# Windows：任务面板不显示时的启动与诊断

这组工具解决一个 Windows 上常见的接入问题：Codex 桌面版已经安装 Taskboard，但
用户自己启动的 Codex 窗口里没有任务面板。

## 根因

Taskboard 是 CDP 注入型工具。它通过 `--remote-debugging-port` 连接 Codex 渲染器，
再把 `inject/codex-taskboard.user.js` 注入页面。没有 CDP 端口的 Codex 实例无法接收
注入，因此无论重启或重装多少次，面板都不会出现。

官方 Windows 启动器会另外拉起一个带独立 profile 和 CDP 的托管实例。这条路径还有
一个独立缺陷：`scripts/codex-injector.mjs` 的 `activateCodexApp()` 只在 macOS 上
实现，Windows 分支直接返回。托管窗口被其他窗口盖住或隐藏后，启动器不会再次把它
唤到前台，用户就会觉得面板“不见了”。

本目录提供：

- 源码修复：Windows 下复用 Store 应用的 AUMID 激活通道，把已运行的托管 Codex
  窗口带到前台。
- 只读诊断脚本：不改状态地判断入口、面板和窗口当前是否可用。

## 脚本

### Probe-CodexTaskboardPanel.ps1

```powershell
.\Probe-CodexTaskboardPanel.ps1
```

只读探测并输出 JSON。退出码：

| 退出码 | 含义 |
| --- | --- |
| 0 | 入口和面板已挂载，且处于可见的 Codex 窗口 |
| 1 | CDP 可达，但面板当前不可用 |
| 2 | 注入器、CDP 端点或主窗口目标缺失 |

判定面板是否真的可用，应同时满足：`entryMounted`、`panelVisible` 为真，
`statusVisible` 为假。iframe 的 `src` 常为 `about:blank`，这是 CDP
`Page.setDocumentContent` 的设计结果，不能作为失效判据。

## 验证记录

本机 Windows 11 + Codex `26.1002.7124.0`：

- 新增的 `activateWindowsCodexWindow()` 真机调用成功，返回有效进程号。
- `node --test test/windows-codex.test.mjs` 5/5 通过。

## 限制

- 最后一步集成验收需要关闭并重启 Codex，因此应在能接受会话中断时手动执行。
- 源码修复依赖 Store 版 Codex 的应用包元数据；非 Store 安装需要改用窗口级激活方案。
- `activateWindowsCodexWindow()` 返回的进程号来自应用激活通道，不一定是托管
  Codex 自身的进程号；它只用于判断激活是否成功。
