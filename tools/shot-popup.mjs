/* 把 popup 實際渲染出來截圖（帶假 chrome API），用來確認使用者看到的畫面。 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : path.resolve(HERE, '..', '..', 'DSH引用助手-V2');
const CHROME = process.env.CHROME || (fs.existsSync('/opt/chrome-linux64/chrome') ? '/opt/chrome-linux64/chrome' : 'C:\Program Files\Google\Chrome\Application\chrome.exe');
const OUT = path.resolve(HERE, 'popup-shot.png');
const PORT = 8796;
const CDP_PORT = 9338;

const MOCK = `(() => {
  const store = { dshQuoteSettings: { enabled: true, showCopy: true, breakLine: true, scope: 'conversation', format: 'double' },
                  dshQuoteSites: ['https://192.168.1.5/*'] };
  const later = (fn, value) => { if (typeof fn === 'function') setTimeout(() => fn(value), 0); };
  window.chrome = {
    runtime: { lastError: undefined, sendMessage() { return Promise.resolve({}); } },
    storage: { local: {
      get(keys, fn) { const key = typeof keys === 'string' ? keys : null; const out = {}; if (key) out[key] = store[key]; else Object.assign(out, store); later(fn, out); },
      set(obj) { Object.assign(store, obj); return Promise.resolve(); }
    } },
    permissions: { request(o, fn) { later(fn, true); }, remove(o, fn) { later(fn, true); } }
  };
})();`;

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const send = (type, body) => {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  if (url === '/' || url === '/popup.html') {
    const html = fs.readFileSync(path.join(EXT, 'popup', 'popup.html'), 'utf8').replace(
      '<script src="../sites.js"></script>',
      '<script src="/mock-chrome.js"></script>\n    <script src="../sites.js"></script>'
    );
    return send('text/html; charset=utf-8', html);
  }
  if (url === '/mock-chrome.js') return send('text/javascript; charset=utf-8', MOCK);
  if (url === '/sites.js') return send('text/javascript; charset=utf-8', fs.readFileSync(path.join(EXT, 'sites.js')));
  if (url === '/popup.js') return send('text/javascript; charset=utf-8', fs.readFileSync(path.join(EXT, 'popup', 'popup.js')));
  if (url === '/popup.css') return send('text/css; charset=utf-8', fs.readFileSync(path.join(EXT, 'popup', 'popup.css')));
  res.writeHead(404);
  res.end('nf');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let id = 0;
function send(socket, method, params) {
  const myId = (id += 1);
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id !== myId) return;
      socket.removeEventListener('message', onMessage);
      if (payload.error) reject(new Error(JSON.stringify(payload.error)));
      else resolve(payload.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id: myId, method, params }));
  });
}

const main = async () => {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const profile = path.join(os.tmpdir(), 'popup-shot-' + Date.now());
  const chrome = spawn(CHROME, ['--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=268,900', `http://127.0.0.1:${PORT}/popup.html`], { stdio: 'ignore' });
  let socket = null;
  try {
    let page = null;
    for (let i = 0; i < 60 && !page; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page' && t.url.indexOf(`127.0.0.1:${PORT}`) !== -1);
      } catch (err) {
        /* wait */
      }
      if (!page) await sleep(250);
    }
    if (!page) throw new Error('no target');
    socket = await new Promise((resolve, reject) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      ws.addEventListener('open', () => resolve(ws), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws')), { once: true });
    });
    await send(socket, 'Runtime.enable', {});
    await sleep(700);
    const metrics = await send(socket, 'Runtime.evaluate', {
      expression: `JSON.stringify({ w: document.body.scrollWidth, h: document.body.scrollHeight, hasInput: !!document.getElementById('siteInput'), rows: document.querySelectorAll('#siteList li').length, inputRect: (()=>{const r=document.getElementById('siteInput').getBoundingClientRect();return {top:Math.round(r.top),left:Math.round(r.left),w:Math.round(r.width),h:Math.round(r.height)};})(), sectionTexts: Array.from(document.querySelectorAll('h2')).map(h=>h.textContent) })`,
      returnByValue: true
    });
    console.log('LAYOUT=' + metrics.result.value);
    await send(socket, 'Emulation.setDeviceMetricsOverride', { width: 280, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(300);
    const shot = await send(socket, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log('WROTE ' + OUT);
  } finally {
    if (socket) socket.close();
    try {
      chrome.kill();
    } catch (err) {
      /* ignore */
    }
    await sleep(400);
    server.close();
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (err) {
      /* ignore */
    }
  }
};

main().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
