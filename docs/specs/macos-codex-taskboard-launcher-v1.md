# macOS Codex + Taskboard 启动入口 Spec

## 目标

提供一个可从 Finder 识别的 `Codex + Taskboard.app` 入口，并把 Taskboard 服务与 SQLite 数据目录交给独立的 LaunchAgent 管理。用户退出并重新打开该入口后，官方 Codex 通过 loopback CDP 启动，Taskboard 注入器在主 renderer 中恢复入口和面板。

## 范围

- 生成并安装一个单一 Finder 入口，不要求用户输入仓库路径或终端命令。
- 生成独立的 Taskboard 服务 LaunchAgent：登录启动、异常退出后恢复，明确固定数据目录。
- 生成 Codex 入口 LaunchAgent：登录时调用同一个 Finder 入口；不使用 `KeepAlive` 反复重启 Codex。
- 普通 Codex 入口无法提供 CDP 时只提示一次可诊断的降级信息；不循环弹窗。
- Codex renderer 消失后注入器在短暂恢复窗口结束后退出，使用户可以再次打开唯一入口。

## 不做

- 不修改官方 `ChatGPT.app` 或其 `app.asar`。
- 不把自动认领、周期性强制重启或 keepalive 任务加入启动链路。
- 不写真实飞书业务数据，不改变 Taskboard 的业务任务状态。

## 验收标准

1. 生成的 app bundle 和两个 LaunchAgent 都使用当前仓库、Node 和 `.data` 的绝对路径；服务 LaunchAgent 具有 `RunAtLoad + KeepAlive`，Codex LaunchAgent 不具有 `KeepAlive`。
2. 运行入口后，`codex-injector` 的验证结果同时包含 `entryMounted`、`pageMounted`、`frameLoaded` 为真，iframe URL 为 loopback Taskboard URL。
3. 退出并再次打开 `Codex + Taskboard.app` 后，新的主 renderer 再次满足上述结果；注入器退出期间不产生重复重启提示。
4. 登录启动只运行一次入口；若普通官方 Codex 已占用且没有 CDP，输出一次降级通知并保留日志，不能循环弹窗或后台强制重启。

## 回滚

卸载本地 LaunchAgent 并删除生成的 `Codex + Taskboard.app`；仓库代码和 Taskboard `.data` 不删除。
