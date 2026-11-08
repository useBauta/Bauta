<p align="center">
  <img src="docs/mask.svg" width="96" alt="Bauta mask">
</p>

<h1 align="center">Bauta</h1>
<p align="center"><b>Your agent wears a mask.</b></p>

<p align="center">
A tiny local proxy that sits between your AI agent and the models.<br>
Secrets never leave your machine, and your agent keeps working when your limits run out.
</p>

---

AI coding agents read everything: your `.env`, your config files, your client's emails. All of it gets sent to whichever AI company you use. And when you hit your usage limit, the agent just stops.

**Bauta fixes both, on your own computer:**

- 🎭 **Masks secrets before they leave your machine.** API keys, passwords, database URLs, private keys and wallet seed phrases are swapped for placeholders like `[[BAUTA_SECRET_1]]`. The model works with the placeholder, and Bauta puts the real value back into the answer **locally**. So your agent still writes working code, but the provider never sees the key.
- 🛶 **Keeps you working when limits hit.** When Claude or OpenAI returns a limit or overload error, Bauta continues on a **private open model via [Venice](https://venice.ai)** (zero data retention), without interrupting your session.
- 👤 **Masks personal data too.** Emails, phone numbers, card numbers, plus any names you list (clients, your real name, codenames).
- 🔒 **Runs only on your machine.** No servers, no accounts, no telemetry, zero dependencies. The secret vault lives in memory and disappears when Bauta stops.
- 🌊 **A live dashboard** shows every request as a gondola on a night canal, with secrets caught at the mask gate.

## Quick start (2 minutes)

You need [Node.js 18.17+](https://nodejs.org) and a [Venice API key](https://venice.ai/settings/api) (the key is only needed for the fallback and private mode; masking works without it).

**1. Start Bauta**

```powershell
# Windows PowerShell
$env:VENICE_API_KEY="your-venice-key"; npx github:usebauta/bauta
```

```bash
# macOS / Linux
VENICE_API_KEY=your-venice-key npx github:usebauta/bauta
```

**2. Point your agent at it**

```powershell
# Claude Code (Windows PowerShell), in a second terminal
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8787"; claude
```

```bash
# Claude Code (macOS / Linux)
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

**3. Open the dashboard:** http://127.0.0.1:8787

That's it. Keep working as usual.

### Other agents

Any tool **running on your computer** that lets you set an **OpenAI-compatible base URL** (Cline, OpenClaw, Hermes, aider, Continue…). Tools that call the model from their own servers (Cursor, for example) cannot reach a proxy on 127.0.0.1.

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` |
| Model | `deepseek-v4-1-flash`, or any Venice model ID (run `npx github:usebauta/bauta models`) |
| API key | anything (Bauta uses your `VENICE_API_KEY`) |

By default these requests go to Venice (private). Set `BAUTA_OPENAI_PRIMARY=openai` to send them to OpenAI first (with your own OpenAI key) and fall back to Venice.

### Claude Code on Venice models only

Want Claude Code's interface with every model request going to Venice? In private mode Bauta sends every model request to Venice, answers Claude Code's other Anthropic API calls locally or refuses them, and never forwards them to Anthropic. Claude Code itself still has its own background traffic to Anthropic (updates, error reports), separate from model requests. Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` to turn it off.

```powershell
$env:VENICE_API_KEY="your-venice-key"; $env:BAUTA_MODE="private"; npx github:usebauta/bauta
# second terminal:
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8787"; $env:ANTHROPIC_API_KEY="bauta"; claude
```

## See what Bauta would mask

```bash
npx github:usebauta/bauta scan .env
```

```
.env  3 secrets · 1 personal  (openai-key, stripe-key, db-password, email)
  What the AI provider would see:

  OPENAI_API_KEY=[[BAUTA_SECRET_1]]
  STRIPE_SECRET_KEY=[[BAUTA_SECRET_2]]
  DATABASE_URL=postgres://admin:[[BAUTA_SECRET_3]]@db.internal:5432/app
  ADMIN_EMAIL=[[BAUTA_EMAIL_1]]
  MAX_TOKENS=16384

  Bauta would keep 4 values on your machine.
```

## How it works

```
 Your agent ──► Bauta (127.0.0.1) ──► mask gate ──► Anthropic / OpenAI   (masked)
 (Claude Code,      │                     │
  Cline, …)         │                     └── limit hit? ──► Venice      (private)
                    └──◄── answer, with real values restored locally ◄──┘
```

1. Your agent sends a request to Bauta instead of the provider.
2. Bauta finds secrets and personal data and swaps them for placeholders. The same value always gets the same placeholder, so conversations and prompt caching stay consistent.
3. The masked request goes to your normal provider, using your own login or key, which Bauta just passes along.
4. If the provider says "limit reached" or "overloaded" (429, 529, 5xx), Bauta translates the request and sends it to Venice instead. For Claude Code, it converts between Anthropic's and OpenAI's formats, including tool calls and streaming.
5. As the answer streams back, Bauta restores the real values, including inside tool calls, so files your agent writes contain the real key.

**What's masked**

| Secrets | Personal data |
|---|---|
| OpenAI, Anthropic, AWS, GitHub, Stripe, Slack and Google keys · JWTs · private key blocks · database URL passwords · Bearer tokens · `.env` values (`*_SECRET`, `*_TOKEN`, `*_PASSWORD`, `*_API_KEY` …) · `apiKey: "…"` style config · wallet seed phrases · wallet private keys | Emails · phone numbers (international format) · card numbers (checked with Luhn) · your own list of names/terms |

## Configuration

Environment variables (or a `bauta.config.json` in your project or `~/.bauta/config.json`):

| Variable | Default | What it does |
|---|---|---|
| `VENICE_API_KEY` | — | Your Venice key. Only read from the environment, never from files |
| `BAUTA_MODE` | `auto` | `auto` = your provider first, Venice when limits hit · `private` = everything to Venice |
| `BAUTA_VENICE_MODEL` | `deepseek-v4-1-flash` | Venice model for fallback/private mode |
| `BAUTA_ON_SECRETS` | `mask` | `venice` = send any request that contains secrets to Venice instead |
| `BAUTA_OPENAI_PRIMARY` | `venice` | For OpenAI-compatible tools: `venice` or `openai` |
| `BAUTA_TERMS` | — | Comma-separated words to always mask, e.g. `Acme Corp,Jane Doe` |
| `BAUTA_MASK_PII` | `1` | `0` turns off personal-data masking |
| `BAUTA_PORT` | `8787` | Port |

Example `bauta.config.json`:

```json
{
  "customTerms": ["Acme Corp", "Project Falcon"],
  "veniceModel": "kimi-k3-1-pro",
  "onSecrets": "mask"
}
```

## Privacy and security

- **Local only.** Bauta listens on `127.0.0.1` and refuses requests from other hosts and from web pages (Origin/Host checks), so websites can't use it.
- **Nothing stored.** No database, no logs of content, no telemetry. The dashboard shows metadata only (model, timing, counts), never prompts or answers.
- **Your credentials stay yours.** Your Anthropic/OpenAI login is passed straight to that provider and is never sent to Venice. Bauta only ever sends its own `VENICE_API_KEY` to Venice, never the key your tool sends.
- **Zero dependencies.** Plain Node.js, about 1,200 lines you can read in one sitting.

**Be aware:**

- Masking is pattern-based. It catches the common formats listed above, **not every possible secret.** Use `bauta scan` to check your files, and add your own terms.
- Masking changes what the model sees. If a task needs the *actual* secret value (for example "what does this key start with?"), the model only sees the placeholder.
- On fallback, Venice receives the same **masked** prompt your provider would have. Venice states it keeps no prompts or responses. See [Venice's privacy docs](https://docs.venice.ai/overview/privacy).
- Claude's "thinking" blocks are left untouched (they're cryptographically signed), so placeholders can appear there.

## Roadmap

- **Shield:** stop agents from leaking your identity to websites they visit (inspired by [@This_Liss](https://x.com/This_Liss)'s finding that agents send personal data in HTTP headers when sites ask).
- Opt-in, anonymous totals ("Bauta users kept N secrets private this week"), counts only.
- More providers and smarter detection.

## Credits

- Private open models via the [Venice API](https://docs.venice.ai).
- The idea of a local router for Claude Code comes from [claude-code-router](https://github.com/musistudio/claude-code-router), which Venice's own docs recommend.
- Secret patterns inspired by open-source scanners like gitleaks.

*Bauta is an independent open-source project. It is not affiliated with or endorsed by Venice, Anthropic or OpenAI.*

The *bauta* is the classic Venetian mask that let its wearer speak and act anonymously.

## License

MIT
