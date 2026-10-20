# DSH 引用助手（Chrome 擴充套件）

在 [DSH](https://github.com/deepseek-ai) 網頁介面（`http://127.0.0.1:3080`）的對話區**框選文字**，選取處旁會浮出兩顆按鈕：

| 按鈕 | 行為 |
| --- | --- |
| **引用** | 把框選文字送進下方輸入框（DSH 的 Lexical 編輯器），接在游標位置／草稿後面 |
| **複製** | 把框選文字放進系統剪貼簿，完成後顯示「已複製」 |

省去「選取 → Ctrl+C → 點輸入框 → Ctrl+V」這串動作。

## 功能

- 框選即出按鈕，不需要開右鍵選單。
- **引用**：直接呼叫 Lexical 的模型層插入（等同 DSH 內建貼上的路徑），支援多行、`Ctrl+Z` 可復原；失效時自動退回合成 `paste` 事件 → `execCommand('insertText')` → 直接改 DOM，每一步都驗證是否真的插入。
- **複製**：`navigator.clipboard.writeText()` 優先，被拒時退回 `execCommand('copy')`；不需要輸入框也能用（例如複製整段回答去別的地方）。
- 顯示範圍：只在對話區（預設）／整頁任何位置；輸入框內選取一律不觸發。
- 引用格式：原文照貼／Markdown 引用（每行加 `>`）；複製永遠是原文。
- 設定即時生效，不需重新整理。

## 安裝（開發者模式載入）

1. Chrome 開啟 `chrome://extensions`。
2. 右上角開啟 **開發人員模式**。
3. 左上角 **載入未封裝項目**，選擇本專案資料夾（含 `manifest.json` 的那一層）。
4. 回到 DSH 網頁按 `F5` 重新整理。

> 也可以下載 Releases 裡的 `DSH引用助手-V2.zip`，解壓後用同一個方式載入。

## 使用

1. 在 DSH 對話訊息上選取文字 → 旁邊出現「引用」「複製」。
2. 按「引用」送進輸入框；按「複製」進剪貼簿。
3. `Esc` 或點空白處關閉按鈕。

## 設定

點工具列上的擴充套件圖示：啟用浮動按鈕、顯示「複製」按鈕、顯示範圍、引用插入格式。

## 目錄結構

```
manifest.json          Manifest V3 設定（content scripts 只在 127.0.0.1 / localhost 生效）
content/quote.js       MAIN world：浮動按鈕、選取判定、引用插入、複製
content/bridge.js      ISOLATED world：把 chrome.storage 設定同步成 <html data-dshq-*>
popup/                 設定面板
icons/                 圖示
使用說明.md            完整使用說明與疑難排解
```

## 開發備註

- DSH 的輸入框是 Lexical 0.49（`<div data-composer-input contenteditable>`），不是 `textarea`；`MAIN world` 才拿得到 `rootElement.__lexicalEditor`。
- 驗證方式：Chrome headless + CDP，在載入真實 Lexical 0.49 的模擬頁上驅動本擴充套件，確認「引用插入」與「複製到剪貼簿」都真的生效（Chrome 155 已封鎖用命令列 `--load-extension` 載入未封裝套件，實機要用 UI 載入）。

## 版本

- **V2（2.0.0）**：新增「複製」按鈕與 fallback、按鈕組、popup 新設定。
- **V1（1.0.0）**：框選後「引用」送進輸入框。

## License

MIT，見 [LICENSE](LICENSE)。
