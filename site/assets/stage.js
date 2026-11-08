/*
  Bauta hero stage: a palazzo gallery at night, with the amber terminal running Bauta.
  Classic script, no dependencies. Builds the scene inside every [data-stage].
  Each time the screen masks a request it fires document 'bauta:masked' { count, total }.
*/
(function () {
  'use strict';

  if (typeof document === 'undefined' || !document.querySelectorAll) return;

  // The scene is drawn in world units: 1000 tall, wide enough to crop at 2.4:1.
  var WORLD_W = 2600, WORLD_H = 1000;
  var FOCUS_X = 1750, FOCUS_Y = 594;   // terminal centre, and the vertical centre used when zoomed
  var MIN_VIEW_W = 620;                // narrow boxes zoom in so the exhibit stays big
  var VP_X = 1648, VP_Y = 330, FOCAL = 3475, EYE = 1.4;
  var PAD = 28;                        // parallax room around full-size layers, css px

  var MOON = '#9fb4d8', AMBER = '#ffb547';

  function proj(X, Y, z) { return [VP_X + FOCAL * X / z, VP_Y + FOCAL * (EYE - Y) / z]; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), s | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash3(a, b, c) {
    var h = Math.imul(a + 1, 374761393) ^ Math.imul(b + 7, 668265263) ^ Math.imul(c + 13, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function stops(g, list) {
    for (var i = 0; i < list.length; i++) g.addColorStop(list[i][0], list[i][1]);
    return g;
  }
  function lin(c, x0, y0, x1, y1, list) { return stops(c.createLinearGradient(x0, y0, x1, y1), list); }
  function rad(c, x0, y0, r0, x1, y1, r1, list) { return stops(c.createRadialGradient(x0, y0, r0, x1, y1, r1), list); }

  function rrect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function poly(c, pts) {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath();
  }

  // Soft ellipse, used for contact shadows and light pools.
  function blob(c, x, y, rx, ry, color, edge) {
    c.save();
    c.translate(x, y);
    c.scale(1, ry / rx);
    c.fillStyle = rad(c, 0, 0, 0, 0, 0, rx, [[0, color], [edge || 0.35, color], [1, color.replace(/[\d.]+\)$/, '0)')]]);
    c.fillRect(-rx, -rx, rx * 2, rx * 2);
    c.restore();
  }

  function hull(pts) {
    pts = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lo = [], up = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], pts[i]) <= 0) lo.pop();
      lo.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (up.length > 1 && cross(up[up.length - 2], up[up.length - 1], pts[i]) <= 0) up.pop();
      up.push(pts[i]);
    }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  // Some Safari versions ignore ctx.filter; there we blur by sampling down and up.
  var CAN_FILTER = (function () {
    try {
      var x = makeCanvas(2, 2).getContext('2d');
      x.filter = 'blur(2px)';
      return x.filter === 'blur(2px)';
    } catch (e) { return false; }
  })();

  // Draws src onto c (identity transform expected) blurred by px device pixels.
  function drawBlurred(c, src, px, x, y) {
    x = x || 0; y = y || 0;
    if (px < 0.5) { c.drawImage(src, x, y); return; }
    if (CAN_FILTER) {
      c.filter = 'blur(' + px.toFixed(2) + 'px)';
      c.drawImage(src, x, y);
      c.filter = 'none';
      return;
    }
    var k = Math.max(1.5, px * 0.8);
    var t = makeCanvas(src.width / k, src.height / k);
    var tc = t.getContext('2d');
    tc.imageSmoothingQuality = 'high';
    tc.drawImage(src, 0, 0, t.width, t.height);
    c.imageSmoothingQuality = 'high';
    c.drawImage(t, x, y, src.width, src.height);
  }

  // 5x7 bitmap font. Seven rows per glyph, one base-32 digit per row, bit 4 is the left column.
  var GLYPHS = {
    ' ': '0000000', '!': '4444004', '"': 'aaa0000', '#': 'aavavaa', '$': '4fke5u4', '%': 'op248j3',
    '&': 'cik8lid', "'": 'c480000', '(': '2488842', ')': '8422248', '*': '04lel40', '+': '044v440',
    ',': '0000c48', '-': '000v000', '.': '00000cc', '/': '01248g0', ':': '0cc0cc0', ';': '0cc0c48',
    '<': '248g842', '=': '00v0v00', '>': '8421248', '?': 'eh12404', '@': 'eh1dlle', '[': 'e88888e',
    '\\': '0g84210', ']': 'e22222e', '_': '000000v', '|': '4444444', '~': '008l200',
    '0': 'ehjlphe', '1': '4c4444e', '2': 'eh1248v', '3': 'v2421he', '4': '26aiv22', '5': 'vgu11he',
    '6': '68guhhe', '7': 'v124888', '8': 'ehhehhe', '9': 'ehhf12c',
    A: 'ehhvhhh', B: 'uhhuhhu', C: 'ehggghe', D: 'sihhhis', E: 'vgguggv', F: 'vgguggg', G: 'ehgnhhf',
    H: 'hhhvhhh', I: 'e44444e', J: '72222ic', K: 'hikokih', L: 'ggggggv', M: 'hrllhhh', N: 'hhpljhh',
    O: 'ehhhhhe', P: 'uhhuggg', Q: 'ehhhlid', R: 'uhhukih', S: 'fgge11u', T: 'v444444', U: 'hhhhhhe',
    V: 'hhhhha4', W: 'hhhllla', X: 'hha4ahh', Y: 'hhha444', Z: 'v1248gv',
    a: '00e1fhf', b: 'ggmphhu', c: '00egghe', d: '11djhhf', e: '00ehvge', f: '698s888', g: '0fhhf1e',
    h: 'ggmphhh', i: '40c444e', j: '20622ic', k: 'ggikoki', l: 'c44444e', m: '00qllhh', n: '00mphhh',
    o: '00ehhhe', p: '00uhugg', q: '00djf11', r: '00mpggg', s: '00ege1u', t: '88s8896', u: '00hhhjd',
    v: '00hhha4', w: '00hhlla', x: '00ha4ah', y: '00hhf1e', z: '00v248v',
    '·': '0004000', '…': '000000l', '→': '042v240', '←': '048v840',
    '↺': 'mpt11he', '◆': '04eve40', '✓': '013ms80'
  };

  // Draws one glyph as dots. ox/oy is the glyph's top-left; px/py the dot pitch; dw/dh the dot size.
  function glyph(c, ch, ox, oy, px, py, dw, dh) {
    if (ch === '─') {
      for (var k = 0; k < 6; k++) c.fillRect(ox + k * px, oy + 3 * py, dw + (k < 5 ? px - dw : 0), dh);
      return;
    }
    var code = GLYPHS[ch] || GLYPHS['?'];
    for (var gy = 0; gy < 7; gy++) {
      var v = parseInt(code.charAt(gy), 32);
      if (!v) continue;
      for (var bx = 0; bx < 5; bx++) if (v & (16 >> bx)) c.fillRect(ox + bx * px, oy + gy * py, dw, dh);
    }
  }

  function text(c, str, ox, oy, px, py, dw, dh) {
    for (var i = 0; i < str.length; i++) glyph(c, str.charAt(i), ox + i * 6 * px, oy, px, py, dw, dh);
  }

  // ---------------------------------------------------------------- terminal screen

  // Fewer, bigger cells than a real terminal, so the screen reads at desktop sizes.
  var COLS = 37, ROWS = 13, BODY = ROWS - 2;
  var NORMAL = 0, DIM = 1, BRIGHT = 2, INVERSE = 3, FAINT = 4;
  var INK = ['#ffb547', 'rgba(201,138,46,.95)', '#ffdc9c', '#ffb547', 'rgba(107,74,26,.9)'];
  var ELL = '…', MID = '·', GEM = '◆';
  var SCRAMBLE = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=<>?@$';
  var HEAD = 'BAUTA v0.1.0 ' + MID + ' 127.0.0.1:8787';

  function cut() { return Array.prototype.join.call(arguments, '') + ELL; }

  // Sample values are assembled from pieces and always cut short.
  var SETS = [
    {
      dur: 15000,
      req: 'claude  POST /v1/messages',
      found: [
        ['  OPENAI_API_KEY=', cut('sk', '-proj-', '9fK2x7'), ''],
        ['  DB_PASSWORD=', cut('Hx', '9w', 'q2'), ''],
        ['  ADMIN_EMAIL=', ['marta.rossi', 'lagoon.test'].join('@'), '']
      ],
      ph: ['[[BAUTA_SECRET_1]]', '[[BAUTA_SECRET_2]]', '[[BAUTA_EMAIL_1]]'],
      routes: [
        ['→ anthropic ', '.', '429 limit'],
        ['↺ venice ' + MID + ' deepseek-v4-1-flash', ' ', '200']
      ],
      log: '14:05:02  claude-sonnet-4-6 → venice  ↺ fallback (anthropic 429)  ' + GEM + ' masked 2 secrets, 1 personal  200  1.9s'
    },
    {
      dur: 14000,
      req: 'claude  POST /v1/messages',
      found: [
        ['  STRIPE_KEY=', cut('sk', '_live_', '51Hq'), ''],
        ['  GITHUB_TOKEN=', cut('gh', 'p_', '8Zt1'), ''],
        ['  CONTACT=', cut('+39 041 ', '52'), '']
      ],
      ph: ['[[BAUTA_SECRET_1]]', '[[BAUTA_SECRET_2]]', '[[BAUTA_PHONE_1]]'],
      routes: [['→ anthropic ', '.', '200']],
      log: '14:06:11  claude-sonnet-4-6 → anthropic  ' + GEM + ' masked 2 secrets, 1 personal  200  2.4s'
    },
    {
      dur: 14500,
      req: 'aider  POST /v1/chat/completions',
      found: [
        ['  AWS_KEY_ID=', cut('AK', 'IA', '4Q7R'), ''],
        ['  auth: Bearer ', cut('ey', 'JhbGci'), ''],
        ['  billing ', ['giulia', 'ca-doro.test'].join('@'), '']
      ],
      ph: ['[[BAUTA_SECRET_1]]', '[[BAUTA_SECRET_2]]', '[[BAUTA_EMAIL_1]]'],
      routes: [['→ venice ' + MID + ' deepseek-v4-1-flash', ' ', '200']],
      log: '14:07:40  deepseek-v4-1-flash → venice  ' + GEM + ' masked 2 secrets, 1 personal  200  1.2s'
    }
  ];

  function repeat(ch, n) { return new Array(Math.max(0, n) + 1).join(ch); }

  // Turns a sample set into timed lines. A segment without `at` starts when the previous one ends.
  function buildScript(set) {
    var lines = [], t = 300, i, p, seg;
    lines.push({ segs: [{ s: '> ', at: t }, { s: set.req, at: t + 160, cps: 36 }] });
    t += 160 + set.req.length / 36 * 1000 + 380;
    for (i = 0; i < 3; i++) {
      p = set.found[i];
      lines.push({ segs: [{ s: p[0], at: t, cps: 150 }, { s: p[1], cps: 150 }, { s: p[2], cps: 150 }] });
      t += 360;
    }
    var caught = t + 420;
    for (i = 0; i < 3; i++) lines[1 + i].segs[1].inv = caught + i * 240;
    t = caught + 3 * 240 + 380;
    var mask = t + 120;
    lines.push({ segs: [{ s: '  ' + GEM + ' masked 2 secrets ' + MID + ' 1 personal', at: t, cps: 240, st: BRIGHT }] });
    t += 640;
    for (i = 0; i < 3; i++) {
      p = set.found[i];
      lines.push({ segs: [{ s: p[0], at: t, cps: 240 }, { s: set.ph[i], cps: 240, st: BRIGHT, scr: t + 760 }, { s: p[2], cps: 240 }] });
      t += 420;
    }
    t += 560;
    for (i = 0; i < set.routes.length; i++) {
      var r = set.routes[i], dotted = r[1] === '.';
      var n = COLS - r[0].length - r[2].length - 1;
      var leftEnd = t + r[0].length / 110 * 1000;
      var fillEnd = leftEnd + 120 + (dotted ? n / 17 * 1000 : 0);
      var rightAt = fillEnd + (dotted ? 260 : 820);
      lines.push({ segs: [
        { s: r[0], at: t, cps: 110 },
        { s: repeat(r[1], n), at: leftEnd + 120, cps: dotted ? 17 : 0, st: DIM },
        { s: ' ' + r[2], at: rightAt, st: BRIGHT }
      ] });
      t = rightAt + 650;
    }
    var rest = '← restored 3 values on this machine';
    seg = rest.length / 90 * 1000;
    lines.push({ segs: [{ s: rest, at: t, cps: 90 }, { s: repeat(' ', COLS - rest.length - 2) }, { s: ' ✓', at: t + seg + 420, st: BRIGHT }] });
    var done = t + seg + 420;
    t += seg + 1400;
    lines.push({ segs: [{ s: set.log, at: t, cps: 260, st: DIM }] });
    return { lines: lines, dur: set.dur, mask: mask, count: 3, done: done, log: t };
  }

  var SCRIPTS = SETS.map(buildScript);
  var LOOP = SCRIPTS.reduce(function (a, s) { return a + s.dur; }, 0);

  function scriptAt(t) {
    t = ((t % LOOP) + LOOP) % LOOP;
    for (var i = 0; i < SCRIPTS.length; i++) {
      if (t < SCRIPTS[i].dur) return { sc: SCRIPTS[i], t: t, i: i };
      t -= SCRIPTS[i].dur;
    }
    return { sc: SCRIPTS[0], t: 0, i: 0 };
  }

  function newFrame() {
    return { ch: new Array(ROWS * COLS), st: new Array(ROWS * COLS), cur: -1, lit: 0 };
  }

  function put(f, row, col, s, st) {
    for (var i = 0; i < s.length && col + i < COLS; i++) {
      f.ch[row * COLS + col + i] = s.charAt(i);
      f.st[row * COLS + col + i] = st;
    }
  }

  // Fills f with the screen at time t of the given script.
  function computeFrame(f, sc, t) {
    var i, j, k;
    for (i = 0; i < f.ch.length; i++) { f.ch[i] = ' '; f.st[i] = NORMAL; }
    put(f, 0, 0, HEAD, NORMAL);
    put(f, 0, COLS - 6, ' AUTO ', INVERSE);
    put(f, 1, 0, repeat('─', COLS), DIM);
    f.cur = -1;
    var fade = t > sc.dur - 480, gone = t > sc.dur - 170;
    var rows = [], curRow = 0, curCol = 0, busy = false;
    for (i = 0; i < sc.lines.length && !gone; i++) {
      var line = sc.lines[i];
      if (t < line.segs[0].at) break;
      var cells = [], prevEnd = 0;
      for (k = 0; k < line.segs.length; k++) {
        var g = line.segs[k];
        var start = g.at != null ? g.at : prevEnd;
        var dur = g.cps ? g.s.length / g.cps * 1000 : 0;
        prevEnd = start + dur;
        if (t < start) break;
        if (t < prevEnd) busy = true;
        var n = dur ? Math.min(g.s.length, Math.floor((t - start) * g.cps / 1000)) : g.s.length;
        for (j = 0; j < n; j++) {
          var c = g.s.charAt(j), st = g.st || NORMAL;
          if (g.scr && t < g.scr + j * 20 && c !== ' ') {
            c = SCRAMBLE.charAt(hash3(i, j, Math.floor(t / 60)) % SCRAMBLE.length);
            st = NORMAL;
          }
          if (g.inv && t >= g.inv) st = INVERSE;
          if (fade) st = FAINT;
          cells.push(c, st);
        }
      }
      var len = cells.length / 2;
      for (j = 0; j < Math.max(1, len); j += COLS) rows.push(cells.slice(j * 2, (j + COLS) * 2));
      curRow = rows.length - 1;
      curCol = len === 0 ? 0 : (len % COLS === 0 ? COLS - 1 : len % COLS);
    }
    var drop = Math.max(0, rows.length - BODY);
    for (i = drop; i < rows.length; i++) {
      var cellsRow = rows[i];
      for (j = 0; j < cellsRow.length; j += 2) {
        var idx = (2 + i - drop) * COLS + j / 2;
        f.ch[idx] = cellsRow[j];
        f.st[idx] = cellsRow[j + 1];
      }
    }
    if (!fade && (busy || Math.floor(t / 530) % 2 === 0)) {
      f.cur = (2 + Math.max(0, curRow - drop)) * COLS + curCol;
    }
    var lit = 0;
    for (i = 2 * COLS; i < f.ch.length; i++) if (f.ch[i] !== ' ') lit += f.st[i] === BRIGHT || f.st[i] === INVERSE ? 1.6 : 1;
    f.lit = lit;
    return f;
  }

  function sameFrame(a, b) {
    if (a.cur !== b.cur) return false;
    for (var i = 0; i < a.ch.length; i++) if (a.ch[i] !== b.ch[i] || a.st[i] !== b.st[i]) return false;
    return true;
  }

  // Screen renderer. Text is drawn as dots into a small source canvas (3x4 px per dot),
  // then scaled onto the glass with two soft glow passes.
  var DX = 3, DY = 4;

  function Crt(host) {
    this.host = host;
    this.cv = document.createElement('canvas');
    this.cv.className = 'stage__crt-screen';
    host.insertBefore(this.cv, host.firstChild);
    this.ctx = this.cv.getContext('2d');
    this.src = makeCanvas(COLS * 6 * DX, ROWS * 9 * DY);
    this.g1 = makeCanvas(this.src.width / 4, this.src.height / 4);
    this.g2 = makeCanvas(this.src.width / 12, this.src.height / 12);
    this.dpr = 1;
  }

  Crt.prototype.resize = function (w, h, dpr) {
    this.dpr = dpr;
    this.cv.width = Math.max(2, Math.round(w * dpr));
    this.cv.height = Math.max(2, Math.round(h * dpr));
    this.bg = null;
  };

  Crt.prototype.paintSource = function (f) {
    var c = this.src.getContext('2d');
    c.clearRect(0, 0, this.src.width, this.src.height);
    var cw = 6 * DX, chh = 9 * DY, dw = DX * 0.84, dh = DY * 0.7;
    for (var r = 0; r < ROWS; r++) {
      for (var col = 0; col < COLS; col++) {
        var idx = r * COLS + col, ch = f.ch[idx], st = f.st[idx];
        var ox = col * cw, oy = r * chh;
        if (st === INVERSE) {
          c.fillStyle = 'rgba(255,181,71,.9)';
          c.fillRect(ox, oy + DY * 0.2, cw, chh - DY * 0.7);
          c.fillStyle = '#1c1005';
          glyph(c, ch, ox, oy + DY, DX, DY, dw, dh);
        } else if (ch !== ' ') {
          c.fillStyle = INK[st];
          glyph(c, ch, ox, oy + DY, DX, DY, dw, dh);
        }
        if (idx === f.cur) {
          c.fillStyle = INK[NORMAL];
          c.fillRect(ox, oy + DY * 7.2, DX * 5, DY * 0.8);
        }
      }
    }
  };

  Crt.prototype.draw = function (f, power) {
    var c = this.ctx, W = this.cv.width, H = this.cv.height;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    if (!this.bg) {
      this.bg = rad(c, W * 0.5, H * 0.45, 0, W * 0.5, H * 0.5, W * 0.7,
        [[0, '#21140a'], [0.55, '#150d05'], [1, '#090502']]);
    }
    c.fillStyle = this.bg;
    c.fillRect(0, 0, W, H);
    if (power <= 0) return;
    if (power < 0.3) {
      var lw = W * smooth(power / 0.3), lh = Math.max(1.5, this.dpr * 1.6);
      c.globalCompositeOperation = 'lighter';
      c.fillStyle = 'rgba(255,200,120,.22)';
      c.fillRect((W - lw) / 2, H / 2 - lh * 4, lw, lh * 8);
      c.fillStyle = 'rgba(255,236,200,.95)';
      c.fillRect((W - lw) / 2, H / 2 - lh / 2, lw, lh);
      return;
    }
    if (f) this.paintSource(f);
    var g1 = this.g1.getContext('2d'), g2 = this.g2.getContext('2d');
    g1.clearRect(0, 0, this.g1.width, this.g1.height);
    g1.drawImage(this.src, 0, 0, this.g1.width, this.g1.height);
    g2.clearRect(0, 0, this.g2.width, this.g2.height);
    g2.drawImage(this.g1, 0, 0, this.g2.width, this.g2.height);
    var tx = W * 0.05, ty = H * 0.065, tw = W * 0.9, th = H * 0.87;
    c.save();
    if (power < 1) {
      var bh = Math.max(2, H * smooth((power - 0.3) / 0.7));
      c.beginPath();
      c.rect(0, (H - bh) / 2, W, bh);
      c.clip();
    }
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 0.5;
    c.drawImage(this.g2, tx - tw * 0.03, ty - th * 0.03, tw * 1.06, th * 1.06);
    c.globalAlpha = 0.55;
    c.drawImage(this.g1, tx, ty, tw, th);
    c.globalAlpha = 1;
    c.drawImage(this.src, tx, ty, tw, th);
    if (power < 1) {
      c.globalAlpha = 0.5 * (1 - power);
      c.fillStyle = '#ffe2b0';
      c.fillRect(0, 0, W, H);
    }
    c.restore();
  };

  // ---------------------------------------------------------------- masks

  // Shapes from the Bauta emblem (viewBox 0 0 624 940).
  var MP = null;
  function maskPaths() {
    if (MP) return MP;
    var P = function (d) { return new Path2D(d); };
    MP = {
      face: P('M312 162.7C420 162.7 601.6 250 601.6 480.3C601.6 616.1 540.9 686.9 517.3 755.2L470.2 891.6C468.1 897.5 418 919.2 312 919.2C206 919.2 155.9 897.5 153.8 891.6L106.7 755.2C83.1 686.9 22.4 616.1 22.4 480.3C22.4 250 204 162.7 312 162.7Z'),
      bowl: P('M61.7 379.5C40.6 401.6 63.6 612.5 303.5 689.5H320.5C560.4 612.5 583.4 401.6 562.3 379.5H641.6V-20.5H-17.6V379.5Z'),
      band: P('M22.4 425.2C72.4 337.9 208.9 308.6 312 308.6C415.1 308.6 551.6 337.9 601.6 425.2L631.6 425.2V413.5A365.9 365.9 0 0 0 -7.6 413.5V425.2Z'),
      brow: P('M22.4 425.2C72.4 337.9 208.9 308.6 312 308.6C415.1 308.6 551.6 337.9 601.6 425.2'),
      lip: P('M50 741.3L312 674.2L574 741.3V969.5H50Z'),
      chin: P('M50 782.3L312 715.1L574 782.3V969.5H50Z'),
      chev: P('M50 741.3L312 674.2L574 741.3'),
      eyeL: P('M103 464.8A105.2 105.2 0 0 1 261.6 464.8A105.2 105.2 0 0 1 103 464.8Z'),
      eyeR: P('M362.4 464.8A105.2 105.2 0 0 1 521 464.8A105.2 105.2 0 0 1 362.4 464.8Z'),
      nose: P('M312 406.2V611.4L272.8 650.6V676.5')
    };
    return MP;
  }

  // gold, cream, ochre, olive
  var TONES = [
    { cheek: ['#e8b04e', '#9a5f18'], face: '#f0c674', band: '#9c6c22', rim: '#ffe4a6' },
    { cheek: ['#d99c32', '#b17022'], face: '#f2e7d4', band: '#826832', rim: '#fff4e2' },
    { cheek: ['#c47e2c', '#844a14'], face: '#d89a4c', band: '#6e5426', rim: '#f7c47c' },
    { cheek: ['#937a3a', '#5a481f'], face: '#ad975c', band: '#4f4020', rim: '#e2d29c' }
  ];

  function paintMask(c, tone) {
    var m = maskPaths();
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = 30;
    c.strokeStyle = lin(c, 230, 20, 400, 200, [[0, tone.rim], [0.5, tone.cheek[0]], [1, tone.cheek[1]]]);
    c.beginPath();
    c.arc(312, 109.4, 86, 0, Math.PI * 2);
    c.stroke();
    c.save();
    c.clip(m.face);
    c.fillStyle = lin(c, 22, 0, 602, 0, [[0, tone.cheek[0]], [1, tone.cheek[1]]]);
    c.fillRect(0, 150, 624, 790);
    c.fillStyle = tone.face; c.fill(m.bowl);
    c.fillStyle = tone.band; c.fill(m.band);
    c.fillStyle = tone.face; c.fill(m.lip);
    c.fillStyle = tone.band; c.fill(m.chin);
    c.fillStyle = rad(c, 230, 320, 20, 330, 520, 560,
      [[0, 'rgba(255,248,232,.45)'], [0.42, 'rgba(255,240,210,.05)'], [0.78, 'rgba(0,0,0,.3)'], [1, 'rgba(0,0,0,.62)']]);
    c.fillRect(0, 150, 624, 790);
    c.strokeStyle = 'rgba(30,17,4,.72)';
    c.lineWidth = 18;
    c.stroke(m.brow); c.stroke(m.chev); c.stroke(m.nose);
    c.translate(-4, -5);
    c.strokeStyle = 'rgba(255,242,210,.5)';
    c.lineWidth = 6;
    c.stroke(m.brow); c.stroke(m.chev); c.stroke(m.nose);
    c.restore();
    c.fillStyle = '#05070b';
    c.fill(m.eyeL); c.fill(m.eyeR);
    c.globalAlpha = 0.75;
    c.lineWidth = 9;
    c.strokeStyle = tone.rim;
    c.stroke(m.eyeL); c.stroke(m.eyeR);
    c.globalAlpha = 1;
    c.lineWidth = 16;
    c.strokeStyle = 'rgba(12,10,8,.85)';
    c.stroke(m.face);
    c.lineWidth = 6;
    c.strokeStyle = lin(c, 0, 160, 0, 920, [[0, 'rgba(255,238,196,.95)'], [0.35, 'rgba(255,222,160,.25)'], [1, 'rgba(255,222,160,0)']]);
    c.stroke(m.face);
    c.strokeStyle = lin(c, 330, 0, 610, 0, [[0, 'rgba(159,180,216,0)'], [1, 'rgba(176,196,230,.8)']]);
    c.stroke(m.face);
    c.restore();
  }

  // ---------------------------------------------------------------- gallery rows

  // lateral X, depth z, tone; far to near
  var GALLERY = [
    [1.35, 14.4, 0], [-1.05, 13.6, 2], [1.35, 12.4, 3], [-1.05, 11.2, 1], [1.35, 10.2, 1],
    [-1.05, 9.0, 0], [1.35, 8.2, 2], [-1.05, 7.2, 3], [1.35, 6.4, 0], [-1.05, 5.6, 1]
  ];

  function paintPlinth(c, X, z, tone) {
    var f = FOCAL / z, fb = FOCAL / (z + 0.44), hw = 0.22, cw = 0.27;
    var xL = VP_X + f * (X - hw), xR = VP_X + f * (X + hw);
    var yTop = proj(X, 0.94, z)[1], yBase = proj(X, 0.09, z)[1], yFloor = proj(X, 0, z)[1];
    var sx = X < 0 ? X + hw : X - hw;
    var fx = VP_X + f * sx, bx = VP_X + fb * sx;
    c.fillStyle = lin(c, 0, yTop, 0, yFloor, [[0, '#1a1c22'], [1, '#06070a']]);
    poly(c, [[fx, yTop], [bx, VP_Y + fb * (EYE - 0.94)], [bx, VP_Y + fb * EYE], [fx, yFloor]]);
    c.fill();
    c.fillStyle = lin(c, 0, yTop, 0, yFloor, [[0, '#3d362e'], [0.16, '#25252b'], [0.6, '#13151b'], [1, '#08090d']]);
    c.fillRect(xL, yTop, xR - xL, yFloor - yTop);
    var cxL = VP_X + f * (X - cw), cxR = VP_X + f * (X + cw);
    var bxL = VP_X + fb * (X - cw), bxR = VP_X + fb * (X + cw);
    var yCap = proj(X, 1.0, z)[1], yBack = VP_Y + fb * (EYE - 1.0);
    c.fillStyle = lin(c, 0, yBack, 0, yCap, [[0, '#4b4236'], [1, '#75664f']]);
    poly(c, [[bxL, yBack], [bxR, yBack], [cxR, yCap], [cxL, yCap]]);
    c.fill();
    c.fillStyle = lin(c, 0, yCap, 0, yTop, [[0, '#5d5246'], [1, '#2b2929']]);
    c.fillRect(cxL, yCap, cxR - cxL, yTop - yCap);
    c.fillStyle = '#0b0c10';
    c.fillRect(cxL, yBase, cxR - cxL, yFloor - yBase);
    c.strokeStyle = 'rgba(159,180,216,.4)';
    c.lineWidth = Math.max(1, f * 0.006);
    c.beginPath(); c.moveTo(bxL, yBack); c.lineTo(bxR, yBack); c.stroke();
    var mh = 0.3 * f, ms = mh / 940, mx = VP_X + f * X;
    var my = proj(X, 1.1, z + 0.12)[1];
    c.strokeStyle = '#6b5326';
    c.lineWidth = Math.max(1, f * 0.012);
    c.beginPath(); c.moveTo(mx, (yCap + yBack) / 2); c.lineTo(mx, my - mh * 0.2); c.stroke();
    c.save();
    c.translate(mx - 312 * ms, my - 919 * ms);
    c.scale(ms, ms);
    paintMask(c, TONES[tone]);
    c.restore();
    c.globalCompositeOperation = 'lighter';
    blob(c, mx, my - mh * 0.55, mh * 0.95, mh * 0.95, 'rgba(255,214,150,.2)', 0.1);
    blob(c, mx, (yCap + yBack) / 2, (cxR - cxL) * 0.55, (yCap - yBack) * 0.9, 'rgba(255,220,170,.22)', 0.2);
    c.globalCompositeOperation = 'source-over';
    return {
      eye: [mx + (500 - 312) * ms, my + (456 - 919) * ms],
      hi: [[mx - 90 * ms, my - 640 * ms], [mx + 150 * ms, my - 300 * ms]],
      box: [cxL - 6, my - mh * 1.1, cxR + 6 + Math.abs(bx - fx), yFloor + 4],
      base: yFloor, size: mh
    };
  }

  // ---------------------------------------------------------------- back wall, windows, floor

  function windowPath(c, x0, x1, yb, ys, yt) {
    c.beginPath();
    c.moveTo(x0, yb);
    c.lineTo(x0, ys);
    ogeeArch(c, x0, x1, ys, yt);
    c.lineTo(x1, yb);
    c.closePath();
  }

  // The head alone, from (x0, ys) over the tip at (centre, yt) down to (x1, ys).
  function ogeeArch(c, x0, x1, ys, yt) {
    var xc = (x0 + x1) / 2, hw = (x1 - x0) / 2, h = ys - yt;
    // an ogee: a short convex shoulder, then a long concave rise to a sharp tip
    c.bezierCurveTo(x0, ys - h * 0.24, xc - hw * 0.74, ys - h * 0.38, xc - hw * 0.44, ys - h * 0.46);
    c.bezierCurveTo(xc - hw * 0.16, ys - h * 0.54, xc - hw * 0.03, yt + h * 0.24, xc, yt);
    c.bezierCurveTo(xc + hw * 0.03, yt + h * 0.24, xc + hw * 0.16, ys - h * 0.54, xc + hw * 0.44, ys - h * 0.46);
    c.bezierCurveTo(xc + hw * 0.74, ys - h * 0.38, x1, ys - h * 0.24, x1, ys);
  }

  // A Venetian gothic window on the back wall: a stone surround holding three tall lights with
  // pointed ogee heads on slender columns, and quatrefoil roundels above the columns.
  var WIN_W = 1.36;

  function windowGeom(X, z) {
    var f = FOCAL / z, w = WIN_W;
    return {
      f: f, x0: VP_X + f * (X - w / 2), x1: VP_X + f * (X + w / 2),
      yb: proj(X, 0.9, z)[1],   // sill
      ys: proj(X, 1.66, z)[1],  // where the heads spring
      yp: proj(X, 2.12, z)[1],  // tips of the heads
      yt: proj(X, 2.38, z)[1]   // top of the surround, kept well below the page header
    };
  }

  // Cold, dim glass, so the windows stay behind the terminal and the wordmark.
  function glass(c, g, b) {
    var xc = (g.x0 + g.x1) / 2, hw = (g.x1 - g.x0) / 2;
    c.globalAlpha = b;
    c.fillStyle = lin(c, 0, g.yt, 0, g.yb, [[0, '#2a3a5a'], [0.42, '#364c74'], [1, '#161f35']]);
    c.fillRect(g.x0 - 2, g.yt - 2, g.x1 - g.x0 + 4, g.yb - g.yt + 4);
    c.fillStyle = rad(c, xc + hw * 0.45, g.ys - (g.ys - g.yt) * 0.4, 0, xc + hw * 0.45, g.ys, hw * 1.5,
      [[0, 'rgba(170,194,236,.3)'], [1, 'rgba(170,194,236,0)']]);
    c.fillRect(g.x0 - 2, g.yt - 2, g.x1 - g.x0 + 4, g.yb - g.yt + 4);
    c.globalAlpha = 1;
  }

  function leading(c, g, f) {
    c.strokeStyle = 'rgba(6,9,16,.55)';
    c.lineWidth = Math.max(0.8, f * 0.005);
    var step = f * 0.1, tall = g.yb - g.yt;
    c.beginPath();
    for (var k = -16; k < 30; k++) {
      c.moveTo(g.x0 + k * step, g.yt); c.lineTo(g.x0 + k * step - tall * 0.5, g.yb);
      c.moveTo(g.x0 + k * step - tall * 0.5, g.yt); c.lineTo(g.x0 + k * step, g.yb);
    }
    c.stroke();
  }

  function quatrefoil(c, x, y, r) {
    var o = r * 0.5, lr = r * 0.52;
    c.beginPath();
    c.moveTo(x - o + lr, y); c.arc(x - o, y, lr, 0, Math.PI * 2);
    c.moveTo(x + o + lr, y); c.arc(x + o, y, lr, 0, Math.PI * 2);
    c.moveTo(x + lr, y - o); c.arc(x, y - o, lr, 0, Math.PI * 2);
    c.moveTo(x + lr, y + o); c.arc(x, y + o, lr, 0, Math.PI * 2);
    c.rect(x - o, y - o, o * 2, o * 2);
  }

  function paintWindow(c, X, z, b) {
    var g = windowGeom(X, z), f = g.f, k;
    var xc = (g.x0 + g.x1) / 2, hw = (g.x1 - g.x0) / 2, my = (g.yt + g.yb) / 2;
    // a faint cold glow on the wall around the opening
    c.fillStyle = rad(c, xc, my, 0, xc, my, hw * 2.6, [[0, rgba(MOON, 0.06 * b)], [1, rgba(MOON, 0)]]);
    c.fillRect(xc - hw * 2.8, g.yt - hw * 1.6, hw * 5.6, g.yb - g.yt + hw * 3.2);
    // stone surround, cornice and the dark tracery plate
    var m = f * 0.07;
    c.fillStyle = '#111824';
    c.fillRect(g.x0 - m, g.yt - m * 0.6, g.x1 - g.x0 + m * 2, g.yb - g.yt + m * 1.2);
    c.fillStyle = '#151d2c';
    c.fillRect(g.x0 - m * 1.25, g.yt - m * 1.05, g.x1 - g.x0 + m * 2.5, m * 0.5);
    c.fillStyle = 'rgba(159,180,216,.1)';
    c.fillRect(g.x0 - m * 1.25, g.yt - m * 1.05, g.x1 - g.x0 + m * 2.5, Math.max(1, m * 0.1));
    c.fillStyle = '#090d15';
    c.fillRect(g.x0, g.yt, g.x1 - g.x0, g.yb - g.yt);
    // three lights on two slender columns
    var n = 3, col = f * 0.045, edge = f * 0.035;
    var lw = (g.x1 - g.x0 - 2 * edge - col * (n - 1)) / n, lights = [];
    for (k = 0; k < n; k++) {
      var a = g.x0 + edge + k * (lw + col);
      lights.push([a, a + lw]);
    }
    for (k = 0; k < n; k++) {
      windowPath(c, lights[k][0], lights[k][1], g.yb, g.ys, g.yp);
      c.save(); c.clip(); glass(c, g, b); leading(c, g, f); c.restore();
    }
    // quatrefoil roundels above the columns, between the heads
    for (k = 1; k < n; k++) {
      var qx = lights[k][0] - col / 2, qy = g.yp + (g.yt - g.yp) * 0.36, qr = f * 0.1;
      quatrefoil(c, qx, qy, qr);
      c.save(); c.clip(); glass(c, g, b * 0.85); c.restore();
      c.strokeStyle = 'rgba(159,180,216,.12)';
      c.lineWidth = Math.max(0.8, f * 0.006);
      c.beginPath(); c.arc(qx, qy, qr * 1.16, 0, Math.PI * 2); c.stroke();
    }
    // the columns, with small capitals and bases, moonlit on one side
    for (k = 1; k < n; k++) {
      var cx0 = lights[k][0] - col;
      c.fillStyle = '#131a28';
      c.fillRect(cx0, g.ys, col, g.yb - g.ys);
      c.fillStyle = 'rgba(159,180,216,.15)';
      c.fillRect(cx0 + col * 0.62, g.ys, Math.max(0.8, col * 0.22), g.yb - g.ys);
      c.fillStyle = '#19212f';
      c.fillRect(cx0 - col * 0.55, g.ys - f * 0.028, col * 2.1, f * 0.028);
      c.fillRect(cx0 - col * 0.35, g.yb - f * 0.024, col * 1.7, f * 0.024);
    }
    // a hood moulding over each head, ending in a small finial, with a thin moon rim inside
    var e = f * 0.018;
    for (k = 0; k < n; k++) {
      var L0 = lights[k][0], L1 = lights[k][1], lc = (L0 + L1) / 2;
      c.beginPath(); c.moveTo(L0 - e, g.ys);
      ogeeArch(c, L0 - e, L1 + e, g.ys, g.yp - e * 2.2);
      c.strokeStyle = '#1b2434';
      c.lineWidth = Math.max(1, f * 0.014);
      c.stroke();
      c.beginPath(); c.moveTo(lc, g.yp - e * 2.2); c.lineTo(lc, g.yp - e * 4.4); c.stroke();
      windowPath(c, L0, L1, g.yb, g.ys, g.yp);
      c.strokeStyle = 'rgba(159,180,216,.11)';
      c.lineWidth = Math.max(0.8, f * 0.005);
      c.stroke();
    }
    // sill
    c.fillStyle = '#121a29';
    c.fillRect(g.x0 - m * 1.3, g.yb, g.x1 - g.x0 + m * 2.6, m * 0.7);
    c.fillStyle = 'rgba(159,180,216,.14)';
    c.fillRect(g.x0 - m * 1.3, g.yb, g.x1 - g.x0 + m * 2.6, Math.max(1, m * 0.12));
  }

  // lateral X and brightness; the windows flank the terminal instead of sitting behind it
  var WINDOWS = [[-4.04, 0.12], [-1.29, 0.42], [2.17, 0.56]];
  var PIERS = [-2.67, 0.44, 3.55];

  function paintWall(c) {
    var base = proj(0, 0, 15)[1];
    var bl = proj(-3.5, 0, 15), br = proj(3.5, 0, 15);
    var nl = proj(-3.5, 0, 4), nr = proj(3.5, 0, 4);
    c.fillStyle = '#05070b';
    c.fillRect(-100, -100, WORLD_W + 200, WORLD_H + 200);
    c.fillStyle = lin(c, 0, -60, 0, base, [[0, '#070a11'], [0.55, '#0c121e'], [1, '#111a2a']]);
    c.fillRect(bl[0], -100, br[0] - bl[0], base + 100);
    for (var i = 0; i < PIERS.length; i++) {
      var px = proj(PIERS[i], 0, 15)[0], pw = FOCAL * 0.32 / 15;
      c.fillStyle = 'rgba(20,28,44,.55)';
      c.fillRect(px - pw / 2, -100, pw, base + 100);
      c.fillStyle = 'rgba(159,180,216,.07)';
      c.fillRect(px + pw / 2 - 2, -100, 2, base + 100);
    }
    c.fillStyle = 'rgba(4,6,10,.55)';
    c.fillRect(bl[0], proj(0, 0.45, 15)[1], br[0] - bl[0], base - proj(0, 0.45, 15)[1]);
    c.fillStyle = lin(c, bl[0], 0, -100, 0, [[0, '#0a0f19'], [1, '#040508']]);
    poly(c, [[bl[0], -100], [bl[0], bl[1]], [nl[0], nl[1]], [-300, nl[1]], [-300, -100]]);
    c.fill();
    c.fillStyle = lin(c, br[0], 0, WORLD_W + 100, 0, [[0, '#0b101a'], [1, '#05070b']]);
    poly(c, [[br[0], -100], [br[0], br[1]], [nr[0], nr[1]], [WORLD_W + 300, nr[1]], [WORLD_W + 300, -100]]);
    c.fill();
    [6, 9, 12].forEach(function (z) {
      var a = proj(-3.5, 0, z), b = proj(3.5, 0, z), w = FOCAL * 0.3 / z;
      c.fillStyle = 'rgba(16,22,36,.6)';
      c.fillRect(a[0] - w, -100, w, a[1] + 100);
      c.fillRect(b[0], -100, w, b[1] + 100);
    });
    c.fillStyle = lin(c, 0, base, 0, WORLD_H + 60, [[0, '#121a29'], [0.25, '#0b101a'], [1, '#030406']]);
    poly(c, [bl, br, nr, [WORLD_W + 300, WORLD_H + 300], [-300, WORLD_H + 300], nl]);
    c.fill();
    c.strokeStyle = 'rgba(159,180,216,.045)';
    c.lineWidth = 1.2;
    c.beginPath();
    for (var X = -3.5; X <= 3.51; X += 0.7) {
      var p0 = proj(X, 0, 15), p1 = proj(X, 0, 2.2);
      c.moveTo(p0[0], p0[1]); c.lineTo(p1[0], p1[1]);
    }
    [13.5, 12, 10.6, 9.3, 8.1, 7, 6].forEach(function (z) {
      var a = proj(-3.5, 0, z), b = proj(3.5, 0, z);
      c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
    });
    c.stroke();
    WINDOWS.forEach(function (w) { paintWindow(c, w[0], 15, w[1]); });
    blob(c, VP_X, base - 40, 1100, 260, 'rgba(36,50,78,.22)', 0.2);
  }

  // Moonlight through haze: beams from the windows down to patches on the floor, plus
  // the windows' soft reflections in the polished floor. Drawn on its own canvas, then blurred.
  function paintMoonlight(c) {
    var base = proj(0, 0, 15)[1];
    c.globalCompositeOperation = 'lighter';
    WINDOWS.forEach(function (wv, n) {
      var X = wv[0], b = wv[1], g = windowGeom(X, 15), w = WIN_W;
      var r = (g.x1 - g.x0) * 0.42;
      c.fillStyle = lin(c, 0, base, 0, base + (g.yb - g.yt) * 0.55, [[0, rgba(MOON, 0.16 * b)], [1, rgba(MOON, 0)]]);
      c.fillRect((g.x0 + g.x1) / 2 - r, base, r * 2, (g.yb - g.yt) * 0.55);
      if (n === 0) return;
      var hit = function (Xw, Yw) { var s = Yw / 0.55; return proj(Xw - 0.2 * s, 0, 15 - s); };
      var top = 2.1;
      var win = [proj(X - w / 2, 0.9, 15), proj(X + w / 2, 0.9, 15), proj(X - w / 2, top, 15), proj(X + w / 2, top, 15)];
      var pat = [hit(X - w / 2, 0.9), hit(X + w / 2, 0.9), hit(X + w / 2, top), hit(X - w / 2, top)];
      c.fillStyle = lin(c, win[3][0], win[3][1], pat[3][0], pat[3][1], [[0, rgba(MOON, 0.22 * b)], [1, rgba(MOON, 0.08 * b)]]);
      poly(c, hull(win.concat(pat)));
      c.fill();
      c.fillStyle = rgba(MOON, 0.42 * b);
      poly(c, pat);
      c.fill();
    });
    c.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- the exhibit

  var GLASS = [1566, 303, 368, 280];       // x, y, w, h of the CRT glass
  var EXHIBIT_BOX = [1360, 200, 780, 860]; // world rect covered by the exhibit canvases
  var CONE_BOX = [1300, -60, 900, 940];

  function paintExhibit(c) {
    var i, k;
    // plinth body, gold band, slab and top surface
    c.fillStyle = lin(c, 0, 899, 0, 1060, [[0, '#272a32'], [0.22, '#171a20'], [1, '#06070a']]);
    c.fillRect(1446, 899, 628, 170);
    c.fillStyle = lin(c, 1446, 0, 2074, 0, [[0, 'rgba(159,180,216,.07)'], [0.08, 'rgba(0,0,0,0)'], [0.75, 'rgba(0,0,0,.05)'], [1, 'rgba(0,0,0,.4)']]);
    c.fillRect(1446, 899, 628, 170);
    c.strokeStyle = 'rgba(236,231,220,.05)';
    c.lineWidth = 1.2;
    c.beginPath();
    c.moveTo(1470, 925); c.bezierCurveTo(1560, 940, 1610, 990, 1700, 1010);
    c.moveTo(1880, 905); c.bezierCurveTo(1930, 960, 2000, 975, 2060, 1040);
    c.moveTo(1600, 1000); c.bezierCurveTo(1660, 1015, 1720, 1060, 1800, 1062);
    c.stroke();
    // brass plaque
    rrect(c, 1694, 932, 132, 26, 3);
    c.fillStyle = lin(c, 1694, 932, 1694, 958, [[0, '#e6c27a'], [0.45, '#b48a40'], [1, '#6e5222']]);
    c.fill();
    c.strokeStyle = 'rgba(30,20,6,.8)'; c.lineWidth = 1.2; c.stroke();
    c.fillStyle = 'rgba(255,240,200,.35)';
    text(c, '127.0.0.1:8787', 1705.6, 939.6, 1.3, 1.6, 1.05, 1.3);
    c.fillStyle = '#3a2a0e';
    text(c, '127.0.0.1:8787', 1705, 939, 1.3, 1.6, 1.05, 1.3);
    c.fillStyle = lin(c, 1424, 0, 2096, 0, [[0, '#5a4218'], [0.18, '#b8893e'], [0.5, '#f2d18a'], [0.82, '#b8893e'], [1, '#5a4218']]);
    c.fillRect(1428, 890, 664, 9);
    c.fillStyle = 'rgba(255,244,214,.55)';
    c.fillRect(1440, 890, 640, 1.4);
    poly(c, [[1424, 834], [2096, 834], [2096, 890], [1424, 890]]);
    c.fillStyle = lin(c, 0, 834, 0, 890, [[0, '#3a3732'], [0.25, '#26252a'], [1, '#16171b']]);
    c.fill();
    c.fillStyle = lin(c, 1424, 0, 2096, 0, [[0, 'rgba(0,0,0,.35)'], [0.18, 'rgba(0,0,0,0)'], [0.8, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,.45)']]);
    c.fill();
    poly(c, [[1460, 753], [2024, 753], [2096, 834], [1424, 834]]);
    c.fillStyle = lin(c, 0, 753, 0, 834, [[0, '#1d1d21'], [1, '#37332d']]);
    c.fill();
    c.save();
    c.clip();
    blob(c, 1752, 800, 360, 52, 'rgba(255,230,186,.22)', 0.25);
    c.fillStyle = lin(c, 0, 753, 0, 770, [[0, 'rgba(159,180,216,.16)'], [1, 'rgba(159,180,216,0)']]);
    c.fillRect(1400, 753, 720, 20);
    blob(c, 1752, 777, 205, 15, 'rgba(0,0,0,.75)', 0.45);
    blob(c, 1746, 822, 200, 9, 'rgba(0,0,0,.6)', 0.4);
    blob(c, 1500, 813, 78, 11, 'rgba(0,0,0,.6)', 0.35);
    c.restore();
    c.strokeStyle = 'rgba(255,238,205,.5)';
    c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(1426, 834.5); c.lineTo(2094, 834.5); c.stroke();
    c.strokeStyle = 'rgba(170,192,228,.5)';
    c.lineWidth = 1.4;
    c.beginPath(); c.moveTo(1461, 753.5); c.lineTo(2023, 753.5); c.stroke();

    // terminal foot
    poly(c, [[1642, 704], [1858, 704], [1892, 777], [1608, 777]]);
    c.fillStyle = lin(c, 0, 704, 0, 777, [[0, '#0c0d10'], [0.5, '#1a1c21'], [1, '#26292f']]);
    c.fill();
    c.fillStyle = 'rgba(255,236,200,.12)';
    c.fillRect(1610, 774, 280, 1.5);

    // housing
    rrect(c, 1515, 248, 470, 464, 52);
    c.fillStyle = lin(c, 0, 248, 0, 712, [[0, '#393c43'], [0.07, '#2a2d33'], [0.5, '#1c1e23'], [1, '#111216']]);
    c.fill();
    c.save();
    c.clip();
    c.fillStyle = lin(c, 1515, 0, 1985, 0, [[0, 'rgba(159,180,216,.12)'], [0.07, 'rgba(0,0,0,0)'], [0.82, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,.38)']]);
    c.fillRect(1515, 248, 470, 464);
    c.fillStyle = lin(c, 0, 248, 0, 296, [[0, 'rgba(255,236,200,.3)'], [1, 'rgba(255,236,200,0)']]);
    c.fillRect(1515, 248, 470, 50);
    c.strokeStyle = 'rgba(0,0,0,.4)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(1520, 647); c.lineTo(1980, 647); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,.05)';
    c.beginPath(); c.moveTo(1520, 649.5); c.lineTo(1980, 649.5); c.stroke();
    c.restore();
    rrect(c, 1530, 263, 440, 434, 40);
    c.strokeStyle = 'rgba(255,255,255,.045)'; c.lineWidth = 2; c.stroke();
    rrect(c, 1515.8, 248.8, 468.4, 462.4, 51);
    c.lineWidth = 2.4;
    c.strokeStyle = lin(c, 1515, 0, 1985, 0, [[0, 'rgba(176,198,232,.75)'], [0.05, 'rgba(159,180,216,0)'], [0.95, 'rgba(159,180,216,0)'], [1, 'rgba(176,198,232,.6)']]);
    c.stroke();
    c.strokeStyle = lin(c, 0, 248, 0, 300, [[0, 'rgba(255,236,200,.6)'], [0.3, 'rgba(255,236,200,0)']]);
    c.stroke();

    // deep-set screen
    rrect(c, 1552, 290, 396, 310, 32);
    c.fillStyle = lin(c, 0, 290, 0, 600, [[0, '#040405'], [0.12, '#0a0b0d'], [0.8, '#121315'], [1, '#221b12']]);
    c.fill();
    c.strokeStyle = 'rgba(255,236,200,.22)'; c.lineWidth = 1.4;
    c.beginPath(); c.moveTo(1584, 600.5); c.lineTo(1916, 600.5); c.stroke();
    rrect(c, GLASS[0], GLASS[1], GLASS[2], GLASS[3], 24);
    c.fillStyle = '#0d0803';
    c.fill();

    // nameplate, LED, knob, vents
    rrect(c, 1708, 611, 84, 20, 2.5);
    c.fillStyle = lin(c, 0, 611, 0, 631, [[0, '#ecc985'], [0.5, '#b98d42'], [1, '#735525']]);
    c.fill();
    c.strokeStyle = 'rgba(20,14,4,.8)'; c.lineWidth = 1; c.stroke();
    c.fillStyle = 'rgba(255,244,214,.45)';
    text(c, 'BAUTA', 1721.6, 615.6, 2.1, 1.75, 1.6, 1.45);
    c.fillStyle = '#35260c';
    text(c, 'BAUTA', 1721, 615, 2.1, 1.75, 1.6, 1.45);
    blob(c, 1924, 621, 26, 26, 'rgba(255,181,71,.32)', 0.05);
    c.fillStyle = '#ffc163';
    c.beginPath(); c.arc(1924, 621, 4.6, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#fff1d0';
    c.beginPath(); c.arc(1923, 620, 1.7, 0, Math.PI * 2); c.fill();
    c.fillStyle = rad(c, 1559, 670, 1, 1562, 674, 11, [[0, '#4a4e56'], [0.6, '#24272c'], [1, '#0f1013']]);
    c.beginPath(); c.arc(1562, 674, 10.5, 0, Math.PI * 2); c.fill();
    for (k = 0; k < 5; k++) {
      rrect(c, 1836, 658 + k * 9.5, 116, 4.2, 2);
      c.fillStyle = '#070809'; c.fill();
      c.fillStyle = 'rgba(255,255,255,.06)';
      c.fillRect(1838, 662.6 + k * 9.5, 112, 1);
    }

    // coiled cable from the keyboard to the foot
    var P0 = [1902, 797], P1 = [2016, 812], P2 = [1884, 762];
    c.lineWidth = 2.6;
    for (i = 0; i <= 26; i++) {
      var u = i / 26, v = 1 - u;
      var x = v * v * P0[0] + 2 * v * u * P1[0] + u * u * P2[0];
      var y = v * v * P0[1] + 2 * v * u * P1[1] + u * u * P2[1];
      var tx = 2 * v * (P1[0] - P0[0]) + 2 * u * (P2[0] - P1[0]);
      var ty = 2 * v * (P1[1] - P0[1]) + 2 * u * (P2[1] - P1[1]);
      var a = Math.atan2(ty, tx) + Math.PI / 2;
      c.save();
      c.translate(x, y);
      c.rotate(a);
      c.strokeStyle = '#0c0d0f';
      c.beginPath(); c.ellipse(0, 0, 7, 3.2, 0, 0, Math.PI * 2); c.stroke();
      c.strokeStyle = 'rgba(120,126,138,.55)';
      c.lineWidth = 1;
      c.beginPath(); c.ellipse(0, -0.6, 7, 3.2, 0, Math.PI * 1.1, Math.PI * 1.9); c.stroke();
      c.lineWidth = 2.6;
      c.restore();
    }

    // keyboard
    poly(c, [[1592, 786], [1902, 786], [1914, 818], [1580, 818]]);
    c.fillStyle = lin(c, 0, 786, 0, 818, [[0, '#1b1d21'], [1, '#2b2e34']]);
    c.fill();
    poly(c, [[1580, 818], [1914, 818], [1911, 831], [1583, 831]]);
    c.fillStyle = '#111215';
    c.fill();
    c.fillStyle = 'rgba(255,236,200,.22)';
    c.fillRect(1581, 818, 332, 1.2);
    c.strokeStyle = 'rgba(170,192,228,.35)'; c.lineWidth = 1.1;
    c.beginPath(); c.moveTo(1593, 786.5); c.lineTo(1901, 786.5); c.stroke();
    for (var r = 0; r < 5; r++) {
      var yk = 789.5 + r * 5.6, hk = 3.6 + r * 0.32, fr = (yk - 786) / 32;
      var xl = 1592 - 12 * fr + 9, xr = 1902 + 12 * fr - 9, gap = 2.6;
      var keys = r === 4 ? [1, 1, 1, 6.5, 1, 1, 1] : [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
      if (r === 1 || r === 2) keys[0] = 1.5;
      var total = keys.reduce(function (s, n) { return s + n; }, 0);
      var unit = (xr - xl - gap * (keys.length - 1)) / total, kx = xl;
      for (k = 0; k < keys.length; k++) {
        var kw = keys[k] * unit;
        c.fillStyle = '#33363d';
        c.fillRect(kx, yk, kw, hk);
        c.fillStyle = 'rgba(255,236,200,.16)';
        c.fillRect(kx, yk, kw, 0.8);
        c.fillStyle = 'rgba(0,0,0,.45)';
        c.fillRect(kx, yk + hk - 0.7, kw, 0.7);
        kx += kw + gap;
      }
    }

    // a gold mask lying beside the keyboard
    c.save();
    c.translate(1500, 805);
    c.scale(1, 0.5);
    c.rotate(-1.66);
    c.scale(0.136, 0.136);
    c.translate(-312, -540);
    paintMask(c, TONES[0]);
    c.restore();
  }

  // Warm light from the screen: on the bezel recess, the keys, the mask and the plinth top.
  function paintSpill(c, exhibit) {
    c.save();
    c.translate(1750, 760);
    c.scale(1, 0.32);
    c.fillStyle = rad(c, 0, 0, 0, 0, 0, 430, [[0, 'rgba(255,170,72,.85)'], [0.4, 'rgba(255,160,60,.36)'], [1, 'rgba(255,150,50,0)']]);
    c.fillRect(-500, -1400, 1000, 2800);
    c.restore();
    c.save();
    c.globalCompositeOperation = 'destination-out';
    rrect(c, 1515, 248, 470, 464, 52);
    c.fillStyle = lin(c, 0, 248, 0, 712, [[0, 'rgba(0,0,0,1)'], [0.75, 'rgba(0,0,0,1)'], [1, 'rgba(0,0,0,.55)']]);
    c.fill();
    poly(c, [[1642, 704], [1858, 704], [1892, 777], [1608, 777]]);
    c.fillStyle = lin(c, 0, 704, 0, 777, [[0, 'rgba(0,0,0,.95)'], [1, 'rgba(0,0,0,.55)']]);
    c.fill();
    c.restore();
    c.save();
    rrect(c, 1552, 290, 396, 310, 32);
    c.clip();
    c.fillStyle = lin(c, 0, 290, 0, 600, [[0, 'rgba(255,170,70,.03)'], [0.7, 'rgba(255,170,70,.1)'], [1, 'rgba(255,186,90,.42)']]);
    c.fillRect(1552, 290, 396, 310);
    c.restore();
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(exhibit, 0, 0, c.canvas.width, c.canvas.height);
    c.restore();
    c.globalCompositeOperation = 'lighter';
    blob(c, 1750, 444, 300, 240, 'rgba(255,176,70,.07)', 0.5);
    blob(c, 1750, 780, 150, 6, 'rgba(255,180,90,.35)', 0.2);
    c.globalCompositeOperation = 'source-over';
  }

  // The main spotlight, as a soft cone in haze.
  function paintCone(c) {
    c.globalCompositeOperation = 'lighter';
    for (var i = 0; i < 7; i++) {
      var k = 1 - i * 0.13;
      poly(c, [[1750 - 50 * k, -60], [1750 + 50 * k, -60], [1750 + 365 * k, 836], [1750 - 365 * k, 836]]);
      c.fillStyle = 'rgba(255,232,190,.013)';
      c.fill();
    }
    c.fillStyle = 'rgba(255,240,215,.009)';
    poly(c, [[1735, -60], [1748, -60], [1640, 836], [1600, 836]]); c.fill();
    poly(c, [[1756, -60], [1768, -60], [1905, 836], [1860, 836]]); c.fill();
    c.globalCompositeOperation = 'destination-in';
    c.fillStyle = lin(c, 0, -60, 0, 836, [[0, 'rgba(0,0,0,1)'], [0.6, 'rgba(0,0,0,.75)'], [1, 'rgba(0,0,0,.35)']]);
    c.fillRect(1300, -60, 900, 900);
    c.globalCompositeOperation = 'source-over';
  }

  function paintHaze(c) {
    var r = rng(41), i;
    c.globalCompositeOperation = 'lighter';
    for (i = 0; i < 26; i++) {
      var x = 700 + r() * 1900, y = 120 + r() * 700, s = 120 + r() * 320;
      var warm = Math.abs(x - 1750) < 380 && r() < 0.6;
      blob(c, x, y, s, s * (0.45 + r() * 0.4), warm ? 'rgba(255,214,160,' + (0.02 + r() * 0.025).toFixed(3) + ')' : 'rgba(150,172,212,' + (0.02 + r() * 0.03).toFixed(3) + ')', 0.05);
    }
    blob(c, 1400, 690, 1200, 90, 'rgba(140,162,204,.06)', 0.1);
    c.globalCompositeOperation = 'source-over';
  }

  // Dust in the spotlight, simulated in world units.
  function Dust(n) {
    var r = rng(7);
    this.p = [];
    for (var i = 0; i < n; i++) {
      this.p.push({ y: r() * 820, u: r() * 2 - 1, vy: (r() - 0.6) * 9, amp: 6 + r() * 14, w: 0.15 + r() * 0.35, ph: r() * 6.28, s: 0.7 + r() * 1.7, tw: r() * 6.28 });
    }
  }
  Dust.prototype.draw = function (c, t) {
    var s = t / 1000;
    c.globalCompositeOperation = 'lighter';
    for (var i = 0; i < this.p.length; i++) {
      var d = this.p[i];
      var y = ((d.y + d.vy * s) % 820 + 820) % 820;
      var half = 50 + 315 * (y / 836);
      var x = 1750 + d.u * half * 0.92 + Math.sin(s * d.w + d.ph) * d.amp;
      var edge = 1 - Math.abs(d.u);
      var a = (0.25 + 0.75 * edge) * (0.55 + 0.45 * Math.sin(s * 0.9 + d.tw)) * (y < 60 ? y / 60 : 1);
      c.fillStyle = 'rgba(255,238,206,' + (a * 0.55).toFixed(3) + ')';
      c.beginPath();
      c.arc(x, y, d.s, 0, Math.PI * 2);
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  };

  var GRAIN = null;
  function grainUrl() {
    if (GRAIN) return GRAIN;
    var cv = makeCanvas(140, 140), c = cv.getContext('2d'), img = c.createImageData(140, 140), r = rng(3);
    for (var i = 0; i < img.data.length; i += 4) {
      var v = Math.floor(r() * 255);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    try { GRAIN = cv.toDataURL('image/png'); } catch (e) { GRAIN = ''; }
    return GRAIN;
  }

  // ---------------------------------------------------------------- stage

  var INTRO = 2600;   // ms of "lights on" before the log starts

  function mq(q) { return window.matchMedia ? window.matchMedia(q) : { matches: false }; }
  function node(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    parent.appendChild(e);
    return e;
  }

  function parseFocus(raw, w) {
    raw = (raw || '').trim();
    var n = parseFloat(raw);
    if (!isNaN(n)) return clamp(raw.indexOf('%') > -1 || n > 1 ? n / 100 : n, 0, 1);
    return w < 820 ? 0.5 : 0.72;
  }

  // Sizes a canvas to the whole box plus parallax padding; returns a context in world units.
  function fullCanvas(cv, v, d) {
    var cw = v.w + PAD * 2, ch = v.h + PAD * 2;
    cv.width = Math.max(1, Math.round(cw * d));
    cv.height = Math.max(1, Math.round(ch * d));
    cv.style.cssText = 'left:' + -PAD + 'px;top:' + -PAD + 'px;width:' + cw + 'px;height:' + ch + 'px';
    var c = cv.getContext('2d');
    var kx = cv.width / cw, ky = cv.height / ch;
    c.setTransform(v.s * kx, 0, 0, v.s * ky, (PAD - v.x0 * v.s) * kx, (PAD - v.y0 * v.s) * ky);
    return c;
  }

  // Sizes a canvas to a world rect, snapped to device pixels.
  function regionCanvas(cv, v, box, d) {
    var left = Math.round((box[0] - v.x0) * v.s * d) / d;
    var top = Math.round((box[1] - v.y0) * v.s * d) / d;
    cv.width = Math.max(1, Math.round(box[2] * v.s * d));
    cv.height = Math.max(1, Math.round(box[3] * v.s * d));
    cv.style.cssText = 'left:' + left + 'px;top:' + top + 'px;width:' + cv.width / d + 'px;height:' + cv.height / d + 'px';
    var c = cv.getContext('2d');
    c.setTransform(v.s * d, 0, 0, v.s * d, -d * (v.x0 * v.s + left), -d * (v.y0 * v.s + top));
    return c;
  }

  function Stage(root) {
    var self = this;
    this.root = root;
    this.t = 0;
    this.total = 0;
    this.frame = newFrame();
    this.shown = newFrame();
    this.dust = new Dust(46);
    this.par = { x: 0, y: 0, tx: 0, ty: 0, lx: 9, ly: 9 };
    this.cycle = -1;
    this.flash = 0;
    this.nextGlint = 4200;
    this.spots = [];
    this.visible = !('IntersectionObserver' in window);
    this.reduce = mq('(prefers-reduced-motion: reduce)');
    this.fine = mq('(hover: hover) and (pointer: fine)');
    this.tickBound = function (now) { self.tick(now); };
    this.build();
    this.layout();

    if ('ResizeObserver' in window) new ResizeObserver(function () { self.queueLayout(); }).observe(root);
    window.addEventListener('resize', function () { self.queueLayout(); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        self.visible = es[es.length - 1].isIntersecting;
        self.sync();
      }).observe(root);
    }
    document.addEventListener('visibilitychange', function () { self.sync(); });
    window.addEventListener('pointermove', function (e) {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      self.par.tx = clamp(e.clientX / window.innerWidth * 2 - 1, -1, 1);
      self.par.ty = clamp(e.clientY / window.innerHeight * 2 - 1, -1, 1);
    }, { passive: true });
    document.documentElement.addEventListener('mouseleave', function () { self.par.tx = self.par.ty = 0; });
    if (this.reduce.addEventListener) this.reduce.addEventListener('change', function () { self.key = ''; self.layout(); if (self.reduce.matches) self.still(); self.sync(); });

    root.bautaStage = {
      seek: function (ms) { self.hold = true; self.sync(); self.t = ms; self.introDone = false; self.render(0, true); },
      play: function () { self.hold = false; self.sync(); },
      pause: function () { self.hold = true; self.sync(); },
      time: function () { return self.t; }
    };
    if (this.reduce.matches) this.still();
    this.sync();
  }

  Stage.prototype.build = function () {
    var root = this.root;
    if (window.getComputedStyle(root).position === 'static') root.style.position = 'relative';
    var scene = node('div', 'stage__scene', root);
    this.lWall = node('div', 'stage__layer stage__layer--wall', scene);
    this.cWall = node('canvas', '', this.lWall);
    this.lRows = node('div', 'stage__layer stage__layer--rows', scene);
    this.cRows = node('canvas', '', this.lRows);
    this.glints = [node('i', 'stage__glint', this.lRows), node('i', 'stage__glint', this.lRows)];
    this.lHaze = node('div', 'stage__layer stage__layer--haze', scene);
    this.cHaze = node('canvas', 'stage__haze', this.lHaze);
    this.lEx = node('div', 'stage__layer stage__layer--exhibit', scene);
    this.cEx = node('canvas', 'stage__exhibit', this.lEx);
    this.cSpill = node('canvas', 'stage__spill', this.lEx);
    this.crtBox = node('div', 'stage__crt', this.lEx);
    node('i', 'stage__crt-roll', this.crtBox);
    node('i', 'stage__crt-glass', this.crtBox);
    this.crt = new Crt(this.crtBox);
    this.cCone = node('canvas', 'stage__cone', this.lEx);
    this.cDust = node('canvas', 'stage__dust', this.lEx);
    node('div', 'stage__shade', scene);
    var grain = node('div', 'stage__grain', scene), url = grainUrl();
    if (url) grain.style.backgroundImage = 'url(' + url + ')';
    root.classList.add('is-built');
  };

  Stage.prototype.queueLayout = function () {
    var self = this;
    clearTimeout(this.lt);
    this.lt = setTimeout(function () { if (self.layout() && self.reduce.matches) self.still(); }, 120);
  };

  Stage.prototype.layout = function () {
    var root = this.root, w = root.clientWidth, h = root.clientHeight;
    if (w < 2 || h < 2) return false;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var fx = parseFocus(window.getComputedStyle(root).getPropertyValue('--stage-focus-x'), w);
    var key = [w, h, dpr, fx].join('|');
    if (key === this.key) return false;
    this.key = key;
    var s = h / WORLD_H;
    if (w / s > WORLD_W) s = w / WORLD_W;
    if (w / s < MIN_VIEW_W) s = w / MIN_VIEW_W;
    var vw = w / s, vh = h / s;
    var v = this.v = {
      w: w, h: h, s: s, dpr: dpr, fx: fx,
      x0: clamp(FOCUS_X - fx * vw, 0, Math.max(0, WORLD_W - vw)),
      y0: clamp(FOCUS_Y - vh / 2, 0, Math.max(0, WORLD_H - vh))
    };
    root.classList.toggle('stage--side', fx >= 0.6);
    this.renderWall();
    this.renderRows();
    paintHaze(fullCanvas(this.cHaze, v, 0.35));
    var ce = regionCanvas(this.cEx, v, EXHIBIT_BOX, dpr);
    paintExhibit(ce);
    paintSpill(regionCanvas(this.cSpill, v, EXHIBIT_BOX, Math.min(dpr, 1)), this.cEx);
    paintCone(regionCanvas(this.cCone, v, CONE_BOX, 0.5));
    this.dc = regionCanvas(this.cDust, v, CONE_BOX, Math.min(dpr, 1.5));
    this.dm = this.dc.getTransform ? this.dc.getTransform() : null;
    var gl = Math.round((GLASS[0] - v.x0) * s * dpr) / dpr, gt = Math.round((GLASS[1] - v.y0) * s * dpr) / dpr;
    var gw = Math.round(GLASS[2] * s * dpr) / dpr, gh = Math.round(GLASS[3] * s * dpr) / dpr;
    this.crtBox.style.cssText = 'left:' + gl + 'px;top:' + gt + 'px;width:' + gw + 'px;height:' + gh + 'px';
    this.crt.resize(gw, gh, dpr);
    this.lastPower = -1;
    this.render(0, true);
    return true;
  };

  Stage.prototype.renderWall = function () {
    var v = this.v, d = Math.min(v.dpr, 1);
    var c = fullCanvas(this.cWall, v, d);
    var off = makeCanvas(this.cWall.width, this.cWall.height), oc = off.getContext('2d');
    oc.setTransform(c.getTransform ? c.getTransform() : new DOMMatrix());
    paintWall(oc);
    var moon = makeCanvas(off.width, off.height), mc = moon.getContext('2d');
    mc.setTransform(oc.getTransform());
    paintMoonlight(mc);
    oc.setTransform(1, 0, 0, 1, 0, 0);
    oc.globalCompositeOperation = 'lighter';
    drawBlurred(oc, moon, 16 * v.s * d);
    oc.globalCompositeOperation = 'source-over';
    c.setTransform(1, 0, 0, 1, 0, 0);
    drawBlurred(c, off, Math.max(0.6, 1.2 * v.s * d));
  };

  Stage.prototype.renderRows = function () {
    var v = this.v, d = Math.min(v.dpr, 1.5);
    var cv = this.cRows, c = fullCanvas(cv, v, d);
    var kx = cv.width / (v.w + PAD * 2), k = v.s * kx;
    var ox = (PAD - v.x0 * v.s) * kx, oy = (PAD - v.y0 * v.s) * kx;
    var r = rng(11), i;
    c.globalCompositeOperation = 'lighter';
    for (i = 0; i < 16; i++) {
      var bx = 820 + r() * 1700, by = 300 + r() * 160, br = 8 + r() * 22;
      blob(c, bx, by, br, br, r() < 0.7 ? 'rgba(255,196,120,' + (0.05 + r() * 0.08).toFixed(3) + ')' : 'rgba(160,184,226,' + (0.05 + r() * 0.06).toFixed(3) + ')', 0.75);
    }
    c.globalCompositeOperation = 'source-over';
    var beams = makeCanvas(cv.width, cv.height), bc = beams.getContext('2d');
    bc.setTransform(k, 0, 0, k, ox, oy);
    GALLERY.forEach(function (g) {
      var f = FOCAL / g[1], x = VP_X + f * g[0], yb = proj(g[0], 1.05, g[1])[1];
      bc.fillStyle = lin(bc, 0, -60, 0, yb, [[0, 'rgba(255,226,170,0)'], [0.55, 'rgba(255,226,170,.05)'], [1, 'rgba(255,226,170,.11)']]);
      poly(bc, [[x - f * 0.05, -60], [x + f * 0.05, -60], [x + f * 0.3, yb], [x - f * 0.3, yb]]);
      bc.fill();
    });
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'lighter';
    drawBlurred(c, beams, 6 * k);
    c.globalCompositeOperation = 'source-over';
    var spots = [];
    for (i = 0; i < GALLERY.length; i++) {
      var g = GALLERY[i], X = g[0], z = g[1], f = FOCAL / z, mh = 0.3 * f;
      var blur = 40 * (1 / 3.4 - 1 / z) * k;
      var m = Math.ceil(blur * 2.5 + 4);
      var wx0 = VP_X + f * (X - 0.3) - 10, wx1 = VP_X + f * (X + 0.3) + 10;
      var wy0 = proj(X, 1.1, z + 0.12)[1] - mh * 1.15, wy1 = proj(X, 0, z)[1] + 4;
      var dx0 = Math.floor(wx0 * k + ox), dy0 = Math.floor(wy0 * k + oy);
      var dw = Math.ceil((wx1 - wx0) * k), dh = Math.ceil((wy1 - wy0) * k);
      if (dx0 + dw < -m || dx0 > cv.width + m || dy0 > cv.height + m) continue;
      var tmp = makeCanvas(dw + m * 2, Math.min(dh, cv.height - dy0 + m) + m * 2), tc = tmp.getContext('2d');
      tc.setTransform(k, 0, 0, k, ox - dx0 + m, oy - dy0 + m);
      var info = paintPlinth(tc, X, z, g[2]);
      c.setTransform(1, 0, 0, 1, 0, 0);
      drawBlurred(c, tmp, blur, dx0 - m, dy0 - m);
      var base = info.base * k + oy;
      if (base < cv.height) {
        var span = base - (dy0 - m);
        var refl = makeCanvas(tmp.width, Math.max(2, Math.min(span, cv.height - base + 4))), rc = refl.getContext('2d');
        rc.setTransform(1, 0, 0, -1, 0, span);
        rc.drawImage(tmp, 0, 0);
        rc.setTransform(1, 0, 0, 1, 0, 0);
        rc.globalCompositeOperation = 'destination-in';
        rc.fillStyle = lin(rc, 0, 0, 0, span * 0.7, [[0, 'rgba(0,0,0,.3)'], [1, 'rgba(0,0,0,0)']]);
        rc.fillRect(0, 0, refl.width, refl.height);
        drawBlurred(c, refl, blur * 1.6 + 2, dx0 - m, base);
      }
      c.setTransform(k, 0, 0, k, ox, oy);
      c.globalCompositeOperation = 'lighter';
      for (var h = 0; h < info.hi.length; h++) {
        var rr = blur / k * 1.5 + mh * 0.05;
        blob(c, info.hi[h][0], info.hi[h][1], rr, rr, 'rgba(255,210,140,' + (h ? 0.12 : 0.2) + ')', 0.8);
      }
      c.globalCompositeOperation = 'source-over';
      var ex = (info.eye[0] - v.x0) * v.s, ey = (info.eye[1] - v.y0) * v.s;
      if (ex > (v.fx >= 0.6 ? v.w * 0.42 : 0) && ex < v.w && ey > 0 && ey < v.h) spots.push([ex, ey, info.size * v.s]);
    }
    this.spots = spots;
  };

  Stage.prototype.applyIntro = function (t) {
    if (t >= 1720) {
      this.lWall.style.opacity = this.lHaze.style.opacity = this.cCone.style.opacity = this.cDust.style.opacity = '';
      this.cRows.style.filter = this.cEx.style.filter = '';
      this.introDone = true;
      return;
    }
    var moon = smooth(t / 1200);
    var spot = t < 1400 ? 0 : t < 1460 ? 1 : t < 1530 ? 0.55 : 0.55 + 0.45 * smooth((t - 1530) / 160);
    this.lWall.style.opacity = moon.toFixed(3);
    this.lHaze.style.opacity = (moon * 0.6 + spot * 0.4).toFixed(3);
    this.cCone.style.opacity = this.cDust.style.opacity = spot.toFixed(3);
    this.cRows.style.filter = 'brightness(' + (0.16 + 0.22 * moon + 0.62 * spot).toFixed(3) + ')';
    this.cEx.style.filter = 'brightness(' + (0.1 + 0.22 * moon + 0.68 * spot).toFixed(3) + ')';
  };

  // Draws everything that changes over time. force skips the screen's frame-rate cap.
  Stage.prototype.render = function (dt, force) {
    if (!this.v) return;
    var t = this.t;
    if (!this.introDone) this.applyIntro(t);
    var power = smooth((t - 2000) / 600);
    if (force || power !== this.lastPower || t - (this.crtAt || 0) >= 33) {
      this.crtAt = t;
      var ct = t - INTRO, at = scriptAt(Math.max(0, ct));
      computeFrame(this.frame, at.sc, ct < 0 ? 0 : at.t);
      if (ct >= 0) {
        var cycle = Math.floor(ct / LOOP) * SCRIPTS.length + at.i;
        if (cycle !== this.cycle) { this.cycle = cycle; this.sent = false; }
        if (!this.sent && at.t >= at.sc.mask) {
          this.sent = true;
          if (at.t < at.sc.mask + 1500 && !force) this.emit(at.sc.count);
        }
      }
      if (force || power !== this.lastPower || !sameFrame(this.frame, this.shown)) {
        var sw = this.shown; this.shown = this.frame; this.frame = sw;
        this.lastPower = power;
        this.crt.draw(this.shown, power);
      }
    }
    this.flash = Math.max(0, this.flash - dt / 700);
    var spill = power * (0.74 + 0.26 * Math.min(1, this.shown.lit / 300)) + 0.14 * this.flash;
    if (Math.abs(spill - (this.spill || 0)) > 0.008 || force) { this.spill = spill; this.cSpill.style.opacity = spill.toFixed(3); }
    var dc = this.dc;
    dc.setTransform(1, 0, 0, 1, 0, 0);
    dc.clearRect(0, 0, this.cDust.width, this.cDust.height);
    if (this.dm) dc.setTransform(this.dm);
    this.dust.draw(dc, t);
    var p = this.par;
    if (this.fine.matches && !this.reduce.matches) {
      var e = Math.min(1, dt / 260);
      p.x += (p.tx - p.x) * e;
      p.y += (p.ty - p.y) * e;
    } else { p.x = p.y = 0; }
    if (Math.abs(p.x - p.lx) > 0.0005 || Math.abs(p.y - p.ly) > 0.0005) {
      p.lx = p.x; p.ly = p.y;
      this.lWall.style.transform = 'translate3d(' + (-p.x * 6).toFixed(2) + 'px,' + (-p.y * 4).toFixed(2) + 'px,0)';
      this.lRows.style.transform = 'translate3d(' + (-p.x * 12).toFixed(2) + 'px,' + (-p.y * 7).toFixed(2) + 'px,0)';
      this.lHaze.style.transform = 'translate3d(' + (-p.x * 9).toFixed(2) + 'px,' + (-p.y * 5).toFixed(2) + 'px,0)';
      this.lEx.style.transform = 'translate3d(' + (-p.x * 18).toFixed(2) + 'px,' + (-p.y * 10).toFixed(2) + 'px,0)';
    }
    if (t > this.nextGlint && this.spots.length && !force) {
      this.nextGlint = t + 2600 + Math.random() * 4200;
      var s = this.spots[Math.floor(Math.random() * this.spots.length)];
      var gEl = this.glints[Math.floor(Math.random() * this.glints.length)];
      gEl.classList.remove('is-on');
      gEl.style.cssText = 'left:' + s[0].toFixed(1) + 'px;top:' + s[1].toFixed(1) + 'px;--g:' + Math.max(8, s[2] * 0.22).toFixed(1) + 'px';
      void gEl.offsetWidth;
      gEl.classList.add('is-on');
    }
  };

  Stage.prototype.emit = function (count) {
    this.total += count;
    this.flash = 1;
    this.root.setAttribute('data-masked', this.total);
    try {
      document.dispatchEvent(new CustomEvent('bauta:masked', { detail: { count: count, total: this.total } }));
    } catch (e) { /* very old browsers */ }
  };

  Stage.prototype.tick = function (now) {
    this.raf = 0;
    if (!this.running) return;
    var dt = this.last ? Math.min(50, now - this.last) : 16;
    this.last = now;
    this.t += dt;
    this.render(dt, false);
    this.raf = window.requestAnimationFrame(this.tickBound);
  };

  Stage.prototype.sync = function () {
    var go = this.visible && !document.hidden && !this.reduce.matches && !this.hold;
    this.root.classList.toggle('is-paused', !go);
    if (go && !this.running) {
      this.running = true;
      this.last = 0;
      this.raf = window.requestAnimationFrame(this.tickBound);
    } else if (!go && this.running) {
      this.running = false;
      if (this.raf) window.cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  };

  // Reduced motion: lights on, the first request finished on screen, nothing moves.
  Stage.prototype.still = function () {
    var self = this;
    var sc = SCRIPTS[0], at = sc.done + 60;
    if (Math.floor(at / 530) % 2) at = (Math.floor(at / 530) + 1) * 530 + 20;
    if (at >= sc.log) at = sc.log - 40;
    this.t = INTRO + at;
    this.introDone = false;
    this.render(0, true);
    if (!this.stillSent) {
      this.stillSent = true;
      setTimeout(function () { self.emit(SCRIPTS[0].count); }, 400);
    }
  };

  function init() {
    var list = document.querySelectorAll('[data-stage]');
    for (var i = 0; i < list.length; i++) {
      if (!list[i].bautaStage) {
        try { new Stage(list[i]); } catch (e) { if (window.console) console.warn('stage:', e); }
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
