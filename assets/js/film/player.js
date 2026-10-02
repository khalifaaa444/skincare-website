/* Pétale — film player.

   Hosts ONE film source in the fixed full-viewport #film container and drives it from the page
   scroll. The film's progress p ∈ [0,1] is pinned to the scene sections: anchor k of n is reached
   when that section sits centred in the viewport (p = k/(n-1)), linear in between, clamped.

     const player = FilmPlayer.create({ container, anchors, config, onLoadProgress, onReady });
     player.frame(nowMs, scrollY);   // once per animation frame, from the page's single rAF loop
     player.progress;                // eased progress currently on screen
     player.measure();               // re-measure the anchors (fonts / images / layout changed)

   Sources live in window.FilmSources (frames | scene2d | scene3d) and are loaded lazily. For
   config.source "auto" the image-sequence film wins when config.manifest is a valid manifest,
   otherwise the procedural scene named by config.scene runs; any source that fails hands over to
   the next one (frames → scene → scene2d). render(p, info) is called only when p moved, after a
   resize, or when the motion settles; info.velocity is in progress units per second.

   Classic script, no dependencies, no globals besides FilmPlayer and the __film test handle. */
(function () {
  'use strict';

  var SCRIPTS = {
    frames: 'assets/js/film/frames.js',
    scene2d: 'assets/js/film/scene-2d.js',
    scene3d: 'assets/js/film/scene-3d.bundle.js'
  };
  var SELF = 'assets/js/film/player.js';
  var DEFAULT_ANCHORS = ['top', 'bloom', 'cream', 'texture', 'line'];

  var READY_TIMEOUT = 8000;       // never keep the visitor behind the veil longer than this
  var SCENE_TIMEOUT = 12000;      // a procedural scene that has not loaded by now is skipped
  var RESIZE_DEBOUNCE = 150;
  var JITTER_PX = 160;            // same width, smaller height change: the mobile URL bar
  var FADE_MS = 300;              // device-class swap: container fades out, swaps, fades in
  var SWAP_WAIT = 1600;           // longest wait for a swapped source before fading back in
  var SNAP = 1e-4;                // easing snaps onto the target below this distance
  var RENDER_EPS = 1e-5;          // smaller progress changes than this are not re-rendered
  var SETTLE_MS = 100;            // target unchanged this long (and caught up) = at rest

  function noop() {}
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function media(q) {
    try { return window.matchMedia ? window.matchMedia(q) : null; } catch (e) { return null; }
  }
  function onMedia(mql, fn) {
    if (!mql) return noop;
    if (mql.addEventListener) { mql.addEventListener('change', fn); return function () { mql.removeEventListener('change', fn); }; }
    if (mql.addListener) { mql.addListener(fn); return function () { mql.removeListener(fn); }; }
    return noop;
  }
  function warn(msg, err) {
    if (window.console && console.warn) console.warn('[film] ' + msg + (err && err.message ? ' — ' + err.message : ''));
  }

  /* The site root, judged from this script's own URL, so the sources resolve to the same files
     whether the page is at the root or in a sub-folder. Falls back to the document's location. */
  var siteRoot = (function () {
    var s = document.currentScript, src = s && s.src;
    if (!src) return '';
    var at = src.indexOf(SELF);
    return at >= 0 ? src.slice(0, at) : '';
  })();

  /* ---- lazy source scripts --------------------------------------------------------------- */
  var scriptJobs = {};
  function sourceFactory(name, map) {
    var FS = window.FilmSources = window.FilmSources || {};
    if (typeof FS[name] === 'function') return Promise.resolve(FS[name]);
    if (scriptJobs[name]) return scriptJobs[name];
    var path = map[name];
    if (!path) return Promise.reject(new Error('unknown source "' + name + '"'));
    var job = new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = /^([a-z][a-z0-9+.-]*:|\/)/i.test(path) ? path : siteRoot + path;
      el.async = true;
      el.onload = function () {
        var f = (window.FilmSources || {})[name];
        if (typeof f === 'function') resolve(f);
        else reject(new Error(path + ' did not define FilmSources.' + name));
      };
      el.onerror = function () { reject(new Error('could not load ' + path)); };
      (document.head || document.documentElement).appendChild(el);
    });
    scriptJobs[name] = job;
    job.then(null, function () { delete scriptJobs[name]; });
    return job;
  }

  /* ---- manifest probe (source "auto" / "frames") ----------------------------------------- */
  function usableManifest(m) {
    if (!m || typeof m !== 'object' || !m.variants || typeof m.variants !== 'object') return false;
    return Object.keys(m.variants).some(function (k) {
      var v = m.variants[k];
      return !!v && typeof v.dir === 'string' && +v.count >= 1;
    });
  }
  function fetchManifest(url) {
    /* from file:// a fetch can only fail (and log a CORS error), and the frames could not load either */
    if (!url || typeof fetch !== 'function' || location.protocol === 'file:') return Promise.resolve(null);
    var req;
    try { req = fetch(url, { cache: 'no-cache' }); } catch (e) { return Promise.resolve(null); }
    return req.then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) { return usableManifest(m) ? m : null; }, function () { return null; });
  }

  function withTimeout(promise, ms, what) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error(what + ' timed out')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  /* ---- the player ------------------------------------------------------------------------ */
  function create(opts) {
    opts = opts || {};
    var container = opts.container && opts.container.nodeType === 1 ? opts.container : null;
    var ids = (opts.anchors && opts.anchors.length) ? opts.anchors.slice() : DEFAULT_ANCHORS.slice();
    var cfg = opts.config || (window.SITE && window.SITE.film) || {};
    var onLoadProgress = typeof opts.onLoadProgress === 'function' ? opts.onLoadProgress : noop;
    var onReady = typeof opts.onReady === 'function' ? opts.onReady : noop;
    var map = {};
    var k;
    for (k in SCRIPTS) map[k] = SCRIPTS[k];
    var extra = opts.scripts || cfg.scripts;
    if (extra) for (k in extra) map[k] = extra[k];

    var mqReduce = media('(prefers-reduced-motion: reduce)');
    var mqCoarse = media('(pointer: coarse)');

    /* progress */
    var p = 0, target = 0, velocity = 0;
    var lastNow = 0, lastTarget = NaN, targetMovedAt = -1e9, moving = false;
    var renderedP = NaN, renderedMoving = false, needRender = true, snapNext = true;
    var lastScroll = 0;

    /* anchors: [{ y: absolute scroll position, p: progress }] */
    var stops = [], measured = false, docMax = 0, idleMeasure = 0;
    var LVH = window.innerHeight || 0, lastW = window.innerWidth || 0, lastH = window.innerHeight || 0;

    /* source */
    var source = null, sourceName = null, live = false, renderErrors = 0;
    var candidates = [], candidateAt = 0, keepNodes = [];
    var lastV = null, classPortrait = null, swapGen = 0, swapping = false;
    var readyFired = false, bestLoad = 0, destroyed = false;
    var readyResolve;
    var ready = new Promise(function (r) { readyResolve = r; });
    var cleanups = [];
    var resizeTimer = 0, safetyTimer = 0, measureRaf = 0, fadeTimer = 0;

    var handle = {
      progress: function () { return p; },
      target: function () { return target; },
      ready: ready,
      source: null,
      debug: function () {
        return source && typeof source.debug === 'function' ? source.debug() : null;
      },
      anchors: function () { return stops.map(function (s) { return { y: s.y, p: s.p }; }); },
      lvh: function () { return LVH; }
    };
    window.__film = handle;

    var player = {
      frame: frame,
      measure: measure,
      destroy: destroy,
      get progress() { return p; },
      get target() { return target; },
      get velocity() { return velocity; },
      get moving() { return moving; },
      get source() { return sourceName; },
      get ready() { return ready; }
    };

    /* ---- anchors ---- */
    function readDocMax() {
      var de = document.documentElement, b = document.body;
      var h = Math.max(de ? de.scrollHeight : 0, b ? b.scrollHeight : 0);
      return Math.max(0, h - (window.innerHeight || 0));
    }
    function measure() {
      if (destroyed) return;
      var ih = window.innerHeight || 0;
      if (ih > LVH) LVH = ih;
      var sy = window.scrollY || window.pageYOffset || 0;
      docMax = readDocMax();
      var n = ids.length, out = [];
      for (var i = 0; i < n; i++) {
        var el = document.getElementById(ids[i]);
        if (!el) continue;
        var r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;                 // display:none
        var y = r.top + sy + r.height / 2 - LVH / 2;
        out.push({ y: clamp(y, 0, Math.max(0, docMax)), p: n > 1 ? i / (n - 1) : 0 });
      }
      for (var j = 1; j < out.length; j++) if (out[j].y < out[j - 1].y) out[j].y = out[j - 1].y;
      if (out.length) {
        if (out[0].p > 0 && out[0].y > 0) out.unshift({ y: 0, p: 0 });
        var last = out[out.length - 1];
        if (last.p < 1 && docMax > last.y) out.push({ y: docMax, p: 1 });
      }
      stops = out;
      measured = true;
    }
    function scheduleMeasure() {
      if (measureRaf || destroyed) return;
      var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
      measureRaf = raf(function () { measureRaf = 0; measure(); });
    }
    function targetAt(s) {
      var a = stops, n = a.length;
      if (!n) return docMax > 0 ? clamp(s / docMax, 0, 1) : 0;
      if (s <= a[0].y) return a[0].p;
      if (s >= a[n - 1].y) return a[n - 1].p;
      for (var i = 1; i < n; i++) {
        if (s < a[i].y) {
          var y0 = a[i - 1].y, span = a[i].y - y0;
          if (span < 0.5) return a[i].p;
          return clamp(a[i - 1].p + (a[i].p - a[i - 1].p) * (s - y0) / span, 0, 1);
        }
      }
      return a[n - 1].p;
    }

    /* ---- per-frame ---- */
    function frame(now, scrollY) {
      if (destroyed) return p;
      if (typeof now !== 'number' || !isFinite(now)) now = nowMs();
      if (typeof scrollY !== 'number' || !isFinite(scrollY)) scrollY = window.scrollY || window.pageYOffset || 0;
      lastScroll = scrollY;
      if (!measured || (!stops.length && ++idleMeasure % 60 === 0)) measure();

      target = targetAt(scrollY);
      var dt = lastNow ? now - lastNow : 16.7;
      lastNow = now;
      dt = clamp(dt, 0, 100);

      if (lastTarget !== lastTarget) lastTarget = target;
      else if (Math.abs(target - lastTarget) > 1e-7) { lastTarget = target; targetMovedAt = now; }

      var prev = p;
      if (snapNext || (mqReduce && mqReduce.matches)) {
        p = target;
        snapNext = false;
      } else {
        var d = target - p;
        if (Math.abs(d) < SNAP) p = target;
        else p += d * (1 - Math.exp(-dt / ((mqCoarse && mqCoarse.matches) ? 12 : 28)));
      }
      if (dt > 0) {
        var inst = (p - prev) * 1000 / dt;
        velocity += (inst - velocity) * (1 - Math.exp(-dt / 50));
      }
      moving = Math.abs(target - p) > SNAP || now - targetMovedAt < SETTLE_MS;
      if (!moving) velocity = 0;

      if (live && (needRender || renderedP !== renderedP || Math.abs(p - renderedP) > RENDER_EPS ||
                   (renderedMoving && !moving))) draw();
      return p;
    }

    function draw() {
      if (!source) return;
      try {
        source.render(p, { moving: moving, velocity: velocity });
        renderErrors = 0;
      } catch (e) {
        renderErrors++;
        if (renderErrors === 1 && window.console) console.error('[film] render failed', e);
        if (renderErrors >= 3) { abandon(e); return; }
      }
      renderedP = p;
      renderedMoving = moving;
      needRender = false;
    }

    /* ---- viewport, resize, device class ---- */
    function viewport() {
      var iw = window.innerWidth || 1, ih = window.innerHeight || 1;
      var r = container ? container.getBoundingClientRect() : null;
      var w = r && r.width > 0 ? r.width : iw, h = r && r.height > 0 ? r.height : ih;
      return {
        w: Math.max(1, Math.round(w)),
        h: Math.max(1, Math.round(h)),
        dpr: clamp(window.devicePixelRatio || 1, 0.5, 2),
        portrait: iw / Math.max(1, ih) < 0.85
      };
    }
    function sameV(a, b) { return !!a && !!b && a.w === b.w && a.h === b.h && a.dpr === b.dpr && a.portrait === b.portrait; }

    function onWindowResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyResize, RESIZE_DEBOUNCE);
    }
    function applyResize() {
      if (destroyed) return;
      var w = window.innerWidth || 0, h = window.innerHeight || 0;
      var jitter = w === lastW && Math.abs(h - lastH) < JITTER_PX;
      lastW = w; lastH = h;
      if (!jitter) LVH = h;                                // a real resize re-anchors the mapping
      else if (h > LVH) LVH = h;
      measure();
      resizeSource(false);
    }
    function resizeSource(force) {
      if (!container || !source) return;
      var v = viewport();
      if (classPortrait !== null && v.portrait !== classPortrait) { swapClass(); return; }
      if (swapping) return;                                // the swap applies the latest size itself
      if (!force && sameV(v, lastV)) return;
      lastV = v;
      classPortrait = v.portrait;
      try { if (source.resize) source.resize(v); } catch (e) { warn('resize failed', e); }
      needRender = true;
      if (live) draw();                                    // a resized canvas is blank: repaint now
    }
    function swapClass() {
      var g = ++swapGen;
      swapping = true;
      clearTimeout(fadeTimer);
      container.style.transition = 'opacity .3s ease';
      container.style.opacity = '0';
      setTimeout(function () {
        if (g !== swapGen || destroyed) return;
        var v = viewport();
        lastV = v;
        classPortrait = v.portrait;
        var res = null;
        try { res = source && source.resize ? source.resize(v) : null; } catch (e) { warn('resize failed', e); }
        needRender = true;
        var shown = false;
        var reveal = function () {
          if (shown || g !== swapGen || destroyed) return;
          shown = true;
          swapping = false;
          if (live) { needRender = true; draw(); }
          container.style.opacity = '';
          fadeTimer = setTimeout(function () { if (g === swapGen) container.style.transition = ''; }, FADE_MS + 50);
          var v2 = viewport();                             // it may have changed again meanwhile
          if (!sameV(v2, lastV)) resizeSource(false);
        };
        if (res && typeof res.then === 'function') {
          res.then(reveal, reveal);
          setTimeout(reveal, SWAP_WAIT);
        } else reveal();
      }, FADE_MS);
    }
    function watchDpr() {
      var dpr = window.devicePixelRatio || 1;
      var mql = media('(resolution: ' + dpr + 'dppx)');
      if (!mql) return;
      var off = onMedia(mql, function () {
        off();
        if (destroyed) return;
        watchDpr();
        resizeSource(false);
      });
      cleanups.push(function () { off(); });
    }

    /* ---- loading ---- */
    function reportLoad(f) {
      if (readyFired) return;
      f = clamp(+f || 0, 0, 1);
      if (f <= bestLoad) return;
      bestLoad = f;
      try { onLoadProgress(f); } catch (e) { warn('onLoadProgress threw', e); }
    }
    function fireReady() {
      if (readyFired) return;
      if (bestLoad < 1) reportLoad(1);
      readyFired = true;
      clearTimeout(safetyTimer);
      try { onReady(); } catch (e) { warn('onReady threw', e); }
      readyResolve(sourceName);
    }

    function start() {
      var mode = String(cfg.source || 'auto').toLowerCase();
      var scene = cfg.scene || 'scene2d';
      var scenes = [scene];
      if (scene !== 'scene2d') scenes.push('scene2d');
      var probe = mode === 'scene' ? Promise.resolve(null) : fetchManifest(cfg.manifest || 'film/manifest.json');
      probe.then(function (m) {
        if (destroyed) return;
        if (m) candidates.push({ name: 'frames', manifest: m });
        else if (mode === 'frames') warn('no usable film manifest at ' + (cfg.manifest || 'film/manifest.json') + ', using the procedural scene');
        for (var i = 0; i < scenes.length; i++) candidates.push({ name: scenes[i] });
        tryCandidate(0);
      });
    }

    function tryCandidate(i) {
      if (destroyed) return;
      candidateAt = i;
      if (i >= candidates.length) {
        warn('no film source could start; the page carries on without the film');
        live = false;
        fireReady();
        return;
      }
      var c = candidates[i];
      var before = Array.prototype.slice.call(container.childNodes);
      keepNodes = before;                                  // whatever the page put in the container stays
      var src = null;
      var isLast = i === candidates.length - 1;
      sourceFactory(c.name, map).then(function (factory) {
        if (destroyed) throw new Error('destroyed');
        src = factory({ container: container, manifest: c.manifest, manifestUrl: cfg.manifest });
        if (!src || typeof src.load !== 'function' || typeof src.render !== 'function') throw new Error('not a film source');
        source = src;
        sourceName = c.name;
        var v = viewport();
        lastV = v;
        classPortrait = v.portrait;
        if (src.resize) src.resize(v);
        var job = Promise.resolve(src.load(function (f) { reportLoad(f); }, { progress: targetAt(currentScroll()) }));
        return (c.name === 'frames' || isLast) ? job : withTimeout(job, SCENE_TIMEOUT, c.name);
      }).then(function () {
        if (destroyed || source !== src) return;
        var v = viewport();
        if (!sameV(v, lastV)) resizeSource(false);
        handle.source = sourceName;
        live = true;
        renderErrors = 0;
        target = targetAt(currentScroll());
        p = target;                                        // first frame lands exactly where the page is
        needRender = true;
        draw();
        fireReady();
      }).then(null, function (err) {
        if (destroyed) return;
        warn('source "' + c.name + '" unavailable', err);
        if (source === src) { source = null; sourceName = null; live = false; }
        if (src) { try { if (src.destroy) src.destroy(); } catch (e) {} }
        cleanContainer(before);
        tryCandidate(i + 1);
      });
    }
    function abandon(err) {
      var src = source;
      warn('source "' + sourceName + '" keeps failing, switching', err);
      source = null; sourceName = null; live = false; handle.source = null;
      try { if (src && src.destroy) src.destroy(); } catch (e) {}
      cleanContainer(keepNodes);
      tryCandidate(candidateAt + 1);
    }
    function cleanContainer(keep) {
      if (!container) return;
      var nodes = Array.prototype.slice.call(container.childNodes);
      for (var i = 0; i < nodes.length; i++) {
        if (keep.indexOf(nodes[i]) < 0 && nodes[i].nodeType === 1) container.removeChild(nodes[i]);
      }
    }
    function currentScroll() {
      var s = window.scrollY || window.pageYOffset || 0;
      return lastNow ? lastScroll : s;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(resizeTimer); clearTimeout(safetyTimer); clearTimeout(fadeTimer);
      for (var i = 0; i < cleanups.length; i++) { try { cleanups[i](); } catch (e) {} }
      cleanups = [];
      if (source) { try { if (source.destroy) source.destroy(); } catch (e) {} }
      source = null; live = false;
      if (container) { container.style.opacity = ''; container.style.transition = ''; }
      if (window.__film === handle) handle.source = null;
    }

    /* ---- wiring ---- */
    function listen(target, type, fn, o) {
      target.addEventListener(type, fn, o);
      cleanups.push(function () { target.removeEventListener(type, fn, o); });
    }
    listen(window, 'resize', onWindowResize, { passive: true });
    listen(window, 'orientationchange', onWindowResize, { passive: true });
    listen(window, 'load', scheduleMeasure);
    listen(window, 'pageshow', function () { scheduleMeasure(); needRender = true; });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleMeasure, noop);
    if (typeof ResizeObserver === 'function') {
      try {
        var ro = new ResizeObserver(scheduleMeasure);
        ids.forEach(function (id) { var el = document.getElementById(id); if (el) ro.observe(el); });
        cleanups.push(function () { ro.disconnect(); });
      } catch (e) {}
    }
    watchDpr();
    measure();

    if (!container) {
      /* no film container: the progress mapping still works (the page's progress bar uses it) */
      setTimeout(function () { if (!destroyed) fireReady(); }, 0);
      return player;
    }
    safetyTimer = setTimeout(fireReady, READY_TIMEOUT);
    start();
    return player;
  }

  window.FilmPlayer = { create: create, sources: SCRIPTS };
})();
