# 本机HTTP接口日志

启用此候选的服务后，日志追加在该服务数据目录的 `logs/api-requests.jsonl`。这是新增的请求日志，不是卡片活动历史；它无法补造启用前缺失的请求。当前活动服务不会因修改候选代码而自动切换。

使用该版本的正式CLI及准确活动runtime：

```text
taskctl log list --limit 200 --json
taskctl log analyze --limit 1000 --json
taskctl log list --source-thread THREAD_UUID --json
taskctl log list --task ISSUE_ID --json
taskctl log list --request-id REQUEST_UUID --json
```

`taskctl`表示由项目Skill指定的真实完整前缀，不是另找全局程序。查询通过现有本机能力边界内的 `GET /api/local/request-logs`；只读，不向云端转发或修改卡片。`limit`是最近匹配的事件条数（1–1000），一次请求通常有接入与终态两条。

CLI自动把当前 `CODEX_THREAD_ID` 中的Codex UUID声明为来源，写命令显式调用者优先。没有有效UUID的调用仍能使用，但日志来源为未知。浏览器及其他客户端尚无通用会话声明，不将其猜为任何卡片owner。

每条日志仅有UTC时间、方法、保守路由模板、可验证格式的任务ID、服务端生成的 `requestId`、CLI生成的 `clientRequestId`、**自报**来源、事件及终态的HTTP状态/分类错误码/耗时。两类ID仅作关联，不是幂等键或认证身份。

- `received`证明该请求到达这个本机HTTP服务；`completed`附HTTP结果，`rejected`表示HTTP 4xx/5xx结果，不能单凭它判断是谁应负责。
- CLI收到HTTP错误时，`error.trace.delivery=http_response`，可按服务端ID核对日志。
- 已确认连接无法建立的 `ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN`返回 `not_connected`；其他未取得HTTP响应的情况为 `unknown`，不能认定请求没有到达。
- 没找到记录不证明没有请求：可能是启用前、另一服务、截取窗口或记录失败。`coverage`明确窗口截断、写失败及不可读记录数量。只见接入而无终态也不能当作未到达。
- `success`仅表示HTTP结果，不能证明卡片字段写对、CLI完整解析成功或用户已验收；判断具体业务仍需核卡片版本、字段活动和原会话证据。
- 来源是调用者自报，不能证明实际原生会话身份、授权、owner或真人操作；两个不同来源的测试不替代真实跨会话试点。

不会记录原始URL、查询串、认证头、密钥、请求或响应正文、错误消息。未知路由仅记 `unmatched`；未通过校验的来源不记录。代理响应只记本机所见状态，不读取远端敏感错误正文。HTTP事件流的终态在结束时记录；WebSocket升级、云Worker内部执行和CLI调用前失败不在服务端HTTP日志覆盖内。

这是追加日志，当前未实现自动清理/轮转；读取分析只处理匹配窗口，不宣称完整历史审计。保持数据目录的正常磁盘管理。

直接验证：`node --test test/request-log.test.mjs`。它在独立临时目录启动真实HTTP服务，执行不同声明来源的CLI读取及成功/失败请求，核对关联、拒绝、持久化和敏感哨兵；不访问生产卡、不替换共享runtime。
