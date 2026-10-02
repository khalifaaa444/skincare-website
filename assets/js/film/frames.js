/* Pétale — image-sequence film source ("frames").

   Plays a film made of stills (tools/build-film.sh → film/manifest.json + film/<variant>/f_0001…)
   scrubbed by scroll. What is on screen is always ONE opaque frame, cover-fitted with the
   variant's focusX; there is never a crossfade between two frames.

   Three layers keep the scrub smooth without holding the whole film decoded:
     · bytes  — every frame's compressed file as a Blob, fetched coarse → fine (a dense start, then
                strides 64, 32 … 1) with a bounded number of requests in flight; two of every
                three slots go to the frames just ahead of the cursor in the scroll direction.
     · window — decoded ImageBitmaps around the cursor, requested ahead by as far as the cursor
                will travel while a decode is in flight (measured live), thinned to every k-th
                frame when the scroll outruns the decoders; evicted farthest-first, frames behind
                the scroll direction counting double. Decoding runs in a small pool of workers.
     · grid   — a sparse, small, always-resident set of frames, only for flings faster than the
                decoders, where the eye cannot resolve the step or the sharpness anyway.
   At rest the exact frame for the cursor is decoded and drawn (on phones at full display size,
   while moving a touch smaller to fit the memory line of mobile browsers).

   On touch devices a variant's optional light set (`lite`, the same frames smaller) carries the
   scrub, and only the exact resting frame is fetched from the full-size set.

   Manifest: { version:1, variants:{ desktop:{dir,count,width,height,ext,focusX}, portrait:{…} },
               acts?:[frame index per anchor] }  — dir is relative to the page, frames are
   f_0001.<ext> (1-indexed), acts are 0-based frame indices (a variant may carry its own acts),
   and a variant may add lite:{dir,width,height,ext}. */
(function () {
  'use strict';

  var FS = window.FilmSources = window.FilmSources || {};
  var MB = 1048576;
  var AIR = '#F4E8EE';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function now() { return performance.now(); }
  function pad4(n) { var s = String(n); while (s.length < 4) s = '0' + s; return s; }
  function dims(b) { return b ? [b.width || b.naturalWidth || 0, b.height || b.naturalHeight || 0] : [0, 0]; }
  function bytesOf(b) { var d = dims(b); return d[0] * d[1] * 4; }
  function release(b) {
    if (!b) return;
    if (typeof b.close === 'function') { try { b.close(); } catch (e) {} }
    if (b._blobUrl) { URL.revokeObjectURL(b._blobUrl); b._blobUrl = null; }
  }

  /* ---- decoding ---------------------------------------------------------------------------
     createImageBitmap in blob-URL workers, bitmaps transferred back (no copy). A worker that
     cannot decode (no createImageBitmap, an error event) is dropped and its jobs, like every job
     when no worker is available, are decoded on the main thread instead. */
  var WORKER_CODE = [
    'self.onmessage = function (e) {',
    '  var m = e.data, t0 = performance.now();',
    '  var o = m.w ? { resizeWidth: m.w, resizeHeight: m.h, resizeQuality: m.q || "high" } : null;',
    '  var go = function (sized) { return sized && o ? createImageBitmap(m.blob, o) : createImageBitmap(m.blob); };',
    '  go(true).catch(function () { return go(false); }).then(function (b) {',
    '    self.postMessage({ id: m.id, bmp: b, ms: performance.now() - t0 }, [b]);',
    '  }, function (err) {',
    '    self.postMessage({ id: m.id, err: String((err && err.message) || err) });',
    '  });',
    '};'
  ].join('\n');

  function decodeHere(blob, w, h, q) {
    var t0 = now();
    if (typeof createImageBitmap === 'function') {
      var o = w ? { resizeWidth: w, resizeHeight: h, resizeQuality: q || 'high' } : null;
      var go = function (sized) { return sized && o ? createImageBitmap(blob, o) : createImageBitmap(blob); };
      return go(true).catch(function () { return go(false); })
        .then(function (b) { return { bmp: b, ms: now() - t0 }; });
    }
    return new Promise(function (resolve, reject) {            // very old engines
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { img._blobUrl = url; resolve({ bmp: img, ms: now() - t0 }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  function makePool(size) {
    var workers = [], jobs = new Map(), seq = 0, url = null;
    function spawn() {
      var w = new Worker(url);
      w.load = 0;
      w.onmessage = function (e) {
        var m = e.data, j = jobs.get(m.id);
        if (!j) { if (m.bmp) release(m.bmp); return; }
        jobs.delete(m.id);
        w.load--;
        if (m.err) j.reject(new Error(m.err)); else j.resolve({ bmp: m.bmp, ms: m.ms });
      };
      w.onerror = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        drop(w);
      };
      workers.push(w);
    }
    function drop(w) {
      var at = workers.indexOf(w);
      if (at >= 0) workers.splice(at, 1);
      try { w.terminate(); } catch (e) {}
      jobs.forEach(function (j, id) {
        if (j.worker !== w) return;
        jobs.delete(id);
        decodeHere(j.blob, j.w, j.h, j.q).then(j.resolve, j.reject);
      });
    }
    if (size > 0 && typeof Worker === 'function' && typeof createImageBitmap === 'function') {
      try {
        url = URL.createObjectURL(new Blob([WORKER_CODE], { type: 'text/javascript' }));
        for (var i = 0; i < size; i++) spawn();
      } catch (e) {
        workers.forEach(function (w) { try { w.terminate(); } catch (x) {} });
        workers = [];
      }
    }
    return {
      size: function () { return workers.length; },
      decode: function (blob, w, h, q) {
        if (!workers.length) return decodeHere(blob, w, h, q);
        var best = workers[0];
        for (var i = 1; i < workers.length; i++) if (workers[i].load < best.load) best = workers[i];
        var id = ++seq;
        return new Promise(function (resolve, reject) {
          jobs.set(id, { resolve: resolve, reject: reject, worker: best, blob: blob, w: w, h: h, q: q });
          best.load++;
          try { best.postMessage({ id: id, blob: blob, w: w || 0, h: h || 0, q: q || 'high' }); }
          catch (e) { drop(best); }
        });
      },
      destroy: function () {
        workers.forEach(function (w) { try { w.terminate(); } catch (e) {} });
        workers = [];
        jobs.forEach(function (j) { j.reject(new Error('destroyed')); });
        jobs.clear();
        if (url) { URL.revokeObjectURL(url); url = null; }
      }
    };
  }

  /* ---- manifest ---------------------------------------------------------------------------- */
  function cleanActs(a, n, scale) {
    if (!Array.isArray(a) || a.length < 2) return null;
    var out = [];
    for (var i = 0; i < a.length; i++) {
      var x = +a[i];
      if (!isFinite(x)) return null;
      x = clamp(x * scale, 0, n - 1);
      if (i && x < out[i - 1]) x = out[i - 1];
      out.push(x);
    }
    return out;
  }
  function readVariant(key, v, m) {
    if (!v || typeof v.dir !== 'string') return null;
    var n = Math.floor(+v.count);
    if (!(n >= 1)) return null;
    var ext = String(v.ext || 'webp').replace(/^\./, '');
    var full = { base: folder(v.dir), w: +v.width > 0 ? +v.width : 1920, h: +v.height > 0 ? +v.height : 1080, ext: ext };
    var L = v.lite, lite = null;
    if (L && typeof L.dir === 'string' && +L.width > 0 && +L.height > 0 && +L.width < full.w) {
      lite = { base: folder(L.dir), w: +L.width, h: +L.height, ext: String(L.ext || ext).replace(/^\./, '') };
    }
    var fx = +v.focusX;
    var acts = null;
    if (Array.isArray(v.acts)) acts = cleanActs(v.acts, n, 1);
    else if (Array.isArray(m.acts)) {
      var ref = +m.actsCount;
      acts = cleanActs(m.acts, n, ref > 1 && ref !== n ? (n - 1) / (ref - 1) : 1);
    }
    return { key: key, n: n, w: full.w, h: full.h, full: full, lite: lite, fx: isFinite(fx) ? clamp(fx, 0, 1) : 0.5, acts: acts };
  }
  function folder(dir) {
    if (dir && dir.charAt(dir.length - 1) !== '/') dir += '/';
    try { return new URL(dir, document.baseURI).href; } catch (e) { return dir; }
  }
  function frameUrl(set, i, retry) {
    return set.base + 'f_' + pad4(i + 1) + '.' + set.ext + (retry ? '?r=' + retry : '');
  }
  /* a 200 is not proof of a frame: static hosts answer missing files with their HTML page */
  function fetchBlob(url, priority, signal) {
    var init = { priority: priority };
    if (signal) init.signal = signal;
    return fetch(url, init).then(function (res) {
      var type = res.headers.get('content-type') || '';
      if (!res.ok || /^text\//i.test(type)) throw new Error('not a frame (' + res.status + ' ' + type + ')');
      return res.blob();
    }).then(function (blob) {
      if (!blob || !blob.size) throw new Error('empty frame');
      return blob;
    });
  }

  /* ---- the source -------------------------------------------------------------------------- */
  FS.frames = function createFramesSource(opts) {
    opts = opts || {};
    var container = opts.container, manifest = opts.manifest;
    if (!container) throw new Error('frames: no container');
    if (!manifest || typeof manifest.variants !== 'object' || !manifest.variants) throw new Error('frames: no manifest');

    var variants = {}, keys = [];
    Object.keys(manifest.variants).forEach(function (k) {
      var v = readVariant(k, manifest.variants[k], manifest);
      if (v) { variants[k] = v; keys.push(k); }
    });
    if (!keys.length) throw new Error('frames: the manifest has no usable variant');

    var coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    var lowMem = (navigator.deviceMemory || 8) <= 4;
    var WIN_BUDGET = (coarse ? (lowMem ? 90 : 130) : 600) * MB;   // decoded window
    var GRID_BUDGET = (coarse ? (lowMem ? 24 : 40) : 160) * MB;   // sparse low-res grid
    var GRID_WIDTH = coarse ? 360 : 640;
    var MOVE_SCALE = coarse ? 0.75 : 1;           // window frames on phones; the resting frame is full size
    /* resizing inside createImageBitmap costs about twice the decode itself, so frames are decoded at
       their native size unless the screen needs much less (phones, where memory is the limit) */
    var NATIVE_FROM = coarse ? 0.92 : 0.7;
    var FETCH_MAX = coarse ? 6 : 8, FETCH_URGENT = 4;
    var WORKERS = coarse ? 2 : clamp((navigator.hardwareConcurrency || 4) - 2, 2, 4);
    var DEC_MAX = WORKERS * 2, GRID_MAX = coarse ? 1 : 2;
    var DENSE = 40, START = 24, AHEAD = coarse ? 120 : 200, BEHIND = 24;

    var canvas = document.createElement('canvas');
    canvas.className = 'film-frames';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;background:' + AIR;
    var ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('frames: no 2D canvas');
    container.appendChild(canvas);
    fill();

    var pool = makePool(WORKERS);

    var gen = 0;            // a new reel (variant swap) or destroy: late results of the old one are dropped
    var sizeGen = 0;        // the decode size changed: the decoded window is rebuilt
    var R = null;           // the active reel
    var started = false, destroyed = false, lost = false;

    var lastP = 0, cur = 0, dir = 1, fvel = 0, lastT = 0, moving = false, restTimer = 0, kickRaf = 0;
    var inflight = 0, urgentIn = 0, pumpTurn = 0;
    var win = new Map(), winBytes = 0, pending = new Map(), decBusy = 0, winCap = 24, decodeFails = 0, decodeOk = 0;
    var grid = [], gridK = 1, gridW = 0, gridH = 0, gridQ = [], gridBusy = 0, gridN = 0;
    var rest = { i: -1, bmp: null, want: -1, ctrl: null, dead: {} };
    var winW = 0, winH = 0, restW = 0, restH = 0, winEff = 0, separateRest = false;
    var latMs = 0, decMs = 0;
    var shown = null, shownIdx = -1, shownTier = 'none', everDrawn = false;
    var stats = { draws: 0, moving: 0, exact: 0, near: 0, grid: 0, none: 0, maxOff: 0, offSum: 0, renderMs: 0, renderMax: 0 };
    var loadJob = null, swapJob = null;

    function fill() {
      ctx.globalAlpha = 1;
      ctx.fillStyle = AIR;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    /* ---- reel ---- */
    function chooseKey(portrait) {
      var want = portrait ? 'portrait' : 'desktop', alt = portrait ? 'desktop' : 'portrait';
      return variants[want] ? want : variants[alt] ? alt : keys[0];
    }
    function coarseToFine(n) {
      var seen = new Uint8Array(n), out = [];
      var add = function (i) { if (i >= 0 && i < n && !seen[i]) { seen[i] = 1; out.push(i); } };
      for (var i = 0; i < Math.min(n, DENSE); i++) add(i);
      add(n - 1);
      for (var s = 64; s >= 1; s >>= 1) for (var j = 0; j < n; j += s) add(j);
      return out;
    }
    function mapFrame(p) {
      var n1 = R.n - 1, a = R.v.acts;
      p = clamp(p, 0, 1);
      if (!a) return p * n1;
      var x = p * (a.length - 1), k = Math.min(a.length - 2, Math.floor(x));
      return clamp(a[k] + (a[k + 1] - a[k]) * (x - k), 0, n1);
    }
    function dropDecoded() {
      win.forEach(release); win.clear(); winBytes = 0; pending.clear();
      release(rest.bmp); rest.bmp = null; rest.i = -1; rest.want = -1;
      if (rest.ctrl) { try { rest.ctrl.abort(); } catch (e) {} rest.ctrl = null; }
    }
    function dropGrid() {
      for (var i = 0; i < grid.length; i++) release(grid[i]);
      grid = []; gridN = 0; gridQ.length = 0;
    }
    function abortReel() {
      if (R && R.ctrl) { try { R.ctrl.abort(); } catch (e) {} }
    }
    function startReel(key) {
      gen++;
      abortReel();                                 // requests of the previous reel are not needed any more
      dropDecoded();
      dropGrid();
      var v = variants[key];
      var set = coarse && v.lite ? v.lite : v.full;
      R = {
        key: key, v: v, n: v.n, set: set, lite: set !== v.full,
        ctrl: typeof AbortController === 'function' ? new AbortController() : null,
        blobs: new Array(v.n), st: new Uint8Array(v.n), tries: new Uint8Array(v.n),
        order: coarseToFine(v.n), opos: 0, loaded: 0, dead: 0, bytes: 0, t0: now()
      };
      inflight = 0; urgentIn = 0; decBusy = 0; gridBusy = 0; decodeFails = 0; decodeOk = 0;
      grid = new Array(v.n);
      gridW = Math.min(set.w, GRID_WIDTH);
      gridH = Math.max(1, Math.round(gridW * set.h / set.w));
      gridK = Math.max(1, Math.ceil(v.n * gridW * gridH * 4 / GRID_BUDGET));
      if (gridW >= set.w) { gridW = 0; gridH = 0; }
      rest.dead = {};
      cur = mapFrame(lastP);
      shown = null; shownIdx = -1; shownTier = 'none';
      winEff = 0;
      sizeTiers();
      if (started) pump();
    }

    /* decode sizes follow the canvas: never bigger than what the cover-fit shows, native when close */
    function sizeTiers() {
      var v = R.v, set = R.set, cw = canvas.width, ch = canvas.height;
      var s = Math.min(1, Math.max(cw / v.w, ch / v.h));            // what the cover-fit shows, full-size px
      var dw = Math.round(v.w * s), dh = Math.round(v.h * s);
      var rw = dw >= v.w * NATIVE_FROM ? 0 : dw, rh = rw ? dh : 0;
      var mw = Math.round(dw * (R.lite ? 1 : MOVE_SCALE)), mh = 0;   // a light set is decoded as it is
      if (mw >= set.w * NATIVE_FROM) mw = 0; else mh = Math.round(mw * set.h / set.w);
      var eff = mw || set.w;
      if (winEff && Math.abs(eff - winEff) / winEff < 0.12) return;   // URL-bar jitter: keep what is decoded
      sizeGen++;
      dropDecoded();
      winW = mw; winH = mh; restW = rw; restH = rh; winEff = eff;
      separateRest = R.lite || (rw || v.w) > eff * 1.05;
      var frameBytes = eff * (mh || set.h) * 4;
      winCap = clamp(Math.floor(WIN_BUDGET / frameBytes), 12, 160);
    }

    /* ---- bytes ---- */
    function fetchFrame(i, urgent) {
      if (R.st[i] !== 0) return;
      R.st[i] = 1;
      inflight++;
      if (urgent) urgentIn++;
      var g = gen, reel = R;
      var ok = false;
      fetchBlob(frameUrl(reel.set, i, reel.tries[i]), urgent || i < 6 ? 'high' : 'low', reel.ctrl && reel.ctrl.signal).then(function (blob) {
        if (g !== gen) return;
        reel.blobs[i] = blob; reel.st[i] = 2; reel.loaded++; reel.bytes += blob.size;
        ok = true;
      }).then(null, function () {
        if (g !== gen) return;
        reel.tries[i]++;
        if (reel.tries[i] >= 3) { reel.st[i] = 3; reel.dead++; }
        else { reel.st[i] = 0; reel.order.push(i); }      // back of the queue, with a cache-busting retry
      }).then(function () {
        if (g !== gen || destroyed) return;
        inflight--;
        if (urgent) urgentIn--;
        if (ok) arrived(i);
        checkReady();
        pump();
      });
    }
    function aheadOfCursor() {
      var n = R.n, i0 = clamp(Math.round(cur), 0, n - 1), i, j;
      for (j = 0; j < AHEAD; j++) { i = i0 + dir * j; if (i < 0 || i >= n) break; if (!R.st[i]) return i; }
      for (j = 1; j <= BEHIND; j++) { i = i0 - dir * j; if (i < 0 || i >= n) break; if (!R.st[i]) return i; }
      return -1;
    }
    function nextInOrder() {
      while (R.opos < R.order.length && R.st[R.order[R.opos]]) R.opos++;
      return R.opos < R.order.length ? R.order[R.opos++] : -1;
    }
    function pump() {
      if (!R || destroyed || !started) return;
      while (inflight < FETCH_MAX) {
        var i = (pumpTurn++ % 3 !== 2) ? aheadOfCursor() : -1;
        if (i < 0) i = nextInOrder();
        if (i < 0) i = aheadOfCursor();
        if (i < 0) return;
        fetchFrame(i, false);
      }
    }
    function arrived(i) {
      if (i % gridK === 0) gridQ.push(i);
      kick();
    }

    /* ---- decoded window ---- */
    function want(i) {
      if (i < 0 || i >= R.n) return;
      if (win.has(i) || pending.has(i)) return;
      var st = R.st[i];
      if (st !== 2) {
        if (st === 0 && urgentIn < FETCH_URGENT) fetchFrame(i, true);   // jumps the background queue
        return;
      }
      if (decBusy >= DEC_MAX) return;
      var g = gen, sg = sizeGen, t0 = now(), token = {};
      pending.set(i, token);
      decBusy++;
      pool.decode(R.blobs[i], winW, winH, 'medium').then(function (res) {
        if (g !== gen || sg !== sizeGen || destroyed) { release(res.bmp); return; }
        var el = now() - t0;
        latMs = latMs ? latMs * 0.85 + el * 0.15 : el;
        if (res.ms) decMs = decMs ? decMs * 0.85 + res.ms * 0.15 : res.ms;
        decodeOk++;
        win.set(i, res.bmp);
        winBytes += bytesOf(res.bmp);
        evict();
        kick();
      }, function () {
        if (g !== gen) return;
        decodeFails++;                                 // a file that will not decode is not asked for again
        if (R.st[i] === 2) { R.st[i] = 3; R.blobs[i] = null; R.dead++; }
      }).then(function () {
        if (g !== gen) return;
        decBusy--;
        if (pending.get(i) === token) pending.delete(i);
        if (decodeFails && !decodeOk) checkReady();
      });
    }
    /* the resting frame at full display size: from the bytes already here, or with a light set,
       fetched from the full-size set (the previous request is aborted when the cursor moves on) */
    function wantRest(i) {
      if ((rest.i === i && rest.bmp) || rest.want === i || rest.dead[i]) return;
      var g = gen, sg = sizeGen;
      if (!R.lite) {
        if (R.st[i] !== 2) return;
        rest.want = i;
        decodeRest(R.blobs[i], i, g, sg);
        return;
      }
      if (rest.ctrl) { try { rest.ctrl.abort(); } catch (e) {} }
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      rest.ctrl = ctrl;
      rest.want = i;
      var tries = 0, full = R.v.full;
      (function attempt() {
        fetchBlob(frameUrl(full, i, tries), 'high', ctrl && ctrl.signal).then(function (blob) {
          if (g !== gen || rest.want !== i) return;
          if (rest.ctrl === ctrl) rest.ctrl = null;
          decodeRest(blob, i, g, sg);
        }, function () {
          if (g !== gen || rest.want !== i || (ctrl && ctrl.signal.aborted)) return;
          if (++tries < 3) { attempt(); return; }
          rest.dead[i] = 1;
          rest.want = -1;
        });
      })();
    }
    function decodeRest(blob, i, g, sg) {
      pool.decode(blob, restW, restH, 'high').then(function (res) {
        if (g !== gen || sg !== sizeGen || destroyed || rest.want !== i) { release(res.bmp); return; }
        release(rest.bmp);
        rest.bmp = res.bmp; rest.i = i; rest.want = -1;
        kick();
      }, function () {
        if (g === gen && rest.want === i) { rest.dead[i] = 1; rest.want = -1; }
      });
    }
    /* farthest first; behind the scroll direction counts double */
    function evict() {
      while (win.size > winCap || (winBytes > WIN_BUDGET && win.size > 4)) {
        var worst = -1, wd = -1;
        win.forEach(function (b, k) {
          var d = Math.abs(k - cur);
          if ((k - cur) * dir < 0) d *= 2;
          if (d > wd) { wd = d; worst = k; }
        });
        if (worst < 0) return;
        var b = win.get(worst);
        win.delete(worst);
        winBytes -= bytesOf(b);
        release(b);
      }
    }
    /* the grid is the safety net for flings, so it keeps one decoder slot even while the window is busy */
    function pumpGrid() {
      while (gridQ.length && (gridBusy === 0 || (gridBusy < GRID_MAX && decBusy < DEC_MAX - 1))) {
        var i = gridQ.shift();
        if (grid[i] || R.st[i] !== 2) continue;
        gridBusy++;
        (function (i, g) {
          pool.decode(R.blobs[i], gridW, gridH, 'low').then(function (res) {
            if (g !== gen || destroyed) { release(res.bmp); return; }
            grid[i] = res.bmp; gridN++;
          }, function () {}).then(function () {
            if (g !== gen) return;
            gridBusy--;
            if (gridQ.length) pumpGrid();
          });
        })(i, gen);
      }
    }

    /* which frames to decode next: at rest the exact one (and its neighbours); while moving, the
       stretch the cursor will cover once a decode lands, every k-th frame if the decoders are
       outrun — aligned to multiples of k so the wish list holds still from refresh to refresh */
    function schedule() {
      var n = R.n, i0 = clamp(Math.round(cur), 0, n - 1);
      if (!moving) {
        want(i0);
        if (separateRest) wantRest(i0);
        want(i0 + dir); want(i0 - dir); want(i0 + 2 * dir); want(i0 - 2 * dir);
        return;
      }
      var speed = Math.abs(fvel) * 1000;                            // film frames per second
      var lat = Math.max(8, latMs || 35);                           // ask → have, queue included
      var perSec = Math.max(1, pool.size()) * 1000 / Math.max(3, decMs || lat);
      var stride = Math.max(1, Math.round(speed / (perSec * 0.75)));
      var lead = Math.floor(speed * lat / 1000 * 0.8);
      var reach = Math.min(Math.floor(winCap * 0.6), Math.ceil(speed * (lat + 60) / 1000) + 3);
      if (lead <= 1) want(i0);
      var k = i0 + dir * Math.max(1, lead);
      if (stride > 1) k = dir > 0 ? Math.ceil(k / stride) * stride : Math.floor(k / stride) * stride;
      for (; Math.abs(k - i0) <= lead + reach && k >= 0 && k < n; k += dir * stride) want(k);
      if (lead > 1) want(i0);
      want(i0 - dir);
    }

    /* ---- drawing ---- */
    function nearestGrid(i) {
      if (!gridN) return -1;
      var n = R.n, k0 = Math.round(i / gridK) * gridK;
      for (var r = 0; r <= n + gridK; r += gridK) {
        var a = k0 - r, c = k0 + r;
        if (a >= 0 && a < n && grid[a]) return a;
        if (c >= 0 && c < n && grid[c]) return c;
        if (a < 0 && c >= n) break;
      }
      return -1;
    }
    /* sharp and near beats exact and soft, at every step */
    function pick() {
      var i = clamp(Math.round(cur), 0, R.n - 1), b, d;
      if (!moving && separateRest && rest.i === i && rest.bmp) return { b: rest.bmp, i: i, tier: 'rest' };
      b = win.get(i);
      if (b) return { b: b, i: i, tier: 'win' };
      var tol = moving ? Math.max(1, Math.ceil(Math.abs(fvel) * 16.7 * 1.5)) : 1;
      for (d = 1; d <= tol; d++) {
        b = win.get(i - dir * d); if (b) return { b: b, i: i - dir * d, tier: 'near' };
        b = win.get(i + dir * d); if (b) return { b: b, i: i + dir * d, tier: 'near' };
      }
      var wi = -1, wd = Infinity;
      win.forEach(function (_, k) { var dd = Math.abs(k - i); if (dd < wd) { wd = dd; wi = k; } });
      var gi = nearestGrid(i), gd = gi < 0 ? Infinity : Math.abs(gi - i);
      if (wi >= 0 && (wd <= Math.max(tol, 3) || wd <= gd)) return { b: win.get(wi), i: wi, tier: 'near' };
      if (gi >= 0) return { b: grid[gi], i: gi, tier: 'grid' };
      if (rest.bmp) return { b: rest.bmp, i: rest.i, tier: 'near' };
      return null;
    }
    function blit(b, tier) {
      var d = dims(b), bw = d[0], bh = d[1];
      if (!bw || !bh) return;
      var cw = canvas.width, ch = canvas.height;
      var s = Math.max(cw / bw, ch / bh);
      var dw = Math.ceil(bw * s), dh = Math.ceil(bh * s);
      var dx = Math.round((cw - dw) * R.v.fx), dy = Math.round((ch - dh) / 2);
      if (dx + dw < cw) dx = cw - dw;
      if (dy + dh < ch) dy = ch - dh;
      ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = tier === 'grid' ? 'low' : 'high';
      ctx.drawImage(b, dx, dy, dw, dh);
    }
    function paint(force) {
      if (!R || destroyed) return;
      var sel = pick();
      if (!sel) {
        if (force || !everDrawn) fill();
        if (force) { shown = null; shownIdx = -1; shownTier = 'none'; }
        return;
      }
      if (!force && sel.b === shown) { shownTier = sel.tier; return; }
      if (lost) return;
      blit(sel.b, sel.tier);
      shown = sel.b; shownIdx = sel.i; shownTier = sel.tier; everDrawn = true;
      stats.draws++;
      if (swapJob) { var s = swapJob; swapJob = null; s(); }
      if (loadJob) checkReady();
    }
    function kick() {
      if (kickRaf || destroyed) return;
      kickRaf = requestAnimationFrame(function () {
        kickRaf = 0;
        if (!R || destroyed) return;
        schedule();
        pumpGrid();
        paint(false);
      });
    }
    function settle() {
      if (destroyed) return;
      moving = false;
      fvel = 0;
      kick();
    }
    function count() {
      stats.moving++;
      if (shownIdx < 0) { stats.none++; return; }
      var off = Math.abs(shownIdx - cur);
      if (shownTier === 'grid') stats.grid++;
      else if (shownIdx === Math.round(cur)) stats.exact++;
      else stats.near++;
      if (off > stats.maxOff) stats.maxOff = off;
      stats.offSum += off;
    }

    /* ---- readiness ---- */
    function checkReady() {
      var job = loadJob;
      if (!job || !R) return;
      var need = Math.min(R.n, START), t = now() - job.t0;
      var f = Math.min(R.loaded, need) / need;
      job.report(Math.min(0.97, f * 0.9 + (everDrawn ? 0.07 : 0)));
      var onCursor = everDrawn && shownIdx === clamp(Math.round(cur), 0, R.n - 1);
      if (everDrawn && (onCursor || t > 2500) && (R.loaded >= need || t > 2500)) {
        loadJob = null;
        job.resolve();
        return;
      }
      var hopeless = (R.loaded === 0 && R.dead >= Math.min(R.n, 6)) ||
                     (decodeFails >= 6 && !decodeOk) || R.dead >= R.n;
      if (hopeless) {
        loadJob = null;
        job.reject(new Error('the film frames could not be loaded from ' + R.set.base));
      }
    }

    /* ---- the interface ---- */
    function resize(v) {
      if (destroyed) return;
      v = v || {};
      var dpr = clamp(+v.dpr || 1, 0.5, 2);
      var w = +v.w || container.clientWidth || window.innerWidth || 1;
      var h = +v.h || container.clientHeight || window.innerHeight || 1;
      var cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr));
      var sized = false;
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; sized = true; }
      var key = chooseKey(v.portrait === undefined ? w / h < 0.85 : !!v.portrait);
      var first = !R, swapped = !R || key !== R.key;
      if (swapped) startReel(key); else sizeTiers();
      if (sized || swapped) paint(true);
      if (swapped && !first && started) {
        kick();
        if (swapJob) { var earlier = swapJob; swapJob = null; earlier(); }
        return new Promise(function (resolve) { swapJob = resolve; });
      }
    }
    function load(onProgress, hint) {
      if (destroyed) return Promise.reject(new Error('destroyed'));
      if (!R) resize({ w: container.clientWidth, h: container.clientHeight, dpr: window.devicePixelRatio || 1 });
      if (hint && typeof hint.progress === 'number' && isFinite(hint.progress)) {
        lastP = clamp(hint.progress, 0, 1);
        cur = mapFrame(lastP);
      }
      var best = 0;
      return new Promise(function (resolve, reject) {
        loadJob = {
          t0: now(), resolve: resolve, reject: reject,
          report: function (f) {
            if (f > best && typeof onProgress === 'function') { best = f; try { onProgress(f); } catch (e) {} }
          }
        };
        started = true;
        pump();
        kick();
        setTimeout(checkReady, 2600);
      });
    }
    function render(p, info) {
      if (!R || destroyed) return;
      var t = now();
      lastP = clamp(+p || 0, 0, 1);
      var c = mapFrame(lastP), dc = c - cur, dt = t - lastT;
      lastT = t;
      if (Math.abs(dc) > 1e-3) dir = dc > 0 ? 1 : -1;
      fvel = fvel * 0.5 + (dt > 0 && dt < 250 ? dc / dt : 0) * 0.5;   // frames per ms
      cur = c;
      moving = !!(info && info.moving);
      clearTimeout(restTimer);
      if (moving) restTimer = setTimeout(settle, 150);
      else fvel = 0;
      schedule();
      pumpGrid();
      paint(false);
      if (moving) count();
      var spent = now() - t;
      stats.renderMs = stats.renderMs ? stats.renderMs * 0.95 + spent * 0.05 : spent;
      if (spent > stats.renderMax) stats.renderMax = spent;
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      gen++;
      abortReel();
      clearTimeout(restTimer);
      if (kickRaf) cancelAnimationFrame(kickRaf);
      dropDecoded();
      dropGrid();
      pool.destroy();
      canvas.removeEventListener('contextlost', onLost);
      canvas.removeEventListener('contextrestored', onRestored);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      if (loadJob) { var j = loadJob; loadJob = null; j.reject(new Error('destroyed')); }
      if (swapJob) { var s = swapJob; swapJob = null; s(); }
      R = null;
    }
    function debug() {
      var i0 = R ? clamp(Math.round(cur), 0, R.n - 1) : -1;
      return {
        variant: R ? R.key : null, count: R ? R.n : 0, focusX: R ? R.v.fx : 0, lite: !!(R && R.lite),
        cursor: cur, frame: i0, drawn: shownIdx, tier: shownTier,
        exact: shownIdx === i0 && (shownTier === 'win' || shownTier === 'rest'),
        moving: moving, loaded: R ? R.loaded : 0, dead: R ? R.dead : 0, mb: R ? +(R.bytes / MB).toFixed(1) : 0,
        window: win.size, windowCap: winCap, windowMB: +(winBytes / MB).toFixed(1),
        grid: gridN, gridEvery: gridK, decodeMs: +decMs.toFixed(1), latencyMs: +latMs.toFixed(1),
        workers: pool.size(), canvas: [canvas.width, canvas.height],
        decodeSize: [winW || (R ? R.set.w : 0), winH || (R ? R.set.h : 0)], separateRest: separateRest,
        stats: JSON.parse(JSON.stringify(stats))
      };
    }

    /* at large backing stores GPU context loss is a matter of time: keep the frame coming back */
    function onLost(e) { e.preventDefault(); lost = true; }
    function onRestored() { lost = false; shown = null; paint(true); }
    canvas.addEventListener('contextlost', onLost);
    canvas.addEventListener('contextrestored', onRestored);

    return { load: load, resize: resize, render: render, destroy: destroy, debug: debug, canvas: canvas };
  };
})();
