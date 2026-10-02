/* Pétale — page behaviour.
   One rAF loop drives everything: Lenis smooth scroll first, then the film player reads the
   scroll position, then the top progress bar. Reveals, in-page anchors, the loading veil.
   Classic script (no modules) so the page also works from file:// and degrades without the
   film or the checkout. */
(function () {
  'use strict';

  var html = document.documentElement;
  var body = document.body;
  html.classList.remove('nojs');
  html.classList.add('js');
  html.setAttribute('data-booted', '');

  var SITE = window.SITE || {};
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };

  /* ── prices: config.js is the source of truth, the static copy in the HTML is the fallback ── */
  (function syncPrices() {
    var list = SITE.products || [];
    var cur = SITE.currency || {};
    var bySku = {};
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].sku) bySku[list[i].sku] = list[i];
    var fmt = function (n) {
      try {
        return new Intl.NumberFormat(cur.locale || 'en-US', {
          style: 'currency', currency: cur.code || 'USD',
          minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2
        }).format(n);
      } catch (e) { return (cur.symbol || '$') + n; }
    };
    var els = document.querySelectorAll('[data-price]');
    for (var j = 0; j < els.length; j++) {
      var p = bySku[els[j].getAttribute('data-price')];
      if (!p || typeof p.price !== 'number') continue;
      var t = fmt(p.price);
      if (els[j].textContent !== t) els[j].textContent = t;
    }
  })();

  /* ── film progress bar & fallback progress ── */
  var progEl = document.querySelector('.prog');
  var lastProg = -1;
  var maxScroll = 1;
  function updateMaxScroll() {
    maxScroll = Math.max(1, (document.scrollingElement || html).scrollHeight - window.innerHeight);
  }

  /* ── film player ── */
  var player = null;
  var filmEl = document.getElementById('film');

  function measure() {
    updateMaxScroll();
    if (player && typeof player.measure === 'function') {
      try { player.measure(); } catch (e) { /* the player re-measures itself on resize too */ }
    }
  }

  /* ── reveals: start observing only once the veil has lifted, so nothing plays unseen ── */
  function observeReveals() {
    var targets = document.querySelectorAll('.scene:not(.hero), .collection, .foot, .pcard');
    var i;
    if (reduced || !('IntersectionObserver' in window)) {
      for (i = 0; i < targets.length; i++) targets[i].classList.add('in');
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      for (var k = 0; k < entries.length; k++) {
        var e = entries[k];
        if (!e.isIntersecting) continue;
        /* threshold .2 — or, for a block taller than five viewports, a third of the screen */
        var rb = e.rootBounds;
        if (e.intersectionRatio >= 0.2 || (rb && e.intersectionRect.height >= rb.height * 0.33)) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }
    }, { threshold: [0, 0.05, 0.1, 0.15, 0.2], rootMargin: '0px 0px -12% 0px' });
    for (i = 0; i < targets.length; i++) io.observe(targets[i]);
  }

  /* ── veil ── */
  var veil = document.getElementById('veil');
  var veilBar = veil ? veil.querySelector('.bar span') : null;
  var isReady = false;
  var veilShown = 0;
  function setVeil(f) {
    if (isReady || !veilBar) return;
    f = clamp01(+f || 0);
    if (f <= veilShown) return;                       // the bar only ever grows
    veilShown = f;
    veilBar.style.transform = 'scaleX(' + f.toFixed(3) + ')';
  }
  function reveal() {
    if (isReady) return;
    isReady = true;
    if (veilBar) veilBar.style.transform = 'scaleX(1)';
    if (veil) {
      veil.classList.add('gone');
      setTimeout(function () { veil.classList.add('out'); }, 1300);   // after the fade: out of the way entirely
    }
    body.classList.add('ready');
    measure();
    observeReveals();
  }
  setTimeout(reveal, 8000);                           // never trap the visitor behind the veil

  if (window.FilmPlayer && typeof window.FilmPlayer.create === 'function' && filmEl) {
    try {
      player = window.FilmPlayer.create({
        container: filmEl,
        anchors: ['top', 'bloom', 'cream', 'texture', 'line'],
        config: SITE.film || { source: 'auto', manifest: 'film/manifest.json', scene: 'scene2d' },
        onLoadProgress: setVeil,
        onReady: reveal
      });
    } catch (err) {
      player = null;
      if (window.console) console.warn('[pétale] the film could not start; the page carries on without it.', err);
    }
  }
  if (!player) {
    if (document.readyState === 'complete') reveal();
    else window.addEventListener('load', reveal, { once: true });
  }

  /* ── smooth scroll ── */
  var lenis = null;
  if (window.Lenis && !reduced) {
    try {
      lenis = new window.Lenis({ lerp: 0.12, smoothWheel: true });
      window.lenis = lenis;
    } catch (err) { lenis = null; }
  }

  /* ── the one loop ── */
  var scrolled = null;
  var frameFailed = false;
  function tick(t) {
    if (lenis) lenis.raf(t);
    var y = window.scrollY || window.pageYOffset || 0;
    var p = NaN;
    if (player) {
      try {
        player.frame(t, y);
        p = +player.progress;
      } catch (err) {
        if (!frameFailed && window.console) { frameFailed = true; console.warn('[pétale] film frame failed', err); }
      }
    }
    if (!(p >= 0)) p = y / maxScroll;                 // no film: show page progress instead
    p = clamp01(p);
    if (progEl && p !== lastProg && (Math.abs(p - lastProg) > 0.0004 || p === 0 || p === 1)) {
      lastProg = p;
      progEl.style.transform = 'scaleX(' + p.toFixed(4) + ')';
    }
    var s = y > 24;
    if (s !== scrolled) {
      scrolled = s;
      body.classList.toggle('scrolled', s);
    }
    window.requestAnimationFrame(tick);
  }
  updateMaxScroll();
  window.requestAnimationFrame(tick);

  /* ── in-page anchors: smooth with Lenis; href="#" placeholders are inert ── */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    var href = a.getAttribute('href');
    if (href === '#') { e.preventDefault(); return; }
    var target = null;
    try { target = document.querySelector(href); } catch (err) { return; }
    if (!target) return;
    e.preventDefault();
    if (lenis && !lenis.isStopped) lenis.scrollTo(target, { duration: 1.5 });
    else target.scrollIntoView({ block: 'start' });
    /* keyboard users (and the skip link) also get focus moved to the destination */
    if (e.detail === 0 || a.classList.contains('skip')) {
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      try { target.focus({ preventScroll: true }); } catch (err) { target.focus(); }
    }
  });

  /* ── keep the film's anchors honest when the layout moves ── */
  if (document.fonts) {
    if (document.fonts.ready) document.fonts.ready.then(measure, function () {});
    if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', measure);
  }
  window.addEventListener('load', measure);
  var rzT = 0;
  window.addEventListener('resize', function () {
    clearTimeout(rzT);
    rzT = setTimeout(measure, 200);
  }, { passive: true });
})();
