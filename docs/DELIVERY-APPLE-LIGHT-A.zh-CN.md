# Apple Light A 源码交付索引

这是 dashi-taskboard Apple Light A 的限定交付包索引，不是可独立运行的源码仓库。包内不含 `package.json`、应用源码、Codex profile 或签名 App/DMG。

所有 `npm`、`node`、`taskctl` 与构建命令都必须在完整源码仓库的 `feature/apple-light-a` 分支中运行，不能在本输出目录运行。开始前先阅读[安装、启动与回滚](INSTALL-APPLE-LIGHT-A.zh-CN.md)。

## 交付文件

- [安装、启动与回滚](INSTALL-APPLE-LIGHT-A.zh-CN.md)
- [最终 QA 与已知边界](apple-light-a-qa.md)
- [源码版本记录](source-revision.txt)

## 验收截图

- [Codex 左侧 Plugins → Taskboard 入口](screenshots/customized-codex-sidebar-light.png)
- [项目切换浮层](screenshots/project-switcher-overlay-light.png)
- [浅色 1440px 的 40px 布局节奏](screenshots/taskboard-spacing-light-1440.png)
- [深色 900px 响应式布局](screenshots/taskboard-spacing-dark-900.png)
- [已完成列与独立归档入口](screenshots/board-completed-archive-entry-light.png)
- [独立归档视图](screenshots/archive-dedicated-light.png)
- [1728px 浅色看板](screenshots/board-light-1728.png)
- [1440px 浅色看板](screenshots/board-light-1440.png)
- [1280px 浅色看板](screenshots/board-light-1280.png)
- [900px 浅色看板](screenshots/board-light-900.png)
- [深色模式回归](screenshots/board-dark-regression-1440.png)
- [真实 70% 任务进度](screenshots/task-progress-light-70.png)
- [自动化设置](screenshots/automation-light.png)
- [归档基线](screenshots/archive-light.png)

结构化 Codex DOM JSON 只由源码仓库中的安全捕获脚本写入被 Git 忽略的 `.artifacts/codex-qa/customized-codex`，不包含在本输出包中。
