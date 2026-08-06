import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ApiError,
  archiveProjectContextEntry,
  createProjectContextEntry,
  getProjectContextEntry,
  listProjectContext,
  listProjectContextRevisions,
  restoreProjectContextEntry,
  updateProjectContextEntry,
} from "../api";
import type {
  ProjectContextCreateInput,
  ProjectContextEntry,
  ProjectContextKind,
  ProjectContextRevision,
  ProjectContextUpdateInput,
} from "../types";
import { LinearIcon, type LinearIconName } from "./LinearIcon";

const CONTEXT_BODY_MAX_BYTES = 65_536;
const CONTEXT_BODY_WARNING_BYTES = 60 * 1024;

const KIND_DETAILS: Record<ProjectContextKind, { label: string; icon: LinearIconName }> = {
  requirement: { label: "需求", icon: "write" },
  decision: { label: "决策", icon: "check" },
  constraint: { label: "约束", icon: "shieldAlert" },
  fact: { label: "事实", icon: "status" },
  risk: { label: "风险", icon: "alert" },
  handoff: { label: "交接", icon: "hand" },
  summary: { label: "总结", icon: "dashboard" },
};

const CONTEXT_KINDS = Object.keys(KIND_DETAILS) as ProjectContextKind[];

interface ContextDraft {
  kind: ProjectContextKind;
  title: string;
  body: string;
  tags: string;
  pinned: boolean;
}

interface ContextConflict {
  latest: ProjectContextEntry;
  baseVersion: number;
}

type ContextAction = "pin" | "archive" | "restore";

interface ContextActionConflict extends ContextConflict {
  action: ContextAction;
}

interface DraftValidationError {
  field: "title" | "body" | "tags";
  message: string;
}

interface ContextViewProps {
  projectId: string;
  revision: number;
  createRequest: number;
  onAnnounce: (message: string) => void;
}

function emptyDraft(): ContextDraft {
  return { kind: "decision", title: "", body: "", tags: "", pinned: false };
}

function draftFromEntry(entry: ProjectContextEntry): ContextDraft {
  return {
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    tags: entry.tags.join(", "),
    pinned: entry.pinned,
  };
}

function parseTags(value: string): string[] {
  return [...new Set(value.split(/[,，]/u).map((tag) => tag.trim()).filter(Boolean))];
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "操作未完成，请重试。";
}

function isContextVersionConflict(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.status === 409
    && (error.code === "VERSION_CONFLICT" || error.code === "CONTEXT_VERSION_CONFLICT");
}

function exactTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function relativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function markdownSummary(value: string): string {
  const plain = value
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[#>*_~`|\-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return plain || "无正文";
}

function sortContextEntries(entries: ProjectContextEntry[]): ProjectContextEntry[] {
  return [...entries].sort((left, right) => (
    Number(right.pinned) - Number(left.pinned)
  ));
}

function ContextMarkdown({ value }: { value: string }) {
  return (
    <div className="issue-description-document context-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}

function visibleSourceIdentifier(value: string | null): string | null {
  if (!value) return null;
  if (/^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(value)) return null;
  return value;
}

function sourceLabel(entry: ProjectContextEntry): string {
  const labels: Record<ProjectContextEntry["sourceType"], string> = {
    manual: "手动记录",
    issue: "议题",
    comment: "评论",
    thread_summary: "线程摘要",
    agent: "Agent",
  };
  const sourceId = visibleSourceIdentifier(entry.sourceId);
  return `${labels[entry.sourceType]}${sourceId ? ` · ${sourceId}` : ""}`;
}

export function ContextView({
  projectId,
  revision,
  createRequest,
  onAnnounce,
}: ContextViewProps) {
  const [entries, setEntries] = useState<ProjectContextEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ProjectContextKind | "">("");
  const [tag, setTag] = useState("");
  const [pinned, setPinned] = useState<"" | "true" | "false">("");
  const [showArchived, setShowArchived] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingEntry, setEditingEntry] = useState<ProjectContextEntry | null>(null);
  const [draft, setDraft] = useState<ContextDraft>(emptyDraft);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validationField, setValidationField] = useState<DraftValidationError["field"] | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ContextConflict | null>(null);
  const [actionConflict, setActionConflict] = useState<ContextActionConflict | null>(null);
  const [revisions, setRevisions] = useState<ProjectContextRevision[] | null>(null);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [revisionPreview, setRevisionPreview] = useState<ProjectContextRevision | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ProjectContextEntry | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const loadSequence = useRef(0);
  const loadAbortController = useRef<AbortController | null>(null);
  const revisionSequence = useRef(0);
  const previousCreateRequest = useRef(createRequest);
  const idempotencyKeyRef = useRef<string | null>(null);
  const archiveTriggerRef = useRef<HTMLButtonElement>(null);
  const archiveConfirmRef = useRef<HTMLButtonElement>(null);
  const archiveDialogRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(saving);
  const tagsRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const selectedFromEntries = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  );
  const selected = editorOpen && editingEntry
    ? editingEntry
    : actionConflict?.latest ?? selectedFromEntries;
  const availableTags = useMemo(
    () => [...new Set(entries.flatMap((entry) => entry.tags))].sort(),
    [entries],
  );
  const filtersActive = Boolean(query || kind || tag || pinned || showArchived);
  const bodyBytes = byteLength(draft.body);
  const visibleSourceThreadId = visibleSourceIdentifier(selected?.sourceThreadId ?? null);
  const confirmArchive = archiveTarget !== null;

  function entryMatchesCurrentFilters(entry: ProjectContextEntry): boolean {
    if (kind && entry.kind !== kind) return false;
    if (tag.trim() && !entry.tags.includes(tag.trim())) return false;
    if (pinned === "true" && !entry.pinned) return false;
    if (pinned === "false" && entry.pinned) return false;
    if (!showArchived && entry.archivedAt) return false;
    if (query.trim()) {
      const needle = query.trim().toLocaleLowerCase();
      const haystack = [entry.title, entry.body, ...entry.tags].join("\n").toLocaleLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  }

  function invalidateRevisions() {
    revisionSequence.current += 1;
    setRevisions(null);
    setRevisionsLoading(false);
    setRevisionPreview(null);
  }

  function applySavedEntry(entry: ProjectContextEntry) {
    const matches = entryMatchesCurrentFilters(entry);
    setEntries((current) => {
      const withoutSaved = current.filter((candidate) => candidate.id !== entry.id);
      return matches ? sortContextEntries([entry, ...withoutSaved]) : withoutSaved;
    });
    setSelectedId(matches ? entry.id : null);
    if (!matches) setMobileDetail(false);
    invalidateRevisions();
  }

  async function loadEntries({ append = false, cursor }: { append?: boolean; cursor?: string } = {}) {
    const sequence = ++loadSequence.current;
    loadAbortController.current?.abort();
    const controller = new AbortController();
    loadAbortController.current = controller;
    if (append) {
      setLoadingMore(true);
      setLoadMoreError(null);
    } else {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const result = await listProjectContext(projectId, {
        query: query.trim() || undefined,
        kind: kind || undefined,
        tag: tag.trim() || undefined,
        pinned: pinned === "" ? undefined : pinned === "true",
        archived: showArchived ? "all" : "false",
        limit: 50,
        cursor,
      }, controller.signal);
      if (sequence !== loadSequence.current) return;
      const sortedResultEntries = sortContextEntries(result.entries);
      setEntries((current) => append
        ? sortContextEntries([
          ...current,
          ...result.entries.filter((entry) => !current.some(({ id }) => id === entry.id)),
        ])
        : sortedResultEntries);
      setNextCursor(result.nextCursor);
      if (!append) {
        setSelectedId((current) => (
          current && sortedResultEntries.some((entry) => entry.id === current)
            ? current
            : sortedResultEntries[0]?.id ?? null
        ));
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      if (append) setLoadMoreError(messageFor(error));
      else setLoadError(messageFor(error));
    } finally {
      if (sequence === loadSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
      if (loadAbortController.current === controller) loadAbortController.current = null;
    }
  }

  useEffect(() => () => loadAbortController.current?.abort(), []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadEntries(), query ? 240 : 0);
    return () => window.clearTimeout(timer);
  // `loadEntries` intentionally reads the current filter values.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, query, kind, tag, pinned, showArchived]);

  useEffect(() => {
    setNextCursor(null);
    setLoadMoreError(null);
  }, [projectId, query, kind, tag, pinned, showArchived]);

  useEffect(() => {
    if (revision === 0) return;
    void loadEntries();
  // A realtime refresh updates the list but never resets the editor draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  useEffect(() => {
    if (createRequest === previousCreateRequest.current) return;
    previousCreateRequest.current = createRequest;
    startCreate();
  }, [createRequest]);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    revisionSequence.current += 1;
    setRevisions(null);
    setRevisionsLoading(false);
    setRevisionPreview(null);
  }, [selectedId]);

  useEffect(() => {
    if (!confirmArchive) return undefined;
    window.setTimeout(() => archiveConfirmRef.current?.focus(), 0);

    function handleArchiveDialogKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !savingRef.current) {
        event.preventDefault();
        setArchiveTarget(null);
        window.setTimeout(() => archiveTriggerRef.current?.focus(), 0);
        return;
      }
      if (event.key !== "Tab") return;
      const buttons = [...(archiveDialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      if (buttons.length === 0) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleArchiveDialogKeyDown);
    return () => document.removeEventListener("keydown", handleArchiveDialogKeyDown);
  }, [confirmArchive]);

  function startCreate() {
    if (editorOpen) {
      setSaveError("请先保存或取消当前编辑，草稿仍保留在表单中。");
      onAnnounce("请先保存或取消当前编辑。");
      return;
    }
    setCreating(true);
    setEditorOpen(true);
    setEditingEntry(null);
    setActionConflict(null);
    setArchiveTarget(null);
    setDraft(emptyDraft());
    setBaseVersion(null);
    setConflict(null);
    setSaveError(null);
    setValidationField(null);
    setRevisionPreview(null);
    idempotencyKeyRef.current = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setMobileDetail(true);
    window.setTimeout(() => titleRef.current?.focus(), 0);
  }

  function openEntry(entry: ProjectContextEntry) {
    if (editorOpen) return;
    setSelectedId(entry.id);
    setCreating(false);
    setEditorOpen(false);
    setEditingEntry(null);
    setActionConflict(null);
    setArchiveTarget(null);
    setDraft(draftFromEntry(entry));
    setBaseVersion(entry.version);
    setConflict(null);
    setSaveError(null);
    setValidationField(null);
    setRevisions(null);
    setRevisionPreview(null);
    setMobileDetail(true);
  }

  function startEdit() {
    if (!selected || selected.archivedAt) return;
    setCreating(false);
    setEditorOpen(true);
    setEditingEntry(selected);
    setActionConflict(null);
    setArchiveTarget(null);
    setDraft(draftFromEntry(selected));
    setBaseVersion(selected.version);
    setConflict(null);
    setSaveError(null);
    setValidationField(null);
    window.setTimeout(() => titleRef.current?.focus(), 0);
  }

  function cancelEdit() {
    setEditorOpen(false);
    setCreating(false);
    setEditingEntry(null);
    setConflict(null);
    setSaveError(null);
    setValidationField(null);
    if (selected) setDraft(draftFromEntry(selected));
  }

  function validateDraft(): DraftValidationError | null {
    if (!draft.title.trim()) return { field: "title", message: "标题不能为空。" };
    if (draft.title.trim().length > 240) return { field: "title", message: "标题不能超过 240 个字符。" };
    if (bodyBytes > CONTEXT_BODY_MAX_BYTES) {
      return { field: "body", message: "正文不能超过 64 KiB，请删减后保存。" };
    }
    const tags = parseTags(draft.tags);
    if (tags.length > 20) return { field: "tags", message: "最多添加 20 个标签。" };
    if (tags.some((item) => item.length > 64)) {
      return { field: "tags", message: "每个标签不能超过 64 个字符。" };
    }
    return null;
  }

  function focusValidationField(field: DraftValidationError["field"]) {
    if (field === "title") titleRef.current?.focus();
    if (field === "tags") tagsRef.current?.focus();
    if (field === "body") bodyRef.current?.focus();
  }

  async function refreshConflict(error: ApiError, version: number) {
    if (!selected) return;
    try {
      const latest = await getProjectContextEntry(selected.id);
      setConflict({ latest, baseVersion: version });
      setBaseVersion(latest.version);
      setEditingEntry(latest);
      setEntries((current) => sortContextEntries(current.map((entry) => entry.id === latest.id ? latest : entry)));
    } catch {
      setSaveError(`${error.message} 你的输入已保留，请刷新后重试。`);
    }
  }

  async function refreshStaleAction(error: ApiError, entryId: string, action: ContextAction, baseVersion: number) {
    if (action === "archive") setArchiveTarget(null);
    try {
      const latest = await getProjectContextEntry(entryId);
      setEntries((current) => {
        const withoutLatest = current.filter((entry) => entry.id !== latest.id);
        return entryMatchesCurrentFilters(latest)
          ? sortContextEntries([latest, ...withoutLatest])
          : withoutLatest;
      });
      setSelectedId(latest.id);
      setBaseVersion(latest.version);
      setActionConflict({ latest, action, baseVersion });
      setArchiveTarget(null);
      setSaveError(null);
    } catch {
      setSaveError(`${error.message} 无法加载最新版本，请刷新后重试。`);
    }
  }

  async function saveDraft() {
    const validation = validateDraft();
    if (validation) {
      setValidationField(validation.field);
      setSaveError(validation.message);
      focusValidationField(validation.field);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setValidationField(null);
    try {
      const values = {
        kind: draft.kind,
        title: draft.title.trim(),
        body: draft.body,
        tags: parseTags(draft.tags),
        pinned: draft.pinned,
      };
      const saved = creating
        ? await createProjectContextEntry(projectId, {
          ...values,
          sourceType: "manual",
          idempotencyKey: idempotencyKeyRef.current,
        } satisfies ProjectContextCreateInput)
        : await updateProjectContextEntry(
          selected!.id,
          baseVersion ?? selected!.version,
          values satisfies ProjectContextUpdateInput,
        );
      applySavedEntry(saved);
      setCreating(false);
      setEditorOpen(false);
      setEditingEntry(null);
      setBaseVersion(saved.version);
      setConflict(null);
      setActionConflict(null);
      setRevisionPreview(null);
      idempotencyKeyRef.current = null;
      onAnnounce(creating ? "Context 已创建。" : "Context 已保存。");
    } catch (error) {
      if (isContextVersionConflict(error) && !creating && selected) {
        await refreshConflict(error, baseVersion ?? selected?.version ?? 0);
      } else {
        setSaveError(messageFor(error));
      }
    } finally {
      setSaving(false);
    }
  }

  async function togglePin(target = selected) {
    if (!target || target.archivedAt) return;
    setSaving(true);
    setActionConflict(null);
    try {
      const saved = await updateProjectContextEntry(target.id, target.version, {
        pinned: !target.pinned,
      });
      applySavedEntry(saved);
      setBaseVersion(saved.version);
      onAnnounce(saved.pinned ? "Context 已置顶。" : "Context 已取消置顶。");
    } catch (error) {
      if (isContextVersionConflict(error)) {
        await refreshStaleAction(error, target.id, "pin", target.version);
      } else setSaveError(messageFor(error));
    } finally {
      setSaving(false);
    }
  }

  async function archiveSelected(target = archiveTarget) {
    if (!target) return;
    setSaving(true);
    setActionConflict(null);
    try {
      const saved = await archiveProjectContextEntry(target.id, target.version);
      setArchiveTarget(null);
      setEditingEntry(null);
      applySavedEntry(saved);
      onAnnounce("Context 已归档，可通过“显示已归档”查看。");
    } catch (error) {
      if (isContextVersionConflict(error)) await refreshStaleAction(error, target.id, "archive", target.version);
      else {
        setArchiveTarget(null);
        setSaveError(messageFor(error));
      }
    } finally {
      setSaving(false);
    }
  }

  async function restoreSelected(target = selected) {
    if (!target) return;
    setSaving(true);
    setActionConflict(null);
    try {
      const saved = await restoreProjectContextEntry(target.id, target.version);
      applySavedEntry(saved);
      setBaseVersion(saved.version);
      onAnnounce("Context 已恢复。");
    } catch (error) {
      if (isContextVersionConflict(error)) await refreshStaleAction(error, target.id, "restore", target.version);
      else setSaveError(messageFor(error));
    } finally {
      setSaving(false);
    }
  }

  async function retryActionConflict() {
    const pending = actionConflict;
    if (!pending) return;
    setActionConflict(null);
    if (pending.action === "pin") await togglePin(pending.latest);
    if (pending.action === "archive") await archiveSelected(pending.latest);
    if (pending.action === "restore") await restoreSelected(pending.latest);
  }

  async function toggleRevisions() {
    if (revisions) {
      revisionSequence.current += 1;
      setRevisions(null);
      setRevisionPreview(null);
      return;
    }
    if (!selected) return;
    const sequence = ++revisionSequence.current;
    setRevisionsLoading(true);
    setSaveError(null);
    try {
      const nextRevisions = await listProjectContextRevisions(selected.id);
      if (sequence === revisionSequence.current) setRevisions(nextRevisions);
    } catch (error) {
      if (sequence === revisionSequence.current) setSaveError(messageFor(error));
    } finally {
      if (sequence === revisionSequence.current) setRevisionsLoading(false);
    }
  }

  function clearFilters() {
    setQuery("");
    setKind("");
    setTag("");
    setPinned("");
    setShowArchived(false);
  }

  function handleMobileBack() {
    if (editorOpen) {
      setSaveError("请先保存或取消当前编辑，草稿仍保留在表单中。");
      onAnnounce("请先保存或取消当前编辑。");
      window.setTimeout(() => titleRef.current?.focus(), 0);
      return;
    }
    setMobileDetail(false);
  }

  const displayEntry = revisionPreview ?? selected;

  return (
    <section className={`context-view${mobileDetail ? " is-mobile-detail" : ""}`} aria-label="项目共享 Context">
      <div className="context-toolbar" aria-label="Context 搜索与筛选">
        <label className={`search-field context-search${query ? " has-value" : ""}`} title="搜索 Context">
          <LinearIcon className="search-icon" name="search" />
          <span className="sr-only">搜索 Context</span>
          <input
            id="context-search"
            type="search"
            disabled={editorOpen}
            value={query}
            maxLength={256}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 Context…"
          />
        </label>
        <label className="context-filter-field">
          <span className="sr-only">按类型筛选</span>
          <select value={kind} disabled={editorOpen} onChange={(event) => setKind(event.target.value as ProjectContextKind | "")}>
            <option value="">全部类型</option>
            {CONTEXT_KINDS.map((value) => <option value={value} key={value}>{KIND_DETAILS[value].label}</option>)}
          </select>
        </label>
        <label className="context-filter-field">
          <span className="sr-only">按标签筛选</span>
          <select value={tag} disabled={editorOpen} onChange={(event) => setTag(event.target.value)}>
            <option value="">全部标签</option>
            {availableTags.map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
        </label>
        <label className="context-filter-field">
          <span className="sr-only">按置顶状态筛选</span>
          <select value={pinned} disabled={editorOpen} onChange={(event) => setPinned(event.target.value as typeof pinned)}>
            <option value="">全部条目</option>
            <option value="true">仅置顶</option>
            <option value="false">未置顶</option>
          </select>
        </label>
        <label className="context-archive-toggle">
          <input type="checkbox" checked={showArchived} disabled={editorOpen} onChange={(event) => setShowArchived(event.target.checked)} />
          <span>显示已归档</span>
        </label>
        {filtersActive && (
          <button className="clear-filter" type="button" aria-label="清除 Context 筛选" title="清除筛选" disabled={editorOpen} onClick={clearFilters}>
            <LinearIcon name="close" />
          </button>
        )}
        <button className="button primary context-toolbar-create" type="button" disabled={editorOpen} onClick={startCreate}>
          <LinearIcon name="plus" />
          新建
        </button>
      </div>

      <div className="context-layout">
        <div className="context-list-pane">
          {loading && entries.length === 0 ? (
            <div className="context-list-loading" aria-label="正在加载 Context" aria-busy="true">
              <span /><span /><span />
            </div>
          ) : loadError && entries.length === 0 ? (
            <div className="page-empty context-empty" role="alert">
              <span className="empty-search" aria-hidden="true"><LinearIcon name="alert" /></span>
              <h2>无法加载 Context</h2>
              <p>{loadError}</p>
              <button className="button secondary" type="button" onClick={() => void loadEntries()}>重试</button>
            </div>
          ) : entries.length === 0 ? (
            <div className="page-empty context-empty">
              <span className="empty-search" aria-hidden="true"><LinearIcon name={filtersActive ? "search" : "dashboard"} /></span>
              <h2>{filtersActive ? "没有匹配的 Context" : "还没有共享上下文"}</h2>
              <p>{filtersActive ? "请更换搜索词或清除筛选。" : "记录稳定需求、决策、约束、风险或交接信息。"}</p>
              <button className="button secondary" type="button" onClick={filtersActive ? clearFilters : startCreate}>
                {filtersActive ? "清除筛选" : "新增 Context 条目"}
              </button>
            </div>
          ) : (
            <>
              {loadError && <div className="context-inline-error" role="alert">刷新失败：{loadError}</div>}
              <div className="context-entry-list" role="list" aria-label="Context 条目">
                {entries.map((entry, index) => (
                  <div key={entry.id} className="context-entry-item" role="listitem">
                    {entry.pinned && (index === 0 || !entries[index - 1]?.pinned) && <h2 className="context-list-heading">置顶</h2>}
                    {!entry.pinned && index > 0 && entries[index - 1]?.pinned && <h2 className="context-list-heading">全部 Context</h2>}
                    <button
                      className={`context-entry-row${entry.id === selectedId ? " is-selected" : ""}${entry.pinned ? " is-pinned" : ""}${entry.archivedAt ? " is-archived" : ""}`}
                      type="button"
                      disabled={editorOpen}
                      aria-current={entry.id === selectedId ? "true" : undefined}
                      onClick={() => openEntry(entry)}
                    >
                      <span className={`context-kind-glyph is-${entry.kind}`} aria-hidden="true"><LinearIcon name={KIND_DETAILS[entry.kind].icon} /></span>
                      <span className="context-row-copy">
                        <span className="context-row-heading">
                          <strong>{entry.title}</strong>
                          {entry.archivedAt && <span className="context-archived-label">已归档</span>}
                        </span>
                        <span className="context-row-summary">{markdownSummary(entry.body)}</span>
                        <span className="context-row-meta">
                          <span>{KIND_DETAILS[entry.kind].label}</span>
                          {entry.tags.slice(0, 3).map((value) => <span className="label-chip" key={value}>{value}</span>)}
                          {entry.tags.length > 3 && <span>+{entry.tags.length - 3}</span>}
                          <span>{entry.authorName}</span>
                          <time dateTime={entry.updatedAt} title={exactTime(entry.updatedAt)}>{relativeTime(entry.updatedAt)}</time>
                          <span>v{entry.version}</span>
                        </span>
                      </span>
                      {entry.pinned && <LinearIcon className="context-row-pin" name="favorite" title="已置顶" />}
                    </button>
                  </div>
                ))}
              </div>
              {nextCursor && (
                <div className="context-load-more">
                  {loadMoreError && <p role="alert">无法加载更多：{loadMoreError}</p>}
                  <button className="button secondary" type="button" disabled={loading || loadingMore} onClick={() => void loadEntries({ append: true, cursor: nextCursor })}>
                    {loadingMore ? "加载中…" : "加载更多"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <article className="context-detail-pane" aria-label={creating ? "新建 Context" : selected ? `Context：${selected.title}` : "Context 详情"}>
          {(selected || creating) ? (
            <div className="context-detail-scroll">
              <header className="context-detail-header">
                <button className="detail-back-button context-mobile-back" type="button" aria-label="返回 Context 列表" onClick={handleMobileBack}>
                  <LinearIcon name="chevronLeft" />
                </button>
                <div>
                  <span>{creating ? "新建 Context" : `v${selected?.version}`}</span>
                  {!creating && selected && <time dateTime={selected.updatedAt}>更新于 {exactTime(selected.updatedAt)}</time>}
                </div>
                {!editorOpen && selected && (
                  <div className="context-detail-actions">
                    {!selected.archivedAt && (
                      <button className={`icon-button${selected.pinned ? " is-active" : ""}`} type="button" aria-label={selected.pinned ? "取消置顶" : "置顶"} aria-pressed={selected.pinned} title={selected.pinned ? "取消置顶" : "置顶"} disabled={saving} onClick={() => void togglePin()}>
                        <LinearIcon name="favorite" />
                      </button>
                    )}
                    <button className="button secondary" type="button" disabled={saving} onClick={() => void toggleRevisions()}>{revisions ? "收起历史" : "版本历史"}</button>
                    {selected.archivedAt ? (
                      <button className="button secondary" type="button" disabled={saving} onClick={() => void restoreSelected()}>恢复</button>
                    ) : (
                      <>
                        <button className="button secondary" type="button" onClick={startEdit}>编辑</button>
                        <button ref={archiveTriggerRef} className="button danger subtle" type="button" disabled={saving} onClick={() => setArchiveTarget(selected)}>归档</button>
                      </>
                    )}
                  </div>
                )}
              </header>

              {saveError && <div className="context-save-error" id="context-form-error" role="alert"><LinearIcon name="alert" />{saveError}</div>}
              {conflict && (
                <div className="context-conflict-banner" role="alert">
                  <LinearIcon name="alert" />
                  <div>
                    <strong>此条目已被更新，你的输入仍保留。</strong>
                    <p>{conflict.latest.authorName} 于 {exactTime(conflict.latest.updatedAt)} 更新了 v{conflict.latest.version}；你开始编辑的是 v{conflict.baseVersion}。</p>
                    <div>
                      <button className="button primary" type="button" disabled={saving} onClick={() => void saveDraft()}>用当前草稿保存到最新版本</button>
                      <button className="button secondary" type="button" onClick={() => {
                        setDraft(draftFromEntry(conflict.latest));
                        setEditorOpen(false);
                        setEditingEntry(null);
                        setConflict(null);
                      }}>放弃草稿并刷新</button>
                    </div>
                  </div>
                  <span className="sr-only">刷新后重试</span>
                </div>
              )}
              {actionConflict && (
                <div className="context-conflict-banner" role="alert">
                  <LinearIcon name="alert" />
                  <div>
                    <strong>操作前条目已被更新，已加载最新状态。</strong>
                    <p>{actionConflict.latest.authorName} 于 {exactTime(actionConflict.latest.updatedAt)} 更新了 v{actionConflict.latest.version}；当前操作基于 v{actionConflict.baseVersion}。</p>
                    <button className="button primary" type="button" disabled={saving} onClick={() => void retryActionConflict()}>刷新状态后重试</button>
                  </div>
                </div>
              )}

              {editorOpen ? (
                <form className="context-editor" aria-describedby={saveError ? "context-form-error" : undefined} onSubmit={(event) => { event.preventDefault(); void saveDraft(); }}>
                  <label className="context-editor-field">
                    <span>标题</span>
                    <input
                      ref={titleRef}
                      type="text"
                      required
                      maxLength={240}
                      value={draft.title}
                      aria-invalid={validationField === "title"}
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, title: event.target.value }));
                        if (validationField === "title") {
                          setValidationField(null);
                          setSaveError(null);
                        }
                      }}
                    />
                  </label>
                  <div className="context-editor-grid">
                    <label className="context-editor-field">
                      <span>类型</span>
                      <select value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as ProjectContextKind }))}>
                        {CONTEXT_KINDS.map((value) => <option value={value} key={value}>{KIND_DETAILS[value].label}</option>)}
                      </select>
                    </label>
                    <label className="context-editor-field">
                      <span>标签</span>
                      <input
                        ref={tagsRef}
                        type="text"
                        value={draft.tags}
                        placeholder="api, phase-1"
                        aria-describedby="context-tags-help"
                        aria-invalid={validationField === "tags"}
                        onChange={(event) => {
                          setDraft((current) => ({ ...current, tags: event.target.value }));
                          if (validationField === "tags") {
                            setValidationField(null);
                            setSaveError(null);
                          }
                        }}
                      />
                      <small id="context-tags-help">用逗号分隔，最多 20 个</small>
                    </label>
                    <label className="context-pin-toggle">
                      <input type="checkbox" checked={draft.pinned} onChange={(event) => setDraft((current) => ({ ...current, pinned: event.target.checked }))} />
                      <span>置顶此条目</span>
                    </label>
                  </div>
                  <label className="context-editor-field context-body-field">
                    <span>正文（Markdown）</span>
                    <textarea
                      ref={bodyRef}
                      value={draft.body}
                      aria-describedby="context-body-counter"
                      aria-invalid={validationField === "body"}
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, body: event.target.value }));
                        if (validationField === "body") {
                          setValidationField(null);
                          setSaveError(null);
                        }
                      }}
                    />
                    <small id="context-body-counter" className={bodyBytes > CONTEXT_BODY_MAX_BYTES ? "is-error" : bodyBytes > CONTEXT_BODY_WARNING_BYTES ? "is-warning" : ""}>{bodyBytes.toLocaleString()} / {CONTEXT_BODY_MAX_BYTES.toLocaleString()} bytes</small>
                  </label>
                  <div className="context-editor-actions">
                    <button className="button secondary" type="button" disabled={saving} onClick={cancelEdit}>取消</button>
                    <button className="button primary" type="submit" disabled={saving || bodyBytes > CONTEXT_BODY_MAX_BYTES}>{saving ? "正在保存…" : creating ? "创建 Context" : "保存更改"}</button>
                  </div>
                </form>
              ) : displayEntry ? (
                <div className="context-detail-content">
                  {revisionPreview && <div className="context-history-preview-heading"><strong>历史预览 · v{revisionPreview.version}</strong><button type="button" onClick={() => setRevisionPreview(null)}>关闭预览</button></div>}
                  <h1>{displayEntry.title}</h1>
                  <div className="context-detail-badges">
                    <span className={`context-kind-badge is-${displayEntry.kind}`}><LinearIcon name={KIND_DETAILS[displayEntry.kind].icon} />{KIND_DETAILS[displayEntry.kind].label}</span>
                    {displayEntry.tags.map((value) => <span className="label-chip" key={value}>{value}</span>)}
                    {"pinned" in displayEntry && displayEntry.pinned && <span className="context-pinned-badge"><LinearIcon name="favorite" />已置顶</span>}
                    {"archivedAt" in displayEntry && displayEntry.archivedAt && <span className="context-archived-label">已归档</span>}
                  </div>
                  {displayEntry.body ? <ContextMarkdown value={displayEntry.body} /> : <p className="context-no-body">无正文</p>}
                </div>
              ) : null}

              {selected && !creating && (
                <aside className="context-properties" aria-label="Context 属性">
                  <dl>
                    <div><dt>作者</dt><dd>{selected.authorName}<small>{selected.authorId}</small></dd></div>
                    <div><dt>来源</dt><dd>{sourceLabel(selected)}</dd></div>
                    {visibleSourceThreadId && <div><dt>来源线程标识</dt><dd><code>{visibleSourceThreadId}</code><small>仅用于标记来源</small></dd></div>}
                    <div><dt>创建</dt><dd>{exactTime(selected.createdAt)}</dd></div>
                    <div><dt>更新</dt><dd>{exactTime(selected.updatedAt)}</dd></div>
                    <div><dt>版本</dt><dd>v{selected.version}</dd></div>
                  </dl>
                  {(revisionsLoading || revisions) && (
                    <section className="context-revisions" aria-label="版本历史" aria-busy={revisionsLoading}>
                      <h2>版本历史</h2>
                      {revisionsLoading ? <p>正在加载…</p> : revisions?.map((item) => (
                        <button type="button" className={revisionPreview?.id === item.id ? "is-selected" : ""} key={item.id} onClick={() => setRevisionPreview(item)}>
                          <strong>v{item.version} · {item.title}</strong>
                          <span>{KIND_DETAILS[item.kind].label} · {item.authorName}</span>
                          <time dateTime={item.createdAt}>{exactTime(item.createdAt)}</time>
                        </button>
                      ))}
                    </section>
                  )}
                </aside>
              )}
            </div>
          ) : (
            <div className="context-detail-empty">
              <LinearIcon name="dashboard" />
              <h2>选择一条 Context</h2>
              <p>在这里查看正文、来源和版本历史。</p>
            </div>
          )}
        </article>
      </div>

      {archiveTarget && (
        <div className="delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saving) {
            setArchiveTarget(null);
            window.setTimeout(() => archiveTriggerRef.current?.focus(), 0);
          }
        }}>
          <div ref={archiveDialogRef} className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="archive-context-title">
            <h2 id="archive-context-title">归档这条 Context？</h2>
            <p>“{archiveTarget.title}” 将从默认列表移除，之后可在归档筛选中恢复。</p>
            <div>
              <button className="button secondary" type="button" disabled={saving} onClick={() => {
                setArchiveTarget(null);
                window.setTimeout(() => archiveTriggerRef.current?.focus(), 0);
              }}>取消</button>
              <button ref={archiveConfirmRef} className="button danger" type="button" disabled={saving} onClick={() => void archiveSelected()}>{saving ? "归档中…" : "归档"}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
