// A walk through the real app on the iOS simulator (debug builds only): injected by
// InkwrightBridgeViewController from the INKWRIGHT_TOUR launch environment, with __IDS__ and
// __PREFIX__ filled in by simulator-run.mjs. It taps through the interface as a person would and
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
  var go = async function (hash, ready) {
    location.hash = hash;
    await waitFor(ready, 20000);
    await sleep(1800);
  };
  (async function () {
    try {
      await waitFor(function () { return document.querySelector('.welcome, .lib, main'); }, 40000);
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
