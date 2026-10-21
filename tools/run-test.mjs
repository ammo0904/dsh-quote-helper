/* 用 Chrome headless + CDP 對「DSH 引用助手」做端到端驗證：
   在模擬頁面（真實 Lexical 0.49 編輯器 + DSH 的 data-* 結構）上，
   程式化選取文字 → 觸發浮動按鈕 → 點擊 → 檢查輸入框內容。 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QUOTE_JS = process.env.QUOTE_JS
  ? path.resolve(process.env.QUOTE_JS)
  : path.resolve(HERE, '..', '..', 'DSH引用助手-V1', 'content', 'quote.js');
const USE_EXTENSION = process.env.USE_EXTENSION === '1';
const EXTENSION_DIR = path.resolve(HERE, '..', '..', 'DSH引用助手-V1');
const CHROME = process.env.CHROME || (fs.existsSync('/opt/chrome-linux64/chrome') ? '/opt/chrome-linux64/chrome' : 'C:\Program Files\Google\Chrome\Application\chrome.exe');
const PORT = 8791;
const CDP_PORT = 9333;

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  let file = null;
  let type = 'text/plain; charset=utf-8';
  if (url === '/' || url === '/index.html') {
    file = path.join(HERE, 'index.html');
    type = 'text/html; charset=utf-8';
  } else if (url === '/lexical.mjs') {
    file = path.join(HERE, 'lexical.mjs');
    type = 'text/javascript; charset=utf-8';
  } else if (url === '/quote.js') {
    file = QUOTE_JS;
    type = 'text/javascript; charset=utf-8';
  }
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end('not found: ' + url);
    return;
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  if (USE_EXTENSION && type.indexOf('text/html') === 0) {
    /* 用擴充套件注入時，把頁面裡的手動 <script> 拿掉，確保是擴充套件自己在跑。 */
    const html = fs.readFileSync(file, 'utf8').replace('<script src="./quote.js"></script>', '');
    res.end(html);
    return;
  }
  res.end(fs.readFileSync(file));
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launchChrome(profileDir) {
  const args = [
    '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,900'
  ];
  if (USE_EXTENSION) {
    args.push(`--load-extension=${EXTENSION_DIR}`, `--disable-extensions-except=${EXTENSION_DIR}`);
  } else {
    args.push('--disable-extensions');
  }
  if (process.env.EXTRA_FLAGS) {
    for (const flag of process.env.EXTRA_FLAGS.split(' ')) {
      if (flag.trim()) args.push(flag.trim());
    }
  }
  args.push(`http://127.0.0.1:${PORT}/`);
  return spawn(CHROME, args, { stdio: 'ignore' });
}

async function findTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await response.json();
      const page = list.find((item) => item.type === 'page' && item.url.indexOf(`127.0.0.1:${PORT}`) !== -1);
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (err) {
      /* Chrome 還沒起來 */
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

const PAGE_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { steps: [] };
  for (let i = 0; i < 60 && !window.__ready; i += 1) await sleep(50);
  if (!window.__ready) return { error: 'page not ready' };

  /* 等擴充套件的內容腳本注入（只有 USE_EXTENSION 模式才需要等）。 */
  for (let i = 0; i < 100 && window.__dshQuoteHelper !== true; i += 1) await sleep(50);
  out.helperFlag = window.__dshQuoteHelper === true;
  out.htmlSettings = {
    enabled: document.documentElement.getAttribute('data-dshq-enabled'),
    scope: document.documentElement.getAttribute('data-dshq-scope'),
    format: document.documentElement.getAttribute('data-dshq-format')
  };

  const host = document.getElementById('host');
  const getBtn = () => {
    const shadowHost = document.getElementById('__dsh-quote-helper__');
    return shadowHost && shadowHost.shadowRoot ? shadowHost.shadowRoot.querySelector('.dq-btn') : null;
  };

  out.editorAttached = !!host.__lexicalEditor;
  out.dataLexicalEditor = host.getAttribute('data-lexical-editor');

  const modelText = () => {
    try {
      const state = window.__t.editor.getEditorState();
      return state.read(() => {
        const root = state._nodeMap.get('root');
        return root.getTextContent();
      });
    } catch (err) {
      return 'ERR:' + err.message;
    }
  };
  const domInfo = () => ({ html: host.innerHTML, text: host.textContent, paragraphs: host.querySelectorAll('p').length });

  const waitButton = async () => {
    for (let i = 0; i < 60; i += 1) {
      const candidate = getBtn();
      if (candidate && !candidate.hidden) return true;
      await sleep(25);
    }
    return false;
  };

  const selectNodeContents = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
  };

  const traceAfterClick = async (label, ms) => {
    const samples = [];
    const started = Date.now();
    while (Date.now() - started < ms) {
      samples.push({
        t: Date.now() - started,
        model: modelText(),
        dom: host.textContent,
        html: host.innerHTML.length,
        strategies: (window.__strategies || []).length
      });
      await sleep(40);
    }
    return { label, samples };
  };

  /* 等「這次點擊」真的處理完（instrumented 版本會記錄策略），避免測試自己打架。 */
  const waitStrategy = async (expected) => {
    if (!window.__strategies) {
      await sleep(1200);
      return;
    }
    for (let i = 0; i < 160; i += 1) {
      if (window.__strategies.length >= expected) return;
      await sleep(50);
    }
  };

  /* ---------- 情境 1：空草稿，框選第一段 ---------- */
  try {
    selectNodeContents(document.getElementById('p1'));
    out.s1_buttonShown = await waitButton();
    const shown = getBtn();
    out.s1_position = shown ? { top: shown.style.top, left: shown.style.left, text: shown.textContent.trim() } : null;
    out.s1_selectionBeforeClick = String(window.getSelection());
    if (shown) shown.click();
    out.s1_trace = await traceAfterClick('s1', 1800);
    await waitStrategy(1);
    out.s1_model = modelText();
    out.s1_dom = domInfo();
    out.s1_editorError = window.__editorError || null;
  } catch (err) {
    out.s1_error = String(err);
  }

  /* ---------- 情境 2：草稿中有文字、游標在第 3 個字後，框選兩段 ---------- */
  try {
    window.__t.editor.update(() => {
      const root = window.__t.$getRoot();
      root.clear();
      const paragraph = window.__t.$createParagraphNode();
      paragraph.append(window.__t.$createTextNode('ABCDEF'));
      root.append(paragraph);
    }, { discrete: true });
    await sleep(80);

    out.s2_afterReset = domInfo();

    const paragraphEl = host.querySelector('p');
    let textNode = null;
    if (paragraphEl) {
      for (const child of paragraphEl.childNodes) {
        if (child.nodeType === 3 && child.data.length >= 3) {
          textNode = child;
          break;
        }
        if (child.nodeType === 1 && child.firstChild && child.firstChild.nodeType === 3 && child.firstChild.data.length >= 3) {
          textNode = child.firstChild;
          break;
        }
      }
    }
    out.s2_foundTextNode = !!textNode;
    if (textNode) {
      const caret = document.createRange();
      caret.setStart(textNode, 3);
      caret.collapse(true);
      const caretSelection = window.getSelection();
      caretSelection.removeAllRanges();
      caretSelection.addRange(caret);
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
      await sleep(200);
    }
    out.s2_caretModel = modelText();

    const span = document.createRange();
    span.setStartBefore(document.getElementById('p1'));
    span.setEndAfter(document.getElementById('p2'));
    const spanSelection = window.getSelection();
    spanSelection.removeAllRanges();
    spanSelection.addRange(span);
    out.s2_selectionText = JSON.stringify(String(window.getSelection()));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
    out.s2_buttonShown = await waitButton();
    const shown2 = getBtn();
    if (shown2) shown2.click();
    await waitStrategy(2);
    out.s2_model = modelText();
    out.s2_dom = domInfo();
    out.s2_editorError = window.__editorError || null;
  } catch (err) {
    out.s2_error = String(err);
  }

  /* ---------- 情境 3：在輸入框內選取文字時，不應出現按鈕 ---------- */
  try {
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const innerRange = document.createRange();
    innerRange.selectNodeContents(host);
    const innerSelection = window.getSelection();
    innerSelection.removeAllRanges();
    innerSelection.addRange(innerRange);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
    await sleep(300);
    const b3 = getBtn();
    out.s3_buttonHidden = !b3 || b3.hidden;
  } catch (err) {
    out.s3_error = String(err);
  }

  /* ---------- 情境 4：多行程式碼區塊（<pre>） ---------- */
  try {
    window.__t.editor.update(() => {
      const root = window.__t.$getRoot();
      root.clear();
      root.append(window.__t.$createParagraphNode());
    }, { discrete: true });
    await sleep(80);

    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    selectNodeContents(document.getElementById('code'));
    out.s4_selectionText = JSON.stringify(String(window.getSelection()));
    out.s4_buttonShown = await waitButton();
    const shown4 = getBtn();
    if (shown4) shown4.click();
    await waitStrategy(3);
    out.s4_model = modelText();
    out.s4_dom = domInfo();
    out.s4_editorError = window.__editorError || null;
  } catch (err) {
    out.s4_error = String(err);
  }

  out.strategies = window.__strategies || null;
  return out;
})()`;

async function main() {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log('static server on http://127.0.0.1:' + PORT);

  const profileDir = path.join(os.tmpdir(), 'dsh-quote-cdp-' + Date.now());
  const chrome = launchChrome(profileDir);
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
    }
    console.log('RESULT:');
    console.log(JSON.stringify(result.result && result.result.value, null, 2));
  } finally {
    if (socket) socket.close();
    try {
      chrome.kill();
    } catch (err) {
      /* ignore */
    }
    await sleep(600);
    server.close();
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (err) {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
