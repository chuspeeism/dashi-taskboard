# Apple Light A 安装、启动与回滚

本交付是基于 dashi-taskboard v1.0.3 的本地源码变体。它通过独立 Codex 配置启动，不修改 `/Applications/ChatGPT.app`、普通 Codex 配置或现有对话数据。

## 环境要求

- macOS，且已安装官方 Codex App；本机验收版本为 `26.810.50856`（build `6644`）。
- Node.js `>=22.5`；本机验收使用 `v24.19.0`。
- 安装依赖时需要 npm registry 访问；浏览器验收使用 Google Chrome `151.0.7922.138`。

## 启动 Scheme A

在源码目录运行：

```bash
npm ci
npm run build:web
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

保持终端运行。启动器会使用独立 profile 启动第二个 Codex 窗口，并把“任务面板”放在左侧 Plugins 后。Codex 的浅色/深色切换会同步到面板，筛选、搜索、选中任务和详情不会因主题消息而重载。

默认服务只监听 `127.0.0.1:47823`，CDP 只监听 `127.0.0.1:9231`。不要为了本地使用把 `CODEX_TASKBOARD_HOST` 改成 `0.0.0.0`。

## 数据、运行信息与 Skill

- 源码运行数据：仓库内 `.data/taskboard.sqlite`。
- 独立 Codex profile：默认位于 `/private/tmp/codex-taskboard-independent-profile-v2`。如需持久化到其他位置，启动前设置 `CODEX_TASKBOARD_CODEX_PROFILE=/绝对路径/独立-profile`；该变量会覆盖默认路径。
- 带身份信息的临时端点：`.data/launcher-runtime.json`；不要复制到交付包或公开日志。
- Skill 源码：`skills/manage-taskboard/SKILL.md`。
- 源码启动器日志：当前终端标准输出/错误。
- 已签名上游 App 的独立数据与日志（仅供区分）：`~/Library/Application Support/Codex Taskboard` 与 `~/Library/Logs/Codex Taskboard/codex-taskboard-launcher.log`。

使用 `taskctl` 时必须用完整议题 ID，并尊重返回的 `version`。已完成任务可以打开编辑、选择“继续任务”回到处理中，或归档；归档记录通过独立“归档”入口查看并恢复。

## 停止

在运行 `npm run codex` 的终端按 `Ctrl-C`。等待进程退出后可用以下只读命令确认端口已关闭：

```bash
lsof -nP -iTCP:47823 -sTCP:LISTEN
lsof -nP -iTCP:9231 -sTCP:LISTEN
```

若挂载过上游 DMG，可在 Finder 点推出，或对已确认的挂载点执行 `hdiutil detach <挂载点>`。不要对未知卷使用通配符。

## 回滚与移除

1. 先按上节停止源码启动器。
2. 删除或移走本源码检出即可移除界面变体；普通 Codex 不受影响。
3. 如曾手动链接 Skill，只删除该精确链接：`~/.codex/skills/manage-taskboard`。先用 `ls -l` 确认它指向本仓库。
4. 如需清空本变体数据，先备份，再只移除本仓库的 `.data`；不要删除 `~/Library/Application Support/Codex`。
5. 如需清理源码启动器的独立 Codex profile，先确认启动器已经停止，再用 `ls -ld /private/tmp/codex-taskboard-independent-profile-v2` 核对精确默认目录后移除它。若启动时设置过 `CODEX_TASKBOARD_CODEX_PROFILE`，只清理该变量指向并经你核实的独立目录，不要误删普通 Codex profile。
6. 若使用过上游 Codex Taskboard App，其数据是另一套目录；除非明确不再需要上游数据，不要删除 `~/Library/Application Support/Codex Taskboard`。

## 生成最小化 QA 入口证据

`node scripts/capture-codex-taskboard-qa.mjs` 默认把证据写入被 Git 忽略的 `.artifacts/codex-qa/customized-codex`。JSON 只保留主题、运行时存在性和 Plugins/Taskboard 相邻顺序字段，不保存页面 `bodyText`、任务或线程正文；PNG 直接裁剪到必要的两个侧栏入口区域，而不是整屏截图。

只有在明确需要其他临时目录时，才把第三个参数设为经过核实的输出路径：`node scripts/capture-codex-taskboard-qa.mjs 9231 /绝对路径/临时证据目录`。不要把未经检查的原始 CDP 输出复制到交付包。

## 签名与 DMG 边界

上游 v1.0.3 DMG 已单独通过签名、Gatekeeper 与哈希验证。本地 Apple Light A 源码没有可供 `app:preflight` 验证的自定义 `.app`，环境中也没有发布签名前置，因此本轮没有运行 `app:build`，没有修改或重新签名上游 DMG，也没有交付“已签名自定义 DMG”。当前可运行交付路径是上面的 `npm run codex`。
