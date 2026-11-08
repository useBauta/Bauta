import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.1.0';

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  // Where requests normally go.
  anthropicUrl: 'https://api.anthropic.com',
  openaiUrl: 'https://api.openai.com/v1',
  veniceUrl: 'https://api.venice.ai/api/v1',
  // Venice model used for fallback and private mode.
  veniceModel: 'deepseek-v4-1-flash',
  // Upper bound for max_tokens sent to Venice (some models reject very large values).
  veniceMaxTokens: 16384,
  // 'auto'    = your normal provider first, Venice when limits hit.
  // 'private' = everything goes to Venice.
  mode: 'auto',
  // For OpenAI-compatible tools (/v1/chat/completions): 'venice' or 'openai'.
  openaiPrimary: 'venice',
  // When a request contains secrets: 'mask' (mask and send as usual) or 'venice' (send to Venice instead).
  onSecrets: 'mask',
  maskSecrets: true,
  maskPII: true,
  // Extra words to always mask (client names, your real name, project codenames...).
  customTerms: [],
  // Email domains that are never masked.
  allowEmails: ['example.com', 'example.org', 'example.net', 'users.noreply.github.com', 'noreply.github.com'],
  // Upstream HTTP statuses that trigger the Venice fallback.
  fallbackStatuses: [429, 500, 502, 503, 504, 529],
  fallback: true,
  // Print one line per request in the terminal (metadata only, never content).
  logRequests: true,
};

const CONFIG_FILES = () => [
  path.join(process.cwd(), 'bauta.config.json'),
  path.join(os.homedir(), '.bauta', 'config.json'),
];

function readConfigFile() {
  for (const file of CONFIG_FILES()) {
    if (fs.existsSync(file)) {
      try {
        return { cfg: JSON.parse(fs.readFileSync(file, 'utf8')), source: file };
      } catch (err) {
        throw new Error(`Could not read ${file}: ${err.message}`);
      }
    }
  }
  return { cfg: {}, source: null };
}

function envConfig(env) {
  const out = {};
  if (env.BAUTA_PORT) out.port = Number(env.BAUTA_PORT);
  if (env.BAUTA_HOST) out.host = env.BAUTA_HOST;
  if (env.BAUTA_MODE) out.mode = env.BAUTA_MODE;
  if (env.BAUTA_VENICE_MODEL) out.veniceModel = env.BAUTA_VENICE_MODEL;
  if (env.BAUTA_OPENAI_PRIMARY) out.openaiPrimary = env.BAUTA_OPENAI_PRIMARY;
  if (env.BAUTA_ON_SECRETS) out.onSecrets = env.BAUTA_ON_SECRETS;
  if (env.BAUTA_ANTHROPIC_URL) out.anthropicUrl = env.BAUTA_ANTHROPIC_URL;
  if (env.BAUTA_OPENAI_URL) out.openaiUrl = env.BAUTA_OPENAI_URL;
  if (env.BAUTA_VENICE_URL) out.veniceUrl = env.BAUTA_VENICE_URL;
  if (env.BAUTA_MASK_PII === '0') out.maskPII = false;
  if (env.BAUTA_NO_FALLBACK === '1') out.fallback = false;
  if (env.BAUTA_QUIET === '1') out.logRequests = false;
  if (env.BAUTA_TERMS) out.customTerms = env.BAUTA_TERMS.split(',').map((s) => s.trim()).filter(Boolean);
  return out;
}

export function loadConfig(overrides = {}, env = process.env) {
  const { cfg: fileCfg, source } = overrides.skipFile ? { cfg: {}, source: null } : readConfigFile();
  const cfg = { ...DEFAULTS, ...fileCfg, ...envConfig(env), ...overrides };
  // The Venice key only ever comes from the environment (or tests). Never store it in a file.
  cfg.veniceKey = overrides.veniceKey !== undefined ? overrides.veniceKey : (env.VENICE_API_KEY || null);
  cfg.configSource = source;
  cfg.anthropicUrl = String(cfg.anthropicUrl).replace(/\/+$/, '');
  cfg.openaiUrl = String(cfg.openaiUrl).replace(/\/+$/, '');
  cfg.veniceUrl = String(cfg.veniceUrl).replace(/\/+$/, '');
  if (!['auto', 'private'].includes(cfg.mode)) throw new Error(`mode must be "auto" or "private", got "${cfg.mode}"`);
  if (!['venice', 'openai'].includes(cfg.openaiPrimary)) throw new Error(`openaiPrimary must be "venice" or "openai"`);
  if (!['mask', 'venice'].includes(cfg.onSecrets)) throw new Error(`onSecrets must be "mask" or "venice"`);
  return cfg;
}
