/* ═══ Pétale — the bag and the demo checkout (window.Cart) ════════════════════════════
   A classic script with no dependencies. It reads window.SITE (config.js) and builds:
   · a round bag button in every [data-cart-button] slot, with a count badge
   · a glass bag that slides in from the right (lines, quantities, free-shipping hint)
   · a three-step checkout dialog: Bag ✓ · Delivery · Payment, with a 3D card that mirrors
     what you type, flips for the CVC, flies to the centre while the payment "processes",
     then turns into a confirmation.

   DEMO ONLY. There is not one network request in this file. The card inputs have no
   name attributes, are never stored, and are wiped when the dialog closes. The only thing
   kept is the bag itself — sku and quantity — in localStorage.

   Hooks (see CONTRACT): [data-add-to-bag="sku"] anywhere on the page adds one; the clicked
   element gets .is-added for ~1.6 s. document receives `cart:change` {count, subtotal}.
   ═════════════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  if (window.Cart && window.Cart.__petale) return;          // loaded twice: keep the first

  var doc = document;
  var root = doc.documentElement;
  var SITE = window.SITE || {};
  var CUR = SITE.currency || {};
  var LOCALE = CUR.locale || 'en-US';
  var CODE = CUR.code || 'USD';
  var BRAND = SITE.brand || 'Shop';
  var LOGO = SITE.logo || String(BRAND).toUpperCase();
  var FREE_FROM = isFinite(+SITE.freeShippingFrom) && SITE.freeShippingFrom !== null ? +SITE.freeShippingFrom : Infinity;
  var STD_FEE = isFinite(+SITE.standardFee) ? +SITE.standardFee : 0;
  var MAX_QTY = 10;
  var KEY = 'bag:' + slug(BRAND) + ':v1';

  var CATALOG = {};
  (Array.isArray(SITE.products) ? SITE.products : []).forEach(function (p) {
    if (p && p.sku != null) CATALOG[String(p.sku)] = p;
  });
  var SHIPPING = Array.isArray(SITE.shipping) && SITE.shipping.length ? SITE.shipping
    : [{ id: 'standard', label: 'Standard delivery', detail: '', price: 0 }];
  var HAS_STD = SHIPPING.some(function (s) { return s.id === 'standard'; });

  var COUNTRIES = [
    ['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['IE', 'Ireland'], ['FR', 'France'],
    ['DE', 'Germany'], ['IT', 'Italy'], ['ES', 'Spain'], ['NL', 'Netherlands'], ['SE', 'Sweden'],
    ['CH', 'Switzerland'], ['AU', 'Australia'], ['NZ', 'New Zealand'], ['JP', 'Japan'], ['SG', 'Singapore'],
    ['AE', 'United Arab Emirates']
  ];
  var SAMPLE = { email: 'ava.bloom@example.com', name: 'Ava Bloom', address: '212 Magnolia Street', city: 'Savannah', zip: '31401', country: 'US' };
  var TEST_CARD = { number: '4242 4242 4242 4242', exp: '12/34', cvc: '123' };

  var mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  var mqFine = matchMedia('(hover: hover) and (pointer: fine)');
  var mqCoarse = matchMedia('(pointer: coarse)');
  function reduced() { return mqReduce.matches; }

  /* ── small helpers ───────────────────────────────────────────────────────────────── */
  function slug(s) { return String(s).normalize ? String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') : String(s).toLowerCase(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(sel, r) { return (r || doc).querySelector(sel); }
  function $$(sel, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(sel)); }
  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function raf2(fn) { requestAnimationFrame(function () { requestAnimationFrame(fn); }); }
  function focusEl(el) { if (!el) return; try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }
  function visible(el) { return !!(el && el.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'); }
  var fmt = {};
  function money(n) {
    n = Math.round((+n || 0) * 100) / 100;
    var dp = n % 1 === 0 ? 0 : 2;
    if (fmt[dp] === undefined) {
      try { fmt[dp] = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CODE, minimumFractionDigits: dp, maximumFractionDigits: dp }); }
      catch (e) { fmt[dp] = null; }
    }
    return fmt[dp] ? fmt[dp].format(n) : (CUR.symbol || '$') + n.toFixed(dp);
  }
  function plural(n) { return n + (n === 1 ? ' item' : ' items'); }
  /* will-change only while something moves: set it, drop it when the transition ends */
  function moving(el, ms, props) {
    if (!el) return;
    el.style.willChange = props || 'transform';
    clearTimeout(el.__ckWc);
    el.__ckWc = setTimeout(function () { el.style.willChange = ''; }, (ms || 800) + 80);
  }

  /* ── icons (24×24, stroked) ──────────────────────────────────────────────────────── */
  function ic(d, cls) { return '<svg class="ck-ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + d + '</svg>'; }
  var I = {
    bag: ic('<path d="M5.6 8.4h12.8l-1.05 11.1a1.7 1.7 0 0 1-1.7 1.5H8.35a1.7 1.7 0 0 1-1.7-1.5L5.6 8.4Z"/><path d="M9.1 10.6V7.1a2.9 2.9 0 0 1 5.8 0v3.5"/>'),
    x: ic('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    next: ic('<path d="M4.5 12h14.5M13.5 6.5 19 12l-5.5 5.5"/>'),
    back: ic('<path d="M19.5 12H5M10.5 6.5 5 12l5.5 5.5"/>'),
    tick: ic('<path d="m5.5 12.6 4.1 4.1 8.9-9.3"/>'),
    minus: ic('<path d="M6.5 12h11"/>'),
    plus: ic('<path d="M12 6.5v11M6.5 12h11"/>'),
    mail: ic('<rect x="3.5" y="5.5" width="17" height="13" rx="2.2"/><path d="m4.5 7 7.5 6 7.5-6"/>'),
    user: ic('<circle cx="12" cy="8.3" r="3.6"/><path d="M4.8 20c1.3-3.6 4-5.4 7.2-5.4s5.9 1.8 7.2 5.4"/>'),
    pin: ic('<path d="M12 20.8s-6.6-5.9-6.6-11a6.6 6.6 0 0 1 13.2 0c0 5.1-6.6 11-6.6 11Z"/><circle cx="12" cy="9.8" r="2.4"/>'),
    card: ic('<rect x="3" y="5.5" width="18" height="13" rx="2.2"/><path d="M3 9.6h18M6.5 15h4"/>'),
    cal: ic('<rect x="3.5" y="5" width="17" height="15" rx="2.2"/><path d="M3.5 9.8h17M8 3.2v3.4M16 3.2v3.4"/>'),
    lock: ic('<rect x="5" y="10.4" width="14" height="10" rx="2.2"/><path d="M8.2 10.4V8a3.8 3.8 0 0 1 7.6 0v2.4"/>'),
    flip: ic('<path d="M19.4 9.2A7.6 7.6 0 0 0 5.6 7.6M4.6 14.8a7.6 7.6 0 0 0 13.8 1.6"/><path d="M19.6 4.4v4.9h-4.9M4.4 19.6v-4.9h4.9"/>'),
    truck: ic('<path d="M2.8 6.5h10.7v9.2H2.8zM13.5 9.6h3.9l3 3.1v3H13.5"/><circle cx="7" cy="17.4" r="1.7"/><circle cx="17" cy="17.4" r="1.7"/>'),
    spark: ic('<path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.6 2.6M15.4 15.4 18 18M6 18l2.6-2.6M15.4 8.6 18 6"/>')
  };
  var NFC = '<svg class="ck-nfc" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7.6 8.2a5.4 5.4 0 0 1 0 7.6M10.9 5.6a9 9 0 0 1 0 12.8M14.2 3a12.6 12.6 0 0 1 0 18"/></svg>';
  /* our own mark on the card: a five-petal rosette in hairlines */
  function rosette() {
    var g = '';
    for (var i = 0; i < 5; i++) g += '<ellipse cx="0" cy="-19" rx="11.5" ry="20" transform="rotate(' + (i * 72) + ')"/>';
    for (var k = 0; k < 5; k++) g += '<ellipse cx="0" cy="-11" rx="7" ry="12" transform="rotate(' + (k * 72 + 36) + ')"/>';
    return '<svg class="ck-rosette" viewBox="-50 -50 100 100" aria-hidden="true" focusable="false"><g>' + g + '<circle r="4.2"/></g></svg>';
  }
  var NETS = '<span class="ck-net" data-net="">' +
    '<b class="ck-n ck-n-visa">VISA</b>' +
    '<b class="ck-n ck-n-mc"><i></i><i></i></b>' +
    '<b class="ck-n ck-n-amex">AMEX</b>' +
    '<b class="ck-n ck-n-disc">DISC<i></i>VER</b></span>';
  var NET_NAME = { visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', discover: 'Discover' };

  /* ── the bag: state, persistence, totals ─────────────────────────────────────────── */
  function sanitize(raw) {
    var out = [], seen = {};
    if (!Array.isArray(raw)) return out;
    raw.forEach(function (l) {
      if (!l || typeof l !== 'object') return;
      var sku = String(l.sku), q = Math.floor(+l.qty);
      if (!CATALOG[sku] || !(q > 0)) return;
      if (seen[sku]) { seen[sku].qty = Math.min(MAX_QTY, seen[sku].qty + q); return; }
      seen[sku] = { sku: sku, qty: Math.min(MAX_QTY, q) };
      out.push(seen[sku]);
    });
    return out;
  }
  function load() {
    var raw = null;
    try { raw = JSON.parse(window.localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
    return sanitize(raw);
  }
  function save() {
    try {
      if (lines.length) window.localStorage.setItem(KEY, JSON.stringify(lines.map(function (l) { return { sku: l.sku, qty: l.qty }; })));
      else window.localStorage.removeItem(KEY);
    } catch (e) { /* private mode, quota, blocked storage: the bag just lives for this visit */ }
  }
  var lines = load();

  function priceOf(sku) { var p = CATALOG[sku]; return p ? (+p.price || 0) : 0; }
  function count() { return lines.reduce(function (n, l) { return n + l.qty; }, 0); }
  function subtotal() { return lines.reduce(function (n, l) { return n + l.qty * priceOf(l.sku); }, 0); }
  function find(sku) { for (var i = 0; i < lines.length; i++) if (lines[i].sku === sku) return lines[i]; return null; }
  function isStd(opt, i) { return opt.id === 'standard' || (!HAS_STD && i === 0); }
  function stdCost(sub) { return sub >= FREE_FROM ? 0 : STD_FEE; }
  function optCost(opt, sub) { var i = SHIPPING.indexOf(opt); return isStd(opt, i) ? stdCost(sub) : (+opt.price || 0); }
  function optLabel(opt, sub) { var i = SHIPPING.indexOf(opt); return isStd(opt, i) && optCost(opt, sub) > 0 ? 'Standard delivery' : (opt.label || 'Delivery'); }
  var shipId = SHIPPING[0].id;
  function shipOpt() { for (var i = 0; i < SHIPPING.length; i++) if (SHIPPING[i].id === shipId) return SHIPPING[i]; return SHIPPING[0]; }

  /* every change to the bag goes through here */
  function commit(o) {
    o = o || {};
    if (!o.noSave) save();
    if (built) {
      paintBadges(!!o.bump);
      renderBag();
      if (state.co && !busy) renderSummary();
    }
    try { doc.dispatchEvent(new CustomEvent('cart:change', { detail: { count: count(), subtotal: subtotal() } })); } catch (e) { /* very old browser */ }
  }
  function add(sku, qty, o) {
    sku = String(sku);
    if (!CATALOG[sku]) return 0;
    qty = Math.max(1, Math.floor(+qty || 1));
    var l = find(sku), before = l ? l.qty : 0;
    if (l) l.qty = Math.min(MAX_QTY, l.qty + qty);
    else { l = { sku: sku, qty: Math.min(MAX_QTY, qty) }; lines.push(l); }
    commit({ bump: l.qty !== before });
    var p = CATALOG[sku];
    if (o && o.announce !== false) say(l.qty === before ? 'You can add up to ' + MAX_QTY + ' of ' + p.name + '.' :
      'Added ' + p.name + ' to your bag. ' + plural(count()) + ', ' + money(subtotal()) + '.');
    return l.qty;
  }
  function setQty(sku, q) {
    sku = String(sku);
    q = Math.floor(+q);
    if (!(q > 0)) return removeSku(sku);
    if (!CATALOG[sku]) return 0;
    var l = find(sku);
    if (!l) { l = { sku: sku, qty: 0 }; lines.push(l); }
    l.qty = Math.min(MAX_QTY, q);
    commit();
    return l.qty;
  }
  function removeSku(sku) {
    sku = String(sku);
    var n = lines.length;
    lines = lines.filter(function (l) { return l.sku !== sku; });
    if (lines.length !== n) commit();
    return 0;
  }
  function clearBag() { lines = []; commit(); }

  /* ── state of the overlays ───────────────────────────────────────────────────────── */
  var built = false, busy = false, done = false;
  var state = { bag: false, co: false };
  var opener = null, openTimer = 0;
  var els = {}, bagBtns = [], rowEls = {};
  var step = 'delivery';

  /* screen-reader announcements */
  function say(text) {
    if (!els.live) return;
    els.live.textContent = '';
    setTimeout(function () { els.live.textContent = text; }, 40);
  }

  /* ═══ building the DOM ═════════════════════════════════════════════════════════════ */
  function field(o) {
    var id = 'ck-' + o.id;
    var input = o.select
      ? '<select id="' + id + '"' + (o.auto ? ' autocomplete="' + o.auto + '"' : '') + ' aria-describedby="' + id + '-err">' + o.select + '</select>' + ic('<path d="m7 10 5 5 5-5"/>', 'ck-caret')
      : '<input id="' + id + '" type="' + (o.type || 'text') + '"' +
        (o.name ? ' name="' + o.name + '"' : '') +
        (o.mode ? ' inputmode="' + o.mode + '"' : '') +
        ' autocomplete="' + (o.auto || 'off') + '"' +
        (o.ph ? ' placeholder="' + esc(o.ph) + '"' : '') +
        (o.max ? ' maxlength="' + o.max + '"' : '') +
        (o.cls ? ' class="' + o.cls + '"' : '') +
        ' spellcheck="false" aria-describedby="' + id + '-err">';
    return '<div class="ck-f' + (o.half ? ' ck-f--half' : '') + '">' +
      '<label for="' + id + '">' + esc(o.label) + '</label>' +
      '<div class="ck-in">' + (o.icon || '') + input + (o.after || '') + '</div>' +
      '<p class="ck-err" id="' + id + '-err"></p></div>';
  }

  function build() {
    if (built) return;
    built = true;

    /* nav button(s) */
    $$('[data-cart-button]').forEach(function (slot) {
      var b = doc.createElement('button');
      b.type = 'button';
      b.className = 'ck-bagbtn';
      b.setAttribute('data-cart-button', '');
      b.setAttribute('aria-haspopup', 'dialog');
      b.setAttribute('aria-expanded', 'false');
      b.innerHTML = I.bag + '<span class="ck-badge" aria-hidden="true">0</span>';
      b.addEventListener('click', function () { openBag(b); });
      slot.parentNode.replaceChild(b, slot);
      bagBtns.push(b);
    });

    var live = doc.createElement('div');
    live.className = 'ck-sr';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    els.live = live;

    var scrim = doc.createElement('div');
    scrim.className = 'ck-scrim';
    scrim.setAttribute('aria-hidden', 'true');
    els.scrim = scrim;

    /* the bag */
    var bag = doc.createElement('aside');
    bag.className = 'ck-bag';
    bag.setAttribute('role', 'dialog');
    bag.setAttribute('aria-modal', 'true');
    bag.setAttribute('aria-labelledby', 'ck-bag-title');
    bag.tabIndex = -1;
    bag.innerHTML =
      '<header class="ck-bag-head">' +
        '<h2 id="ck-bag-title">Your bag <span class="ck-bag-count"></span></h2>' +
        '<button type="button" class="ck-x" data-ck="close-bag" aria-label="Close bag">' + I.x + '</button>' +
      '</header>' +
      '<div class="ck-bag-body" data-lenis-prevent>' +
        '<ul class="ck-lines" role="list"></ul>' +
        '<div class="ck-empty" hidden>' +
          '<div class="ck-empty-art" aria-hidden="true">' + I.bag + '</div>' +
          '<p class="ck-empty-h">Your bag is empty</p>' +
          '<p class="ck-empty-p">Every piece is poured by hand in small batches. The cream is a lovely place to begin.</p>' +
          '<button type="button" class="ck-cta ck-cta--soft" data-ck="continue">Continue shopping</button>' +
        '</div>' +
      '</div>' +
      '<footer class="ck-bag-foot">' +
        '<div class="ck-free">' + I.truck + '<p class="ck-free-t"></p><span class="ck-free-bar" aria-hidden="true"><i></i></span></div>' +
        '<dl class="ck-rows">' +
          '<div class="ck-row"><dt>Subtotal</dt><dd class="ck-bag-sub"></dd></div>' +
          '<div class="ck-row ck-row--soft"><dt>Shipping</dt><dd class="ck-bag-ship"></dd></div>' +
        '</dl>' +
        '<button type="button" class="ck-cta" data-ck="checkout"><span>Checkout</span>' + I.next + '</button>' +
        '<p class="ck-fine">Demo checkout: no card is charged and nothing is sent.</p>' +
      '</footer>';
    els.bag = bag;
    els.bagCount = $('.ck-bag-count', bag);
    els.lines = $('.ck-lines', bag);
    els.empty = $('.ck-empty', bag);
    els.bagBody = $('.ck-bag-body', bag);
    els.bagFoot = $('.ck-bag-foot', bag);
    els.freeT = $('.ck-free-t', bag);
    els.freeBar = $('.ck-free-bar i', bag);
    els.free = $('.ck-free', bag);
    els.bagSub = $('.ck-bag-sub', bag);
    els.bagShip = $('.ck-bag-ship', bag);
    els.goBtn = $('[data-ck="checkout"]', bag);

    /* the checkout dialog */
    var shipHTML = SHIPPING.map(function (s, i) {
      return '<label class="ck-opt"><input type="radio" name="ck-ship" value="' + esc(s.id) + '"' + (i ? '' : ' checked') + '>' +
        '<span class="ck-opt-dot" aria-hidden="true"></span>' +
        '<span class="ck-opt-t"><b class="ck-opt-l" data-opt-label="' + esc(s.id) + '">' + esc(s.label) + '</b><small>' + esc(s.detail || '') + '</small></span>' +
        '<span class="ck-opt-p" data-opt-price="' + esc(s.id) + '"></span></label>';
    }).join('');
    var countryHTML = COUNTRIES.map(function (c) { return '<option value="' + c[0] + '">' + esc(c[1]) + '</option>'; }).join('');

    var co = doc.createElement('div');
    co.className = 'ck-co';
    co.setAttribute('role', 'dialog');
    co.setAttribute('aria-modal', 'true');
    co.setAttribute('aria-labelledby', 'ck-co-title');
    co.innerHTML =
      '<div class="ck-panel" tabindex="-1">' +
        '<header class="ck-top">' +
          '<div class="ck-brand"><span class="ck-logo">' + esc(LOGO) + '</span><span class="ck-brand-sub" id="ck-co-title">Checkout</span></div>' +
          '<ol class="ck-steps" aria-label="Checkout steps">' +
            '<li data-s="bag"><i></i><span>Bag</span></li>' +
            '<li data-s="delivery"><i></i><span>Delivery</span></li>' +
            '<li data-s="payment"><i></i><span>Payment</span></li>' +
          '</ol>' +
          '<button type="button" class="ck-x" data-ck="close-co" aria-label="Close checkout">' + I.x + '</button>' +
        '</header>' +
        '<div class="ck-body" data-lenis-prevent>' +

          /* step 1: delivery */
          '<section class="ck-view" data-view="delivery" aria-labelledby="ck-h-delivery">' +
            '<div class="ck-sumcol">' +
              '<div class="ck-sum">' +
                '<button type="button" class="ck-sum-toggle" aria-expanded="false" aria-controls="ck-sum-body">' +
                  '<span>Order summary <small class="ck-sum-n"></small></span><b class="ck-sum-tot2"></b>' + ic('<path d="m7 10 5 5 5-5"/>', 'ck-caret') +
                '</button>' +
                '<div class="ck-sum-body" id="ck-sum-body">' +
                  '<h3 class="ck-h ck-h--sm">Your order</h3>' +
                  '<p class="ck-sub">Each jar is filled the week it ships.</p>' +
                  '<ul class="ck-sum-lines" role="list"></ul>' +
                  '<dl class="ck-rows ck-rows--sum">' +
                    '<div class="ck-row"><dt>Subtotal</dt><dd class="ck-s-sub"></dd></div>' +
                    '<div class="ck-row"><dt>Shipping</dt><dd class="ck-s-ship"></dd></div>' +
                    '<div class="ck-row ck-row--total"><dt>Total</dt><dd class="ck-s-tot"></dd></div>' +
                  '</dl>' +
                  '<p class="ck-sum-free"></p>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<form class="ck-form" data-form="delivery" novalidate>' +
              '<div class="ck-form-head"><h3 class="ck-h" id="ck-h-delivery" tabindex="-1">Delivery</h3><p class="ck-sub">Tell us where to send your parcel.</p></div>' +
              field({ id: 'email', label: 'Email', type: 'email', mode: 'email', auto: 'email', name: 'email', ph: 'you@example.com', icon: I.mail }) +
              field({ id: 'name', label: 'Full name', auto: 'name', name: 'name', ph: 'First and last name', icon: I.user }) +
              field({ id: 'addr', label: 'Address', auto: 'street-address', name: 'address', ph: 'Street, number, apartment', icon: I.pin }) +
              field({ id: 'city', label: 'City', auto: 'address-level2', name: 'city', ph: 'City', half: true }) +
              field({ id: 'zip', label: 'Postcode', auto: 'postal-code', name: 'postcode', ph: 'Postcode', half: true }) +
              field({ id: 'country', label: 'Country', auto: 'country', select: countryHTML }) +
              '<fieldset class="ck-ship"><legend>Shipping method</legend><div class="ck-opts">' + shipHTML + '</div></fieldset>' +
              '<div class="ck-actions">' +
                '<button type="button" class="ck-back" data-ck="to-bag">' + I.back + '<span>Back to bag</span></button>' +
                '<button type="submit" class="ck-cta"><span>Continue to payment</span>' + I.next + '</button>' +
              '</div>' +
              '<p class="ck-fine">Demo checkout: no card is charged and nothing is sent. <button type="button" class="ck-link" data-ck="sample">Fill in sample details</button></p>' +
            '</form>' +
          '</section>' +

          /* step 2: payment */
          '<section class="ck-view" data-view="payment" aria-labelledby="ck-h-payment" hidden>' +
            '<div class="ck-cardcol">' +
              '<div class="ck-stage" aria-hidden="true">' +
                '<div class="ck-glow"><i></i><i></i></div>' +
                '<div class="ck-ring"><i class="ck-ring-a"></i><i class="ck-ring-ok"></i></div>' +
                '<div class="ck-tilt"><div class="ck-card">' +
                  '<div class="ck-face ck-front">' +
                    rosette() + '<span class="ck-sheen"></span>' +
                    '<div class="ck-c-top"><span class="ck-c-logo">' + esc(LOGO) + '</span>' + NETS + '</div>' +
                    '<div class="ck-c-mid"><span class="ck-chip"></span>' + NFC + '</div>' +
                    '<div class="ck-c-num"></div>' +
                    '<div class="ck-c-bot"><div class="ck-c-who"><small>Card holder</small><span class="ck-c-name">Your name</span></div>' +
                      '<div class="ck-c-when"><small>Expires</small><span class="ck-c-exp"></span></div></div>' +
                  '</div>' +
                  '<div class="ck-face ck-rear">' +
                    '<span class="ck-stripe"></span>' +
                    '<div class="ck-sig"><span class="ck-sig-strip"></span><span class="ck-c-cvc"></span></div>' +
                    '<div class="ck-rear-foot"><p>Demo · never charged</p>' + NETS + '</div>' +
                  '</div>' +
                '</div></div>' +
              '</div>' +
              '<div class="ck-cardtools">' +
                '<button type="button" class="ck-flip" data-ck="flip" aria-pressed="false">' + I.flip + '<span>Flip card</span></button>' +
                '<p class="ck-safe">' + I.lock + '<span>Card details never leave this page.</span></p>' +
              '</div>' +
              '<div class="ck-mini"><div class="ck-mini-th"></div><div class="ck-mini-t"><b></b><span></span></div></div>' +
            '</div>' +
            '<form class="ck-form" data-form="payment" novalidate autocomplete="off">' +
              '<div class="ck-form-head"><h3 class="ck-h" id="ck-h-payment" tabindex="-1">Payment</h3><p class="ck-sub">Watch the card fill in as you type.</p></div>' +
              field({ id: 'cname', label: 'Name on card', ph: 'As printed on the card', icon: I.user }) +
              field({ id: 'cnum', label: 'Card number', mode: 'numeric', ph: '1234 5678 9012 3456', icon: I.card, max: 19, cls: 'ck-num', after: '<span class="ck-tag" aria-live="polite"></span>' }) +
              field({ id: 'cexp', label: 'Expiry (MM/YY)', mode: 'numeric', ph: 'MM/YY', icon: I.cal, max: 5, cls: 'ck-num', half: true }) +
              field({ id: 'ccvc', label: 'CVC', mode: 'numeric', ph: '123', icon: I.lock, max: 3, cls: 'ck-num', half: true }) +
              '<div class="ck-paytotal"><span>Total to pay</span><b class="ck-p-tot"></b></div>' +
              '<div class="ck-actions">' +
                '<button type="button" class="ck-back" data-ck="to-delivery">' + I.back + '<span>Back to delivery</span></button>' +
                '<button type="submit" class="ck-cta ck-pay"><span class="ck-pay-l"></span>' + I.next + '</button>' +
              '</div>' +
              '<p class="ck-fine ck-fine--demo">' + I.lock + '<span>Demo checkout: no card is charged and nothing is sent. <button type="button" class="ck-link" data-ck="testcard">Fill in a test card</button></span></p>' +
            '</form>' +
          '</section>' +

          /* step 3: processing and done */
          '<section class="ck-finale" hidden>' +
            '<div class="ck-slot"></div>' +
            '<div class="ck-msg"></div>' +
          '</section>' +
        '</div>' +
      '</div>';
    els.co = co;
    els.panel = $('.ck-panel', co);
    els.body = $('.ck-body', co);
    els.steps = $$('.ck-steps li', co);
    els.vDelivery = $('[data-view="delivery"]', co);
    els.vPayment = $('[data-view="payment"]', co);
    els.finale = $('.ck-finale', co);
    els.slot = $('.ck-slot', co);
    els.msg = $('.ck-msg', co);
    els.sum = $('.ck-sum', co);
    els.sumToggle = $('.ck-sum-toggle', co);
    els.sumLines = $('.ck-sum-lines', co);
    els.fDelivery = $('[data-form="delivery"]', co);
    els.fPayment = $('[data-form="payment"]', co);
    els.cardcol = $('.ck-cardcol', co);
    els.stage = $('.ck-stage', co);
    els.tilt = $('.ck-tilt', co);
    els.card = $('.ck-card', co);
    els.sheen = $('.ck-sheen', co);
    els.cNum = $('.ck-c-num', co);
    els.cName = $('.ck-c-name', co);
    els.cExp = $('.ck-c-exp', co);
    els.cCvc = $('.ck-c-cvc', co);
    els.nets = $$('.ck-net', co);
    els.tag = $('.ck-tag', co);
    els.flipBtn = $('[data-ck="flip"]', co);
    els.closeCo = $('[data-ck="close-co"]', co);
    ['email', 'name', 'addr', 'city', 'zip', 'country', 'cname', 'cnum', 'cexp', 'ccvc'].forEach(function (k) { els[k] = $('#ck-' + k, co); });

    doc.body.appendChild(live);
    doc.body.appendChild(scrim);
    doc.body.appendChild(bag);
    doc.body.appendChild(co);

    wire();
    paintBadges(false);
    renderBag();
    paintCard();
    setStep('delivery', { noFocus: true, noAnim: true });
  }

  /* ═══ the nav button ════════════════════════════════════════════════════════════════ */
  function paintBadges(bump) {
    var n = count();
    bagBtns.forEach(function (b) {
      var badge = $('.ck-badge', b);
      badge.textContent = n > 99 ? '99+' : String(n);
      b.classList.toggle('has-items', n > 0);
      b.setAttribute('aria-label', 'Open bag, ' + plural(n));
      if (bump && n > 0 && !reduced()) {
        b.classList.remove('is-bump');
        void b.offsetWidth;                                   // restart the keyframes
        b.classList.add('is-bump');
        moving(badge, 600);
        clearTimeout(b.__ckBump);
        b.__ckBump = setTimeout(function () { b.classList.remove('is-bump'); }, 700);
      }
    });
  }

  /* ═══ the bag panel ═════════════════════════════════════════════════════════════════ */
  function makeRow(sku) {
    var p = CATALOG[sku];
    var li = doc.createElement('li');
    li.className = 'ck-line';
    li.setAttribute('data-sku', sku);
    var meta = [p.note, p.size].filter(Boolean).map(function (t) { return '<span>' + esc(t) + '</span>'; }).join(' · ');
    li.innerHTML =
      '<div class="ck-thumb"><span class="ck-thumb-in">' + (p.img ? '<img src="' + esc(p.img) + '" alt="" width="72" height="90" decoding="async">' : '') + '</span></div>' +
      '<div class="ck-line-main">' +
        '<h3 class="ck-line-name">' + esc(p.name || p.short || sku) + '</h3>' +
        (meta ? '<p class="ck-line-meta">' + meta + '</p>' : '') +
        '<div class="ck-line-ctl">' +
          '<div class="ck-stepper" role="group" aria-label="Quantity of ' + esc(p.name) + '">' +
            '<button type="button" data-ck="dec" aria-label="One less ' + esc(p.name) + '">' + I.minus + '</button>' +
            '<span class="ck-qty"></span>' +
            '<button type="button" data-ck="inc" aria-label="One more ' + esc(p.name) + '">' + I.plus + '</button>' +
          '</div>' +
          '<button type="button" class="ck-rm" data-ck="remove" aria-label="Remove ' + esc(p.name) + ' from the bag">Remove</button>' +
        '</div>' +
      '</div>' +
      '<p class="ck-line-amt"></p>';
    return li;
  }
  function paintRow(li, l) {
    var q = $('.ck-qty', li), a = $('.ck-line-amt', li);
    var qs = String(l.qty), as = money(l.qty * priceOf(l.sku));
    if (q.textContent !== qs) {
      var first = q.textContent === '';
      q.textContent = qs;
      if (!first && !reduced()) { q.classList.remove('is-tick'); void q.offsetWidth; q.classList.add('is-tick'); }
    }
    if (a.textContent !== as) a.textContent = as;
    $('[data-ck="dec"]', li).setAttribute('aria-disabled', l.qty <= 1 ? 'true' : 'false');
    $('[data-ck="inc"]', li).setAttribute('aria-disabled', l.qty >= MAX_QTY ? 'true' : 'false');
  }
  /* rows below a removed one glide up into place (FLIP on transform) */
  function dropRow(li) {
    if (li.classList.contains('is-leaving')) return;
    li.classList.add('is-leaving');
    var finish = function () {
      if (!li.parentNode) return;
      var rest = $$('.ck-line:not(.is-leaving)', els.lines);
      var before = rest.map(function (r) { return r.getBoundingClientRect().top; });
      li.parentNode.removeChild(li);
      if (!reduced()) rest.forEach(function (r, i) {
        var dy = before[i] - r.getBoundingClientRect().top;
        if (Math.abs(dy) < 1) return;
        r.style.transition = 'none';
        r.style.transform = 'translateY(' + dy + 'px)';
        moving(r, 520);
        raf2(function () { r.style.transition = ''; r.style.transform = ''; });
      });
      syncEmpty();
    };
    if (reduced() || !state.bag) finish();
    else { moving(li, 320); setTimeout(finish, 300); }
  }
  function syncEmpty() {
    var empty = !lines.length && !$('.ck-line', els.lines);
    var wasHidden = els.empty.hidden;
    els.empty.hidden = !empty;
    els.bagFoot.hidden = !lines.length;
    els.bag.classList.toggle('is-empty', empty);
    if (empty && wasHidden && !reduced()) { els.empty.classList.remove('is-in'); void els.empty.offsetWidth; els.empty.classList.add('is-in'); }
  }
  function renderBag() {
    if (!built) return;
    var n = count(), sub = subtotal();
    els.bagCount.textContent = n ? plural(n) : '';
    var keep = {};
    var ref = els.lines.firstElementChild;
    lines.forEach(function (l) {
      var li = rowEls[l.sku];
      if (!li || li.classList.contains('is-leaving')) { li = makeRow(l.sku); rowEls[l.sku] = li; if (state.bag && !reduced()) li.classList.add('is-new'); }
      keep[l.sku] = 1;
      paintRow(li, l);
      while (ref && ref.classList.contains('is-leaving')) ref = ref.nextElementSibling;
      if (li !== ref) els.lines.insertBefore(li, ref);
      else ref = ref.nextElementSibling;
    });
    Object.keys(rowEls).forEach(function (sku) {
      if (!keep[sku]) { var li = rowEls[sku]; delete rowEls[sku]; dropRow(li); }
    });
    /* totals and the free-shipping hint */
    els.bagSub.textContent = money(sub);
    var std = stdCost(sub);
    els.bagShip.textContent = std ? money(std) : 'Free';
    var gap = FREE_FROM - sub;
    var unlocked = isFinite(FREE_FROM) && gap <= 0;
    els.free.hidden = !isFinite(FREE_FROM);
    els.free.classList.toggle('is-unlocked', unlocked);
    els.freeT.textContent = unlocked ? 'Free shipping unlocked' : 'You’re ' + money(gap) + ' away from free shipping';
    var f = isFinite(FREE_FROM) && FREE_FROM > 0 ? Math.max(0, Math.min(1, sub / FREE_FROM)) : 1;
    els.freeBar.style.transform = 'scaleX(' + f.toFixed(4) + ')';
    els.goBtn.setAttribute('aria-disabled', lines.length ? 'false' : 'true');
    syncEmpty();
  }

  function rememberOpener(el) {
    if (opener) return;
    var a = el || doc.activeElement;
    if (a && (els.bag.contains(a) || els.co.contains(a))) a = null;
    opener = a && a !== doc.body ? a : null;
  }
  function restoreFocus() {
    var t = opener;
    opener = null;
    if (t && visible(t)) focusEl(t);
    else if (bagBtns[0] && visible(bagBtns[0])) focusEl(bagBtns[0]);
  }

  var locked = false;
  function lock(on) {
    if (on === locked) return;
    locked = on;
    var L = window.lenis;
    if (on) {
      var sbw = Math.max(0, window.innerWidth - root.clientWidth);
      root.style.setProperty('--ck-sbw', sbw + 'px');
    }
    root.classList.toggle('ck-lock', on);
    try { if (L) { if (on && L.stop) L.stop(); else if (!on && L.start) L.start(); } } catch (e) { /* lenis gone */ }
  }
  function scrim(on) {
    els.scrim.classList.toggle('is-on', on);
  }

  function openBag(from, o) {
    if (!built) return;
    o = o || {};
    clearTimeout(openTimer);
    if (state.co) return;
    if (o.delay) { openTimer = setTimeout(function () { openBag(from); }, o.delay); return; }
    renderBag();
    if (state.bag) return;
    rememberOpener(from);
    state.bag = true;
    moving(els.bag, 800);
    els.bag.classList.add('is-open');
    if (!reduced()) {
      $$('.ck-line', els.lines).forEach(function (li, i) { li.style.setProperty('--i', i); });
      els.bag.classList.add('is-entering');
      setTimeout(function () { els.bag.classList.remove('is-entering'); }, 1100);
    }
    bagBtns.forEach(function (b) { b.setAttribute('aria-expanded', 'true'); });
    scrim(true);
    lock(true);
    setTimeout(function () { if (state.bag) focusEl($('[data-ck="close-bag"]', els.bag)); }, 60);
  }
  function closeBag(o) {
    o = o || {};
    clearTimeout(openTimer);
    if (!state.bag) return;
    state.bag = false;
    moving(els.bag, 800);
    els.bag.classList.remove('is-open', 'is-entering');
    bagBtns.forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
    if (o.toCheckout) return;
    scrim(false);
    lock(false);
    restoreFocus();
  }

  /* ═══ the checkout dialog ═══════════════════════════════════════════════════════════ */
  function openCheckout(from) {
    if (!built) return;
    if (!lines.length) { openBag(from); return; }
    if (state.co) return;
    if (state.bag) closeBag({ toCheckout: true });
    else rememberOpener(from);
    if (done) resetFinale();
    state.co = true;
    renderSummary();
    setStep('delivery', { noFocus: true });
    moving(els.panel, 900, 'transform, opacity');
    els.co.classList.add('is-open');
    scrim(true);
    lock(true);
    setTimeout(function () {
      if (!state.co) return;
      if (mqCoarse.matches) focusEl($('#ck-h-delivery', els.co));
      else focusEl(els.email);
    }, 90);
  }
  function closeCheckout(o) {
    o = o || {};
    if (!state.co || busy) return;
    state.co = false;
    moving(els.panel, 700, 'transform, opacity');
    els.co.classList.remove('is-open');
    wipeCard();
    if (done) setTimeout(function () { if (!state.co) resetFinale(); }, 650);
    if (o.toBag) { openBagFromCheckout(); return; }
    scrim(false);
    lock(false);
    restoreFocus();
  }
  function openBagFromCheckout() {
    state.bag = false;
    renderBag();
    state.bag = true;
    moving(els.bag, 800);
    els.bag.classList.add('is-open');
    bagBtns.forEach(function (b) { b.setAttribute('aria-expanded', 'true'); });
    setTimeout(function () { if (state.bag) focusEl(lines.length ? els.goBtn : $('[data-ck="continue"]', els.bag)); }, 60);
  }
  function closeAll() {
    if (busy) return;
    if (state.co) closeCheckout();
    else if (state.bag) closeBag();
  }

  function setStep(name, o) {
    o = o || {};
    step = name;
    [els.vDelivery, els.vPayment].forEach(function (v) {
      var on = v.getAttribute('data-view') === name;
      v.hidden = !on;
      if (on && !o.noAnim && !reduced()) { v.classList.remove('is-enter'); void v.offsetWidth; v.classList.add('is-enter'); }
    });
    var order = ['bag', 'delivery', 'payment'], k = order.indexOf(name);
    els.steps.forEach(function (li, i) { paintStep(li, i < k ? 'done' : i === k ? 'now' : 'todo', i); });
    els.body.scrollTop = 0;
    if (name === 'payment') { paintTotals(); paintCard(); paintMini(); }
    if (o.noFocus) return;
    setTimeout(function () {
      if (!state.co) return;
      var v = name === 'payment' ? els.vPayment : els.vDelivery;
      if (mqCoarse.matches) focusEl($('.ck-h', $('.ck-form', v)));
      else {
        var first = $$('input', v).filter(function (i) { return !i.value; })[0] || $('input', v);
        focusEl(first);
      }
    }, reduced() ? 0 : 120);
  }
  function paintStep(li, s, i) {
    li.classList.toggle('is-done', s === 'done');
    li.classList.toggle('is-now', s === 'now');
    if (s === 'now') li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    var label = $('span', li).textContent;
    $('i', li).innerHTML = s === 'done' ? I.tick + '<b class="ck-sr">' + label + ', completed</b>' : '<b aria-hidden="true">' + (i + 1) + '</b>';
  }

  /* the order summary (delivery step) and the totals everywhere in the dialog */
  function renderSummary() {
    if (!built) return;
    if (!lines.length && state.co && !done) { closeCheckout({ toBag: true }); return; }
    els.sumLines.innerHTML = lines.map(function (l) {
      var p = CATALOG[l.sku];
      return '<li class="ck-sline"><div class="ck-thumb ck-thumb--sm"><span class="ck-thumb-in">' + (p.img ? '<img src="' + esc(p.img) + '" alt="" width="56" height="70" decoding="async">' : '') + '</span>' +
        '<span class="ck-sline-q" aria-hidden="true">' + l.qty + '</span></div>' +
        '<div><p class="ck-sline-n">' + esc(p.name) + '</p><p class="ck-sline-m">' + esc([p.note, p.size].filter(Boolean).join(' · ')) + '<span class="ck-sr">, quantity ' + l.qty + '</span></p></div>' +
        '<p class="ck-sline-a">' + money(l.qty * priceOf(l.sku)) + '</p></li>';
    }).join('');
    paintTotals();
  }
  function paintTotals() {
    var sub = subtotal(), opt = shipOpt(), sh = optCost(opt, sub), tot = sub + sh;
    $('.ck-s-sub', els.co).textContent = money(sub);
    $('.ck-s-ship', els.co).textContent = sh ? money(sh) : 'Free';
    $('.ck-s-tot', els.co).textContent = money(tot);
    $('.ck-sum-tot2', els.co).textContent = money(tot);
    $('.ck-sum-n', els.co).textContent = plural(count());
    $('.ck-p-tot', els.co).textContent = money(tot);
    $('.ck-pay-l', els.co).textContent = 'Pay ' + money(tot);
    var gap = FREE_FROM - sub;
    $('.ck-sum-free', els.co).textContent = !isFinite(FREE_FROM) ? '' : gap > 0
      ? 'Add ' + money(gap) + ' more for free standard shipping.' : 'Standard shipping is on us.';
    SHIPPING.forEach(function (s) {
      var c = optCost(s, sub);
      var pe = $('[data-opt-price="' + cssEsc(s.id) + '"]', els.co), le = $('[data-opt-label="' + cssEsc(s.id) + '"]', els.co);
      if (pe) pe.textContent = c ? money(c) : 'Free';
      if (le) le.textContent = optLabel(s, sub);
    });
  }
  function paintMini() {
    var m = $('.ck-mini', els.co), opt = shipOpt(), sub = subtotal(), sh = optCost(opt, sub);
    $('.ck-mini-th', m).innerHTML = lines.slice(0, 4).map(function (l) {
      var p = CATALOG[l.sku];
      return '<span class="ck-thumb ck-thumb--xs"><span class="ck-thumb-in">' + (p.img ? '<img src="' + esc(p.img) + '" alt="" width="40" height="50" decoding="async">' : '') + '</span></span>';
    }).join('');
    var city = v(els.city.value), c = els.country.options[els.country.selectedIndex];
    $('.ck-mini-t b', m).textContent = plural(count()) + ' \u00b7 ' + money(sub + sh);
    $('.ck-mini-t span', m).textContent = (city ? 'To ' + city + (c ? ', ' + c.text : '') + ' \u00b7 ' : '') + optLabel(opt, sub) + (sh ? ' ' + money(sh) : ', free');
  }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

  /* ── validation: said in the field, kindly, never in an alert ───────────────────────── */
  var flagged = {};
  function mark(input, msg) {
    var f = input.closest('.ck-f'), err = f && $('.ck-err', f), box = input.closest('.ck-in');
    var bad = !!msg;
    if (box) box.classList.toggle('is-bad', bad);
    if (bad) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    if (err) {
      if (bad && err.textContent !== msg && !reduced()) { err.classList.remove('is-in'); void err.offsetWidth; err.classList.add('is-in'); }
      err.textContent = msg || '';
    }
    flagged[input.id] = bad;
    return !bad;
  }
  function v(s) { return String(s || '').trim(); }
  var RULES = {
    'ck-email': function (x) {
      x = v(x);
      if (!x) return 'Add your email so we can send the receipt.';
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x) ? '' : 'That email looks incomplete. Check the @ and the part after it.';
    },
    'ck-name': function (x) { x = v(x); return x.length >= 2 && /\p{L}/u.test(x) ? '' : 'Tell us who the parcel is for.'; },
    'ck-addr': function (x) { return v(x).length >= 4 ? '' : 'Add the street and number.'; },
    'ck-city': function (x) { return v(x).length >= 2 ? '' : 'Add your town or city.'; },
    'ck-zip': function (x) {
      x = v(x);
      var c = els.country ? els.country.value : '';
      if (!x) return 'Add your postcode.';
      if (c === 'US' && !/^\d{5}(-\d{4})?$/.test(x)) return 'US postcodes have 5 digits, like 31401.';
      if (c === 'CA' && !/^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/.test(x)) return 'Canadian postcodes look like K1A 0B1.';
      if (c === 'GB' && !/^[A-Za-z]{1,2}\d[A-Za-z\d]? ?\d[A-Za-z]{2}$/.test(x)) return 'UK postcodes look like SW1A 1AA.';
      return /^[A-Za-z0-9][A-Za-z0-9 \-]{1,9}$/.test(x) ? '' : 'That postcode doesn’t look right.';
    },
    'ck-cname': function (x) { x = v(x); return x.length >= 2 && /\p{L}/u.test(x) ? '' : 'Add the name as it’s printed on the card.'; },
    'ck-cnum': function (x) {
      var d = String(x || '').replace(/\D/g, ''), b = brandOf(d), need = b === 'amex' ? 15 : 16;
      if (!d) return 'Add the card number.';
      if (d.length < need) return 'That number is a little short: ' + (b === 'amex' ? 'Amex cards have 15 digits.' : 'cards have 16 digits.');
      return luhn(d) ? '' : 'That card number doesn’t add up. Check the digits.';
    },
    'ck-cexp': function (x) {
      var m = /^(\d{2})\/(\d{2})$/.exec(v(x));
      if (!v(x)) return 'Add the expiry date.';
      if (!m) return 'Use MM/YY, like 08/29.';
      var mm = +m[1], yy = 2000 + +m[2], now = new Date(), y = now.getFullYear(), mo = now.getMonth() + 1;
      if (mm < 1 || mm > 12) return 'Months go from 01 to 12.';
      if (yy < y || (yy === y && mm < mo)) return 'That card has expired. Try another one.';
      if (yy > y + 20) return 'That date is too far ahead. Check the year.';
      return '';
    },
    'ck-ccvc': function (x) {
      var d = String(x || '').replace(/\D/g, ''), amex = brandOf(els.cnum.value.replace(/\D/g, '')) === 'amex', need = amex ? 4 : 3;
      if (!d) return amex ? 'Add the 4-digit code on the card.' : 'Add the 3 digits on the back of the card.';
      return d.length === need ? '' : (amex ? 'Amex codes have 4 digits.' : 'The code has 3 digits.');
    }
  };
  function check(input) { var r = RULES[input.id]; return mark(input, r ? r(input.value) : ''); }
  function checkAll(list) {
    var firstBad = null;
    list.forEach(function (i) { if (!check(i) && !firstBad) firstBad = i; });
    if (firstBad) {
      focusEl(firstBad);
      if (firstBad.scrollIntoView) firstBad.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
      say('Please check the highlighted fields.');
    }
    return !firstBad;
  }

  /* ── the card ─────────────────────────────────────────────────────────────────────── */
  function brandOf(d) {
    if (/^3[47]/.test(d)) return 'amex';
    if (/^4/.test(d)) return 'visa';
    if (/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/.test(d)) return 'mastercard';
    if (/^(6011|65|64[4-9]|622)/.test(d)) return 'discover';
    return '';
  }
  function groupsOf(b) { return b === 'amex' ? [4, 6, 5] : [4, 4, 4, 4]; }
  function groupDigits(d, b) {
    var g = groupsOf(b), out = [], i = 0;
    g.forEach(function (n) { if (i < d.length) out.push(d.slice(i, i + n)); i += n; });
    return out.join(' ');
  }
  function luhn(d) {
    var s = 0, alt = false;
    for (var i = d.length - 1; i >= 0; i--) { var n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; }
    return d.length >= 13 && s % 10 === 0;
  }
  var shown = '', curBrand = '';
  function paintNumber(d, b) {
    var g = groupsOf(b), html = '', i = 0;
    g.forEach(function (n, gi) {
      if (gi) html += '<span class="ck-gap"> </span>';
      for (var k = 0; k < n; k++, i++) {
        var ch = d[i];
        var pop = ch && shown[i] !== ch && !reduced();
        html += '<span class="' + (ch ? 'is-d' : 'is-ph') + (pop ? ' is-pop' : '') + '">' + (ch || '•') + '</span>';
      }
    });
    els.cNum.innerHTML = html;
    shown = d;
  }
  function setBrand(b) {
    if (b === curBrand) return;
    curBrand = b;
    els.nets.forEach(function (n) { n.setAttribute('data-net', b); });
    els.tag.textContent = NET_NAME[b] || '';
    els.ccvc.maxLength = b === 'amex' ? 4 : 3;
    els.ccvc.placeholder = b === 'amex' ? '1234' : '123';
    if (els.ccvc.value.length > els.ccvc.maxLength) { els.ccvc.value = els.ccvc.value.slice(0, els.ccvc.maxLength); paintCvc(); }
  }
  function paintName() { var n = v(els.cname.value); els.cName.textContent = n ? n.toUpperCase() : 'Your name'; els.cName.classList.toggle('is-ph', !n); }
  function paintExp() {
    var t = els.cexp.value, ph = 'MM/YY', html = '';
    for (var i = 0; i < 5; i++) {
      var ch = t[i] || ph[i], cls = (t[i] ? '' : 'is-ph') + (ch === '/' ? ' is-sl' : '');
      html += '<span' + (cls.trim() ? ' class="' + cls.trim() + '"' : '') + '>' + esc(ch) + '</span>';
    }
    els.cExp.innerHTML = html;
  }
  function paintCvc() {
    var d = els.ccvc.value, n = curBrand === 'amex' ? 4 : 3, html = '';
    for (var i = 0; i < n; i++) html += d[i] ? '<span>' + esc(d[i]) + '</span>' : '<span class="is-ph">•</span>';
    els.cCvc.innerHTML = html;
  }
  function paintCard() {
    if (!built) return;
    var d = els.cnum.value.replace(/\D/g, '');
    setBrand(brandOf(d));
    paintNumber(d, curBrand);
    paintName();
    paintExp();
    paintCvc();
  }
  var flipped = false, pinned = false;
  function setFlip(on) {
    if (on === flipped) return;
    flipped = on;
    moving(els.card, 900);                                  // transform only: will-change: opacity would flatten the 3D
    els.card.classList.toggle('is-flipped', on);
    els.flipBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    $('span', els.flipBtn).textContent = on ? 'Show front' : 'Flip card';
  }
  function wipeCard() {
    if (!built || busy) return;
    [els.cnum, els.cexp, els.ccvc].forEach(function (i) { i.value = ''; mark(i, ''); });
    shown = '';
    pinned = false;
    setFlip(false);
    paintCard();
  }

  /* number field: groups of 4 (Amex 4-6-5), caret stays where it was */
  function onNumInput() {
    var el = els.cnum, raw = el.value, pos = el.selectionStart == null ? raw.length : el.selectionStart;
    var before = raw.slice(0, pos).replace(/\D/g, '').length;
    var d = raw.replace(/\D/g, '');
    var b = brandOf(d);
    d = d.slice(0, b === 'amex' ? 15 : 16);
    var f = groupDigits(d, b);
    el.value = f;
    el.maxLength = b === 'amex' ? 17 : 19;
    var p = 0, seen = 0;
    while (p < f.length && seen < before) { if (/\d/.test(f[p])) seen++; p++; }
    if (doc.activeElement === el) { try { el.setSelectionRange(p, p); } catch (e) {} }
    setBrand(b);
    paintNumber(d, b);
    liveCheck(el);
    if (flagged['ck-ccvc'] && els.ccvc.value) check(els.ccvc);
  }
  function onExpInput(e) {
    var el = els.cexp, d = el.value.replace(/\D/g, '').slice(0, 4);
    if (d.length === 1 && +d > 1) d = '0' + d;
    var typing = !e || !e.inputType || e.inputType.indexOf('delete') !== 0;
    el.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : (d.length === 2 && typing ? d + '/' : d);
    paintExp();
    liveCheck(el);
  }
  function onCvcInput() {
    var el = els.ccvc;
    el.value = el.value.replace(/\D/g, '').slice(0, curBrand === 'amex' ? 4 : 3);
    paintCvc();
    liveCheck(el);
  }
  /* once a field has been flagged, it re-checks itself as you type and clears the moment it's right */
  function liveCheck(el) { if (flagged[el.id]) check(el); }

  /* tilt: fine pointers only, one transform per frame, nothing else */
  function wireTilt() {
    var area = els.cardcol, tx = 0, ty = 0, frame = 0, on = false;
    function apply() {
      frame = 0;
      if (!on) return;
      els.tilt.style.transform = 'rotateX(' + (-ty * 7).toFixed(2) + 'deg) rotateY(' + (tx * 10).toFixed(2) + 'deg)';
      els.sheen.style.transform = 'translate3d(' + (tx * 22).toFixed(1) + '%,0,0)';
    }
    area.addEventListener('pointerenter', function (e) {
      if (!mqFine.matches || reduced() || busy || e.pointerType === 'touch') return;
      on = true;
      els.tilt.style.willChange = 'transform';
      els.sheen.style.willChange = 'transform';
      els.tilt.classList.add('is-live');
    });
    area.addEventListener('pointermove', function (e) {
      if (!on) return;
      var r = els.stage.getBoundingClientRect();
      tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2));
      ty = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height - 0.5) * 2));
      if (!frame) frame = requestAnimationFrame(apply);
    }, { passive: true });
    function leave() {
      if (!on) return;
      on = false;
      els.tilt.classList.remove('is-live');
      els.tilt.style.transform = '';
      els.sheen.style.transform = '';
      setTimeout(function () { if (!on) { els.tilt.style.willChange = ''; els.sheen.style.willChange = ''; } }, 700);
    }
    area.addEventListener('pointerleave', leave);
    els.tiltOff = leave;
  }

  /* simulated typing for the helpers (input events, so the card writes itself) */
  function typeInto(input, text, ms) {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    var chars = text.split(''), i = 0;
    return new Promise(function (res) {
      (function next() {
        if (i >= chars.length) { res(); return; }
        input.value += chars[i++];
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: chars[i - 1] }));
        if (reduced() || !ms) next(); else setTimeout(next, ms);
      })();
    });
  }
  function fillSample() {
    els.email.value = SAMPLE.email; els.name.value = SAMPLE.name; els.addr.value = SAMPLE.address;
    els.city.value = SAMPLE.city; els.zip.value = SAMPLE.zip; els.country.value = SAMPLE.country;
    [els.email, els.name, els.addr, els.city, els.zip].forEach(function (i) { mark(i, ''); });
    say('Sample delivery details filled in.');
  }
  var filling = false;
  function fillTestCard() {
    if (filling || busy) return;
    filling = true;
    if (!v(els.cname.value)) { els.cname.value = v(els.name.value) || SAMPLE.name; paintName(); mark(els.cname, ''); }
    typeInto(els.cnum, TEST_CARD.number, 34)
      .then(function () { return typeInto(els.cexp, TEST_CARD.exp, 60); })
      .then(function () {
        if (!mqCoarse.matches) focusEl(els.ccvc); else setFlip(true);
        return typeInto(els.ccvc, TEST_CARD.cvc, 110);
      })
      .then(function () { return wait(reduced() ? 0 : 650); })
      .then(function () {
        filling = false;
        if (!pinned) { if (doc.activeElement === els.ccvc) focusEl($('.ck-pay', els.co)); else setFlip(false); }
        say('Test card filled in.');
      });
  }

  /* ── paying: the card flies to the centre, a ring turns, then it's done ───────────── */
  function orderNo() {
    var A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', out = '', buf = new Uint8Array(6);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(buf); else for (var i = 0; i < 6; i++) buf[i] = Math.floor(Math.random() * 256);
    for (var k = 0; k < 6; k++) out += A[buf[k] % A.length];
    return 'PT-' + out;
  }
  /* FLIP: measure, change the layout, measure again, then animate only the transform */
  function flipMove(el, mutate, ms) {
    var a = el.getBoundingClientRect();
    mutate();
    var b = el.getBoundingClientRect();
    var dx = a.left - b.left, dy = a.top - b.top, s = b.width ? a.width / b.width : 1;
    if (reduced() || (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(s - 1) < 0.01)) return Promise.resolve();
    el.style.transition = 'none';
    el.style.transformOrigin = '0 0';
    el.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0) scale(' + s + ')';
    el.style.willChange = 'transform';
    void el.offsetWidth;
    return new Promise(function (res) {
      requestAnimationFrame(function () {
        el.style.transition = 'transform ' + ms + 'ms cubic-bezier(.16,1,.3,1)';
        el.style.transform = '';
        setTimeout(function () {
          el.style.transition = ''; el.style.transformOrigin = ''; el.style.willChange = '';
          res();
        }, ms + 30);
      });
    });
  }
  function pay() {
    if (busy) return;
    busy = true;
    var snap = {
      lines: lines.map(function (l) { return { sku: l.sku, qty: l.qty }; }),
      sub: subtotal(), opt: shipOpt(), email: v(els.email.value), name: v(els.name.value),
      addr: v(els.addr.value), city: v(els.city.value), zip: v(els.zip.value),
      country: els.country.options[els.country.selectedIndex] ? els.country.options[els.country.selectedIndex].text : ''
    };
    snap.ship = optCost(snap.opt, snap.sub);
    snap.total = snap.sub + snap.ship;
    snap.no = orderNo();
    var rm = reduced();

    els.co.classList.add('is-busy');
    els.closeCo.disabled = true;
    pinned = false;
    setFlip(false);
    if (els.tiltOff) els.tiltOff();
    focusEl(els.panel);                                     // drops the phone keyboard, keeps focus inside
    say('Processing payment.');
    els.body.classList.add('is-leaving');

    wait(rm ? 0 : 380).then(function () {
      els.body.style.height = els.body.offsetHeight + 'px'; // the panel holds its size while the card travels
      els.body.style.minHeight = '';
      return flipMove(els.stage, function () {
        els.finale.hidden = false;
        els.slot.appendChild(els.stage);
        els.vPayment.hidden = true;
        els.vDelivery.hidden = true;
        els.body.scrollTop = 0;
        els.msg.innerHTML = '';
      }, 950);
    }).then(function () {
      els.body.classList.remove('is-leaving');
      els.stage.classList.add('is-busy');
      els.msg.innerHTML = '<div class="ck-proc"><p class="ck-msg-h">Processing payment…</p><p class="ck-msg-p">Hold on a moment while we confirm your order.</p></div>';
      showMsg();
      return wait(rm ? 900 : 2300);
    }).then(function () {
      els.stage.classList.add('is-ok');
      els.steps.forEach(function (li, i) { paintStep(li, 'done', i); });
      els.co.classList.add('is-done');
      hideMsg();
      return wait(rm ? 0 : 420);
    }).then(function () {
      done = true;
      lines = [];
      commit();
      return flipMove(els.stage, function () {
        els.finale.classList.add('is-result');
        els.msg.innerHTML = successHTML(snap);
      }, 800);
    }).then(function () {
      els.stage.classList.remove('is-busy');
      showMsg();
      say('Payment approved. Thank you, order ' + snap.no + ' is confirmed.');
      busy = false;
      els.co.classList.remove('is-busy');
      els.closeCo.disabled = false;
      setTimeout(function () {
        if (!state.co) return;
        if (mqCoarse.matches) focusEl($('.ck-done-h', els.co));
        else { var f = $('[data-ck="finish"]', els.co); focusEl(f); if (f.scrollIntoView) f.scrollIntoView({ block: 'nearest' }); }
      }, rm ? 0 : 500);
    });
  }
  function showMsg() { if (reduced()) { els.msg.classList.add('is-on'); return; } moving(els.msg, 700, 'transform, opacity'); raf2(function () { els.msg.classList.add('is-on'); }); }
  function hideMsg() { moving(els.msg, 500, 'transform, opacity'); els.msg.classList.remove('is-on'); }
  function successHTML(s) {
    var items = s.lines.map(function (l) {
      var p = CATALOG[l.sku];
      return '<li><span>' + esc(p.short || p.name) + ' <small>× ' + l.qty + '</small></span><b>' + money(l.qty * priceOf(l.sku)) + '</b></li>';
    }).join('');
    var where = [s.name, s.addr, [s.city, s.zip].filter(Boolean).join(' '), s.country].filter(Boolean).map(esc).join(', ');
    return '<div class="ck-done">' +
      '<span class="ck-check" aria-hidden="true"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"/></svg>' +
        '<span class="ck-check-w"><span class="ck-check-i"><svg viewBox="0 0 52 52"><path d="M15.5 27.2l7.2 7.2 14.4-15.6"/></svg></span></span></span>' +
      '<h3 class="ck-done-h" tabindex="-1">Thank you — order <span class="ck-ono">' + esc(s.no) + '</span> confirmed</h3>' +
      '<p class="ck-done-p">Your order is being poured and sealed for ' + esc((s.name || 'you').split(' ')[0]) + '. This was a demo, so no card was charged and no email was sent.</p>' +
      '<div class="ck-receipt">' +
        '<ul role="list">' + items + '</ul>' +
        '<dl class="ck-rows">' +
          '<div class="ck-row"><dt>' + esc(optLabel(s.opt, s.sub)) + '</dt><dd>' + (s.ship ? money(s.ship) : 'Free') + '</dd></div>' +
          '<div class="ck-row ck-row--total"><dt>Total</dt><dd>' + money(s.total) + '</dd></div>' +
        '</dl>' +
        (where ? '<p class="ck-where">' + I.truck + '<span>' + where + (s.opt.detail ? ' · ' + esc(s.opt.detail) : '') + '</span></p>' : '') +
      '</div>' +
      '<button type="button" class="ck-cta" data-ck="finish"><span>Back to the site</span>' + I.next + '</button>' +
    '</div>';
  }
  function resetFinale() {
    done = false;
    els.co.classList.remove('is-done', 'is-busy');
    els.finale.classList.remove('is-result');
    els.finale.hidden = true;
    els.msg.classList.remove('is-on');
    els.msg.innerHTML = '';
    els.stage.classList.remove('is-busy', 'is-ok');
    els.stage.style.cssText = '';
    els.body.style.height = '';
    els.body.classList.remove('is-leaving');
    els.cardcol.insertBefore(els.stage, els.cardcol.firstChild);
    [els.cname, els.cnum, els.cexp, els.ccvc].forEach(function (i) { i.value = ''; mark(i, ''); });
    shown = '';
    paintCard();
  }

  /* ═══ events ════════════════════════════════════════════════════════════════════════ */
  function wire() {
    /* add to bag, anywhere on the page */
    doc.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-add-to-bag]') : null;
      if (!t || t.closest('.ck-bag, .ck-co')) return;
      var sku = t.getAttribute('data-add-to-bag');
      if (!CATALOG[sku]) return;
      e.preventDefault();
      add(sku, parseInt(t.getAttribute('data-qty'), 10) || 1, { announce: true });
      feedback(t);
      openBag(t, { delay: reduced() ? 0 : 300 });
    });

    els.scrim.addEventListener('click', function () { if (!busy) closeAll(); });
    $('[data-ck="close-bag"]', els.bag).addEventListener('click', function () { closeBag(); });
    $('[data-ck="continue"]', els.bag).addEventListener('click', function () {
      var dest = doc.getElementById('collection');
      closeBag();
      if (dest) {
        var L = window.lenis;
        if (L && L.scrollTo && !reduced()) L.scrollTo(dest, { duration: 1.4 });
        else dest.scrollIntoView({ block: 'start' });
      }
    });
    els.goBtn.addEventListener('click', function () { if (lines.length) openCheckout(); });
    els.lines.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-ck]');
      var li = e.target.closest('.ck-line');
      if (!b || !li || li.classList.contains('is-leaving')) return;
      var sku = li.getAttribute('data-sku'), l = find(sku), act = b.getAttribute('data-ck');
      if (!l || b.getAttribute('aria-disabled') === 'true') return;
      var p = CATALOG[sku];
      if (act === 'inc') { setQty(sku, l.qty + 1); say(p.name + ', quantity ' + find(sku).qty + '.'); }
      else if (act === 'dec') { setQty(sku, l.qty - 1); say(p.name + ', quantity ' + find(sku).qty + '.'); }
      else if (act === 'remove') {
        var rows = $$('.ck-line:not(.is-leaving)', els.lines), at = rows.indexOf(li);
        var next = rows[at + 1] || rows[at - 1];
        removeSku(sku);
        say('Removed ' + p.name + '. ' + (lines.length ? plural(count()) + ' left.' : 'Your bag is empty.'));
        focusEl(next ? $('[data-ck="remove"]', next) : (lines.length ? els.goBtn : $('[data-ck="continue"]', els.bag)));
        if (!lines.length) setTimeout(function () { if (state.bag) focusEl($('[data-ck="continue"]', els.bag)); }, reduced() ? 0 : 340);
      }
    });

    /* checkout */
    els.closeCo.addEventListener('click', function () { closeCheckout(); });
    $('[data-ck="to-bag"]', els.co).addEventListener('click', function () { closeCheckout({ toBag: true }); });
    $('[data-ck="to-delivery"]', els.co).addEventListener('click', function () { if (!busy) { pinned = false; setFlip(false); setStep('delivery'); } });
    $('[data-ck="sample"]', els.co).addEventListener('click', fillSample);
    $('[data-ck="testcard"]', els.co).addEventListener('click', fillTestCard);
    els.sumToggle.addEventListener('click', function () {
      var open = !els.sum.classList.contains('is-open');
      els.sum.classList.toggle('is-open', open);
      els.sumToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    els.msg.addEventListener('click', function (e) { if (e.target.closest('[data-ck="finish"]')) closeCheckout(); });
    $$('input[name="ck-ship"]', els.co).forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) { shipId = r.value; paintTotals(); } });
    });

    var deliveryInputs = [els.email, els.name, els.addr, els.city, els.zip];
    deliveryInputs.forEach(function (i) {
      i.addEventListener('input', function () { liveCheck(i); });
      i.addEventListener('blur', function () { if (v(i.value) && state.co) check(i); });
    });
    els.country.addEventListener('change', function () { if (v(els.zip.value)) check(els.zip); });
    els.fDelivery.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy || !checkAll(deliveryInputs)) return;
      if (!v(els.cname.value)) { els.cname.value = v(els.name.value); paintName(); }
      setStep('payment');
    });

    var payInputs = [els.cname, els.cnum, els.cexp, els.ccvc];
    els.cname.addEventListener('input', function () { paintName(); liveCheck(els.cname); });
    els.cnum.addEventListener('input', onNumInput);
    els.cnum.addEventListener('keydown', function (e) {
      /* backspace right after a group space deletes the digit before it */
      var el = els.cnum, s = el.selectionStart;
      if (e.key === 'Backspace' && s === el.selectionEnd && s > 0 && el.value[s - 1] === ' ') el.setSelectionRange(s - 1, s - 1);
    });
    els.cexp.addEventListener('input', onExpInput);
    els.ccvc.addEventListener('input', onCvcInput);
    els.ccvc.addEventListener('focus', function () { setFlip(true); });
    els.ccvc.addEventListener('blur', function () { if (!pinned && !filling) setFlip(false); });
    payInputs.forEach(function (i) { i.addEventListener('blur', function () { if (v(i.value) && state.co && !busy && !filling) check(i); }); });
    els.flipBtn.addEventListener('click', function () { pinned = !flipped; setFlip(!flipped); });
    els.fPayment.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy || filling) return;
      if (!checkAll(payInputs)) { if (flagged['ck-ccvc'] && !flagged['ck-cnum'] && !flagged['ck-cexp'] && !flagged['ck-cname']) setFlip(true); return; }
      pay();
    });
    wireTilt();

    /* keyboard: Esc closes, Tab stays inside the open layer */
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (state.co) { e.preventDefault(); if (!busy) closeCheckout(); }
        else if (state.bag) { e.preventDefault(); closeBag(); }
        return;
      }
      if (e.key !== 'Tab') return;
      var layer = activeLayer();
      if (!layer) return;
      var f = focusables(layer);
      if (!f.length) { e.preventDefault(); focusEl(state.co ? els.panel : els.bag); return; }
      var first = f[0], last = f[f.length - 1], a = doc.activeElement;
      var inside = layer.contains(a);
      if (e.shiftKey && (a === first || !inside || a === els.panel || a === els.bag)) { e.preventDefault(); focusEl(last); }
      else if (!e.shiftKey && (a === last || !inside)) { e.preventDefault(); focusEl(first); }
    });
    doc.addEventListener('focusin', function (e) {
      var layer = activeLayer();
      if (!layer || layer.contains(e.target) || e.target === els.live) return;
      var f = focusables(layer);
      focusEl(f[0] || (state.co ? els.panel : els.bag));
    });

    /* the bag in another tab changed */
    window.addEventListener('storage', function (e) {
      if (e.key !== KEY || busy) return;
      lines = load();
      commit({ noSave: true });
    });
  }
  function activeLayer() { return state.co ? els.co : state.bag ? els.bag : null; }
  function focusables(layer) {
    return $$('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])', layer).filter(function (el) {
      if (el.disabled || el.tabIndex < 0 || el.closest('[hidden]')) return false;
      if (el.type === 'radio' && !el.checked && $$('input[name="' + el.name + '"]:checked', layer).length) return false;
      return visible(el);
    });
  }

  /* "Added" feedback on the element that was clicked; the page styles .is-added */
  var fb = typeof WeakMap === 'function' ? new WeakMap() : null;
  function feedback(el) {
    if (!fb) return;
    var st = fb.get(el);
    if (!st) {
      var label = el.querySelector('.add-label, .btn-label, [data-added-label]');
      var target = label || (el.children.length === 0 ? el : null);
      st = { target: target, html: target ? target.innerHTML : '', minW: el.style.minWidth, timer: 0 };
      if (target) {
        var w = el.getBoundingClientRect().width;
        if (w) el.style.minWidth = Math.ceil(w) + 'px';     // the button keeps its width while it says "Added"
        target.textContent = el.getAttribute('data-added-text') || 'Added';
      }
      fb.set(el, st);
    }
    clearTimeout(st.timer);
    el.classList.remove('is-added');
    void el.offsetWidth;
    el.classList.add('is-added');
    st.timer = setTimeout(function () {
      el.classList.remove('is-added');
      if (st.target) st.target.innerHTML = st.html;
      el.style.minWidth = st.minW;
      fb.delete(el);
    }, 1600);
  }

  /* ═══ public API ════════════════════════════════════════════════════════════════════ */
  window.Cart = {
    __petale: true,
    add: function (sku, qty) { return add(sku, qty == null ? 1 : qty, { announce: false }); },
    remove: function (sku) { return removeSku(sku); },
    setQty: function (sku, q) { return setQty(sku, q); },
    open: function () { openBag(null); },
    close: function () { closeAll(); },
    checkout: function () { openCheckout(null); },
    items: function () {
      return lines.map(function (l) {
        var p = CATALOG[l.sku];
        return { sku: l.sku, qty: l.qty, name: p.name, price: priceOf(l.sku), total: l.qty * priceOf(l.sku) };
      });
    },
    clear: function () { clearBag(); },
    count: count,
    subtotal: subtotal
  };

  function boot() {
    try { build(); } catch (err) { if (window.console) console.error('[checkout] could not start', err); return; }
    commit({ noSave: true });                               // tell the page what is already in the bag
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
