/* V2.8 驗證：「引用＋執行」按鈕。
   在真實 Lexical 0.49 模擬頁上驅動 quote.js：
   1. 選取後三顆按鈕都在（引用／引用＋執行／複製）。
   2. 按「引用＋執行」→ 內容＝引用格式＋換行＋執行文字，且自動送出。
   3. 頁面用 KEY_ENTER_COMMAND（與 DSH 同優先級 4）模擬送出：收到事件、清空草稿。
   4. 執行文字可自訂（data-dshq-exec-text），「引用後換行」關掉也強制換行。
   5. 先「引用」再「引用＋執行」→ 兩段之間空一行。
   用法：node tools/run-test-exec.mjs（可用環境變數 CHROME 指定 Chrome 路徑） */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : path.resolve(HERE, '..');
const CHROME = process.env.CHROME || (fs.existsSync('/opt/chrome-linux64/chrome') ? '/opt/chrome-linux64/chrome' : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const PORT = 8797;
const CDP_PORT = 9338;

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const send = (type, body) => {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  if (url === '/' || url === '/index.html') return send('text/html; charset=utf-8', fs.readFileSync(path.join(HERE, 'index.html')));
  if (url === '/lexical.mjs') return send('text/javascript; charset=utf-8', fs.readFileSync(path.join(HERE, 'lexical.mjs')));
  if (url === '/quote.js') return send('text/javascript; charset=utf-8', fs.readFileSync(path.join(EXT, 'content', 'quote.js')));
  res.writeHead(404);
  res.end('not found');
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGE_SCRIPT = `(async () => {
  const lex = await import('./lexical.mjs');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !window.__ready; i += 1) await sleep(50);
  for (let i = 0; i < 120 && window.__dshQuoteHelper !== true; i += 1) await sleep(50);

  const editor = window.__t.editor;
  const modelText = () => editor.getEditorState().read(() => editor.getEditorState()._nodeMap.get('root').getTextContent());

  /* 模擬 DSH 的送出：DSH 在 KEY_ENTER_COMMAND（優先級 4）上呼叫 submit，
     送出後清空草稿。這裡做同樣的事，讓擴充套件的「草稿變空＝送出成功」判定成立。 */
  window.__enterEvents = [];
  window.__sent = [];
  editor.registerCommand(lex.KEY_ENTER_COMMAND, (event) => {
    window.__enterEvents.push({ key: event && event.key, trusted: !!(event && event.isTrusted) });
    window.__sent.push(modelText());
    editor.update(() => {
      const root = lex.$getRoot();
      root.clear();
      root.append(lex.$createParagraphNode());
    }, { discrete: true });
    return true;
  }, 4);

  const reset = async () => {
    editor.update(() => {
      const root = lex.$getRoot();
      root.clear();
      root.append(lex.$createParagraphNode());
    }, { discrete: true });
    window.__enterEvents.length = 0;
    window.__sent.length = 0;
    await sleep(60);
  };
  const cfg = async (attrs) => {
    const keys = ['data-dshq-format', 'data-dshq-break', 'data-dshq-copy', 'data-dshq-exec-text'];
    keys.forEach((k) => document.documentElement.removeAttribute(k));
    Object.keys(attrs).forEach((k) => document.documentElement.setAttribute(k, attrs[k]));
    await sleep(90);
  };
  const bar = () => {
    const h = document.getElementById('__dsh-quote-helper__');
    return h && h.shadowRoot ? h.shadowRoot : null;
  };
  const selectEl = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
  };
  const waitBar = async (kind) => {
    for (let i = 0; i < 160; i += 1) {
      const root = bar();
      const barEl = root && root.querySelector('.dq-bar');
      const btn = root && root.querySelector(kind);
      if (barEl && !barEl.hidden && btn && !btn.hidden) return btn;
      await sleep(25);
    }
    return null;
  };
  const toastText = () => {
    const root = bar();
    const t = root && root.querySelector('.dq-toast');
    return t && !t.hidden ? t.textContent : '';
  };
  /* 模擬「使用者用滑鼠在對話區點一下」：輸入框失焦（與 V2.4 測試一致） */
  const clickConversation = () => {
    const active = document.activeElement;
    if (active && typeof active.blur === 'function') active.blur();
    document.body.focus();
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  };
  const clickKind = async (el, kind) => {
    clickConversation();
    await sleep(80);
    selectEl(el);
    const btn = await waitBar(kind);
    if (!btn) return { error: 'no ' + kind + ' button' };
    btn.click();
    await sleep(800);
    return { model: modelText(), sent: window.__sent.slice(), enters: window.__enterEvents.slice(), toast: toastText() };
  };

  const out = { cases: {} };

  /* 1. 三顆按鈕都要出現 */
  await reset();
  await cfg({});
  clickConversation();
  await sleep(80);
  selectEl(document.getElementById('p1'));
  await waitBar('.dq-quote');
  const root1 = bar();
  const barEl = root1 && root1.querySelector('.dq-bar');
  const visible = (sel) => {
    const n = root1 && root1.querySelector(sel);
    return !!(n && !n.hidden);
  };
  out.cases.buttons = {
    barVisible: !!(barEl && !barEl.hidden),
    quote: visible('.dq-quote'),
    exec: visible('.dq-exec'),
    copy: visible('.dq-copy'),
    execLabel: (root1 && root1.querySelector('.dq-exec span') && root1.querySelector('.dq-exec span').textContent) || ''
  };
  await sleep(50);

  /* 2. 預設：引用＋換行＋執行！（送出後草稿要變空） */
  await reset();
  await cfg({});
  out.cases.default = await clickKind(document.getElementById('p1'), '.dq-exec');

  /* 3. 自訂執行文字 */
  await reset();
  await cfg({ 'data-dshq-exec-text': '開始吧' });
  out.cases.customText = await clickKind(document.getElementById('p1'), '.dq-exec');

  /* 4. 關掉「引用後換行」也一定要換行到執行文字 */
  await reset();
  await cfg({ 'data-dshq-format': 'plain', 'data-dshq-break': '0' });
  out.cases.noBreak = await clickKind(document.getElementById('p1'), '.dq-exec');

  /* 5. 先引用、再引用＋執行：兩段之間空一行 */
  await reset();
  await cfg({ 'data-dshq-format': 'double', 'data-dshq-break': '1' });
  {
    clickConversation();
    await sleep(80);
    selectEl(document.getElementById('p1'));
    const q = await waitBar('.dq-quote');
    if (q) q.click();
    await sleep(700);
    const before = modelText();
    const second = await clickKind(document.getElementById('p2'), '.dq-exec');
    out.cases.chained = { before: before, model: second.model, sent: second.sent };
  }

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
      /* not up */
    }
    await sleep(250);
  }
  return null;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error('ws failed')), { once: true });
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
  const profileDir = path.join(os.tmpdir(), 'dsh-quote-exec-' + Date.now());
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--window-size=1280,900',
      `http://127.0.0.1:${PORT}/`
    ],
    { stdio: 'ignore' }
  );
  let socket = null;
  try {
    const target = await findTarget();
    if (!target) throw new Error('chrome target not found');
    socket = await connect(target.webSocketDebuggerUrl);
    await send(socket, 'Runtime.enable', {});
    const result = await send(socket, 'Runtime.evaluate', { expression: PAGE_SCRIPT, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      console.log('PAGE EXCEPTION:', JSON.stringify(result.exceptionDetails, null, 2));
      process.exitCode = 1;
    }
    const v = result.result && result.result.value;
    console.log(JSON.stringify(v, null, 2));

    const fails = [];
    const check = (name, pass, detail) => {
      if (!pass) fails.push(name + (detail ? ' :: ' + detail : ''));
    };
    const c = (v && v.cases) || {};
    const j = (x) => JSON.stringify(x);

    check('三顆按鈕都顯示', c.buttons && c.buttons.barVisible && c.buttons.quote && c.buttons.exec && c.buttons.copy, j(c.buttons));
    check('按鈕文字＝引用＋執行', c.buttons && c.buttons.execLabel === '引用＋執行', j(c.buttons && c.buttons.execLabel));

    /* 送出成功時草稿會被清空，所以插入內容要看送出當下的 __sent（模型文字）。 */
    const sentOf = (x) => (x && x.sent && x.sent[0]) || '';
    check('預設插入＝引用＋換行＋執行！', sentOf(c.default) === '“第一段：引用功能的測試文字。”\n執行！', j(sentOf(c.default)));
    check('預設會自動送出（草稿清空、只送一次）', c.default && c.default.sent && c.default.sent.length === 1 && c.default.model === '', j(c.default && { sent: c.default.sent, model: c.default.model }));
    check('送出路徑＝合成 Enter 事件', c.default && c.default.enters && c.default.enters[0] && c.default.enters[0].key === 'Enter' && c.default.enters[0].trusted === false, j(c.default && c.default.enters));
    check('成功提示＝已引用並送出', c.default && /已引用並送出/.test(c.default.toast || ''), j(c.default && c.default.toast));

    check('自訂執行文字生效', sentOf(c.customText) === '“第一段：引用功能的測試文字。”\n開始吧', j(sentOf(c.customText)));
    check('自訂文字也會自動送出', c.customText && c.customText.sent && c.customText.sent.length === 1, j(c.customText && c.customText.sent));

    check('關掉換行仍換行到執行文字', sentOf(c.noBreak) === '第一段：引用功能的測試文字。\n執行！', j(sentOf(c.noBreak)));

    check('先引用再加執行＝兩段間空一行', sentOf(c.chained) === '“第一段：引用功能的測試文字。”\n\n“Second line, English text for the test.”\n執行！', j(sentOf(c.chained)));

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
