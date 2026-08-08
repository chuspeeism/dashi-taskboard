# 面向个人用户的三列议题工作台：ChatGPT Pro 协作与验收记录

## 协作信息

- ChatGPT Pro 对话：https://chatgpt.com/c/6a6b2b0e-9dc0-83ea-a57e-3addec457e70
- 源码基线：`677b54451db707ae6132486b6593b7be11e4ee09`
- 提交给 ChatGPT Pro 的源码 ZIP：
  - 文件：`codex-taskboard-pro-677b544.zip`
  - 字节数：`1,645,317`
  - SHA-256：`a1a96179554d69cb2770910c7857981fa2a14fb39afcaa6e6fcfc0b07a17fef6`
- ChatGPT Pro 交付 ZIP：
  - 文件：`codex-taskboard-pro-3col-board.zip`
  - 字节数：`1,635,271`
  - SHA-256：`a3cca47873283f4eec2a4710fb46f7cd5427bdc310318494598b7db3ca6cf14e`
- ChatGPT Pro 主补丁：
  - 文件：`codex-taskboard-pro-3col-board.patch`
  - 字节数：`67,714`
  - SHA-256：`5393f54db5c5e2dca8071f2a999dda49a39da4058076945320455b223f7b832a`
- ChatGPT Pro 修正补丁：
  - 文件：`codex-taskboard-pro-3col-board-fix.patch`
  - 字节数：`3,035`
  - SHA-256：`091df00ba8e1d9304f86109f731564de06f5301f574b7a90ece4f1a0353f1044`

## 实现范围

- 主工作台固定显示 `todo`、`in_progress`、`in_review` 三列。
- 三列文案改为“待处理”“处理中”“等你确认”。
- `backlog`、`blocked`、`done`、`canceled` 收入右侧“其他任务”面板。
- 侧面板支持四个状态 Tab、计数、详情入口、筛选同步和现有任务卡操作。
- 保留七状态领域模型、API、CLI、数据库和实时同步链路。
- 全局新建议题默认进入 `todo`；列内新建仍使用所在列状态。
- 删除旧的空列显示、手动隐藏列和“隐藏列”运行路径。
- 流程看板入口仍保持隐藏。

## 要求 ChatGPT Pro 修正的问题

首次交付为让目标测试全部通过，顺带修改了评论附件和自动认领功能的旧测试断言。这超出本次范围。已要求并取得最小修正补丁：

- 恢复评论附件测试的基线断言。
- 恢复自动认领测试的基线断言。
- 只保留删除 `BoardSettingsMenu.tsx` 所需的两处测试改动。
- 未修改运行时代码、依赖、锁文件或其他测试。

## 独立验收

- 源码 ZIP 展开后密钥扫描：`0` 条。
- ZIP 与主补丁应用后的源码：逐文件一致。
- 主补丁和修正补丁：`git apply --check` 通过。
- `package.json` 和 `package-lock.json`：与基线逐字节一致。
- `npm run typecheck`：通过。
- `npm run build:web`：通过。
- 当前工作树相关合同测试：`22/22` 通过。
- 当前工作树生产构建：通过。
- Codex 注入刷新：端口 `9231`，`refreshed: true`。
- 当前本地管理面板：已确认显示三列和“其他任务”入口。

完整 `npm test` 在安装锁文件完整依赖后执行：

- 基线：`349` 项，`332` 通过，`17` 失败。
- 修改后：`350` 项，`333` 通过，`17` 失败。
- 失败项目集合与基线一致，本次没有新增失败。

隔离数据目录中的真实页面已验证：

- 三个主状态列固定显示。
- “其他任务”面板默认关闭，可打开和关闭。
- 四个状态 Tab、计数和内容正确。
- 面板任务可进入详情，返回后保留活动 Tab。
- 搜索同时作用于主列和侧面板。
- 面板任务迁移到主列后，刷新页面仍保持新状态。

未自动执行原生指针拖拽。当前浏览器驱动未暴露拖拽动作；已检查真实拖拽链路仍复用 `TaskCard` 的 `dataTransfer` 和 `BoardColumn` 的原有 `onDrop`、排序及持久化流程。

## 当前状态

- 修改只存在于本地 `feature/consumer-task-board` 分支工作树。
- 未提交、未推送、未创建 PR、未部署。
- 未迁移数据库，未修改线上配置，未操作真实用户数据。
