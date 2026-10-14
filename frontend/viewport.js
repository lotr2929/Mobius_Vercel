/* viewport.js - keeps the chat page exactly as tall as the screen you can see.
 *
 * Why: on some Android phones, after you switch to another app (or to Settings) and come back, the browser keeps a stale window height.
 * The page is then taller than the visible screen and the bottom of it (the message box and its buttons) slips under the navigation bar.
 * What this does: it measures the visible height again whenever the page is shown, comes back to the front, or the window changes size,
 * and hands it to the page as --app-h (index.html uses it for #app). Browsers that never had the problem measure the same height as before.
 * It also keeps a short log of the measurements (window.__vp) that is sent with the device information, so a stubborn case can be diagnosed. */
(function () {
  'use strict';
  const root = document.documentElement;
  const log = (window.__vp = []);
  let timers = [];

  function measure(why) {
    const h = Math.round(window.innerHeight || 0);
    if (h < 200) return; // not a real measurement (page hidden or still starting)
    const prev = root.style.getPropertyValue('--app-h');
    const next = h + 'px';
    if (prev !== next) {
      root.style.setProperty('--app-h', next);
      root.classList.add('vh-js');
      void root.offsetHeight; // force the browser to lay the page out again at once
    }
    const vv = window.visualViewport;
    log.push({ why, inner: h, vv: vv ? Math.round(vv.height) : null, screen: screen.height, avail: screen.availHeight, t: Date.now() % 100000 });
    if (log.length > 12) log.shift();
  }

  // Android reports the final size a moment after the page comes back, so measure a few times, not once.
  function remeasure(why) {
    timers.forEach(clearTimeout); timers = [];
    measure(why);
    [120, 500, 1500].forEach(ms => timers.push(setTimeout(() => measure(why + '+' + ms), ms)));
  }

  window.addEventListener('resize', () => measure('resize'));
  window.addEventListener('orientationchange', () => remeasure('orientation'));
  window.addEventListener('pageshow', () => remeasure('pageshow'));
  window.addEventListener('focus', () => remeasure('focus'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) remeasure('visible'); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => measure('vvresize'));
  remeasure('start');
})();
