import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vault, newReport, maskText, maskDeep, restoreText, restoreDeep, StreamRestorer, scanText } from '../src/scanner.js';
import { DEFAULTS } from '../src/config.js';

const cfg = { ...DEFAULTS, customTerms: ['Acme Corp'] };

// Test values are assembled at runtime so this file never contains real-looking keys.
const OPENAI_KEY = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const ANTHROPIC_KEY = 'sk-ant-api03-' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe';
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLQ';
const GH_TOKEN = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789AB';
const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

test('masks common secrets and restores them', () => {
  const vault = new Vault();
  const report = newReport();
  const text = `OPENAI_API_KEY=${OPENAI_KEY}\nkey: ${ANTHROPIC_KEY}\naws ${AWS_KEY}\ntoken ${GH_TOKEN}`;
  const masked = maskText(text, cfg, vault, report);
  for (const v of [OPENAI_KEY, ANTHROPIC_KEY, AWS_KEY, GH_TOKEN]) assert.ok(!masked.includes(v), `leaked ${v}`);
  assert.equal(report.secrets, 4);
  assert.equal(restoreText(masked, vault), text);
});

test('same value always gets the same placeholder', () => {
  const vault = new Vault();
  const a = maskText(`x ${OPENAI_KEY}`, cfg, vault, newReport());
  const b = maskText(`y ${OPENAI_KEY}`, cfg, vault, newReport());
  assert.equal(a.slice(2), b.slice(2));
});

test('masks .env values, db passwords, seed phrases, private keys', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n-----END PRIVATE KEY-----';
  const text = [
    'DATABASE_PASSWORD="hunter2hunter2"',
    'DATABASE_URL=postgres://admin:s3cr3tPassw0rd@db.internal:5432/app',
    `MNEMONIC="${SEED}"`,
    `wallet private key: 0x${'ab'.repeat(32)}`,
    pem,
  ].join('\n');
  const { masked, report } = scanText(text, cfg);
  assert.ok(!masked.includes('hunter2hunter2'));
  assert.ok(!masked.includes('s3cr3tPassw0rd'));
  assert.ok(masked.includes('postgres://admin:[[BAUTA_SECRET_'));
  assert.ok(!masked.includes('abandon ability'));
  assert.ok(!masked.includes('ab'.repeat(32)));
  assert.ok(!masked.includes('MIIEvQ'));
  assert.equal(report.secrets, 5);
});

test('does not mask ordinary code', () => {
  const code = [
    'const MAX_TOKENS = 16384;',
    'TOKENIZER_PATH=/models/tokenizer.json',
    'const apiKey = process.env.OPENAI_API_KEY;',
    'API_KEY=your-api-key-here',
    'import x from "@types/node";',
    'git@github.com:user/repo.git',
    'const tx = "0x' + 'cd'.repeat(32) + '";',
  ].join('\n');
  const { masked, report } = scanText(code, cfg);
  assert.equal(masked, code);
  assert.equal(report.secrets + report.pii, 0);
});

test('masks personal data and custom terms', () => {
  const text = 'Email jane.doe@gmail.com or call +1 415 555 0132 about Acme Corp. Card 4242 4242 4242 4242. Docs: test@example.com';
  const { masked, report } = scanText(text, cfg);
  assert.ok(!masked.includes('jane.doe@gmail.com'));
  assert.ok(!masked.includes('415 555 0132'));
  assert.ok(!masked.includes('Acme Corp'));
  assert.ok(!masked.includes('4242 4242'));
  assert.ok(masked.includes('test@example.com'));
  assert.equal(report.pii, 4);
});

test('maskDeep skips ids, tool names, thinking blocks and images', () => {
  const vault = new Vault();
  const body = {
    model: 'claude-sonnet',
    system: [{ type: 'text', text: `key ${OPENAI_KEY}` }],
    tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: `here ${GH_TOKEN}` },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: `secret ${GH_TOKEN}`, signature: 'sig' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${GH_TOKEN}"` } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: `ok ${AWS_KEY}` },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo' } },
      ] },
    ],
  };
  const masked = maskDeep(body, cfg, vault, newReport());
  const s = JSON.stringify(masked);
  assert.ok(!s.includes(OPENAI_KEY));
  assert.ok(!masked.messages[0].content.includes(GH_TOKEN));
  assert.equal(masked.messages[1].content[0].thinking, `secret ${GH_TOKEN}`, 'thinking must be untouched');
  assert.equal(masked.messages[1].content[1].id, 'toolu_1');
  assert.ok(!masked.messages[1].content[1].input.command.includes(GH_TOKEN));
  assert.ok(!masked.messages[2].content[0].content.includes(AWS_KEY));
  assert.equal(masked.messages[2].content[1].source.data, 'iVBORw0KGgo');
  assert.equal(masked.tools[0].name, 'Bash');
});

test('stream restorer handles placeholders split across chunks', () => {
  const vault = new Vault();
  const masked = maskText(`use ${OPENAI_KEY} now`, cfg, vault, newReport());
  const r = new StreamRestorer(vault);
  let out = '';
  for (const ch of masked) out += r.push(ch);
  out += r.flush();
  assert.equal(out, `use ${OPENAI_KEY} now`);
});

test('json restore escapes values for tool arguments', () => {
  const vault = new Vault();
  const pw = 'pa"ss\\word123';
  const masked = maskText(`PASSWORD=${pw}`, cfg, vault, newReport());
  const token = masked.split('=')[1];
  const args = JSON.stringify({ cmd: `echo ${token}` });
  const restored = restoreText(args, vault, true);
  assert.deepEqual(JSON.parse(restored), { cmd: `echo ${pw}` });
});

test('restoreDeep leaves thinking blocks alone', () => {
  const vault = new Vault();
  const tok = maskText(`k ${GH_TOKEN}`, cfg, vault, newReport()).slice(2);
  const msg = { content: [{ type: 'thinking', thinking: tok, signature: 's' }, { type: 'text', text: tok }, { type: 'tool_use', id: 'a', name: 'b', input: { x: tok } }] };
  const out = restoreDeep(msg, vault);
  assert.equal(out.content[0].thinking, tok);
  assert.equal(out.content[1].text, GH_TOKEN);
  assert.equal(out.content[2].input.x, GH_TOKEN);
});
