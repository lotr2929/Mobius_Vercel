/* device.js - what this device is, read by the page itself.
 * Shown on the Settings page under "This device". It reads the device the page is open on, each time it is opened, so the same page shows
 * the laptop on the laptop and the phone on the phone, with nothing to keep up to date. Nothing here is sent to Mobius's server or to any AI.
 * One file, used twice: the browser loads it as a plain script, and the tests load it in Node with made-up readings (test/device.test.mjs).
 * collect() asks the browser; rows() and text() only arrange what collect() found. */
(function () {
  'use strict';

  // Android phones name themselves with a model code; a few are spelled out. Anything else is shown as the code the phone gives.
  const KNOWN_MODELS = [[/^SM-A556/i, 'Samsung Galaxy A55 5G']];

  const clean = (v, n = 80) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  const bytes = n => {
    n = Number(n); if (!isFinite(n) || n <= 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  };
  const minutes = s => { s = Number(s); if (!isFinite(s) || s <= 0) return ''; const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };

  // "ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)"  ->  "Intel Arc Graphics"
  function cleanGpu(raw) {
    let s = clean(raw, 200).replace(/^ANGLE \((.*)\)$/i, '$1');
    s = s.replace(/,?\s*(Direct3D\d+|OpenGL ES|OpenGL|Vulkan|Metal)\b.*$/i, '').replace(/\(0x[0-9a-f]+\)/gi, '').replace(/\((?:R|TM)\)/g, '');
    s = s.replace(/^([A-Za-z]+),\s*(?=\1\b)/i, '').replace(/^[A-Za-z]+,\s*/, m => (/^(?:Intel|NVIDIA|AMD|ARM|Qualcomm|Samsung|Apple|Google),\s*/i.test(m) ? '' : m));
    return s.replace(/\s+/g, ' ').replace(/[,\s]+$/, '').trim();
  }

  function osName(info) {
    const p = clean(info.platform, 30), v = clean(info.platformVersion, 20), major = parseInt(v, 10);
    if (/windows/i.test(p)) return v ? `Windows ${major >= 13 ? 11 : 10} (platform version ${v})` : 'Windows';
    if (/android/i.test(p)) return v ? `Android ${major}` : 'Android';
    return [p, v].filter(Boolean).join(' ') || 'unknown';
  }
  function kindName(info) {
    const known = KNOWN_MODELS.find(([re]) => re.test(clean(info.model, 40)));
    const model = known ? known[1] : clean(info.model, 40);
    return `${info.mobile ? 'Phone or tablet' : 'Computer'}${model ? ` (${model}${known ? `, model code ${clean(info.model, 40)}` : ''})` : ''}`;
  }

  // Ask the browser. Every reading is optional: a browser that will not say leaves a gap, never an error.
  async function collect() {
    const n = navigator, s = screen, ua = n.userAgentData, info = {};
    const tryIt = async (fn) => { try { return await fn(); } catch { return undefined; } };
    info.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    info.locale = n.language; info.languages = [...(n.languages || [])].slice(0, 4);
    info.platform = ua?.platform || n.platform || '';
    info.mobile = ua ? ua.mobile : /Mobi|Android/i.test(n.userAgent);
    const brands = (ua?.brands || []).filter(b => !/not.?a.?brand/i.test(b.brand));
    info.browser = brands.length ? brands.map(b => `${b.brand} ${b.version}`).join(', ') : (n.userAgent.match(/(Edg|Chrome|Firefox|Version)\/[\d.]+/) || [''])[0];
    const hi = await tryIt(() => ua?.getHighEntropyValues(['model', 'platformVersion', 'architecture', 'bitness', 'formFactors']));
    if (hi) { info.model = hi.model; info.platformVersion = hi.platformVersion; info.arch = hi.architecture; info.bitness = hi.bitness; info.formFactors = hi.formFactors; }
    info.cores = n.hardwareConcurrency; info.memoryGB = n.deviceMemory;
    info.gpu = await tryIt(() => {
      const c = document.createElement('canvas'), gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return '';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return cleanGpu(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    });
    if (n.gpu) {
      const a = await tryIt(() => n.gpu.requestAdapter());
      const i = a && (a.info || (a.requestAdapterInfo && await tryIt(() => a.requestAdapterInfo())));
      info.webgpu = a ? { ok: true, name: clean([i?.vendor, i?.architecture, i?.description].filter(Boolean).join(' '), 80), maxBuffer: a.limits?.maxBufferSize } : { ok: false };
    } else info.webgpu = { ok: false, absent: true };
    info.screen = `${s.width} x ${s.height}`; info.dpr = window.devicePixelRatio; info.viewport = `${innerWidth} x ${innerHeight}`;
    info.orientation = s.orientation?.type || ''; info.colourDepth = s.colorDepth;
    info.touch = n.maxTouchPoints; info.coarse = matchMedia('(pointer: coarse)').matches;
    info.standalone = matchMedia('(display-mode: standalone)').matches;
    info.secure = window.isSecureContext;
    info.online = n.onLine;
    const c = n.connection; if (c) info.connection = { type: c.type, effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt, saveData: c.saveData };
    const b = await tryIt(() => n.getBattery && n.getBattery());
    if (b) info.battery = { level: Math.round(b.level * 100), charging: b.charging, toFull: b.chargingTime, toEmpty: b.dischargingTime };
    const est = await tryIt(() => n.storage?.estimate());
    if (est) info.storage = { usage: est.usage, quota: est.quota, persisted: await tryIt(() => n.storage.persisted()) };
    info.serviceWorker = !!(n.serviceWorker && n.serviceWorker.controller);
    info.geoPermission = await tryIt(async () => (await n.permissions.query({ name: 'geolocation' })).state);
    return info;
  }

  const yesNo = v => (v ? 'yes' : 'no');
  function timeText(info, now) {
    const tz = info.tz || undefined;
    try {
      const date = new Intl.DateTimeFormat(info.locale || 'en-GB', { dateStyle: 'full', timeZone: tz }).format(now);
      const time = new Intl.DateTimeFormat(info.locale || 'en-GB', { timeStyle: 'long', timeZone: tz }).format(now);
      return { date, time };
    } catch { return { date: now.toDateString(), time: now.toTimeString().slice(0, 8) }; }
  }

  // Groups of [label, value]; blank values are left out, so a missing reading simply does not appear.
  function rows(info, now = new Date()) {
    info = info || {};
    const t = timeText(info, now), c = info.connection, bat = info.battery, st = info.storage, g = info.webgpu;
    const mem = info.memoryGB ? (Number(info.memoryGB) >= 8 ? '8 GB or more (browsers report no higher than 8)' : `about ${Number(info.memoryGB)} GB (browsers round this)`) : '';
    const groups = [
      ['Device', [
        ['Type', kindName(info)],
        ['System', osName(info)],
        ['Browser', clean(info.browser, 80)],
        ['Processor', [info.arch && clean(info.arch, 12), info.bitness && `${clean(info.bitness, 4)}-bit`, info.cores && `${Number(info.cores)} logical cores`].filter(Boolean).join(', ')],
        ['Memory', mem],
        ['Graphics', clean(info.gpu, 80)],
        ['Local AI (WebGPU)', g ? (g.ok ? `available${g.name ? `: ${g.name}` : ''}${g.maxBuffer ? `; largest buffer ${bytes(g.maxBuffer)}` : ''}` : g.absent ? 'not available in this browser' : 'present, but no graphics adapter was offered') : ''],
      ]],
      ['Screen and input', [
        ['Screen', info.screen && `${clean(info.screen, 20)} at ${Number(info.dpr) || 1}x pixel density${info.colourDepth ? `, ${Number(info.colourDepth)}-bit colour` : ''}`],
        ['Window', [clean(info.viewport, 20), clean(info.orientation, 24)].filter(Boolean).join(', ')],
        ['Touch', info.touch ? `touch screen (${Number(info.touch)} points)${info.coarse ? ', finger-sized pointer' : ''}` : 'no touch screen'],
        ['Running as', info.standalone ? 'the installed app' : 'a browser tab'],
      ]],
      ['Network and power', [
        ['Connection', info.online === false ? 'offline' : 'online'],
        ['Link', c && [c.type, c.effectiveType, c.downlink && `about ${Number(c.downlink)} Mbps`, c.rtt && `${Number(c.rtt)} ms round trip`, c.saveData && 'data saver on'].filter(Boolean).map(x => clean(x, 24)).join(', ')],
        ['Battery', bat && `${Number(bat.level)}%${bat.charging ? ', charging' + (minutes(bat.toFull) ? `, full in ${minutes(bat.toFull)}` : '') : ', on battery' + (minutes(bat.toEmpty) ? `, about ${minutes(bat.toEmpty)} left` : '')}`],
        ['Storage for Mobius', st && `${bytes(st.usage) || '0 B'} used of ${bytes(st.quota)} allowed${st.persisted ? ', kept permanently' : ''}`],
      ]],
      ['Time and place', [
        ['Date', t.date],
        ['Time', t.time],
        ['Time zone', clean(info.tz, 40)],
        ['Language', [clean(info.locale, 12), ...(info.languages || []).filter(l => l !== info.locale).map(l => clean(l, 12))].filter(Boolean).join(', ')],
        ['Location access', info.geoPermission && ({ granted: 'allowed', denied: 'blocked', prompt: 'will ask when you press Show my position' }[info.geoPermission] || clean(info.geoPermission, 20))],
      ]],
      ['This app', [
        ['Secure connection', info.secure === undefined ? '' : yesNo(info.secure)],
        ['Works offline', info.serviceWorker === undefined ? '' : (info.serviceWorker ? 'the app files are kept on this device' : 'not yet: open it once more online')],
      ]],
    ];
    return groups.map(([title, list]) => ({ title, rows: list.filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '' && String(v) !== 'false') })).filter(g => g.rows.length);
  }

  function text(info, now = new Date()) {
    return rows(info, now).map(g => `${g.title}\n${g.rows.map(([k, v]) => `  ${k}: ${v}`).join('\n')}`).join('\n\n');
  }

  globalThis.MobiusDevice = { collect, rows, text, cleanGpu, KNOWN_MODELS };
})();
