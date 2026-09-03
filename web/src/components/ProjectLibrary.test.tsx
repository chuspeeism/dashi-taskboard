import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskboardLanguageProvider } from "../i18n";
import type { Project, ProjectDocument } from "../types";
import { ProjectLibrary } from "./ProjectLibrary";

const api = vi.hoisted(() => ({
  createDocumentFolder: vi.fn(),
  createProjectDocument: vi.fn(),
  listDocumentAttachments: vi.fn(),
  listDocumentFolders: vi.fn(),
  listDocumentRevisions: vi.fn(),
  listProjectDocuments: vi.fn(),
  updateProjectDocument: vi.fn(),
  uploadDocumentAttachment: vi.fn(),
}));

vi.mock("../api", () => ({
  ...api,
  ApiError: class ApiError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } },
  resolvePersistedAttachmentUrl: (url: string) => url,
  resolveTaskboardUrl: (url: string) => url,
}));

const project: Project = {
  id: "atlas",
  name: "Atlas Workbench",
  workspacePath: null,
  source: "local",
  labels: [],
  issueCount: 0,
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
};

const document: ProjectDocument = {
  id: "doc-1",
  projectId: "atlas",
  folderId: null,
  title: "服务器连接信息",
  type: "general",
  status: "draft",
  content: "# 服务器\n\nhost: 10.0.0.8",
  size: 31,
  version: 1,
  isProjectOverview: false,
  taskIds: [],
  createdBy: { type: "user", id: "owner", name: "老板", avatarUrl: null },
  updatedBy: { type: "user", id: "owner", name: "老板", avatarUrl: null },
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
};

describe("ProjectLibrary", () => {
  beforeEach(() => {
    api.listDocumentFolders.mockResolvedValue([]);
    api.listProjectDocuments.mockResolvedValue([document]);
    api.listDocumentRevisions.mockResolvedValue([{ ...document, documentId: document.id, id: "doc-1:v1" }]);
    api.listDocumentAttachments.mockResolvedValue([]);
    api.updateProjectDocument.mockResolvedValue({
      ...document,
      content: "# 服务器\n\nhost: 10.0.0.9",
      version: 2,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists Chinese Markdown documents and saves with the current version", async () => {
    render(
      <TaskboardLanguageProvider language="zh">
        <ProjectLibrary project={project} revision={0} />
      </TaskboardLanguageProvider>,
    );

    const row = await screen.findByRole("row", { name: /服务器连接信息/ });
    fireEvent.click(row);
    expect(await screen.findByText("项目资料 · v1 · 老板")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "编辑 Markdown" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Markdown 正文" }), {
      target: { value: "# 服务器\n\nhost: 10.0.0.9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(api.updateProjectDocument).toHaveBeenCalledWith("doc-1", {
      content: "# 服务器\n\nhost: 10.0.0.9",
      version: 1,
    }));
  });

  it("creates a Chinese folder in the current library path", async () => {
    api.createDocumentFolder.mockResolvedValue({
      id: "folder-1",
      projectId: "atlas",
      parentId: null,
      name: "项目资料",
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
    });
    render(
      <TaskboardLanguageProvider language="zh">
        <ProjectLibrary project={project} revision={0} />
      </TaskboardLanguageProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /新建文件夹/ }));
    fireEvent.change(screen.getByPlaceholderText("文件夹名称"), { target: { value: "项目资料" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(api.createDocumentFolder).toHaveBeenCalledWith("atlas", "项目资料", null));
  });
});
