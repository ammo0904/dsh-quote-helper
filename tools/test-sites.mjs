/* V2.2 單元驗證（不需瀏覽器）：
   1. sites.js 的 toPattern／ids 行為（含 port、缺 scheme、非法網址）。
   2. background.js 的 sync() 邏輯：用假的 chrome API 跑，確認
      「清掉不在清單裡的舊註冊」「每個網址註冊 ISOLATED + MAIN 一對腳本」。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..', '..', 'DSH引用助手-V2');
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail === undefined ? '' : detail });

/* ---------------------------------------------------------- 1. sites.js */

globalThis.self = globalThis;
eval(fs.readFileSync(path.join(EXT, 'sites.js'), 'utf8'));
const S = globalThis.DSHQ_SITES;

const pat = (input) => S.toPattern(input);

ok('toPattern: 完整 https 網址', pat('https://dsh-149-88-70-170.sslip.io/').pattern === 'https://dsh-149-88-70-170.sslip.io/*', pat('https://dsh-149-88-70-170.sslip.io/').pattern);
ok('toPattern: 補上 scheme 預設 https', pat('dsh.example.com').pattern === 'https://dsh.example.com/*', pat('dsh.example.com').pattern);
ok('toPattern: 去掉 port（match pattern 不含 port）', pat('192.168.1.5:3080').pattern === 'https://192.168.1.5/*', pat('192.168.1.5:3080').pattern);
ok('toPattern: http + port + 路徑', pat('http://localhost:3080/chat').pattern === 'http://localhost/*', pat('http://localhost:3080/chat').pattern);
ok('toPattern: 保留 http scheme', pat('http://10.0.0.9:8080').pattern === 'http://10.0.0.9/*');
ok('toPattern: 空字串要失敗', pat('').ok === false, JSON.stringify(pat('')));
ok('toPattern: 只有空白要失敗', pat('   ').ok === false);
ok('toPattern: 非 http/https 要失敗', pat('ftp://example.com').ok === false, JSON.stringify(pat('ftp://example.com')));
ok('toPattern: chrome:// 要失敗', pat('chrome://extensions').ok === false);

const idsA = S.ids('https://a.example.com/*');
const idsA2 = S.ids('https://a.example.com/*');
const idsB = S.ids('https://b.example.com/*');
ok('ids: 同一 pattern 穩定', idsA.bridge === idsA2.bridge && idsA.quote === idsA2.quote);
ok('ids: 不同 pattern 不同 id', idsA.bridge !== idsB.bridge && idsA.quote !== idsB.quote);
ok('ids: id 只含合法字元', [idsA.bridge, idsA.quote].every((id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id)), idsA.bridge);
ok('isBuiltin: 127.0.0.1 是內建', S.isBuiltin('http://127.0.0.1/*') === true);
ok('isBuiltin: 自訂網址不是內建', S.isBuiltin('https://a.example.com/*') === false);

/* ------------------------------------------------------ 2. background.js */

const calls = { registered: [], unregistered: [], getRegistered: 0, badge: [], title: [] };
const fakeScripts = [{ id: 'dshq-bridge-old123' }, { id: 'dshq-quote-old123' }, { id: 'someone-else' }];
const store = { dshQuoteSites: ['https://a.example.com/*', 'https://b.example.com/*'] };
const manifestVersion = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;
let messageListener = null;

globalThis.importScripts = () => {
	/* sites.js 已經載入到 globalThis，這裡不用重複 */
};
globalThis.chrome = {
	storage: {
		local: {
			get: async (key) => (key in store ? { [key]: store[key] } : {}),
			set: async (obj) => Object.assign(store, obj)
		}
	},
	scripting: {
		getRegisteredContentScripts: async (filter) => {
			calls.getRegistered += 1;
			if (filter && filter.ids) return fakeScripts.filter((s) => filter.ids.indexOf(s.id) !== -1);
			return fakeScripts.slice();
		},
		registerContentScripts: async (scripts) => {
			scripts.forEach((s) => {
				if (!s.matches || !s.matches.every((m) => /^https?:\/\/[^/]+\/\*$/.test(m))) throw new Error('bad pattern: ' + s.matches);
				calls.registered.push(s);
			});
		},
		unregisterContentScripts: async ({ ids }) => {
			calls.unregistered.push(ids.slice());
		}
	},
	runtime: {
		getManifest: () => ({ name: 'DSH 引用助手', version: manifestVersion }),
		onInstalled: { addListener: () => {} },
		onStartup: { addListener: () => {} },
		onMessage: { addListener: (fn) => { messageListener = fn; } }
	},
	action: {
		setBadgeBackgroundColor: () => {},
		setBadgeTextColor: () => {},
		setBadgeText: (options) => calls.badge.push(options.text),
		setTitle: (options) => calls.title.push(options.title)
	}
};

eval(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'));
ok('background: 有註冊 onMessage 監聽', typeof messageListener === 'function');

const response = await new Promise((resolve) => {
	const keep = messageListener({ type: 'dshq-sync' }, {}, resolve);
	ok('background: 監聽器回傳 true（非同步 sendResponse）', keep === true);
});

/* 版本標示：只在 popup 顯示，工具列不加徽章（但要主動清掉舊版留下的） */
ok('background: 工具列徽章被清空', calls.badge.length > 0 && calls.badge.every((text) => !text), JSON.stringify(calls.badge));
ok('background: 滑鼠提示帶完整版本', (calls.title[0] || '').indexOf('v' + manifestVersion) !== -1, JSON.stringify(calls.title));

const staleIds = calls.unregistered.flat();
ok('background: 清掉舊的 dshq- 註冊', staleIds.indexOf('dshq-bridge-old123') !== -1 && staleIds.indexOf('dshq-quote-old123') !== -1, JSON.stringify(calls.unregistered));
ok('background: 不動別人的註冊', staleIds.indexOf('someone-else') === -1);
ok('background: 兩個網址各註冊一對腳本', calls.registered.length === 4, 'registered=' + calls.registered.length);

const bridge = calls.registered.find((s) => s.world === 'ISOLATED');
const main = calls.registered.find((s) => s.world === 'MAIN');
ok('background: ISOLATED 跑 bridge.js @document_start', !!bridge && bridge.js[0] === 'content/bridge.js' && bridge.runAt === 'document_start');
ok('background: MAIN 跑 quote.js @document_idle', !!main && main.js[0] === 'content/quote.js' && main.runAt === 'document_idle');
ok('background: matches 帶入使用者網址', calls.registered.every((s) => s.matches.length === 1 && /^https:\/\/[ab]\.example\.com\/\*$/.test(s.matches[0])), JSON.stringify(calls.registered.map((s) => s.matches)));
ok('background: 回應列出已註冊的網址', response && response.registered && response.registered.length === 2, JSON.stringify(response));

/* 清單為空時：應把舊的 dshq- 全部移除、不再註冊 */
calls.registered.length = 0;
calls.unregistered.length = 0;
store.dshQuoteSites = [];
const emptyResponse = await new Promise((resolve) => messageListener({ type: 'dshq-sync' }, {}, resolve));
ok('background: 清單清空後不註冊任何腳本', calls.registered.length === 0);
ok('background: 清單清空後舊註冊被移除', calls.unregistered.flat().indexOf('dshq-bridge-old123') !== -1);
ok('background: 清單清空後回應為空', emptyResponse.registered.length === 0);

/* ---------------------------------------------------------------- 輸出 */

const failed = results.filter((r) => !r.pass);
results.forEach((r) => console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '  {' + r.detail + '}' : '')));
console.log('---');
console.log('TOTAL=' + results.length + ' PASSED=' + (results.length - failed.length) + ' FAILED=' + failed.length);
process.exitCode = failed.length ? 1 : 0;
