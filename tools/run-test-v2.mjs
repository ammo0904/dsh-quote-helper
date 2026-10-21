/* V2 端到端驗證：Chrome headless + CDP，在模擬頁（真實 Lexical 0.49 + DSH 的 data-* 結構）
   上驅動 DSH引用助手-V2 的 quote.js，驗證「引用」與新增的「複製」。

   驗證重點：
   1. 框選後同時出現「引用」「複製」兩顆按鈕。
   2. 按「複製」→ 剪貼簿內容＝框選原文（不是 Markdown 加工版）、跳出「已複製」、按鈕不消失。
   3. 按「引用」→ Lexical 模型真的多出文字（V1 功能未回歸）。
   4. 沒有輸入框時 → 只出現「複製」，而且仍可複製。
   5. 「顯示複製按鈕」關掉（data-dshq-copy=0）→ 只剩「引用」。
   6. 兩者都不可用時 → 完全不顯示。
   7. 在輸入框內選取 → 不顯示。
   8. Markdown 格式只影響「引用」，不影響「複製」。
   9. navigator.clipboard 被拒 → 退回 execCommand('copy')。
  10. Esc 關閉按鈕組。 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = process.env.EXT_DIR
  ? path.resolve(process.env.EXT_DIR)
  : path.resolve(HERE, '..', '..', 'DSH引用助手-V2');
const QUOTE_JS = path.join(EXT_DIR, 'content', 'quote.js');
const CHROME = process.env.CHROME || (fs.existsSync('/opt/chrome-linux64/chrome') ? '/opt/chrome-linux64/chrome' : 'C:\Program Files\Google\Chrome\Application\chrome.exe');
const PORT = 8792;
const CDP_PORT = 9334;
const ORIGIN = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync(QUOTE_JS)) {
  console.error('找不到 ' + QUOTE_JS);
  process.exit(1);
}

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
    '--disable-extensions',
    '--window-size=1280,900',
    `${ORIGIN}/`
  ];
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
  const out = { cases: {}, notes: [] };
  const P1 = '第一段：引用功能的測試文字。';
  const P2 = 'Second line, English text for the test.';

  for (let i = 0; i < 80 && !window.__ready; i += 1) await sleep(50);
  for (let i = 0; i < 120 && window.__dshQuoteHelper !== true; i += 1) await sleep(50);
  out.helperInjected = window.__dshQuoteHelper === true;
  if (!out.helperInjected) return out;

  const host = document.getElementById('host');

  /* ---- 剪貼簿探測：記錄我們這支程式呼叫了什麼，也能模擬「被瀏覽器拒絕」 ---- */
  const clip = navigator.clipboard;
  window.__clip = { calls: [], mode: 'ok', realErr: null };
  if (clip && typeof clip.writeText === 'function') {
    const realWrite = clip.writeText.bind(clip);
    navigator.clipboard.writeText = async (text) => {
      window.__clip.calls.push(text);
      if (window.__clip.mode === 'throw') {
        const err = new Error('Document is not focused');
        err.name = 'NotAllowedError';
        throw err;
      }
      try {
        await realWrite(text);
      } catch (err) {
        window.__clip.realErr = String((err && err.name) || err);
      }
    };
  } else {
    out.notes.push('navigator.clipboard 不可用');
  }
  const readClipboard = async () => {
    try {
      return await navigator.clipboard.readText();
    } catch (err) {
      out.notes.push('readText 失敗: ' + ((err && err.name) || err));
      return null;
    }
  };

  /* ---- execCommand 記錄（驗證備援路徑真的被用到） ---- */
  const realExec = document.execCommand.bind(document);
  window.__execCalls = [];
  document.execCommand = (command) => {
    const result = realExec(command);
    window.__execCalls.push({ command, result });
    return result;
  };

  /* ---- UI 存取 ---- */
  const parts = () => {
    const hostEl = document.getElementById('__dsh-quote-helper__');
    const root = hostEl && hostEl.shadowRoot;
    if (!root) return null;
    return {
      bar: root.querySelector('.dq-bar'),
      quote: root.querySelector('.dq-quote'),
      copy: root.querySelector('.dq-copy'),
      toast: root.querySelector('.dq-toast')
    };
  };
  const shown = (el) => !!el && !el.hidden;
  const state = () => {
    const p = parts();
    if (!p) return { bar: false, quote: false, copy: false, text: '' };
    return {
      bar: shown(p.bar),
      quote: shown(p.quote),
      copy: shown(p.copy),
      text: String((p.bar && p.bar.textContent) || '').replace(/\\s+/g, '')
    };
  };
  const waitState = async (want) => {
    for (let i = 0; i < 120; i += 1) {
      const now = state();
      if (now.bar === want.bar && now.quote === want.quote && now.copy === want.copy) return now;
      await sleep(25);
    }
    return state();
  };
  const selectEl = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
  };
  const clearSelection = () => {
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  };
  const modelText = () => {
    try {
      const s = window.__t.editor.getEditorState();
      return s.read(() => s._nodeMap.get('root').getTextContent());
    } catch (err) {
      return 'ERR:' + err.message;
    }
  };
  const resetComposer = async () => {
    window.__t.editor.update(() => {
      const root = window.__t.$getRoot();
      root.clear();
      root.append(window.__t.$createParagraphNode());
    }, { discrete: true });
    await sleep(60);
  };

  /* ---------- 1. 框選 → 兩顆按鈕都在；按「複製」複製原文 ---------- */
  try {
    selectEl(document.getElementById('p1'));
    const s1 = await waitState({ bar: true, quote: true, copy: true });
    out.cases.s1 = {
      state: s1,
      selectionText: String(window.getSelection()),
      barRect: (() => {
        const bar = parts().bar;
        const r = bar.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width) };
      })()
    };
    const before = window.__clip.calls.length;
    parts().copy.click();
    await sleep(150);
    out.cases.s1.copied = window.__clip.calls.length > before ? window.__clip.calls[window.__clip.calls.length - 1] : null;
    out.cases.s1.copiedMatchesP1 = out.cases.s1.copied === P1;
    out.cases.s1.toast = (() => {
      const t = parts().toast;
      return { shown: shown(t), text: String(t.textContent || '') };
    })();
    out.cases.s1.realClipboard = await readClipboard();
    out.cases.s1.realClipboardOk = out.cases.s1.realClipboard === P1;
    out.cases.s1.selectionAfterCopy = String(window.getSelection());
    await sleep(120);
    out.cases.s1.afterCopy = state();
  } catch (err) {
    out.cases.s1 = { error: String(err) };
  }

  /* ---------- 2. 「引用」仍然可用（V1 行為沒有回歸） ---------- */
  try {
    await resetComposer();
    clearSelection();
    await sleep(120);
    selectEl(document.getElementById('p1'));
    await waitState({ bar: true, quote: true, copy: true });
    parts().quote.click();
    await sleep(500);
    out.cases.s2 = {
      model: modelText(),
      modelOk: modelText().indexOf('第一段：引用功能的測試文字。') !== -1,
      barAfter: state()
    };
  } catch (err) {
    out.cases.s2 = { error: String(err) };
  }

  /* ---------- 3. 沒有輸入框 → 只剩「複製」，且能複製 ---------- */
  try {
    host.style.display = 'none';
    clearSelection();
    await sleep(120);
    selectEl(document.getElementById('p2'));
    const s3 = await waitState({ bar: true, quote: false, copy: true });
    const before = window.__clip.calls.length;
    parts().copy.click();
    await sleep(150);
    out.cases.s3 = {
      state: s3,
      copied: window.__clip.calls.length > before ? window.__clip.calls[window.__clip.calls.length - 1] : null
    };
    out.cases.s3.copiedMatchesP2 = out.cases.s3.copied === P2;
  } catch (err) {
    out.cases.s3 = { error: String(err) };
  }

  /* ---------- 4. 關掉「顯示複製按鈕」→ 只剩「引用」 ---------- */
  try {
    host.style.display = '';
    document.documentElement.setAttribute('data-dshq-copy', '0');
    await sleep(120);
    clearSelection();
    await sleep(80);
    selectEl(document.getElementById('p1'));
    out.cases.s4 = await waitState({ bar: true, quote: true, copy: false });
    out.cases.s4.toastIgnored = true;
  } catch (err) {
    out.cases.s4 = { error: String(err) };
  }

  /* ---------- 5. 複製關掉 + 沒有輸入框 → 完全不顯示 ---------- */
  try {
    host.style.display = 'none';
    clearSelection();
    await sleep(120);
    selectEl(document.getElementById('p2'));
    const s5 = await waitState({ bar: false, quote: false, copy: false });
    out.cases.s5 = s5;
  } catch (err) {
    out.cases.s5 = { error: String(err) };
  }

  /* ---------- 6. 在輸入框內選取 → 不顯示 ---------- */
  try {
    host.style.display = '';
    document.documentElement.setAttribute('data-dshq-copy', '1');
    await sleep(120);
    clearSelection();
    const range = document.createRange();
    range.selectNodeContents(host);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
    await sleep(300);
    out.cases.s6 = state();
  } catch (err) {
    out.cases.s6 = { error: String(err) };
  }

  /* ---------- 7. Markdown 格式只影響引用、不影響複製 ---------- */
  try {
    document.documentElement.setAttribute('data-dshq-format', 'markdown');
    await sleep(120);
    await resetComposer();
    clearSelection();
    await sleep(120);
    selectEl(document.getElementById('p1'));
    await waitState({ bar: true, quote: true, copy: true });
    parts().quote.click();
    await sleep(500);
    const quoted = modelText();

    clearSelection();
    await sleep(120);
    selectEl(document.getElementById('p1'));
    await waitState({ bar: true, quote: true, copy: true });
    const before = window.__clip.calls.length;
    parts().copy.click();
    await sleep(150);
    const copied = window.__clip.calls.length > before ? window.__clip.calls[window.__clip.calls.length - 1] : null;
    out.cases.s7 = {
      quotedModel: quoted,
      quotedHasPrefix: quoted.indexOf('> 第一段：引用功能的測試文字。') !== -1,
      copied: copied,
      copiedIsRaw: copied === P1
    };
    document.documentElement.setAttribute('data-dshq-format', 'plain');
  } catch (err) {
    out.cases.s7 = { error: String(err) };
  }

  /* ---------- 8. clipboard 被拒 → 退回 execCommand('copy') ---------- */
  try {
    window.__clip.mode = 'throw';
    clearSelection();
    await sleep(120);
    selectEl(document.getElementById('p1'));
    await waitState({ bar: true, quote: true, copy: true });
    const execBefore = window.__execCalls.length;
    parts().copy.click();
    await sleep(250);
    out.cases.s8 = {
      execCalls: window.__execCalls.slice(execBefore),
      toast: String(parts().toast.textContent || ''),
      copiedViaFallback: window.__execCalls.slice(execBefore).some((c) => c.command === 'copy')
    };
    window.__clip.mode = 'ok';
  } catch (err) {
    out.cases.s8 = { error: String(err) };
  }

  /* ---------- 9. Esc 關閉（等排程沉降後再按，避免測試自己的 30ms 排程又把它叫回來） ---------- */
  try {
    clearSelection();
    await sleep(120);
    selectEl(document.getElementById('p1'));
    const beforeEsc = await waitState({ bar: true, quote: true, copy: true });
    await sleep(150);
    out.cases.s9 = { beforeEsc };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(150);
    out.cases.s9.afterEsc = state();
  } catch (err) {
    out.cases.s9 = { error: String(err) };
  }

  /* ---------- 10. 多行程式碼區塊：複製要保留換行 ---------- */
  try {
    clearSelection();
    await sleep(150);
    selectEl(document.getElementById('code'));
    await waitState({ bar: true, quote: true, copy: true });
    const before = window.__clip.calls.length;
    parts().copy.click();
    await sleep(150);
    const copied = window.__clip.calls.length > before ? window.__clip.calls[window.__clip.calls.length - 1] : null;
    out.cases.s10 = { copied, hasNewlines: !!copied && copied.split('\\n').length > 1 };
  } catch (err) {
    out.cases.s10 = { error: String(err) };
  }

  out.clipCalls = window.__clip.calls.length;
  out.execCalls = window.__execCalls.length;
  return out;
})()`;

async function main() {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log('static server on ' + ORIGIN);

  const profileDir = path.join(os.tmpdir(), 'dsh-quote-v2-' + Date.now());
  const chrome = launchChrome(profileDir);
  let socket = null;
  try {
    const target = await findTarget();
    if (!target) throw new Error('chrome target not found');
    socket = await connect(target.webSocketDebuggerUrl);
    await send(socket, 'Runtime.enable', {});
    try {
      await send(socket, 'Browser.grantPermissions', {
        origin: ORIGIN,
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
      });
    } catch (err) {
      console.log('grantPermissions failed (clipboard 讀回可能不可用): ' + err.message);
    }
    try {
      await send(socket, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (err) {
      /* 舊版 Chrome 沒有這個指令，忽略 */
    }
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
