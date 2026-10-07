// device-helper.mjs - a small, read-only helper that tells the Mobius Settings page what this computer is.
//
// Why it exists: a web page cannot read a PC's make, model or processor name (browsers hide them on purpose), and the cloud copy of Mobius cannot
// see your laptop at all. This helper runs ON the laptop, reads those facts from Windows, and hands them to the Settings page when the page asks.
// It is part of the Mobius project (this file) but runs as its own background process, started at login (MobiusDeviceHelper.vbs in the Startup
// folder; delete that file to stop it). The phone needs none: an Android phone reports its own model to the browser.
//
// What it will and will not do - keep it this small:
//   - listens on 127.0.0.1 only (this computer; never the network), port 3777
//   - answers GET /device and GET /ping, nothing else; every other path or method is refused
//   - answers only requests that come from the Mobius pages (the allow-list below) or from a direct visit to the address
//   - the PowerShell it runs is a fixed text with no input from the request; nothing is written, installed or changed
//   - reports: make, model, processor, memory, graphics adapters, Windows edition, BIOS, disks (size and free), uptime, computer name.
//     It does NOT report serial numbers, user names, accounts, IP or MAC addresses, files, or anything about what is running.
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PORT = Number(process.env.MOBIUS_HELPER_PORT) || 3777;
export const ORIGINS = ['https://mobius-pwa.vercel.app', 'http://localhost:3005', 'http://127.0.0.1:3005'];

const PS = `
$ErrorActionPreference = 'Stop'
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$bios = Get-CimInstance Win32_BIOS
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name } | Where-Object { $_ } | Select-Object -Unique)
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [pscustomobject]@{ drive = $_.DeviceID; sizeGB = [math]::Round($_.Size / 1GB); freeGB = [math]::Round($_.FreeSpace / 1GB) } })
[pscustomobject]@{
  manufacturer = $cs.Manufacturer; model = $cs.Model
  cpu = $cpu.Name.Trim(); cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors
  ramGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
  gpus = $gpus
  os = $os.Caption; osVersion = $os.Version; osBuild = $os.BuildNumber
  biosVersion = $bios.SMBIOSBIOSVersion; biosDate = $bios.ReleaseDate.ToString('yyyy-MM-dd')
  disks = $disks
  bootTime = $os.LastBootUpTime.ToString('o')
  computerName = $env:COMPUTERNAME
} | ConvertTo-Json -Compress -Depth 4`;

const str = (v, n = 120) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

// Whatever the collector returns, only these fields, of these shapes, ever leave this file.
export function tidy(raw = {}) {
  return {
    helper: 1,
    manufacturer: str(raw.manufacturer, 60), model: str(raw.model, 100),
    cpu: str(raw.cpu), cores: num(raw.cores), threads: num(raw.threads), ramGB: num(raw.ramGB),
    gpus: (Array.isArray(raw.gpus) ? raw.gpus : []).slice(0, 6).map(g => str(g, 80)),
    os: str(raw.os, 80), osVersion: str(raw.osVersion, 30), osBuild: str(raw.osBuild, 12),
    biosVersion: str(raw.biosVersion, 40), biosDate: str(raw.biosDate, 12),
    disks: (Array.isArray(raw.disks) ? raw.disks : []).slice(0, 8).map(d => ({ drive: str(d.drive, 4), sizeGB: num(d.sizeGB), freeGB: num(d.freeGB) })),
    bootTime: str(raw.bootTime, 40), computerName: str(raw.computerName, 40),
    partial: !!raw.partial,
  };
}

function fromOs() {
  const cpus = os.cpus();
  return { manufacturer: '', model: '', cpu: cpus[0]?.model, cores: null, threads: cpus.length, ramGB: Math.round(os.totalmem() / 1e8) / 10, gpus: [], os: `${os.type()} ${os.release()}`, osVersion: os.version?.(), computerName: os.hostname(), bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString(), partial: true };
}

export function readMachine() {
  if (process.platform !== 'win32') return Promise.resolve(fromOs());
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS], { timeout: 20000, windowsHide: true, maxBuffer: 1e6 }, (err, out) => {
      if (err) return resolve(fromOs());
      try { resolve(JSON.parse(out)); } catch { resolve(fromOs()); }
    });
  });
}

const HOST_OK = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/i; // refuses a page that reaches this port through another name (DNS rebinding)

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The same facts as a page of its own, for opening in a browser tab on this computer. A page reaching the helper from the Mobius site needs
// the browser's permission to contact this computer, which a managed laptop may withhold; simply opening this address needs none.
export function renderPage(d, now = new Date()) {
  const rows = [
    ['Make and model', d.model && d.manufacturer && d.model.toLowerCase().startsWith(d.manufacturer.toLowerCase()) ? d.model : [d.manufacturer, d.model].filter(Boolean).join(' ')],
    ['Processor', [d.cpu, d.cores && d.threads && `${d.cores} cores, ${d.threads} threads`].filter(Boolean).join(', ')],
    ['Memory installed', d.ramGB != null ? `${d.ramGB} GB` : ''],
    ['Graphics adapters', (d.gpus || []).join('; ')],
    ['Windows', [d.os, d.osVersion && `version ${d.osVersion}`].filter(Boolean).join(', ')],
    ['BIOS', [d.biosVersion, d.biosDate].filter(Boolean).join(', ')],
    ['Disks', (d.disks || []).map(k => `${k.drive} ${k.sizeGB} GB, ${k.freeGB} GB free`).join('; ')],
    ['Running since', d.bootTime ? new Date(d.bootTime).toLocaleString('en-GB') : ''],
    ['Computer name', d.computerName],
    ['Partial reading', d.partial ? 'Windows would not answer everything' : ''],
  ].filter(([, v]) => v);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>This computer — Mobius device helper</title>
<style>body{max-width:760px;margin:24px auto;padding:0 14px;font:15px/1.5 'Century Gothic','Segoe UI',sans-serif;background:#e2dccd;color:#1b1510}h1{font-size:20px;color:#2e5231}table{width:100%;border-collapse:collapse;background:#f5eedd;border:1px solid #c9bfae}td{padding:6px 10px;border-bottom:1px solid #c9bfae;vertical-align:top}td:first-child{width:32%;color:#443a2d}.s{font-size:12px;color:#8d7c64;margin-top:10px}</style></head><body>
<h1>This computer</h1><table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
<p class="s">Read just now (${esc(now.toLocaleString('en-GB'))}) from this computer by the Mobius device helper. Nothing here leaves it. Refresh the page to read again.</p></body></html>`;
}

export function createServer({ collect = readMachine, origins = ORIGINS, ttlMs = 20000, log = null } = {}) {
  let cache = null, at = 0;
  const lastLogged = new Map();
  // What reached the helper, so "the page could not reach it" can be told from "it asked and was refused": every refusal, and a successful
  // request once per ten minutes per page. No request bodies, no data from the machine.
  const note = (req, res) => {
    if (!log) return;
    const key = `${req.method} ${String(req.url || '').split('?')[0]} ${req.headers.origin ?? '-'}`, now = Date.now();
    if (res.statusCode < 400 && now - (lastLogged.get(key) || 0) < 600000) return;
    lastLogged.set(key, now);
    log(`${new Date().toISOString()}  ${key}  host=${req.headers.host || '-'}  ->  ${res.statusCode}`);
  };
  const send = (res, code, body, extra = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(JSON.stringify(body));
  };
  return http.createServer(async (req, res) => {
    res.on('finish', () => note(req, res));
    try {
      if (!HOST_OK.test(String(req.headers.host || ''))) return send(res, 403, { error: 'wrong host' });
      const origin = req.headers.origin;
      const cors = {};
      if (origin !== undefined) {
        if (!origins.includes(origin)) return send(res, 403, { error: 'this page is not allowed to ask' });
        Object.assign(cors, { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' });
      }
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      if (req.method !== 'GET') return send(res, 405, { error: 'read only' }, { ...cors, Allow: 'GET' });
      const path = String(req.url || '').split('?')[0];
      if (path === '/ping') return send(res, 200, { ok: true, helper: 1 }, cors);
      if (path === '/') { // the same facts as a page, for opening on this computer; it cannot be framed or run scripts
        if (!cache || Date.now() - at > ttlMs) { cache = tidy(await collect()); at = Date.now(); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
        return res.end(renderPage(cache));
      }
      if (path === '/device') {
        if (!cache || Date.now() - at > ttlMs) { cache = tidy(await collect()); at = Date.now(); }
        return send(res, 200, cache, cors);
      }
      return send(res, 404, { error: 'nothing here' }, cors);
    } catch { return send(res, 500, { error: 'could not read this computer' }); }
  });
}

// Run directly (npm run device-helper, or the Startup script)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer({ log: console.log });
  server.on('error', e => { if (e.code === 'EADDRINUSE') { console.log(`already running on port ${PORT}`); process.exit(0); } console.error(e.message); process.exit(1); });
  server.listen(PORT, '127.0.0.1', () => console.log(`Mobius device helper on 127.0.0.1:${PORT}: read-only; answers only the Mobius pages. Stop it by deleting MobiusDeviceHelper.vbs from the Startup folder and ending this process.`));
}
