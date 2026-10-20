/* ==========================================================================
 * DSH 引用助手 — 設定橋接腳本（ISOLATED world）
 *
 * popup 把設定存進 chrome.storage.local；這裡把設定同步成 <html> 上的
 * data-dshq-* 屬性，讓跑在 MAIN world 的 quote.js 讀得到
 * （MAIN world 拿不到 chrome.storage）。
 * ========================================================================== */
(() => {
	'use strict';

	const STORAGE_KEY = 'dshQuoteSettings';
	const DEFAULTS = { enabled: true, scope: 'conversation', format: 'double', showCopy: true, breakLine: true };

	function apply(raw) {
		const settings = Object.assign({}, DEFAULTS, raw || {});
		const root = document.documentElement;
		if (!root) return false;
		const format = settings.format;
		const safeFormat = format === 'plain' || format === 'corner' || format === 'markdown' ? format : 'double';
		root.setAttribute('data-dshq-enabled', settings.enabled === false ? '0' : '1');
		root.setAttribute('data-dshq-scope', settings.scope === 'anywhere' ? 'anywhere' : 'conversation');
		root.setAttribute('data-dshq-format', safeFormat);
		root.setAttribute('data-dshq-copy', settings.showCopy === false ? '0' : '1');
		root.setAttribute('data-dshq-break', settings.breakLine === false ? '0' : '1');
		try {
			root.setAttribute('data-dshq-version', chrome.runtime.getManifest().version);
		} catch (err) {
			/* 取不到版本就留著舊值 */
		}
		return true;
	}

	function load(attempt) {
		try {
			chrome.storage.local.get(STORAGE_KEY, (value) => {
				if (chrome.runtime.lastError) {
					apply(null);
					return;
				}
				if (apply(value && value[STORAGE_KEY]) === false && attempt < 50) {
					setTimeout(() => load(attempt + 1), 20);
				}
			});
		} catch (err) {
			apply(null);
		}
	}

	try {
		chrome.storage.onChanged.addListener((changes, area) => {
			if (area !== 'local' || !changes[STORAGE_KEY]) return;
			apply(changes[STORAGE_KEY].newValue);
		});
	} catch (err) {
		/* 忽略：storage 不可用時用預設值 */
	}

	load(0);
})();
