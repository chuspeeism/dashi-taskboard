# In Review 验收与退回原任务设计

## 目标与范围

让用户在议题详情页完成两条明确的 In Review 主路径：

1. 查看最近一次 Agent 交付说明，确认后将议题标记为 `done`。
2. 写下验收反馈，保存为 Taskboard 评论，并把同一反馈发送给议题已绑定的 Codex 任务；发送成功后将议题移回 `in_progress`。

本阶段不修改自动领项、实时进度、状态模型、数据库结构或普通评论的通知语义，不创建新的 Codex 任务。

## 已证明的现有操作链

- 验收入口：`web/src/components/TaskCard.tsx` 在 `in_review` 卡片上显示“完成”，调用 `web/src/App.tsx` 的 `moveTask(task, "done")`，最终通过现有任务移动 API 更新状态，用户看到卡片进入完成状态。
- 评论入口：`web/src/components/TaskDetail.tsx` 的 `submitComment()` 调用 `web/src/api.ts` 的 `createComment()`，服务端写入评论并通过实时事件刷新界面；该路径不会向 Codex 任务发送消息。
- 绑定入口：`TaskDetail.tsx` 和 `App.tsx` 已能读取完整 `threadBinding` 并打开精确的本地或 SSH Codex 任务。
- 原生边界：嵌入页消息经 `inject/codex-taskboard.user.js` 的 capability/challenge 校验进入固定宿主绑定；`scripts/codex-injector-runtime.mjs` 校验宿主请求，`scripts/codex-injector.mjs` 已通过 Codex App Server 的 `turn/start` 向精确 `threadId` 发起回合。

## 方案比较

### A. 详情页轻量验收区（采用）

在现有详情页主栏中增加 In Review 专用验收区，显示最近一条非空 Agent 评论和两个明确动作。退回动作复用现有评论输入框，不新增编辑器或弹窗。

优点：信息与动作同页；最少新增 UI；复用评论、状态更新和绑定数据。缺点：需要跨 Web、注入脚本和宿主请求边界发送反馈。

### B. 验收弹窗

点击卡片或详情页按钮后打开独立弹窗，集中展示交付说明、反馈框和动作。

优点：流程聚焦。缺点：复制现有评论编辑能力，增加附件、焦点、响应式和错误状态处理，不符合当前最小主路径。

### C. 扩展现有“改为等待认领”开关

把现有评论开关改成“退回并通知”。

优点：改动面小。缺点：继续混淆“回到待认领”和“继续原绑定任务”，且无法自然表达验收通过，因此不采用。

## 交互设计

### 验收区

仅当 `currentTask.status === "in_review"` 时显示，位置在议题内容之后、活动时间线之前。

- 标题：“等待你验收”。
- 内容：按 `createdAt` 取最近一条 `authorType === "agent"` 且正文非空的评论，原样用现有 Markdown 渲染器展示；没有时显示“暂无 Agent 交付说明，请打开处理对话查看结果”。
- 若议题有完整 `threadBinding`，保留现有对话链接。
- 主按钮：“通过并完成”。调用现有任务更新路径把状态改为 `done`。
- 次按钮：“写退回意见”。滚动并聚焦现有评论框，同时切换为“退回原任务”提交意图。

### 评论框

普通状态保持现状。In Review 时明确显示：

- 普通“评论”仍只保存记录，不通知 Codex。
- “退回并继续原任务”只在存在完整 `threadBinding` 且反馈正文非空时可用；附件不能替代正文，因为发送给 Codex 的是文本反馈。
- 现有“改为等待认领”动作改写为“仅改为等待认领（不通知）”，保留原能力但消除语义误导。

### 状态与错误

- 通过成功：`in_review -> done`，不发送 Codex 消息。
- 退回成功：先保存用户评论，再把反馈发送到完整 `threadBinding.threadId`；宿主确认 `turn/start` 成功后，使用最新议题版本执行 `in_review -> in_progress`，保留完整绑定。
- 评论保存失败：停止，不发送、不改状态。
- Codex 发送失败：评论保留，议题保持 `in_review`，展示明确错误；不创建新任务、不自动重试。
- 发送已确认但状态更新失败：展示“反馈已发送，但状态更新失败”，刷新议题；不再次发送。该跨系统边界无法做数据库事务，本阶段不引入持久化幂等层。
- 无完整绑定或仅有 legacy local thread：不提供自动退回按钮，提示用户打开原对话或改为等待认领；不得猜测项目或主机。

## 组件与数据流

### 通过并完成

`TaskDetail` 验收区 → `onUpdate(currentTask, { status: "done" })` → 现有任务更新 API/数据库 → App 任务状态刷新 → 用户看到完成状态。

### 退回并继续原任务

`TaskDetail` 评论框 → `createComment()` 保存反馈 → 重新读取议题并核对 `in_review` 与完整绑定 → `App` 发出带 request ID 的嵌入宿主消息 → 注入层校验 frame capability/challenge → 固定宿主校验 thread binding 和反馈边界 → Codex App Server `turn/start` 精确发送到保存的 host/thread → 成功响应 → `onUpdate(..., { status: "in_progress" })` → 用户看到处理中状态。

请求不包含新建任务参数，宿主处理器也不调用 `thread/start` 或 `create_thread`。

## 安全与边界

- 只接受完整五字段绑定：`threadId`、`codexProjectId`、`codexProjectKind`、`codexHostId`、`workspacePath`。
- 宿主请求沿用现有 authenticated iframe capability、隔离 world binding 和 host ID 路由。
- 反馈文本必须非空并限制在现有评论正文上限内；不读取任意文件，不操作附件内容。
- 每次点击最多发起一个 `turn/start`；按钮在请求中禁用。未知结果不自动重试。
- 不操作真实 Taskboard 数据；直接验证使用现有测试、fixture 和隔离宿主 stub。

## 直接验证与验收标准

风险等级：高。原因是改动跨越 UI、原生注入宿主和 Codex App Server 外部边界，但不涉及数据库迁移、进程生命周期、安装或发布。

验证预算是退回失败路径加一条成功主路径：

1. 测试先证明无完整绑定时不会显示/触发自动退回。
2. 测试证明一条退回请求只携带保存的 host/thread 和正文，调用一次 `turn/start`，不包含创建任务调用。
3. 隔离页面验证评论保存 → 精确发送 → 状态变 `in_progress`；模拟发送失败时评论保留、状态仍为 `in_review`。
4. 真实 UI 预览只使用 fixture：能看到最近交付说明、“通过并完成”、“写退回意见”，普通评论的“不通知”含义清楚。

完成定义：用户可在一个详情页通过或退回；退回只继续原绑定任务，不创建自动化或新任务；发送失败不会误改状态。

## 视觉选择回执

- 项目批准来源：未发现独立批准的设计规范；现有 `web/src/components/TaskDetail.tsx` 与 `web/src/styles.css` 作为运行中的主基线。
- 记录的缺口：In Review 缺少清晰的交付摘要与主次验收动作层级。
- 外部池：`/Users/lyon/Documents/Codex/VisualStyleLibrary/sources/awesome-design-md`。
- 池提交：`8147538b4226ae41e2487a9179e3bcc1f68e8554`。
- 选中条目：`design-md/linear.app/DESIGN.md`，权利标签 `public_reference_only`。
- 来源陈述：参考条目使用单一强调色表达少量关键 CTA，次级按钮保持表面色，按钮采用紧凑间距与中等圆角。
- 采用推断：只采用“一个明确主动作、一个次动作、静默辅助说明”的层级；颜色、字号、圆角和间距全部继续使用 Taskboard 现有 token。
- 拒绝项：不采用 Linear 的品牌色、专有字体、Logo、深色营销画布或其他识别性元素；Notion 条目因彩色品牌表达超出此缺口而未采用。
- 预览与 QA：实现完成后在隔离 fixture 页面检查信息层级、可读性、间距、对比度、键盘焦点、窄屏布局和中英文文案；在用户确认前不合并或发布。
