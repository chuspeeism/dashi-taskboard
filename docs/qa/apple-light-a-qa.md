# Apple Light A 最终 QA

验收日期：2026-08-15。实现与交付提交：`c28f11f85a905f092ecfd43d92ea18e7748fc8c4`；审查修复提交：`8b3daceea2c86355b3001c9815ddec0441bbf1a3`、`07c57e638a93e410d433096243fa233ccb146e6b`、`841a3edaa0072ba796963988144f977a1fe0770b`、`0ce83c846c759689d9a7486325ad0875e4a296c5`。

| 检查 | 实际结果 |
| --- | --- |
| Node | `v24.19.0` |
| Chrome | `151.0.7922.138` |
| Codex | `26.810.50856`，build `6644` |
| `npm ci` | PASS；198 packages，0 vulnerabilities（干净临时 worktree） |
| `npm run typecheck` | PASS |
| `npm run build:web` | PASS；527 modules transformed |
| `npm run test:e2e` | PASS；16/16，包含无主 bundle 首帧主题、浅色/深色、Axe、入口顺序、浮层、40px 间距、真实进度，以及完成任务真实标题编辑→继续→归档→恢复生命周期 |
| Axe | PASS；浅色看板/详情/自动化/归档/新建议题弹窗，以及深色看板/详情均为 0 serious/critical |
| `npm run test:loopback-safe` | PASS；主批 462 total / 458 passed / 0 failed / 4 safety-policy skips（30.650 秒），full-height 串行批 1/1 passed（fixture 2.916 秒，批次 2.962 秒），聚合为 463 tests / 459 passed / 0 failed / 4 policy skips，最终退出码 0。 |
| `git diff --check` | 最终门禁 PASS |
| 服务监听 | 独立 GUI 验收时仅 `127.0.0.1:47823` |
| CDP 监听 | 独立 GUI 验收时仅 `127.0.0.1:9231` |
| Plugins → Taskboard | PASS；同一父节点，Plugins index 0、Taskboard index 1，中间无可见入口；`entryMounted=true` |
| 主题 | PASS；host light → dark → light 无重载，筛选、搜索、选中任务与详情保留 |
| 真实进度 | PASS；真实 `7/10` 在卡片和详情均显示 `70%` 与剩余 3 步，不用计时器伪造 |
| exact-id / version | PASS；临时 `LOCAL-1` 通过 exact ID 获取、评论与版本化状态流转；完成任务先在详情真实修改并保存标题，API 校验字段与 version 递增，再继续到处理中并校验第二次 version 递增；完成→归档、归档→恢复同样读取服务端状态 |
| 退出清理 | PASS；独立 GUI 所有 owned 进程退出，`47823`/`9231` 关闭，普通 Codex 未操作 |
| `npm run app:preflight` | 未通过前置：脚本明确要求 `<App.app>`，本地无自定义 `.app`，签名环境变量缺失 |
| 自定义 App/DMG | 未构建、未交付、未声称签名；没有绕过 Gatekeeper |

## 新增视觉与交互验收

- 项目切换菜单由 `document.body` portal 承载，`position: fixed`，在 900px 视口内四边不越界；语义层级为 navigation `10`、popover `20`，不使用任意超大 z-index。
- 工具栏底部到任务面板主体顶部在 1440px 浅色与 900px 深色均为精确 `40px`。
- “已完成”是活跃看板的明确列；“归档”是带图标、文字和数量的独立入口，不作为活跃状态列。
- 已完成任务可打开详情编辑、用“继续任务”回到处理中、归档；归档记录保留原状态并可恢复。
- 900px 下文档无横向溢出；看板内部横向滚动承载四列。
- 主 bundle 被阻断时，`?theme=dark` 与系统深色都在首帧前写入深色；嵌入模式不信任 standalone 查询参数。React 挂载后合法 host light → dark → light 在下一帧前同步，非法主题被忽略，详情、筛选和搜索状态保留。
- 限定交付包使用专用索引，不复制源码 README；纯测试校验包内 Markdown 相对链接均存在且不越出包目录。
- 工作流状态选择与服务端项目摘要中的 `done` 用户可见标签均为“已完成”；纯合同先 RED 后 GREEN。该字符串一致性修复不涉及浏览器渲染，沿用已通过的 Playwright 16/16 证据，未重复启动 Chrome。

## 截图人工检查

- `project-switcher-overlay-light.png`：浮层完整覆盖在导航与内容之上，未被裁切。
- `taskboard-spacing-light-1440.png`、`taskboard-spacing-dark-900.png`：40px 节奏清晰，深色响应式未破坏。
- `board-completed-archive-entry-light.png`：1728px 浅色下等待认领、处理中、等你确认、已完成四列齐全，归档入口清晰。
- `archive-dedicated-light.png`：归档侧视图独立，恢复与永久删除操作清晰。
- Task 5 的 8 张基线截图继续保留；浅色内容为实色卡片，毛玻璃只用于导航/浮层，70% 进度语义可读。

独立 Codex 入口证据见 `evidence/customized-codex-sidebar-order.json` 与去敏截图 `evidence/customized-codex-sidebar-light.png`。证据不包含 token、任务、线程、用户或工作区内容。

后续运行 `scripts/capture-codex-taskboard-qa.mjs` 时，默认输出位于 Git 忽略的 `.artifacts/codex-qa/customized-codex`。纯函数测试验证其 JSON 使用最小字段 allowlist，不会写入 `bodyText`、任务或线程正文；截图请求直接裁剪至 Plugins/Taskboard 两个必要入口区域。该安全捕获契约在完整 loopback-safe 中为 3/3 PASS。

## 已知边界

- 当前交付是本地源码启动路径，不是经过 Developer ID 签名和 Apple 公证的自定义安装包。
- Loopback-safe runner 会先运行主批，再以 `--test-concurrency=1` 运行 full-height 真实 Chrome fixture；两批任一失败都会传播到最终退出码。该 fixture 通过私有 CDP pipe 读取 DOM 结果，并在约 3 秒后主动关闭仅由测试启动的 Chrome，不依赖 kill timeout。
- 已完成列使主看板最小宽度增加；窄屏按设计在看板内部横向滚动，不产生文档级横向滚动。
- 上游 v1.0.3 的签名 DMG 与本地源码变体是两个不同交付物，不能把上游签名结果套用于本地改动。
