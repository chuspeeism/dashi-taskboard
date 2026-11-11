# 看板工具调用诊断

日志用于回答“这个执行会话有没有调用看板工具、在哪一步失败、有没有保存和读回”，不是只展示HTTP计数。启用候选后，使用项目Skill指定的准确CLI及runtime：

```text
taskctl log diagnose --source-thread THREAD_UUID --task ISSUE_ID --limit 1000 --json
taskctl log diagnose --source-thread THREAD_UUID --since 2026-11-11T00:00:00Z --until 2026-11-11T01:00:00Z --json
taskctl log analyze --limit 1000 --json
taskctl log list --request-id REQUEST_UUID --json
```

`diagnose`结合本机CLI调用记录和同一服务的HTTP日志，按一次工具调用给出工具、时间、来源、请求步骤、结果、错误码、保存证据、读回证据和下一步。它不修改卡片，也不自动重送失败请求。`list/analyze`还支持`--source-thread`、`--task`、`--since`、`--until`；`limit`为最近匹配事件数，范围1–1000，不能把截取窗口当完整历史。

## 真实记录路径

1. `taskctl`为一次CLI调用生成`invocationId`，写入`cli_started`，随后记录请求尝试、HTTP响应或传输错误、`cli_finished`。参数值、文件路径、正文均不写入。显式runtime下文件位于descriptor旁的`logs/taskctl-invocations.jsonl`；未显式指定时使用该CLI源码runtime位置旁的journal，不宣称自动发现的其他平台descriptor共用这个文件。
   参数解析失败也保留启动/失败事件；无法解析显式runtime参数时，只使用已配置环境或源码journal，标明目标未解析。无法识别的命令只记固定`unrecognized_command`，不记录原始未知文本。日志诊断查询本身不作为业务调用纳入诊断。
2. 每个HTTP请求带`clientRequestId`、同次调用ID、允许的工具名和有效的自报会话UUID。服务接入时生成独立`requestId`并记`received`；响应结束记HTTP结果、分类错误码、耗时。
3. 本地数据库的原有写方法返回后，记录任务/评论ID与版本。任务保存还记录CAS前版本及请求修改的字段名，不记录字段值，也不把请求字段名当实际内容正确的证明。
4. 后续独立GET返回同一实体版本时，诊断关联到相同自报来源的保存。另一会话的读取不冒充写入者自己的读回；评论与卡片分开，评论成功不代表正文更新。

HTTP日志在服务数据目录的`logs/api-requests.jsonl`。只读接口为`GET /api/local/request-logs`，沿现有本机访问边界，不向云端转发。两个关联ID和调用ID都不是认证身份或幂等键。

## 如何读结论

| 诊断 | 可以确认什么 | 下一步 |
| --- | --- | --- |
| `failed_before_http` | CLI已启动，但本机记录未到发送阶段 | 检查参数、输入文件、runtime配置 |
| `connection_not_established` | 该次连接因明确拒绝/DNS失败未建立 | 先恢复准确服务入口 |
| `transport_outcome_unknown` | 有调用尝试，未取得可确定的HTTP结果 | 核关联ID，不盲目重送写入 |
| `http_rejected` | 服务返回具体HTTP错误，如409版本冲突 | 重新读版本/要求，处理该失败步骤 |
| `failed_after_http_response` | HTTP已返回，但CLI解析或本地处理失败 | 不把HTTP200当工具完整成功 |
| `server_record_not_observed` | 客户端收到HTTP响应，当前服务日志未匹配 | 核窗口、来源和服务目标 |
| `read_only` | 观察到读取，没有该调用的卡片保存证据 | 若应回写进展，核原owner回执 |
| `save_committed` | 原数据库写方法已返回保存版本 | 单独检查`saves[].readback` |
| `attachment_saved` | 附件数据库记录已返回 | 单独核附件列表/下载，不当作正文更新 |
| `deletion_committed` | 原数据库删除方法已返回 | 单独核删除结果，勿重复删除 |
| `partial_success` | 有保存证据，流程另有失败 | 分别处理成功与失败，不重送整轮 |
| `http_success_without_save_evidence` | HTTP成功，但此路径没有任务/评论保存证据 | 不宣称卡片更新成功 |
| `incomplete_evidence` / `not_observed` | 当前窗口缺少足够证据 | 不能据此断言“没有调用” |

`saves[].readback=version_confirmed`证明随后独立读到了保存版本；`not_observed`不是保存失败，`different_version_observed`说明读到别的版本。元数据不检查正文是否符合目标，也不等于用户验收。已返回但版本未变的任务操作另标`save_returned_without_version_change`。

## 来源、模型和覆盖边界

- `bindingComparisons`按目标卡记录数据库绑定threadId、任务版本、快照阶段（before/read/after）及来源，并与本HTTP请求的声明来源标示`same`、`different`、`missing`；不支持的旧ID格式或冲突标`unknown`，没有观察到绑定的旧日志标`not_observed`，不推断成卡片未绑定。列表逐卡记录，写请求保留修改前后，`bindingChanges`指出改绑，不能用修改后的“一致”遮掉原不同。快照不是事务锁；以记录中的时间/版本为准。只记绑定会话ID，不记录工作目录等完整绑定内容。
- `callerIdentity`分别保留环境声明的`clientContextThreadId`、CLI显式`explicitCallerThreadId`及HTTP声明ID。即使命令显式caller与环境不同，也不覆盖环境上下文；`status`比较卡片绑定与HTTP声明，`contextComparison`比较卡片绑定与环境声明。`--source-thread`可按两种声明查找。它们都是自报，`verifiedThreadId`保持null：当前接口没有逐会话认证，服务访问token不证明发起会话身份。对照是ID差异，不自动判授权或阻断调用；协调者读取其它owner卡时不同可以是正常情况。
- 来源是有效`CODEX_THREAD_ID`或写命令显式调用者的自报值，不是认证身份。外部agent归属选项不会冒用环境里的Codex来源；浏览器/其他客户端未声明来源时保持未知，不从卡片owner反推请求者。
- 当前逐请求入口没有可信的实际模型后端信息，`model.id=null`、`provenance=unavailable_at_tool_boundary`。不把用户请求的模型、环境中的随意字符串或会话默认设置冒充这次真正运行的模型。
- CLI结束不是任务会话结束。本功能未接入可信的会话完成事件，也没有自动监听；协调者需用真实会话回执给定时间窗口，再核调用。没有日志可能是未接入、另一设备/服务、来源丢失、窗口截断、记录失败或确实没调用，不能只凭空白定论。
- 当前保存证据覆盖本机任务创建/更新/移动/归档/恢复/关系及评论新增/修改；其它HTTP路径没有相应证据就明确未证明。Jira本机数据库回执不等于远端全部状态验收；云Worker内部、WebSocket升级、未使用此CLI的工具启动都不在完整覆盖内。
- journal写失败不阻止或重放业务操作；缺记录仍保留未知。读取会报告文件缺失/不可读、坏行、窗口截断，不能保证恰好一次或完整历史。未实现自动轮转/清理，不补造启用前数据。

客户端写日志失败会在成功或错误JSON中返回`loggingWarning.code=CLIENT_JOURNAL_WRITE_FAILED`、允许的系统错误码和失败事件数，不再静默。业务成功仍exit0，409等业务错误保持原退出码，不能因日志失败重送写入；警告不包含日志路径或原始系统错误消息。请求还声明截至发送前的journal状态，服务端诊断以`clientJournalReport`提示客户端自报写失败。响应后才发生的写失败由该次CLI返回警告保留；服务器不能据发送前的ok声明保证后续日志完整。

附件保存、任务/评论/附件删除有单独数据库回执；没有版本的附件与删除不伪造`version_confirmed`，分别标未自动核验附件或删除。普通下载依旧是读取。删除后文件清理等后续步骤失败时保留已发生的数据库效果并标部分成功，不能按HTTP错误盲目重演整轮。项目设置等非任务接口仍仅有HTTP结果，不冒充任务保存。

不记录密钥、认证头、原始URL、查询串、请求/响应正文或错误消息。未知路由仅记`unmatched`；传输错误只保留固定允许的系统错误码。

## 验证与集成

`node --test test/request-log.test.mjs test/cli.test.mjs`使用隔离服务/数据，覆盖保存与独立读回、只读会话、缺失来源、CLI请求前失败、409、离线journal、HTTP200后的处理失败、时间窗口及敏感材料不落日志。不同声明来源测试不替代真实跨会话验证。

现用`issue get/list --view full|summary`及关系投影保持；诊断不会改变三段摘要。候选代码不会自动替换活动服务，正式启用须完成项目所需功能确认、评审和共享runtime集成。只应用精确增量及所需新模块，不能整文件覆盖CLI或顺带启用其它候选。
