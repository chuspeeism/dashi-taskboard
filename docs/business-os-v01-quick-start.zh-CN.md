# Codex 全业务任务中心 V0.1 快速开始

这套初始化把现有 Codex 本地项目接入同一个 Taskboard。Taskboard 管工作状态、对话和验收，原项目目录及业务系统继续保存业务事实。

## 1. 启动本机服务并初始化

要求 Node.js 22.5 或更高版本。先在终端 A 启动仅供初始化使用的独立服务：

```bash
npm ci
npm run build
export CODEX_BUSINESS_OS_DATA_DIR='/请替换为私有数据目录的绝对路径'
export CODEX_BUSINESS_OS_CONFIG='/请替换为私有项目清单的绝对路径.json'
CODEX_TASKBOARD_DATA_DIR="$CODEX_BUSINESS_OS_DATA_DIR" CODEX_TASKBOARD_HOST=127.0.0.1 npm start
```

服务地址为 <http://127.0.0.1:47823>。数据固定保存在上述 `outputs/codex-business-os-data`，不会因为更换源码工作树而丢失。V0.1 只绑定 `127.0.0.1`，不要直接开放到局域网或公网。

保持终端 A 运行，在终端 B 执行下面第 2、3、4 节的预览、初始化与验证。全部通过后回到终端 A 按 `Ctrl+C` 停止独立服务；同一端口不能同时运行独立服务和 Codex Launcher。

## 2. 先预览初始化计划

终端 B 不会继承终端 A 的环境变量，先在终端 B 设置同一个私有清单路径：

```bash
export CODEX_BUSINESS_OS_CONFIG='/请替换为私有项目清单的绝对路径.json'
npm run bootstrap:business-os -- --config "$CODEX_BUSINESS_OS_CONFIG" --dry-run
```

脚本只读取以下元数据：Taskboard 健康状态、Codex 本地项目与路径映射、Taskboard 项目列表和项目 README。它不会读取项目文件内容，也不会导入历史任务、对话、附件或业务文件。

预览必须显示：

- 匹配项目清单中的全部 Codex 本地工作区；
- `local` 作为收件箱；
- 待创建或复用的项目均有正式 `area` 字段；
- 历史任务、对话、附件和业务文件的导入数均为 0。

如果提示后端没有 `projects.area`，先重新构建并重启当前分支的 Taskboard 服务，再重新预览。脚本不会在缺少正式业务域字段时退回到标签模拟。

## 3. 执行初始化

```bash
npm run bootstrap:business-os -- --config "$CODEX_BUSINESS_OS_CONFIG"
```

项目清单放在仓库外，权限建议设为 `0600`，避免把本机路径和业务项目名提交到公开仓库。格式如下：

```json
{
  "projects": [
    {
      "name": "示例项目",
      "area": "示例业务域",
      "workspacePath": "/本机/Codex/项目的绝对路径"
    }
  ]
}
```

脚本使用 Codex 已保存的项目 UUID 作为 Taskboard 项目 ID，因此 Codex 与 Taskboard 不会出现两份同路径项目。每个项目会写入一份最小 README；已有且不属于本初始化的 README 会原样保留。

默认只创建或复用清单中的项目及项目 README，不生成推测性的业务任务。重复运行是安全的：项目按 Codex UUID 与路径复用，README 按隐藏版本标记复用。

## 4. 验证

健康检查：

```bash
curl -fsS http://127.0.0.1:47823/health
```

项目与正式业务域：

```bash
CODEX_TASKBOARD_URL=http://127.0.0.1:47823 npm run taskctl -- project list --json
```

默认流程不请求或写入任务接口。不要为了验证而运行不带 `--project` 的全局任务读取，以免触发已经配置的外部任务同步。

浏览器总览：

- 工作台：<http://127.0.0.1:47823/?project=__all_projects__>
- 收件箱：<http://127.0.0.1:47823/?project=local>

在项目切换菜单确认项目清单中的真实项目只出现一次，并检查每个项目的“项目 README”页。`local` 保持为收件箱，不绑定任何单一业务目录。

最后再次运行：

```bash
npm run bootstrap:business-os -- --config "$CODEX_BUSINESS_OS_CONFIG" --dry-run --json
```

完成初始化后，输出中的项目和 README 应全部进入复用路径，不再产生重复记录。

## 5. 接入 Codex 桌面端

先安装仓库自带的任务管理 Skill；如果目标已存在，应先检查，不要覆盖：

把 `skills/manage-taskboard` 链接到 Codex 的个人 Skill 目录。安装时使用当前稳定源码目录的绝对路径；目标已存在时先核验，不要直接覆盖。

确认独立服务已经停止，再从同一源码目录启动 Codex Launcher。它会使用同一 SQLite 数据目录，并在当前 Codex 的原生浏览面板中打开任务中心：

```bash
export CODEX_BUSINESS_OS_DATA_DIR='/请替换为私有数据目录的绝对路径'
CODEX_TASKBOARD_DATA_DIR="$CODEX_BUSINESS_OS_DATA_DIR" \
CODEX_TASKBOARD_RUNTIME_FILE="$CODEX_BUSINESS_OS_DATA_DIR/launcher-runtime.json" \
CODEX_TASKBOARD_HOST=127.0.0.1 \
CODEX_TASKBOARD_PORT=47823 \
npm run business-os
```

`business-os` 会先核验权限为私有的 runtime descriptor 和真实 Launcher 进程。重复运行时复用现有服务并再次打开页面；未知端口占用不会被自动终止。不要同时再运行 `npm start`。

Launcher 运行时读取项目列表：

```bash
npm run taskctl -- \
  --runtime-file "$CODEX_BUSINESS_OS_DATA_DIR/launcher-runtime.json" \
  project list --json
```

runtime descriptor 含临时访问路径，只能保存在私有数据目录；不要打印、复制到文档或提交到 Git。

## 6. 日常使用规则

- 新想法和无法归类的工作先进入 `local` 收件箱。
- `backlog` 表示未批准，Codex 不开始执行。
- 目标、交付物和验收标准明确后，人工移动到 `todo`。
- Codex 领取后进入 `in_progress`，交付并验证后进入 `in_review`。
- 只有用户明确验收后才进入 `done`。
- 业务系统状态与 Codex 工作状态分开。例如，Codex 完成上传准备不代表平台已经发布。
- Taskboard 只保存最小摘要和来源引用；凭证、完整合同、完整身份或账户资料、客户原始数据留在权威系统。
- 最终发布、付款、签署和不可逆删除必须逐次人工确认。

V0.1 不启用云同步、自动化认领或外部平台连接器。先用真实工作运行一周，再决定哪些流程值得自动化。
