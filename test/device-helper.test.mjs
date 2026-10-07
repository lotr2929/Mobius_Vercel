// test/device-helper.test.mjs — the local device helper (backend/device-helper.mjs). A real server on a free port, a made-up collector.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, tidy, readMachine, renderPage, ORIGINS } from '../backend/device-helper.mjs';

const RAW = { manufacturer: 'HP', model: 'HP Elite x360 1040 14 inch G11 2-in-1 Notebook PC', cpu: 'Intel(R) Core(TM) Ultra 7 155H', cores: 16, threads: 22, ramGB: 31.5,
  gpus: ['Intel(R) Arc(TM) Graphics', 'DisplayLink USB Device'], os: 'Microsoft Windows 11 Enterprise', osVersion: '10.0.26200', osBuild: '26200', biosVersion: 'W90 Ver. 01.10.00', biosDate: '2026-06-04',
  disks: [{ drive: 'C:', sizeGB: 477, freeGB: 131 }], bootTime: '2026-10-07T00:10:00.0000000+08:00', computerName: 'CD-TEST',
  serialNumber: 'SECRET-SERIAL', userName: 'someone', macAddress: 'AA:BB', ip: '10.0.0.5' };

async function withServer(fn, opts = {}) {
  const server = createServer({ collect: async () => ({ ...RAW }), origins: ['https://mobius.test'], ...opts });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ask = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      let body = ''; res.on('data', c => (body += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
  try { await fn(ask, port); } finally { await new Promise(r => server.close(r)); }
}

test('it reports the machine, and only the fields it is meant to', async () => {
  await withServer(async ask => {
    const r = await ask('/device', { headers: { Origin: 'https://mobius.test' } });
    assert.equal(r.status, 200);
    const d = JSON.parse(r.body);
    assert.equal(d.model, RAW.model); assert.equal(d.cpu, RAW.cpu); assert.equal(d.threads, 22); assert.equal(d.ramGB, 31.5);
    assert.deepEqual(d.gpus, RAW.gpus); assert.equal(d.disks[0].freeGB, 131);
    assert.ok(!/SECRET|someone|AA:BB|10\.0\.0\.5/.test(r.body), 'no serial number, user name, MAC or IP address leaves the helper');
    assert.deepEqual(Object.keys(d).sort(), ['biosDate', 'biosVersion', 'bootTime', 'computerName', 'cores', 'cpu', 'disks', 'gpus', 'helper', 'manufacturer', 'model', 'os', 'osBuild', 'osVersion', 'partial', 'ramGB', 'threads']);
    assert.equal(r.headers['access-control-allow-origin'], 'https://mobius.test');
    assert.equal(r.headers['cache-control'], 'no-store');
  });
});

test('only the Mobius pages may ask, and only for reading', async () => {
  await withServer(async (ask, port) => {
    assert.equal((await ask('/device', { headers: { Origin: 'https://evil.example' } })).status, 403, 'another web page is refused');
    assert.equal((await ask('/device', { headers: { Host: 'evil.example:3777' } })).status, 403, 'another name for this port is refused (DNS rebinding)');
    assert.equal((await ask('/device', { method: 'POST', headers: { Origin: 'https://mobius.test' } })).status, 405);
    assert.equal((await ask('/device', { method: 'DELETE' })).status, 405);
    assert.equal((await ask('/etc/passwd')).status, 404);
    assert.equal((await ask('/ping')).status, 200, 'a direct visit, with no Origin, is fine');
    const pre = await ask('/device', { method: 'OPTIONS', headers: { Origin: 'https://mobius.test', 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(pre.status, 204); assert.equal(pre.headers['access-control-allow-private-network'], 'true');
    assert.equal((await ask('/device', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
  });
});

test('a collector that fails gives a 500, never a crash; odd values are made safe', async () => {
  await withServer(async ask => { assert.equal((await ask('/device')).status, 500); }, { collect: async () => { throw new Error('boom'); } });
  const t = tidy({ model: 'a\u0000b'.repeat(100), cores: 'x', gpus: 'not a list', disks: [{ drive: 'C:', sizeGB: 'NaN', freeGB: 5 }] });
  assert.ok(t.model.length <= 100 && !/\u0000/.test(t.model)); assert.equal(t.cores, null); assert.deepEqual(t.gpus, []); assert.equal(t.disks[0].sizeGB, null);
});

test('the allow-list holds the live app and the local copy, and nothing else', () => {
  assert.deepEqual(ORIGINS, ['https://mobius-pwa.vercel.app', 'http://localhost:3005', 'http://127.0.0.1:3005']);
});

test('on this computer it can really read the machine', { skip: process.platform !== 'win32' }, async () => {
  const d = tidy(await readMachine());
  assert.ok(d.cpu && d.threads > 0 && d.ramGB > 0, JSON.stringify(d));
  assert.ok(d.model, 'a make and model were found');
});

test("the helper's own page shows the machine, cannot be framed or run scripts, and keeps the same guards", async () => {
  await withServer(async ask => {
    const r = await ask('/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.ok(r.body.includes('HP Elite x360 1040 14 inch G11 2-in-1 Notebook PC') && r.body.includes('Intel(R) Core(TM) Ultra 7 155H') && r.body.includes('CD-TEST'), r.body);
    assert.ok(!/SECRET|someone|AA:BB|10\.0\.0\.5/.test(r.body), 'no serial number, user name, MAC or IP address on the page either');
    assert.ok(!/HP HP/.test(r.body), 'the maker is said once');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.match(r.headers['content-security-policy'], /default-src 'none'/);
    assert.ok(!/<script/i.test(r.body), 'no script on the page');
    assert.equal((await ask('/', { headers: { Host: 'evil.example:3777' } })).status, 403, 'another name for this port is refused');
    assert.equal((await ask('/', { method: 'POST' })).status, 405);
  });
  assert.ok(renderPage({ model: '<img src=x onerror=alert(1)>', manufacturer: '', gpus: ['<b>x</b>'], disks: [] }).indexOf('<img') === -1, 'anything odd in a reading is escaped');
});
