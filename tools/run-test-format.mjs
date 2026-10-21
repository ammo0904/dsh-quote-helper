/* V2.3 驗證：引用格式（雙引號／中文引號／Markdown／原文）＋「引用後換行」游標位置。
   在真實 Lexical 0.49 模擬頁上驅動 quote.js：
   框選 → 點「引用」→ 檢查模型文字 → 再模擬使用者直接打字，確認游標已在新的一行。 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : path.resolve(HERE, '..', '..', 'DSH引用助手-V2');
const CHROME = process.env.CHROME || (fs.existsSync('/opt/chrome-linux64/chrome') ? '/opt/chrome-linux64/chrome' : 'C:\Program Files\Google\Chrome\Application\chrome.exe');
const PORT = 8794;
const CDP_PORT = 9336;

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
  const modelText = () => editor.getEditorState().read(() => editor.getEditorState()._nodeMap.get('root').getTextContent());

  const reset = async () => {
    editor.update(() => {
      const root = window.__t.$getRoot();
      root.clear();
      root.append(window.__t.$createParagraphNode());
    }, { discrete: true });
    await sleep(60);
  };
  const cfg = async (attrs) => {
    const keys = ['data-dshq-format', 'data-dshq-break', 'data-dshq-copy'];
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
  const waitQuote = async () => {
    for (let i = 0; i < 160; i += 1) {
      const root = bar();
      const barEl = root && root.querySelector('.dq-bar');
      const btn = root && root.querySelector('.dq-quote');
      if (barEl && !barEl.hidden && btn && !btn.hidden) return btn;
      await sleep(25);
    }
    return null;
  };
  const quoteP1 = async () => {
    await reset();
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    selectEl(document.getElementById('p1'));
    const btn = await waitQuote();
    if (!btn) return { error: 'no button' };
    btn.click();
    await sleep(700);
    return { model: modelText() };
  };
  /* 模擬使用者直接打字：從目前游標插入文字 */
  const typeAfter = async (text) => {
    editor.update(() => {
      const state = editor._pendingEditorState;
      const sel = state && state._selection;
      if (sel && typeof sel.insertText === 'function') sel.insertText(text);
    }, { discrete: true });
    await sleep(120);
    return modelText();
  };

  const out = { cases: {} };

  /* 1. 預設（沒有任何 data-* 屬性）＝雙引號 + 換行 */
  await cfg({});
  const c1 = await quoteP1();
  out.cases.default = { model: c1.model, afterType: await typeAfter('後續') };

  /* 2. 雙引號（明確指定）＋換行 */
  await cfg({ 'data-dshq-format': 'double', 'data-dshq-break': '1' });
  const c2 = await quoteP1();
  out.cases.double = { model: c2.model, afterType: await typeAfter('後續') };

  /* 3. 中文引號 ＋換行 */
  await cfg({ 'data-dshq-format': 'corner', 'data-dshq-break': '1' });
  const c3 = await quoteP1();
  out.cases.corner = { model: c3.model, afterType: await typeAfter('後續') };

  /* 4. Markdown 引用 ＋換行 */
  await cfg({ 'data-dshq-format': 'markdown', 'data-dshq-break': '1' });
  const c4 = await quoteP1();
  out.cases.markdown = { model: c4.model, afterType: await typeAfter('後續') };

  /* 5. 原文照貼＋換行 */
  await cfg({ 'data-dshq-format': 'plain', 'data-dshq-break': '1' });
  const c5 = await quoteP1();
  out.cases.plain = { model: c5.model, afterType: await typeAfter('後續') };

  /* 6. 關掉換行：游標應緊接在引號後面（打字不會換行） */
  await cfg({ 'data-dshq-format': 'double', 'data-dshq-break': '0' });
  const c6 = await quoteP1();
  out.cases.noBreak = { model: c6.model, afterType: await typeAfter('後續') };

  /* 7. 多行程式碼區塊：內部換行要保留、外層包引號 */
  await cfg({ 'data-dshq-format': 'double', 'data-dshq-break': '0' });
  await reset();
  document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  selectEl(document.getElementById('code'));
  const codeBtn = await waitQuote();
  if (codeBtn) codeBtn.click();
  await sleep(700);
  out.cases.codeBlock = { model: modelText() };

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
  const profileDir = path.join(os.tmpdir(), 'dsh-quote-format-' + Date.now());
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
    const c = (v && v.cases) || {};
    const shown = (x) => JSON.stringify(x && x.model);
    check('預設＝雙引號', c.default && c.default.model.indexOf('“第一段：引用功能的測試文字。”') !== -1, shown(c.default));
    check('預設＝引用後換行（打字落在下一行）', c.default && /”\n+後續/.test(c.default.afterType), JSON.stringify(c.default && c.default.afterType));
    check('雙引號格式正確', c.double && c.double.model.indexOf('“第一段：引用功能的測試文字。”') !== -1, shown(c.double));
    check('中文引號格式正確', c.corner && c.corner.model.indexOf('「第一段：引用功能的測試文字。」') !== -1, shown(c.corner));
    check('中文引號後換行', c.corner && /」\n+後續/.test(c.corner.afterType), JSON.stringify(c.corner && c.corner.afterType));
    check('Markdown 格式正確', c.markdown && c.markdown.model.indexOf('> 第一段：引用功能的測試文字。') !== -1, shown(c.markdown));
    check('原文照貼沒有引號', c.plain && c.plain.model.indexOf('第一段：引用功能的測試文字。') !== -1 && c.plain.model.indexOf('“') === -1, shown(c.plain));
    check('關掉換行時游標緊接引號', c.noBreak && /”後續/.test(c.noBreak.afterType), JSON.stringify(c.noBreak && c.noBreak.afterType));
    check('程式碼區塊保留內部換行', c.codeBlock && /”/.test(c.codeBlock.model) && (c.codeBlock.model.match(/\n/g) || []).length >= 3, JSON.stringify(c.codeBlock && c.codeBlock.model?.slice(0, 120)));

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
