# 项目文档索引

## 产品与运行规则

- [AI 介入与触发事件](ai-intervention-triggers.md)：什么操作会启动 planner、worker、handoff、自动化或故障恢复，模型默认值如何选择，以及每个入口的后果。
- [任务状态说明](task-status-reference.md)：八个任务状态的含义、责任人、进入条件、AI 副作用和推荐流转规则。
- [Cloud 协作](cloud-collaboration.md)：Cloudflare、D1、R2、设备侧 companion 和数据迁移。

## 功能规格

- [AI 对话自动重试 V1](specs/ai-chat-auto-retry-v1.md)
- [macOS Codex Taskboard Launcher V1](specs/macos-codex-taskboard-launcher-v1.md)
- [多项目任务面板 V1](specs/multi-project-board-v1.md)
- [父任务 Sol 与子任务派发 V1](specs/parent-sol-child-dispatch-v1.md)

## 文档维护规则

以下行为变化必须在同一个改动中更新对应文档：

- 新增、删除或重命名任务状态。
- 改变任何状态的进入条件、退出条件或副作用。
- 改变评论按钮的 intent、action、文案或状态后果。
- 改变 readiness、planner、worker、handoff、自动重试或项目自动开发的触发条件。
- 改变 planner/worker 的模型默认值、用户选择规则、推理强度、服务等级或沙箱权限。
- 新增能够创建 AI thread、启动 AI run 或改变任务状态的入口。

维护完成后至少检查：

1. README 中的入口仍然有效。
2. 本索引中的相对链接没有断链。
3. 两份参考文档对同一状态和触发事件的表述一致。
4. 文档描述的是当前代码事实；目标行为或待修问题必须明确标注，不能写成已经实现。
