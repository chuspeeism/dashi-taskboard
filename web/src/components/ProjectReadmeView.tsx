import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  getProjectReadme,
  saveProjectReadme,
  uploadProjectReadmeAttachment,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type { Project, ProjectReadme, Task, TaskRelationSummary } from "../types";
import { DescriptionDocument } from "./DescriptionDocument";
import {
  createInlineMediaSegments,
  InlineMediaComposer,
  inlineMediaImages,
  resolveInlineMediaMarkdown,
  serializeInlineMedia,
  type InlineMediaComposerHandle,
  type InlineMediaSegment,
} from "./InlineMediaComposer";
import { LinearIcon } from "./LinearIcon";
import "./ProjectReadmeView.css";

type ProjectReadmeError = string | readonly [string, string];

interface ProjectReadmeViewProps {
  project: Project;
  tasks: Task[];
  referenceTasks: Task[];
  revision: number;
  onOpenTask: (task: TaskRelationSummary) => void;
  onError?: (error: ProjectReadmeError | null) => void;
}

export function ProjectReadmeView({
  project,
  tasks,
  referenceTasks,
  revision,
  onOpenTask,
  onError,
}: ProjectReadmeViewProps) {
  const { text } = useTaskboardI18n();
  const [readme, setReadme] = useState<ProjectReadme | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRequest, setLoadRequest] = useState(0);
  const [editing, setEditing] = useState(false);
  const [segments, setSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments("", referenceTasks),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const composerRef = useRef<InlineMediaComposerHandle>(null);

  useEffect(() => {
    if (editing) return;
    let active = true;
    setSaveError(null);
    setLoadError(null);

    getProjectReadme(project.id)
      .then((data) => {
        if (!active) return;
        setReadme(data);
        setSegments(createInlineMediaSegments(data.content, referenceTasks));
      })
      .catch((err) => {
        if (!active) return;
        const message = err instanceof Error ? err.message : String(err);
        setLoadError(message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [editing, loadRequest, project.id, revision]);

  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  }, [editing]);

  function startEditing() {
    if (!readme) return;
    setSegments(createInlineMediaSegments(readme.content, referenceTasks));
    setEditing(true);
    setSaveError(null);
  }

  function cancelEditing() {
    setSegments(createInlineMediaSegments(readme?.content ?? "", referenceTasks));
    setEditing(false);
    setSaveError(null);
  }

  async function save() {
    if (saving || !readme) return;
    const draftContent = serializeInlineMedia(segments);
    const inlineImages = inlineMediaImages(segments);
    if (draftContent === readme.content && inlineImages.length === 0) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setSaveError(null);
    onError?.(null);

    try {
      const uploaded = await Promise.all(
        inlineImages.map((image) => uploadProjectReadmeAttachment(project.id, image.file)),
      );
      const resolvedContent = resolveInlineMediaMarkdown(
        draftContent,
        inlineImages,
        uploaded,
      );
      const updated = await saveProjectReadme(project.id, resolvedContent, readme.version);
      setReadme(updated);
      setSegments(createInlineMediaSegments(updated.content, referenceTasks));
      setEditing(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "VERSION_CONFLICT") {
        setSaveError(text(
          "專案文件已被其他協作者或 Agent 更新，請重新整理後重試。",
          "Project Docs were modified elsewhere. Please refresh and try again.",
        ));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setSaveError(message);
        onError?.(message);
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="project-readme-loading">
        <div className="project-readme-spinner" />
        <p>{text("正在載入專案文件…", "Loading Project Docs…")}</p>
      </div>
    );
  }

  if (loadError && !readme) {
    return (
      <div className="project-readme-loading" role="alert">
        <p>{loadError}</p>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setLoading(true);
            setLoadRequest((current) => current + 1);
          }}
        >
          {text("重試", "Try again")}
        </button>
      </div>
    );
  }

  const content = readme?.content ?? "";

  return (
    <div className="project-readme-container">
      <div className="project-readme-content">
        {saveError && (
          <div className="project-readme-alert error" role="alert">
            <LinearIcon name="alert" />
            <span>{saveError}</span>
          </div>
        )}

        {loadError && !editing && (
          <div className="project-readme-alert error" role="alert">
            <LinearIcon name="alert" />
            <span>{loadError}</span>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setLoading(true);
                setLoadRequest((current) => current + 1);
              }}
            >
              {text("重試", "Try again")}
            </button>
          </div>
        )}

        {editing ? (
          <div
            className="issue-description-composer"
            onBlur={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              void save();
            }}
          >
            <InlineMediaComposer
              ref={composerRef}
              segments={segments}
              mentionTasks={tasks}
              referenceTasks={referenceTasks}
              completionContext={{
                projectId: project.id,
                surface: "issue-description",
              }}
              placeholder={text("新增說明...", "Add notes...")}
              ariaLabel={text("專案文件", "Project Docs")}
              disabled={saving}
              onChange={setSegments}
              onError={(message) => onError?.(message)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelEditing();
                }
              }}
            />
          </div>
        ) : (
          <div
            className={`issue-description-read${content ? "" : " empty"}`}
            role="button"
            tabIndex={0}
            aria-label={text("編輯專案文件", "Edit Project Docs")}
            onClick={() => {
              if (window.getSelection()?.isCollapsed === false) return;
              startEditing();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                startEditing();
              }
            }}
          >
            {content
              ? <DescriptionDocument
                  value={content}
                  referenceTasks={referenceTasks}
                  onOpenTask={onOpenTask}
                />
              : text("新增說明...", "Add notes...")}
          </div>
        )}
      </div>
    </div>
  );
}
