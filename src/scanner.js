// Bauta scanner: finds secrets and personal data, swaps them for placeholders,
// and puts the real values back into responses. Everything happens in memory.

const PLACEHOLDER_RE = /\[\[BAUTA_[A-Z]+_\d+\]\]/g;
const PLACEHOLDER_PREFIX = '[[BAUTA_';
const MAX_PLACEHOLDER_LEN = 40;

// Values that look like secrets but are obviously placeholders in docs/examples.
const NOT_SECRET = /^(?:true|false|null|undefined|none|changeme|change_me|password|secret|token|your[-_].*|<.*>|\$\{.*\}|\$\(.*\)|process\.env\..*|os\.environ.*|x{6,}|\*{4,}|\.{3,}|example.*|dummy.*|test|placeholder.*|\d{1,10})$/i;

const SECRET_RULES = [
  { name: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g },
  { name: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'db-password', re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:\s/@]+:([^@\s/]+)@/g, group: 1 },
  { name: 'bearer-token', re: /\bBearer\s+([A-Za-z0-9._~+/-]{24,}=*)/g, group: 1 },
  { name: 'seed-phrase', re: /\b(?:mnemonic|seed(?:[ _-]?phrase)?|recovery[ _-]?phrase|secret[ _-]?phrase|wallet[ _-]?words)\b[^\n]{0,12}?\b((?:[a-z]{3,8}[ \t]+){11,23}[a-z]{3,8})\b/gi, group: 1 },
  { name: 'wallet-private-key', re: /\b(?:private[ _-]?key|priv[ _-]?key|pk|wallet[ _-]?key)\b[^\n]{0,8}?\b((?:0x)?[a-fA-F0-9]{64})\b/gi, group: 1 },
  { name: 'env-secret', re: /\b(?:[A-Z0-9]+_)*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|MNEMONIC)(?:_[A-Z0-9]+)*\b\s*[=:]\s*["']?([^\s"'#,;]{8,})/g, group: 1 },
  { name: 'kv-secret', re: /["']?(?:api[_-]?key|apiKey|secret[_-]?key|secretKey|client[_-]?secret|clientSecret|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|auth[_-]?token|authToken|password|privateKey)["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi, group: 1 },
];

const PII_RULES = [
  {
    name: 'email',
    kind: 'EMAIL',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    validate: (v, cfg) => {
      const lower = v.toLowerCase();
      const [local, domain] = lower.split('@');
      if (['git', 'noreply', 'no-reply'].includes(local)) return false;
      return !(cfg.allowEmails || []).some((d) => domain === d || domain.endsWith('.' + d));
    },
  },
  { name: 'phone', kind: 'PHONE', re: /(?<![\w+])\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}\b/g },
  {
    name: 'card-number',
    kind: 'CARD',
    re: /\b(?:4\d{3}|5[1-5]\d{2}|2[2-7]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/g,
    validate: (v) => luhn(v.replace(/\D/g, '')),
  },
];

function luhn(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Holds the mapping between real values and placeholders. Lives in memory only. */
export class Vault {
  constructor() {
    this.byValue = new Map();
    this.byToken = new Map();
    this.counters = {};
    this.kinds = new Map(); // token -> kind
  }

  tokenFor(kind, value) {
    const existing = this.byValue.get(value);
    if (existing) return { token: existing, isNew: false };
    const n = (this.counters[kind] = (this.counters[kind] || 0) + 1);
    const token = `[[BAUTA_${kind}_${n}]]`;
    this.byValue.set(value, token);
    this.byToken.set(token, value);
    this.kinds.set(token, kind);
    return { token, isNew: true };
  }

  valueOf(token) {
    return this.byToken.get(token);
  }

  get size() {
    return this.byToken.size;
  }

  countKind(kind) {
    let n = 0;
    for (const k of this.kinds.values()) if (k === kind) n++;
    return n;
  }
}

export function newReport() {
  return { secrets: 0, pii: 0, newSecrets: 0, newPii: 0, types: new Set() };
}

export function reportToJSON(report) {
  return { secrets: report.secrets, pii: report.pii, newSecrets: report.newSecrets, newPii: report.newPii, types: [...report.types] };
}

function rulesFor(cfg) {
  const rules = [];
  if (cfg.maskSecrets !== false) for (const r of SECRET_RULES) rules.push({ ...r, kind: 'SECRET', category: 'secret' });
  if (cfg.maskPII !== false) for (const r of PII_RULES) rules.push({ ...r, category: 'pii' });
  const terms = (cfg.customTerms || []).filter((t) => typeof t === 'string' && t.trim().length >= 2);
  if (terms.length) {
    const re = new RegExp(`(?<![\\w])(?:${terms.map((t) => escapeRegExp(t.trim())).join('|')})(?![\\w])`, 'gi');
    rules.push({ name: 'custom-term', kind: 'TERM', category: 'pii', re });
  }
  return rules;
}

const ruleCache = new WeakMap();
function cachedRules(cfg) {
  let r = ruleCache.get(cfg);
  if (!r) { r = rulesFor(cfg); ruleCache.set(cfg, r); }
  return r;
}

/** Finds sensitive spans in a string. Returns non-overlapping spans sorted by start. */
export function findSpans(text, cfg) {
  if (typeof text !== 'string' || text.length < 6) return [];
  const spans = [];
  for (const rule of cachedRules(cfg)) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) { rule.re.lastIndex++; continue; }
      let value = m[0];
      let start = m.index;
      if (rule.group) {
        value = m[rule.group];
        if (value === undefined) continue;
        start = m.index + m[0].lastIndexOf(value);
      }
      if (value.includes(PLACEHOLDER_PREFIX)) continue;
      if (rule.category === 'secret' && rule.group && NOT_SECRET.test(value)) continue;
      if (rule.validate && !rule.validate(value, cfg)) continue;
      spans.push({ start, end: start + value.length, value, kind: rule.kind, category: rule.category, name: rule.name });
    }
  }
  // Earlier first; at the same start, secrets win over personal data, then the longer match.
  const rank = (s) => (s.category === 'secret' ? 0 : 1);
  spans.sort((a, b) => a.start - b.start || rank(a) - rank(b) || (b.end - b.start) - (a.end - a.start));
  const out = [];
  let lastEnd = -1;
  for (const s of spans) {
    if (s.start >= lastEnd) { out.push(s); lastEnd = s.end; }
  }
  return out;
}

/** Masks one string. Updates the report. */
export function maskText(text, cfg, vault, report) {
  const spans = findSpans(text, cfg);
  if (!spans.length) return text;
  let out = '';
  let pos = 0;
  for (const s of spans) {
    const { token, isNew } = vault.tokenFor(s.kind, s.value);
    out += text.slice(pos, s.start) + token;
    pos = s.end;
    if (report) {
      if (s.category === 'secret') { report.secrets++; if (isNew) report.newSecrets++; }
      else { report.pii++; if (isNew) report.newPii++; }
      report.types.add(s.name);
    }
  }
  return out + text.slice(pos);
}

// Keys whose string values must never be changed (structure, ids, signatures, binary data).
const SKIP_KEYS = new Set([
  'model', 'role', 'type', 'id', 'tool_use_id', 'tool_call_id', 'name', 'media_type', 'data',
  'signature', 'cache_control', 'stop_reason', 'finish_reason', 'index', 'metadata', 'mime_type',
  'detail', 'format', 'encoding',
]);
const SKIP_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking', 'image', 'document_base64']);

/**
 * Masks every user-visible string inside a request body (Anthropic or OpenAI format).
 * Tool names, ids, thinking blocks and images are left untouched.
 */
export function maskDeep(value, cfg, vault, report, key = null) {
  if (typeof value === 'string') {
    if (key && SKIP_KEYS.has(key)) return value;
    if (key === 'url' && value.startsWith('data:')) return value;
    return maskText(value, cfg, vault, report);
  }
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, cfg, vault, report, key === 'tools' ? 'tools' : null));
  if (value && typeof value === 'object') {
    if (typeof value.type === 'string' && SKIP_BLOCK_TYPES.has(value.type)) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'metadata' || (k === 'tools' && Array.isArray(v))) { out[k] = v; continue; }
      out[k] = maskDeep(v, cfg, vault, report, k);
    }
    return out;
  }
  return value;
}

function jsonEscape(s) {
  return JSON.stringify(s).slice(1, -1);
}

/** Replaces placeholders with real values. Set json=true when the text is raw JSON (tool arguments). */
export function restoreText(text, vault, json = false) {
  if (typeof text !== 'string' || !text.includes(PLACEHOLDER_PREFIX)) return text;
  return text.replace(PLACEHOLDER_RE, (tok) => {
    const v = vault.valueOf(tok);
    if (v === undefined) return tok;
    return json ? jsonEscape(v) : v;
  });
}

/** Restores placeholders inside a response object (skips thinking blocks so signatures stay valid). */
export function restoreDeep(value, vault, key = null) {
  if (typeof value === 'string') {
    if (key && (key === 'signature' || key === 'id' || key === 'tool_use_id' || key === 'type' || key === 'role')) return value;
    return restoreText(value, vault, key === 'arguments' || key === 'partial_json');
  }
  if (Array.isArray(value)) return value.map((v) => restoreDeep(v, vault));
  if (value && typeof value === 'object') {
    if (value.type === 'thinking' || value.type === 'redacted_thinking') return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = restoreDeep(v, vault, k);
    return out;
  }
  return value;
}

/**
 * Restores placeholders in streamed text that may be split across chunks.
 * Holds back a possible partial placeholder until it is complete.
 */
export class StreamRestorer {
  constructor(vault, json = false) {
    this.vault = vault;
    this.json = json;
    this.buf = '';
  }

  push(chunk) {
    const text = this.buf + (chunk || '');
    let hold = 0;
    const open = text.lastIndexOf('[[');
    if (open !== -1 && text.indexOf(']]', open) === -1 && text.length - open <= MAX_PLACEHOLDER_LEN) {
      hold = text.length - open;
    } else if (text.endsWith('[')) {
      hold = 1;
    }
    const safe = text.slice(0, text.length - hold);
    this.buf = text.slice(text.length - hold);
    return restoreText(safe, this.vault, this.json);
  }

  flush() {
    const rest = this.buf;
    this.buf = '';
    return restoreText(rest, this.vault, this.json);
  }
}

/** For the `bauta scan` command: masks a whole text with a fresh vault. */
export function scanText(text, cfg) {
  const vault = new Vault();
  const report = newReport();
  const masked = maskText(text, cfg, vault, report);
  return { masked, report, vault };
}
