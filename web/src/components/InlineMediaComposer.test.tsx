import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type KeyboardEventHandler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerCandidatesResponse, Task } from "../types";
import {
  createInlineMediaSegments,
  InlineMediaComposer,
  serializeInlineMedia,
  type InlineMediaSegment,
} from "./InlineMediaComposer";

const api = vi.hoisted(() => ({
  getCandidates: vi.fn(),
}));

vi.mock("../api", () => ({
  attachmentContentUrl: () => "",
  resolvePersistedAttachmentUrl: (url: string) => url,
  getAiChatComposerCandidates: api.getCandidates,
}));

const EMPTY_TASKS: readonly Task[] = [];

function TestComposer({
  initial,
  mentionTasks = EMPTY_TASKS,
  onKeyDown,
  projectId = "project-1",
}: {
  initial: string;
  mentionTasks?: readonly Task[];
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  projectId?: string;
}) {
  const [segments, setSegments] = useState<InlineMediaSegment[]>(() => (
    createInlineMediaSegments(initial, mentionTasks)
  ));
  return (
    <>
      <InlineMediaComposer
        segments={segments}
        mentionTasks={mentionTasks}
        referenceTasks={mentionTasks}
        completionContext={{ projectId, surface: "issue-description" }}
        placeholder="Description"
        ariaLabel="Description"
        onChange={setSegments}
        onError={() => {}}
        onKeyDown={onKeyDown}
      />
      <output data-testid="serialized">{serializeInlineMedia(segments)}</output>
    </>
  );
}

function placeCaretAtEnd(editor: HTMLElement) {
  const text = editor.querySelector(".inline-media-text")?.firstChild;
  if (!(text instanceof Text)) throw new Error("Expected an inline text node");
  const range = document.createRange();
  range.setStart(text, text.length);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretAtRootEnd(editor: HTMLElement) {
  const range = document.createRange();
  range.setStart(editor, editor.childNodes.length);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function response(candidates: ComposerCandidatesResponse["candidates"]): ComposerCandidatesResponse {
  return {
    contractVersion: "composer.v1",
    revision: "revision-1",
    candidates,
    sources: [],
  };
}

describe("InlineMediaComposer completion references", () => {
  beforeEach(() => {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(20, 20, 1, 18),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    api.getCandidates.mockReset();
  });

  it("round trips only strict v1 Skill and Agent markers as durable atoms", () => {
    const value = [
      "before ",
      "[$Manage Taskboard](taskboard://composer-reference/v1/skill/bWFuYWdlLXRhc2tib2FyZA)",
      " and ",
      "[@任務總管](taskboard://composer-reference/v1/agent/bWFzdGVy)",
      " after",
    ].join("");
    const segments = createInlineMediaSegments(value);

    expect(segments.some((segment) => segment.type === "skill-reference")).toBe(true);
    expect(segments.some((segment) => segment.type === "agent-reference")).toBe(true);
    expect(serializeInlineMedia(segments)).toBe(value);

    for (const legacy of ["$Manage Taskboard", "@任務總管", "[任務總管](subagent://master)"]) {
      expect(createInlineMediaSegments(legacy).every((segment) => segment.type === "text")).toBe(true);
    }
    const unsupported = createInlineMediaSegments(
      "[$Future](taskboard://composer-reference/v2/skill/bWFuYWdlLXRhc2tib2FyZA)",
    );
    expect(unsupported.some((segment) => segment.type === "unsupported-reference")).toBe(true);
    expect(serializeInlineMedia(unsupported)).toBe(
      "[$Future](taskboard://composer-reference/v2/skill/bWFuYWdlLXRhc2tib2FyZA)",
    );
  });

  it("keeps service candidates and Taskboard issues in separate groups with one keyboard index", async () => {
    const issue = {
      id: "task-1",
      projectId: "project-1",
      identifier: "LOCAL-1",
      externalKey: "LOCAL-1",
      title: "Manage Composer issue",
    } as Task;
    api.getCandidates.mockResolvedValue(response([{
      kind: "agent",
      trigger: "@",
      candidateRef: "agent:master",
      label: "任務總管",
      description: "Master agent",
      group: "Agents",
      groupOrder: 1,
      itemOrder: 1,
      selectable: true,
      persistence: {
        format: "taskboard.composer-reference.v1",
        kind: "agent",
        referenceKey: "bWFzdGVy",
        markdown: "[@任務總管](taskboard://composer-reference/v1/agent/bWFzdGVy)",
      },
    }]));
    render(<TestComposer initial="@ma" mentionTasks={[issue]} />);
    const editor = screen.getByRole("textbox", { name: "Description" });
    placeCaretAtEnd(editor);
    fireEvent.keyUp(editor, { key: "a" });

    expect(await screen.findByRole("option", { name: /任務總管/ })).toBeTruthy();
    expect(screen.getByText("Agents")).toBeTruthy();
    expect(screen.getByText("Taskboard issues")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getAllByRole("option")[0].textContent).toContain("LOCAL-1");
    expect(screen.getByRole("option", { name: /LOCAL-1/ }).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(editor, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /任務總管/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(editor, { key: "Tab" });

    await waitFor(() => expect(screen.getByTestId("serialized").textContent).toBe(
      "[@任務總管](taskboard://composer-reference/v1/agent/bWFzdGVy) ",
    ));
  });

  it("opens and inserts an Agent completion from a root boundary after a persisted image", async () => {
    api.getCandidates.mockResolvedValue(response([{
      kind: "agent",
      trigger: "@",
      candidateRef: "agent:master",
      label: "任務總管",
      description: "Master agent",
      group: "Agents",
      groupOrder: 1,
      itemOrder: 1,
      selectable: true,
      persistence: {
        format: "taskboard.composer-reference.v1",
        kind: "agent",
        referenceKey: "bWFzdGVy",
        markdown: "[@任務總管](taskboard://composer-reference/v1/agent/bWFzdGVy)",
      },
    }]));
    render(<TestComposer initial="![proof](api/attachments/attachment-1/content) E2 @ma" />);
    const editor = screen.getByRole("textbox", { name: "Description" });
    placeCaretAtRootEnd(editor);
    fireEvent.keyUp(editor, { key: "a" });

    expect(await screen.findByRole("option", { name: /任務總管/ })).toBeTruthy();
    expect(api.getCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "@", query: "ma" }),
      expect.any(AbortSignal),
    );
    fireEvent.keyDown(editor, { key: "Tab" });

    await waitFor(() => expect(screen.getByTestId("serialized").textContent).toBe(
      "![proof](api/attachments/attachment-1/content) E2 "
      + "[@任務總管](taskboard://composer-reference/v1/agent/bWFzdGVy) ",
    ));
  });

  it("opens and inserts a Slash completion from a root boundary after a persisted image", async () => {
    api.getCandidates.mockResolvedValue(response([{
      kind: "slashAction",
      trigger: "/",
      candidateRef: "slash:review",
      label: "/review",
      description: "Review changes",
      group: "Slash commands",
      groupOrder: 1,
      itemOrder: 1,
      selectable: true,
      command: "/review",
      dispatch: { type: "client", handlerId: "review" },
      selection: { type: "insertText", text: "/review " },
    }]));
    render(<TestComposer initial="![proof](api/attachments/attachment-1/content) /rev" />);
    const editor = screen.getByRole("textbox", { name: "Description" });
    placeCaretAtRootEnd(editor);
    fireEvent.keyUp(editor, { key: "v" });

    expect(await screen.findByRole("option", { name: /review/i })).toBeTruthy();
    expect(api.getCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "/", query: "rev" }),
      expect.any(AbortSignal),
    );
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(screen.getByTestId("serialized").textContent).toBe(
      "![proof](api/attachments/attachment-1/content) /review ",
    ));
  });

  it("keeps non-contiguous groups unique, source diagnostics non-selectable, and active identity stable", async () => {
    const agent = (id: string, label: string) => ({
      kind: "agent" as const,
      trigger: "@" as const,
      candidateRef: `agent:${id}`,
      label,
      description: null,
      group: "Agents",
      groupOrder: 1,
      itemOrder: 1,
      selectable: true as const,
      persistence: {
        format: "taskboard.composer-reference.v1" as const,
        kind: "agent" as const,
        referenceKey: btoa(id).replace(/=+$/, ""),
        markdown: `[@${label}](taskboard://composer-reference/v1/agent/${btoa(id).replace(/=+$/, "")})`,
      },
    });
    const first = agent("first", "First agent");
    const second = agent("second", "Second agent");
    const skill = {
      kind: "skill" as const,
      trigger: "@" as const,
      candidateRef: "skill:middle",
      label: "Middle skill",
      description: null,
      group: "Skills",
      groupOrder: 0,
      itemOrder: 1,
      selectable: true as const,
      persistence: {
        format: "taskboard.composer-reference.v1" as const,
        kind: "skill" as const,
        referenceKey: "bWlkZGxl",
        markdown: "[$Middle skill](taskboard://composer-reference/v1/skill/bWlkZGxl)",
      },
    };
    const withDiagnostics = (candidates: ComposerCandidatesResponse["candidates"]) => ({
      ...response(candidates),
      sources: [{ kind: "plugins" as const, state: "unsupported" as const, reasonCode: "EXPERIMENTAL_SOURCE_NOT_ALLOWED" as const }],
    });
    api.getCandidates
      .mockResolvedValueOnce(withDiagnostics([first, skill, second]))
      .mockResolvedValueOnce(withDiagnostics([second, skill, first]));
    const view = render(<TestComposer initial="@" projectId="project-1" />);
    const editor = screen.getByRole("textbox", { name: "Description" });
    placeCaretAtEnd(editor);
    fireEvent.keyUp(editor, { key: "@" });
    await screen.findByRole("option", { name: /First agent/ });
    expect(screen.getAllByText("Agents")).toHaveLength(1);
    expect(screen.queryByText(/EXPERIMENTAL_SOURCE_NOT_ALLOWED/)).toBeNull();
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Second agent/ }).getAttribute("aria-selected")).toBe("true");

    view.rerender(<TestComposer initial="@" projectId="project-2" />);
    await waitFor(() => expect(
      screen.getByRole("option", { name: /Second agent/ }).getAttribute("aria-selected"),
    ).toBe("true"));

    api.getCandidates.mockResolvedValueOnce(withDiagnostics([]));
    view.rerender(<TestComposer initial="@x" projectId="project-3" />);
    placeCaretAtEnd(screen.getByRole("textbox", { name: "Description" }));
    fireEvent.keyUp(screen.getByRole("textbox", { name: "Description" }), { key: "x" });
    expect(await screen.findByText(/EXPERIMENTAL_SOURCE_NOT_ALLOWED/)).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("uses Slash insertText without dispatch and lets IME or empty Enter reach the parent", async () => {
    const parentKeyDown = vi.fn();
    api.getCandidates.mockResolvedValue(response([{
      kind: "slashAction",
      trigger: "/",
      candidateRef: "slash:review",
      label: "/review",
      description: "Review changes",
      group: "Slash commands",
      groupOrder: 1,
      itemOrder: 1,
      selectable: true,
      command: "/review",
      dispatch: { type: "client", handlerId: "must-not-run" },
      selection: { type: "insertText", text: "/review " },
    }]));
    render(<TestComposer initial="/rev" onKeyDown={parentKeyDown} />);
    const editor = screen.getByRole("textbox", { name: "Description" });
    placeCaretAtEnd(editor);
    fireEvent.keyUp(editor, { key: "v" });
    await screen.findByRole("option", { name: /review/i });

    fireEvent.keyDown(editor, { key: "Enter", keyCode: 229, isComposing: true });
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("serialized").textContent).toBe("/rev");

    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("serialized").textContent).toBe("/review "));

    fireEvent.keyDown(editor, { key: "Enter" });
    expect(parentKeyDown).toHaveBeenCalledTimes(2);
  });

  it("closes the menu with Escape without changing the text", async () => {
    api.getCandidates.mockResolvedValue(response([]));
    render(<TestComposer initial="@missing" />);
    const editor = screen.getByRole("textbox", { name: "Description" });
    placeCaretAtEnd(editor);
    fireEvent.keyUp(editor, { key: "g" });
    await screen.findByText("No matching completions");

    fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("serialized").textContent).toBe("@missing");
  });

  it("does not reopen a dismissed query when an aborted response resolves late", async () => {
    let resolveRequest!: (value: ComposerCandidatesResponse) => void;
    api.getCandidates.mockReturnValue(new Promise<ComposerCandidatesResponse>((resolve) => {
      resolveRequest = resolve;
    }));
    render(<TestComposer initial="@late" />);
    const editor = screen.getByRole("textbox", { name: "Description" });
    placeCaretAtEnd(editor);
    fireEvent.keyUp(editor, { key: "e" });
    expect(await screen.findByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(editor, { key: "Escape" });
    resolveRequest(response([]));
    await Promise.resolve();

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("serialized").textContent).toBe("@late");
  });
});
