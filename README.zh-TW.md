[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

# Codex Taskboard

一個本地優先的議題面板，可在瀏覽器中執行，也可透過獨立 CDP 啟動器或其注入指令碼嵌入 Codex。同一套 HTTP API 為 React UI 和隨附 Codex Skill 使用的 `taskctl` CLI 提供支援。

![Codex Taskboard 產品截圖](docs/assets/codex-taskboard.png)

## 系統要求

- Node.js 22.5 或更高版本
- 建置 macOS App 和 DMG：Xcode Command Line Tools、Rust 1.88 或更高版本，以及 `aarch64-apple-darwin` 和 `x86_64-apple-darwin` target。`npm install` 會安裝本專案使用的 Tauri CLI。
- 建置 Windows NSIS：Microsoft Store 版 Codex App、Rust 1.88 或更高版本，以及帶 C++ 工作負載和 Windows SDK 的 Visual Studio Build Tools。

## 本地執行

```bash
npm install
npm run build
npm start
```

開啟 <http://127.0.0.1:47823>。SQLite 資料庫儲存在 `.data/taskboard.sqlite`。

如需在前端實時過載模式下開發：

```bash
npm run dev
```

Vite UI 執行在 <http://127.0.0.1:5173>，並將 API 請求代理到本地服務。

## 使用 CLI

在專案中執行：

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

請執行 `npm link`，以便在 shell 路徑中使用 `taskctl`。設定 `CODEX_TASKBOARD_URL`，可讓 CLI 指向另一個本地或區域網路服務。雲端部署透過**迴環 companion**（本機 loopback 配套服務，不是「伴侶」）使用 `taskctl cloud login` 設定。

## 安裝 Codex Skill

將 `skills/manage-taskboard` 複製或符號連結到 Codex Skill 目錄，然後啟動一個新的 Codex 任務：

```bash
ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.agents/skills/manage-taskboard
```

桌面 App 會讓該目錄與內建 Skill 保持同步。該 Skill 會指導 Codex 檢查議題，將其移到 `in_progress`，使用樂觀版本控制，驗證工作，然後將其移到 `in_review`；只有在使用者明確確認接受或要求將議題標記為完成後，才會將議題移到 `done`。

## 嵌入 Codex

### 手動：使用專用 CDP 埠

讓現有 Codex 視窗保持開啟。在 Taskboard 儲存庫中，使用專用 CDP 埠啟動第二個 Codex 執行個體：

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

新 Codex 視窗出現後，在另一個終端中執行注入器：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

使用嵌入式面板時，讓注入器終端保持執行。原 Codex 視窗不會變化，新視窗會顯示 Taskboard 側邊欄入口。如果埠 `9231` 已被佔用，請在兩個指令中使用另一個埠。

### 推薦：用一個指令啟動獨立 Taskboard 視窗

讓現有 Codex 視窗保持開啟，然後執行：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

該指令會在需要時啟動本地 Taskboard 服務。它會複用已開啟且有可用 CDP 渲染器的 Codex；普通 Codex 沒有 CDP 時，它會在該執行個體的原生瀏覽面板中開啟 Taskboard；沒有開啟 Codex 時，它會使用獨立設定檔案和僅限迴環存取的埠 `9231` 啟動官方 macOS Codex App。有可用 CDP 時，它會在 Plugins 後注入一個原生外觀的 Taskboard 入口，並持續監視服務和替換後的渲染器。使用嵌入式面板時，請讓該指令保持執行。啟動器不會修改 `ChatGPT.app` 或其 `app.asar`。

原始碼啟動器會把帶身分資訊的服務地址寫入 `.data/launcher-runtime.json`。透過 `npm link` 安裝的 `taskctl` 預設讀取此檔案。因此，普通 shell 和從面板開啟的 Codex 任務無需設定額外環境變數，即可使用同一個 Taskboard 服務。

### macOS App：無需終端即可開啟和注入

如需進行 Tauri 開發，請執行：

```bash
npm run app:dev
```

如需建置本地 App 和 DMG，請先安裝兩個 Rust target，然後執行建置：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run app:build
```

從 Finder 開啟 `src-tauri/target/universal-apple-darwin/release/bundle/macos/Codex Taskboard.app`。DMG 位於 `src-tauri/target/universal-apple-darwin/release/bundle/dmg/`。如果只需安裝穩定版，請從 [GitHub Releases](https://github.com/chuspeeism/dashi-taskboard/releases/latest) 下載目前 DMG。

該 App 包含自己的 Node 執行時、Taskboard 服務、建置後的 Web UI、Skill、CLI 包裝器和注入指令碼。它會啟動服務，複用已開啟且有可用 CDP 渲染器的 Codex；普通 Codex 沒有 CDP 時，它會在該執行個體的原生瀏覽面板中開啟 Taskboard；沒有開啟 Codex 時，它會啟動官方 Codex App。有可用 CDP 時，它會等待渲染器並注入側邊欄入口，然後在不顯示終端視窗的情況下開啟面板。該 App 可以複製到本檢出目錄之外；目標 Mac 只需安裝官方 Codex App，不需要此儲存庫、系統 Node 安裝或單獨的 Codex CLI 安裝。Taskboard 資料儲存在 `~/Library/Application Support/Codex Taskboard`，啟動器輸出寫入 `~/Library/Logs/Codex Taskboard/codex-taskboard-launcher.log`。

本地建置使用 ad-hoc 程式碼簽名進行直接驗證。公開的 macOS 下載仍需要 Developer ID 簽名和 Apple 公證。

### Linux App：Ubuntu 24.04 x64 軟體包

Linux 桌面版第一版僅支援 Ubuntu 24.04 LTS x64。請先安裝官方 ChatGPT 桌面版 `.deb`，並確認執行 `chatgpt` 可以開啟它。然後從 [GitHub Releases](https://github.com/chuspeeism/dashi-taskboard/releases/latest) 下載 Codex Taskboard `.deb` 或 `.AppImage`。請將以下指令中的 `<file>` 替換為下載的檔名。

安裝 `.deb` 軟體包：

```bash
sudo apt install ./<file>.deb
```

或者執行 AppImage：

```bash
chmod +x ./<file>.AppImage
./<file>.AppImage
```

如需在 Ubuntu 24.04 x64 上建置這兩種軟體包，請執行：

```bash
npm ci
npm run app:build:linux:x64
```

第一版不支援 ARM64、Fedora、RPM 軟體包或其他 Linux 發行版。

### Windows App：托盤啟動器與內建 Taskboard

先從 Microsoft Store 安裝官方 Codex App。在 Windows x64 上執行以下指令建置目前使用者級 NSIS 安裝包：

```powershell
npm ci
npm run app:build:windows
```

安裝包位於 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。它包含托盤啟動器、內建 Node、本地服務、建置後的 Web UI、Skill、`taskctl.cmd` 和注入指令碼。Taskboard 資料儲存在 `%APPDATA%\Codex Taskboard`，日誌儲存在 `%LOCALAPPDATA%\Codex Taskboard\Logs`，Skill 會複製到 `%USERPROFILE%\.agents\skills\manage-taskboard`。

Windows CI 產物目前有意保持未簽名，也不支援自動更新。分發前請閱讀[程式碼簽名策略](docs/code-signing-policy.md)。保留資料的行為見 [Windows 解除安裝說明](docs/windows-uninstall.md)。

Codex 26.715.52143 的渲染器 CSP 會阻止任意 HTTP iframe。因此，啟動器會啟用 CDP CSP 繞過，重新載入該渲染器一次，安裝文件啟動指令碼，並等待 Taskboard OOPIF 實際載入。同一臺機器上的其他程序存取 CDP 時不需要身分驗證，因此啟動器執行時只能執行受信任的原生程式碼。

要注入一個已經透過其他方式使用 CDP 啟動的 Codex 執行個體，請執行：

```bash
npm run codex:inject -- --port 9229 --open
```

該指令也會保持駐留，因此服務退出後，注入的標籤頁可以重新啟動 Taskboard。使用 `Ctrl-C` 停止該指令。

該指令碼會在 Codex 側邊欄新增 Taskboard 入口，並在 Codex 的整個主工作區渲染 iframe，包括上下文標題欄區域，因此 Taskboard 自己的頁首不會留下空白條。這個完整的矩形頁首位於 Electron 可拖動層之上，並標記為 `no-drag`；由於 Taskboard 活動時會隱藏原生上下文操作，它自己的操作可以使用正常的邊緣內邊距，不會產生人為的右側空隙。原生側邊欄保持掛載，此前頁面的選中狀態和上下文頁首會暫時隱藏；選擇另一個 Codex 頁面會恢復它們。

“在對話中開啟”會在可用時選擇對應的原生 Codex 專案，並開啟一個未傳送的原生 composer，其中包含 `e-taskboard` 指令和議題的真實識別符號。已安裝的 Skill 會根據該指令隱式選中，因此 composer 不會新增 `$manage-taskboard` 提及。只有在會話實際處理該議題後，才會記錄該會話的歸屬關係：`taskctl` 讀取 Codex 的 `CODEX_THREAD_ID`，並在議題或評論變更上記錄該 ID。記錄的 ID 可透過 Codex 的原生路由橋接點選。每個議題可以綁定一個 Git 分支或一個 worktree；選項從所選 Codex 專案的儲存庫掃描，而不是手動輸入。該整合使用 Codex 現有的專案、composer 和路由標記；它不會修改 React、替換 `fetch`、載入私有 chunk 或編輯 Codex 資料檔案。

要使用不同的 UI 來源，請在使用者指令碼執行前設定 `window.__CODEX_TASKBOARD_URL__`。

## 設定

| 變數 | 預設值 | 用途 |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP 綁定地址；使用 `127.0.0.1` 可禁用區域網路存取 |
| `CODEX_TASKBOARD_PORT` | `47823` | 本地 HTTP 埠 |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite 資料目錄 |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API 源地址 |

`npm start` 會輸出本地 URL 和可用的區域網路 URL。同一受信任網路中的協作者可以開啟其中一個區域網路 URL，並使用同一個 Taskboard 服務。任務、評論和附件變化透過伺服器傳送事件廣播到所有開啟的用戶端；用戶端重連後會執行完整重新整理，因此不會遺漏斷開連線期間發生的變化。使用 `taskctl` 的協作者可以透過 `CODEX_TASKBOARD_URL=http://<host-ip>:47823` 指向共享服務。

區域網路模式沒有帳戶身分驗證：受信任本地網路中任何能存取該 URL 的人都可以讀取和寫入 Taskboard。公網和雲端部署需要經過身分驗證的部署邊界。

## 透過 Cloudflare 共享

對於兩名受信任的協作者，Taskboard 可以在 Cloudflare 上執行，使用 Worker Static Assets 和 API 路由，以 D1 作為權威業務資料庫，並使用私有 R2 bucket 儲存附件。該部署使用帶共享密碼的 HTTPS Basic 身分驗證，並在全域修訂號變化後重新整理已開啟的面板。

每臺裝置保留自己的專案檢出對應，並繼續使用**本地 companion**（本機配套服務 / 環回代理）提供 Codex、Git/worktree、Skill 和 MCP 能力。請勿將 companion 譯為「伴侶」，也不要把普通 Taskboard HTTP 介面稱為「伴侶 API」。雲端模式絕不會回退到本地 SQLite 資料庫，也不會同時寫入本機資料庫。

請參閱[雲端協作](docs/cloud-collaboration.md)，瞭解所有者部署、現有 GitHub 安裝設定、密碼輪換、本地路徑對應和一次性本機資料遷移流程。

## 驗證

```bash
npm run check
```

該指令會執行 TypeScript 檢查、生產前端建置、元件測試，以及伺服器/CLI/注入測試套件。

## 議題 Markdown

議題描述和評論支援 GFM，包括表格和任務清單。`mermaid` 圍欄程式碼區塊會在檢視器載入後渲染成只讀圖；渲染失敗時仍可閱讀原始圖表原始碼。Markdown HTML 註釋（例如 `<!-- trace-analysis:v1 ... -->`）不會出現在渲染後的正文中，且不會啟用原始 HTML。
