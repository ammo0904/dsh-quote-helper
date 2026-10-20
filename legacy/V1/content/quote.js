/* ==========================================================================
 * DSH 引用助手 — 主要內容腳本（Main world）
 *
 * 功能：
 *   1. 在 DSH 網頁框選文字後，於選取範圍旁顯示「引用」浮動按鈕。
 *   2. 按下按鈕，把框選的文字送進下方輸入框（DSH 的 Lexical 編輯器），
 *      插入位置＝輸入框裡原本的游標位置；若沒有游標就接在草稿最後面。
 *
 * 為什麼要跑在 MAIN world：
 *   DSH 的輸入框是 Lexical 編輯器。Lexical 把 editor 實例掛在 DOM 上
 *   （rootElement.__lexicalEditor），而「隔離世界（ISOLATED）」的內容腳本
 *   拿不到頁面 JS 掛在 DOM 上的屬性，也無法通過 Lexical 內部的
 *   `instanceof ClipboardEvent` 檢查。跑在 MAIN world 才能直接用 Lexical
 *   自己的 API 插入文字（等同 DSH 自己的貼上流程）。
 *
 * 插入策略（依序嘗試，每一步都驗證是否真的插入成功才往下走）：
 *   A. Lexical 模型層插入：editor.update() + selection.insertText()
 *      （和 DSH 內建「貼上」實作同一條路徑，支援多行、undo 正常）
 *   B. 合成 paste 事件：把文字放進 ClipboardEvent 的 clipboardData，
 *      DSH 自己的貼上處理器會接手。
 *   C. document.execCommand('insertText')。
 *   D. 直接改 DOM（最後手段）。
 * ========================================================================== */
(() => {
	'use strict';

	const GUARD = '__dshQuoteHelper';
	if (window[GUARD]) return;
	window[GUARD] = true;

	const HOST_ID = '__dsh-quote-helper__';
	const CONVERSATION_SELECTOR = '[data-conversation-scroll]';
	const COMPOSER_REGION_SELECTOR = '[data-conversation-region="composer"]';
	const COMPOSER_SELECTORS = [
		'[data-composer-input]',
		'[data-input-scroll] [contenteditable="true"]',
		'[data-lexical-editor="true"]',
		'[data-conversation-region="composer"] textarea'
	];
	const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]';
	const POLL_INTERVAL = 25;
	const WAIT_TIMEOUT = 300;
	const SETTLE_MS = 150;
	const TOAST_MS = 1800;

	/* ---------------------------------------------------------------- 狀態 */

	const settings = { enabled: true, scope: 'conversation', format: 'plain' };
	let currentQuote = '';
	let lastComposer = null;
	let host = null;
	let shadow = null;
	let button = null;
	let toast = null;
	let toastTimer = 0;
	let scheduled = false;

	/* ------------------------------------------------------------ 小工具 */

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const norm = (value) => String(value == null ? '' : value).replace(/\s+/g, '');

	function asElement(node) {
		if (!node) return null;
		if (node.nodeType === 1) return node;
		return node.parentElement || null;
	}

	function isEditableElement(el) {
		if (!el || typeof el.closest !== 'function') return false;
		if (el.closest('input, textarea, select')) return true;
		const editable = el.closest('[contenteditable]');
		if (!editable) return !!el.closest('[data-composer-input]');
		const value = editable.getAttribute('contenteditable');
		return value === null || value === '' || value === 'true' || value === 'plaintext-only';
	}

	function isTextControl(el) {
		if (!el) return false;
		if (el.tagName === 'TEXTAREA') return true;
		return el.tagName === 'INPUT' && /^(text|search|url|email|tel)$/i.test(el.type || '');
	}

	function isVisible(el) {
		if (!el || !el.isConnected) return false;
		const rect = el.getBoundingClientRect();
		return rect.width > 0 || rect.height > 0;
	}

	/* -------------------------------------------------------- 讀取設定值 */
	/* 設定值由 isolated world 的 bridge.js 寫在 <html> 的 data-dshq-* 屬性上。 */

	function readSettings() {
		const root = document.documentElement;
		if (!root) return;
		settings.enabled = root.getAttribute('data-dshq-enabled') !== '0';
		settings.scope = root.getAttribute('data-dshq-scope') === 'anywhere' ? 'anywhere' : 'conversation';
		settings.format = root.getAttribute('data-dshq-format') === 'markdown' ? 'markdown' : 'plain';
	}

	function watchSettings() {
		readSettings();
		const root = document.documentElement;
		if (!root) return;
		const observer = new MutationObserver(() => {
			readSettings();
			if (!settings.enabled) hideButton();
		});
		observer.observe(root, {
			attributes: true,
			attributeFilter: ['data-dshq-enabled', 'data-dshq-scope', 'data-dshq-format']
		});
	}

	/* ------------------------------------------------------------ 浮動按鈕 */

	const BUTTON_SVG =
		'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
		'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
		'<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1a1 1 0 0 1 1 1v1a2 2 0 0 1-2 2h-1a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h1a6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>' +
		'<path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1a1 1 0 0 1 1 1v1a2 2 0 0 1-2 2H4a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h1a6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>' +
		'</svg>';

	function ensureUI() {
		if (host && host.isConnected && shadow && button) return true;
		if (!document.body) return false;

		host = document.createElement('div');
		host.id = HOST_ID;
		host.setAttribute('data-dsh-quote-ui', '1');
		host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;';

		shadow = host.attachShadow({ mode: 'open' });
		shadow.innerHTML =
			'<style>' +
			'.dq-btn{position:fixed;display:inline-flex;align-items:center;gap:6px;padding:7px 11px 7px 9px;' +
			'border:1px solid rgba(255,255,255,.18);border-radius:9px;background:#2c2c31;color:#f7f7f8;' +
			'font:500 13px/1 "Segoe UI","Microsoft JhengHei",system-ui,-apple-system,sans-serif;' +
			'letter-spacing:.02em;cursor:pointer;white-space:nowrap;user-select:none;-webkit-user-select:none;' +
			'box-shadow:0 8px 22px rgba(0,0,0,.35),0 1px 2px rgba(0,0,0,.28);' +
			'transition:background .12s ease,transform .08s ease;}' +
			'.dq-btn:hover{background:#3b3b42;}' +
			'.dq-btn:active{transform:translateY(1px);}' +
			'.dq-btn svg{display:block;flex:none;}' +
			'.dq-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);max-width:60vw;' +
			'padding:8px 14px;border-radius:8px;background:rgba(28,28,32,.96);color:#fff;' +
			'font:500 13px/1.35 "Segoe UI","Microsoft JhengHei",system-ui,-apple-system,sans-serif;' +
			'box-shadow:0 8px 22px rgba(0,0,0,.35);}' +
			'[hidden]{display:none !important;}' +
			'</style>' +
			'<button class="dq-btn" type="button" tabindex="-1" hidden>' +
			BUTTON_SVG +
			'<span>引用</span></button>' +
			'<div class="dq-toast" hidden></div>';

		button = shadow.querySelector('.dq-btn');
		toast = shadow.querySelector('.dq-toast');
		button.addEventListener('mousedown', onButtonMouseDown, true);
		button.addEventListener('click', onButtonClick, true);

		document.body.appendChild(host);
		return true;
	}

	function placeButton(rect) {
		const width = button.offsetWidth || 64;
		const height = button.offsetHeight || 30;
		const gap = 8;
		let top = rect.top - height - gap;
		if (top < 6) top = rect.bottom + gap;
		if (top + height > window.innerHeight - 6) {
			top = Math.max(6, Math.min(window.innerHeight - height - 6, rect.top - height - gap));
		}
		let left = rect.left + rect.width / 2 - width / 2;
		left = Math.max(6, Math.min(left, window.innerWidth - width - 6));
		button.style.top = Math.round(top) + 'px';
		button.style.left = Math.round(left) + 'px';
	}

	function showButton(rect) {
		if (!ensureUI()) return;
		button.hidden = false;
		placeButton(rect);
	}

	function hideButton() {
		currentQuote = '';
		if (button) button.hidden = true;
	}

	function notify(message) {
		if (!ensureUI()) return;
		toast.textContent = message;
		toast.hidden = false;
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toast.hidden = true;
			toastTimer = 0;
		}, TOAST_MS);
	}

	/* ------------------------------------------------------- 選取範圍判定 */

	function pickSelection() {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

		const range = selection.getRangeAt(0);
		const ancestor = range.commonAncestorContainer;
		if (host && (ancestor === host || host.contains(ancestor))) return null;

		const el = asElement(ancestor);
		if (!el || isEditableElement(el)) return null;

		if (settings.scope === 'conversation') {
			if (!el.closest(CONVERSATION_SELECTOR)) return null;
			if (el.closest(COMPOSER_REGION_SELECTOR)) return null;
		}

		const text = selection.toString();
		if (!text || !text.trim()) return null;

		let rect = range.getBoundingClientRect();
		if (!rect || (rect.width === 0 && rect.height === 0)) {
			const rects = range.getClientRects();
			rect = rects && rects.length ? rects[rects.length - 1] : null;
		}
		if (!rect || (rect.width === 0 && rect.height === 0)) return null;
		if (rect.bottom < 0 || rect.top > window.innerHeight) return null;

		return { text: text, rect: rect };
	}

	function buildQuote(raw) {
		let text = String(raw).replace(/\r\n?/g, '\n');
		text = text
			.split('\n')
			.map((line) => line.replace(/[ \t]+$/, ''))
			.join('\n');
		text = text.replace(/^\n+/, '').replace(/\n+$/, '');
		if (!text) return '';
		if (settings.format === 'markdown') {
			text = text
				.split('\n')
				.map((line) => (line ? '> ' + line : '>'))
				.join('\n');
		}
		return text;
	}

	function refresh() {
		if (!settings.enabled) {
			hideButton();
			return;
		}
		const picked = pickSelection();
		if (!picked) {
			hideButton();
			return;
		}
		if (!findComposer()) {
			hideButton();
			return;
		}
		const quote = buildQuote(picked.text);
		if (!quote) {
			hideButton();
			return;
		}
		currentQuote = quote;
		showButton(picked.rect);
	}

	function schedule() {
		if (scheduled) return;
		scheduled = true;
		/* 用 setTimeout 而非 requestAnimationFrame：分頁在背景時 rAF 不會跑，
		   而這裡的工作很輕（幾個 querySelector），不需要等畫面更新。 */
		setTimeout(() => {
			scheduled = false;
			refresh();
		}, 0);
	}

	/* --------------------------------------------------------- 找輸入框 */

	document.addEventListener(
		'focusin',
		(event) => {
			const el = asElement(event.target);
			if (!el || typeof el.closest !== 'function') return;
			const hit = el.closest(COMPOSER_SELECTORS.join(','));
			if (hit) lastComposer = hit;
		},
		true
	);

	function findComposer() {
		const seen = [];
		for (let i = 0; i < COMPOSER_SELECTORS.length; i += 1) {
			const nodes = document.querySelectorAll(COMPOSER_SELECTORS[i]);
			for (let j = 0; j < nodes.length; j += 1) {
				if (seen.indexOf(nodes[j]) === -1) seen.push(nodes[j]);
			}
		}
		const usable = seen.filter((el) => isVisible(el) && (isTextControl(el) || el.isContentEditable));
		if (!usable.length) return null;

		const active = document.activeElement;
		if (active) {
			for (let i = 0; i < usable.length; i += 1) {
				if (usable[i] === active || usable[i].contains(active)) return usable[i];
			}
		}
		if (lastComposer && usable.indexOf(lastComposer) !== -1) return lastComposer;

		usable.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
		return usable[0];
	}

	/* --------------------------------------------------------- 插入文字 */

	function insertIntoTextControl(el, text) {
		try {
			const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
			const current = el.value == null ? '' : el.value;
			const start = typeof el.selectionStart === 'number' ? el.selectionStart : current.length;
			const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : current.length;
			const next = current.slice(0, start) + text + current.slice(end);
			el.focus();
			if (descriptor && descriptor.set) descriptor.set.call(el, next);
			else el.value = next;
			if (typeof el.setSelectionRange === 'function') el.setSelectionRange(start + text.length, start + text.length);
			el.dispatchEvent(new Event('input', { bubbles: true }));
			return true;
		} catch (err) {
			return false;
		}
	}

	/** 讀出 Lexical 模型的純文字（用來確認插入是否真的成功）。
	 *  Lexical 的節點方法必須在有 active editor state 時呼叫，所以要包在 read() 裡。 */
	function modelText(editor) {
		try {
			const state = editor.getEditorState();
			if (!state || typeof state.read !== 'function') return null;
			return state.read(() => {
				const root = state._nodeMap && state._nodeMap.get('root');
				if (root && typeof root.getTextContent === 'function') return root.getTextContent();
				return null;
			});
		} catch (err) {
			return null;
		}
	}

	/**
	 * 策略 A：直接在 Lexical 模型上插入（等於 DSH 內建貼上的做法）。
	 * discrete:true 讓這次更新同步提交，函式返回時模型與 DOM 都已更新。
	 */
	function lexInsert(editor, text) {
		let outcome = 'skip';
		try {
			editor.update(
				() => {
					const pending = editor._pendingEditorState;
					if (!pending) {
						outcome = 'no-pending-state';
						return;
					}
					let selection = pending._selection;
					if (!selection || typeof selection.insertText !== 'function') {
						const root = pending._nodeMap && pending._nodeMap.get('root');
						selection = root && typeof root.selectEnd === 'function' ? root.selectEnd() : null;
					}
					if (!selection || typeof selection.insertText !== 'function') {
						outcome = 'no-selection';
						return;
					}
					/* insertRawText 會把 \n 拆成段落（和真的貼上一樣），優先用它；
					   沒有這個方法時退回 insertText。 */
					if (typeof selection.insertRawText === 'function') selection.insertRawText(text);
					else selection.insertText(text);
					outcome = 'ok';
				},
				{ tag: 'dsh-quote', discrete: true }
			);
		} catch (err) {
			outcome = 'threw';
		}
		return outcome;
	}

	/** 策略 B：合成 paste 事件，交給 DSH 自己的貼上處理。 */
	function synthPaste(composer, text) {
		try {
			const data = new DataTransfer();
			data.setData('text/plain', text);
			const event = new ClipboardEvent('paste', {
				clipboardData: data,
				bubbles: true,
				cancelable: true,
				composed: true
			});
			composer.dispatchEvent(event);
			return true;
		} catch (err) {
			return false;
		}
	}

	/** 策略 C：瀏覽器原生 insertText 指令。 */
	function execInsert(text) {
		try {
			document.execCommand('insertText', false, text);
			return true;
		} catch (err) {
			return false;
		}
	}

	/** 策略 D：直接改 DOM（最後手段）。 */
	function domInsert(composer, text) {
		try {
			const selection = window.getSelection();
			if (!selection) return false;
			if (selection.rangeCount === 0 || !composer.contains(selection.anchorNode)) {
				const range = document.createRange();
				range.selectNodeContents(composer);
				range.collapse(false);
				selection.removeAllRanges();
				selection.addRange(range);
			}
			const active = window.getSelection();
			if (!active || active.rangeCount === 0) return false;
			const range = active.getRangeAt(0);
			const fragment = document.createDocumentFragment();
			text.split('\n').forEach((line, index) => {
				if (index > 0) fragment.appendChild(document.createElement('br'));
				fragment.appendChild(document.createTextNode(line));
			});
			range.deleteContents();
			range.insertNode(fragment);
			try {
				composer.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
			} catch (err) {
				/* 忽略：只是通知 React/Lexical 有輸入 */
			}
			return true;
		} catch (err) {
			return false;
		}
	}

	async function waitForChange(context) {
		const deadline = Date.now() + WAIT_TIMEOUT;
		for (;;) {
			if (context.changed()) return true;
			if (Date.now() >= deadline) return false;
			await sleep(POLL_INTERVAL);
		}
	}

	/**
	 * 確認插入真的成功。
	 * Lexical 會用 MutationObserver 把「只改 DOM、模型沒改」的變化還原，
	 * 所以看到變化後要先沉降一下再確認一次，避免把曇花一現的 DOM 變化誤判成成功。
	 */
	async function verifyChange(context) {
		if (!(await waitForChange(context))) {
			await sleep(SETTLE_MS);
			return false;
		}
		await sleep(SETTLE_MS);
		return context.changed();
	}

	async function insertQuote(text) {
		const composer = findComposer();
		if (!composer) return 'no-composer';
		if (isTextControl(composer)) return insertIntoTextControl(composer, text) ? 'text-control' : 'failed';

		try {
			composer.focus({ preventScroll: true });
		} catch (err) {
			try {
				composer.focus();
			} catch (err2) {
				/* 忽略：有些瀏覽器不接受 options */
			}
		}

		const editor = composer.__lexicalEditor || null;
		const beforeDom = norm(composer.textContent);
		const beforeModel = editor ? modelText(editor) : null;
		/* 讀得到模型時以模型為準（DOM 專屬的變化不算成功）。 */
		const modelAuthoritative = !!(editor && beforeModel !== null);

		const context = {
			changed() {
				if (editor) {
					const now = modelText(editor);
					if (beforeModel !== null && now !== null) return now !== beforeModel;
				}
				const domNow = norm(composer.textContent);
				return domNow !== beforeDom && domNow.indexOf(norm(text)) !== -1;
			}
		};

		/* A. Lexical 模型插入（discrete 同步提交，可立即驗證） */
		if (editor) {
			const outcome = lexInsert(editor, text);
			if (outcome === 'ok') {
				if (modelAuthoritative) {
					if (modelText(editor) !== beforeModel) return 'lexical';
				} else if (await verifyChange(context)) {
					return 'lexical';
				}
			}
		}

		/* B. 合成 paste 事件（走 DSH 自己的貼上處理） */
		if (synthPaste(composer, text) && (await verifyChange(context))) return 'paste';

		/* C. execCommand('insertText') */
		if (execInsert(text) && (await verifyChange(context))) return 'exec';

		/* D. 直接改 DOM（最後手段） */
		if (domInsert(composer, text) && (await verifyChange(context))) return 'dom';

		return 'failed';
	}

	/* ------------------------------------------------------------- 事件 */

	function onButtonMouseDown(event) {
		/* 阻止 mousedown 讓框選消失（不然按鈕一按，選取範圍就沒了） */
		event.preventDefault();
		event.stopPropagation();
	}

	async function onButtonClick(event) {
		event.preventDefault();
		event.stopPropagation();
		const text = currentQuote;
		hideButton();
		if (!text) return;
		let result = 'failed';
		try {
			result = await insertQuote(text);
		} catch (err) {
			result = 'failed';
		}
		if (result === 'no-composer') notify('找不到輸入框：請先開啟一個對話');
		else if (result === 'failed') notify('引用失敗：請於 DSH 網頁重試');
	}

	function onDocumentMouseDown(event) {
		if (!host) return;
		const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
		if (path && path.indexOf(host) !== -1) return;
		if (event.target === host) return;
		hideButton();
	}

	function onSelectionLike() {
		schedule();
		setTimeout(schedule, 30);
	}

	function onKeyUp(event) {
		if (event.key === 'Escape') {
			hideButton();
			return;
		}
		onSelectionLike();
	}

	function install() {
		watchSettings();

		document.addEventListener('mouseup', onSelectionLike, true);
		document.addEventListener('keyup', onKeyUp, true);
		document.addEventListener('selectionchange', schedule, true);
		document.addEventListener('mousedown', onDocumentMouseDown, true);
		document.addEventListener('scroll', hideButton, true);
		document.addEventListener(
			'keydown',
			(event) => {
				if (event.key === 'Escape') hideButton();
			},
			true
		);
		window.addEventListener('resize', hideButton, true);
		window.addEventListener('blur', hideButton, true);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', install, { once: true });
	} else {
		install();
	}
})();
