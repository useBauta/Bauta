/* Bauta site: small enhancements on top of a page that reads fine without them.
   No dependencies. Loaded with defer, so the DOM is ready when this runs. */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var live = doc.getElementById('live');
  var motion = root.classList.contains('motion');
  var hasIO = 'IntersectionObserver' in window;

  /* ---------- Header: solid once the page has moved ---------- */

  var scrolled = null;
  function markScrolled() {
    var s = window.scrollY > 8;
    if (s !== scrolled) {
      scrolled = s;
      root.classList.toggle('is-scrolled', s);
    }
  }
  window.addEventListener('scroll', markScrolled, { passive: true });
  markScrolled();

  /* ---------- Current section in the pill nav ---------- */

  var navLinks = Array.prototype.slice.call(doc.querySelectorAll('.nav a[href^="#"]'));
  if (hasIO && navLinks.length) {
    var byId = {};
    navLinks.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var visible = {};
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { visible[e.target.id] = e.isIntersecting; });
      var current = null;
      navLinks.forEach(function (a) {
        var id = a.getAttribute('href').slice(1);
        if (visible[id] && !current) current = id;
      });
      navLinks.forEach(function (a) {
        if (byId[current] === a) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(byId).forEach(function (id) {
      var sec = doc.getElementById(id);
      if (sec) spy.observe(sec);
    });
  }

  /* ---------- Art that has not arrived stays out of sight ---------- */

  Array.prototype.forEach.call(doc.querySelectorAll('.card__art img, .band__art img'), function (img) {
    function hide() { img.classList.add('is-missing'); }
    // complete with no size means the request already failed
    if (img.complete && img.naturalWidth === 0) hide();
    img.addEventListener('error', hide);
    img.addEventListener('load', function () { img.classList.remove('is-missing'); });
  });

  /* ---------- Section headings: split into letters for the LED sweep ---------- */

  function splitLed(h) {
    var text = h.textContent;
    var shown = doc.createElement('span');
    shown.setAttribute('aria-hidden', 'true');
    var words = text.split(/\s+/).filter(Boolean);
    var n = text.replace(/\s+/g, '').length;
    var i = 0;
    words.forEach(function (word, w) {
      var wSpan = doc.createElement('span');
      wSpan.className = 'led__w';
      for (var k = 0; k < word.length; k++) {
        var ch = doc.createElement('span');
        ch.className = 'led__ch';
        ch.style.setProperty('--i', i++);
        ch.textContent = word[k];
        wSpan.appendChild(ch);
      }
      shown.appendChild(wSpan);
      if (w < words.length - 1) shown.appendChild(doc.createTextNode(' '));
    });
    var label = doc.createElement('span');
    label.className = 'sr';
    label.textContent = text;
    h.textContent = '';
    h.appendChild(label);
    h.appendChild(shown);
    h.style.setProperty('--step', Math.min(28, Math.round(760 / Math.max(n, 1))) + 'ms');
  }

  /* ---------- Scroll-triggered motion ----------
     Nothing is hidden until the reader first scrolls, and then only what is still below the
     fold. A page that is printed, captured or never scrolled shows everything as it ends up. */

  if (motion && hasIO) {
    Array.prototype.forEach.call(doc.querySelectorAll('h2.led'), splitLed);

    var reveal = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        el.classList.remove('is-pending');
        el.classList.add('is-in');
        reveal.unobserve(el);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.15 });

    var armed = false;
    var arm = function () {
      if (armed) return;
      armed = true;
      window.removeEventListener('scroll', arm);
      var fold = window.innerHeight;
      var items = doc.querySelectorAll('[data-reveal], h2.led');
      for (var i = 0; i < items.length; i++) {
        var el = items[i];
        if (el.getBoundingClientRect().top <= fold) continue;
        el.classList.add('is-pending');
        reveal.observe(el);
      }
    };
    window.addEventListener('scroll', arm, { passive: true });
  }

  /* ---------- Pause looping work that is off screen ---------- */

  if (hasIO) {
    var pauser = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { e.target.classList.toggle('is-off', !e.isIntersecting); });
    });
    Array.prototype.forEach.call(doc.querySelectorAll('.hero, .foot'), function (el) { pauser.observe(el); });

    // The card and canal art animate inside their own SVG files, which page CSS cannot pause.
    // Far off screen they are not drawn at all, so their animations stop with them.
    var far = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { e.target.classList.toggle('is-far', !e.isIntersecting); });
    }, { rootMargin: '320px 0px' });
    Array.prototype.forEach.call(doc.querySelectorAll('.card__art, .band__art'), function (el) { far.observe(el); });
  }

  /* ---------- Venice band: the art drifts a little slower than the page ---------- */

  var band = doc.querySelector('.band');
  var bandImg = band && band.querySelector('.band__art img');
  if (motion && band && bandImg && hasIO) {
    var bandOn = false;
    var queued = false;
    var drift = function () {
      queued = false;
      if (!bandOn) return;
      var r = band.getBoundingClientRect();
      var wide = window.innerWidth >= 760;
      var range = wide ? 56 : 36;
      var off = (r.top + r.height / 2 - window.innerHeight / 2) * -0.08;
      off = Math.max(-range, Math.min(range, off));
      bandImg.style.transform = 'translate3d(0,' + off.toFixed(1) + 'px,0)';
    };
    var queue = function () {
      if (!queued) { queued = true; requestAnimationFrame(drift); }
    };
    new IntersectionObserver(function (entries) {
      bandOn = entries[0].isIntersecting;
      if (bandOn) queue();
    }).observe(band);
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
  }

  /* ---------- Live counter, fed by the hero stage ---------- */

  var counter = doc.querySelector('[data-counter]');
  if (counter) {
    var num = counter.querySelector('.hero__n');
    var unit = counter.querySelector('.hero__unit');
    var dia = counter.querySelector('.dia');
    var total = 0;
    doc.addEventListener('bauta:masked', function (e) {
      var d = e.detail || {};
      var next = typeof d.total === 'number' ? d.total : total + (Number(d.count) || 0);
      if (!(next > 0) || next === total) return;
      total = next;
      num.textContent = total.toLocaleString('en-US');
      unit.textContent = total === 1 ? 'value' : 'values';
      counter.hidden = false;
      if (motion) {
        [num, dia].forEach(function (el) {
          el.classList.remove('is-tick');
          void el.offsetWidth;
          el.classList.add('is-tick');
        });
      }
    });
  }

  /* ---------- Copy buttons ---------- */

  // The older route still works where the Clipboard API is blocked (file://, some frames).
  function legacyCopy(text) {
    var area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.opacity = '0';
    doc.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = doc.execCommand('copy'); } catch (err) { ok = false; }
    doc.body.removeChild(area);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () {
        if (!legacyCopy(text)) throw new Error('copy failed');
      });
    }
    return legacyCopy(text) ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }

  function settle(button, label, text, done) {
    clearTimeout(button._reset);
    button.classList.toggle('is-copied', done);
    label.textContent = text;
    button._reset = setTimeout(function () {
      button.classList.remove('is-copied');
      label.textContent = 'Copy';
    }, 1800);
  }

  doc.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('[data-copy]') : null;
    if (!button) return;
    var source = doc.getElementById(button.getAttribute('data-copy'));
    var label = button.querySelector('.copy__label');
    if (!source || !label) return;
    var text = source.textContent.trim();
    copyText(text).then(function () {
      settle(button, label, 'Copied', true);
      if (live) live.textContent = 'Copied to the clipboard.';
    }, function () {
      // No clipboard access: select the command so the reader can copy it by hand.
      var range = doc.createRange();
      range.selectNodeContents(source);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      settle(button, label, 'Selected', false);
      if (live) live.textContent = 'Command selected. Press Ctrl+C or Cmd+C to copy.';
    });
  });

  /* ---------- Shell tabs on the setup commands ---------- */

  Array.prototype.forEach.call(doc.querySelectorAll('[data-tabs]'), function (box) {
    var panels = Array.prototype.slice.call(box.querySelectorAll('[data-tab]'));
    var bar = box.querySelector('.cmds__bar');
    if (panels.length < 2 || !bar) return;

    var list = doc.createElement('div');
    list.className = 'cmds__tabs';
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', box.getAttribute('data-tabs-label') || 'Choose');

    var tabs = panels.map(function (panel) {
      var tab = doc.createElement('button');
      tab.type = 'button';
      tab.className = 'cmds__tab';
      tab.id = panel.id + '-tab';
      tab.textContent = panel.getAttribute('data-tab');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panel.id);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      list.appendChild(tab);
      return tab;
    });

    function select(index, focus) {
      tabs.forEach(function (tab, i) {
        var on = i === index;
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
        panels[i].hidden = !on;
      });
      if (focus) tabs[index].focus();
    }

    list.addEventListener('click', function (event) {
      var tab = event.target.closest('[role="tab"]');
      if (tab) select(tabs.indexOf(tab), false);
    });
    list.addEventListener('keydown', function (event) {
      var i = tabs.indexOf(doc.activeElement);
      if (i < 0) return;
      var next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select((next + tabs.length) % tabs.length, true);
    });

    bar.appendChild(list);
    box.classList.add('is-tabbed');

    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    select(/win/i.test(platform) ? 0 : 1, false);
  });

  /* ---------- FAQ: open and close with a height animation ---------- */

  if (motion && Element.prototype.animate) {
    Array.prototype.forEach.call(doc.querySelectorAll('.qa'), function (item) {
      var summary = item.querySelector('summary');
      var body = item.querySelector('.qa__a');
      var running = null;

      summary.addEventListener('click', function (event) {
        event.preventDefault();
        var opening = !item.open || item.classList.contains('is-closing');
        var from = body.getBoundingClientRect().height;
        if (running) running.cancel();

        if (opening) {
          item.classList.remove('is-closing');
          item.open = true;
          var to = body.scrollHeight;
          running = body.animate(
            [{ height: from + 'px', opacity: from ? 1 : 0 }, { height: to + 'px', opacity: 1 }],
            { duration: 380, easing: 'cubic-bezier(.2,.7,.2,1)' }
          );
        } else {
          item.classList.add('is-closing');
          running = body.animate(
            [{ height: from + 'px', opacity: 1 }, { height: '0px', opacity: 0 }],
            { duration: 300, easing: 'cubic-bezier(.2,.7,.2,1)' }
          );
        }
        running.onfinish = function () {
          running = null;
          if (item.classList.contains('is-closing')) {
            item.classList.remove('is-closing');
            item.open = false;
          }
        };
      });
    });
  }
})();
