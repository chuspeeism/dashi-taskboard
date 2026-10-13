import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LinearIcon } from "./LinearIcon";
import { ProjectIcon, RecurrenceIcon } from "./SemanticIcons";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { TaskboardIcon } from "./TaskboardIcon";
import { useTaskboardI18n } from "../i18n";
import { listenForMenuViewportChange, listenForOutsidePointerDown } from "../menuEvents";
import type { AiChatModel } from "../types";

type AutomationStatus = "ACTIVE" | "PAUSED";
type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";
type IntervalMinutes = 5 | 10 | 15 | 30 | 60;

interface AutomationOptions {
  enabledByUser: boolean;
  quotaAware: boolean;
  intervalMinutes: IntervalMinutes;
  model: string;
  reasoningEffort: string;
}

interface AutomationState extends AutomationOptions {
  status: AutomationStatus;
  idleReason?: "checking-todos" | "waiting-todos";
  quota?: {
    state: AutomationQuotaState;
    checkedAt: number;
    resetsAt?: number;
    reason?: "api-key";
  };
}

export type AutoRunRunner = "claude" | "codex";

interface ProjectAutomationMenuProps {
  runner: AutoRunRunner;
  // Claude Code agent loop settings; null when the project has no agent loop.
  loop: { enabled: boolean; maxConcurrent: number; active: number; limit: number } | null;
  // Claude Code loop runner heartbeat status; null hides it.
  runnerStatus: { state: "running" | "in_progress" | "stuck" | "not_running"; since: number | null } | null;
  runnerNote: string | null;
  onCopyCoordinatorCommand: () => void;
  onRunnerChange: (runner: AutoRunRunner) => void;
  onEnabledChange: (enabled: boolean) => void;
  onMaxConcurrentChange: (maxConcurrent: number) => void;
  automation?: Partial<AutomationState>;
  models: AiChatModel[];
  pending: boolean;
  error: string | null;
  unavailableReason: string | null;
  onOpen: () => void;
  onChange: (options: AutomationOptions) => void;
}

const EFFORT_LABELS: Record<string, readonly [string, string]> = {
  low: ["轻度", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["极高 (xhigh)", "Extra high (xhigh)"],
  max: ["最高", "Maximum"],
  ultra: ["极高 (ultra)", "Ultra"],
};

export function automationOptions(
  models: AiChatModel[],
  automation?: Partial<AutomationState>,
): AutomationOptions {
  const model = models.find((candidate) => candidate.slug === automation?.model) ?? models[0];
  const reasoningEffort = model?.supportedReasoningEfforts.includes(automation?.reasoningEffort ?? "")
    ? automation?.reasoningEffort
    : model?.defaultReasoningEffort;
  return {
    enabledByUser: automation?.enabledByUser ?? false,
    quotaAware: automation?.quotaAware ?? false,
    intervalMinutes: automation?.intervalMinutes ?? 5,
    model: model?.slug ?? automation?.model ?? "",
    reasoningEffort: reasoningEffort ?? automation?.reasoningEffort ?? "",
  };
}

export function ProjectAutomationMenu({
  runner,
  loop,
  runnerStatus,
  runnerNote,
  onCopyCoordinatorCommand,
  onRunnerChange,
  onEnabledChange,
  onMaxConcurrentChange,
  automation,
  models,
  pending,
  error,
  unavailableReason,
  onOpen,
  onChange,
}: ProjectAutomationMenuProps) {
  const { locale, text } = useTaskboardI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasPendingRef = useRef(pending);
  const [open, setOpen] = useState(false);
  const [pickerMenu, setPickerMenu] = useState<"interval" | "model" | "reasoning" | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationOptions>(() => automationOptions(models, automation));
  const status = automation?.status ?? "PAUSED";
  const quota = automation?.quota;
  const idleLabel = automation?.enabledByUser && automation.idleReason === "checking-todos"
    ? text("正在判断待办", "Checking todos")
    : automation?.enabledByUser && automation.idleReason === "waiting-todos"
      ? text("等待任务条件", "Waiting for task conditions")
      : null;
  const stateLabel = idleLabel ?? (!automation?.enabledByUser
    ? text("已暂停", "Paused")
    : automation.quotaAware && quota?.state === "blocked"
      ? text("额度暂停", "Paused by quota")
      : automation.quotaAware && quota?.state === "unavailable"
        ? text("额度不可用", "Quota unavailable")
        : automation.quotaAware && (!quota || quota.state === "unknown")
          ? text("额度未知", "Quota unknown")
          : status === "ACTIVE"
            ? text("运行中", "Running")
            : text("已暂停", "Paused"));
  const selectedModel = models.find((model) => model.slug === draft.model) ?? models[0];
  const disabled = pending || !selectedModel || Boolean(unavailableReason);
  const isCodex = runner === "codex";
  const enabled = isCodex ? draft.enabledByUser : Boolean(loop?.enabled);
  const active = isCodex ? status === "ACTIVE" : Boolean(loop?.enabled);
  const triggerLabel = isCodex
    ? idleLabel ?? (status === "ACTIVE" ? text("自动认领中", "Auto-claiming") : text("自动运行", "Auto-run"))
    : loop?.enabled
      ? `Claude Code ${loop.active}/${loop.maxConcurrent}`
      : text("自动运行", "Auto-run");

  const runnerMinutes = runnerStatus?.since ? Math.max(0, Math.floor((Date.now() - runnerStatus.since) / 60_000)) : 0;
  const runnerLabel = !runnerStatus
    ? null
    : runnerStatus.state === "running"
      ? text(`运行中 · 上次 ${runnerMinutes} 分钟前`, `Running · last tick ${runnerMinutes}m ago`)
      : runnerStatus.state === "in_progress"
        ? text(`本轮进行中 ${runnerMinutes} 分钟`, `Tick in progress ${runnerMinutes}m`)
        : runnerStatus.state === "stuck"
          ? text("卡住？", "Stuck?")
          : text("未运行", "Not running");

  useEffect(() => {
    if (!open) return;
    setDraft(automationOptions(models, automation));
  }, [automation, models, open]);

  useEffect(() => {
    if (!open) setPickerMenu(null);
  }, [open]);

  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      setDraft(automationOptions(models, automation));
    }
    wasPendingRef.current = pending;
  }, [automation, pending]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const stopOutside = listenForOutsidePointerDown([triggerRef, menuRef], close);
    const stopViewport = listenForMenuViewportChange(menuRef, close);
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !pickerMenu) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      stopOutside();
      stopViewport();
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [open, pickerMenu]);

  const submitChange = (next: AutomationOptions) => {
    if (disabled) return;
    setDraft(next);
    onChange(next);
  };

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu no-drag"
      role="dialog"
      aria-label={text("自动运行设置", "Auto-run settings")}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>{text("自动运行", "Auto-run")}</strong>
        <span className={active ? "is-active" : "is-paused"}>
          {isCodex ? stateLabel : loop?.enabled ? text("运行中", "Running") : text("已暂停", "Paused")}
        </span>
      </div>
      {loop && (
        <div className="project-automation-runner" role="radiogroup" aria-label={text("运行器", "Runner")}>
          {([["claude", "Claude Code"], ["codex", "Codex"]] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={runner === value}
              className={runner === value ? "is-selected" : undefined}
              disabled={pending}
              onClick={() => runner !== value && onRunnerChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="project-automation-switch">
        <span>{text("自动运行开关", "Auto-run")}</span>
        <button
          type="button"
          className={`board-setting-switch${enabled ? " is-on" : ""}`}
          role="switch"
          aria-checked={enabled}
          disabled={isCodex && disabled}
          onClick={() => {
            if (isCodex) setDraft({ ...draft, enabledByUser: !enabled });
            onEnabledChange(!enabled);
          }}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {loop && (
        <div className="project-automation-field">
          <span>{text("进行中 / 最大并发", "Active / max concurrent")}</span>
          <span className="project-automation-count">
            {loop.active} /
            <select
              className="project-automation-select"
              value={loop.maxConcurrent}
              onChange={(event) => onMaxConcurrentChange(Number(event.target.value))}
              aria-label={text("最大并发任务数", "Max concurrent tasks")}
            >
              {Array.from({ length: loop.limit }, (_, index) => index + 1).map((value) => (
                <option value={value} key={value}>{value}</option>
              ))}
            </select>
          </span>
        </div>
      )}
      {isCodex && (
        <>
      <div className="project-automation-switch">
        <span>{text("根据额度启用/关闭", "Use quota limits")}</span>
        <button
          type="button"
          className={`board-setting-switch${draft.quotaAware ? " is-on" : ""}`}
          role="switch"
          aria-checked={draft.quotaAware}
          disabled={disabled}
          onClick={() => submitChange({
            ...draft,
            quotaAware: !draft.quotaAware,
          })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {draft.quotaAware && (
        <div className={`project-automation-quota is-${quota?.state ?? "unknown"}`}>
          {quota?.state === "available" && text("当前额度可用", "Quota is available")}
          {quota?.state === "blocked" && (
            quota.resetsAt
              ? text(
                `额度已用尽，预计 ${formatResetTime(quota.resetsAt, locale)} 恢复`,
                `Quota is exhausted. Expected reset: ${formatResetTime(quota.resetsAt, locale)}.`,
              )
              : text("额度已用尽，自动认领已暂停", "Quota is exhausted. Auto-claim is paused.")
          )}
          {quota?.state === "unavailable" && (
            quota.reason === "api-key"
              ? text(
                "API Key 模式不支持读取 Codex App 额度",
                "API key mode cannot read the Codex app quota.",
              )
              : text("当前账户无法读取额度", "This account cannot read quota information.")
          )}
          {(!quota || quota.state === "unknown") && text(
            "额度状态未知，自动认领已暂停",
            "Quota status is unknown. Auto-claim is paused.",
          )}
        </div>
      )}
      <div className="project-automation-field">
        <span>{text("间隔", "Interval")}</span>
        <TaskPropertyPicker
          value={String(draft.intervalMinutes)}
          options={[5, 10, 15, 30, 60].map((minutes) => ({
            value: String(minutes),
            label: text(`${minutes} 分钟`, `${minutes} min`),
            icon: <RecurrenceIcon color="currentColor" size={14} />,
          }))}
          open={pickerMenu === "interval"}
          disabled={disabled}
          className="project-automation-picker"
          triggerClassName="project-automation-picker-trigger"
          ariaLabel={text("间隔", "Interval")}
          onOpenChange={(open) => setPickerMenu(open ? "interval" : null)}
          onChange={(value) => submitChange({
            ...draft,
            intervalMinutes: Number(value) as IntervalMinutes,
          })}
        />
      </div>
      {selectedModel && (
        <>
          <div className="project-automation-field">
            <span>{text("模型", "Model")}</span>
            <TaskPropertyPicker
              value={draft.model}
              options={models.map((model) => ({
                value: model.slug,
                label: model.displayName,
                icon: <ProjectIcon color="currentColor" size={14} />,
              }))}
              open={pickerMenu === "model"}
              disabled={disabled}
              className="project-automation-picker"
              triggerClassName="project-automation-picker-trigger"
              ariaLabel={text("模型", "Model")}
              onOpenChange={(open) => setPickerMenu(open ? "model" : null)}
              onChange={(value) => {
                const model = models.find((candidate) => candidate.slug === value);
                if (!model) return;
                submitChange({
                  ...draft,
                  model: value,
                  reasoningEffort: model.supportedReasoningEfforts.includes(draft.reasoningEffort)
                    ? draft.reasoningEffort
                    : model.defaultReasoningEffort,
                });
              }}
            />
          </div>
          <div className="project-automation-field">
            <span>{text("推理强度", "Reasoning effort")}</span>
            <TaskPropertyPicker
              value={draft.reasoningEffort}
              options={selectedModel.supportedReasoningEfforts.map((effort) => ({
                value: effort,
                label: EFFORT_LABELS[effort] ? text(...EFFORT_LABELS[effort]) : effort,
                icon: <LinearIcon name="displayOptions" />,
              }))}
              open={pickerMenu === "reasoning"}
              disabled={disabled}
              className="project-automation-picker"
              triggerClassName="project-automation-picker-trigger"
              ariaLabel={text("推理强度", "Reasoning effort")}
              onOpenChange={(open) => setPickerMenu(open ? "reasoning" : null)}
              onChange={(value) => submitChange({
                ...draft,
                reasoningEffort: value,
              })}
            />
          </div>
        </>
      )}
      {idleLabel && (
        <p className="project-automation-note" role="status">
          {automation?.idleReason === "waiting-todos"
            ? text(
              "当前待办任务都需要等待，已暂停本轮自动认领。新增可执行任务，或更新任务说明、最新评论后，将自动重新判断。",
              "Current tasks need to wait, so auto-claim is paused for now. New actionable tasks or changes to task descriptions or latest comments will trigger a new check.",
            )
            : text(
              "正在确认待办任务是否可以开始，确认前暂停自动认领。",
              "Checking whether tasks can start. Auto-claim is paused until the check is complete.",
            )}
        </p>
      )}
      {unavailableReason && <p className="project-automation-note">{unavailableReason}</p>}
      {error && error !== unavailableReason && <p className="project-automation-error" role="alert">{error}</p>}
        </>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${active ? "is-active" : "is-paused"}`}
        aria-label={triggerLabel}
        aria-busy={pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={triggerLabel}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
        <TaskboardIcon name={active ? "automationPause" : "automationPlay"} />
        <span>{triggerLabel}</span>
      </button>
      {runnerStatus && (
        <span
          className={`project-runner-status is-${runnerStatus.state}`}
          role="status"
          title={runnerNote ?? undefined}
        >
          {runnerLabel}
        </span>
      )}
      {(runnerStatus?.state === "not_running" || runnerStatus?.state === "stuck") && (
        <button
          type="button"
          className="project-runner-copy no-drag"
          title={text(
            "在 dashi-taskboard 仓库的新 Claude Code 会话中运行",
            "Run in a new Claude Code session in the dashi-taskboard repository",
          )}
          onClick={onCopyCoordinatorCommand}
        >
          {text("复制启动命令", "Copy start command")}
        </button>
      )}
      {menu}
    </>
  );
}

function formatResetTime(value: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1_000));
}
