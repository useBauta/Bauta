import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBauta } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { readSSE } from '../src/streams.js';

const SECRET = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789AB';
const PLACEHOLDER_RE = /\[\[BAUTA_SECRET_\d+\]\]/;

// ---- tiny mock servers -------------------------------------------------

function mockServer(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const call = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    calls.push(call);
    await server.handler(call, res);
  });
  server.handler = handler;
  server.calls = calls;
  return server;
}

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write((e.event ? `event: ${e.event}\n` : '') + `data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`);
  res.end();
};

let anthropic, venice, bautaUrl, bauta, anthropicUrl, veniceUrl;

before(async () => {
  anthropic = mockServer(() => {});
  venice = mockServer(() => {});
  anthropicUrl = await listen(anthropic);
  veniceUrl = await listen(venice);
  const cfg = loadConfig({ skipFile: true, anthropicUrl, veniceUrl: veniceUrl + '/api/v1', openaiUrl: veniceUrl + '/v1', veniceKey: 'test-venice-key', logRequests: false, port: 0 }, {});
  bauta = createBauta(cfg);
  bautaUrl = await listen(bauta.server);
});

after(() => {
  anthropic.close(); venice.close(); bauta.server.close();
});

function claudeRequest(extra = {}) {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 64000,
    stream: true,
    system: [{ type: 'text', text: 'You are a coding agent.' }],
    tools: [{ name: 'Bash', description: 'Run a shell command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }],
    messages: [
      { role: 'user', content: `My GitHub token is ${SECRET}. Use it to list repos.` },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md' }, { type: 'text', text: 'continue' }] },
    ],
    ...extra,
  };
}

async function post(path, body, headers = {}) {
  return fetch(bautaUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'user-anthropic-key', 'anthropic-version': '2023-06-01', ...headers },
    body: JSON.stringify(body),
  });
}

async function collect(res) {
  const events = [];
  for await (const e of readSSE(res.body)) events.push({ event: e.event, data: e.data === '[DONE]' ? e.data : JSON.parse(e.data) });
  return events;
}

// ---- tests ---------------------------------------------------------------

test('Claude Code passthrough: secret never reaches Anthropic, answer comes back with the real value', async () => {
  anthropic.handler = (call, res) => {
    const token = JSON.stringify(call.body).match(PLACEHOLDER_RE)[0];
    // Split the placeholder across deltas to test streaming restoration.
    sse(res, [
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Token: ' + token.slice(0, 9) } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: token.slice(9) + ' ok' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
  };
  const res = await post('/v1/messages?beta=true', claudeRequest());
  assert.equal(res.status, 200);
  const events = await collect(res);
  const sent = JSON.stringify(anthropic.calls.at(-1).body);
  assert.ok(!sent.includes(SECRET), 'secret leaked to Anthropic');
  assert.equal(anthropic.calls.at(-1).headers['x-api-key'], 'user-anthropic-key');
  assert.equal(anthropic.calls.at(-1).url, '/v1/messages?beta=true');
  const text = events.filter((e) => e.data.type === 'content_block_delta').map((e) => e.data.delta.text).join('');
  assert.equal(text, `Token: ${SECRET} ok`);
});

test('Claude Code fallback: Anthropic 429 → Venice, translated both ways, tool input restored', async () => {
  anthropic.handler = (call, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }));
  };
  venice.handler = (call, res) => {
    const token = JSON.stringify(call.body).match(PLACEHOLDER_RE)[0];
    const args = JSON.stringify({ command: `gh repo list --token ${token}` });
    sse(res, [
      { data: { choices: [{ index: 0, delta: { role: 'assistant', content: 'Listing ' } }] } },
      { data: { choices: [{ index: 0, delta: { content: 'repos.' } }] } },
      { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: args.slice(0, 30) } }] } }] } },
      { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(30) } }] } }] } },
      { data: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
      { data: { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } } },
      { data: '[DONE]' },
    ]);
  };
  const res = await post('/v1/messages', claudeRequest());
  assert.equal(res.status, 200);
  const events = await collect(res);

  const vcall = venice.calls.at(-1);
  assert.equal(vcall.url, '/api/v1/chat/completions');
  assert.equal(vcall.headers.authorization, 'Bearer test-venice-key');
  assert.ok(!vcall.headers['x-api-key'], 'Anthropic key must never go to Venice');
  assert.ok(!JSON.stringify(vcall.body).includes(SECRET), 'secret leaked to Venice');
  assert.equal(vcall.body.model, 'deepseek-v4-1-flash');
  assert.equal(vcall.body.max_tokens, 16384);
  assert.equal(vcall.body.messages[0].role, 'system');
  assert.equal(vcall.body.messages[2].tool_calls[0].function.name, 'Bash');
  assert.equal(vcall.body.messages[3].role, 'tool');
  assert.equal(vcall.body.messages[3].tool_call_id, 'toolu_1');
  assert.equal(vcall.body.tools[0].function.name, 'Bash');

  const types = events.map((e) => e.data.type);
  assert.deepEqual(types.filter((t) => t !== 'content_block_delta'), [
    'message_start', 'content_block_start', 'content_block_stop', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
  const text = events.filter((e) => e.data.delta?.type === 'text_delta').map((e) => e.data.delta.text).join('');
  assert.equal(text, 'Listing repos.');
  const json = events.filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(json), { command: `gh repo list --token ${SECRET}` });
  const md = events.find((e) => e.data.type === 'message_delta').data;
  assert.equal(md.delta.stop_reason, 'tool_use');
  assert.equal(md.usage.output_tokens, 30);
  assert.equal(bauta.stats.fallbacks >= 1, true);
});

test('non-streaming fallback returns an Anthropic message', async () => {
  anthropic.handler = (call, res) => { res.writeHead(529); res.end('{"type":"error","error":{"type":"overloaded_error"}}'); };
  venice.handler = (call, res) => {
    const token = JSON.stringify(call.body).match(PLACEHOLDER_RE)[0];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `Saved ${token}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
  };
  const res = await post('/v1/messages', claudeRequest({ stream: false }));
  const msg = await res.json();
  assert.equal(msg.type, 'message');
  assert.equal(msg.content[0].text, `Saved ${SECRET}`);
  assert.equal(msg.stop_reason, 'end_turn');
});

test('OpenAI-compatible route goes to Venice with masking and streamed restore', async () => {
  venice.handler = (call, res) => {
    const token = JSON.stringify(call.body).match(PLACEHOLDER_RE)[0];
    sse(res, [
      { data: { choices: [{ index: 0, delta: { content: 'ok ' + token.slice(0, 5) } }] } },
      { data: { choices: [{ index: 0, delta: { content: token.slice(5) } }] } },
      { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
      { data: '[DONE]' },
    ]);
  };
  const res = await fetch(bautaUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'kimi-k3-1-pro', stream: true, messages: [{ role: 'user', content: `token ${SECRET}` }] }),
  });
  const events = await collect(res);
  const vcall = venice.calls.at(-1);
  assert.equal(vcall.body.model, 'kimi-k3-1-pro');
  assert.equal(vcall.body.venice_parameters.include_venice_system_prompt, false);
  assert.ok(!JSON.stringify(vcall.body).includes(SECRET));
  const text = events.filter((e) => e.data !== '[DONE]').map((e) => e.data.choices[0]?.delta?.content || '').join('');
  assert.equal(text, `ok ${SECRET}`);
});

test('rejects requests from web pages and foreign hosts', async () => {
  const res = await fetch(bautaUrl + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: '{}',
  });
  assert.equal(res.status, 403);
  const res2 = await fetch(bautaUrl + '/v1/messages', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(res2.status, 415);
});

test('the tool\'s own key is never forwarded to Venice', async () => {
  // A second Bauta without a Venice key: an OpenAI key sent by the tool must not reach Venice.
  const cfg2 = loadConfig({ skipFile: true, anthropicUrl, veniceUrl: veniceUrl + '/api/v1', openaiUrl: veniceUrl + '/v1', veniceKey: null, logRequests: false, port: 0 }, {});
  const b2 = createBauta(cfg2);
  const url2 = await listen(b2.server);
  venice.handler = (call, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); };
  const before = venice.calls.length;
  const res = await fetch(url2 + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-proj-user-openai-key-should-stay-home' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 401);
  const res2 = await fetch(url2 + '/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-proj-user-openai-key-should-stay-home' },
    body: JSON.stringify({ input: 'x' }),
  });
  await res2.text();
  for (const c of venice.calls.slice(before)) {
    assert.ok(!String(c.headers.authorization || '').includes('user-openai-key'), 'tool key leaked to Venice');
  }
  b2.server.close();
});

test('private mode never contacts Anthropic', async () => {
  const cfg3 = loadConfig({ skipFile: true, anthropicUrl, veniceUrl: veniceUrl + '/api/v1', openaiUrl: veniceUrl + '/v1', veniceKey: 'test-venice-key', mode: 'private', logRequests: false, port: 0 }, {});
  const b3 = createBauta(cfg3);
  const url3 = await listen(b3.server);
  const before = anthropic.calls.length;
  const headers = { 'x-api-key': 'bauta', 'anthropic-version': '2023-06-01' };
  const models = await fetch(url3 + '/v1/models', { headers });
  const mj = await models.json();
  assert.equal(mj.data[0].id, 'deepseek-v4-1-flash');
  const other = await fetch(url3 + '/v1/organizations/me', { headers });
  assert.equal(other.status, 404);
  const count = await fetch(url3 + '/v1/messages/count_tokens', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(claudeRequest({ stream: false })) });
  assert.ok((await count.json()).input_tokens > 0);
  assert.equal(anthropic.calls.length, before, 'Anthropic was contacted in private mode');
  b3.server.close();
});

test('stats and health endpoints work and contain no content', async () => {
  const s = await (await fetch(bautaUrl + '/_bauta/stats')).json();
  assert.ok(s.requests >= 3);
  assert.ok(s.uniqueSecrets >= 1);
  assert.ok(!JSON.stringify(s).includes(SECRET));
  const h = await (await fetch(bautaUrl + '/_bauta/health')).json();
  assert.equal(h.ok, true);
});
