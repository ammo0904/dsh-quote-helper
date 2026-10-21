/* V2.4 驗證：連續引用要依序往下排、區塊之間保留空行（不是每次都插回第一行）。
   流程模仿真人：在對話區選字（此時輸入框失焦）→ 按「引用」→ 再選下一段 → 再按。
   檢查模型文字是否變成：
     “第1段”
     (空行)
     “第2段”
     (空行)
     “第3段”
   以及最後游標是否落在新的一行。 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : path.resolve(HERE, '..', '..', 'DSH引用助手-V2');
const CHROME = process.env.CHROME || (fs.existsSync('/opt/chrome-linux64/chrome') ? '/opt/chrome-linux64/chrome' : 'C:\Program Files\Google\Chrome\Application\chrome.exe');
const PORT = 8795;
const CDP_PORT = 9337;
const MANIFEST_VERSION = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;

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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !window.__ready; i += 1) await sleep(50);
  for (let i = 0; i < 120 && window.__dshQuoteHelper !== true; i += 1) await sleep(50);

  const editor = window.__t.editor;
  const host = window.__t.host;
  /* 模擬 bridge.js 寫入的版本屬性 */
  document.documentElement.setAttribute('data-dshq-version', '${MANIFEST_VERSION}');
  const toastText = () => {
    const root = shadow();
    const toast = root && root.querySelector('.dq-toast');
    return toast && !toast.hidden ? toast.textContent : '';
  };
  const modelText = () => editor.getEditorState().read(() => editor.getEditorState()._nodeMap.get('root').getTextContent());
  const shadow = () => {
    const h = document.getElementById('__dsh-quote-helper__');
    return h && h.shadowRoot ? h.shadowRoot : null;
  };
  const barVisible = () => {
    const root = shadow();
    if (!root) return false;
    const bar = root.querySelector('.dq-bar');
    const btn = root.querySelector('.dq-quote');
    return !!bar && !bar.hidden && !!btn && !btn.hidden;
  };
  const waitBar = async () => {
    for (let i = 0; i < 160; i += 1) {
      if (barVisible()) return true;
      await sleep(25);
    }
    return false;
  };
  const selectEl = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
  };
  /* 模擬「使用者用滑鼠在對話區點一下」：輸入框失焦 */
  const clickConversation = () => {
    const active = document.activeElement;
    if (active && typeof active.blur === 'function') active.blur();
    document.body.focus();
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  };
  const quoteFrom = async (el) => {
    clickConversation();
    await sleep(80);
    selectEl(el);
    const ok = await waitBar();
    if (!ok) return { error: 'bar not shown' };
    shadow().querySelector('.dq-quote').click();
    await sleep(700);
    return { model: modelText(), toast: toastText() };
  };

  const out = { steps: {} };
  out.focusedBefore = document.activeElement === host;

  out.steps.first = await quoteFrom(document.getElementById('p1'));
  out.steps.second = await quoteFrom(document.getElementById('p2'));
  out.steps.third = await quoteFrom(document.getElementById('code'));

  const finalModel = modelText();
  out.finalModel = finalModel;

  /* 最後游標位置：直接打一個字，看它落在哪裡 */
  editor.update(() => {
    const state = editor._pendingEditorState;
    const sel = state && state._selection;
    if (sel && typeof sel.insertText === 'function') sel.insertText('尾巴');
  }, { discrete: true });
  await sleep(150);
  out.afterType = modelText();
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
  const profileDir = path.join(os.tmpdir(), 'dsh-quote-multi-' + Date.now());
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
    const model = (v && v.finalModel) || '';
    check('三次引用都在', (model.match(/“/g) || []).length === 3, JSON.stringify(model));
    check('第一段在最前面（不是被擠到別處）', model.indexOf('“第一段：引用功能的測試文字。”') === 0, JSON.stringify(model.slice(0, 40)));
    check('第 1、2 段之間有空行', /”\n\n“Second line/.test(model), JSON.stringify(model));
    check('第 2、3 段之間有空行', /test\.”\n\n“const a = 1;/.test(model), JSON.stringify(model));
    check('程式碼區塊內部換行保留', /“const a = 1;\nif \(a\) \{\n  console\.log\(a\);\n\}”/.test(model), JSON.stringify(model));
    check('最後游標在新的一行（打字落在最後一段之後）', v && /”\n+尾巴/.test(v.afterType), JSON.stringify(v && v.afterType));
    check('成功提示會顯示版本與格式', v && v.steps && v.steps.first && v.steps.first.toast === '已引用（雙引號 · v' + MANIFEST_VERSION + '）', JSON.stringify(v && v.steps && v.steps.first && v.steps.first.toast));

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
