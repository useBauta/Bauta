/* Bauta: the masking demo in <section id="try">.

   Left: a small .env you can edit. Right: what your provider would see once Bauta has masked it,
   redrawn as you type. The masking is done by bauta-scanner.js, which is the proxy's own scanner,
   so the placeholders, their numbering and the rules are the real ones. All of it happens in this
   tab. Nothing is sent anywhere.

   The page needs <div class="bauta-demo" data-demo></div>, demo.css and this file (it loads
   bauta-scanner.js from its own folder if the page has not). BautaDemo.mount(el) mounts one by
   hand, BautaDemo.instances lists the mounted ones. No dependencies. */

(function () {
  'use strict';

  const SCRIPT = document.currentScript;

  // ---------- Sample ----------

  // Fake values, put together from pieces so that no file here holds a string shaped like a real
  // key (GitHub's push protection would rightly stop it). The patterns make them easy to spot.
  const j = (...parts) => parts.join('');

  const SAMPLE = [
    '# production, do not commit',
    'NODE_ENV=production',
    'OPENAI_API_KEY=' + j('sk-', 'proj-', 'a1B2c3D4e5F6', 'g7H8i9J0k1L2', 'm3N4o5P6q7R8'),
    'STRIPE_SECRET_KEY=' + j('sk_', 'live_', '51Hq', 'AbCdEfGhIjKl', 'MnOpQrStUvWx'),
    'DATABASE_URL=' + j('postgres://', 'admin:', 'correct-horse-battery-staple', '@db.internal:5432/app'),
    'ADMIN_EMAIL=' + j('marta.rossi', '@', 'lagoon.test'),
    'MAX_TOKENS=16384',
  ].join('\n');

  // Lines the "add" buttons append, one per click, in turn. Once a list runs out it starts again,
  // so the repeat gets the placeholder it had the first time. The phone numbers come from ranges
  // kept free for films and books (US 555-01xx, UK 020 7946 0xxx, AU 02 5550 xxxx); the cards are
  // the usual test cards.
  const EXTRAS = {
    phone: {
      label: 'phone',
      name: 'phone number',
      lines: ['SUPPORT_PHONE=+1 415 555 0132', 'ONCALL_PHONE=+44 20 7946 0958', 'SALES_PHONE=+61 2 5550 1234'],
    },
    card: {
      label: 'card',
      name: 'card number',
      lines: ['TEST_CARD=4242 4242 4242 4242', 'BACKUP_CARD=5555 5555 5555 4444'],
    },
    github: {
      label: 'GitHub token',
      lines: [
        'GITHUB_TOKEN=' + j('gh', 'p_', 'Q4w8E2r6T0y5', 'U9i3O7p1A4s8', 'D2f6G0h5J9k3'),
        'DEPLOY_TOKEN=' + j('gh', 'p_', 'Zx81Cv72Bn63', 'Ml54Kj45Hg36', 'Fd27Sa18Qw09'),
      ],
    },
    aws: {
      label: 'AWS key',
      lines: ['AWS_ACCESS_KEY_ID=' + j('AK', 'IA', 'Q4W8E2R6', 'T0Y5U9I3')],
    },
  };

  // The proxy's defaults from src/config.js: secrets and personal data on, no custom terms.
  const CFG = {
    maskSecrets: true,
    maskPII: true,
    customTerms: [],
    allowEmails: ['example.com', 'example.org', 'example.net', 'users.noreply.github.com', 'noreply.github.com'],
  };

  // ---------- Timing ----------

  const SCRAMBLE_MS = 720;      // a red secret turning into its gold placeholder
  const MARK_MS = 450;          // a caught value lighting up on the left
  const STAGGER_MS = 80;
  const LEAD_MS = 260;          // the right side starts a beat after the left
  const DEBOUNCE_MS = 140;      // redraw the right side when typing pauses...
  const MAX_WAIT_MS = 520;      // ...or at least this often while it doesn't
  const SPEAK_MS = 900;         // the screen-reader copy waits for a proper pause
  const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';

  const motion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const calm = () => !!(motion && motion.matches);
  const now = () => performance.now();

  // ---------- Small helpers ----------

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const plural = (n, one, many) => (n === 1 ? one : many);

  // cubic-bezier(.2, .7, .2, 1), the site's --ease, for the one thing JavaScript fades itself.
  function ease(x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const cx = 0.6, bx = -0.6, ax = 1;          // x(t) for x1 = x2 = .2
    const cy = 2.1, by = -1.2, ay = 0.1;        // y(t) for y1 = .7, y2 = 1
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = ((ax * t + bx) * t + cx) * t - x;
      if (Math.abs(err) < 1e-5) break;
      t -= err / ((3 * ax * t + 2 * bx) * t + cx);
      t = Math.min(1, Math.max(0, t));
    }
    return ((ay * t + by) * t + cy) * t;
  }

  // Cheap repeatable noise, so a scramble looks the same if it gets redrawn halfway through.
  function hash(a, b, c) {
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 1, 0xc2b2ae35) ^ Math.imul(c + 7, 0x27d4eb2f);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    return h >>> 0;
  }

  // Where did the text change since the last draw? One changed stretch is enough to tell a value
  // that was there already (and is being edited) from one that just appeared.
  function editBetween(a, b) {
    const max = Math.min(a.length, b.length);
    let p = 0;
    while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    let s = 0;
    while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
    return { p, oldEnd: a.length - s, delta: b.length - a.length };
  }

  // The old span whose untouched part overlaps this new one, if there is one.
  function predecessor(span, olds, edit) {
    if (!edit) return null;
    for (const o of olds) {
      if (o.start < edit.p && span.start < Math.min(o.end, edit.p) && o.start < span.end) return o;
      if (o.end > edit.oldEnd) {
        const a = Math.max(o.start, edit.oldEnd) + edit.delta;
        const b = o.end + edit.delta;
        if (span.start < b && a < span.end) return o;
      }
    }
    return null;
  }

  // ---------- The demo ----------

  let uid = 0;
  const instances = [];

  function create(root, S) {
    const id = 'bauta-demo-' + ++uid;
    const extraButtons = Object.keys(EXTRAS)
      .map((k) => {
        const x = EXTRAS[k];
        return `<button type="button" class="bd-add" data-add="${k}"${x.name ? ` aria-label="${x.name}"` : ''}>${x.label}</button>`;
      })
      .join('');

    root.classList.add('bauta-demo');
    root.innerHTML = `
<div class="bd-frame">
  <div class="bd-pane bd-pane--in">
    <div class="bd-head">
      <label class="bd-tab" for="${id}-in"><span class="bd-file">.env</span><span class="bd-dirty" aria-hidden="true"></span><span class="bd-sr">, a sample you can edit</span></label>
      <span class="bd-where">on your machine</span>
    </div>
    <div class="bd-edit">
      <div class="bd-mirror" aria-hidden="true"></div>
      <textarea class="bd-input" id="${id}-in" rows="1" maxlength="4000" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" wrap="soft" placeholder="KEY=value, one per line" aria-describedby="${id}-note"></textarea>
    </div>
    <div class="bd-tools" role="group" aria-labelledby="${id}-add"><span class="bd-tools__label" id="${id}-add">Add a line:</span>${extraButtons}</div>
  </div>
  <div class="bd-pane bd-pane--out" role="region" aria-labelledby="${id}-out">
    <span class="bd-gate" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="M2.5 8h10M9 4.5 12.5 8 9 11.5"/></svg></span>
    <div class="bd-head">
      <span class="bd-title" id="${id}-out">What your provider sees</span>
    </div>
    <div class="bd-body">
      <div class="bd-out" aria-hidden="true"></div>
      <div class="bd-sr bd-said" aria-live="polite"></div>
    </div>
  </div>
  <p class="bd-sum" aria-live="polite"><span class="bd-sum__in"></span></p>
</div>
<div class="bd-foot">
  <p class="bd-note" id="${id}-note">This demo runs in your browser and sends nothing. Use fake values.</p>
  <button type="button" class="bd-reset">Reset</button>
</div>`;

    const $ = (sel) => root.querySelector(sel);
    const input = $('.bd-input');
    const mirror = $('.bd-mirror');
    const out = $('.bd-out');
    const said = $('.bd-said');
    const sum = $('.bd-sum');
    const sumIn = $('.bd-sum__in');
    const tab = $('.bd-tab');
    const gate = $('.bd-gate');
    const paneIn = $('.bd-pane--in');
    const paneOut = $('.bd-pane--out');

    const state = {
      marks: [], markText: '',      // left: caught values
      chips: [], chipText: '',      // right: placeholders
      introIn: false, introOut: false,
      counts: null, summary: '',
      masked: '', lines: [],
      added: {}, hot: null,
      raf: 0, outTimer: 0, firstPending: 0, speakTimer: 0,
      io: null,
    };

    // ----- Left: the editable file, with what Bauta caught lit up underneath -----

    function drawMirror(t) {
      const text = input.value;
      const edit = editBetween(state.markText, text);
      const fresh = [];
      state.marks = S.findSpans(text, CFG).map((s) => {
        const before = predecessor(s, state.marks, edit);
        const m = { start: s.start, end: s.end, pii: s.category === 'pii', bornAt: before ? before.bornAt : 0 };
        if (!before) fresh.push(m);
        return m;
      });
      fresh.forEach((m, i) => {
        m.bornAt = calm() ? -Infinity : state.introIn ? t + i * STAGGER_MS : Infinity;
      });
      state.markText = text;
      paintMirror(t);
    }

    // One block per line, so the line numbers can sit in the margin. A mark that runs over a line
    // break (a private key block, say) is cut into one piece per line.
    function paintMirror(t) {
      const text = state.markText;
      const lines = [''];
      const put = (s, wrap) => {
        s.split('\n').forEach((part, i) => {
          if (i) lines.push('');
          if (part) lines[lines.length - 1] += wrap ? wrap(esc(part)) : esc(part);
        });
      };
      let pos = 0;
      state.marks.forEach((m, k) => {
        let cls = m.pii ? 'bd-mark bd-mark--pii' : 'bd-mark';
        let style = '';
        if (m.bornAt === Infinity) cls += ' is-wait';
        else if (t - m.bornAt < MARK_MS) {
          cls += ' is-fresh';
          style = ` style="animation-delay:${Math.round(m.bornAt - t)}ms"`;
        }
        put(text.slice(pos, m.start));
        put(text.slice(m.start, m.end), (inner) => `<mark class="${cls}" data-i="${k}"${style}>${inner}</mark>`);
        pos = m.end;
      });
      put(text.slice(pos));
      if (state.hot) requestAnimationFrame(() => light(state.hot));
      // An empty line still needs its height, as it has in the textarea.
      mirror.innerHTML = lines.map((l, i) => `<div class="bd-line" data-n="${i + 1}">${l || '\u200b'}</div>`).join('');
    }

    // Side by side, each line on the right is given the height of its line on the left, so the two
    // stay level even where a long key wraps on one side only.
    function align() {
      const rows = out.children;
      const level = paneIn.offsetTop === paneOut.offsetTop && mirror.children.length;
      const heights = level ? Array.from(mirror.children, (d) => d.getBoundingClientRect().height) : null;
      for (const row of rows) {
        if (!level || !row.dataset.n) { row.style.minHeight = ''; continue; }
        const from = Number(row.dataset.n) - 1;
        const to = from + Number(row.dataset.span || 1);
        let h = 0;
        for (let i = from; i < to; i++) h += heights[i] || 0;
        row.style.minHeight = h ? `${h.toFixed(2)}px` : '';
      }
    }

    // ----- Right: the masked text, drawn from the same scan maskText() does -----

    function drawOutput(t, opts = {}) {
      clearTimeout(state.outTimer);
      state.firstPending = 0;

      const text = input.value;
      const vault = new S.Vault();
      const report = S.newReport();
      const masked = S.maskText(text, CFG, vault, report);
      const spans = S.findSpans(text, CFG);
      const edit = opts.replay ? null : editBetween(state.chipText, text);

      const fresh = [];
      const chips = spans.map((s) => {
        const before = predecessor(s, state.chips, edit);
        const c = {
          start: s.start,
          end: s.end,
          value: s.value,
          token: vault.byValue.get(s.value),
          rule: s.name,
          bornAt: before ? before.bornAt : 0,
          soft: before ? before.soft : false,
          seed: before ? before.seed : (Math.random() * 2147483647) | 0,
          el: null,
          shown: '',
        };
        if (!before) fresh.push(c);
        return c;
      });
      const start = t + (opts.lead || 0);
      // Until the pane has been seen, a new placeholder is shown as it ends up (never the secret);
      // it gets a short gold shimmer once the pane scrolls into view.
      fresh.forEach((c, i) => {
        if (calm()) c.bornAt = -Infinity;
        else if (state.introOut) c.bornAt = start + i * STAGGER_MS;
        else { c.bornAt = -Infinity; c.intro = true; }
      });

      // Rebuild the output around the spans; it has to come out exactly as maskText's. Each row
      // remembers which line of the file it starts on (a masked private key swallows several).
      const rows = [{ n: 1, html: '' }];
      let line = 1;
      let plain = '';
      let pos = 0;
      const put = (s) => {
        s.split('\n').forEach((part, i) => {
          if (i) rows.push({ n: ++line, html: '' });
          rows[rows.length - 1].html += esc(part);
        });
        plain += s;
      };
      chips.forEach((c, k) => {
        put(text.slice(pos, c.start));
        rows[rows.length - 1].html += `<span class="bd-chip" data-i="${k}" title="${esc(c.rule)}"></span>`;
        plain += c.token;
        line += c.value.split('\n').length - 1;
        pos = c.end;
      });
      put(text.slice(pos));

      if (plain === masked) {
        out.innerHTML = text
          ? rows.map((r, k) => {
            const span = (k + 1 < rows.length ? rows[k + 1].n : line + 1) - r.n;
            return `<div class="bd-line" data-n="${r.n}"${span > 1 ? ` data-span="${span}"` : ''}>${r.html || '\u200b'}</div>`;
          }).join('')
          : '';
        out.querySelectorAll('.bd-chip').forEach((el, i) => { chips[i].el = el; });
      } else {
        out.textContent = masked;   // never expected; plain text beats a wrong picture
        chips.length = 0;
      }
      align();
      if (state.hot) requestAnimationFrame(() => light(state.hot));

      state.chips = chips;
      state.chipText = text;
      state.masked = masked;
      if (fresh.length && state.introOut && !calm() && !opts.replay) nudge();
      paintChips(t);
      summarize(vault, report, masked);
      speakLater(masked, opts.speakNow);
      root.dispatchEvent(new CustomEvent('bauta-demo:update', { detail: { ...state.counts, masked } }));
    }

    // The source a chip scrambles from: the secret itself, cut or padded to the placeholder's
    // length so nothing around it moves while it turns.
    function source(c) {
      const n = c.token.length;
      const v = c.value.replace(/[\r\n\t]/g, ' ');
      return v.length >= n ? v.slice(0, n) : v + ' '.repeat(n - v.length);
    }

    function frame(c, t) {
      const target = c.token;
      const src = source(c);
      const n = target.length;
      const tick = Math.floor(t / 50);
      let html = '';
      let run = '';
      let kind = '';
      const flush = () => {
        if (run) html += kind ? `<span class="bd-${kind}">${esc(run)}</span>` : esc(run);
        run = '';
      };
      for (let i = 0; i < n; i++) {
        const p = n > 1 ? i / (n - 1) : 0;
        const churnAt = p * 160;
        const settleAt = Math.min(SCRAMBLE_MS - 20, 140 + p * (SCRAMBLE_MS - 260) + (hash(c.seed, i, 3) % 1000) * 0.09);
        let k;
        let ch;
        if (t >= settleAt) { k = ''; ch = target[i]; }
        else if (t < churnAt && !c.soft) { k = 's'; ch = src[i]; }
        else { k = c.soft ? 'g' : 'z'; ch = GLYPHS[hash(c.seed, i, tick) % GLYPHS.length]; }
        if (k !== kind) { flush(); kind = k; }
        run += ch;
      }
      flush();
      return html;
    }

    function paintChips(t) {
      let busy = false;
      for (const c of state.chips) {
        const age = t - c.bornAt;
        const cl = c.el.classList;
        // A soft chip waiting for its shimmer keeps showing the placeholder.
        if (age >= SCRAMBLE_MS || (c.soft && age < 0)) {
          if (age < 0) busy = true;
          else c.soft = false;
          if (c.shown !== 'done') {
            cl.remove('is-wait', 'is-run');
            c.el.style.removeProperty('--bd-k');
            c.el.textContent = c.token;
            c.shown = 'done';
          }
          continue;
        }
        if (age < 0) {
          if (c.bornAt !== Infinity) busy = true;
          if (c.shown !== 'wait') {
            cl.remove('is-run');
            cl.add('is-wait');
            c.el.innerHTML = `<span class="bd-s">${esc(source(c))}</span>`;
            c.shown = 'wait';
          }
          continue;
        }
        busy = true;
        if (c.shown !== 'run') {
          cl.remove('is-wait');
          cl.add('is-run');
        }
        if (!c.soft) c.el.style.setProperty('--bd-k', ease((age - 90) / (SCRAMBLE_MS - 90)).toFixed(3));
        c.el.innerHTML = frame(c, age);
        c.shown = 'run';
      }
      if (busy && !state.raf) state.raf = requestAnimationFrame(loop);
      return busy;
    }

    function loop(t) {
      state.raf = 0;
      paintChips(t);
    }

    function nudge() {
      gate.classList.remove('is-nudge');
      void gate.offsetWidth;
      gate.classList.add('is-nudge');
    }

    // ----- Summary, in the words `bauta scan` uses -----

    function summarize(vault, report, masked) {
      const secrets = vault.countKind('SECRET');
      const values = vault.size;
      const personal = values - secrets;
      const rules = [...report.types];
      const prev = state.counts;
      state.counts = { secrets, personal, values, rules };

      const none = masked ? 'Nothing to mask. Your provider would see exactly this.' : 'Nothing to mask.';
      const text = values
        ? `${secrets} ${plural(secrets, 'secret', 'secrets')} · ${personal} personal · ${values} ${plural(values, 'value stays', 'values stay')} on your machine (${rules.join(', ')})`
        : none;
      if (text === state.summary) return;
      state.summary = text;

      const num = (n, key) => {
        const changed = prev && prev[key] !== n && !calm();
        return `<b class="bd-n${changed ? ' is-tick' : ''}">${n}</b>`;
      };
      // The spaces between the spans are for screen readers; the flex gap does the spacing on screen.
      sumIn.innerHTML = values
        ? `<span class="bd-count">${num(secrets, 'secrets')} ${plural(secrets, 'secret', 'secrets')} · ${num(personal, 'personal')} personal</span> ` +
          `<span class="bd-keep">${num(values, 'values')} ${plural(values, 'value stays', 'values stay')} on your machine</span> ` +
          `<span class="bd-rules">(${esc(rules.join(', '))})</span>`
        : `<span class="bd-none">${none}</span>`;
    }

    function revealSummary(delay) {
      if (calm()) { sum.classList.remove('is-wait'); return; }
      sum.style.setProperty('--bd-delay', Math.max(0, Math.round(delay)) + 'ms');
      sum.classList.remove('is-wait');
      sum.classList.add('is-in');
    }

    // ----- Screen readers: a plain copy of the output, changed line by line after a pause -----

    function speakLater(masked, immediately) {
      clearTimeout(state.speakTimer);
      if (immediately) speak(masked);
      else state.speakTimer = setTimeout(() => speak(masked), SPEAK_MS);
    }

    function speak(masked) {
      const lines = masked.split('\n');
      lines.forEach((line, i) => {
        const el = said.children[i] || said.appendChild(document.createElement('div'));
        if (state.lines[i] !== line || el.textContent !== line) el.textContent = line;
      });
      while (said.children.length > lines.length) said.lastChild.remove();
      state.lines = lines;
    }

    // ----- Arriving on screen: each side plays once, when it is actually visible -----

    // If the page is still fading the demo in, give it a moment, so the first scramble is seen.
    function fadingIn() {
      for (let el = root; el && el !== document.body; el = el.parentElement) {
        if (parseFloat(getComputedStyle(el).opacity) < 0.9) return 420;
      }
      return 0;
    }

    function introIn(t) {
      if (state.introIn) return;
      state.introIn = true;
      const from = t + fadingIn();
      let i = 0;
      for (const m of state.marks) if (m.bornAt === Infinity) m.bornAt = from + i++ * STAGGER_MS;
      paintMirror(t);
    }

    function introOut(t) {
      if (state.introOut) return;
      state.introOut = true;
      const lead = LEAD_MS + fadingIn();
      let i = 0;
      for (const c of state.chips) {
        if (c.intro) { c.intro = false; c.soft = true; c.bornAt = t + lead + i++ * STAGGER_MS; }
        else if (c.bornAt === Infinity) c.bornAt = t + lead + i++ * STAGGER_MS;
      }
      paintChips(t);
      if (i && !calm()) setTimeout(nudge, lead);
      revealSummary(i ? lead + (i - 1) * STAGGER_MS + SCRAMBLE_MS - 240 : 0);
    }

    function watch() {
      if (calm() || !('IntersectionObserver' in window)) {
        state.introIn = state.introOut = true;
        return;
      }
      sum.classList.add('is-wait');
      // A side plays once its first lines are really on screen: about 150 px of it, or a third of
      // a short one. The right side also goes as soon as its first placeholder is clear of the
      // bottom edge, so a red value never sits there waiting.
      state.io = new IntersectionObserver((entries) => {
        const t = now();
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          let ready = e.intersectionRect.height >= Math.min(150, e.boundingClientRect.height * 0.35);
          if (!ready && e.target === paneOut) {
            const first = out.querySelector('.bd-chip');
            ready = !!first && first.getBoundingClientRect().bottom <= window.innerHeight - 24;
          }
          if (!ready) continue;
          if (e.target === paneIn) introIn(t);
          else introOut(t);
          state.io.unobserve(e.target);
        }
      }, { threshold: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35], rootMargin: '0px 0px -8% 0px' });
      state.io.observe(paneIn);
      state.io.observe(paneOut);
    }

    // ----- Pointing at a placeholder lights up the value it stands for, and every repeat -----

    function light(token) {
      out.querySelectorAll('.bd-chip').forEach((el, i) => {
        el.classList.toggle('is-hot', !!token && state.chips[i] && state.chips[i].token === token);
      });
      const inStep = state.markText === state.chipText;
      mirror.querySelectorAll('mark').forEach((el) => {
        const c = inStep ? state.chips[Number(el.dataset.i)] : null;
        el.classList.toggle('is-hot', !!token && !!c && c.token === token);
      });
    }

    function onPoint(e) {
      const chip = e.target.closest('.bd-chip');
      const c = chip ? state.chips[Number(chip.dataset.i)] : null;
      const token = c ? c.token : null;
      if (token !== state.hot) { state.hot = token; light(token); }
    }

    function onLeave() {
      if (state.hot) { state.hot = null; light(null); }
    }

    // ----- Input -----

    function scheduleOutput() {
      const t = now();
      if (!state.firstPending) state.firstPending = t;
      clearTimeout(state.outTimer);
      const wait = Math.min(DEBOUNCE_MS, Math.max(0, state.firstPending + MAX_WAIT_MS - t));
      state.outTimer = setTimeout(() => drawOutput(now()), wait);
    }

    function changed() {
      tab.classList.toggle('is-dirty', input.value !== SAMPLE);
    }

    function onInput() {
      const t = now();
      if (!state.introIn) introIn(t);
      drawMirror(t);
      changed();
      scheduleOutput();
    }

    function add(kind) {
      const extra = EXTRAS[kind];
      if (!extra) return;
      const n = (state.added[kind] = (state.added[kind] || 0) + 1);
      const line = extra.lines[(n - 1) % extra.lines.length];
      let text = input.value;
      if (text && !text.endsWith('\n')) text += '\n';
      if (text.length + line.length > input.maxLength) return;
      input.value = text + line;
      const t = now();
      if (!state.introIn) introIn(t);
      if (!state.introOut) introOut(t);
      drawMirror(t);
      changed();
      drawOutput(t, { speakNow: true });
    }

    // Back to the sample, and play the whole thing again.
    function reset() {
      input.value = SAMPLE;
      state.added = {};
      changed();
      replay();
    }

    function replay() {
      const t = now();
      state.introIn = state.introOut = true;
      state.marks = [];
      state.markText = '';
      drawMirror(t);
      state.chips = [];
      drawOutput(t, { replay: true, lead: LEAD_MS, speakNow: true });
      const n = state.chips.length;
      if (!calm() && n) {
        setTimeout(nudge, LEAD_MS);
        sum.classList.remove('is-in');
        void sum.offsetWidth;
        revealSummary(LEAD_MS + (n - 1) * STAGGER_MS + SCRAMBLE_MS - 240);
      }
    }

    // Jump every animation to its end (tests, or a visitor who switched motion off mid-way).
    function finish() {
      state.introIn = state.introOut = true;
      for (const m of state.marks) m.bornAt = -Infinity;
      for (const c of state.chips) { c.bornAt = -Infinity; c.intro = c.soft = false; }
      paintMirror(now());
      paintChips(now());
      sum.classList.remove('is-wait', 'is-in');
    }

    function onClick(e) {
      const btn = e.target.closest('button');
      if (!btn || !root.contains(btn)) return;
      if (btn.classList.contains('bd-reset')) reset();
      else if (btn.dataset.add) add(btn.dataset.add);
    }

    function onMotionChange() {
      if (calm()) finish();
    }

    input.addEventListener('input', onInput);
    root.addEventListener('click', onClick);
    out.addEventListener('mouseover', onPoint);
    out.addEventListener('mouseleave', onLeave);
    window.addEventListener('beforeprint', finish);
    if (motion && motion.addEventListener) motion.addEventListener('change', onMotionChange);

    // A new width means new line wrapping, and new heights for the right side to copy. (Typing
    // changes heights too, but drawOutput lines things up again itself.)
    let alignQueued = 0;
    let lastWidth = 0;
    const queueAlign = () => {
      if (!alignQueued) alignQueued = requestAnimationFrame(() => { alignQueued = 0; align(); });
    };
    const resize = 'ResizeObserver' in window
      ? new ResizeObserver((entries) => {
        const w = entries[entries.length - 1].contentRect.width;
        if (w !== lastWidth) { lastWidth = w; queueAlign(); }
      })
      : null;
    if (resize) resize.observe(mirror);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueAlign);

    // ----- First draw -----

    input.value = SAMPLE;
    watch();
    const t0 = now();
    drawMirror(t0);
    drawOutput(t0, { speakNow: true });

    const api = {
      root,
      sample: SAMPLE,
      get text() { return input.value; },
      get masked() { return state.masked; },
      get counts() { return { ...state.counts }; },
      setText(text) {
        input.value = String(text);
        onInput();
        drawOutput(now(), { speakNow: true });
      },
      add,
      reset,
      replay,
      finish,
      destroy() {
        cancelAnimationFrame(state.raf);
        cancelAnimationFrame(alignQueued);
        clearTimeout(state.outTimer);
        clearTimeout(state.speakTimer);
        if (state.io) state.io.disconnect();
        if (resize) resize.disconnect();
        input.removeEventListener('input', onInput);
        root.removeEventListener('click', onClick);
        out.removeEventListener('mouseover', onPoint);
        out.removeEventListener('mouseleave', onLeave);
        window.removeEventListener('beforeprint', finish);
        if (motion && motion.removeEventListener) motion.removeEventListener('change', onMotionChange);
        const i = instances.indexOf(api);
        if (i !== -1) instances.splice(i, 1);
        delete root.bautaDemo;
      },
    };
    root.bautaDemo = api;
    instances.push(api);
    return api;
  }

  // ---------- Loading and mounting ----------

  function withScanner(done) {
    if (window.BautaScanner) return done(window.BautaScanner);
    let tag = document.querySelector('script[src*="bauta-scanner"]');
    if (!tag) {
      tag = document.createElement('script');
      const base = SCRIPT && SCRIPT.src ? SCRIPT.src : new URL('assets/', document.baseURI).href;
      tag.src = new URL('bauta-scanner.js', base).href;
      document.head.appendChild(tag);
    }
    tag.addEventListener('load', () => window.BautaScanner && done(window.BautaScanner), { once: true });
    tag.addEventListener('error', () => console.error('Bauta demo: bauta-scanner.js did not load'), { once: true });
  }

  function mount(el) {
    if (!el || el.bautaDemo) return el && el.bautaDemo;
    if (!window.BautaScanner) {
      withScanner(() => mount(el));
      return null;
    }
    return create(el, window.BautaScanner);
  }

  function mountAll() {
    document.querySelectorAll('[data-demo]').forEach((el) => mount(el));
  }

  function whenReady(fn) {
    let ran = false;
    const run = () => { if (!ran) { ran = true; fn(); } };
    if (document.readyState === 'complete') run();
    else {
      document.addEventListener('DOMContentLoaded', run, { once: true });
      window.addEventListener('load', run, { once: true });
    }
  }

  window.BautaDemo = { mount, instances, sample: SAMPLE };
  whenReady(() => withScanner(mountAll));
})();
