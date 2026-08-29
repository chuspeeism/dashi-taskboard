[English](README.md) | [简体中文](README.zh-CN.md)

# Codex Taskboard

一个本地优先的议题面板，可在浏览器中运行，也可通过独立 CDP 启动器或其注入脚本嵌入 Codex。同一套 HTTP API 为 React UI 和随附 Codex Skill 使用的 `taskctl` CLI 提供支持。

![Codex Taskboard 产品截图](docs/assets/codex-taskboard.png)

## 系统要求

- Node.js 22.5 或更高版本
- 构建 macOS App 和 DMG：Xcode Command Line Tools、Rust 1.88 或更高版本，以及 `aarch64-apple-darwin` 和 `x86_64-apple-darwin` target。`npm install` 会安装本项目使用的 Tauri CLI。
- 构建 Windows NSIS：Microsoft Store 版 Codex App、Rust 1.88 或更高版本，以及带 C++ 工作负载和 Windows SDK 的 Visual Studio Build Tools。

## 本地运行

```bash
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:47823>。SQLite 数据库存储在 `.data/taskboard.sqlite`。

如需在前端实时重载模式下开发：

```bash
npm run dev
```

Vite UI 运行在 <http://127.0.0.1:5173>，并将 API 请求代理到本地服务。

## 使用 CLI

在项目中运行：

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

请运行 `npm link`，以便在 shell 路径中使用 `taskctl`。设置 `CODEX_TASKBOARD_URL`，可让 CLI 指向另一个本地或局域网服务。云端部署通过**回环 companion**（本机 loopback 配套服务，不是「伴侣」）使用 `taskctl cloud login` 配置。

## 安装 Codex Skill

将 `skills/manage-taskboard` 复制或符号链接到 Codex Skill 目录，然后启动一个新的 Codex 任务：

```bash
ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.agents/skills/manage-taskboard
```

桌面 App 会让该目录与内置 Skill 保持同步。该 Skill 会指导 Codex 检查议题，将其移到 `in_progress`，使用乐观版本控制，验证工作，然后将其移到 `in_review`；只有在用户明确确认接受或要求将议题标记为完成后，才会将议题移到 `done`。

## 嵌入 Codex

### 手动：使用专用 CDP 端口

让现有 Codex 窗口保持打开。在 Taskboard 仓库中，使用专用 CDP 端口启动第二个 Codex 实例：

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

新 Codex 窗口出现后，在另一个终端中运行注入器：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

使用嵌入式面板时，让注入器终端保持运行。原 Codex 窗口不会变化，新窗口会显示 Taskboard 侧边栏入口。如果端口 `9231` 已被占用，请在两个命令中使用另一个端口。

### 推荐：用一个命令启动独立 Taskboard 窗口

让现有 Codex 窗口保持打开，然后运行：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

该命令会在需要时启动本地 Taskboard 服务。它会复用已打开且有可用 CDP 渲染器的 Codex；普通 Codex 没有 CDP 时，它会在该实例的原生浏览面板中打开 Taskboard；没有打开 Codex 时，它会使用独立配置文件和仅限回环访问的端口 `9231` 启动官方 macOS Codex App。有可用 CDP 时，它会在 Plugins 后注入一个原生外观的 Taskboard 入口，并持续监视服务和替换后的渲染器。使用嵌入式面板时，请让该命令保持运行。启动器不会修改 `ChatGPT.app` 或其 `app.asar`。

源码启动器会把带身份信息的服务地址写入 `.data/launcher-runtime.json`。通过 `npm link` 安装的 `taskctl` 默认读取此文件。因此，普通 shell 和从面板打开的 Codex 任务无需设置额外环境变量，即可使用同一个 Taskboard 服务。

### macOS App：无需终端即可打开和注入

如需进行 Tauri 开发，请运行：

```bash
npm run app:dev
```

如需构建本地 App 和 DMG，请先安装两个 Rust target，然后运行构建：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run app:build
```

从 Finder 打开 `src-tauri/target/universal-apple-darwin/release/bundle/macos/Codex Taskboard.app`。DMG 位于 `src-tauri/target/universal-apple-darwin/release/bundle/dmg/`。如果只需安装稳定版，请从 [GitHub Releases](https://github.com/chuspeeism/dashi-taskboard/releases/latest) 下载当前 DMG。

该 App 包含自己的 Node 运行时、Taskboard 服务、构建后的 Web UI、Skill、CLI 包装器和注入脚本。它会启动服务，复用已打开且有可用 CDP 渲染器的 Codex；普通 Codex 没有 CDP 时，它会在该实例的原生浏览面板中打开 Taskboard；没有打开 Codex 时，它会启动官方 Codex App。有可用 CDP 时，它会等待渲染器并注入侧边栏入口，然后在不显示终端窗口的情况下打开面板。该 App 可以复制到本检出目录之外；目标 Mac 只需安装官方 Codex App，不需要此仓库、系统 Node 安装或单独的 Codex CLI 安装。Taskboard 数据存储在 `~/Library/Application Support/Codex Taskboard`，启动器输出写入 `~/Library/Logs/Codex Taskboard/codex-taskboard-launcher.log`。

本地构建使用 ad-hoc 代码签名进行直接验证。公开的 macOS 下载仍需要 Developer ID 签名和 Apple 公证。

### Linux App：Ubuntu 24.04 x64 软件包

Linux 桌面版第一版仅支持 Ubuntu 24.04 LTS x64。请先安装官方 ChatGPT 桌面版 `.deb`，并确认运行 `chatgpt` 可以打开它。然后从 [GitHub Releases](https://github.com/chuspeeism/dashi-taskboard/releases/latest) 下载 Codex Taskboard `.deb` 或 `.AppImage`。请将以下命令中的 `<file>` 替换为下载的文件名。

安装 `.deb` 软件包：

```bash
sudo apt install ./<file>.deb
```

或者运行 AppImage：

```bash
chmod +x ./<file>.AppImage
./<file>.AppImage
```

如需在 Ubuntu 24.04 x64 上构建这两种软件包，请运行：

```bash
npm ci
npm run app:build:linux:x64
```

第一版不支持 ARM64、Fedora、RPM 软件包或其他 Linux 发行版。

### Windows App：托盘启动器与内置 Taskboard

先从 Microsoft Store 安装官方 Codex App。在 Windows x64 上运行以下命令构建当前用户级 NSIS 安装包：

```powershell
npm ci
npm run app:build:windows
```

安装包位于 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。它包含托盘启动器、内置 Node、本地服务、构建后的 Web UI、Skill、`taskctl.cmd` 和注入脚本。Taskboard 数据存储在 `%APPDATA%\Codex Taskboard`，日志存储在 `%LOCALAPPDATA%\Codex Taskboard\Logs`，Skill 会复制到 `%USERPROFILE%\.agents\skills\manage-taskboard`。

Windows CI 产物目前有意保持未签名，也不支持自动更新。分发前请阅读[代码签名策略](docs/code-signing-policy.md)。保留数据的行为见 [Windows 卸载说明](docs/windows-uninstall.md)。

Codex 26.715.52143 的渲染器 CSP 会阻止任意 HTTP iframe。因此，启动器会启用 CDP CSP 绕过，重新加载该渲染器一次，安装文档启动脚本，并等待 Taskboard OOPIF 实际加载。同一台机器上的其他进程访问 CDP 时不需要身份验证，因此启动器运行时只能运行受信任的本地代码。

要注入一个已经通过其他方式使用 CDP 启动的 Codex 实例，请运行：

```bash
npm run codex:inject -- --port 9229 --open
```

该命令也会保持驻留，因此服务退出后，注入的标签页可以重新启动 Taskboard。使用 `Ctrl-C` 停止该命令。

该脚本会在 Codex 侧边栏添加 Taskboard 入口，并在 Codex 的整个主工作区渲染 iframe，包括上下文标题栏区域，因此 Taskboard 自己的页眉不会留下空白条。这个完整的矩形页眉位于 Electron 可拖动层之上，并标记为 `no-drag`；由于 Taskboard 活动时会隐藏原生上下文操作，它自己的操作可以使用正常的边缘内边距，不会产生人为的右侧空隙。原生侧边栏保持挂载，此前页面的选中状态和上下文页眉会暂时隐藏；选择另一个 Codex 页面会恢复它们。

“在对话中打开”会在可用时选择对应的原生 Codex 项目，并打开一个未发送的原生 composer，其中包含 `e-taskboard` 指令和议题的真实标识符。已安装的 Skill 会根据该指令隐式选中，因此 composer 不会添加 `$manage-taskboard` 提及。只有在会话实际处理该议题后，才会记录该会话的归属关系：`taskctl` 读取 Codex 的 `CODEX_THREAD_ID`，并在议题或评论变更上记录该 ID。记录的 ID 可通过 Codex 的原生路由桥接点击。每个议题可以绑定一个 Git 分支或一个 worktree；选项从所选 Codex 项目的仓库扫描，而不是手动输入。该集成使用 Codex 现有的项目、composer 和路由标记；它不会修改 React、替换 `fetch`、加载私有 chunk 或编辑 Codex 数据文件。

要使用不同的 UI 来源，请在用户脚本运行前设置 `window.__CODEX_TASKBOARD_URL__`。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP 绑定地址；使用 `127.0.0.1` 可禁用局域网访问 |
| `CODEX_TASKBOARD_PORT` | `47823` | 本地 HTTP 端口 |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite 数据目录 |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API 源地址 |

`npm start` 会输出本地 URL 和可用的局域网 URL。同一受信任网络中的协作者可以打开其中一个局域网 URL，并使用同一个 Taskboard 服务。任务、评论和附件变化通过服务器发送事件广播到所有打开的客户端；客户端重连后会执行完整刷新，因此不会遗漏断开连接期间发生的变化。使用 `taskctl` 的协作者可以通过 `CODEX_TASKBOARD_URL=http://<host-ip>:47823` 指向共享服务。

局域网模式没有账户身份验证：受信任本地网络中任何能访问该 URL 的人都可以读取和写入 Taskboard。公网和云端部署需要经过身份验证的部署边界。

## 通过 Cloudflare 共享

对于两名受信任的协作者，Taskboard 可以在 Cloudflare 上运行，使用 Worker Static Assets 和 API 路由，以 D1 作为权威业务数据库，并使用私有 R2 bucket 存储附件。该部署使用带共享密码的 HTTPS Basic 身份验证，并在全局修订号变化后刷新已打开的面板。

每台设备保留自己的项目检出映射，并继续使用**本地 companion**（本机配套服务 / 环回代理）提供 Codex、Git/worktree、Skill 和 MCP 能力。请勿将 companion 译为「伴侣」，也不要把普通 Taskboard HTTP 接口称为「伴侣 API」。云端模式绝不会回退到本地 SQLite 数据库，也不会同时写入本地数据库。

请参阅[云端协作](docs/cloud-collaboration.md)，了解所有者部署、现有 GitHub 安装设置、密码轮换、本地路径映射和一次性本地数据迁移流程。

## 验证

```bash
npm run check
```

该命令会运行 TypeScript 检查、生产前端构建、组件测试，以及服务器/CLI/注入测试套件。

## 议题 Markdown

议题描述和评论支持 GFM，包括表格和任务列表。`mermaid` 围栏代码块会在查看器加载后渲染成只读图；渲染失败时仍可阅读原始图表源码。Markdown HTML 注释（例如 `<!-- trace-analysis:v1 ... -->`）不会出现在渲染后的正文中，且不会启用原始 HTML。
