// Server-sent events helpers and streaming placeholder restoration.

import { StreamRestorer, restoreText } from './scanner.js';

/** Reads a web ReadableStream of SSE bytes and yields { event, data } objects. */
export async function* readSSE(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    if (buf.includes('\r')) buf = buf.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseEvent(raw);
      if (ev) yield ev;
    }
  }
  buf += decoder.decode();
  if (buf.includes('\r')) buf = buf.replace(/\r\n/g, '\n');
  if (buf.trim()) {
    const ev = parseEvent(buf);
    if (ev) yield ev;
  }
}

function parseEvent(raw) {
  let event = null;
  const data = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!event && !data.length) return null;
  return { event, data: data.join('\n') };
}

export function formatSSE({ event, data }) {
  const d = typeof data === 'string' ? data : JSON.stringify(data);
  return (event ? `event: ${event}\n` : '') + `data: ${d}\n\n`;
}

/**
 * Restores placeholders inside an Anthropic event stream.
 * Takes { event, data(object) } and returns an array of events to send.
 * Thinking blocks are never touched, so their signatures stay valid.
 */
export function anthropicRestorer(vault) {
  const blocks = new Map();
  return (ev) => {
    const d = ev.data;
    if (!d || typeof d !== 'object') return [ev];
    if (d.type === 'content_block_start') {
      const t = d.content_block?.type;
      blocks.set(d.index, t === 'text' ? new StreamRestorer(vault, false) : t === 'tool_use' ? new StreamRestorer(vault, true) : null);
      if (t === 'text' && d.content_block.text) d.content_block.text = restoreText(d.content_block.text, vault);
      return [ev];
    }
    if (d.type === 'content_block_delta') {
      const r = blocks.get(d.index);
      if (r && d.delta?.type === 'text_delta') {
        d.delta.text = r.push(d.delta.text);
        return d.delta.text ? [ev] : [];
      }
      if (r && d.delta?.type === 'input_json_delta') {
        d.delta.partial_json = r.push(d.delta.partial_json);
        return d.delta.partial_json ? [ev] : [];
      }
      return [ev];
    }
    if (d.type === 'content_block_stop') {
      const out = [];
      const r = blocks.get(d.index);
      if (r) {
        const rest = r.flush();
        if (rest) {
          out.push({
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: d.index,
              delta: r.json ? { type: 'input_json_delta', partial_json: rest } : { type: 'text_delta', text: rest },
            },
          });
        }
        blocks.delete(d.index);
      }
      out.push(ev);
      return out;
    }
    return [ev];
  };
}

/** Restores placeholders inside OpenAI streaming chunks (mutates and returns the chunk). */
export function openaiRestorer(vault) {
  const content = new Map();
  const tools = new Map();
  const get = (map, key, json) => {
    let r = map.get(key);
    if (!r) { r = new StreamRestorer(vault, json); map.set(key, r); }
    return r;
  };
  return (chunk) => {
    for (const choice of chunk.choices || []) {
      const ci = choice.index ?? 0;
      const d = choice.delta;
      if (d) {
        if (typeof d.content === 'string') d.content = get(content, ci, false).push(d.content);
        for (const tc of d.tool_calls || []) {
          if (tc.function && typeof tc.function.arguments === 'string') {
            tc.function.arguments = get(tools, `${ci}:${tc.index ?? 0}`, true).push(tc.function.arguments);
          }
        }
      }
      if (choice.finish_reason) {
        const r = content.get(ci);
        const rest = r ? r.flush() : '';
        if (rest) {
          choice.delta = choice.delta || {};
          choice.delta.content = (choice.delta.content || '') + rest;
        }
        for (const [key, tr] of tools) {
          if (!key.startsWith(`${ci}:`)) continue;
          const rest2 = tr.flush();
          if (!rest2) continue;
          const ti = Number(key.split(':')[1]);
          choice.delta = choice.delta || {};
          choice.delta.tool_calls = choice.delta.tool_calls || [];
          let tc = choice.delta.tool_calls.find((t) => (t.index ?? 0) === ti);
          if (!tc) { tc = { index: ti, function: { arguments: '' } }; choice.delta.tool_calls.push(tc); }
          tc.function = tc.function || {};
          tc.function.arguments = (tc.function.arguments || '') + rest2;
        }
      }
    }
    return chunk;
  };
}
