import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  createDocumentFolder,
  createProjectDocument,
  listDocumentAttachments,
  listDocumentFolders,
  listDocumentRevisions,
  listProjectDocuments,
  resolveTaskboardUrl,
  updateProjectDocument,
  uploadDocumentAttachment,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type {
  DocumentAttachment,
  DocumentFolder,
  DocumentRevision,
  Project,
  ProjectDocument,
  ProjectDocumentType,
} from "../types";
import { MarkdownDocument } from "./MarkdownDocument";
import { LinearIcon } from "./LinearIcon";
import { PlusIcon } from "./SemanticIcons";
import "./ProjectLibrary.css";

type LibraryError = string | readonly [string, string];

interface ProjectLibraryProps {
  project: Project;
  revision: number;
  onError?: (error: LibraryError | null) => void;
}

const DOCUMENT_TYPES: Array<{ value: ProjectDocumentType; zh: string; en: string }> = [
  { value: "general", zh: "项目资料", en: "Project docs" },
  { value: "spec", zh: "SPEC", en: "SPEC" },
  { value: "plan", zh: "Plan", en: "Plan" },
  { value: "tasks", zh: "Tasks", en: "Tasks" },
  { value: "run-report", zh: "执行报告", en: "Run report" },
  { value: "test-report", zh: "测试报告", en: "Test report" },
];

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function documentTypeLabel(type: ProjectDocumentType, language: "zh" | "en") {
  const option = DOCUMENT_TYPES.find((candidate) => candidate.value === type);
  return language === "zh" ? option?.zh ?? type : option?.en ?? type;
}

export function ProjectLibrary({ project, revision, onError }: ProjectLibraryProps) {
  const { language, text } = useTaskboardI18n();
  const [folders, setFolders] = useState<DocumentFolder[]>([]);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProjectDocument | null>(null);
  const [revisions, setRevisions] = useState<DocumentRevision[]>([]);
  const [attachments, setAttachments] = useState<DocumentAttachment[]>([]);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<ProjectDocumentType | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [createMode, setCreateMode] = useState<"folder" | "document" | null>(null);
  const [createName, setCreateName] = useState("");
  const [createType, setCreateType] = useState<ProjectDocumentType>("general");
  const [creating, setCreating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextFolders, nextDocuments] = await Promise.all([
        listDocumentFolders(project.id),
        listProjectDocuments(project.id, {
          ...(query.trim() ? {} : { folderId: currentFolderId }),
          query: query.trim() || undefined,
          type: typeFilter,
        }),
      ]);
      setFolders(nextFolders);
      setDocuments(nextDocuments);
      setSelected((current) => (
        current ? nextDocuments.find((document) => document.id === current.id) ?? current : null
      ));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      onError?.(message);
    } finally {
      setLoading(false);
    }
  }, [currentFolderId, onError, project.id, query, typeFilter]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary, revision]);

  useEffect(() => {
    if (!selected) {
      setRevisions([]);
      setAttachments([]);
      return;
    }
    setDraft(selected.content);
    Promise.all([
      listDocumentRevisions(selected.id),
      listDocumentAttachments(selected.id),
    ]).then(([nextRevisions, nextAttachments]) => {
      setRevisions(nextRevisions);
      setAttachments(nextAttachments);
    }).catch((caught) => {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
    });
  }, [selected?.id, selected?.version]);

  const childFolders = useMemo(
    () => folders.filter((folder) => folder.parentId === currentFolderId),
    [currentFolderId, folders],
  );

  const breadcrumbs = useMemo(() => {
    const result: DocumentFolder[] = [];
    let id = currentFolderId;
    const visited = new Set<string>();
    while (id && !visited.has(id)) {
      visited.add(id);
      const folder = folders.find((candidate) => candidate.id === id);
      if (!folder) break;
      result.unshift(folder);
      id = folder.parentId;
    }
    return result;
  }, [currentFolderId, folders]);

  async function submitCreate() {
    const name = createName.trim();
    if (!name || !createMode || creating) return;
    setCreating(true);
    setError(null);
    try {
      if (createMode === "folder") {
        await createDocumentFolder(project.id, name, currentFolderId);
      } else {
        const document = await createProjectDocument(project.id, {
          folderId: currentFolderId,
          title: name,
          type: createType,
          content: "",
        });
        setSelected(document);
        setEditing(true);
      }
      setCreateMode(null);
      setCreateName("");
      await loadLibrary();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      onError?.(message);
    } finally {
      setCreating(false);
    }
  }

  async function saveDocument() {
    if (!selected || saving || draft === selected.content) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateProjectDocument(selected.id, {
        content: draft,
        version: selected.version,
      });
      setSelected(updated);
      setEditing(false);
      await loadLibrary();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "VERSION_CONFLICT") {
        setError(text(
          "文档已被其他成员或 Agent 更新。你的草稿已保留，请复制后刷新再合并。",
          "This document changed elsewhere. Your draft is preserved; refresh and merge it.",
        ));
      } else {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        onError?.(message);
      }
    } finally {
      setSaving(false);
    }
  }

  async function uploadFile(file: File) {
    if (!selected) return;
    setError(null);
    try {
      const attachment = await uploadDocumentAttachment(selected.id, file);
      setAttachments((current) => [...current, attachment]);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      onError?.(message);
    }
  }

  return (
    <div className="project-library">
      <div className="library-toolbar">
        <div className="library-actions">
          <button type="button" className="button secondary" onClick={() => setCreateMode("folder")}>
            <PlusIcon size={14} /> {text("新建文件夹", "New folder")}
          </button>
          <button type="button" className="button primary" onClick={() => setCreateMode("document")}>
            <PlusIcon size={14} /> {text("新建文档", "New document")}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!selected}
            title={selected ? undefined : text("先选择一份文档", "Select a document first")}
            onClick={() => fileInputRef.current?.click()}
          >
            {text("上传文件", "Upload file")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadFile(file);
              event.target.value = "";
            }}
          />
        </div>
        <div className="library-filters">
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as ProjectDocumentType | "")}>
            <option value="">{text("全部类型", "All types")}</option>
            {DOCUMENT_TYPES.map((option) => (
              <option key={option.value} value={option.value}>{language === "zh" ? option.zh : option.en}</option>
            ))}
          </select>
          <label className="library-search">
            <LinearIcon name="search" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={text("搜索文件或正文…", "Search files or content…")}
            />
          </label>
        </div>
      </div>

      {createMode && (
        <form className="library-create" onSubmit={(event) => { event.preventDefault(); void submitCreate(); }}>
          <input
            autoFocus
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            placeholder={createMode === "folder" ? text("文件夹名称", "Folder name") : text("文档标题", "Document title")}
          />
          {createMode === "document" && (
            <select value={createType} onChange={(event) => setCreateType(event.target.value as ProjectDocumentType)}>
              {DOCUMENT_TYPES.map((option) => (
                <option key={option.value} value={option.value}>{language === "zh" ? option.zh : option.en}</option>
              ))}
            </select>
          )}
          <button type="submit" className="button primary" disabled={!createName.trim() || creating}>
            {creating ? text("创建中…", "Creating…") : text("创建", "Create")}
          </button>
          <button type="button" className="button ghost" onClick={() => setCreateMode(null)}>
            {text("取消", "Cancel")}
          </button>
        </form>
      )}

      {error && <div className="project-readme-alert error library-alert" role="alert"><LinearIcon name="alert" />{error}</div>}

      <div className={`library-layout${selected ? " has-detail" : ""}`}>
        <section className="library-browser" aria-label={text("项目资料库", "Project library")}>
          <nav className="library-breadcrumbs" aria-label={text("资料库路径", "Library path")}>
            <button type="button" onClick={() => setCurrentFolderId(null)}>{text("资料库", "Library")}</button>
            {breadcrumbs.map((folder) => (
              <span key={folder.id}><i>/</i><button type="button" onClick={() => setCurrentFolderId(folder.id)}>{folder.name}</button></span>
            ))}
          </nav>
          <div className="library-table" role="table">
            <div className="library-row library-head" role="row">
              <span>{text("名称", "Name")}</span>
              <span>{text("类型", "Type")}</span>
              <span>{text("更新人", "Updated by")}</span>
              <span>{text("更新时间", "Updated")}</span>
              <span>{text("大小", "Size")}</span>
            </div>
            {loading ? (
              <div className="library-empty">{text("正在加载资料库…", "Loading library…")}</div>
            ) : (
              <>
                {!query && childFolders.map((folder) => (
                  <button className="library-row" role="row" type="button" key={folder.id} onClick={() => setCurrentFolderId(folder.id)}>
                    <span className="library-name"><b className="library-icon folder">▰</b>{folder.name}</span>
                    <span>{text("文件夹", "Folder")}</span><span>—</span><span>{shortDate(folder.updatedAt)}</span><span>—</span>
                  </button>
                ))}
                {documents.map((document) => (
                  <button
                    className={`library-row${selected?.id === document.id ? " selected" : ""}`}
                    role="row"
                    type="button"
                    key={document.id}
                    onClick={() => { setSelected(document); setEditing(false); }}
                  >
                    <span className="library-name"><b className="library-icon markdown">M</b>{document.title}</span>
                    <span>{documentTypeLabel(document.type, language)}</span>
                    <span>{document.updatedBy.name}</span>
                    <span>{shortDate(document.updatedAt)}</span>
                    <span>{fileSize(document.size)}</span>
                  </button>
                ))}
                {childFolders.length === 0 && documents.length === 0 && (
                  <div className="library-empty">{text("这里还没有资料", "No files here yet")}</div>
                )}
              </>
            )}
          </div>
        </section>

        {selected && (
          <aside className="library-detail" aria-label={text("文档详情", "Document details")}>
            <header>
              <div><h2>{selected.title}</h2><p>{documentTypeLabel(selected.type, language)} · v{selected.version} · {selected.updatedBy.name}</p></div>
              <button type="button" className="icon-button" aria-label={text("关闭详情", "Close details")} onClick={() => setSelected(null)}>×</button>
            </header>
            <div className="library-detail-actions">
              {editing ? (
                <>
                  <button type="button" className="button primary" disabled={saving} onClick={() => void saveDocument()}>{saving ? text("保存中…", "Saving…") : text("保存", "Save")}</button>
                  <button type="button" className="button secondary" onClick={() => { setDraft(selected.content); setEditing(false); }}>{text("取消", "Cancel")}</button>
                </>
              ) : (
                <button type="button" className="button primary" onClick={() => setEditing(true)}>{text("编辑 Markdown", "Edit Markdown")}</button>
              )}
              <a className="button secondary" href={resolveTaskboardUrl(`/api/documents/${encodeURIComponent(selected.id)}/export`)} download>{text("导出 .md", "Export .md")}</a>
            </div>
            <div className="library-document-body">
              {editing
                ? <textarea aria-label={text("Markdown 正文", "Markdown content")} value={draft} onChange={(event) => setDraft(event.target.value)} />
                : selected.content
                  ? <MarkdownDocument value={selected.content} />
                  : <p className="library-empty-copy">{text("点击编辑开始编写 Markdown。", "Choose edit to start writing Markdown.")}</p>}
            </div>
            {attachments.length > 0 && (
              <section className="library-meta-section"><h3>{text("附件", "Attachments")}</h3>{attachments.map((attachment) => (
                <a key={attachment.id} href={resolveTaskboardUrl(`/api/document-attachments/${encodeURIComponent(attachment.id)}/content`)} download>{attachment.filename}<small>{fileSize(attachment.size)}</small></a>
              ))}</section>
            )}
            <section className="library-meta-section"><h3>{text("版本历史", "Version history")}</h3>{revisions.map((item) => (
              <div className="library-revision" key={item.id}><span>v{item.version}</span><span>{item.updatedBy.name}</span><time>{shortDate(item.createdAt)}</time></div>
            ))}</section>
          </aside>
        )}
      </div>
    </div>
  );
}
