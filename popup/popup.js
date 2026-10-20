/* ==========================================================================
 * DSH 引用助手 — popup 設定面板
 *   - 上方：浮動按鈕設定（chrome.storage.local.dshQuoteSettings）
 *   - 下方：啟用網址管理（chrome.storage.local.dshQuoteSites）
 *     加入網址＝向使用者要 optional host 權限 → 存清單 → 通知 background 動態註冊腳本
 * ========================================================================== */
(() => {
	'use strict';

	const STORAGE_KEY = 'dshQuoteSettings';
	const SITES_KEY = 'dshQuoteSites';
	const DEFAULTS = { enabled: true, scope: 'conversation', format: 'plain', showCopy: true };
	const SITES = window.DSHQ_SITES || { BUILTIN: [], toPattern: () => ({ ok: false, error: 'sites.js 未載入' }) };

	const enabledBox = document.getElementById('enabled');
	const showCopyBox = document.getElementById('showCopy');
	const siteList = document.getElementById('siteList');
	const siteInput = document.getElementById('siteInput');
	const siteAdd = document.getElementById('siteAdd');
	const siteMsg = document.getElementById('siteMsg');

	let customSites = [];
	let msgTimer = 0;
	let busy = false;

	/* ------------------------------------------------------------ 顯示訊息 */

	function showMsg(text) {
		if (!siteMsg) return;
		siteMsg.textContent = text;
		siteMsg.hidden = false;
		if (msgTimer) clearTimeout(msgTimer);
		msgTimer = setTimeout(() => {
			siteMsg.hidden = true;
			msgTimer = 0;
		}, 5000);
	}

	/* -------------------------------------------------------- 浮動按鈕設定 */

	function checkedValue(name, fallback) {
		const input = document.querySelector('input[name="' + name + '"]:checked');
		return input ? input.value : fallback;
	}

	function fill(settings) {
		const value = Object.assign({}, DEFAULTS, settings || {});
		enabledBox.checked = value.enabled !== false;
		showCopyBox.checked = value.showCopy !== false;
		const scope = document.querySelector('input[name="scope"][value="' + value.scope + '"]');
		if (scope) scope.checked = true;
		const format = document.querySelector('input[name="format"][value="' + value.format + '"]');
		if (format) format.checked = true;
	}

	function save() {
		const settings = {
			enabled: enabledBox.checked,
			showCopy: showCopyBox.checked,
			scope: checkedValue('scope', DEFAULTS.scope),
			format: checkedValue('format', DEFAULTS.format)
		};
		try {
			chrome.storage.local.set({ [STORAGE_KEY]: settings });
		} catch (err) {
			/* 忽略：寫入失敗時維持頁面上原本的設定 */
		}
	}

	document.addEventListener('change', save);

	/* ------------------------------------------------------------ 網址清單 */

	function makeRow(pattern, builtin) {
		const li = document.createElement('li');
		li.setAttribute('data-pattern', pattern);

		const name = document.createElement('span');
		name.className = 'site-name';
		name.textContent = pattern.replace(/\/\*$/, '');
		li.appendChild(name);

		if (builtin) {
			const tag = document.createElement('span');
			tag.className = 'tag';
			tag.textContent = '內建';
			li.appendChild(tag);
			return li;
		}

		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'rm';
		remove.textContent = '移除';
		remove.addEventListener('click', () => removeSite(pattern));
		li.appendChild(remove);
		return li;
	}

	function renderSites() {
		if (!siteList) return;
		siteList.textContent = '';
		const builtin = Array.isArray(SITES.BUILTIN) ? SITES.BUILTIN : [];
		builtin.forEach((pattern) => siteList.appendChild(makeRow(pattern, true)));
		customSites.forEach((pattern) => siteList.appendChild(makeRow(pattern, false)));
	}

	function loadSites() {
		try {
			chrome.storage.local.get(SITES_KEY, (value) => {
				const list = value && Array.isArray(value[SITES_KEY]) ? value[SITES_KEY] : [];
				customSites = list.filter((item) => typeof item === 'string');
				renderSites();
			});
		} catch (err) {
			customSites = [];
			renderSites();
		}
	}

	function persistSites() {
		try {
			return chrome.storage.local.set({ [SITES_KEY]: customSites });
		} catch (err) {
			return Promise.resolve();
		}
	}

	function askBackgroundSync() {
		try {
			const result = chrome.runtime.sendMessage({ type: 'dshq-sync' });
			if (result && typeof result.catch === 'function') result.catch(() => {});
		} catch (err) {
			/* background 不在（罕見）就等下次啟動再註冊 */
		}
	}

	function addSite() {
		if (busy) return Promise.resolve();
		const parsed = SITES.toPattern(siteInput.value);
		if (!parsed.ok) {
			showMsg(parsed.error);
			return Promise.resolve();
		}
		if (SITES.BUILTIN.indexOf(parsed.pattern) !== -1) {
			showMsg('這個網址是內建的，不用再加');
			return Promise.resolve();
		}
		if (customSites.indexOf(parsed.pattern) !== -1) {
			showMsg('這個網址已經加過了');
			return Promise.resolve();
		}

		busy = true;
		return new Promise((resolve) => {
			/* 一定要在使用者點擊的當下呼叫 permissions.request() */
			chrome.permissions.request({ origins: [parsed.pattern] }, (granted) => {
				const ok = !chrome.runtime.lastError && granted;
				if (!ok) {
					busy = false;
					showMsg('沒有取得授權（需要按「允許」才能在此網址使用）');
					resolve();
					return;
				}
				customSites.push(parsed.pattern);
				persistSites();
				askBackgroundSync();
				siteInput.value = '';
				renderSites();
				showMsg('已加入 ' + parsed.pattern + '，請重新整理該網頁');
				busy = false;
				resolve();
			});
		});
	}

	function removeSite(pattern) {
		if (busy) return;
		customSites = customSites.filter((item) => item !== pattern);
		persistSites();
		try {
			chrome.permissions.remove({ origins: [pattern] }, () => void chrome.runtime.lastError);
		} catch (err) {
			/* 沒這個權限就忽略 */
		}
		askBackgroundSync();
		renderSites();
		showMsg('已移除 ' + pattern);
	}

	if (siteAdd) siteAdd.addEventListener('click', () => { addSite(); });
	if (siteInput) {
		siteInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				addSite();
			}
		});
	}

	/* ---------------------------------------------------------------- 啟動 */

	try {
		chrome.storage.local.get(STORAGE_KEY, (result) => {
			if (chrome.runtime.lastError) {
				fill(null);
				return;
			}
			fill(result && result[STORAGE_KEY]);
		});
	} catch (err) {
		fill(null);
	}

	loadSites();

	/* 測試用：讓外部可以呼叫同一套流程 */
	window.__dshqPopup = { addSite, removeSite, renderSites, getCustom: () => customSites.slice() };
})();
