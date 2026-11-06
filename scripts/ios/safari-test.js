// The web app's walk in Safari on the iOS simulator (scripts/ios/safari-run.mjs serves the real
// production build and adds this one script tag to its page; it is never part of the app). It
// uses the app as a person would and reports each step to the test server:
//   start   skip the welcome, write a stroke in a new note, check the note is in the library
//   reload  the note is still there after a reload; the offline app (service worker) is installed;
//           optionally the on-device AI: download the model, ask, get an answer
//   banner  the server now publishes a newer version: the library offers it (Update banner)
//   updated after Update, the new version runs and says "Updated to Inkwright …"
(function () {
  if (window.__safariTest) return;
  window.__safariTest = true;
  var KEY = '__safari_test';
  var st = JSON.parse(localStorage.getItem(KEY) || '{"phase":"start"}');
  if (/[?&]ai=1/.test(location.search)) st.ai = true;
  var save = function () { localStorage.setItem(KEY, JSON.stringify(st)); };
  // Reports retry: a page that is reloading or busy can drop a request, and a lost /__done would
  // leave the run waiting until its deadline.
  var post = async function (path, body) {
    for (var i = 0; i < 4; i++) {
      try { var r = await fetch(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body || {}) }); if (r.ok) return; } catch (e) { /* retry */ }
      await new Promise(function (res) { setTimeout(res, 1500); });
    }
  };
  var log = function (m) { return post('/__log', String(m)); };
  var step = function (name, ok, detail) { return post('/__step', { name: name, ok: !!ok, detail: detail || '' }); };
  var snap = function (name) { return post('/__snap?name=' + encodeURIComponent(name)); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
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
    while (Date.now() - t < (ms || 30000)) { var v = fn(); if (v) return v; await sleep(300); }
    return null;
  };
  var visible = function (el) { return !!el && el.getBoundingClientRect().width > 0; };
  var cards = function () { return document.querySelectorAll('.note-card').length; };
  window.addEventListener('error', function (e) { log('page error: ' + (e.message || e)); });
  window.addEventListener('unhandledrejection', function (e) { log('unhandled: ' + ((e.reason && e.reason.message) || e.reason)); });

  var draw = async function () {
    var el = await waitFor(function () { return document.querySelector('.ed-canvas'); }, 20000);
    if (!el) return false;
    await sleep(1200);
    var r = el.getBoundingClientRect();
    var x0 = r.left + r.width * 0.25, y0 = Math.max(r.top, 0) + window.innerHeight * 0.4, w = r.width * 0.4, n = 60;
    var fire = function (type, i) {
      el.dispatchEvent(new PointerEvent(type, {
        pointerId: 21, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
        clientX: x0 + (w * i) / n, clientY: y0 + 6 * Math.sin((i / n) * 3 * Math.PI),
        pressure: type === 'pointerup' ? 0 : 0.35 + 0.4 * Math.sin((Math.PI * i) / n),
        buttons: type === 'pointerup' ? 0 : 1, button: type === 'pointermove' ? -1 : 0, tiltX: 20, tiltY: 10, width: 1, height: 1,
      }));
    };
    fire('pointerdown', 0);
    for (var i = 1; i <= n; i++) { fire('pointermove', i); if (i % 6 === 0) await sleep(16); }
    fire('pointerup', n);
    await sleep(3000);
    return true;
  };

  var setText = function (ta, text) {
    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };

  var onDeviceAI = async function () {
    var card = document.querySelector('.note-card');
    if (card) (card.querySelector('a, button') || card).click();
    if (!(await waitFor(function () { return document.querySelector('.ed-canvas'); }, 20000))) return step('on-device AI answered', false, 'no editor');
    await sleep(1500);
    var ai = await waitFor(function () { return document.querySelector('button[aria-label="AI"]'); }, 10000);
    if (!ai) return step('on-device AI answered', false, 'no AI button');
    ai.click();
    // The panel can take a while on a busy simulator (it reads what is already on the device).
    var dl = await waitFor(function () { return find('button', /^(Download|Resume download)/); }, 120000);
    if (!dl) { await snap('ai-no-download'); return step('on-device AI answered', false, 'no download button'); }
    log('AI offer: ' + dl.textContent);
    dl.click();
    var started = Date.now();
    var ta = null;
    while (Date.now() - started < 25 * 60000) {
      ta = document.querySelector('.ai-input textarea');
      if (ta && !ta.disabled) break;
      var p = document.querySelector('.lai-progress-text, [role="progressbar"]');
      if ((Date.now() - started) % 60000 < 2000) log('AI download: ' + (p ? (p.textContent || p.getAttribute('aria-valuenow')) : 'waiting'));
      var err = find('.lai-error, [role="alert"]', /./);
      if (err && /fail|error|couldn/i.test(err.textContent || '')) log('AI message: ' + err.textContent);
      await sleep(2000);
    }
    if (!ta || ta.disabled) { await snap('ai-not-ready'); return step('on-device AI answered', false, 'model not ready after 25 min'); }
    step('on-device AI downloaded', true, Math.round((Date.now() - started) / 1000) + ' s');
    await snap('ai-ready');
    setText(ta, 'Reply with one short sentence: what is 2 + 2?');
    await sleep(300);
    var send = document.querySelector('.ai-input button[aria-label="Send"]');
    if (send) send.click();
    var asked = Date.now();
    var answer = await waitFor(function () {
      var msgs = document.querySelectorAll('.ai-msg.is-assistant');
      var last = msgs[msgs.length - 1];
      return last && !document.querySelector('.ai-typing') && (last.textContent || '').trim().length > 0 ? last.textContent.trim() : null;
    }, 25 * 60000);
    await snap('ai-answer');
    step('on-device AI answered', !!answer, answer ? answer.slice(0, 200) + ' (' + Math.round((Date.now() - asked) / 1000) + ' s)' : 'no answer in 25 min');
    ai.click();
    location.hash = '';
    await waitFor(function () { return document.querySelector('.library'); }, 20000);
  };

  (async function () {
    try {
      await waitFor(function () { return document.querySelector('.welcome, .library'); }, 60000);
      await sleep(1500);
      if (st.phase === 'start') {
        log('Safari ' + navigator.userAgent);
        if (document.querySelector('.welcome')) {
          await snap('welcome');
          var skip = find('button', /^Skip$/);
          if (skip) skip.click();
          await waitFor(function () { return !document.querySelector('.welcome'); }, 15000);
        }
        await waitFor(function () { return document.querySelector('.library'); }, 15000);
        await sleep(1000);
        await snap('library-first');
        var hint = document.querySelector('section[aria-label="Add to Home Screen"]');
        step('Add to Home Screen suggested', visible(hint));
        var before = cards();
        var nb = document.querySelector('.new-btn');
        (visible(nb) ? nb : document.querySelector('.fab')).click();
        var drew = await draw();
        await snap('editor-ink');
        location.hash = '';
        await waitFor(function () { return document.querySelector('.library'); }, 15000);
        await sleep(1500);
        await step('wrote a note', drew && cards() > before, before + ' → ' + cards() + ' notes');
        st.notes = cards();
        st.phase = 'reload'; save();
        location.reload();
        return;
      }
      if (st.phase === 'reload') {
        await sleep(2000);
        await step('note kept after reload', cards() >= (st.notes || 1), cards() + ' notes');
        var persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
        log('storage persisted: ' + persisted);
        try { await navigator.serviceWorker.register('./sw.js'); } catch (e) { log('service worker registration failed: ' + (e && (e.name + ': ' + e.message))); }
        var reg = await Promise.race([navigator.serviceWorker.ready, sleep(20000).then(function () { return navigator.serviceWorker.getRegistration(); })]);
        if (reg && !reg.active) { var w = reg.installing || reg.waiting; log('service worker ' + (w ? w.state : 'missing')); await sleep(15000); }
        var cached = !!(await caches.match('./').catch(function () { return null; }));
        await step('offline app installed', !!(reg && reg.active) && cached, reg && reg.active ? 'service worker active, app ' + (cached ? 'cached for offline' : 'NOT cached') : 'no service worker');
        await snap('library-reloaded');
        if (st.ai) {
          await onDeviceAI();
          // Back to the library whatever happened, so the update banner (shown there) can be checked.
          var close = document.querySelector('button[aria-label="AI"][aria-pressed="true"]');
          if (close) close.click();
          location.hash = '';
          await waitFor(function () { return document.querySelector('.library'); }, 20000);
        }
        await post('/__switch?what=manifest');
        st.phase = 'banner'; save();
        location.reload();
        return;
      }
      if (st.phase === 'banner') {
        try { log('server version.json: ' + (await (await fetch('./version.json?t=' + Date.now(), { cache: 'no-store' })).text()).slice(0, 60)); } catch (e) { log('version.json: ' + e); }
        var banner = await waitFor(function () { var b = document.querySelector('section[aria-label="Update"]'); return b && /is ready/.test(b.textContent || '') ? b : null; }, 150000);
        await snap('update-banner');
        step('update offered', !!banner, banner ? banner.querySelector('.update-banner-title').textContent : 'no banner in 150 s');
        if (!banner) { await post('/__done'); return; }
        await post('/__switch?what=all');
        st.phase = 'updated'; save();
        find('button', /^Update$/).click();
        return;
      }
      if (st.phase === 'updated') {
        var notice = await waitFor(function () { var n = document.querySelector('section[aria-label="Updated"]'); return n && /Updated to Inkwright/.test(n.textContent || '') ? n : null; }, 30000);
        await step('updated to the new version', !!notice, notice ? notice.textContent.trim().slice(0, 120) : 'no "Updated" notice');
        await snap('updated');
        st.phase = 'finished'; save();
        await post('/__done');
      }
    } catch (e) {
      await log('test error: ' + (e && e.message));
      await post('/__done');
    }
  })();
})();
