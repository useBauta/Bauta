#!/usr/bin/env node
import fs from 'node:fs';
import { loadConfig, VERSION } from '../src/config.js';
import { createBauta } from '../src/server.js';
import { scanText } from '../src/scanner.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const gold = c('38;5;179');
const dim = c('2');
const bold = c('1');
const red = c('38;5;203');
const green = c('38;5;114');
const blue = c('38;5;111');

const args = process.argv.slice(2);
const first = args[0];
const cmd = !first ? 'start'
  : ['--version', '-v'].includes(first) ? 'version'
  : ['--help', '-h'].includes(first) ? 'help'
  : first.startsWith('-') ? 'start'
  : first;
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  }),
);

function banner() {
  return [
    '',
    gold('   ▄▀▀▀▀▀▀▄'),
    gold('   █ ◣  ◢ █ ') + bold(' BAUTA ') + dim(`v${VERSION}`),
    gold('   ▀▄  ▄▄▀  ') + dim(' your agent wears a mask'),
    gold('     ▀▀'),
    '',
  ].join('\n');
}

function setupText(cfg) {
  const url = `http://${cfg.host}:${cfg.port}`;
  return `${bold('Connect your agent')}

  ${gold('Claude Code')}
    PowerShell:  ${blue(`$env:ANTHROPIC_BASE_URL="${url}"; claude`)}
    macOS/Linux: ${blue(`ANTHROPIC_BASE_URL=${url} claude`)}
    Uses your normal Claude login. When you hit a limit, Bauta continues on Venice.

  ${gold('Claude Code on Venice models only (every model request goes to Venice)')}
    Start Bauta with ${blue('BAUTA_MODE=private')}, then set ${blue('ANTHROPIC_API_KEY=bauta')} (any value) and the base URL above.

  ${gold('Cline, OpenClaw, Hermes, aider: OpenAI-compatible tools on this computer')}
    Base URL: ${blue(`${url}/v1`)}   Model: ${blue(cfg.veniceModel)} (or any Venice model ID)
    Requests go to Venice by default. Set ${blue('BAUTA_OPENAI_PRIMARY=openai')} to use your OpenAI key first.

  ${gold('Check what Bauta would mask')}
    ${blue('npx bauta scan .env')}
`;
}

function fmtTime(t) {
  return new Date(t).toTimeString().slice(0, 8);
}

function logLine(ev) {
  const target = ev.target === 'venice' ? gold('venice') : blue(ev.target);
  const parts = [dim(fmtTime(ev.time)), `${(ev.model || '?').slice(0, 28).padEnd(28)} → ${target.padEnd(useColor ? 17 : 9)}`];
  if (ev.fallback) parts.push(gold(`↺ fallback (${ev.reason})`));
  else if (ev.reason) parts.push(gold(ev.reason));
  const masks = [];
  if (ev.secrets) masks.push(`${ev.secrets} secret${ev.secrets > 1 ? 's' : ''}`);
  if (ev.pii) masks.push(`${ev.pii} personal`);
  if (masks.length) parts.push(red(`◆ masked ${masks.join(', ')}`));
  const st = ev.status || '-';
  parts.push(st >= 200 && st < 300 ? green(st) : red(st));
  parts.push(dim(`${(ev.ms / 1000).toFixed(1)}s`));
  console.log('  ' + parts.join('  '));
}

async function start() {
  let cfg;
  try {
    cfg = loadConfig({
      ...(flags.port ? { port: Number(flags.port) } : {}),
      ...(flags.private ? { mode: 'private' } : {}),
    });
  } catch (err) {
    console.error(red(`Config error: ${err.message}`));
    process.exit(1);
  }
  const { server } = createBauta(cfg, { log: cfg.logRequests ? logLine : () => {} });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(red(`Port ${cfg.port} is already in use. Is Bauta already running? Try --port=8788`));
    else console.error(red(err.message));
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    const url = `http://${cfg.host}:${cfg.port}`;
    console.log(banner());
    console.log(`  ${dim('Proxy     ')} ${url}`);
    console.log(`  ${dim('Dashboard ')} ${gold(url + '/')}`);
    console.log(`  ${dim('Mode      ')} ${cfg.mode === 'private' ? gold('private: everything goes to Venice') : 'auto: your provider first, Venice when limits hit'}`);
    console.log(`  ${dim('Venice    ')} ${cfg.veniceKey ? green('✓ key found') + dim(`  model ${cfg.veniceModel}`) : red('✗ no VENICE_API_KEY') + dim('  (masking works, fallback is off)')}`);
    console.log(`  ${dim('Masking   ')} secrets ${cfg.maskSecrets ? green('on') : red('off')} · personal data ${cfg.maskPII ? green('on') : red('off')}${cfg.customTerms.length ? ` · ${cfg.customTerms.length} custom terms` : ''}`);
    if (cfg.configSource) console.log(`  ${dim('Config    ')} ${cfg.configSource}`);
    console.log(`  ${dim('Privacy   ')} runs only on this computer · stores nothing · sends no telemetry\n`);
    console.log(setupText(cfg));
    console.log(dim('  Waiting for requests… (Ctrl+C to stop)\n'));
  });
  const stop = () => { console.log(dim('\n  Bauta stopped. The secret vault was in memory only and is now gone.')); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function scan(files) {
  if (!files.length) {
    console.error('Usage: bauta scan <file> [more files]');
    process.exit(1);
  }
  const cfg = loadConfig();
  let total = 0;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8').replace(/^﻿/, ''); } catch (err) { console.error(red(`Cannot read ${f}: ${err.message}`)); continue; }
    const { masked, report } = scanText(text, cfg);
    total += report.secrets + report.pii;
    console.log(`\n${bold(f)}  ${report.secrets ? red(`${report.secrets} secret${report.secrets > 1 ? 's' : ''}`) : green('0 secrets')} · ${report.pii ? red(`${report.pii} personal`) : green('0 personal')}${report.types.size ? dim(`  (${[...report.types].join(', ')})`) : ''}`);
    console.log(dim('  What the AI provider would see:\n'));
    const lines = masked.split('\n');
    for (const line of lines.slice(0, 60)) console.log('  ' + line.replace(/\[\[BAUTA_[A-Z]+_\d+\]\]/g, (m) => gold(m)));
    if (lines.length > 60) console.log(dim(`  … ${lines.length - 60} more lines`));
  }
  console.log(`\n  ${total ? gold(`Bauta would keep ${total} value${total > 1 ? 's' : ''} on your machine.`) : green('Nothing sensitive found.')}\n`);
}

async function models() {
  const cfg = loadConfig();
  if (!cfg.veniceKey) { console.error(red('Set VENICE_API_KEY first.')); process.exit(1); }
  const res = await fetch(`${cfg.veniceUrl}/models`, { headers: { authorization: `Bearer ${cfg.veniceKey}` } });
  if (!res.ok) { console.error(red(`Venice returned ${res.status}`)); process.exit(1); }
  const j = await res.json();
  const ids = (j.data || []).filter((m) => !m.type || m.type === 'text').map((m) => m.id);
  console.log(`\n${bold('Venice text models')} ${dim(`(${ids.length})`)}\n`);
  for (const id of ids) console.log(`  ${id === cfg.veniceModel ? gold(id + '  ← current') : id}`);
  console.log(dim(`\n  Change with BAUTA_VENICE_MODEL=<id>\n`));
}

function help() {
  console.log(`${banner()}
  ${bold('Usage')}
    npx bauta              start the proxy (same as "bauta start")
    npx bauta start        options: --port=8787  --private
    npx bauta scan <file>  show what Bauta would mask in a file
    npx bauta setup        how to connect Claude Code and other agents
    npx bauta models       list Venice models (needs VENICE_API_KEY)

  ${bold('Environment')}
    VENICE_API_KEY         your Venice API key (fallback and private mode)
    BAUTA_MODE             auto (default) or private
    BAUTA_VENICE_MODEL     Venice model for fallback (default deepseek-v4-1-flash)
    BAUTA_ON_SECRETS       mask (default) or venice (send secret-bearing requests to Venice)
    BAUTA_OPENAI_PRIMARY   venice (default) or openai, for OpenAI-compatible tools
    BAUTA_TERMS            comma-separated words to always mask (names, clients…)
    BAUTA_MASK_PII=0       turn off personal-data masking
    BAUTA_PORT             port (default 8787)
`);
}

switch (cmd) {
  case 'start': await start(); break;
  case 'scan': scan(args.slice(1).filter((a) => !a.startsWith('--'))); break;
  case 'setup': console.log(setupText(loadConfig())); break;
  case 'models': await models(); break;
  case 'version': case '--version': case '-v': console.log(VERSION); break;
  case 'help': case '--help': case '-h': help(); break;
  default: console.error(red(`Unknown command "${cmd}".`)); help(); process.exit(1);
}
