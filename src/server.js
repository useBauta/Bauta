// Bauta proxy server: sits between your agent and the model providers.

import http from 'node:http';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { Vault, newReport, reportToJSON, maskDeep, restoreDeep } from './scanner.js';
import { readSSE, formatSSE, anthropicRestorer, openaiRestorer } from './streams.js';
import { anthropicToOpenAI, openAIToAnthropic, createStreamTranslator } from './translate.js';
import { VERSION } from './config.js';

const DASHBOARD_FILE = new URL('../dashboard/index.html', import.meta.url);
const MAX_BODY = 64 * 1024 * 1024;

const DROP_REQ_HEADERS = new Set([
  'host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive',
  'upgrade', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'origin', 'referer', 'cookie',
]);
const KEEP_RES_HEADERS = /^(request-id|x-request-id|retry-after|anthropic-ratelimit-.*|x-ratelimit-.*|openai-.*|x-venice-.*)$/i;

class Stats extends EventEmitter {
  constructor(vault) {
    super();
    this.vault = vault;
    this.startedAt = Date.now();
    this.requests = 0;
    this.byTarget = { anthropic: 0, openai: 0, venice: 0 };
    this.fallbacks = 0;
    this.maskedOccurrences = 0;
    this.privateTokens = 0;
    this.totalTokens = 0;
    this.recent = [];
  }

  record(ev) {
    this.requests++;
    if (this.byTarget[ev.target] !== undefined) this.byTarget[ev.target]++;
    if (ev.fallback) this.fallbacks++;
    this.maskedOccurrences += (ev.secrets || 0) + (ev.pii || 0);
    const tok = (ev.inTok || 0) + (ev.outTok || 0);
    this.totalTokens += tok;
    if (ev.target === 'venice') this.privateTokens += tok;
    this.recent.unshift(ev);
    if (this.recent.length > 60) this.recent.pop();
    this.emit('event', ev);
  }

  snapshot() {
    const uniqueSecrets = this.vault.countKind('SECRET');
    return {
      version: VERSION,
      startedAt: this.startedAt,
      requests: this.requests,
      byTarget: this.byTarget,
      fallbacks: this.fallbacks,
      maskedOccurrences: this.maskedOccurrences,
      uniqueSecrets,
      uniquePii: this.vault.size - uniqueSecrets,
      privateTokens: this.privateTokens,
      totalTokens: this.totalTokens,
      recent: this.recent.slice(0, 30),
    };
  }
}

function joinUrl(base, path) {
  // base may end with /v1 or /api/v1; incoming paths start with /v1/...
  if (/\/v1$/.test(base) && path.startsWith('/v1/')) return base + path.slice(3);
  return base + path;
}

function forwardHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (DROP_REQ_HEADERS.has(k)) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  out['accept-encoding'] = 'identity';
  return out;
}

function pickResHeaders(headers) {
  const out = {};
  for (const [k, v] of headers) if (KEEP_RES_HEADERS.test(k)) out[k] = v;
  return out;
}

function veniceHeaders(key, stream) {
  return {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'accept-encoding': 'identity',
    'user-agent': `bauta/${VERSION}`,
  };
}

function sendJSON(res, status, obj, extra = {}) {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(obj));
}

function anthropicError(res, status, message) {
  sendJSON(res, status, { type: 'error', error: { type: status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : 'api_error', message } });
}

function openaiError(res, status, message) {
  sendJSON(res, status, { error: { message, type: 'bauta_error', code: status } });
}

function sseHead(res, status = 200, extra = {}) {
  res.writeHead(status, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', ...extra });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function bearerFrom(headers) {
  const a = headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(a);
  return m ? m[1].trim() : null;
}

const ALLOWED_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function createBauta(cfg, { log = () => {} } = {}) {
  const vault = new Vault();
  const stats = new Stats(vault);

  function shouldFallback(status) {
    return cfg.fallback && !!cfg.veniceKey && cfg.fallbackStatuses.includes(status);
  }

  function finish(ev, t0) {
    ev.ms = Date.now() - t0;
    stats.record(ev);
    log(ev);
  }

  // ---------- Anthropic: /v1/messages (Claude Code) ----------

  async function pipeAnthropic(up, res, ev) {
    const ct = up.headers.get('content-type') || '';
    const headers = pickResHeaders(up.headers);
    ev.status = up.status;
    if (ct.includes('text/event-stream')) {
      sseHead(res, up.status, headers);
      const restore = anthropicRestorer(vault);
      for await (const e of readSSE(up.body)) {
        let data;
        try { data = JSON.parse(e.data); } catch { res.write(formatSSE(e)); continue; }
        if (data.type === 'message_start') {
          const u = data.message?.usage || {};
          ev.inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        } else if (data.type === 'message_delta' && data.usage) {
          ev.outTok = data.usage.output_tokens || 0;
        }
        for (const o of restore({ event: e.event, data })) res.write(formatSSE(o));
      }
      res.end();
    } else {
      const text = await up.text();
      let out = text;
      try {
        const j = JSON.parse(text);
        if (j.usage) { ev.inTok = j.usage.input_tokens || 0; ev.outTok = j.usage.output_tokens || 0; }
        out = JSON.stringify(restoreDeep(j, vault));
      } catch {}
      res.writeHead(up.status, { ...headers, 'content-type': ct || 'application/json' });
      res.end(out);
    }
  }

  async function veniceForAnthropic(masked, res, ev, signal) {
    ev.target = 'venice';
    ev.model = cfg.veniceModel;
    if (!cfg.veniceKey) {
      ev.status = 401;
      return anthropicError(res, 401, 'Bauta: no VENICE_API_KEY set, so private mode and fallback are unavailable. Get a key at venice.ai and set VENICE_API_KEY before starting Bauta.');
    }
    const oa = anthropicToOpenAI(masked, cfg.veniceModel, { maxTokens: cfg.veniceMaxTokens });
    const up = await fetch(joinUrl(cfg.veniceUrl, '/chat/completions'), {
      method: 'POST', headers: veniceHeaders(cfg.veniceKey, !!oa.stream), body: JSON.stringify(oa), signal,
    });
    ev.status = up.status;
    if (!up.ok) {
      const t = await up.text().catch(() => '');
      return anthropicError(res, up.status, `Bauta: Venice returned ${up.status}: ${t.slice(0, 600)}`);
    }
    if (oa.stream) {
      sseHead(res, 200);
      const tr = createStreamTranslator(cfg.veniceModel);
      const restore = anthropicRestorer(vault);
      const write = (events) => { for (const e of events) for (const o of restore(e)) res.write(formatSSE(o)); };
      for await (const e of readSSE(up.body)) {
        if (e.data === '[DONE]') break;
        let chunk;
        try { chunk = JSON.parse(e.data); } catch { continue; }
        if (chunk.error) {
          res.write(formatSSE({ event: 'error', data: { type: 'error', error: { type: 'api_error', message: `Bauta: Venice stream error: ${chunk.error.message || JSON.stringify(chunk.error)}` } } }));
          break;
        }
        write(tr.push(chunk));
      }
      write(tr.end());
      ev.inTok = tr.usage.input_tokens;
      ev.outTok = tr.usage.output_tokens;
      res.end();
    } else {
      const j = await up.json();
      const msg = restoreDeep(openAIToAnthropic(j, cfg.veniceModel), vault);
      ev.inTok = msg.usage.input_tokens;
      ev.outTok = msg.usage.output_tokens;
      sendJSON(res, 200, msg);
    }
  }

  async function handleMessages(req, res, body, signal) {
    const t0 = Date.now();
    const report = newReport();
    const masked = maskDeep(body, cfg, vault, report);
    const ev = { id: t0 + Math.random(), time: t0, route: 'messages', model: body.model, stream: !!body.stream, target: 'anthropic', fallback: false, reason: null, ...reportToJSON(report) };
    try {
      let goVenice = false;
      if (cfg.mode === 'private') { goVenice = true; ev.reason = 'private mode'; }
      else if (cfg.onSecrets === 'venice' && report.secrets > 0 && cfg.veniceKey) { goVenice = true; ev.reason = 'secrets → private'; }
      if (!goVenice) {
        let up = null;
        try {
          up = await fetch(joinUrl(cfg.anthropicUrl, req.url), { method: 'POST', headers: forwardHeaders(req.headers), body: JSON.stringify(masked), signal });
        } catch (err) {
          if (signal.aborted) throw err;
          if (!(cfg.fallback && cfg.veniceKey)) { ev.status = 502; return anthropicError(res, 502, `Bauta: could not reach Anthropic (${err.message})`); }
          ev.fallback = true; ev.reason = 'anthropic unreachable';
        }
        if (up) {
          if (shouldFallback(up.status)) {
            up.body?.cancel().catch(() => {});
            ev.fallback = true; ev.reason = `anthropic ${up.status}`;
          } else {
            return await pipeAnthropic(up, res, ev);
          }
        }
      }
      return await veniceForAnthropic(masked, res, ev, signal);
    } finally {
      finish(ev, t0);
    }
  }

  async function handleCountTokens(req, res, body, signal) {
    const masked = maskDeep(body, cfg, vault, newReport());
    const estimate = () => sendJSON(res, 200, { input_tokens: Math.ceil(JSON.stringify(masked).length / 4) });
    if (cfg.mode === 'private') return estimate();
    try {
      const up = await fetch(joinUrl(cfg.anthropicUrl, req.url), { method: 'POST', headers: forwardHeaders(req.headers), body: JSON.stringify(masked), signal });
      if (!up.ok) { up.body?.cancel().catch(() => {}); return estimate(); }
      res.writeHead(up.status, { 'content-type': 'application/json' });
      res.end(await up.text());
    } catch {
      return estimate();
    }
  }

  // ---------- OpenAI-compatible: /v1/chat/completions ----------

  async function pipeOpenAI(up, res, ev) {
    const ct = up.headers.get('content-type') || '';
    ev.status = up.status;
    if (ct.includes('text/event-stream')) {
      sseHead(res, up.status, pickResHeaders(up.headers));
      const restore = openaiRestorer(vault);
      for await (const e of readSSE(up.body)) {
        if (e.data === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
        let chunk;
        try { chunk = JSON.parse(e.data); } catch { res.write(formatSSE(e)); continue; }
        if (chunk.usage) { ev.inTok = chunk.usage.prompt_tokens || 0; ev.outTok = chunk.usage.completion_tokens || 0; }
        res.write(formatSSE({ event: e.event, data: restore(chunk) }));
      }
      res.end();
    } else {
      const text = await up.text();
      let out = text;
      try {
        const j = JSON.parse(text);
        if (j.usage) { ev.inTok = j.usage.prompt_tokens || 0; ev.outTok = j.usage.completion_tokens || 0; }
        out = JSON.stringify(restoreDeep(j, vault));
      } catch {}
      res.writeHead(up.status, { ...pickResHeaders(up.headers), 'content-type': ct || 'application/json' });
      res.end(out);
    }
  }

  async function handleChat(req, res, body, signal) {
    const t0 = Date.now();
    const report = newReport();
    const masked = maskDeep(body, cfg, vault, report);
    let target = cfg.mode === 'private' ? 'venice' : cfg.openaiPrimary;
    const ev = { id: t0 + Math.random(), time: t0, route: 'chat', model: body.model, stream: !!body.stream, target, fallback: false, reason: cfg.mode === 'private' ? 'private mode' : null, ...reportToJSON(report) };
    try {
      if (target === 'openai' && cfg.onSecrets === 'venice' && report.secrets > 0 && cfg.veniceKey) {
        target = 'venice'; ev.reason = 'secrets → private';
      }
      let fellBack = false;
      if (target === 'openai') {
        let up = null;
        try {
          up = await fetch(joinUrl(cfg.openaiUrl, '/v1/chat/completions'), { method: 'POST', headers: forwardHeaders(req.headers), body: JSON.stringify(masked), signal });
        } catch (err) {
          if (signal.aborted) throw err;
          if (!(cfg.fallback && cfg.veniceKey)) { ev.status = 502; return openaiError(res, 502, `Bauta: could not reach OpenAI (${err.message})`); }
          fellBack = true; ev.reason = 'openai unreachable';
        }
        if (up) {
          if (shouldFallback(up.status)) { up.body?.cancel().catch(() => {}); fellBack = true; ev.reason = `openai ${up.status}`; }
          else return await pipeOpenAI(up, res, ev);
        }
        ev.fallback = true;
      }
      ev.target = 'venice';
      // Only ever use our own Venice key. The tool's own key (which may be an OpenAI key) never goes to Venice.
      const key = cfg.veniceKey;
      if (!key) { ev.status = 401; return openaiError(res, 401, 'Bauta: no VENICE_API_KEY set. Get a key at venice.ai and set VENICE_API_KEY before starting Bauta.'); }
      const out = { ...masked };
      if (fellBack || !out.model) out.model = cfg.veniceModel;
      ev.model = out.model;
      out.venice_parameters = { include_venice_system_prompt: false, ...(out.venice_parameters || {}) };
      if (out.stream) out.stream_options = { include_usage: true, ...(out.stream_options || {}) };
      const up = await fetch(joinUrl(cfg.veniceUrl, '/chat/completions'), { method: 'POST', headers: veniceHeaders(key, !!out.stream), body: JSON.stringify(out), signal });
      return await pipeOpenAI(up, res, ev);
    } finally {
      finish(ev, t0);
    }
  }

  // ---------- Other routes ----------

  async function handleModels(req, res, signal) {
    const isAnthropic = !!(req.headers['anthropic-version'] || req.headers['x-api-key']);
    let url;
    let headers;
    if (isAnthropic && cfg.mode === 'private') {
      // Private mode never contacts Anthropic: answer with the Venice model Bauta will use.
      return sendJSON(res, 200, { data: [{ type: 'model', id: cfg.veniceModel, display_name: `${cfg.veniceModel} (via Venice)`, created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: cfg.veniceModel, last_id: cfg.veniceModel });
    }
    if (isAnthropic) { url = joinUrl(cfg.anthropicUrl, req.url); headers = forwardHeaders(req.headers); }
    else if (cfg.mode === 'private' || cfg.openaiPrimary === 'venice') {
      if (!cfg.veniceKey) return openaiError(res, 401, 'Bauta: no VENICE_API_KEY set.');
      url = joinUrl(cfg.veniceUrl, '/models'); headers = veniceHeaders(cfg.veniceKey, false);
    } else { url = joinUrl(cfg.openaiUrl, '/v1/models'); headers = forwardHeaders(req.headers); }
    const up = await fetch(url, { headers, signal });
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json' });
    res.end(await up.text());
  }

  async function passthrough(req, res, raw, signal) {
    const isAnthropic = !!(req.headers['anthropic-version'] || req.headers['x-api-key']);
    const headers = forwardHeaders(req.headers);
    let base;
    if (isAnthropic && cfg.mode === 'private') {
      // Private mode never contacts Anthropic.
      return sendJSON(res, 404, { type: 'error', error: { type: 'not_found_error', message: `Bauta private mode: ${req.method} ${req.url} is not forwarded to Anthropic.` } });
    }
    if (isAnthropic) base = cfg.anthropicUrl;
    else if (cfg.mode === 'private' || cfg.openaiPrimary === 'venice') {
      base = cfg.veniceUrl;
      // Never forward the tool's own credentials to Venice; only our Venice key.
      delete headers.authorization;
      delete headers['x-api-key'];
      if (cfg.veniceKey) headers.authorization = `Bearer ${cfg.veniceKey}`;
    } else base = cfg.openaiUrl;
    const up = await fetch(joinUrl(base, req.url), {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
      signal,
    });
    const resHeaders = {};
    for (const [k, v] of up.headers) if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) resHeaders[k] = v;
    res.writeHead(up.status, resHeaders);
    if (up.body) for await (const c of up.body) res.write(c);
    res.end();
  }

  function serveDashboard(res) {
    try {
      const html = fs.readFileSync(DASHBOARD_FILE, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(500); res.end('Dashboard file missing');
    }
  }

  function serveEvents(req, res) {
    sseHead(res, 200);
    res.write(formatSSE({ event: 'hello', data: stats.snapshot() }));
    const onEvent = (ev) => res.write(formatSSE({ event: 'request', data: { ev, stats: stats.snapshot() } }));
    stats.on('event', onEvent);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { stats.off('event', onEvent); clearInterval(ping); });
  }

  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      // Only accept local requests, and block web pages from using the proxy (DNS rebinding / CSRF).
      if (req.headers.host && !ALLOWED_HOST.test(req.headers.host)) return sendJSON(res, 403, { error: 'Bauta only accepts requests to localhost.' });
      if (req.headers.origin && !ALLOWED_ORIGIN.test(req.headers.origin)) return sendJSON(res, 403, { error: 'Bauta does not accept requests from web pages.' });

      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      if (req.method === 'GET' && (p === '/' || p === '/_bauta' || p === '/_bauta/')) return serveDashboard(res);
      if (req.method === 'GET' && p === '/_bauta/stats') return sendJSON(res, 200, stats.snapshot());
      if (req.method === 'GET' && p === '/_bauta/events') return serveEvents(req, res);
      if (req.method === 'GET' && p === '/_bauta/health') return sendJSON(res, 200, { ok: true, version: VERSION, mode: cfg.mode, venice: !!cfg.veniceKey, veniceModel: cfg.veniceModel });
      if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) return await handleModels(req, res, controller.signal);

      const raw = await readBody(req);
      const isJsonRoute = req.method === 'POST' && ['/v1/messages', '/v1/messages/count_tokens', '/v1/chat/completions', '/chat/completions'].includes(p);
      if (!isJsonRoute) return await passthrough(req, res, raw, controller.signal);

      const ct = req.headers['content-type'] || '';
      if (!ct.includes('application/json')) return sendJSON(res, 415, { error: 'Bauta expects Content-Type: application/json' });
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }

      if (p === '/v1/messages') return await handleMessages(req, res, body, controller.signal);
      if (p === '/v1/messages/count_tokens') return await handleCountTokens(req, res, body, controller.signal);
      return await handleChat(req, res, body, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      const status = err.status || 500;
      if (!res.headersSent) sendJSON(res, status, { error: `Bauta error: ${err.message}` });
      else { try { res.end(); } catch {} }
    }
  });

  return { server, stats, vault, cfg };
}
