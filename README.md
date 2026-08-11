# Codex Taskboard

Codex Taskboard 是一个内嵌于 Codex APP 的任务面板。用于在 Codex APP 中管理、查看任务进度与状态

## 系统要求

- macOS 14 或更高版本。
- 已安装官方 Codex/ChatGPT 客户端。支持以下位置：

- [ ] Windows 版本适配中
 
## 下载和安装

1. 打开 [GitHub Releases](https://github.com/chuspeeism/dashi-taskboard/releases) 下载对应设备版本
2.  安装并从“应用程序”打开 App。启动器在后台运行，不显示主窗口或 Dock 图标。
5. 转到新打开的官方 Codex/ChatGPT 窗口，从侧栏进入任务面板。

## 数据、配置和日志

| 内容 | 路径 |
| --- | --- |
| SQLite 数据库 | `~/Library/Application Support/Codex Taskboard/taskboard.sqlite` |
| 附件 | `~/Library/Application Support/Codex Taskboard/attachments/` |
| 云端配对和本地项目映射 | `~/Library/Application Support/Codex Taskboard/cloud-companion.json` |
| 自动化策略 | `~/Library/Application Support/Codex Taskboard/codex-automation-policies.json` |
| 启动日志 | `~/Library/Logs/Codex Taskboard/codex-taskboard-launcher.log` |


# 本地开发

### 要求

- Node.js 22.5 或更高版本
- Rust 1.88
- Xcode 和 Xcode Command Line Tools

安装依赖并启动浏览器开发环境：

```bash
npm ci
npm run dev
```

Vite 界面位于 <http://127.0.0.1:5173>，并把 API 请求转发到本地服务。

准备并启动 Tauri 开发版：

```bash
npm ci
npm run app:dev
```

构建与发布工作流相同的 universal App 和 DMG：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run app:build
```

### 启动本地服务

```bash
npm run build
npm start
```

打开 <http://127.0.0.1:47823>。开发仓库默认把 SQLite 数据库存到 `.data/taskboard.sqlite`。


## 使用 `taskctl`

从仓库运行：

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

如需在 shell 中直接使用 `taskctl`，可运行 `npm link`。`CODEX_TASKBOARD_URL` 可让 CLI 连接另一台本地或局域网服务。云端部署通过本地 companion 和 `taskctl cloud login` 配置。


## 安装 Codex Skill

把 `skills/manage-taskboard` 复制或链接到 Codex Skills 目录，然后新建 Codex 任务：

```bash
ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.codex/skills/manage-taskboard
```

Skill 会让 Codex 读取任务、移到 `in_progress`、使用乐观版本、验证结果，再移到 `in_review`。只有用户明确验收或要求完成时，它才把任务移到 `done`。

## 不安装 App 时嵌入 Codex

### 推荐：使用独立 CDP 窗口

保留现有 Codex 窗口，并运行：

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

新窗口出现后，在另一个终端运行：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

注入器运行期间，独立窗口会显示 Taskboard 侧栏入口。现有 Codex 窗口不变。

### 一条命令启动独立窗口

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

该命令按需启动本地服务，打开官方 macOS Codex App 的独立 profile，注入侧栏入口，并持续监控服务和 renderer。它不修改 `ChatGPT.app` 或 `app.asar`。

如需注入已用其他方式开启 CDP 的 Codex 实例：

```bash
npm run codex:inject -- --port 9229 --open
```

Codex 26.715.52143 的 renderer CSP 会阻止任意 HTTP iframe。启动器使用 CDP 绕过该 renderer 的 CSP，并等待隔离的 Taskboard iframe 实际加载。正式 App 每次启动使用新的随机 CDP 端口和服务身份令牌；本地开发命令中的固定 CDP 端口只用于受信任的本机开发环境。

“在对话中打开”会选择对应的原生 Codex 项目，并打开带任务标识的未发送原生 composer。任务实际处理后，`taskctl` 从 `CODEX_THREAD_ID` 记录会话。记录的会话可通过 Codex 原生路由打开。每个任务可绑定一个 Git 分支或 worktree。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP 监听地址；设为 `127.0.0.1` 可关闭局域网访问 |
| `CODEX_TASKBOARD_PORT` | `47823` | 本地 HTTP 端口 |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite 和附件目录 |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API 地址 |

`npm start` 会输出本机和局域网地址。同一受信任网络中的用户可打开局域网地址。任务、评论和附件变化通过 server-sent events 推送；断线重连后会执行完整刷新。

局域网模式没有账号认证。可访问该地址的人都能读写任务面板。不要把该模式直接暴露到公网。

## Cloudflare 协作

两名受信任协作者可使用 Worker Static Assets、D1 和私有 R2 bucket 运行云端任务面板。每台设备仍保留自己的项目 checkout 映射，并用本地 companion 提供 Codex、Git/worktree、Skill 和 MCP 能力。

部署、密码轮换、路径映射和一次性数据迁移见 [Cloud collaboration](docs/cloud-collaboration.md)。

## 检查

```bash
npm run check
```

该命令运行 TypeScript 检查、生产 Web 构建和服务端、CLI、注入器测试。
