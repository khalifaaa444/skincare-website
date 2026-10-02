/* Pétale — procedural Canvas2D film: window.FilmSources.scene2d

   The story, scrubbed by p ∈ [0,1]:
     0.00  a closed, plump peony bud with dew; the plum cap of a jar shows in the gap at its heart
     0.25  the petals are open and ruffled, the crystal jar has risen out of the flower, tilted
     0.50  camera in: the jar large, upright and centred, petals soft along the bottom edge
     0.75  the cap lifts straight off and drifts to the upper right while the camera climbs
     1.00  overhead, looking down into a glossy whipped swirl of cream inside the open peony

   How it is drawn: a small 3D world (jar radius = 1 unit) seen by a camera that orbits the jar
   axis in elevation, with framing and depth of field on per-layout keyframe tracks. Every petal
   is a cupped, bent card in 3D — two halves × three segments — and each of those six pieces is
   an exact affine image of a slice of a pre-baked petal sprite, so the art (gradients, veins,
   rim light, ruffles, dew) is painted once and only composited per frame. Each piece is lit by
   overlaying the petal's own silhouette, dark or light, by how its normal meets the key light.
   Sprites are baked in five blur levels (depth of field and mip-mapping) — blurred only while
   baking, never per frame. The jar and the cap are projected cylinders built from ellipse arcs
   and multi-stop gradients; the cream swirl and the lacquer top are baked textures mapped onto
   their projected discs.

   render(p) is pure in p: no clock, nothing carried between frames. Classic script, no deps. */
(function () {
  'use strict';

  var FS = window.FilmSources = window.FilmSources || {};

  var M = Math, PI = M.PI, TAU = PI * 2, DEG = PI / 180;
  var MAX_LONG = 2400;                 // backing-store cap, long side (device px)
  var MAX_AREA = 2400 * 1500;          // … and area
  var CAM_D = 16;                      // camera distance (world units) for the mild perspective

  /* ───────────────────────────── small maths ───────────────────────────── */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function sstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function ease(t) { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = M.imul(t ^ (t >>> 15), t | 1);
      t ^= t + M.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function mixc(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  /* monotone cubic track through [[p, v], …] (Fritsch–Carlson), flat at both ends */
  function track(keys) {
    var n = keys.length, i;
    if (n === 1) { var c0 = keys[0][1]; return function () { return c0; }; }
    var xs = [], ys = [], d = [], m = [];
    for (i = 0; i < n; i++) { xs.push(keys[i][0]); ys.push(keys[i][1]); }
    for (i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    m[0] = 0; m[n - 1] = 0;
    for (i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      var a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { var t = 3 / M.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return function (x) {
      if (!(x > xs[0])) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      var j = 0;
      while (x > xs[j + 1]) j++;
      var h = xs[j + 1] - xs[j], u = (x - xs[j]) / h, u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * ys[j] + (u3 - 2 * u2 + u) * h * m[j] +
             (-2 * u3 + 3 * u2) * ys[j + 1] + (u3 - u2) * h * m[j + 1];
    };
  }

  /* 3-vectors as plain arrays */
  function madd(a, b, s) { return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]; }
  function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function unit(a) { var l = M.sqrt(dot(a, a)) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function rotX(v, a) { var c = M.cos(a), s = M.sin(a); return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]; }
  function rotZ(v, a) { var c = M.cos(a), s = M.sin(a); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]; }

  function mk(w, h) {
    var c = document.createElement('canvas');
    c.width = M.max(1, M.ceil(w)); c.height = M.max(1, M.ceil(h));
    return c;
  }

  /* ───────────────────────────── camera ─────────────────────────────
     World: x right, y up, z toward the camera at elevation 0. The camera orbits the jar axis
     in elevation e and looks at (0, ty, 0), which lands on screen at (ox, oy). */
  function Cam(e, S, ox, oy, ty) {
    this.ce = M.cos(e); this.se = M.sin(e);
    this.S = S; this.ox = ox; this.oy = oy; this.ty = ty;
    this.cd = [0, this.se, this.ce];                 // unit vector toward the camera
  }
  Cam.prototype.pt = function (P) {                  // → [x, y, depth, scale]
    var ry = P[1] - this.ty;
    var up = ry * this.ce - P[2] * this.se, dep = ry * this.se + P[2] * this.ce;
    var f = CAM_D / M.max(1.5, CAM_D - dep), k = this.S * f;
    return [this.ox + P[0] * k, this.oy - up * k, dep, f];
  };
  Cam.prototype.vec = function (V, f) {              // linear part of the projection at scale f
    var k = this.S * f;
    return [V[0] * k, -(V[1] * this.ce - V[2] * this.se) * k];
  };

  /* a circle in 3D (centre C, unit axes U, V, radius r) → screen ellipse E(t) = c + A cos t + B sin t */
  function disc(cam, C, U, V, r) {
    var a = cam.pt(madd(C, U, r)), b = cam.pt(madd(C, U, -r)), c = cam.pt(madd(C, V, r)), d = cam.pt(madd(C, V, -r));
    var E = {
      cx: (a[0] + b[0] + c[0] + d[0]) / 4, cy: (a[1] + b[1] + c[1] + d[1]) / 4,
      ax: (a[0] - b[0]) / 2, ay: (a[1] - b[1]) / 2, bx: (c[0] - d[0]) / 2, by: (c[1] - d[1]) / 2
    };
    var det = E.ax * E.by - E.ay * E.bx, m2 = E.ax * E.ax + E.ay * E.ay + E.bx * E.bx + E.by * E.by;
    if (M.abs(det) < 2e-3 * m2) {                    // edge-on: keep the transform invertible
      var l = M.sqrt(m2) * 0.03, nx = -E.ay, ny = E.ax, nl = M.sqrt(nx * nx + ny * ny) || 1;
      var sg = det < 0 ? -1 : 1;
      E.bx += sg * nx / nl * l; E.by += sg * ny / nl * l;
    }
    return E;
  }
  function ellPt(E, t) { var c = M.cos(t), s = M.sin(t); return [E.cx + E.ax * c + E.bx * s, E.cy + E.ay * c + E.by * s]; }
  function arcE(ctx, E, a0, a1, ccw) {
    ctx.setTransform(E.ax, E.ay, E.bx, E.by, E.cx, E.cy);
    ctx.arc(0, 0, 1, a0, a1, !!ccw);
  }
  function idt(ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); }

  /* silhouette of the solid between two parallel discs: tangent parameters and winding */
  function hull(E0, E1) {
    var dx = E1.cx - E0.cx, dy = E1.cy - E0.cy;
    if (dx * dx + dy * dy < 1e-6) { dx = 0; dy = -1e-3; }
    var t0 = M.atan2(E0.bx * dy - E0.by * dx, E0.ax * dy - E0.ay * dx);
    var t1 = M.atan2(E1.bx * dy - E1.by * dx, E1.ax * dy - E1.ay * dx);
    var mid = t0 + PI / 2;
    var ox = E0.ax * M.cos(mid) + E0.bx * M.sin(mid), oy = E0.ay * M.cos(mid) + E0.by * M.sin(mid);
    var s = (ox * dx + oy * dy) < 0 ? 1 : -1;
    var p0 = ellPt(E0, t0), p1 = ellPt(E1, t1);
    var c0 = (p0[0] - E0.cx) * dy - (p0[1] - E0.cy) * dx, c1 = (p1[0] - E1.cx) * dy - (p1[1] - E1.cy) * dx;
    if (c0 * c1 < 0) t1 += PI;
    var L = p0, R = ellPt(E0, t0 + PI), tl = t0;
    if (L[0] + 0.35 * L[1] > R[0] + 0.35 * R[1]) { var tmp = L; L = R; R = tmp; tl = t0 + PI; }
    return { t0: t0, t1: t1, s: s, L: L, R: R, tl: tl };
  }
  function sidePath(ctx, E0, E1, h) {                // whole silhouette
    arcE(ctx, E0, h.t0, h.t0 + h.s * PI, h.s < 0);
    arcE(ctx, E1, h.t1 + h.s * PI, h.t1 + 2 * h.s * PI, h.s < 0);
    ctx.closePath();
  }
  function bandPath(ctx, E0, E1, h) {                // between E0's outer half and E1's near half
    arcE(ctx, E0, h.t0, h.t0 + h.s * PI, h.s < 0);
    arcE(ctx, E1, h.t1 + h.s * PI, h.t1, h.s > 0);
    ctx.closePath();
  }
  function outerArc(ctx, E, h, t) {                  // the half of E facing away from the solid
    var tt = t == null ? h.t0 : t;
    arcE(ctx, E, tt, tt + h.s * PI, h.s < 0);
  }
  function farArc(ctx, E, h) {                       // the half of a top disc that bounds the silhouette
    arcE(ctx, E, h.t1 + h.s * PI, h.t1 + 2 * h.s * PI, h.s < 0);
  }
  /* part of the outer half, from fraction u0 to u1 measured from the upper-left tangent point */
  function partArc(ctx, E, h, u0, u1) {
    var dir = h.tl === h.t0 ? h.s : -h.s;
    arcE(ctx, E, h.tl + dir * u0 * PI, h.tl + dir * u1 * PI, dir < 0);
  }
  function lin(ctx, a, b, stops) {
    var g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
    for (var i = 0; i < stops.length; i += 2) g.addColorStop(stops[i], stops[i + 1]);
    return g;
  }

  /* ───────────────────────────── palette ───────────────────────────── */
  var TONES = [
    { inn: ['#DC86AE', '#EAA3C2', '#F4C2D6', '#FCE7EF'], out: ['#D99CBE', '#E7AFCB', '#F1C7DA', '#FBE7EF'] },   // pale
    { inn: ['#CF6C9C', '#E18EB5', '#EEAFCA', '#F9D9E6'], out: ['#C986B1', '#DD9DC0', '#EAB7D0', '#F8DDE9'] },   // mid
    { inn: ['#BA4F88', '#D571A2', '#E493B8', '#F4C4D8'], out: ['#B76BA0', '#CE85B2', '#E0A3C4', '#F3CCDD'] }    // deep
  ];
  var LILAC = '205,178,224';

  /* glass, lacquer and gold ramps (positions across a cylinder, upper-left edge → lower-right edge) */
  var GLASS_BACK = [
    0, 'rgba(194,104,150,0.78)', 0.012, 'rgba(224,146,188,0.62)', 0.03, 'rgba(242,196,218,0.42)',
    0.08, 'rgba(234,168,200,0.46)', 0.15, 'rgba(244,206,224,0.26)', 0.5, 'rgba(246,222,232,0.14)',
    0.85, 'rgba(238,188,212,0.3)', 0.92, 'rgba(228,156,194,0.48)', 0.975, 'rgba(218,134,178,0.58)', 1, 'rgba(186,96,142,0.8)'
  ];
  var GLASS_HI = [
    0, 'rgba(255,255,255,0)', 0.012, 'rgba(255,255,255,0.05)', 0.022, 'rgba(255,255,255,0.95)', 0.034, 'rgba(255,255,255,0.1)',
    0.05, 'rgba(255,255,255,0.14)', 0.075, 'rgba(255,250,253,0.55)', 0.105, 'rgba(255,255,255,0.12)',
    0.135, 'rgba(255,255,255,0)', 0.15, 'rgba(255,255,255,0.65)', 0.164, 'rgba(255,255,255,0)',
    0.22, 'rgba(255,255,255,0)', 0.26, 'rgba(255,255,255,0.26)', 0.3, 'rgba(255,255,255,0.08)', 0.33, 'rgba(255,255,255,0)',
    0.78, 'rgba(255,255,255,0)', 0.815, 'rgba(255,255,255,0.14)', 0.836, 'rgba(255,255,255,0.0)',
    0.848, 'rgba(255,255,255,0.5)', 0.862, 'rgba(255,255,255,0)', 0.9, 'rgba(255,255,255,0.1)', 0.925, 'rgba(255,250,253,0.42)',
    0.95, 'rgba(255,255,255,0.05)', 0.97, 'rgba(255,255,255,0.8)', 0.982, 'rgba(255,255,255,0.05)', 1, 'rgba(255,255,255,0)'
  ];
  var CREAM_SIDE = [
    0, 'rgba(214,168,190,0.97)', 0.1, 'rgba(236,208,214,0.98)', 0.27, 'rgba(248,234,232,0.99)', 0.4, 'rgba(251,241,238,0.99)',
    0.62, 'rgba(242,222,224,0.99)', 0.82, 'rgba(226,192,206,0.98)', 1, 'rgba(204,160,186,0.97)'
  ];
  var LACQUER = [
    0, '#150410', 0.02, '#2C0B26', 0.033, '#6A3A62', 0.045, '#ECDDE9', 0.058, '#FCF5FA', 0.072, '#5C2A54',
    0.1, '#2B0B26', 0.2, '#200820', 0.28, '#2C0F28', 0.32, '#5C2F56', 0.36, '#2C0F28', 0.5, '#1C0619',
    0.66, '#230A20', 0.76, '#3A1335', 0.82, '#240A21', 0.88, '#43183D', 0.903, '#E8D6E4', 0.918, '#F6EDF3',
    0.934, '#4A1B44', 0.96, '#230A20', 1, '#130410'
  ];
  var LACQUER_AX = [0, 'rgba(232,140,180,0.24)', 0.28, 'rgba(232,140,180,0.0)', 0.75, 'rgba(255,255,255,0)', 1, 'rgba(255,236,250,0.12)'];
  var GOLD = [
    0, '#6A4C2B', 0.04, '#B38D58', 0.085, '#F7EACD', 0.12, '#E2C496', 0.3, '#C9A571', 0.55, '#A8834E',
    0.8, '#C9A571', 0.9, '#F2DFBA', 0.94, '#B38D58', 1, '#6A4C2B'
  ];
  var NECK = [
    0, 'rgba(206,124,166,0.62)', 0.03, 'rgba(255,255,255,0.85)', 0.06, 'rgba(240,190,212,0.42)', 0.3, 'rgba(250,228,238,0.3)',
    0.7, 'rgba(244,210,226,0.32)', 0.94, 'rgba(234,170,200,0.5)', 0.97, 'rgba(255,255,255,0.75)', 1, 'rgba(200,116,160,0.66)'
  ];

  /* ───────────────────────────── jar & cap dimensions (jar radius = 1) ───────────────────────────── */
  var JAR = {
    H: 1.0, floor: 0.2, rIn: 0.8, rSee: 0.84, creamWall: 0.86, creamTop: 0.95,
    neckR: 0.9, neckH: 1.09, mid: 0.72
  };
  var CAP = { r: 1.02, h: 0.42, band: 0.045, seat: 0.985 };

  /* ───────────────────────────── layout tracks ───────────────────────────── */
  function T(k) { return track(k); }
  var TRACKS = {
    land: {
      e: T([[0, 9], [0.12, 10], [0.28, 21], [0.5, 15], [0.62, 22], [0.75, 38], [0.83, 70], [0.92, 89], [1, 90]]),
      S: T([[0, 0.165], [0.1, 0.2], [0.28, 0.25], [0.45, 0.285], [0.8, 0.285], [0.92, 0.27], [1, 0.218]]),
      ox: T([[0, 0.70], [0.1, 0.715], [0.28, 0.63], [0.45, 0.49], [0.75, 0.49], [0.83, 0.51], [0.93, 0.63], [1, 0.71]]),
      oy: T([[0, 0.56], [0.1, 0.5], [0.28, 0.4], [0.45, 0.53], [0.75, 0.58], [0.85, 0.56], [1, 0.5]]),
      jy: T([[0, 2.2], [0.05, 2.3], [0.16, 2.72], [0.28, 2.85], [0.5, 2.95], [0.75, 2.95], [0.88, 2.5], [1, 2.1]]),
      roll: T([[0, 0], [0.1, 2], [0.27, -9], [0.42, -2], [0.5, 0]]),
      pitch: T([[0, 0], [0.15, 4], [0.27, 12], [0.45, 0]]),
      lift: T([[0.52, 0], [0.64, 0.42], [0.72, 0.8], [0.8, 1.0], [1, 0.9]]),
      cdx: T([[0.6, 0], [0.75, 1.0], [0.85, 1.65], [1, 1.62]]),
      cdy: T([[0.8, 0], [1, -0.6]]),
      cdz: T([[0.65, 0], [0.8, -0.35], [1, -0.72]]),
      croll: T([[0.6, 0], [0.75, -22], [0.86, -42], [1, -36]]),
      cpitch: T([[0.6, 0], [0.75, 12], [0.85, 8], [1, -6]]),
      dof: T([[0, 0.0015], [0.15, 0.004], [0.3, 0.007], [0.5, 0.024], [0.76, 0.024], [0.9, 0.006], [1, 0.0025]])
    },
    port: {
      e: T([[0, 9], [0.12, 9], [0.29, 8], [0.5, 26], [0.62, 30], [0.77, 62], [0.88, 86], [1, 90]]),
      S: T([[0, 0.15], [0.12, 0.2], [0.29, 0.31], [0.5, 0.36], [0.77, 0.37], [0.9, 0.34], [1, 0.32]]),
      ox: T([[0, 0.5], [1, 0.49]]),
      oy: T([[0, 0.6], [0.15, 0.56], [0.29, 0.53], [0.5, 0.66], [0.77, 0.67], [1, 0.62]]),
      jy: T([[0, 2.2], [0.05, 2.3], [0.16, 2.72], [0.28, 2.85], [0.5, 2.95], [0.75, 2.95], [0.88, 2.5], [1, 2.1]]),
      roll: T([[0, 0], [0.1, 2], [0.27, -6], [0.42, -2], [0.5, 0]]),
      pitch: T([[0, 0], [0.15, 3], [0.27, 6], [0.45, 0]]),
      lift: T([[0.52, 0], [0.64, 0.42], [0.72, 0.8], [0.8, 1.0], [1, 0.9]]),
      cdx: T([[0.6, 0], [0.77, 0.85], [1, 1.0]]),
      cdy: T([[0.8, 0], [1, -0.6]]),
      cdz: T([[0.62, 0], [0.77, -0.7], [1, -1.15]]),
      croll: T([[0.6, 0], [0.77, -30], [1, -40]]),
      cpitch: T([[0.6, 0], [0.77, -10], [1, -18]]),
      dof: T([[0, 0.0015], [0.15, 0.004], [0.3, 0.007], [0.5, 0.024], [0.76, 0.024], [0.9, 0.006], [1, 0.0025]])
    }
  };

  /* ───────────────────────────── the flower ─────────────────────────────
     Six whorls. Closed, every petal lies on a bud sphere (centre BUD_Y, radius shrinking inward)
     between two latitudes; open, it springs from the receptacle at angle `a` from vertical and
     curls outward by `rf` per segment. Front petals of the inner whorls part to show the cap. */
  var BUD_Y = 2.35, BUD_R = 2.3;
  var SEG = [0, 0.42, 0.75, 1];                      // segment breaks along the petal (local y)
  var WHORLS = [
    { n: 5, lt: 0, a: 76, rf: 15, L: 3.1, W: 1.34, ro: 0.6, yo: 0.22, tone: 0, t0: 0.00, t1: 0.16, cup: 22 },
    { n: 6, lt: 28, a: 64, rf: 15, L: 2.9, W: 1.24, ro: 0.62, yo: 0.3, tone: 0, t0: 0.02, t1: 0.18, cup: 24 },
    { n: 7, lt: 52, a: 52, rf: 14, L: 2.6, W: 1.12, ro: 0.72, yo: 0.4, tone: 1, t0: 0.04, t1: 0.2, cup: 26 },
    { n: 8, lt: 68, a: 41, rf: 14, L: 2.25, W: 0.98, ro: 0.86, yo: 0.5, tone: 1, t0: 0.06, t1: 0.22, cup: 28 },
    { n: 9, lt: 79, a: 32, rf: 13, L: 1.9, W: 0.84, ro: 1.0, yo: 0.6, tone: 2, t0: 0.08, t1: 0.24, cup: 30 },
    { n: 10, lt: 85, a: 24, rf: 12, L: 1.55, W: 0.7, ro: 1.08, yo: 0.72, tone: 2, t0: 0.1, t1: 0.26, cup: 32 }
  ];
  var NSMOOTH = 2, NSHAPE = 4;                       // shapes 0,1: smooth bud crowns; 2,3: frilly

  function buildFlower(portrait) {
    var R = rng(portrait ? 5519 : 4127), out = [];
    for (var w = 0; w < WHORLS.length; w++) {
      var W = WHORLS[w], step = TAU / W.n;
      var Rw = BUD_R - 0.15 * w, lat0 = -66 + 15 * w;
      for (var k = 0; k < W.n; k++) {
        var th = (k + (w % 2 ? 0.5 : 0) + w * 0.13) * step + (R() - 0.5) * 0.22 * step;
        th = ((th + PI) % TAU + TAU) % TAU - PI;      // −π … π, 0 = facing the camera
        var front = M.cos(th);
        var lt = W.lt + (R() - 0.5) * 8;
        if (w >= 2 && front > 0.72) lt = M.min(lt, 16 + 34 * (1 - front) / 0.28);
        var lats = [lat0, lerp(lat0, lt, 0.4), lerp(lat0, lt, 0.73), lt];
        var cAng = [], cLen = [];
        for (var i = 0; i < 3; i++) {
          cAng.push(-(lats[i] + lats[i + 1]) / 2 * DEG);
          cLen.push(2 * Rw * M.sin((lats[i + 1] - lats[i]) / 2 * DEG));
        }
        var jit = 1 + (R() - 0.5) * 0.12;
        var a = (W.a + (R() - 0.5) * 8) * DEG, rf = W.rf * DEG;
        var L = W.L * jit;
        out.push({
          w: w, th: th,
          cBase: [Rw * M.cos(lat0 * DEG), BUD_Y + Rw * M.sin(lat0 * DEG)],
          oBase: [W.ro + (R() - 0.5) * 0.1, W.yo],
          cAng: cAng, cLen: cLen,
          oAng: [a, a + rf, a + 2 * rf], oLen: [L * 0.42, L * 0.33, L * 0.25],
          cW: W.W * 1.12, oW: W.W * jit,
          cCup: M.min(42, 200 / W.n) * DEG, oCup: W.cup * DEG,
          twist: (R() - 0.5) * 0.25,
          t0: W.t0 + R() * 0.02, t1: W.t1 + R() * 0.02,
          sm: (k + w) % NSMOOTH, fr: NSMOOTH + (k * 3 + w) % (NSHAPE - NSMOOTH), tone: W.tone
        });
      }
    }
    return out;
  }

  /* ───────────────────────────── baking: shared bits ───────────────────────────── */
  var FILTER_OK = null;
  function filterWorks() {
    if (FILTER_OK !== null) return FILTER_OK;
    FILTER_OK = false;
    try {
      var c = mk(24, 24), g = c.getContext('2d');
      if (!('filter' in g)) return false;
      g.filter = 'blur(3px)';
      g.fillStyle = '#000';
      g.fillRect(10, 10, 4, 4);
      g.filter = 'none';
      FILTER_OK = g.getImageData(4, 12, 1, 1).data[3] > 0;
    } catch (e) { FILTER_OK = false; }
    return FILTER_OK;
  }
  /* draw src into g (at x, y, w, h) blurred by sigma px — ctx.filter where it works, otherwise a
     two-pass multi-tap average (Safari has no ctx.filter); only ever used while baking */
  function drawBlurred(g, src, x, y, w, h, sigma) {
    if (sigma < 0.35) { g.drawImage(src, x, y, w, h); return; }
    if (filterWorks()) {
      g.filter = 'blur(' + sigma.toFixed(2) + 'px)';
      g.drawImage(src, x, y, w, h);
      g.filter = 'none';
      return;
    }
    var cw = g.canvas.width, ch = g.canvas.height;
    var tmp = mk(cw, ch), tg = tmp.getContext('2d');
    tg.imageSmoothingQuality = 'high';
    tg.drawImage(src, x, y, w, h);
    var cur = tmp;
    for (var pass = 0; pass < 2; pass++) {
      var nxt = mk(cw, ch), ng = nxt.getContext('2d'), N = 20, r = sigma * 1.3;
      ng.globalCompositeOperation = 'lighter';
      ng.globalAlpha = 1 / (N + 1);
      ng.drawImage(cur, 0, 0);
      for (var i = 0; i < N; i++) {
        var a = i * 2.39996 + pass, rr = r * M.sqrt((i + 0.5) / N);
        ng.drawImage(cur, M.cos(a) * rr, M.sin(a) * rr);
      }
      cur = nxt;
    }
    g.drawImage(cur, 0, 0);
  }

  function bakeNoise(R) {
    var n = 128, c = mk(n, n), g = c.getContext('2d'), img = g.createImageData(n, n), d = img.data;
    for (var i = 0; i < n * n; i++) {
      var v = 128 + (R() - 0.5) * 120 + (R() - 0.5) * 60;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = clamp(v, 0, 255); d[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /* ───────────────────────────── petal sprites ───────────────────────────── */
  function makeShape(R, frilly) {
    var cw = 0.1 + R() * 0.05, wm = 0.93 + R() * 0.07, ym = frilly ? 0.6 + R() * 0.08 : 0.56 + R() * 0.08;
    var n = frilly ? 2.5 + R() * 0.6 : 2.05 + R() * 0.25;
    var A = frilly ? 0.03 + R() * 0.015 : 0.008 + R() * 0.006;
    var fr = [4 + R() * 2, 8 + R() * 3, 15 + R() * 5, 34 + R() * 10], ph = [R() * TAU, R() * TAU, R() * TAU, R() * TAU];
    var am = frilly ? [1, 0.6, 0.38, 0.22] : [1, 0.35, 0.08, 0];
    var notches = [], nn = frilly ? 3 + M.floor(R() * 3) : (R() < 0.5 ? 1 : 0);
    for (var q = 0; q < nn; q++) notches.push({ at: 0.15 + R() * 0.7, w: 0.01 + R() * 0.018, d: (frilly ? 0.04 : 0.02) + R() * 0.05 });
    var asym = (R() - 0.5) * 0.1;
    function ruff(u, weight) {                       // u: 0…1 around the crown
      var r = 0;
      for (var k = 0; k < 4; k++) r += am[k] * M.sin(fr[k] * u * PI + ph[k]);
      r *= A * weight;
      for (var j = 0; j < notches.length; j++) {
        var dd = (u - notches[j].at) / notches[j].w;
        r -= notches[j].d * M.exp(-dd * dd) * weight;
      }
      return r;
    }
    var pts = [], i, N1 = 26, N2 = 170;
    for (i = 0; i <= N1; i++) {                      // right flank, base → shoulder
      var u = i / N1, y = u * ym, x = cw + (wm - cw) * (1 - M.pow(1 - u, 2.4));
      x *= 1 + asym;
      x += ruff(0.0 - (1 - u) * 0.05, sstep(0.45, 1, u) * 0.6) * 0.5;
      pts.push([x, y]);
    }
    for (i = 1; i < N2; i++) {                       // the crown, right → left
      var ph2 = i / N2 * PI, c = M.cos(ph2), s = M.sin(ph2);
      var xx = wm * (c < 0 ? -1 : 1) * M.pow(M.abs(c), 2 / n), yy = ym + (1 - ym) * M.pow(s, 2 / n);
      xx *= c > 0 ? 1 + asym : 1 - asym;
      var rr = ruff(i / N2, 1);
      var nx = xx / wm, ny = (yy - ym) / (1 - ym), nl = M.sqrt(nx * nx + ny * ny) || 1;
      pts.push([xx + nx / nl * rr, yy + ny / nl * rr * 1.1]);
    }
    for (i = N1; i >= 0; i--) {                      // left flank, shoulder → base
      var u2 = i / N1, y2 = u2 * ym, x2 = cw + (wm - cw) * (1 - M.pow(1 - u2, 2.4));
      x2 *= 1 - asym;
      x2 += ruff(1.0 + (1 - u2) * 0.05, sstep(0.45, 1, u2) * 0.6) * 0.5;
      pts.push([-x2, y2]);
    }
    var veins = [], nv = 70;
    for (i = 0; i < nv; i++) {
      var f = (i + R() * 0.8) / nv, ang = (f - 0.5) * PI * 0.92;
      var ex = M.sin(ang) * wm * 0.96, ey = ym + (1 - ym) * M.cos(ang) * 0.95 - 0.02;
      if (M.abs(ex) > wm * 0.85) ey -= 0.1 * (M.abs(ex) - wm * 0.85) / 0.15;
      veins.push({
        x0: (R() - 0.5) * cw * 1.2, y0: 0.01 + R() * 0.04,
        cx: ex * (0.25 + R() * 0.2), cy: ey * (0.5 + R() * 0.15),
        x1: ex * (0.9 + R() * 0.08), y1: ey * (0.9 + R() * 0.08),
        dark: R() < 0.55, a: 0.035 + R() * 0.08, w: 0.0012 + R() * 0.0022
      });
    }
    var creases = [];
    for (i = 0; i < (frilly ? 7 : 4); i++) {
      var cxp = (R() - 0.5) * 1.4;
      creases.push({ x0: cxp * 0.15, x1: cxp * 0.9, bend: (R() - 0.5) * 0.3, light: R() < 0.5, w: 0.025 + R() * 0.06, a: 0.05 + R() * 0.07 });
    }
    var drops = [];
    for (i = 0; i < 30; i++) {
      var edge = R() < 0.6;
      var ua = (R() - 0.5) * PI * 0.9, rad = edge ? 0.86 + R() * 0.08 : 0.2 + R() * 0.6;
      drops.push({
        x: M.sin(ua) * wm * rad, y: ym * 0.6 + (1 - ym * 0.6) * M.cos(ua) * rad + (edge ? 0 : (R() - 0.5) * 0.2),
        r: (edge ? 0.009 : 0.006) + R() * R() * 0.017
      });
    }
    return { pts: pts, veins: veins, creases: creases, drops: drops, ym: ym, wm: wm, frilly: frilly };
  }

  function drawDrop(g, x, y, r) {
    var sx = x + r * 0.3, sy = y + r * 0.42;
    var sg = g.createRadialGradient(sx, sy, 0, sx, sy, r * 1.5);
    sg.addColorStop(0, 'rgba(140,46,100,0.3)'); sg.addColorStop(1, 'rgba(140,46,100,0)');
    g.fillStyle = sg; g.beginPath(); g.arc(sx, sy, r * 1.5, 0, TAU); g.fill();
    var bg = g.createRadialGradient(x - r * 0.2, y - r * 0.25, r * 0.05, x, y, r);
    bg.addColorStop(0, 'rgba(255,246,250,0.3)'); bg.addColorStop(0.6, 'rgba(244,190,214,0.18)');
    bg.addColorStop(0.86, 'rgba(168,70,124,0.5)'); bg.addColorStop(1, 'rgba(168,70,124,0.14)');
    g.fillStyle = bg; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    var cx = x + r * 0.2, cy = y + r * 0.42;
    var cg = g.createRadialGradient(cx, cy, 0, cx, cy, r * 0.55);
    cg.addColorStop(0, 'rgba(255,252,253,0.85)'); cg.addColorStop(1, 'rgba(255,252,253,0)');
    g.fillStyle = cg; g.beginPath(); g.arc(cx, cy, r * 0.55, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.97)';
    g.beginPath(); g.ellipse(x - r * 0.36, y - r * 0.4, r * 0.24, r * 0.16, -0.6, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.beginPath(); g.arc(x + r * 0.32, y - r * 0.06, r * 0.07, 0, TAU); g.fill();
  }

  /* sprite frame: local petal coords (x ∈ [−1,1] across, y ∈ [0,1] base → tip) ↔ sprite px */
  function frame(H0, mgFrac, sc) {
    var mg = mgFrac * H0, kx = 0.4 * H0, ky = H0;
    var W = M.ceil((2 * kx + 2 * mg) * sc), H = M.ceil((ky + 2 * mg) * sc);
    return { W: W, H: H, kx: kx * sc, ky: ky * sc, cx: W / 2, by: H - mg * sc, mg: mg * sc };
  }
  function lvObj(c, F) { return { c: c, kx: F.kx, ky: F.ky, cx: F.cx, by: F.by, W: F.W, H: F.H }; }

  function bakePetal(shape, tone, face, H0, noise) {
    var F = frame(H0, 0.02, 1), c = mk(F.W, F.H), g = c.getContext('2d');
    var pal = TONES[tone][face ? 'out' : 'inn'];
    function X(x) { return F.cx + x * F.kx; }
    function Y(y) { return F.by - y * F.ky; }
    var pts = shape.pts;
    function outline() {
      g.beginPath(); g.moveTo(X(pts[0][0]), Y(pts[0][1]));
      for (var i = 1; i < pts.length; i++) g.lineTo(X(pts[i][0]), Y(pts[i][1]));
      g.closePath();
    }
    function radial(x, y, r, c0, c1) {
      var rg = g.createRadialGradient(X(x), Y(y), 0, X(x), Y(y), r * H0);
      rg.addColorStop(0, c0); rg.addColorStop(1, c1);
      g.fillStyle = rg; g.fillRect(0, 0, F.W, F.H);
    }
    g.save(); outline(); g.clip();
    /* 1 · colour ramp: deep at the claw → pale translucent crown */
    var gr = g.createLinearGradient(0, Y(0), 0, Y(1));
    gr.addColorStop(0, pal[0]); gr.addColorStop(0.3, pal[1]); gr.addColorStop(0.66, pal[2]); gr.addColorStop(0.99, pal[3]);
    g.fillStyle = gr; g.fillRect(0, 0, F.W, F.H);
    /* 2 · cupping across the petal */
    var gx = g.createLinearGradient(X(-1), 0, X(1), 0);
    if (!face) {
      gx.addColorStop(0, 'rgba(255,240,246,0.42)'); gx.addColorStop(0.15, 'rgba(255,240,246,0.1)');
      gx.addColorStop(0.38, 'rgba(186,80,134,0.1)'); gx.addColorStop(0.5, 'rgba(176,70,126,0.2)'); gx.addColorStop(0.62, 'rgba(186,80,134,0.1)');
      gx.addColorStop(0.85, 'rgba(' + LILAC + ',0.14)'); gx.addColorStop(1, 'rgba(255,240,246,0.3)');
    } else {
      gx.addColorStop(0, 'rgba(176,110,180,0.32)'); gx.addColorStop(0.2, 'rgba(255,255,255,0)');
      gx.addColorStop(0.42, 'rgba(255,248,251,0.24)'); gx.addColorStop(0.56, 'rgba(255,248,251,0.2)');
      gx.addColorStop(0.8, 'rgba(255,255,255,0)'); gx.addColorStop(1, 'rgba(160,96,170,0.34)');
    }
    g.fillStyle = gx; g.fillRect(0, 0, F.W, F.H);
    /* 3 · light from the upper left, lilac in the shade */
    radial(-0.5, 0.8, 0.55, 'rgba(255,255,255,0.3)', 'rgba(255,255,255,0)');
    radial(0.6, 0.3, 0.55, 'rgba(' + LILAC + ',0.32)', 'rgba(' + LILAC + ',0)');
    /* 4 · soft creases */
    g.lineCap = 'round';
    for (var ci = 0; ci < shape.creases.length; ci++) {
      var cr = shape.creases[ci];
      g.strokeStyle = cr.light ? 'rgba(255,246,250,' + cr.a + ')' : 'rgba(160,56,112,' + (cr.a * 0.9) + ')';
      g.lineWidth = cr.w * H0;
      g.beginPath(); g.moveTo(X(cr.x0), Y(0.04));
      g.quadraticCurveTo(X((cr.x0 + cr.x1) / 2 + cr.bend), Y(0.5), X(cr.x1), Y(0.97));
      g.stroke();
    }
    /* 5 · fine veins */
    for (var vi = 0; vi < shape.veins.length; vi++) {
      var v = shape.veins[vi];
      var vg = g.createLinearGradient(X(v.x0), Y(v.y0), X(v.x1), Y(v.y1));
      var col = v.dark ? '158,52,108' : '255,250,252';
      var a = v.a * (face ? 1.25 : 1) * (v.dark ? 1 : 1.2);
      vg.addColorStop(0, 'rgba(' + col + ',0)'); vg.addColorStop(0.18, 'rgba(' + col + ',' + a + ')');
      vg.addColorStop(0.75, 'rgba(' + col + ',' + (a * 0.7) + ')'); vg.addColorStop(1, 'rgba(' + col + ',0)');
      g.strokeStyle = vg; g.lineWidth = M.max(0.6, v.w * H0);
      g.beginPath(); g.moveTo(X(v.x0), Y(v.y0)); g.quadraticCurveTo(X(v.cx), Y(v.cy), X(v.x1), Y(v.y1)); g.stroke();
    }
    /* 6 · the claw sits in shade (outer faces: a warm, greenish-cream base like a real bud) */
    radial(0, -0.06, 0.4, 'rgba(128,36,92,0.5)', 'rgba(128,36,92,0)');
    if (face) radial(0, -0.02, 0.24, 'rgba(226,206,168,0.55)', 'rgba(226,206,168,0)');
    else radial(0, 0.1, 0.3, 'rgba(' + LILAC + ',0.2)', 'rgba(' + LILAC + ',0)');
    /* 7 · translucent crown: a soft inner glow along the edge, strongest at the tip */
    var eg = g.createLinearGradient(0, Y(0.35), 0, Y(1));
    eg.addColorStop(0, 'rgba(255,241,246,0)'); eg.addColorStop(1, 'rgba(255,243,248,0.13)');
    g.strokeStyle = eg; g.lineJoin = 'round';
    var ws = [0.16, 0.09, 0.045];
    for (var wi = 0; wi < ws.length; wi++) { g.lineWidth = ws[wi] * H0; outline(); g.stroke(); }
    /* 8 · grain */
    g.globalCompositeOperation = 'overlay'; g.globalAlpha = 0.16;
    g.fillStyle = g.createPattern(noise, 'repeat'); g.fillRect(0, 0, F.W, F.H);
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    /* 9 · rim light along the edge */
    var rl = g.createLinearGradient(X(-1), Y(1), X(1), Y(0.15));
    rl.addColorStop(0, 'rgba(255,255,255,0.75)'); rl.addColorStop(0.55, 'rgba(255,248,251,0.32)'); rl.addColorStop(1, 'rgba(255,248,251,0.08)');
    g.strokeStyle = rl; g.lineWidth = 0.008 * H0; outline(); g.stroke();
    /* 10 · dew */
    var nd = face ? 14 : (shape.frilly ? 6 : 3);
    for (var di = 0; di < nd && di < shape.drops.length; di++) {
      var d = shape.drops[(di * 7 + tone * 3 + face * 11) % shape.drops.length];
      drawDrop(g, X(d.x), Y(d.y), d.r * H0);
    }
    g.restore();
    return lvObj(c, F);
  }

  /* depth-of-field / mip levels: blur sigma as a fraction of the sprite height, and resolution */
  var LEVELS = [{ sig: 0, sc: 1 }, { sig: 0.006, sc: 0.5 }, { sig: 0.016, sc: 0.33 }, { sig: 0.034, sc: 0.21 }, { sig: 0.062, sc: 0.135 }];
  function levelFrame(H0, k) { return frame(H0, 0.02 + 2.7 * LEVELS[k].sig, LEVELS[k].sc); }
  function bakeLevel(base, H0, k) {
    var L = LEVELS[k], F = levelFrame(H0, k);
    var c = mk(F.W, F.H), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    var off = F.mg - 0.02 * H0 * L.sc;
    drawBlurred(g, base.c, off, off, base.W * L.sc, base.H * L.sc, L.sig * H0 * L.sc);
    return lvObj(c, F);
  }
  /* the petal's own silhouette in one flat colour (for per-piece lighting) */
  function bakeSil(lv, col) {
    var c = mk(lv.W, lv.H), g = c.getContext('2d');
    g.drawImage(lv.c, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = col; g.fillRect(0, 0, lv.W, lv.H);
    return { c: c, kx: lv.kx, ky: lv.ky, cx: lv.cx, by: lv.by, W: lv.W, H: lv.H };
  }

  /* ───────────────────────────── cream, cap, glow ───────────────────────────── */
  function bakeCream(T) {
    var c = mk(T, T), g = c.getContext('2d'), img = g.createImageData(T, T), d = img.data;
    var R = T / 2, hgt = new Float32Array(T * T), rid = new Float32Array(T * T), i, j;
    var turns = 2.25;
    for (j = 0; j < T; j++) {
      for (i = 0; i < T; i++) {
        var x = (i + 0.5 - R) / R, y = (j + 0.5 - R) / R, r = M.sqrt(x * x + y * y);
        var th = M.atan2(y, x);
        var warp = 0.07 * M.sin(3 * th + r * 4.0) + 0.045 * M.sin(5 * th - r * 7.0) + 0.03 * M.sin(2 * th + 1.3);
        var s = -th / TAU + r * turns + warp * sstep(0.05, 0.4, r), u = s - M.floor(s);
        var sharp = 0.55 + 0.25 * M.sin(th * 2 + r * 3);
        var ridge = M.pow(M.sin(PI * u), sharp);
        var amp = 0.085 + 0.03 * M.sin(th * 1.5 + r * 5);
        var env = sstep(0.0, 0.26, r) * (1 - 0.45 * sstep(0.8, 1.0, r));
        var h = 0.2 * (1 - r * r) + amp * ridge * env + 0.1 * M.exp(-r * r / 0.0075) + 0.012 * M.sin(th * 9 + r * 20) * env;
        hgt[j * T + i] = h; rid[j * T + i] = ridge * env;
      }
    }
    var Lx = -0.5, Ly = -0.6, Lz = 0.62, ll = M.sqrt(Lx * Lx + Ly * Ly + Lz * Lz);
    Lx /= ll; Ly /= ll; Lz /= ll;
    var Hx = Lx, Hy = Ly, Hz = Lz + 1, hl = M.sqrt(Hx * Hx + Hy * Hy + Hz * Hz);
    Hx /= hl; Hy /= hl; Hz /= hl;
    var CREAM = [253, 248, 247], SHADE = [214, 194, 220], PINK = [240, 190, 208], LIL = [214, 198, 238];
    var ex = R * 1.15;
    for (j = 0; j < T; j++) {
      for (i = 0; i < T; i++) {
        var o = (j * T + i) * 4;
        var xx = (i + 0.5 - R) / R, yy = (j + 0.5 - R) / R, rr = M.sqrt(xx * xx + yy * yy);
        var al = clamp((1 - rr) * R + 0.5, 0, 1);
        if (al <= 0) { d[o + 3] = 0; continue; }
        var iL = i > 0 ? i - 1 : i, iR = i < T - 1 ? i + 1 : i, jU = j > 0 ? j - 1 : j, jD = j < T - 1 ? j + 1 : j;
        var nx = -(hgt[j * T + iR] - hgt[j * T + iL]) * 0.5 * ex, ny = -(hgt[jD * T + i] - hgt[jU * T + i]) * 0.5 * ex;
        var nl = M.sqrt(nx * nx + ny * ny + 1), nz = 1 / nl; nx /= nl; ny /= nl;
        var df = M.max(0, nx * Lx + ny * Ly + nz * Lz);
        var nh = M.max(0, nx * Hx + ny * Hy + nz * Hz);
        var a = 0.48 + 0.52 * df;
        var col = mixc(SHADE, CREAM, a);
        var sh = clamp((1 - nz) * 1.5, 0, 0.4), tt = 0.5 + 0.5 * M.sin(M.atan2(ny, nx) * 2 + rr * 5.5);
        col = mixc(col, mixc(PINK, LIL, tt), sh);
        var ao = 0.92 + 0.08 * rid[j * T + i];
        var wall = 1 - 0.1 * sstep(0.84, 1, rr);
        var k2 = ao * wall;
        col = [col[0] * k2, col[1] * k2, col[2] * k2];
        var sp = M.pow(nh, 46) * 0.7 + M.pow(nh, 10) * 0.16;
        col = mixc(col, [255, 255, 255], clamp(sp, 0, 1));
        d[o] = clamp(col[0], 0, 255); d[o + 1] = clamp(col[1], 0, 255); d[o + 2] = clamp(col[2], 0, 255);
        d[o + 3] = al * 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function bakeCapTop(T) {
    var c = mk(T, T), g = c.getContext('2d'), R = T / 2;
    g.save(); g.beginPath(); g.arc(R, R, R - 0.6, 0, TAU); g.clip();
    var b = g.createLinearGradient(R * 0.2, R * 0.05, R * 1.65, R * 1.95);
    b.addColorStop(0, '#6A3762'); b.addColorStop(0.3, '#43163C'); b.addColorStop(0.65, '#2A0D25'); b.addColorStop(1, '#1D071A');
    g.fillStyle = b; g.fillRect(0, 0, T, T);
    function blob(x, y, rx, ry, rot, col, a0) {
      g.save(); g.translate(x, y); g.rotate(rot); g.scale(1, ry / rx);
      var rg = g.createRadialGradient(0, 0, 0, 0, 0, rx);
      rg.addColorStop(0, 'rgba(' + col + ',' + a0 + ')'); rg.addColorStop(0.55, 'rgba(' + col + ',' + (a0 * 0.45) + ')'); rg.addColorStop(1, 'rgba(' + col + ',0)');
      g.fillStyle = rg; g.beginPath(); g.arc(0, 0, rx, 0, TAU); g.fill(); g.restore();
    }
    blob(R * 0.62, R * 0.58, R * 0.85, R * 0.6, -0.5, '206,170,220', 0.48);       // sky
    blob(R * 0.82, R * 0.3, R * 0.55, R * 0.11, -0.32, '255,248,253', 0.55);      // softbox
    blob(R * 1.25, R * 1.72, R * 0.7, R * 0.22, -0.3, '229,139,176', 0.2);        // petals below
    blob(R * 0.42, R * 1.1, R * 0.25, R * 0.5, 0.4, '190,150,205', 0.1);
    g.restore();
    var rg2 = g.createLinearGradient(R * 0.3, 0, R * 1.7, T);
    rg2.addColorStop(0, 'rgba(255,238,250,0.75)'); rg2.addColorStop(0.45, 'rgba(255,238,250,0.15)'); rg2.addColorStop(1, 'rgba(10,0,8,0.45)');
    g.strokeStyle = rg2; g.lineWidth = T * 0.012;
    g.beginPath(); g.arc(R, R, R - T * 0.008, 0, TAU); g.stroke();
    return c;
  }

  function bakeRadial(T, col, a0) {
    var c = mk(T, T), g = c.getContext('2d'), R = T / 2;
    var rg = g.createRadialGradient(R, R, 0, R, R, R);
    rg.addColorStop(0, 'rgba(' + col + ',' + a0 + ')');
    rg.addColorStop(0.35, 'rgba(' + col + ',' + (a0 * 0.72) + ')');
    rg.addColorStop(0.7, 'rgba(' + col + ',' + (a0 * 0.25) + ')');
    rg.addColorStop(1, 'rgba(' + col + ',0)');
    g.fillStyle = rg; g.fillRect(0, 0, T, T);
    return c;
  }

  /* ───────────────────────────── backdrop & veil (per resize) ───────────────────────────── */
  function bakeBackdrop(W, H, portrait) {
    var c = mk(W, H), g = c.getContext('2d'), mx = M.max(W, H);
    var lg = g.createLinearGradient(0, 0, W * 0.3, H);
    lg.addColorStop(0, '#F7EDF2'); lg.addColorStop(1, '#F1E2EA');
    g.fillStyle = lg; g.fillRect(0, 0, W, H);
    var kx = portrait ? W * 0.25 : W * 0.12, ky = portrait ? H * 0.0 : H * 0.02;
    var k = g.createRadialGradient(kx, ky, 0, kx, ky, mx * 0.95);
    k.addColorStop(0, 'rgba(255,251,253,0.9)'); k.addColorStop(0.45, 'rgba(255,251,253,0.35)'); k.addColorStop(1, 'rgba(255,251,253,0)');
    g.fillStyle = k; g.fillRect(0, 0, W, H);
    var vx = portrait ? W * 0.5 : W * 0.6, vy = portrait ? H * 0.55 : H * 0.48;
    var v = g.createRadialGradient(vx, vy, mx * 0.3, vx, vy, mx * 0.95);
    v.addColorStop(0, 'rgba(232,206,222,0)'); v.addColorStop(1, 'rgba(226,196,214,0.55)');
    g.fillStyle = v; g.fillRect(0, 0, W, H);
    var R = rng(911);
    for (var i = 0; i < 9; i++) {
      var x = portrait ? W * (0.1 + R() * 0.8) : W * (0.42 + R() * 0.56), y = portrait ? H * (0.35 + R() * 0.6) : H * (R() * 0.9);
      var r = H * (0.03 + R() * 0.09), a = 0.05 + R() * 0.1;
      var bg = g.createRadialGradient(x, y, 0, x, y, r);
      var col = R() < 0.5 ? '255,255,255' : '250,226,238';
      bg.addColorStop(0, 'rgba(' + col + ',' + a + ')'); bg.addColorStop(0.7, 'rgba(' + col + ',' + (a * 0.6) + ')'); bg.addColorStop(1, 'rgba(' + col + ',0)');
      g.fillStyle = bg; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    try {                                            // dither the gradients so they never band
      var img = g.getImageData(0, 0, W, H), d = img.data, n = W * H, s = 1234567;
      for (var j = 0; j < n; j++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        var dn = ((s >> 16) & 7) - 3.5;
        var o = j * 4; d[o] += dn; d[o + 1] += dn; d[o + 2] += dn;
      }
      g.putImageData(img, 0, 0);
    } catch (e) { /* unsupported — skip the dither */ }
    return c;
  }
  function bakeVeil(W, H, portrait) {
    var c = mk(W, H), g = c.getContext('2d'), gr;
    if (portrait) {
      gr = g.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, 'rgba(247,238,243,0.62)'); gr.addColorStop(0.24, 'rgba(247,238,243,0.42)');
      gr.addColorStop(0.38, 'rgba(247,238,243,0.12)'); gr.addColorStop(0.48, 'rgba(247,238,243,0)'); gr.addColorStop(1, 'rgba(247,238,243,0)');
    } else {
      gr = g.createLinearGradient(0, 0, W, 0);
      gr.addColorStop(0, 'rgba(247,238,243,0.6)'); gr.addColorStop(0.2, 'rgba(247,238,243,0.42)');
      gr.addColorStop(0.32, 'rgba(247,238,243,0.14)'); gr.addColorStop(0.4, 'rgba(247,238,243,0)'); gr.addColorStop(1, 'rgba(247,238,243,0)');
    }
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    return c;
  }

  /* ───────────────────────────── per-frame: petals ───────────────────────────── */
  var KEY = unit([-0.55, 0.62, 0.56]);               // key light: upper left, toward the camera
  function petalState(pt, p, port) {
    var o = ease((p - pt.t0) / (pt.t1 - pt.t0));
    if (port && pt.w === 0) o = M.max(o, 0.55 + 0.45 * ease(p / 0.16));
    var late = sstep(0.8, 1, p);
    var bx = lerp(pt.cBase[0], pt.oBase[0], o), by = lerp(pt.cBase[1], pt.oBase[1], o);
    var rho = [M.sin(pt.th), 0, M.cos(pt.th)], tau = [M.cos(pt.th), 0, -M.sin(pt.th)];
    var P = [[rho[0] * bx, by, rho[2] * bx]], am = 0;
    for (var i = 0; i < 3; i++) {
      var a = lerp(pt.cAng[i], pt.oAng[i], o) + late * 0.12 * (1 - pt.w / 6);
      var l = lerp(pt.cLen[i], pt.oLen[i], o);
      var sa = M.sin(a), ca = M.cos(a);
      P.push([P[i][0] + rho[0] * sa * l, P[i][1] + ca * l, P[i][2] + rho[2] * sa * l]);
      if (i === 1) am = a;
    }
    var nin = [-rho[0] * M.cos(am), M.sin(am), -rho[2] * M.cos(am)];
    var cup = lerp(pt.cCup, pt.oCup, o), W = lerp(pt.cW, pt.oW, o), tw = pt.twist;
    var cr = M.cos(cup + tw), sr = M.sin(cup + tw), cl = M.cos(cup - tw), sl = M.sin(cup - tw);
    var hr = [(tau[0] * cr + nin[0] * sr) * W, (nin[1] * sr) * W, (tau[2] * cr + nin[2] * sr) * W];
    var hl = [(-tau[0] * cl + nin[0] * sl) * W, (nin[1] * sl) * W, (-tau[2] * cl + nin[2] * sl) * W];
    return { P: P, hr: hr, hl: hl, W: W };
  }

  /* ───────────────────────────── the source ───────────────────────────── */
  FS.scene2d = function create(opts) {
    opts = opts || {};
    var container = opts.container && opts.container.nodeType === 1 ? opts.container : document.body;
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;left:0;top:0;width:100%;height:100%;display:block';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.className = 'film-scene2d';
    container.appendChild(canvas);
    var ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');

    var view = { w: 1, h: 1, dpr: 1, portrait: false }, bw = 1, bh = 1;
    var A = null, loading = null, destroyed = false;
    var flowers = { land: buildFlower(false), port: buildFlower(true) };
    var backdrop = null, veil = null;
    var stats = { bakeMs: 0, renderMs: 0, draws: 0, renders: 0, filter: null };

    /* ---- load: bake the sprites in small slices so the page stays responsive ---- */
    function load(onProgress) {
      if (loading) return loading;
      var report = typeof onProgress === 'function' ? onProgress : function () {};
      loading = new Promise(function (resolve, reject) {
        var t0 = now();
        var scr = window.screen || {};
        var long = M.max(scr.width || 0, scr.height || 0, view.w, view.h) * M.min(2, view.dpr || window.devicePixelRatio || 1);
        var H0 = M.round(clamp(long * 0.3, 300, 560));
        var R = rng(20260);
        var B = { petal: [], sil: [], shapes: [], noise: null, cream: null, cap: null, glow: null, shadow: null, H0: H0 };
        var jobs = [], s, t, f, k;
        jobs.push(function () { B.noise = bakeNoise(R); stats.filter = filterWorks(); });
        jobs.push(function () { for (var q = 0; q < NSHAPE; q++) B.shapes.push(makeShape(R, q >= NSMOOTH)); });
        for (s = 0; s < NSHAPE; s++) {
          B.petal.push([]); B.sil.push([]);
          for (t = 0; t < 3; t++) {
            B.petal[s].push([[], []]);
            for (f = 0; f < 2; f++) {
              (function (s, t, f) {
                jobs.push(function () { B.petal[s][t][f][0] = bakePetal(B.shapes[s], t, f, H0, B.noise); });
                for (var k = 1; k < LEVELS.length; k++) {
                  (function (k) { jobs.push(function () { B.petal[s][t][f][k] = bakeLevel(B.petal[s][t][f][0], H0, k); }); })(k);
                }
              })(s, t, f);
            }
          }
          for (k = 0; k < LEVELS.length; k++) {
            (function (s, k) {
              jobs.push(function () {
                var lv = B.petal[s][1][0][k];
                B.sil[s][k] = { dark: bakeSil(lv, 'rgb(118,44,104)'), light: bakeSil(lv, 'rgb(255,246,250)') };
              });
            })(s, k);
          }
        }
        jobs.push(function () { B.cream = bakeCream(M.round(clamp(long * 0.34, 384, 768))); });
        jobs.push(function () { B.cap = bakeCapTop(512); B.glow = bakeRadial(256, '255,250,252', 1); B.shadow = bakeRadial(128, '112,34,82', 1); });
        var i = 0, n = jobs.length;
        function step() {
          if (destroyed) { reject(new Error('scene2d destroyed')); return; }
          var st = now();
          try {
            while (i < n && now() - st < 20) jobs[i++]();
          } catch (e) { reject(e); return; }
          try { report(i / n); } catch (e) {}
          if (i < n) setTimeout(step, 0);
          else { A = B; stats.bakeMs = now() - t0; resolve(); }
        }
        setTimeout(step, 0);
      });
      return loading;
    }

    /* ---- resize ---- */
    function resize(v) {
      if (destroyed || !v) return;
      var w = M.max(1, M.round(+v.w || 1)), h = M.max(1, M.round(+v.h || 1)), dpr = clamp(+v.dpr || 1, 0.5, 2);
      var W = w * dpr, H = h * dpr;
      var s = M.min(1, MAX_LONG / M.max(W, H), M.sqrt(MAX_AREA / (W * H)));
      W = M.max(1, M.round(W * s)); H = M.max(1, M.round(H * s));
      var portrait = typeof v.portrait === 'boolean' ? v.portrait : w / h < 0.85;
      var changedClass = portrait !== view.portrait || !backdrop;
      view = { w: w, h: h, dpr: dpr, portrait: portrait };
      if (canvas.width !== W || canvas.height !== H || changedClass) {
        canvas.width = W; canvas.height = H;
        bw = W; bh = H;
        backdrop = bakeBackdrop(M.ceil(W / 2), M.ceil(H / 2), portrait);
        veil = bakeVeil(M.ceil(W / 8), M.ceil(H / 8), portrait);
      }
    }

    /* ---- render ---- */
    function render(p) {
      if (destroyed) return;
      var t0 = now();
      p = clamp(+p || 0, 0, 1);
      idt(ctx);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.imageSmoothingEnabled = true;
      if (backdrop) ctx.drawImage(backdrop, 0, 0, bw, bh);
      else { ctx.fillStyle = '#F4E8EE'; ctx.fillRect(0, 0, bw, bh); }
      stats.draws = 0;
      if (A) drawScene(p);
      idt(ctx); ctx.globalAlpha = 1;
      if (veil) ctx.drawImage(veil, 0, 0, bw, bh);
      stats.renderMs = now() - t0;
      stats.renders++;
    }

    function drawScene(p) {
      var port = view.portrait, TR = port ? TRACKS.port : TRACKS.land;
      var unitPx = port ? bw : bh;
      var e = TR.e(p) * DEG, S = TR.S(p) * unitPx;
      var jy = TR.jy(p);
      var ty = lerp(BUD_Y + 0.05, jy + JAR.mid, sstep(0.02, 0.22, p));
      var cam = new Cam(e, S, TR.ox(p) * bw, TR.oy(p) * bh, ty);

      /* jar frame */
      var roll = TR.roll(p) * DEG, pitch = TR.pitch(p) * DEG;
      function jr(v) { return rotZ(rotX(v, pitch), roll); }
      var Nj = jr([0, 1, 0]), Uj = jr([1, 0, 0]), Vj = jr([0, 0, 1]);
      var Jm = [0, jy + JAR.mid, 0], Jb = madd(Jm, Nj, -JAR.mid);

      /* cap frame */
      var lift = TR.lift(p);
      var cr = TR.croll(p) * DEG, cp = TR.cpitch(p) * DEG;
      function crt(v) { return rotZ(rotX(v, cp), cr); }
      var Nc = crt(Nj), Uc = crt(Uj), Vc = crt(Vj);
      var Cc = madd(Jb, Nj, CAP.seat + CAP.h / 2 + lift);
      Cc = vadd(Cc, [TR.cdx(p), TR.cdy(p), TR.cdz(p)]);
      var Cb = madd(Cc, Nc, -CAP.h / 2);
      var capOff = lift > 0.004 || M.abs(cr) > 0.002;

      /* glow behind the subject */
      var jc = cam.pt(Jm);
      var gr = S * 3.4 * jc[3];
      ctx.globalAlpha = 0.5;
      ctx.drawImage(A.glow, jc[0] - gr, jc[1] - gr * 0.9, gr * 2, gr * 1.8);
      ctx.globalAlpha = 1;

      if (p < 0.3) drawStem(cam, S);

      /* petals and the jar, back to front */
      var fl = port ? flowers.port : flowers.land, items = [], dof = TR.dof(p);
      var frill = sstep(0.56, 0.78, p);
      for (var i = 0; i < fl.length; i++) {
        var st = petalState(fl[i], p, port), P = st.P;
        var cpt = cam.pt([(P[0][0] + P[1][0] + P[2][0] + P[3][0]) / 4, (P[0][1] + P[1][1] + P[2][1] + P[3][1]) / 4,
                          (P[0][2] + P[1][2] + P[2][2] + P[3][2]) / 4]);
        items.push({ kind: 0, d: cpt[2], pt: fl[i], st: st, f: cpt[3], blur: dof * M.abs(cpt[2]) * S * cpt[3], frill: frill });
      }
      items.push({ kind: 1, d: jc[2] });
      items.sort(function (a, b) { return a.d - b.d; });
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        if (it.kind === 0) drawPetal(cam, it);
        else {
          if (e > 50 * DEG) drawShadow(cam, Jb, Uj, Vj, sstep(50, 85, e / DEG) * 0.55, 1.28);
          drawJar(cam, Jb, Uj, Vj, Nj, S, capOff);
          if (capOff && p > 0.85) drawShadow(cam, madd(Cb, [0, -0.2, 0], 1), Uc, Vc, sstep(0.85, 1, p) * 0.35, 1.25);
          drawCap(cam, Cb, Uc, Vc, Nc, S);
        }
      }
    }

    function drawStem(cam, S) {
      var a = cam.pt([0, 0.3, 0]), b = cam.pt([0, -9, 0]);
      var w0 = 0.15 * S * a[3], w1 = 0.12 * S * b[3];
      var dx = b[0] - a[0], dy = b[1] - a[1], l = M.sqrt(dx * dx + dy * dy) || 1, nx = -dy / l, ny = dx / l;
      ctx.beginPath();
      ctx.moveTo(a[0] + nx * w0, a[1] + ny * w0); ctx.lineTo(b[0] + nx * w1, b[1] + ny * w1);
      ctx.lineTo(b[0] - nx * w1, b[1] - ny * w1); ctx.lineTo(a[0] - nx * w0, a[1] - ny * w0); ctx.closePath();
      ctx.fillStyle = lin(ctx, [a[0] - nx * w0, a[1] - ny * w0], [a[0] + nx * w0, a[1] + ny * w0],
        [0, '#6F6639', 0.3, '#A69A62', 0.5, '#C2B47C', 0.75, '#8E8350', 1, '#5F5730']);
      ctx.fill();
      ctx.fillStyle = lin(ctx, [a[0], a[1]], [a[0], a[1] + 0.6 * S], [0, 'rgba(110,36,84,0.4)', 1, 'rgba(110,36,84,0)']);
      ctx.fill();
    }

    function drawShadow(cam, B, U, V, alpha, scale) {
      if (alpha <= 0.01) return;
      var E = disc(cam, madd(B, [0.14, 0, 0.12], 1), U, V, scale);
      ctx.setTransform(E.ax, E.ay, E.bx, E.by, E.cx, E.cy);
      ctx.globalAlpha = alpha;
      ctx.drawImage(A.shadow, -1, -1, 2, 2);
      ctx.globalAlpha = 1; idt(ctx);
    }

    /* one petal: two cupped halves × three bent segments, each an affine slice of the sprite,
       then lit by overlaying its silhouette (dark where it turns from the key light) */
    var quads = [];
    function drawPetal(cam, it) {
      var st = it.st, pt = it.pt, f = it.f, P = st.P;
      var Q = [cam.pt(P[0]), cam.pt(P[1]), cam.pt(P[2]), cam.pt(P[3])];
      var XR = cam.vec(st.hr, f), XLn = cam.vec(st.hl, f), XL = [-XLn[0], -XLn[1]];
      var H0 = A.H0;
      var m = st.W * cam.S * f / (0.4 * H0);         // screen px per level-0 sprite px
      var sigFrac = it.blur / M.max(0.05, m) / H0;
      var lvf = 0;
      for (var k = 1; k < LEVELS.length; k++) {
        if (sigFrac >= LEVELS[k].sig) lvf = k;
        else { lvf = k - 1 + (sigFrac - LEVELS[k - 1].sig) / (LEVELS[k].sig - LEVELS[k - 1].sig); break; }
      }
      var mip = 0;
      if (m < 0.62) mip = clamp((0.62 - m) / 0.12, 0, 1);
      if (m < 0.3) mip = 1 + clamp((0.3 - m) / 0.08, 0, 1);
      lvf = clamp(M.max(lvf, mip), 0, LEVELS.length - 1);
      var l0 = M.floor(lvf), l1 = M.min(LEVELS.length - 1, l0 + 1), ft = lvf - l0;
      ft = ft < 0.08 ? 0 : ft > 0.92 ? 1 : (ft - 0.08) / 0.84;
      var fw = it.frill, shA = pt.sm, shB = pt.fr;
      var setA = A.petal[shA][pt.tone], setB = A.petal[shB][pt.tone];
      var silS = fw < 0.5 ? A.sil[shA] : A.sil[shB];
      var lvS = ft < 0.5 ? l0 : l1;

      quads.length = 0;
      for (var s = 0; s < 3; s++) {
        var dy = SEG[s + 1] - SEG[s];
        var Y = [(Q[s + 1][0] - Q[s][0]) / dy, (Q[s + 1][1] - Q[s][1]) / dy];
        var Od = [Q[s][0] - SEG[s] * Y[0], Q[s][1] - SEG[s] * Y[1]];
        var sd = (Q[s][2] + Q[s + 1][2]) / 2;
        var spine = vsub(P[s + 1], P[s]);
        for (var hs = 0; hs < 2; hs++) {
          var X = hs ? XR : XL, h3 = hs ? st.hr : st.hl;
          var det = X[0] * Y[1] - X[1] * Y[0];
          var n = unit(cross(spine, h3));
          if (dot(n, cam.cd) < 0) n = [-n[0], -n[1], -n[2]];
          var lum = dot(n, KEY);
          var shade = lum >= 0 ? (1 - lum) * 0.34 : 0.34 + lum * 0.1;
          var light = lum > 0.72 ? (lum - 0.72) * 0.55 : 0;
          quads.push({ s: s, side: hs ? 1 : -1, X: X, Y: Y, O: Od, face: det < 0 ? 1 : 0, d: sd + dot(h3, cam.cd) * 0.35,
                       shade: shade, light: light });
        }
      }
      quads.sort(function (a, b) { return a.d - b.d; });
      for (var qi = 0; qi < quads.length; qi++) {
        var q = quads[qi];
        if (fw < 1) drawLevels(setA[q.face], q, l0, l1, ft, 1 - fw);
        if (fw > 0) drawLevels(setB[q.face], q, l0, l1, ft, fw);
        if (q.shade > 0.02) slice(silS[lvS].dark, q, q.shade);
        if (q.light > 0.02) slice(silS[lvS].light, q, q.light);
      }
      ctx.globalAlpha = 1;
    }
    function drawLevels(lvls, q, l0, l1, ft, a) {
      if (ft < 1) slice(lvls[l0], q, a * (ft > 0 ? 1 - ft : 1));
      if (ft > 0) slice(lvls[l1], q, a * ft);
    }
    function slice(lv, q, alpha) {
      if (!lv || alpha <= 0.004) return;
      var X = q.X, Y = q.Y, O = q.O;
      var a = X[0] / lv.kx, b = X[1] / lv.kx, c = -Y[0] / lv.ky, d = -Y[1] / lv.ky;
      var e = O[0] - lv.cx * a + lv.by * (Y[0] / lv.ky), f = O[1] - lv.cx * b + lv.by * (Y[1] / lv.ky);
      var ov = 0.8;
      var sx0 = q.side > 0 ? lv.cx - ov : 0, sx1 = q.side > 0 ? lv.W : lv.cx + ov;
      var py0 = q.s === 2 ? 0 : lv.by - SEG[q.s + 1] * lv.ky - ov;
      var py1 = q.s === 0 ? lv.H : lv.by - SEG[q.s] * lv.ky + ov;
      if (py1 - py0 < 0.5 || sx1 - sx0 < 0.5) return;
      ctx.setTransform(a, b, c, d, e, f);
      ctx.globalAlpha = alpha > 1 ? 1 : alpha;
      ctx.drawImage(lv.c, sx0, py0, sx1 - sx0, py1 - py0, sx0, py0, sx1 - sx0, py1 - py0);
      stats.draws++;
    }

    /* the crystal jar */
    function drawJar(cam, B, U, V, N, S, open) {
      function D(ly, r) { return disc(cam, madd(B, N, ly), U, V, r); }
      var lw = M.max(1, S * 0.006);
      var E0 = D(0, 1), E1 = D(JAR.H, 1), h = hull(E0, E1);
      /* 1 · the glass seen through: pink-tinted, deeper at the grazing edges */
      ctx.beginPath(); sidePath(ctx, E0, E1, h); idt(ctx);
      ctx.fillStyle = lin(ctx, h.L, h.R, GLASS_BACK); ctx.fill();
      /* 2 · cream inside, seen through the wall */
      var C0 = D(JAR.floor + 0.04, JAR.rSee), C1 = D(JAR.creamWall, JAR.rSee), hc = hull(C0, C1);
      ctx.beginPath(); bandPath(ctx, C0, C1, hc); idt(ctx);
      ctx.fillStyle = lin(ctx, h.L, h.R, CREAM_SIDE); ctx.fill();
      ctx.fillStyle = lin(ctx, [C0.cx, C0.cy + M.abs(C0.by)], [C1.cx, C1.cy],
        [0, 'rgba(190,118,158,0.45)', 0.3, 'rgba(214,160,190,0.12)', 0.75, 'rgba(255,255,255,0)', 1, 'rgba(255,250,250,0.3)']);
      ctx.fill();
      /* 3 · thick base, pink with refracted petals */
      var Ef = D(JAR.floor, 1), hb = hull(E0, Ef);
      ctx.beginPath(); bandPath(ctx, E0, Ef, hb); idt(ctx);
      ctx.fillStyle = lin(ctx, [E0.cx, E0.cy], [Ef.cx, Ef.cy], [0, 'rgba(226,132,178,0.46)', 0.55, 'rgba(240,180,208,0.26)', 1, 'rgba(250,214,230,0.14)']);
      ctx.fill();
      /* 4 · refraction highlights on the wall */
      ctx.beginPath(); sidePath(ctx, E0, E1, h); idt(ctx);
      ctx.fillStyle = lin(ctx, h.L, h.R, GLASS_HI); ctx.fill();
      /* 5 · base edges: bright bottom rim, cavity floor, a couple of glints */
      ctx.lineCap = 'round';
      ctx.beginPath(); outerArc(ctx, D(0.012, 0.995), h); idt(ctx);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = lw * 1.5; ctx.stroke();
      ctx.beginPath(); outerArc(ctx, D(0.05, 0.99), h); idt(ctx);
      ctx.strokeStyle = 'rgba(190,96,146,0.36)'; ctx.lineWidth = lw * 1.3; ctx.stroke();
      var Fl = D(JAR.floor + 0.04, JAR.rSee);
      ctx.beginPath(); outerArc(ctx, Fl, hull(Fl, C1)); idt(ctx);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = lw * 1.1; ctx.stroke();
      ctx.beginPath(); outerArc(ctx, D(JAR.floor - 0.03, 0.9), h); idt(ctx);
      ctx.strokeStyle = 'rgba(206,116,162,0.3)'; ctx.lineWidth = lw * 2.4; ctx.stroke();
      ctx.beginPath(); partArc(ctx, D(0.1, 0.97), h, 0.12, 0.32); idt(ctx);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = lw; ctx.stroke();
      ctx.beginPath(); partArc(ctx, D(0.13, 0.95), h, 0.62, 0.86); idt(ctx);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = lw * 0.8; ctx.stroke();
      /* the lip of the inner cup, just under the cap */
      var Lp = D(JAR.H - 0.04, JAR.rSee);
      ctx.beginPath(); outerArc(ctx, Lp, hull(Lp, E1)); idt(ctx);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = lw; ctx.stroke();

      if (!open) return;
      /* 6 · shoulder, neck, rim and the cream surface */
      var Es = D(JAR.H, 1), En = D(JAR.H, JAR.neckR);
      ctx.beginPath(); arcE(ctx, Es, 0, TAU); arcE(ctx, En, TAU, 0, true); idt(ctx);
      ctx.fillStyle = lin(ctx, h.L, h.R, [0, 'rgba(228,150,192,0.75)', 0.2, 'rgba(252,232,242,0.62)', 0.5, 'rgba(248,218,232,0.5)', 0.85, 'rgba(238,184,210,0.62)', 1, 'rgba(214,128,172,0.75)']);
      ctx.fill();
      var Nk = D(JAR.neckH, JAR.neckR), hn = hull(En, Nk);
      ctx.beginPath(); sidePath(ctx, En, Nk, hn); idt(ctx);
      ctx.fillStyle = lin(ctx, hn.L, hn.R, NECK); ctx.fill();
      ctx.beginPath(); outerArc(ctx, D(JAR.H + 0.035, JAR.neckR), hn); idt(ctx);
      ctx.strokeStyle = 'rgba(255,255,255,0.42)'; ctx.lineWidth = lw * 0.8; ctx.stroke();
      ctx.beginPath(); outerArc(ctx, D(JAR.H + 0.065, JAR.neckR), hn); idt(ctx);
      ctx.strokeStyle = 'rgba(196,112,156,0.28)'; ctx.lineWidth = lw * 0.8; ctx.stroke();
      var O = D(JAR.neckH, JAR.rIn);
      ctx.beginPath(); arcE(ctx, Nk, 0, TAU); arcE(ctx, O, TAU, 0, true); idt(ctx);
      ctx.fillStyle = lin(ctx, hn.L, hn.R, [0, 'rgba(236,176,206,0.88)', 0.25, 'rgba(255,246,250,0.88)', 0.55, 'rgba(250,226,238,0.84)', 1, 'rgba(226,152,192,0.88)']);
      ctx.fill();
      /* inside the opening: the back wall, then the swirl */
      ctx.save();
      ctx.beginPath(); arcE(ctx, O, 0, TAU); idt(ctx); ctx.clip();
      ctx.fillStyle = lin(ctx, [O.cx, O.cy - M.abs(O.by)], [O.cx, O.cy + M.abs(O.by)], [0, 'rgba(236,190,212,0.92)', 0.5, 'rgba(224,166,196,0.92)', 1, 'rgba(210,146,182,0.92)']);
      ctx.fillRect(0, 0, bw, bh);
      var Cr = D(JAR.creamTop, JAR.rIn);
      ctx.setTransform(Cr.ax, Cr.ay, Cr.bx, Cr.by, Cr.cx, Cr.cy);
      ctx.drawImage(A.cream, -1, -1, 2, 2);
      idt(ctx);
      ctx.beginPath(); farArc(ctx, Cr, hull(Cr, O)); idt(ctx);
      ctx.strokeStyle = 'rgba(160,90,130,0.18)'; ctx.lineWidth = lw * 2; ctx.stroke();
      ctx.restore();
      /* glints */
      ctx.beginPath(); farArc(ctx, Es, h); idt(ctx);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = lw; ctx.stroke();
      ctx.beginPath(); outerArc(ctx, Nk, hn); idt(ctx);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = lw; ctx.stroke();
      ctx.beginPath(); partArc(ctx, O, hn, 0.06, 0.4); idt(ctx);
      ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = lw * 0.9; ctx.stroke();
    }

    /* the plum lacquer cap, wherever it is */
    function drawCap(cam, B, U, V, N, S) {
      var E0 = disc(cam, B, U, V, CAP.r), Eb = disc(cam, madd(B, N, CAP.band), U, V, CAP.r), E1 = disc(cam, madd(B, N, CAP.h), U, V, CAP.r);
      var h = hull(E0, E1), lw = M.max(1, S * 0.006);
      var up = dot(N, cam.cd) >= 0;
      ctx.beginPath(); sidePath(ctx, E0, E1, h); idt(ctx);
      ctx.fillStyle = lin(ctx, h.L, h.R, LACQUER); ctx.fill();
      ctx.fillStyle = lin(ctx, [E0.cx, E0.cy], [E1.cx, E1.cy], LACQUER_AX); ctx.fill();
      var hb = hull(E0, Eb);
      ctx.beginPath(); bandPath(ctx, E0, Eb, hb); idt(ctx);
      ctx.fillStyle = lin(ctx, h.L, h.R, GOLD); ctx.fill();
      ctx.beginPath(); outerArc(ctx, E0, hb); idt(ctx);
      ctx.strokeStyle = 'rgba(255,240,214,0.5)'; ctx.lineWidth = lw * 0.7; ctx.stroke();
      if (up) {
        ctx.setTransform(E1.ax, E1.ay, E1.bx, E1.by, E1.cx, E1.cy);
        ctx.drawImage(A.cap, -1, -1, 2, 2);
        idt(ctx);
        ctx.beginPath(); farArc(ctx, E1, h); idt(ctx);
        ctx.strokeStyle = 'rgba(255,236,248,0.45)'; ctx.lineWidth = lw * 0.9; ctx.stroke();
      } else {
        ctx.beginPath(); arcE(ctx, E0, 0, TAU); idt(ctx);
        ctx.fillStyle = '#1C0818'; ctx.fill();
        var Ei = disc(cam, madd(B, N, 0.02), U, V, CAP.r * 0.86);
        ctx.beginPath(); arcE(ctx, Ei, 0, TAU); idt(ctx);
        ctx.strokeStyle = 'rgba(217,185,138,0.5)'; ctx.lineWidth = lw * 1.5; ctx.stroke();
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      function free(c) { if (c) { c.width = 0; c.height = 0; } }
      if (A) {
        A.petal.forEach(function (s) { s.forEach(function (t) { t.forEach(function (f) { f.forEach(function (lv) { if (lv) free(lv.c); }); }); }); });
        A.sil.forEach(function (s) { s.forEach(function (l) { if (l) { free(l.dark.c); free(l.light.c); } }); });
        [A.cream, A.cap, A.glow, A.shadow, A.noise].forEach(free);
      }
      free(backdrop); free(veil);
      A = null; backdrop = null; veil = null;
      canvas.width = canvas.height = 0;
    }

    return {
      load: load,
      resize: resize,
      render: render,
      destroy: destroy,
      debug: function () {
        return { bakeMs: stats.bakeMs, renderMs: stats.renderMs, draws: stats.draws, renders: stats.renders,
                 backing: [bw, bh], view: view, filter: stats.filter, sprite: A ? A.H0 : 0 };
      }
    };
  };
})();
