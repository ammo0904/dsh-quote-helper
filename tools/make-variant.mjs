/* 產生「停用策略 A」的測試變體，並在每次點擊後記錄實際使用的策略。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(HERE, '..', '..', 'DSH引用助手-V1', 'content', 'quote.js');
const dst = path.join(HERE, 'quote-fallback.js');

let text = fs.readFileSync(src, 'utf8');

const needle = '\t\tif (editor) {\n\t\t\tconst outcome = lexInsert';
if (!text.includes(needle)) {
  console.error('PATTERN NOT FOUND: strategy A');
  process.exit(1);
}
text = text.replace(needle, '\t\tif (false && editor) {\n\t\t\tconst outcome = lexInsert');

const notifyLine = "\t\tif (result === 'no-composer')";
if (!text.includes(notifyLine)) {
  console.error('PATTERN NOT FOUND: notify');
  process.exit(1);
}
text = text.replace(
  notifyLine,
  '\t\t(window.__strategies = window.__strategies || []).push(result);\n' + notifyLine
);

fs.writeFileSync(dst, text, 'utf8');
console.log('variant written:', dst, '| size', text.length);

/* 另一個變體：策略 A 照常啟用，只加上策略記錄（用來確認正式版走哪一條路）。 */
let instrumented = fs.readFileSync(src, 'utf8');
if (!instrumented.includes(notifyLine)) {
  console.error('PATTERN NOT FOUND: notify (instrumented)');
  process.exit(1);
}
instrumented = instrumented.replace(
  notifyLine,
  '\t\t(window.__strategies = window.__strategies || []).push(result);\n' + notifyLine
);
const dst2 = path.join(HERE, 'quote-instrumented.js');
fs.writeFileSync(dst2, instrumented, 'utf8');
console.log('instrumented written:', dst2, '| size', instrumented.length);
