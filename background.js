/* ==========================================================================
 * DSH 引用助手 — background（service worker）
 *
 * 使用者自行加入的網址不會寫在 manifest（那是打包時固定的），而是：
 *   popup 取得 optional 權限 → 存進 chrome.storage.local.dshQuoteSites →
 *   這裡用 chrome.scripting.registerContentScripts 動態註冊
 *   ISOLATED（content/bridge.js）+ MAIN（content/quote.js）兩支腳本。
 *
 * 動態註冊的腳本在擴充套件重新載入／更新後會消失，所以 onInstalled / onStartup
 * 都會呼叫 sync() 重新對齊；popup 每次變更也會送訊息過來觸發。
 * ========================================================================== */
importScripts('sites.js');

const STORAGE_KEY = 'dshQuoteSites';
const SCOPE_PREFIX = 'dshq-';

async function readSites() {
	try {
		const value = await chrome.storage.local.get(STORAGE_KEY);
		const list = value && Array.isArray(value[STORAGE_KEY]) ? value[STORAGE_KEY] : [];
		return list.filter((item) => typeof item === 'string' && item.indexOf('://') > 0);
	} catch (err) {
		return [];
	}
}

async function unregister(ids) {
	if (!ids.length) return;
	try {
		await chrome.scripting.unregisterContentScripts({ ids: ids });
	} catch (err) {
		/* 沒有註冊過就會拋錯，忽略即可 */
	}
}

async function register(pattern) {
	const pair = DSHQ_SITES.ids(pattern);
	let existing = [];
	try {
		existing = await chrome.scripting.getRegisteredContentScripts({ ids: [pair.bridge, pair.quote] });
	} catch (err) {
		existing = [];
	}
	if (existing.length === 2) return true;
	if (existing.length) await unregister([pair.bridge, pair.quote]);

	await chrome.scripting.registerContentScripts([
		{
			id: pair.bridge,
			matches: [pattern],
			js: ['content/bridge.js'],
			runAt: 'document_start',
			allFrames: false,
			world: 'ISOLATED'
		},
		{
			id: pair.quote,
			matches: [pattern],
			js: ['content/quote.js'],
			runAt: 'document_idle',
			allFrames: false,
			world: 'MAIN'
		}
	]);
	return true;
}

async function sync() {
	const sites = await readSites();
	const wanted = [];
	for (const pattern of sites) {
		const pair = DSHQ_SITES.ids(pattern);
		wanted.push(pair.bridge, pair.quote);
	}

	/* 清掉不在清單裡的舊註冊（例如使用者按了移除、或改了網址）。 */
	let all = [];
	try {
		all = await chrome.scripting.getRegisteredContentScripts();
	} catch (err) {
		all = [];
	}
	const stale = all
		.map((script) => script.id)
		.filter((id) => id.indexOf(SCOPE_PREFIX) === 0 && wanted.indexOf(id) === -1);
	await unregister(stale);

	const result = { registered: [], failed: [] };
	for (const pattern of sites) {
		try {
			await register(pattern);
			result.registered.push(pattern);
		} catch (err) {
			result.failed.push({ pattern: pattern, error: String((err && err.message) || err) });
		}
	}
	return result;
}

chrome.runtime.onInstalled.addListener(() => {
	sync().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
	sync().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (!message || message.type !== 'dshq-sync') return undefined;
	sync()
		.then((result) => sendResponse(result))
		.catch((err) => sendResponse({ registered: [], failed: [{ pattern: '*', error: String((err && err.message) || err) }] }));
	return true;
});
