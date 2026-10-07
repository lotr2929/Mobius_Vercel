// test/device.test.mjs — the "This device" panel on the Settings page (frontend/device.js). No network, no browser: made-up readings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
await import('../frontend/device.js');
const D = globalThis.MobiusDevice;
const NOW = new Date('2026-10-07T06:30:00Z'); // 2:30 pm in Perth

const laptop = {
  tz: 'Australia/Perth', locale: 'en-GB', languages: ['en-GB', 'en'], platform: 'Windows', platformVersion: '19.0.0', mobile: false, model: '',
  browser: 'Chromium 154, Microsoft Edge 154', arch: 'x86', bitness: '64', cores: 22, memoryGB: 8,
  gpu: D.cleanGpu('ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)'),
  webgpu: { ok: true, name: 'intel gen-12lp', maxBuffer: 4294967296 }, screen: '1680 x 1050', dpr: 1, viewport: '1680 x 970', orientation: 'landscape-primary', colourDepth: 24,
  touch: 10, coarse: false, standalone: true, secure: true, online: true, connection: { effectiveType: '4g', downlink: 10, rtt: 50 },
  battery: { level: 95, charging: true, toFull: 1800, toEmpty: Infinity }, storage: { usage: 12e6, quota: 3e11, persisted: true }, serviceWorker: true, geoPermission: 'prompt',
};
const phone = {
  tz: 'Australia/Perth', locale: 'en-AU', languages: ['en-AU'], platform: 'Android', platformVersion: '15.0.0', mobile: true, model: 'SM-A556E',
  browser: 'Chromium 154, Google Chrome 154', cores: 8, memoryGB: 8, gpu: D.cleanGpu('ANGLE (Samsung Xclipse 530, Vulkan 1.3.128)'), webgpu: { ok: false, absent: true },
  screen: '412 x 915', dpr: 2.625, viewport: '412 x 780', touch: 5, coarse: true, standalone: false, secure: true, online: true,
  connection: { type: 'cellular', effectiveType: '4g', downlink: 8.5, rtt: 70, saveData: false }, battery: { level: 62, charging: false, toEmpty: 7500 }, geoPermission: 'granted',
};

test('a laptop is described by what the browser can see, and its time is its own', () => {
  const t = D.text(laptop, NOW);
  for (const want of ['Computer\n', 'Windows 11', 'Intel Arc Graphics', '22 logical cores', '8 GB or more', 'the installed app', 'Australia/Perth',
    '95%, charging, full in 30 min', '14:30:00', 'Wednesday, 7 October 2026', 'available: intel gen-12lp', 'kept permanently', 'will ask when you press Show my position'])
    assert.ok(t.includes(want) || t.toLowerCase().includes(want.toLowerCase()), `missing: ${want}\n${t}`);
  assert.ok(!/undefined|NaN|null|\[object/.test(t), 'no stray values:\n' + t);
});

test('an Android phone shows its model, spelled out when we know it', () => {
  const t = D.text(phone, NOW);
  for (const want of ['Phone or tablet (Samsung Galaxy A55 5G, model code SM-A556E)', 'Android 15', 'Samsung Xclipse 530', 'a browser tab', 'touch screen (5 points)', '62%, on battery, about 2 h 5 min left', 'allowed', 'not available'])
    assert.ok(t.includes(want), `missing: ${want}\n${t}`);
  assert.ok(!/undefined|NaN|null/.test(t));
});

test('a browser that says nothing leaves gaps, not errors', () => {
  const t = D.text({}, NOW);
  assert.ok(t.includes('Time and place') && !/undefined|NaN|null/.test(t), t);
  assert.ok(D.rows({ platform: 'Windows' }, NOW).some(g => g.title === 'Device'));
});

test('graphics names are tidied', () => {
  assert.equal(D.cleanGpu('ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'Intel Arc Graphics');
  assert.equal(D.cleanGpu('ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'NVIDIA GeForce RTX 4060 Laptop GPU');
  assert.equal(D.cleanGpu('ANGLE (ARM, Mali-G68, OpenGL ES 3.2)'), 'Mali-G68');
  assert.equal(D.cleanGpu(''), '');
});

test('nothing on this page is sent anywhere, and the Settings page loads and shows it', () => {
  const js = readFileSync(new URL('../frontend/device.js', import.meta.url), 'utf8');
  const urls = [...new Set(js.match(/https?:\/\/[^\s'"`)]+/g) || [])];
  assert.deepEqual(urls, ['http://127.0.0.1:3777'], 'the only address device.js ever contacts is the helper on this same computer');
  assert.ok(!/XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(js) && (js.match(/\bfetch\s*\(/g) || []).length === 1, 'one fetch, to the helper');
  assert.ok(!/method\s*:\s*['"](?:POST|PUT|DELETE)/i.test(js), 'it only reads');
  const html = readFileSync(new URL('../frontend/settings.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('<script src="/device.js"></script>') > 0 && html.indexOf('<script src="/device.js"></script>') < html.indexOf('MobiusDevice.collect'), 'device.js loads before it is used');
  for (const id of ['deviceBox', 'devRefresh', 'devCopy', 'devPos', 'devicePos']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.indexOf('<h2>This device</h2>') > 0 && html.indexOf('<h2>This device</h2>') < html.indexOf('<h2>Your profile</h2>'), 'it sits first on the page');
  const pos = html.slice(html.indexOf("$('devPos').onclick"), html.indexOf("$('devPos').onclick") + 900);
  assert.ok(!/fetch\(|api\(/.test(pos), 'the position is shown, never posted');
});

test('with the helper running, the computer is named properly; without it, the panel says why and a typed name still shows', () => {
  const helper = { ok: true, data: { helper: 1, manufacturer: 'HP', model: 'HP Elite x360 1040 14 inch G11 2-in-1 Notebook PC', cpu: 'Intel(R) Core(TM) Ultra 7 155H', cores: 16, threads: 22, ramGB: 31.5,
    gpus: ['Intel(R) Arc(TM) Graphics', 'DisplayLink USB Device'], os: 'Microsoft Windows 11 Enterprise', osVersion: '10.0.26200', biosVersion: 'W90 Ver. 01.10.00', biosDate: '2026-06-04',
    disks: [{ drive: 'C:', sizeGB: 477, freeGB: 131 }], bootTime: '2026-10-07T00:10:00.000+08:00', computerName: 'CD-TEST' } };
  const t = D.text({ ...laptop, helper, label: 'Office laptop' }, NOW);
  for (const want of ['Called: Office laptop', 'Make and model: HP Elite x360 1040 14 inch G11 2-in-1 Notebook PC', 'Intel(R) Core(TM) Ultra 7 155H, 16 cores, 22 threads', 'Memory installed: 31.5 GB',
    'Intel(R) Arc(TM) Graphics; DisplayLink USB Device', 'C: 477 GB, 131 GB free', 'W90 Ver. 01.10.00, 2026-06-04', 'Computer name: CD-TEST', 'The computer itself (from the Mobius device helper)'])
    assert.ok(t.includes(want), `missing: ${want}\n${t}`);
  assert.ok(!/HP HP/.test(t), 'the maker is not said twice');
  const none = D.text({ ...laptop, helper: { ok: false, why: 'it is not running, or this browser did not allow the request' }, label: 'Office laptop' }, NOW);
  assert.ok(none.includes('the Mobius device helper was not reached (it is not running') && none.includes('Called: Office laptop'), none);
  // a phone never asks for a helper
  const p = D.text(phone, NOW);
  assert.ok(!/helper/i.test(p), 'a phone shows nothing about a helper');
});
