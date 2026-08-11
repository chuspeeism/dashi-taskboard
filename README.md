# Codex Taskboard

Codex Taskboard 是一个本地优先的任务面板。它可在浏览器中运行，也可通过 macOS App 注入官方 Codex/ChatGPT 客户端。React 界面、`taskctl` CLI 和内置 Codex Skill 使用同一套 HTTP API。

## macOS App

### 操作路径

1. 用户打开 `Codex Taskboard.app`。
2. App 从自身资源启动 Node.js 和本地任务面板服务。服务只监听 `127.0.0.1` 上的本次启动随机端口。
3. App 用本次启动的随机 CDP 端口启动官方 Codex/ChatGPT 客户端独立窗口，并注入任务面板入口。
4. 用户在 Codex 侧栏打开任务面板。启动器不显示主窗口或 Dock 图标；正常启动、等待和无更新结果只写入日志。只有发现更新、启动失败，或用户确认更新后发生失败时才显示原生弹窗。
5. 用户修改任务、评论或附件。服务把数据写入 `~/Library/Application Support/Codex Taskboard`，并把变化推送到所有已打开的面板。

用户用 `Cmd-Q` 正常退出 Codex/ChatGPT 后，启动器不会强制重开它。再次打开 `Codex Taskboard.app` 会重新启动官方客户端并注入面板。官方客户端异常退出时，启动器会自动恢复。

App 不修改官方客户端的 `app.asar`。App 自带 Node.js、服务、Web 界面、注入器、Skill 和 `taskctl`，所以安装机不需要系统 Node.js 或本仓库。

### 系统要求

- macOS 14 或更高版本。
- Apple Silicon 或 Intel Mac。GitHub Release 提供同一个 universal 安装包。
- 已安装官方 Codex/ChatGPT 客户端。支持以下位置：
  - `/Applications/ChatGPT.app`
  - `~/Applications/ChatGPT.app`
  - `/Applications/Codex.app`
  - `~/Applications/Codex.app`

当前不提供 Windows 或 Linux App。

### 下载和安装

1. 打开 [GitHub Releases](https://github.com/chuspeeism/dashi-taskboard/releases)。
2. 下载当前已发布版本的 `.dmg`。不要使用仍为 Draft 的 Release。
3. 打开 DMG，把 `Codex Taskboard.app` 拖到“应用程序”。
4. 从“应用程序”打开 App。启动器在后台运行，不显示主窗口或 Dock 图标。
5. 转到新打开的官方 Codex/ChatGPT 窗口，从侧栏进入任务面板。

仓库中的 `0.1.0` 手写 App 没有 Tauri Updater。首次安装 Tauri 正式版 `0.2.0` 时，必须手动下载 DMG 并替换旧 App。真实自动升级路径必须用 `0.2.0 → 0.2.1` 验证，不能用 `0.1.0 → 0.2.0` 代替。

### 数据、配置和日志

替换 App、安装更新或回滚 App 时，不会删除以下用户数据：

| 内容 | 路径 |
| --- | --- |
| SQLite 数据库 | `~/Library/Application Support/Codex Taskboard/taskboard.sqlite` |
| 附件 | `~/Library/Application Support/Codex Taskboard/attachments/` |
| 云端配对和本地项目映射 | `~/Library/Application Support/Codex Taskboard/cloud-companion.json` |
| 自动化策略 | `~/Library/Application Support/Codex Taskboard/codex-automation-policies.json` |
| 启动日志 | `~/Library/Logs/Codex Taskboard/codex-taskboard-launcher.log` |

回滚只替换 `/Applications/Codex Taskboard.app`。不要删除或覆盖 `~/Library/Application Support/Codex Taskboard`。如果回滚版本包含数据库格式变化，先保留该目录的副本，再验证旧版本能读取它。

### 自动更新

App 每次启动时只检查一次 GitHub Releases。没有更新时保持静默；发现新版本时显示原生确认弹窗。用户选择“立即更新”后，App 会下载更新包并验证 Updater 签名；验证通过后才停止任务面板服务、替换 App 并自动重启。更新失败时显示中文错误弹窗，并说明任务面板服务是否已恢复。用户选择“稍后”后，本次运行不再检查。发布版从以下地址读取 Tauri 的静态更新清单：

```text
https://github.com/chuspeeism/dashi-taskboard/releases/latest/download/latest.json
```

Tauri Updater 先用 App 内置公钥验证 `.app.tar.gz` 的签名，再安装更新。Updater 私钥只存在于 GitHub Actions Secret 中。Developer ID 签名和 Apple 公证用于让 Gatekeeper 验证 App 与 DMG；它们不能替代 Updater 签名。

Draft Release 不会成为 GitHub 的 latest Release。审核人批准受保护的 promotion job 后，工作流会重新下载并验证 Draft 资产，再发布和锁定 Release。只有 promotion 成功后，已安装 App 才会看到该版本。

## 本地开发

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

签名、公证和 Updater 构建需要下文列出的环境变量。不要把证书、P8、密码或 Updater 私钥写入仓库、`.env` 或命令历史。

### 启动本地服务

```bash
npm run build
npm start
```

打开 <http://127.0.0.1:47823>。开发仓库默认把 SQLite 数据库存到 `.data/taskboard.sqlite`。

## 发布 macOS App

`.github/workflows/check.yml` 在 PR 中使用 macOS runner 准备内置 Node，并构建真实的 unsigned universal App bundle。`.github/workflows/release-macos.yml` 只接受 `v*` 标签推送。构建 job 验证标签提交属于 `main`，并确认 `package.json`、`Cargo.toml` 和 `tauri.conf.json` 的版本一致，然后使用 Node.js 22、Rust 1.88 和两个 macOS Rust target 构建 universal 包并创建 GitHub Draft Release。它同时保存 4 个上传资产的可信 SHA-256 manifest。独立的 `macos-release` promotion job 从 Draft 重新下载全部资产，对比 manifest，并重新执行签名、公证、Team ID、Updater 公钥、`latest.json` 和 App/DMG/updater 内容一致性验证。验证通过后，该 job 发布 Release，并确认 Release 已不可变且最终资产摘要未变化。所有第三方 Action 都锁定到完整提交 SHA。

内置 Node 版本固定为 `22.23.2`。arm64 与 x64 安装包的 SHA-256 已写入 `scripts/prepare-tauri-app.mjs`，构建不会信任与安装包同源、临时下载的校验清单。

### GitHub Secrets

在仓库的 Actions Secrets 中配置：

| Secret | 内容 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application `.p12` 的单行 Base64 内容 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `KEYCHAIN_PASSWORD` | GitHub runner 临时 keychain 的密码 |
| `APPLE_SIGNING_IDENTITY` | `security find-identity -v -p codesigning` 输出的 Developer ID 证书 SHA；使用 SHA 可避免同名证书歧义 |
| `APPLE_API_ISSUER` | App Store Connect API Issuer ID |
| `APPLE_API_KEY` | App Store Connect API Key ID |
| `APPLE_API_PRIVATE_KEY` | App Store Connect API `.p8` 文件的完整内容 |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri Updater 私钥的完整内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri Updater 私钥密码；只有私钥加密时需要，未加密可不配置 |

`APPLE_API_KEY_PATH` 不是仓库 Secret。工作流把 `APPLE_API_PRIVATE_KEY` 写入 runner 的临时文件，再把该文件路径设为 `APPLE_API_KEY_PATH`。构建结束后，工作流删除 P8、P12 和临时 keychain。

在 `macos-release` environment secrets 中配置 `RELEASE_RULESET_TOKEN`。它必须是仅限本仓库的 fine-grained PAT，并具有 Repository Administration 写权限，使 GitHub API 返回 `bypass_actors`，并允许 promotion 读取 immutable releases 设置。promotion 只把该 token 用于这两项管理状态查询；Secret 缺失、字段不可见或 API 权限不足时，发布会失败。

`GITHUB_TOKEN` 由 GitHub Actions 自动提供。工作流给它 `contents: write` 和 `deployments: write` 权限，用于创建 Draft、运行受保护的 promotion 和发布 Release。

发布前还必须完成以下仓库设置：

- 启用覆盖当前 `v*` 标签的 active tag ruleset。`exclude` 必须为空，`bypass_actors` 必须为空，并启用禁止更新和禁止删除规则。
- 创建 `macos-release` environment，配置必需审核人，并启用“禁止发起人自行审核”。
- 启用 immutable releases。promotion 在发布前检查此设置，并在发布后校验 Release API 的 `immutable: true` 和每个资产的 SHA-256。

### 发布 `v0.2.2`

1. 在 PR 中把 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json` 的版本同步为目标版本。
2. 合并已审核的 PR。
3. 确认所有 GitHub Secrets 和上述仓库发布设置已配置。
4. 在已合并提交上创建并推送标签：

   ```bash
   git tag -a v0.2.2 -m "Codex Taskboard 0.2.2"
   git push origin v0.2.2
   ```

5. 等待构建 job 创建 Draft Release。不要在 GitHub Release 页面直接发布。
6. 完成下方检查后，批准等待中的 `macos-release` promotion job。
7. 等待 promotion 重新下载并验证全部远程资产、发布 Release，并确认最终 Release 和资产不可变。

### Draft Release 检查清单

- 工作流完成签名、公证和 stapling，没有跳过步骤。
- Draft 包含 universal `.dmg`、`.app.tar.gz`、对应 `.sig` 和 `latest.json`。
- `latest.json` 的版本与标签一致，并包含 `darwin-aarch64` 和 `darwin-x86_64`；两者都指向本次 universal `.app.tar.gz`。
- 在 Intel Mac 和 Apple Silicon Mac 上都能安装 DMG。
- `codesign --verify --deep --strict`、`spctl --assess` 和 `xcrun stapler validate` 均通过。
- 启动器没有主窗口或 Dock 图标，能启动本地服务、打开官方客户端并注入任务面板。
- 新建或修改任务后，重启 App，数据和附件仍存在。
- 启动时能读取 `latest.json`；没有更新时静默，有更新时只显示一次确认弹窗。首个真实升级验证使用 `0.2.0 → 0.2.1`。

如果 Draft 检查失败，不要批准 promotion，也不要手动发布。修复代码并走新 PR，再用新的补丁版本标签创建 Draft。已发布版本回滚时，只替换 App；保留 Application Support 数据，并发布更高版本号的修复版本。

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
