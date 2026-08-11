import { useState } from "react";
import { useTaskboardI18n } from "../i18n";
import type { WorkflowCapabilities } from "../types";
import { LinearIcon } from "./LinearIcon";
import {
  type WorkflowCanvasNode,
  type WorkflowNodeData,
} from "./WorkflowNode";
import {
  CODE_RUNTIMES,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  FEISHU_MESSAGE_RECIPIENTS,
  GIT_OPERATIONS,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  TEST_SCOPES,
  selectedCapabilityValue,
  workflowNodeDisplayTitle,
} from "./workflowCatalog";
import { workflowText } from "./workflowI18n";
import { WorkflowMark } from "./WorkflowMark";

interface WorkflowInspectorProps {
  node: WorkflowCanvasNode;
  projectName: string;
  capabilities: WorkflowCapabilities | null;
  capabilitiesFailed: boolean;
  onChange: (changes: Partial<WorkflowNodeData>) => void;
  onClose: () => void;
}

type InspectorTab = "settings" | "configuration";

export function WorkflowInspector({
  node,
  projectName,
  capabilities,
  capabilitiesFailed,
  onChange,
  onClose,
}: WorkflowInspectorProps) {
  const { text } = useTaskboardI18n();
  const [activeTab, setActiveTab] = useState<InspectorTab>("settings");
  const data = node.data;
  const conditionField = data.conditionField ?? CONDITION_FIELDS[0].value;
  const selectedConditionField = CONDITION_FIELDS.find(
    (field) => field.value === conditionField,
  ) ?? CONDITION_FIELDS[0];
  const conditionOperator = selectedConditionField.operators.find(
    (operator) => operator === data.conditionOperator,
  ) ?? selectedConditionField.defaultOperator;
  const conditionValue = data.conditionValue || selectedConditionField.defaultValue;

  return (
    <div className="workflow-inspector-content">
      <div className={`workflow-inspector-title workflow-inspector-${data.tone}`}>
        <span aria-hidden="true">
          <WorkflowMark
            icon={data.icon}
            logo={data.logo}
            logoMonochrome={data.logoMonochrome}
          />
        </span>
        <div>
          <small>{data.eyebrow}</small>
          <strong>{workflowNodeDisplayTitle(data, text)}</strong>
        </div>
        <button
          className="workflow-panel-toggle"
          type="button"
          aria-label={text("关闭步骤配置", "Close step settings")}
          title={text("关闭步骤配置", "Close step settings")}
          onClick={onClose}
        >
          <LinearIcon name="close" />
        </button>
      </div>

      <div
        className="workflow-inspector-tabs"
        role="tablist"
        aria-label={text("步骤配置视图", "Step settings views")}
      >
        <button
          className={activeTab === "settings" ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={activeTab === "settings"}
          onClick={() => setActiveTab("settings")}
        >{text("设置", "Settings")}</button>
        <button
          className={activeTab === "configuration" ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={activeTab === "configuration"}
          onClick={() => setActiveTab("configuration")}
        >{text("配置", "Configuration")}</button>
      </div>

      {activeTab === "settings" ? (
        <div role="tabpanel" aria-label={text("设置", "Settings")}>
          <div className="workflow-config-section">
            <h2>{text("常规", "General")}</h2>
            <label>
              <span>{text("节点名称", "Node name")}</span>
              <input
                type="text"
                value={data.title}
                onChange={(event) => onChange({
                  title: event.target.value,
                  systemCopyDepth: 0,
                })}
              />
            </label>
            <label>
              <span>{text("说明", "Description")}</span>
              <textarea
                rows={3}
                value={data.description}
                onChange={(event) => onChange({ description: event.target.value })}
              />
            </label>
          </div>

          <div className="workflow-config-section">
            <h2>{text("额外说明", "Additional instructions")}</h2>
            <textarea
              aria-label={text("额外说明", "Additional instructions")}
              rows={4}
              value={data.additionalInstructions ?? ""}
              placeholder={text(
                "补充执行约束、上下文或验收要求…",
                "Add execution constraints, context, or acceptance criteria…",
              )}
              onChange={(event) => onChange({ additionalInstructions: event.target.value })}
            />
          </div>

          <div className="workflow-config-section">
            <h2>{text("上下文", "Context")}</h2>
            <div className="workflow-context-field">
              <span>
                <LinearIcon name="project" />
                {text("当前项目", "Current project")}
              </span>
              <strong>{projectName}</strong>
              <LinearIcon name="chevronDown" />
            </div>
          </div>
        </div>
      ) : (
        <div role="tabpanel" aria-label={text("配置", "Configuration")}>
          {data.kind === "issue-create" && (
            <div className="workflow-config-section">
              <h2>{text("创建议题", "Create issue")}</h2>
              <label>
                <span>{text("标题", "Title")}</span>
                <input
                  aria-label={text("ISSUE 标题", "Issue title")}
                  type="text"
                  value={data.createIssueTitle ?? ""}
                  placeholder={text("输入议题标题", "Enter an issue title")}
                  onChange={(event) => onChange({ createIssueTitle: event.target.value })}
                />
              </label>
              <label>
                <span>{text("描述", "Description")}</span>
                <textarea
                  aria-label={text("ISSUE 描述", "Issue description")}
                  rows={4}
                  value={data.createIssueDescription ?? ""}
                  placeholder={text("补充议题描述…", "Add an issue description…")}
                  onChange={(event) => onChange({ createIssueDescription: event.target.value })}
                />
              </label>
              <label>
                <span>{text("初始状态", "Initial status")}</span>
                <select
                  aria-label={text("ISSUE 初始状态", "Issue initial status")}
                  value={data.createIssueStatus ?? "todo"}
                  onChange={(event) => onChange({ createIssueStatus: event.target.value })}
                >
                  {ISSUE_STATUSES.map((status) => (
                    <option key={status.value} value={status.value}>
                      {workflowText(text, status.label)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{text("优先级", "Priority")}</span>
                <select
                  aria-label={text("ISSUE 优先级", "Issue priority")}
                  value={data.createIssuePriority ?? "none"}
                  onChange={(event) => onChange({ createIssuePriority: event.target.value })}
                >
                  {ISSUE_PRIORITIES.map((priority) => (
                    <option key={priority.value} value={priority.value}>
                      {workflowText(text, priority.label)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{text("标签", "Labels")}</span>
                <input
                  aria-label={text("ISSUE 标签", "Issue labels")}
                  type="text"
                  value={data.createIssueLabels ?? ""}
                  placeholder={text(
                    "多个标签用逗号分隔",
                    "Separate multiple labels with commas",
                  )}
                  onChange={(event) => onChange({ createIssueLabels: event.target.value })}
                />
              </label>
            </div>
          )}

          {data.kind === "skill" && (
            <div className="workflow-config-section">
              <h2>Skill</h2>
              <label>
                <span>{text("可用 Skill", "Available Skills")}</span>
                <select
                  aria-label={text("可用 Skill", "Available Skills")}
                  value={selectedCapabilityValue(
                    capabilities?.skills ?? [],
                    data.selectedSkill,
                  )}
                  disabled={
                    !capabilities
                    || capabilitiesFailed
                    || capabilities.skills.length === 0
                  }
                  onChange={(event) => onChange({
                    selectedSkill: event.target.value,
                    meta: `${event.target.selectedOptions[0].text} · Skill`,
                  })}
                >
                  <option value="" disabled>
                    {!capabilities
                      ? text("正在读取可用 Skill…", "Loading available Skills…")
                      : capabilitiesFailed
                        ? text("读取可用 Skill 失败", "Failed to load available Skills")
                        : capabilities.skills.length === 0
                          ? text("未发现可用 Skill", "No available Skills found")
                          : text("请选择 Skill", "Select a Skill")}
                  </option>
                  {(capabilities?.skills ?? []).map((skill) => (
                    <option key={skill.id} value={skill.id}>{skill.label}</option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {data.kind === "mcp" && (
            <div className="workflow-config-section">
              <h2>MCP</h2>
              <label>
                <span>{text("可用 MCP Server", "Available MCP Servers")}</span>
                <select
                  aria-label={text("可用 MCP Server", "Available MCP Servers")}
                  value={selectedCapabilityValue(
                    capabilities?.mcpServers ?? [],
                    data.selectedMcpServer,
                  )}
                  disabled={
                    !capabilities
                    || capabilitiesFailed
                    || capabilities.mcpServers.length === 0
                  }
                  onChange={(event) => {
                    const server = capabilities?.mcpServers.find(
                      (option) => option.id === event.target.value,
                    );
                    onChange({
                      selectedMcpServer: event.target.value,
                      meta: server
                        ? `${server.label} · ${server.transport}`
                        : "尚未选择 MCP Server",
                    });
                  }}
                >
                  <option value="" disabled>
                    {!capabilities
                      ? text(
                        "正在读取可用 MCP Server…",
                        "Loading available MCP Servers…",
                      )
                      : capabilitiesFailed
                        ? text(
                          "读取可用 MCP Server 失败",
                          "Failed to load available MCP Servers",
                        )
                        : capabilities.mcpServers.length === 0
                          ? text("未发现可用 MCP Server", "No available MCP Servers found")
                          : text("请选择 MCP Server", "Select an MCP Server")}
                  </option>
                  {(capabilities?.mcpServers ?? []).map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.label} · {server.transport}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {data.kind === "rss-trigger" && (
            <div className="workflow-config-section">
              <h2>{text("RSS 订阅", "RSS feed")}</h2>
              <label>
                <span>{text("订阅地址", "Feed URL")}</span>
                <input
                  aria-label={text("RSS 订阅地址", "RSS feed URL")}
                  type="url"
                  value={data.rssFeedUrl ?? ""}
                  placeholder="https://example.com/feed.xml"
                  onChange={(event) => onChange({ rssFeedUrl: event.target.value })}
                />
              </label>
            </div>
          )}

          {data.kind === "condition" && (
            <div className="workflow-config-section">
              <h2>{text("判断规则", "Condition rule")}</h2>
              <label>
                <span>{text("判断字段", "Condition field")}</span>
                <select
                  aria-label={text("判断字段", "Condition field")}
                  value={conditionField}
                  onChange={(event) => {
                    const selectedField = CONDITION_FIELDS.find(
                      (field) => field.value === event.target.value,
                    )!;
                    onChange({
                      conditionField: selectedField.value,
                      conditionOperator: selectedField.defaultOperator,
                      conditionValue: selectedField.defaultValue,
                    });
                  }}
                >
                  {CONDITION_FIELDS.map((field) => (
                    <option key={field.value} value={field.value}>
                      {workflowText(text, field.label)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{text("运算符", "Operator")}</span>
                <select
                  aria-label={text("运算符", "Operator")}
                  value={conditionOperator}
                  onChange={(event) => onChange({ conditionOperator: event.target.value })}
                >
                  {selectedConditionField.operators.map((operatorValue) => {
                    const operator = CONDITION_OPERATORS.find(
                      (option) => option.value === operatorValue,
                    )!;
                    return (
                      <option key={operator.value} value={operator.value}>
                        {workflowText(text, operator.label)}
                      </option>
                    );
                  })}
                </select>
              </label>
              {conditionField === "issue-status" && (
                <label>
                  <span>{text("比较值", "Comparison value")}</span>
                  <select
                    aria-label={text("比较值", "Comparison value")}
                    value={conditionValue}
                    onChange={(event) => onChange({ conditionValue: event.target.value })}
                  >
                    {ISSUE_STATUSES.map((status) => (
                      <option key={status.value} value={status.value}>
                        {workflowText(text, status.label)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {conditionField === "issue-priority" && (
                <label>
                  <span>{text("比较值", "Comparison value")}</span>
                  <select
                    aria-label={text("比较值", "Comparison value")}
                    value={conditionValue}
                    onChange={(event) => onChange({ conditionValue: event.target.value })}
                  >
                    {ISSUE_PRIORITIES.map((priority) => (
                      <option key={priority.value} value={priority.value}>
                        {workflowText(text, priority.label)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {(conditionField === "issue-labels" || conditionField === "upstream-output") && (
                <label>
                  <span>{text("比较值", "Comparison value")}</span>
                  <input
                    aria-label={text("比较值", "Comparison value")}
                    type="text"
                    value={conditionValue}
                    placeholder={text("输入要比较的值", "Enter a value to compare")}
                    onChange={(event) => onChange({ conditionValue: event.target.value })}
                  />
                </label>
              )}
            </div>
          )}

          {data.kind === "feishu-message" && (
            <div className="workflow-config-section">
              <h2>{text("飞书消息", "Feishu message")}</h2>
              <label>
                <span>{text("发送对象", "Recipient")}</span>
                <select
                  aria-label={text("飞书消息发送对象", "Feishu message recipient")}
                  value={data.feishuRecipientType ?? "self"}
                  onChange={(event) => onChange({
                    feishuRecipientType: event.target.value as WorkflowNodeData["feishuRecipientType"],
                    feishuUserId: "",
                    feishuChatId: "",
                  })}
                >
                  {FEISHU_MESSAGE_RECIPIENTS.map((recipient) => (
                    <option key={recipient.value} value={recipient.value}>
                      {workflowText(text, recipient.label)}
                    </option>
                  ))}
                </select>
              </label>
              {data.feishuRecipientType === "user" && (
                <label>
                  <span>{text("用户 ID", "User ID")}</span>
                  <input
                    aria-label={text("飞书用户", "Feishu user")}
                    type="text"
                    value={data.feishuUserId ?? ""}
                    placeholder={text("open_id 或 user_id", "open_id or user_id")}
                    onChange={(event) => onChange({ feishuUserId: event.target.value })}
                  />
                </label>
              )}
              {data.feishuRecipientType === "chat" && (
                <label>
                  <span>{text("群聊 ID", "Chat ID")}</span>
                  <input
                    aria-label={text("飞书群聊", "Feishu chat")}
                    type="text"
                    value={data.feishuChatId ?? ""}
                    placeholder="chat_id"
                    onChange={(event) => onChange({ feishuChatId: event.target.value })}
                  />
                </label>
              )}
            </div>
          )}

          {data.kind === "twitter-post" && (
            <div className="workflow-config-section">
              <h2>{text("发布到 Twitter", "Post to Twitter")}</h2>
              <label>
                <span>{text("发布内容", "Post content")}</span>
                <textarea
                  aria-label={text("Twitter 发布内容", "Twitter post content")}
                  rows={6}
                  value={data.twitterPostContent ?? ""}
                  placeholder={text("输入要发布的内容…", "Enter content to post…")}
                  onChange={(event) => onChange({ twitterPostContent: event.target.value })}
                />
              </label>
            </div>
          )}

          {data.kind === "git" && (
            <div className="workflow-config-section">
              <h2>{text("Git 操作", "Git operation")}</h2>
              <label>
                <span>{text("操作", "Operation")}</span>
                <select
                  aria-label={text("Git 操作", "Git operation")}
                  value={data.gitOperation ?? "commit"}
                  onChange={(event) => onChange({ gitOperation: event.target.value })}
                >
                  {GIT_OPERATIONS.map((operation) => (
                    <option key={operation.value} value={operation.value}>
                      {workflowText(text, operation.label)}
                    </option>
                  ))}
                </select>
              </label>
              {data.gitOperation === "commit" && (
                <>
                  <label>
                    <span>{text("提交说明", "Commit message")}</span>
                    <input
                      aria-label={text("Git 提交说明", "Git commit message")}
                      type="text"
                      value={data.gitCommitMessage ?? ""}
                      placeholder={text("描述本次变更", "Describe this change")}
                      onChange={(event) => onChange({ gitCommitMessage: event.target.value })}
                    />
                  </label>
                  <label className="workflow-action-toggle workflow-action-toggle-full">
                    <input
                      type="checkbox"
                      checked={data.gitStageAll ?? true}
                      onChange={(event) => onChange({ gitStageAll: event.target.checked })}
                    />
                    <span>{text("提交前暂存全部变更", "Stage all changes before commit")}</span>
                  </label>
                </>
              )}
              {(data.gitOperation === "pull" || data.gitOperation === "push") && (
                <>
                  <label>
                    <span>{text("远程仓库", "Remote")}</span>
                    <input
                      aria-label={text("Git 远程仓库", "Git remote")}
                      type="text"
                      value={data.gitRemote ?? "origin"}
                      placeholder="origin"
                      onChange={(event) => onChange({ gitRemote: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>{text("分支", "Branch")}</span>
                    <input
                      aria-label={text("Git 分支", "Git branch")}
                      type="text"
                      value={data.gitBranchName ?? ""}
                      placeholder={text(
                        "留空使用当前分支",
                        "Leave blank to use the current branch",
                      )}
                      onChange={(event) => onChange({ gitBranchName: event.target.value })}
                    />
                  </label>
                </>
              )}
              {(data.gitOperation === "create-branch"
                || data.gitOperation === "switch-branch"
                || data.gitOperation === "merge-branch") && (
                <label>
                  <span>{text("分支名称", "Branch name")}</span>
                  <input
                    aria-label={text("Git 分支名称", "Git branch name")}
                    type="text"
                    value={data.gitBranchName ?? ""}
                    placeholder="feature/workflow"
                    onChange={(event) => onChange({ gitBranchName: event.target.value })}
                  />
                </label>
              )}
              {(data.gitOperation === "create-branch"
                || data.gitOperation === "create-worktree") && (
                <label>
                  <span>{text("基于分支", "Base branch")}</span>
                  <input
                    aria-label={text("Git 基于分支", "Git base branch")}
                    type="text"
                    value={data.gitBaseBranch ?? ""}
                    placeholder={text(
                      "留空使用当前分支",
                      "Leave blank to use the current branch",
                    )}
                    onChange={(event) => onChange({ gitBaseBranch: event.target.value })}
                  />
                </label>
              )}
              {data.gitOperation === "create-worktree" && (
                <>
                  <label>
                    <span>{text("Worktree 分支", "Worktree branch")}</span>
                    <input
                      aria-label={text("Git Worktree 分支", "Git worktree branch")}
                      type="text"
                      value={data.gitBranchName ?? ""}
                      placeholder="feature/workflow"
                      onChange={(event) => onChange({ gitBranchName: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>{text("Worktree 目录", "Worktree directory")}</span>
                    <input
                      aria-label={text("Git Worktree 目录", "Git worktree directory")}
                      type="text"
                      value={data.gitWorktreePath ?? ""}
                      placeholder="../project-worktree"
                      onChange={(event) => onChange({ gitWorktreePath: event.target.value })}
                    />
                  </label>
                </>
              )}
            </div>
          )}

          {data.kind === "custom-code" && (
            <div className="workflow-config-section">
              <h2>{text("自定义代码", "Custom code")}</h2>
              <label>
                <span>{text("运行环境", "Runtime")}</span>
                <select
                  aria-label={text("代码运行环境", "Code runtime")}
                  value={data.codeRuntime ?? "shell"}
                  onChange={(event) => onChange({ codeRuntime: event.target.value as WorkflowNodeData["codeRuntime"] })}
                >
                  {CODE_RUNTIMES.map((runtime) => (
                    <option key={runtime.value} value={runtime.value}>
                      {workflowText(text, runtime.label)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{text("代码内容", "Code")}</span>
                <textarea
                  aria-label={text("代码内容", "Code")}
                  rows={10}
                  value={data.codeContent ?? ""}
                  placeholder={text("输入要运行的代码…", "Enter code to run…")}
                  onChange={(event) => onChange({ codeContent: event.target.value })}
                />
              </label>
            </div>
          )}

          {data.kind === "run-tests" && (
            <div className="workflow-config-section">
              <h2>{text("运行测试", "Run tests")}</h2>
              <label>
                <span>{text("测试范围", "Test scope")}</span>
                <select
                  aria-label={text("测试范围", "Test scope")}
                  value={data.testScope ?? "related"}
                  onChange={(event) => onChange({ testScope: event.target.value as WorkflowNodeData["testScope"] })}
                >
                  {TEST_SCOPES.map((scope) => (
                    <option key={scope.value} value={scope.value}>
                      {workflowText(text, scope.label)}
                    </option>
                  ))}
                </select>
              </label>
              {data.testScope === "custom" && (
                <label>
                  <span>{text("测试命令", "Test command")}</span>
                  <input
                    aria-label={text("测试命令", "Test command")}
                    type="text"
                    value={data.testCommand ?? ""}
                    placeholder={text(
                      "例如 npm test -- workflow",
                      "For example, npm test -- workflow",
                    )}
                    onChange={(event) => onChange({ testCommand: event.target.value })}
                  />
                </label>
              )}
            </div>
          )}

          {(data.kind === "claude-code-planning" || data.kind === "claude-code-review") && (
            <div className="workflow-config-section">
              <h2>Claude Code</h2>
              <label>
                <span>{text("模型", "Model")}</span>
                <select
                  aria-label={text("Claude Code 模型", "Claude Code model")}
                  value={data.claudeModel ?? "claude-sonnet"}
                  onChange={(event) => onChange({ claudeModel: event.target.value })}
                >
                  <option value="claude-sonnet">Claude Sonnet</option>
                  <option value="claude-opus">Claude Opus</option>
                  <option value="claude-haiku">Claude Haiku</option>
                </select>
              </label>
              <label>
                <span>{text("推理强度", "Reasoning effort")}</span>
                <select
                  aria-label={text("推理强度", "Reasoning effort")}
                  value={data.reasoningEffort ?? "high"}
                  onChange={(event) => onChange({ reasoningEffort: event.target.value })}
                >
                  <option value="low">{text("低", "Low")}</option>
                  <option value="medium">{text("中", "Medium")}</option>
                  <option value="high">{text("高", "High")}</option>
                  <option value="max">{text("最高", "Maximum")}</option>
                </select>
              </label>
              <label>
                <span>{text("规划要求", "Planning requirements")}</span>
                <textarea
                  rows={4}
                  value={data.planningRequirements ?? ""}
                  placeholder={text(
                    "说明分析步骤、约束、风险和验收要求…",
                    "Describe analysis steps, constraints, risks, and acceptance criteria…",
                  )}
                  onChange={(event) => onChange({ planningRequirements: event.target.value })}
                />
              </label>
            </div>
          )}

          {data.kind === "issue-trigger" && (
            <div className="workflow-config-section">
              <h2>{text("触发条件", "Trigger condition")}</h2>
              <label>
                <span>{text("议题状态变为", "Issue status changes to")}</span>
                <select
                  aria-label={text("议题触发状态", "Issue trigger status")}
                  value={data.triggerStatus ?? "todo"}
                  onChange={(event) => {
                    const status = ISSUE_STATUSES.find(
                      (option) => option.value === event.target.value,
                    )!;
                    onChange({
                      triggerStatus: event.target.value,
                      description: `状态变为「${status.label}」时触发`,
                    });
                  }}
                >
                  {ISSUE_STATUSES.map((status) => (
                    <option key={status.value} value={status.value}>
                      {workflowText(text, status.label)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {data.kind === "issue-update" && (
            <div className="workflow-config-section">
              <h2>{text("议题操作", "Issue actions")}</h2>
              <label>
                <span>{text("议题选择", "Issue selection")}</span>
                <select
                  aria-label={text("议题选择", "Issue selection")}
                  value={data.issueTarget ?? "trigger"}
                  onChange={(event) => onChange({ issueTarget: event.target.value })}
                >
                  <option value="trigger">
                    {text("触发流程的议题", "Issue that triggered the workflow")}
                  </option>
                  <option value="upstream">
                    {text("上游节点输出的议题", "Issue from an upstream node")}
                  </option>
                  <option value="specific">{text("指定议题", "Specific issue")}</option>
                </select>
              </label>
              {data.issueTarget === "specific" && (
                <label>
                  <span>{text("议题 ID", "Issue ID")}</span>
                  <input
                    aria-label={text("指定议题 ID", "Specific issue ID")}
                    type="text"
                    value={data.specificIssueId ?? ""}
                    placeholder={text("输入实际议题编号", "Enter an issue ID")}
                    onChange={(event) => onChange({ specificIssueId: event.target.value })}
                  />
                </label>
              )}
              <div className="workflow-action-row">
                <label className="workflow-action-toggle">
                  <input
                    type="checkbox"
                    checked={data.changeStatus ?? false}
                    onChange={(event) => onChange({ changeStatus: event.target.checked })}
                  />
                  <span>{text("改变状态", "Change status")}</span>
                </label>
                <select
                  aria-label={text("目标状态", "Target status")}
                  disabled={!data.changeStatus}
                  value={data.targetStatus ?? "in_review"}
                  onChange={(event) => onChange({ targetStatus: event.target.value })}
                >
                  {ISSUE_STATUSES.map((status) => (
                    <option key={status.value} value={status.value}>
                      {workflowText(text, status.label)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="workflow-action-row">
                <label className="workflow-action-toggle">
                  <input
                    type="checkbox"
                    checked={data.addComment ?? false}
                    onChange={(event) => onChange({ addComment: event.target.checked })}
                  />
                  <span>{text("添加评论", "Add comment")}</span>
                </label>
                <select
                  aria-label={text("评论内容", "Comment content")}
                  disabled={!data.addComment}
                  value={data.commentSource ?? "workflow-output"}
                  onChange={(event) => onChange({ commentSource: event.target.value })}
                >
                  <option value="workflow-output">
                    {text("上游节点输出", "Upstream node output")}
                  </option>
                  <option value="run-summary">
                    {text("流程运行摘要", "Workflow run summary")}
                  </option>
                  <option value="custom">{text("自定义内容", "Custom content")}</option>
                </select>
              </div>
              {data.addComment && data.commentSource === "custom" && (
                <label>
                  <span>{text("评论内容", "Comment content")}</span>
                  <textarea
                    rows={3}
                    value={data.customComment ?? ""}
                    placeholder={text(
                      "输入要追加到议题的评论…",
                      "Enter a comment to add to the issue…",
                    )}
                    onChange={(event) => onChange({ customComment: event.target.value })}
                  />
                </label>
              )}
              <div className="workflow-action-row">
                <label className="workflow-action-toggle">
                  <input
                    type="checkbox"
                    checked={data.addLabels ?? false}
                    onChange={(event) => onChange({ addLabels: event.target.checked })}
                  />
                  <span>{text("添加标签", "Add labels")}</span>
                </label>
                <input
                  aria-label={text("要添加的标签", "Labels to add")}
                  type="text"
                  disabled={!data.addLabels}
                  value={data.labelsToAdd ?? ""}
                  placeholder={text("自动化, 已处理", "Automation, Processed")}
                  onChange={(event) => onChange({ labelsToAdd: event.target.value })}
                />
              </div>
              <div className="workflow-action-row">
                <label className="workflow-action-toggle">
                  <input
                    type="checkbox"
                    checked={data.setPriority ?? false}
                    onChange={(event) => onChange({ setPriority: event.target.checked })}
                  />
                  <span>{text("设置优先级", "Set priority")}</span>
                </label>
                <select
                  aria-label={text("目标优先级", "Target priority")}
                  disabled={!data.setPriority}
                  value={data.targetPriority ?? "none"}
                  onChange={(event) => onChange({ targetPriority: event.target.value })}
                >
                  {ISSUE_PRIORITIES.map((priority) => (
                    <option key={priority.value} value={priority.value}>
                      {workflowText(text, priority.label)}
                    </option>
                  ))}
                </select>
              </div>
              <label className="workflow-action-toggle workflow-action-toggle-full">
                <input
                  type="checkbox"
                  checked={data.attachArtifacts ?? false}
                  onChange={(event) => onChange({ attachArtifacts: event.target.checked })}
                />
                <span>{text("附加流程运行产物", "Attach workflow run artifacts")}</span>
              </label>
              <label className="workflow-action-toggle workflow-action-toggle-full">
                <input
                  type="checkbox"
                  checked={data.recordConversation ?? false}
                  onChange={(event) => onChange({ recordConversation: event.target.checked })}
                />
                <span>
                  {text(
                    "记录执行该议题的 Codex 对话",
                    "Record the Codex conversation that processes this issue",
                  )}
                </span>
              </label>
            </div>
          )}

          <div className="workflow-config-section">
            <h2>{text("连接", "Connections")}</h2>
            <div className="workflow-port-row">
              <span>
                <i className="input" aria-hidden="true" />
                {text("输入", "Input")}
              </span>
              <strong>
                {data.inputLabel
                  ? workflowText(text, data.inputLabel)
                  : text("无", "None")}
              </strong>
            </div>
            <div className="workflow-port-row">
              <span>
                <i className="output" aria-hidden="true" />
                {text("输出", "Output")}
              </span>
              <strong>
                {data.outputLabel
                  ? workflowText(text, data.outputLabel)
                  : text("无", "None")}
              </strong>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
