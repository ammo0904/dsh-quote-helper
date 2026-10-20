/* ==========================================================================
 * DSH 引用助手 — popup 設定面板
 * ========================================================================== */
(() => {
	'use strict';

	const STORAGE_KEY = 'dshQuoteSettings';
	const DEFAULTS = { enabled: true, scope: 'conversation', format: 'plain' };

	const enabledBox = document.getElementById('enabled');

	function checkedValue(name, fallback) {
		const input = document.querySelector('input[name="' + name + '"]:checked');
		return input ? input.value : fallback;
	}

	function fill(settings) {
		const value = Object.assign({}, DEFAULTS, settings || {});
		enabledBox.checked = value.enabled !== false;
		const scope = document.querySelector('input[name="scope"][value="' + value.scope + '"]');
		if (scope) scope.checked = true;
		const format = document.querySelector('input[name="format"][value="' + value.format + '"]');
		if (format) format.checked = true;
	}

	function save() {
		const settings = {
			enabled: enabledBox.checked,
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
})();
