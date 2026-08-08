# 飞书 Base ↔ Taskboard 插件操作路径 V1

> 状态：路径证据已核对，插件运行时尚未实现
>
> 冻结范围：只同步 `产品灵感` 与 `需求收集管理` 的定义字段；本阶段只允许本地适配器回执、Taskboard 写入和 Base 只读。
>
> 本文是操作路径与范围契约，不是功能实现，也不授权真实 Base 写入、批量迁移、历史回填或新建定时任务。

## 1. 冻结结论

### 1.1 三个系统的责任边界

| 系统 | 本插件中的权威或职责 | 明确不负责 |
| --- | --- | --- |
| Taskboard | 编辑、任务状态、优先级、执行上下文、Codex readiness/planner/worker 触发和执行记录的权威；本地实现是 `TaskboardDatabase` + 任务 API，云模式仍以 Taskboard 的业务 API/数据库为准 | 不把 Base 的原始业务字段当作任务状态权威；不因同步自动把 `backlog` 推进到 `todo` 或 `in_progress` |
| 飞书 Base | 在本规格定义的字段范围内保存完整镜像，并作为入站的产品灵感/需求收集来源；当前阶段只读 | 不直接启动 Codex，不覆盖 Taskboard 状态，不提供未列入白名单的表或字段 |
| workflow-bridge | 仅提供只读的权威分工、幂等/CAS、Hermes writer、ACK/readback 契约参考 | 不是第四事实源，不持有本插件状态，不直接写 Base，不替代 Taskboard 或 Hermes |
| Hermes | 未来出站真实写入时的 Feishu 单一 writer；必须接收稳定幂等包并返回可核验 ACK | 不执行本地开发，不替用户验收；本阶段不启动真实写入 |

“Base 是完整镜像”只表示：白名单内的每个定义字段都必须有确定的投影、回读和差异处理；不表示把 Taskboard 的内部 AI 对话、handoff、附件、历史表或全部 SQLite 表复制到 Base。未列入白名单的字段不属于缺失镜像，也不得被自动读取或补写。

Taskboard 与 Base 已建立映射后，Taskboard 的编辑和状态仍然优先。Base 快照只能用于发现新记录、核对允许的源字段和报告漂移；除第 4.2 节规定的“Taskboard 未变化且已批准的非状态字段最小版本化更新”外，不能直接覆盖 Taskboard 的标题、描述、状态或执行信息。历史状态和旧记录保持原样，不因本规格批量改写或回填。

本插件未来自身持有 source-link、sync-run、outbox、冲突、Hermes ACK 和 Base readback 状态；workflow-bridge 不持有、不推进、不替插件执行这些运行状态。

### 1.2 同步对象白名单

允许读取、映射和未来镜像的源对象只有：

- `产品灵感`：产品灵感原始记录，默认投影为 Taskboard `backlog`。
- `需求收集管理`：需求收集记录；无论 Base 当前状态值是什么，新导入记录统一投影为 Taskboard `backlog`。Base 状态只作为允许的源字段保留和镜像核对，不能推进或覆盖 Taskboard 状态；未知状态值报告 `信息不足`，但不得因此把新记录写入其他 Taskboard 状态。

字段使用语义白名单，而不是根据表中所有字段自动展开：

| 字段组 | 允许的语义 | 方向 | 规则 |
| --- | --- | --- | --- |
| 来源身份 | Base app/table/record 稳定标识、源更新时间、快照时间和字段摘要哈希 | Base → Taskboard 插件收据 | 用于去重、漂移检查和回读定位；不能用标题相似度替代 |
| 需求正文 | 名称/标题、摘要/描述/背景、项目或领域、允许的下一步说明 | Base → Taskboard 初始任务 | 映射前必须做字段存在性、类型和长度校验；未知字段 fail closed |
| 执行镜像 | Taskboard `task_id`、短标识、`status`、`priority`、`labels`、负责人、`version`、`updated_at` | Taskboard → Base | 只反映 Taskboard 权威值；不把 AI 原始输出或本地路径扩展成 Base 字段 |
| 关联与证据 | 稳定源记录键、Taskboard 标识、投影版本、幂等键、回读结果引用 | Taskboard 插件协调状态 | 用于证明链路，不承载账号、支付或提示词正文 |

以下内容不读取、不映射、不回写，且不因表名或字段名变化而放宽：

- 账号资料、登录身份、个人资料、凭据、Cookie、token；
- 支付、订单、订阅、余额、信用额度或其他计费信息；
- 提示词、提示词库、生成参数或提示词版本正文；
- 竞品明细、竞品研究记录、Similarweb/流量/价格明细和竞品快照；
- 任何未被上述两张表及字段白名单明确覆盖的 Base 表、视图、附件和长文档。

真实接入前必须实时读取并记录 Base 的 app/table/field schema；旧文档里的 table id、历史字段数和样例记录不能代替当前 schema 验证。

## 2. 当前代码证据与实现状态

### 2.1 Taskboard 写入、版本和回读原语

当前本地实现已经提供以下可复用原语：

1. `server/database.mjs:549-555` 创建 `TaskboardDatabase`，SQLite 以 WAL 和事务运行。
2. `server/database.mjs:569-605` 的 `tasks` 表保存标题、描述、状态、优先级、标签、负责人、`thread_id`、执行上下文、版本和更新时间；没有 Base record 映射列。
3. `server/database.mjs:980-984` 只有任务创建用的 `task_idempotency_keys`，没有 Feishu external-key 映射表、同步 outbox 或 Base ACK 表；这些 source-link、运行、outbox、冲突和 ACK/readback 状态由未来插件自身持有，当前尚未实现。
4. `server/app.mjs:597-650` 校验任务创建和 PATCH 字段；`server/app.mjs:515-525` 读取 `Idempotency-Key` 请求头。
5. `POST /api/tasks` 在 `server/app.mjs:1993-2011` 调用 `createTaskIdempotently`；相同幂等键返回原任务而不是重复创建。创建响应不是完整同步证明，必须再用 `GET /api/tasks/:id` 回读并比较允许字段。
6. `PATCH /api/tasks/:id` 与 `POST /api/tasks/:id/move` 在 `server/app.mjs:2328-2350` 使用任务 `version`；数据库在 `server/database.mjs:2821-2915`、`2917-2968` 以 `WHERE id = ? AND version = ?` 做 CAS，成功后递增版本并返回任务。

`web/src/components/workflowCatalog.ts` 中已有的 Feishu 消息/文档工作流节点只是通用 UI 工作流定义，不提供本规格所需的 Base schema 白名单、record 映射、Hermes writer 或 Base 回读，因此不计入 Base ↔ Taskboard 同步能力。

因此，Taskboard 具备“幂等创建 + 版本化更新 + API 回读”的基础能力，但没有完成“按 Base record 找到既有任务、投影并双向回写”的插件能力。入站适配器不能把 `Idempotency-Key` 表误称为 external-key 映射，也不能把 HTTP 200/201 误称为完整回读。

### 2.2 EventHub、SSE 和卡片可见性

现有本地事件链路如下：

```text
任务 API / 数据库成功变更
  → EventHub.emit(task.created/task.updated/task.moved/...)
  → GET /api/events 的 SSE 客户端
  → React 刷新项目与任务列表
  → backlog 列显示 Taskboard 卡片
```

证据：

- `server/app.mjs:1075-1125` 的 `EventHub` 维护内存客户端和监听器，发送 `text/event-stream`；它不是持久化事件日志，也没有跨重启重放能力。
- `server/app.mjs:1465-1543` 把数据库服务、readiness、planner/worker 协调器接到同一个 EventHub；任务路由成功后才 emit 任务事件。
- `server/app.mjs:2014-2020` 暴露 `GET /api/events`，只接受 SSE 订阅，不接受同步参数或写入操作。
- `web/src/App.tsx:500-600` 订阅 SSE，收到 `task.*` 后刷新项目、任务和执行概览；`web/src/api.ts:358-378` 通过 `GET /api/tasks` 读取列表。
- `web/src/components/BoardColumn.tsx:8-20` 将 `backlog` 显示为“积压事项”，所以写入一个 `status=backlog` 的任务并完成列表回读后，才有“backlog 卡片可见”的本地观察结果。

SSE 只证明 Taskboard 内部事件已经广播，不证明 Base 已读、已写、已 ACK 或已回读。适配器必须以 API/数据库回读作为业务结果，以 SSE 作为刷新提示。

### 2.3 readiness、planner 和 worker 触发边界

入站同步不能直接启动开发：

- `server/task-readiness-coordinator.mjs:176-218` 规定：Codex 负责人任务进入 `todo`，或在 `todo` 修改标题、描述、标签时，才启动 readiness；用户以 `resume` 评论补充信息时才复审。
- `server/task-readiness-coordinator.mjs:243-297` 创建只读 `planner` 审核线程，并持久化审核轮次、源任务版本和运行绑定。
- `server/task-readiness-coordinator.mjs:318-370` 审核需要补充信息时写评论并把任务移到 `blocked`；审核通过才发出 `readinessApproved` 并调用 `onReady`。
- `server/app.mjs:1497-1535` 的 `onReady` 对普通 Codex 任务启动 worker；顶层 `主任务` 不在这里直接启动普通 worker。
- `server/task-coordinator.mjs:282-323` 只对符合主任务 planner 入口或既有编排的事件继续调度；存在 planner 线程本身不等于 planner run 已成功执行。

冻结规则：同步创建或更新 `backlog` 只产生卡片和同步收据；不自动移动到 `todo`，不自动认领，不自动创建 readiness/planner/worker。只有用户明确把卡片移到 `todo`，才进入现有 readiness 规则。

## 3. 双向操作路径契约

### 3.1 入站：Base → Taskboard → backlog 可见

这是本插件的目标操作路径；其中标为“待实现”的部分当前没有运行时代码。验收时必须保留每一步的收据，不得把整条目标路径写成已经完成。

| 段 | 入口与操作 | 数据/副作用 | 可观察结果 | 当前状态 |
| --- | --- | --- | --- | --- |
| I0 | 手动同步入口，或每日对账入口携带唯一 `run_id` 调用适配器 | 只建立 Taskboard 插件自己的 sync-run；不启动开发 | 有入口参数、时间、范围和插件回执位置 | **待实现**；Taskboard 没有 Feishu 同步路由，workflow-bridge 的每日/手动约束只是契约参考 |
| I1 | 适配器只读取 Feishu 白名单：`产品灵感`、`需求收集管理`；先读 schema，再读记录 | 生成只读 snapshot、稳定 record key、字段摘要哈希；不调用 Base 写 API，不读排除对象 | snapshot 显示允许表、字段、记录数、unknown/conflict | **待实现**；当前仓库没有 Base client 或白名单同步入口 |
| I2 | 对每条允许记录做语义投影和去重；为创建派生稳定 `Idempotency-Key`，为既有任务先 GET 当前 `version` | 新记录统一以 `status=backlog` 写入 Taskboard；既有任务只有在 Taskboard 未变化且字段获准为非状态字段时，才可按第 4.2 节做最小版本化更新；所有更新都用当前版本 CAS；不写 `todo`/`in_progress` | `POST /api/tasks` 返回 201 或幂等重放返回 200；更新返回 200；错误或版本冲突 fail closed | **原语已有，适配器待实现**；`TaskboardDatabase` 没有 source-record link，需要插件自己的稳定映射收据 |
| I3 | 对每次写入立即 `GET /api/tasks/:id`，比较白名单投影、任务标识、状态、版本和更新时间 | 形成 Taskboard 插件自己的 readback receipt；未知写入结果先回读，禁止盲目重放 | receipt 为 `readback_verified` 或明确 `conflict/blocked` | **API 可做，链路待实现** |
| I4 | Taskboard 成功写入后由 API emit `task.created/task.updated/task.moved`；UI 已订阅 `/api/events` | EventHub 内存广播并触发 UI 刷新；不作为持久化业务状态 | SSE 收到任务事件，任务列表重新 GET | **现有能力** |
| I5 | 打开对应项目的 backlog 列，读取刷新后的任务列表 | 只读展示，不自动改变状态 | 能看到标题、描述/标签等允许投影，且 `status=backlog` | **现有 UI 能力；真实 Base→Taskboard 样例未在本任务执行** |

入站的“成功”必须至少包含：`snapshot_verified`、Taskboard write response、Taskboard GET readback、SSE/UI 可见性。只有 dry-run、测试替身、生成 JSON 或本地 outbox 记录时，状态最多为 `prepared`/`shadow_verified`，不能标记为入站完成。

### 3.2 出站：Taskboard → Hermes → Base 镜像

这是未来真实双向同步的目标路径；本阶段只允许走到无副作用适配器回执和 Base 只读核对。

| 段 | 入口与操作 | 数据/副作用 | 可观察结果 | 当前状态 |
| --- | --- | --- | --- | --- |
| O0 | Taskboard 任务 API 成功变更产生 `task.created`、`task.updated` 或 `task.moved` 事件 | 事件携带任务和项目上下文；只选择白名单项目/任务 | EventHub/SSE 可观察事件；任务版本已经递增 | **现有能力** |
| O1 | 根据任务事件读取当前 Taskboard 任务，做权威字段投影 | 以 Taskboard 的标题、描述、状态、优先级、标签、负责人、标识和版本为准；过滤所有排除字段 | 得到确定性 canonical payload 和 payload hash | **投影规则待实现** |
| O2 | 将 payload 写入 Taskboard 插件自己的本地 outbox，带 `event_id`、source task version、target record key、幂等键和 expected Base version | 只写插件协调状态，不碰 Base；同一幂等键的不同 payload 必须转 conflict | 可查看 `pending/blocked/readback_verified` 等插件 outbox receipt | **待实现**；当前 `TaskboardDatabase` 没有 outbox |
| O3 | Hermes 作为唯一 writer 消费 Hermes package，按幂等键写入 Base | 真实 Base 写入只发生在另行批准的 Hermes 流程；workflow-bridge 不直接写 | Hermes 返回 `success`、`message_id`、相同 `idempotency_key`、带时区 ACK 时间 | **未授权/未实现** |
| O4 | 由 Taskboard 插件记录 ACK，并独立调用 Base 只读接口回读目标 record | ACK 本身不等于数据已落地；回读必须比较 record key、允许字段、版本/更新时间和 payload hash | 只有 ACK 成功且独立 Base readback 一致，插件状态才能进入 `readback_verified` | **未授权/未实现** |

workflow-bridge 的只读参考契约明确要求按 `idempotency_key` 去重、Taskboard 更新使用当前 `expected_version`、未知外部写入结果先读后重试，并在 ACK 与立即回读后才进入 `readback_verified`。参考实现中的 `HermesUpdatePackage` 和 `HermesAck` 只说明包与 ACK 的数据约束；实际 source-link、sync-run、outbox、冲突、ACK/readback 状态由本插件持有，不证明当前 Taskboard 已有 Hermes writer 或真实 Base 写入。

## 4. 幂等、冲突和状态规则

### 4.1 稳定身份与映射

- 一个 Base 源记录的稳定身份是 `feishu-base:<percent-encoded app_token>:<percent-encoded table_id>:<percent-encoded record_id>`；不使用标题、内容相似度或行号去重。
- 一个 source key 只能绑定一个 Taskboard task；一个 Taskboard task 可以在“产品灵感 → 正式需求”演进后关联多个允许的 Base source key。实现映射时不得假设 `task_id` 全局唯一对应一个 Base 记录。
- 创建幂等键必须由 source key、映射版本和规范化 payload 派生；相同键相同内容安全重放，相同键不同内容必须 `conflict`。
- Taskboard 任务更新和移动必须先读当前任务，再使用当前 `version` 做 CAS，写后立即回读；当前 API 对 PATCH/move 没有创建接口同等的幂等键语义，不能只依赖 HTTP 重试。
- 任务写入应携带明确的 `thread_id`/`CODEX_THREAD_ID` 归因；当前 API 允许字段缺省，但插件契约不能用隐含的本地用户身份替代执行归因。

### 4.2 冲突处理

| 情况 | 处理 |
| --- | --- |
| Taskboard 只有本地变化 | 保留 Taskboard 变化，出站只投影白名单；不得用旧 Base 快照覆盖 |
| Base 只有变化且 Taskboard 未变化 | 仅对已批准的非状态字段做最小版本化更新；先读当前 Taskboard `version`，成功后立即回读；Taskboard 状态不受 Base 状态推进 |
| 同一字段两边都变化 | 标记 `conflict`，保留两侧版本和哈希，不自动选择、不批量回填 |
| Taskboard version 冲突 | 重新 GET 当前任务，重新计算投影；同一失败最多按契约有限重试，仍失败则 `blocked` |
| Base 写结果未知 | 先独立 Base readback，再决定是否重试；禁止盲目重放 |
| project/必需字段无法映射 | `信息不足`/`blocked`，保留源快照，不创建虚假项目、不零填字段 |
| Base 状态值未知 | 保留源状态和 `信息不足` 收据；新导入仍写入 Taskboard `backlog`，不把 Base 状态映射为其他 Taskboard 状态 |

### 4.3 与 Codex 执行状态隔离

同步状态、Taskboard 任务状态和 AI 执行状态是三个维度：

```text
同步 receipt: received → snapshot_verified → taskboard_readback_verified → prepared → acked → readback_verified
Taskboard:     backlog → todo → in_progress → in_review → ...
AI 活动:       readiness / planner / worker / handoff / retry
```

入站同步只能建立或更新允许的 Taskboard 卡片；它不能因为快照成功、outbox pending、ACK 或任务存在就启动 readiness、planner 或 worker。AI 是否真实执行，仍须单独核对 readiness review、thread、run、dispatch 和 handoff。

## 5. 本阶段门禁与完成定义

### 5.1 本阶段允许的动作

- 在本地仓库保存本规格和无副作用的适配器回执格式；
- 在另行实现适配器后，只读读取 Base 白名单；
- 通过 Taskboard 任务 API 做幂等创建、版本化更新和写后回读；
- 监听 Taskboard EventHub/SSE 并验证 backlog 卡片可见；
- 由插件生成自己的 Hermes package、payload hash、冲突收据和待发送 outbox；workflow-bridge 只用于只读契约核对，不发送、不写 Base。

### 5.2 本阶段禁止或未授权的动作

- 直接调用 Feishu Base 写 API，或让 workflow-bridge 充当 Base writer；
- 创建/修改 Base 字段、表、视图、公式、记录、关联或状态；
- 启动新的 cron/每日后台服务，或把“每日入口”写成已有生产调度；
- 批量迁移、历史回填、旧状态重写或按标题相似度合并；
- 读取或映射账号、支付、提示词、竞品明细；
- 用 dry-run、mock、fixture、outbox、HTTP 200/201、Hermes package 或“READY”替代真实 ACK 和独立 Base readback。

### 5.3 何时才可称为真实双向完成

必须同时具备以下证据：

1. 当前 Base schema 和目标 record 已用允许身份实时读取并核对；
2. 入站每条记录有稳定 source key、Taskboard write、Taskboard GET readback 和 SSE/UI 结果；
3. 出站每个事件有权威投影、幂等 outbox、Hermes 发送记录；
4. Hermes ACK 的 `message_id`、`idempotency_key`、成功标志和时间均有效且匹配；
5. ACK 之后独立 Base GET 回读与 payload 一致；
6. 排除对象读取次数和写回次数均为 0，冲突、失败和未知写入结果都有收据；
7. 用户验收了实际业务路径；不能仅凭测试、部署状态或配置存在宣称完成。

在上述证据闭合前，交付状态只能写为“本地契约/入站影子验证/待 Hermes 联调”中的一种，不能写为“Base ↔ Taskboard 双向闭合”。

## 6. 用户验收清单与步骤

以下步骤按“入口 → 操作 → 预期结果 → 通过标准”执行。当前本任务只完成静态契约和本地代码证据核对；涉及真实 Base 的步骤应保持 `未执行`，不能用模拟值冒充。

### A. 权威与范围

- 入口：打开本规格第 1 节，并定位 `server/database.mjs`、`server/app.mjs`、workflow-bridge 参考 Spec。
- 操作：核对 Taskboard、Base、workflow-bridge、Hermes 的责任表和四类排除对象。
- 预期结果：Taskboard 负责编辑/状态/Codex；Base 只在白名单字段内做镜像；workflow-bridge 只读参考；插件持有运行状态；Hermes 是未来唯一 writer。
- 通过标准：没有任何段落把 Base 写入或 workflow-bridge 直接写入写成当前能力；账号、支付、提示词、竞品明细均标为零读取/零映射/零回写。

### B. 入站只读快照

- 入口：手动同步入口或每日对账入口，携带唯一 `run_id`。
- 操作：读取当前 Base schema，再只读取 `产品灵感` 和 `需求收集管理` 的白名单字段；保存 record key、快照时间和字段哈希。
- 预期结果：得到由插件持有、可重放的 read-only snapshot；不产生 Base 变化。
- 通过标准：snapshot 列出实际读取的表/字段；排除表未被访问；schema 缺失、状态未知或权限不足时返回 `信息不足/blocked`，不猜测继续。

### C. Taskboard 幂等写入与回读

- 入口：B 的单条允许记录和本地 Taskboard API。
- 操作：新记录使用稳定 `Idempotency-Key` 调 `POST /api/tasks`；既有映射先 `GET` 当前任务，再带 `version` 调 PATCH/move；随后无条件 `GET /api/tasks/:id`。
- 预期结果：只创建/更新允许字段，所有新导入卡片进入 `backlog`；已建立映射的记录仅按第 4.2 节对批准的非状态字段做最小版本化更新；重复运行不重复建卡；版本冲突留下插件收据。
- 通过标准：HTTP 响应、Taskboard GET readback、source key、payload hash 和任务版本一致；没有 `todo`/`in_progress` 自动推进。

### D. EventHub/SSE 与 backlog 卡片

- 入口：C 的成功 Taskboard 写入和本地 Taskboard 页面。
- 操作：订阅 `GET /api/events`，观察 `task.created/task.updated/task.moved`，等待 UI 刷新后重新读取任务列表。
- 预期结果：SSE 收到任务事件，界面 backlog/“积压事项”列出现对应卡片。
- 通过标准：事件只作为刷新信号；卡片内容以 Taskboard GET 为准；重连或事件丢失后全量 GET 仍能恢复可见性。

### E. readiness/planner 隔离

- 入口：D 中仍处于 `backlog` 的卡片，随后由用户明确拖到 `todo`。
- 操作：先确认同步结束时没有 AI run；用户移动到 `todo` 后，检查 readiness review，再检查 planner/worker 是否满足任务类型和审核结论。
- 预期结果：backlog 同步不启动 AI；进入 `todo` 后才按现有 readiness 规则审核；需要补充时到 `blocked`，通过后才可回 `todo` 并启动相应执行路径。
- 通过标准：不存在“同步成功即开发”的事件；planner 线程、run、dispatch 和 handoff 均有独立证据。

### F. 出站无副作用回执

- 入口：Taskboard 任务事件 `task.created/task.updated/task.moved`。
- 操作：由插件按白名单生成 canonical projection 和自己的 outbox/适配器回执；只读取 Base 做可选对照，不调用写 API。
- 预期结果：插件持有 `event_id`、Taskboard version、target record key、幂等键、payload hash 和待 Hermes 状态；Base 记录未改变。
- 通过标准：插件回执可重放且冲突可识别；没有 Base write、没有伪造 ACK、没有把 outbox 当成同步完成。

### G. 真实双向门禁

- 入口：另行批准的 Hermes 联调流程。
- 操作：插件把同一幂等包交给 Hermes 单一 writer，插件接收并记录 ACK，再用独立 Base 读取接口回读并比较。
- 预期结果：ACK 成功且 idempotency key 匹配，Base 允许字段与投影一致。
- 通过标准：同时具备真实 schema、发送、ACK、独立 Base readback 和排除对象零访问证据；否则保持“未完成/未授权”。

## 7. 参考证据索引

### Taskboard 仓库

- 任务存储与事务：`server/database.mjs:549-650`。
- 任务幂等创建、版本 CAS：`server/database.mjs:2687-2968`。
- 任务 API 与事件：`server/app.mjs:1993-2020`、`server/app.mjs:2328-2350`。
- EventHub 与服务接线：`server/app.mjs:1075-1125`、`server/app.mjs:1465-1543`。
- SSE/UI 刷新：`web/src/App.tsx:500-600`、`web/src/api.ts:358-378`。
- readiness：`server/task-readiness-coordinator.mjs:176-370`。
- planner/worker 编排：`server/task-coordinator.mjs:282-362`、`server/app.mjs:1497-1535`。
- 状态与 AI 触发参考：`docs/task-status-reference.md`、`docs/ai-intervention-triggers.md`。

### workflow-bridge 只读参考

- 权威分工、幂等/CAS/ACK/readback、Hermes 唯一 writer 和“主线 Taskboard/Feishu 同步未实现”：`docs/specs/personal-information-loop-v1.1.md:17-25`、`:198-259`。
- Hermes 包和 ACK 的结构约束：`src/workflow_bridge/models/requirement_coordination.py:108-124`、`:225-270`；状态转换和 `idempotency_key` 校验：`src/workflow_bridge/workflows/requirement_coordination.py:497-582`、`:727-754`。
- 需求协调 V0.1 的“只生成 Hermes 更新包、不直接写飞书”边界：`docs/specs/requirement-coordination-agent.md:24-58`、`:258-268`。

这些文件只证明可复用的边界和本地原语，不证明当前仓库已经存在 Feishu client、插件入口、outbox、Hermes 发送器或真实 Base ↔ Taskboard E2E。
