/* V2.2 popup 端到端驗證：Chrome headless + CDP 載入真正的 popup.html／popup.js／sites.js，
   只把 chrome.* API 換成假的（記錄呼叫），驗證「自行新增／移除網址」的完整流程：
   授權請求、清單渲染、重複／內建／被拒絕／格式錯誤的提示、移除時撤銷權限。 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : path.resolve(HERE, '..', '..', 'DSH引用助手-V2');
const CHROME = process.env.CHROME || (fs.existsSync('/opt/chrome-linux64/chrome') ? '/opt/chrome-linux64/chrome' : 'C:\Program Files\Google\Chrome\Application\chrome.exe');
const PORT = 8793;
const CDP_PORT = 9335;
const MANIFEST_VERSION = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;

const MOCK = `(() => {
  const store = { dshQuoteSites: ['https://pre.example.com/*'] };
  const log = { request: [], remove: [], messages: [], sets: [] };
  window.__log = log;
  window.__store = store;
  window.__grant = true;
  const later = (fn, value) => { if (typeof fn === 'function') setTimeout(() => fn(value), 0); };
  window.chrome = {
    runtime: {
      lastError: undefined,
      getManifest() { return { name: 'DSH 引用助手', version: '${MANIFEST_VERSION}' }; },
      sendMessage(message) { log.messages.push(message); return Promise.resolve({ registered: [], failed: [] }); }
    },
    storage: {
      local: {
        get(keys, fn) {
          const key = typeof keys === 'string' ? keys : (Array.isArray(keys) ? keys[0] : null);
          const out = {};
          if (key) out[key] = store[key];
          else Object.assign(out, store);
          later(fn, out);
        },
        set(obj) {
          Object.assign(store, obj);
          log.sets.push(JSON.parse(JSON.stringify(obj)));
          return Promise.resolve();
        }
      }
    },
    permissions: {
      request(options, fn) { log.request.push(options); later(fn, window.__grant); },
      remove(options, fn) { log.remove.push(options); later(fn, true); }
    }
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
  res.end('not found');
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGE_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [] };
  const rows = () => Array.from(document.querySelectorAll('#siteList li')).map((li) => ({
    pattern: li.getAttribute('data-pattern'),
    text: li.querySelector('.site-name').textContent,
    builtin: !!li.querySelector('.tag'),
    removable: !!li.querySelector('.rm')
  }));
  const msg = () => {
    const el = document.getElementById('siteMsg');
    return el && !el.hidden ? el.textContent : '';
  };
  const setInput = (value) => {
    const input = document.getElementById('siteInput');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const clickAdd = async () => {
    document.getElementById('siteAdd').click();
    await sleep(120);
  };

  for (let i = 0; i < 80 && !document.querySelector('#siteList li'); i += 1) await sleep(50);
  out.versionBadge = (() => {
    const el = document.getElementById('ver');
    return el ? el.textContent : null;
  })();
  out.initial = rows();
  out.initialBuiltinCount = out.initial.filter((r) => r.builtin).length;
  out.initialCustom = out.initial.filter((r) => !r.builtin).map((r) => r.pattern);

  /* 1.5 「執行文字」欄位：預設值與修改後存檔 */
  const execInput = document.getElementById('execText');
  out.execText = { exists: !!execInput, value: execInput ? execInput.value : null };
  if (execInput) {
    execInput.value = '開始吧';
    execInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);
    out.execText.saved = JSON.parse(JSON.stringify(window.__store.dshQuoteSettings || {}));
  }

  /* 1. 正常新增：帶 port 的區網網址 */
  setInput('https://192.168.1.5:3080');
  await clickAdd();
  out.add = {
    request: JSON.parse(JSON.stringify(window.__log.request)),
    stored: JSON.parse(JSON.stringify(window.__store.dshQuoteSites)),
    rows: rows().length,
    msg: msg(),
    messages: JSON.parse(JSON.stringify(window.__log.messages))
  };

  /* 2. 重複新增同一網址 */
  setInput('https://192.168.1.5/*');
  await clickAdd();
  out.duplicate = { msg: msg(), requests: window.__log.request.length, rows: rows().length };

  /* 3. 內建網址 */
  setInput('http://127.0.0.1:3080');
  await clickAdd();
  out.builtinAttempt = { msg: msg(), requests: window.__log.request.length };

  /* 4. 使用者按「拒絕」 */
  window.__grant = false;
  setInput('https://deny.example.com');
  await clickAdd();
  out.denied = {
    msg: msg(),
    stored: JSON.parse(JSON.stringify(window.__store.dshQuoteSites)),
    rows: rows().length
  };
  window.__grant = true;

  /* 5. 格式錯誤 */
  setInput('ftp://nope.example.com');
  await clickAdd();
  out.invalid = { msg: msg(), requests: window.__log.request.length };

  /* 6. 移除自訂網址 */
  const target = document.querySelector('#siteList li[data-pattern="https://192.168.1.5/*"] .rm');
  out.hasRemoveButton = !!target;
  if (target) {
    target.click();
    await sleep(120);
  }
  out.remove = {
    removed: JSON.parse(JSON.stringify(window.__log.remove)),
    stored: JSON.parse(JSON.stringify(window.__store.dshQuoteSites)),
    rows: rows().length,
    msg: msg()
  };

  /* 7. Enter 鍵也能新增 */
  const input = document.getElementById('siteInput');
  input.value = 'dsh.example.org';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(150);
  out.enterKey = {
    stored: JSON.parse(JSON.stringify(window.__store.dshQuoteSites)),
    rows: rows().length,
    msg: msg()
  };

  return out;
})()`;

async function findTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await response.json();
      const page = list.find((item) => item.type === 'page' && item.url.indexOf(`127.0.0.1:${PORT}`) !== -1);
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (err) {
      /* not up yet */
    }
    await sleep(250);
  }
  return null;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });
}

let messageId = 0;
function send(socket, method, params) {
  const id = (messageId += 1);
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (payload.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (payload.error) reject(new Error(JSON.stringify(payload.error)));
      else resolve(payload.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const main = async () => {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const profileDir = path.join(os.tmpdir(), 'dsh-quote-popup-' + Date.now());
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      `--window-size=420,900`,
      `http://127.0.0.1:${PORT}/popup.html`
    ],
    { stdio: 'ignore' }
  );

  let socket = null;
  try {
    const target = await findTarget();
    if (!target) throw new Error('chrome target not found');
    socket = await connect(target.webSocketDebuggerUrl);
    await send(socket, 'Runtime.enable', {});
    const result = await send(socket, 'Runtime.evaluate', {
      expression: PAGE_SCRIPT,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      console.log('PAGE EXCEPTION:', JSON.stringify(result.exceptionDetails, null, 2));
      process.exitCode = 1;
    }
    const value = result.result && result.result.value;
    console.log(JSON.stringify(value, null, 2));

    /* 斷言 */
    const fails = [];
    const check = (name, pass, detail) => {
      if (!pass) fails.push(name + (detail ? ' :: ' + detail : ''));
    };
    if (!value) {
      fails.push('no result');
    } else {
      check('初始載入 3 個內建網址', value.initialBuiltinCount === 3, JSON.stringify(value.initialBuiltinCount));
      check('popup 有「執行文字」欄位（預設執行！）', value.execText.exists && value.execText.value === '執行！', JSON.stringify(value.execText));
      check('執行文字改了會存檔', value.execText.saved && value.execText.saved.execText === '開始吧', JSON.stringify(value.execText && value.execText.saved));
      check('標題旁顯示版本徽章', value.versionBadge === 'v' + MANIFEST_VERSION, JSON.stringify(value.versionBadge));
      check('初始載入已存的 1 個自訂網址', value.initialCustom.length === 1 && value.initialCustom[0] === 'https://pre.example.com/*', JSON.stringify(value.initialCustom));
      check('新增時要求了正確的 origin', value.add.request.length === 1 && value.add.request[0].origins[0] === 'https://192.168.1.5/*', JSON.stringify(value.add.request));
      check('新增後寫進 storage', value.add.stored.indexOf('https://192.168.1.5/*') !== -1, JSON.stringify(value.add.stored));
      check('新增後清單多一列', value.add.rows === value.initial.length + 1, String(value.add.rows));
      check('新增後有提示', /已加入/.test(value.add.msg), value.add.msg);
      check('新增後通知 background 同步', value.add.messages.some((m) => m.type === 'dshq-sync'), JSON.stringify(value.add.messages));
      check('重複新增被擋下', /已經加過/.test(value.duplicate.msg) && value.duplicate.requests === 1, JSON.stringify(value.duplicate));
      check('內建網址被擋下', /內建/.test(value.builtinAttempt.msg) && value.builtinAttempt.requests === 1, JSON.stringify(value.builtinAttempt));
      check('被拒絕時不寫入', /沒有取得授權/.test(value.denied.msg) && value.denied.stored.indexOf('https://deny.example.com/*') === -1, JSON.stringify(value.denied));
      check('格式錯誤有提示', /只支援/.test(value.invalid.msg) && value.invalid.requests === 2, JSON.stringify(value.invalid));
      check('自訂列有移除按鈕', value.hasRemoveButton === true);
      check('移除時撤銷權限', value.remove.removed.length === 1 && value.remove.removed[0].origins[0] === 'https://192.168.1.5/*', JSON.stringify(value.remove.removed));
      check('移除後清單回到 4 列', value.remove.rows === 4, String(value.remove.rows));
      check('移除後 storage 不含該網址', value.remove.stored.indexOf('https://192.168.1.5/*') === -1, JSON.stringify(value.remove.stored));
      check('Enter 也能新增（自動補 https）', value.enterKey.stored.indexOf('https://dsh.example.org/*') !== -1, JSON.stringify(value.enterKey));
    }
    console.log('---');
    console.log(fails.length ? 'FAILED ' + fails.length + ':\n' + fails.join('\n') : 'ALL CHECKS PASSED');
    if (fails.length) process.exitCode = 1;
  } finally {
    if (socket) socket.close();
    try {
      chrome.kill();
    } catch (err) {
      /* ignore */
    }
    await sleep(500);
    server.close();
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (err) {
      /* ignore */
    }
  }
};

main().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
