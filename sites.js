/* ==========================================================================
 * DSH 引用助手 — 共用網址工具（popup 與 background 共用）
 *
 * 這裡只做三件事：
 *   1. 把使用者輸入的網址正規化成 Chrome match pattern（去掉 port、補上 /*）。
 *   2. 內建（manifest 靜態宣告）的網址清單。
 *   3. 由 pattern 產生動態註冊內容腳本要用的 id（必須是 [a-zA-Z0-9_-]，且短）。
 * ========================================================================== */
(function (root) {
	'use strict';

	/* 內建網址一定要跟 manifest.json 的 content_scripts.matches 一致。 */
	const BUILTIN = ['http://127.0.0.1/*', 'http://localhost/*', 'https://dsh-149-88-70-170.sslip.io/*'];

	/**
	 * 輸入 → { ok:true, pattern, host, secure } 或 { ok:false, error }
	 * 例：192.168.1.5:3080 → http? no，預設補 https → https://192.168.1.5/*
	 * 注意：Chrome match pattern 不含 port，所以 pattern 只保留 hostname。
	 */
	function toPattern(input) {
		const raw = String(input == null ? '' : input).trim();
		if (!raw) return { ok: false, error: '請先輸入網址' };

		let text = raw;
		if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;

		let url;
		try {
			url = new URL(text);
		} catch (err) {
			return { ok: false, error: '網址格式不對，例：https://dsh.xxx.com' };
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return { ok: false, error: '只支援 http:// 或 https:// 開頭的網址' };
		}
		if (!url.hostname) return { ok: false, error: '網址缺少主機名稱' };

		const pattern = url.protocol + '//' + url.hostname + '/*';
		return { ok: true, pattern: pattern, host: url.hostname, secure: url.protocol === 'https:' };
	}

	/** djb2 → base36，產出短而穩定的 id 後綴。 */
	function key(pattern) {
		let hash = 5381;
		for (let i = 0; i < pattern.length; i += 1) hash = ((hash * 33) ^ pattern.charCodeAt(i)) >>> 0;
		return hash.toString(36);
	}

	function ids(pattern) {
		const suffix = key(pattern);
		return { bridge: 'dshq-bridge-' + suffix, quote: 'dshq-quote-' + suffix };
	}

	function isBuiltin(pattern) {
		return BUILTIN.indexOf(pattern) !== -1;
	}

	root.DSHQ_SITES = { BUILTIN: BUILTIN, toPattern: toPattern, key: key, ids: ids, isBuiltin: isBuiltin };
})(typeof self !== 'undefined' ? self : this);
