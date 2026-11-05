// A walk through the real app on the iOS simulator (debug builds only): injected by
// InkwrightBridgeViewController from the INKWRIGHT_TOUR launch environment, with the note ids and
// the snapshot prefix filled in by simulator-run.mjs. It taps through the interface as a person would and
// asks the native side to save a snapshot of the web view at each step (Documents/tour/*.png).
(function () {
  if (location.protocol !== 'capacitor:' || window.__inkwrightTour) return;
  window.__inkwrightTour = true;
  var IDS = __IDS__;
  var PREFIX = __PREFIX__;
  var cap = window.Capacitor;
  var plugin = null;
  var apple = function () { return plugin || (plugin = cap.registerPlugin ? cap.registerPlugin('InkwrightApple') : cap.Plugins.InkwrightApple); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var log = function (m) { console.log('TOUR ' + m); };
  var find = function (sel, re) {
    var all = document.querySelectorAll(sel);
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (re.test((e.textContent || '').trim()) || re.test(e.getAttribute('aria-label') || '')) return e;
    }
    return null;
  };
  var waitFor = async function (fn, ms) {
    var t = Date.now();
    while (Date.now() - t < (ms || 30000)) { var v = fn(); if (v) return v; await sleep(250); }
    return null;
  };
  var snap = async function (name) {
    await sleep(900);
    try { await apple().tourSnapshot({ name: PREFIX + name }); log('snap ' + name); }
    catch (e) { log('snap failed ' + name + ': ' + (e && e.message)); }
  };
  // A pen stroke made of real pointer events, as Apple Pencil delivers them to WebKit, drawn on the
  // open page's empty lower half. The run then checks the note on disk gained a stroke.
  var write = async function () {
    var el = document.querySelector('.ed-canvas');
    if (!el) { log('ink skipped: no canvas'); return; }
    var r = el.getBoundingClientRect();
    var x0 = r.left + r.width * 0.3, y0 = r.top + Math.min(r.height * 0.62, window.innerHeight * 0.62), w = r.width * 0.35, n = 60;
    var fire = function (type, i) {
      el.dispatchEvent(new PointerEvent(type, {
        pointerId: 11, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
        clientX: x0 + (w * i) / n, clientY: y0 + 10 * Math.sin((i / n) * 10 * Math.PI),
        pressure: type === 'pointerup' ? 0 : 0.35 + 0.4 * Math.sin((Math.PI * i) / n),
        buttons: type === 'pointerup' ? 0 : 1, button: type === 'pointermove' ? -1 : 0, tiltX: 20, tiltY: 10, width: 1, height: 1,
      }));
    };
    fire('pointerdown', 0);
    for (var i = 1; i <= n; i++) { fire('pointermove', i); if (i % 6 === 0) await sleep(16); }
    fire('pointerup', n);
    log('ink drawn');
    await sleep(2500);
  };
  var go = async function (hash, ready) {
    location.hash = hash;
    await waitFor(ready, 20000);
    await sleep(1800);
  };
  (async function () {
    try {
      await waitFor(function () { return document.querySelector('.welcome, .lib, main'); }, 40000);
      try { log('apple ' + JSON.stringify(await apple().availability())); } catch (e) { log('apple error ' + (e && e.message)); }
      await sleep(1500);
      if (document.querySelector('.welcome')) {
        await snap('1-welcome');
        var skip = find('button', /^Skip$/);
        if (skip) skip.click();
        await waitFor(function () { return !document.querySelector('.welcome'); }, 10000);
      }
      await waitFor(function () { return find('*', /Lecture 9/); }, 20000);
      await sleep(1500);
      await snap('2-library');
      await go('#note/' + IDS.lecture, function () { return document.querySelector('.ed-canvas canvas'); });
      await snap('3-lecture');
      await write();
      await snap('3-ink');
      var ai = document.querySelector('button[aria-label="AI"]');
      if (ai) { ai.click(); await sleep(2000); await snap('4-assistant'); ai.click(); }
      await go('#note/' + IDS.meeting, function () { return document.querySelector('.ed-canvas canvas'); });
      await snap('5-meeting');
      await go('#settings', function () { return find('h1, h2', /Settings/); });
      await snap('6-settings');
      await go('', function () { return find('*', /Lecture 9/); });
    } catch (e) {
      log('error ' + (e && e.message));
    }
    await snap('done');
  })();
})();
