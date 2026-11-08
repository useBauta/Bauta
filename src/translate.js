// Converts Anthropic Messages API requests/responses to and from the OpenAI
// Chat Completions format, so Claude Code can keep working on Venice models.

import crypto from 'node:crypto';

export function genId(prefix) {
  return `${prefix}_bauta_${crypto.randomBytes(12).toString('hex')}`;
}

function toolResultText(block) {
  let text = '';
  if (typeof block.content === 'string') text = block.content;
  else if (Array.isArray(block.content)) {
    text = block.content.map((c) => (c.type === 'text' ? c.text : `[${c.type} omitted]`)).join('\n');
  }
  return block.is_error ? `Error: ${text}` : text;
}

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
  return '';
}

function mapToolChoice(tc) {
  if (!tc) return undefined;
  switch (tc.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { type: 'function', function: { name: tc.name } };
    default: return undefined;
  }
}

/** Anthropic /v1/messages request body -> OpenAI /chat/completions request body. */
export function anthropicToOpenAI(body, model, { maxTokens } = {}) {
  const out = { model, messages: [] };
  const sys = systemText(body.system);
  if (sys) out.messages.push({ role: 'system', content: sys });

  for (const m of body.messages || []) {
    if (typeof m.content === 'string') {
      out.messages.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolCalls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.messages.push(msg);
    } else {
      // Tool results must directly follow the assistant message that called the tools.
      for (const b of blocks) {
        if (b.type === 'tool_result') out.messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultText(b) });
      }
      const parts = [];
      for (const b of blocks) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image' && b.source?.type === 'base64') {
          parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
        } else if (b.type === 'image' && b.source?.type === 'url') {
          parts.push({ type: 'image_url', image_url: { url: b.source.url } });
        } else if (b.type === 'document') {
          parts.push({ type: 'text', text: '[document omitted by Bauta: not supported on fallback]' });
        }
      }
      if (parts.length) {
        const allText = parts.every((p) => p.type === 'text');
        out.messages.push({ role: 'user', content: allText ? parts.map((p) => p.text).join('\n') : parts });
      }
    }
  }

  const tools = (body.tools || []).filter((t) => t && t.name && (t.input_schema || !t.type || t.type === 'custom'));
  if (tools.length) {
    out.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
    }));
    const choice = mapToolChoice(body.tool_choice);
    if (choice) out.tool_choice = choice;
  }
  if (body.max_tokens) out.max_tokens = maxTokens ? Math.min(body.max_tokens, maxTokens) : body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (body.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  out.venice_parameters = { include_venice_system_prompt: false };
  return out;
}

function mapStop(finishReason, hasTools) {
  if (finishReason === 'tool_calls' || finishReason === 'function_call') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  if (hasTools && finishReason === 'stop') return 'tool_use';
  return 'end_turn';
}

function safeParse(s) {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : { value: v };
  } catch {
    return { _raw: s };
  }
}

/** OpenAI chat completion (non-streaming) -> Anthropic message. */
export function openAIToAnthropic(resp, model) {
  const choice = resp.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    content.push({ type: 'tool_use', id: tc.id || genId('toolu'), name: tc.function?.name || '', input: safeParse(tc.function?.arguments) });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const hasTools = content.some((c) => c.type === 'tool_use');
  return {
    id: genId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStop(choice.finish_reason, hasTools),
    stop_sequence: null,
    usage: { input_tokens: resp.usage?.prompt_tokens || 0, output_tokens: resp.usage?.completion_tokens || 0 },
  };
}

/**
 * Turns OpenAI streaming chunks into Anthropic streaming events.
 * Call push(chunk) for each parsed `data:` object, then end().
 */
export function createStreamTranslator(model) {
  let started = false;
  let nextIndex = 0;
  let openBlock = null;
  let textIndex = null;
  let stopReason = null;
  const toolMap = new Map();
  const usage = { input_tokens: 0, output_tokens: 0 };
  const ev = (type, data) => ({ event: type, data: { type, ...data } });

  function start(out) {
    if (started) return;
    started = true;
    out.push(ev('message_start', {
      message: { id: genId('msg'), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    }));
  }
  function closeOpen(out) {
    if (openBlock !== null) {
      out.push(ev('content_block_stop', { index: openBlock }));
      openBlock = null;
    }
  }

  return {
    push(chunk) {
      const out = [];
      start(out);
      if (chunk.usage) {
        usage.input_tokens = chunk.usage.prompt_tokens || 0;
        usage.output_tokens = chunk.usage.completion_tokens || 0;
      }
      for (const choice of chunk.choices || []) {
        const d = choice.delta || {};
        if (typeof d.content === 'string' && d.content.length) {
          if (openBlock === null || openBlock !== textIndex) {
            closeOpen(out);
            textIndex = nextIndex++;
            openBlock = textIndex;
            out.push(ev('content_block_start', { index: textIndex, content_block: { type: 'text', text: '' } }));
          }
          out.push(ev('content_block_delta', { index: textIndex, delta: { type: 'text_delta', text: d.content } }));
        }
        for (const tc of d.tool_calls || []) {
          const k = tc.index ?? 0;
          let ai = toolMap.get(k);
          if (ai === undefined) {
            closeOpen(out);
            ai = nextIndex++;
            toolMap.set(k, ai);
            openBlock = ai;
            out.push(ev('content_block_start', {
              index: ai,
              content_block: { type: 'tool_use', id: tc.id || genId('toolu'), name: tc.function?.name || '', input: {} },
            }));
          }
          if (tc.function?.arguments) {
            out.push(ev('content_block_delta', { index: ai, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } }));
          }
        }
        if (choice.finish_reason) stopReason = mapStop(choice.finish_reason, toolMap.size > 0);
      }
      return out;
    },
    end() {
      const out = [];
      start(out);
      closeOpen(out);
      out.push(ev('message_delta', {
        delta: { stop_reason: stopReason || (toolMap.size ? 'tool_use' : 'end_turn'), stop_sequence: null },
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
      }));
      out.push(ev('message_stop', {}));
      return out;
    },
    usage,
  };
}
