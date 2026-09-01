# In Review Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit In Review acceptance surface where users can complete an issue or save feedback and continue its exact bound Codex task without creating a new task.

**Architecture:** Keep Taskboard persistence in `TaskDetail` and native Codex messaging in the existing authenticated iframe-to-launcher bridge. A return action saves the comment, re-reads the issue, asks the launcher to start one turn on the saved host/thread, and only after a confirmed turn updates the issue to `in_progress`; the launcher never calls `thread/start` for this path.

**Tech Stack:** React 19, TypeScript, Node.js ESM, Codex App Server JSON-RPC, Node test runner, Vite.

---

## Boundaries and verified starting point

- Base: `upstream/main` at `51fbec106e829dda9314d24d26cc0d06b01c7552`; design commit `a42fde52ef5ef5087932ccab06a1811b66884873`.
- Branch: `codex/in-review-acceptance`.
- Direct path: `TaskDetail` → Taskboard comment API → authenticated injected host bridge → exact Codex host/thread `turn/start` → Taskboard task update → visible `in_progress` state.
- Risk: high because the path crosses the Codex App Server boundary. Do not install the app, publish, push, use the real Taskboard database, start auto-claim, or create a Codex task from product code.
- Verification budget: one successful return path and the send-failure path. Add only the minimal TDD checks needed to drive these paths.

## File map

- `scripts/codex-injector-runtime.mjs`: validate the new authenticated host request and route it to its dedicated handler.
- `scripts/codex-injector.mjs`: verify saved host/thread/workspace and start exactly one turn.
- `inject/codex-taskboard.user.js`: forward a capability-checked iframe request to the resident launcher and return success/failure to the iframe.
- `web/src/App.tsx`: own the iframe request/response promise and expose `onContinueThread` to the detail page.
- `web/src/components/TaskDetail.tsx`: render the acceptance surface and sequence comment → send → status update.
- `web/src/styles.css`: style the acceptance surface with existing Taskboard tokens.
- `test/injector-host-runtime.test.mjs`, `test/inject.test.mjs`, `test/board-interactions.test.mjs`: focused RED/GREEN checks for the direct contract and UI wiring.

### Task 1: Validate and execute the exact-thread host request

**Files:**
- Modify: `test/injector-host-runtime.test.mjs`
- Modify: `scripts/codex-injector-runtime.mjs`
- Modify: `scripts/codex-injector.mjs`

- [ ] **Step 1: Add the failing host-contract test**

Append a focused test to `test/injector-host-runtime.test.mjs` that proves a complete binding reaches only the new handler and returns its turn ID:

```js
test("review feedback reaches the exact bound Codex task", async () => {
  const calls = [];
  const responses = [];
  const request = {
    id: "continue-review-1",
    action: "continue-task-thread",
    identifier: "LOCAL-12",
    feedback: "Please keep the original layout and fix the empty state.",
    threadBinding: {
      threadId: "01a00000-0000-7000-8000-000000000012",
      codexProjectId: "project-12",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "/workspace/project-12",
    },
  };

  const result = await handleHostBindingPayload({
    payload: JSON.stringify(request),
    executionContextId: 12,
  }, {
    parseAutomationRequest: () => null,
    continueTaskThread: async (value) => {
      calls.push(value);
      return { turnId: "turn-12" };
    },
    startConversation: async () => assert.fail("must not create a task"),
    sendResponse: async (_executionContextId, response) => responses.push(response),
  });

  assert.deepEqual(result, { responded: true, accepted: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].threadBinding, request.threadBinding);
  assert.deepEqual(responses, [{ id: request.id, ok: true, turnId: "turn-12" }]);
});
```

Add one malformed representative to the same test:

```js
  const rejected = [];
  await handleHostBindingPayload({
    payload: JSON.stringify({
      ...request,
      id: "continue-review-invalid",
      threadBinding: { ...request.threadBinding, workspacePath: "" },
    }),
    executionContextId: 12,
  }, {
    parseAutomationRequest: () => null,
    continueTaskThread: async () => assert.fail("invalid binding must not reach Codex"),
    startConversation: async () => assert.fail("invalid binding must not create a task"),
    sendResponse: async (_executionContextId, response) => rejected.push(response),
  });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].ok, false);
```

- [ ] **Step 2: Run the host test and verify RED**

Run:

```bash
node --test test/injector-host-runtime.test.mjs
```

Expected: the new test fails because `continue-task-thread` is rejected or falls through to `startConversation`.

- [ ] **Step 3: Add the minimal request parser and explicit route**

In `scripts/codex-injector-runtime.mjs`, add one parser branch before `start-task-conversation`:

```js
  if (
    request.action === "continue-task-thread"
    && typeof request.identifier === "string"
    && request.identifier.length > 0
    && request.identifier.length <= 128
    && typeof request.feedback === "string"
    && request.feedback.trim().length > 0
    && request.feedback.length <= 100_000
    && request.threadBinding
    && typeof request.threadBinding.threadId === "string"
    && request.threadBinding.threadId.length > 0
    && request.threadBinding.threadId.length <= 240
    && typeof request.threadBinding.codexProjectId === "string"
    && request.threadBinding.codexProjectId.length > 0
    && request.threadBinding.codexProjectId.length <= 240
    && (request.threadBinding.codexProjectKind === "local" || request.threadBinding.codexProjectKind === "remote")
    && typeof request.threadBinding.codexHostId === "string"
    && request.threadBinding.codexHostId.length > 0
    && request.threadBinding.codexHostId.length <= 240
    && typeof request.threadBinding.workspacePath === "string"
    && request.threadBinding.workspacePath.length > 0
    && request.threadBinding.workspacePath.length <= 4_096
    && !/[\u0000-\u001f\u007f]/.test([
      request.identifier,
      request.threadBinding.threadId,
      request.threadBinding.codexProjectId,
      request.threadBinding.codexHostId,
      request.threadBinding.workspacePath,
    ].join(""))
  ) return { id, request, error: null };
```

Route it explicitly in `handleHostBindingPayload`:

```js
    } else if (parsed.request.action === "continue-task-thread") {
      result = await handlers.continueTaskThread(parsed.request, params.executionContextId);
    } else {
      result = await handlers.startConversation(parsed.request, params.executionContextId);
```

- [ ] **Step 4: Add the exact-thread App Server handler**

In the handler object passed to `handleHostBindingPayload` in `scripts/codex-injector.mjs`, add:

```js
      continueTaskThread: async (request) => {
        const { threadBinding } = request;
        const read = await requestCodexAppServerViaCdp(
          cdp,
          undefined,
          threadBinding.codexHostId,
          "thread/read",
          { threadId: threadBinding.threadId, includeTurns: false },
        );
        if (
          read?.thread?.id !== threadBinding.threadId
          || normalizeRemoteWorkspace(read.thread.cwd) !== normalizeRemoteWorkspace(threadBinding.workspacePath)
        ) {
          throw new Error("The bound Codex task no longer matches its saved workspace");
        }
        const started = await requestCodexAppServerViaCdp(
          cdp,
          undefined,
          threadBinding.codexHostId,
          "turn/start",
          {
            threadId: threadBinding.threadId,
            input: [{
              type: "text",
              text: [
                `用户在 Taskboard 退回 ${request.identifier}。`,
                "",
                request.feedback.trim(),
                "",
                "请在这个原任务中继续处理；不要创建新任务。完成直接验证后，按原任务约定回报结果。",
              ].join("\n"),
            }],
          },
        );
        if (typeof started?.turn?.id !== "string" || !started.turn.id) {
          throw new Error("Codex did not confirm the continued turn");
        }
        return { turnId: started.turn.id };
      },
```

Do not add `thread/start`, retries, task creation, model overrides, or reasoning-effort overrides.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
node --test test/injector-host-runtime.test.mjs
```

Expected: all tests in the file pass with no warnings.

Commit:

```bash
git add scripts/codex-injector-runtime.mjs scripts/codex-injector.mjs test/injector-host-runtime.test.mjs
git commit -m "feat: continue exact bound Codex task"
```

### Task 2: Wire the iframe request and response

**Files:**
- Modify: `test/inject.test.mjs`
- Modify: `inject/codex-taskboard.user.js`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Add the failing bridge-wiring test**

Append this test to `test/inject.test.mjs`:

```js
test("review feedback crosses the authenticated host bridge without creating a task", () => {
  assert.match(webApp, /type: "taskboard:continue-thread-request"/);
  assert.match(source, /message\.type === "taskboard:continue-thread-request"/);
  assert.match(source, /requestHost\("continue-task-thread",/);
  assert.match(source, /type: "taskboard:continue-thread-response"/);
  assert.match(webApp, /message\.type === "taskboard:continue-thread-response"/);

  const handlerStart = source.indexOf("async function continueTaskThread");
  const handlerEnd = source.indexOf("\n\n  function handleExternalOpen", handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.doesNotMatch(handler, /createThreadForTask|taskboard:create-thread|thread\/start/);
});
```

- [ ] **Step 2: Run the bridge test and verify RED**

Run:

```bash
node --test test/inject.test.mjs
```

Expected: the new test fails because the request and response message types do not exist.

- [ ] **Step 3: Forward the request in the injected host**

Add this function before `handleExternalOpen` in `inject/codex-taskboard.user.js`:

```js
  async function continueTaskThread(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;
    try {
      const response = await requestHost("continue-task-thread", {
        identifier: payload.identifier,
        feedback: payload.feedback,
        threadBinding: payload.threadBinding,
      });
      postToFrame({
        type: "taskboard:continue-thread-response",
        payload: { requestId, ok: true, turnId: response.turnId },
      });
    } catch (error) {
      postToFrame({
        type: "taskboard:continue-thread-response",
        payload: {
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : hostText(
            "无法继续原 Codex 任务",
            "Could not continue the original Codex task",
          ),
          uncertain: error?.uncertain === true,
        },
      });
    }
  }
```

Add this branch in `onFrameMessage` after `taskboard:open-thread`:

```js
    if (message.type === "taskboard:continue-thread-request") {
      void continueTaskThread(message.payload);
      return;
    }
```

Extend the timeout branch in `requestHost` so `continue-task-thread` sets `error.uncertain = true` just like an uncertain conversation start. Do not retry automatically.

- [ ] **Step 4: Add the App-owned promise**

Near `AutomationHostResponse` in `web/src/App.tsx`, add:

```ts
interface ContinueThreadHostResponse {
  requestId: string;
  ok: boolean;
  turnId?: string;
  error?: string;
  uncertain?: boolean;
}

interface PendingContinueThreadRequest {
  resolve: (response: ContinueThreadHostResponse) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}
```

Create `pendingContinueThreadRequestsRef` next to `pendingAutomationRequestsRef`.

Add this callback next to `openThread`:

```ts
  function continueTaskThread(task: Task, feedback: string): Promise<void> {
    if (!embedded || window.parent === window || !task.threadBinding) {
      return Promise.reject(new Error(textRef.current(
        "当前议题没有可继续的完整 Codex 任务绑定。",
        "This issue does not have a complete Codex task binding to continue.",
      )));
    }
    const requestId = window.crypto.randomUUID();
    const response = new Promise<ContinueThreadHostResponse>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingContinueThreadRequestsRef.current.delete(requestId);
        reject(new Error(textRef.current(
          "Codex 响应超时，反馈可能已发送。请打开原任务确认后再决定是否重试。",
          "Codex timed out and the feedback may have been sent. Check the original task before retrying.",
        )));
      }, 12_000);
      pendingContinueThreadRequestsRef.current.set(requestId, { resolve, reject, timeoutId });
    });
    postEmbeddedHostMessage({
      type: "taskboard:continue-thread-request",
      payload: {
        requestId,
        identifier: task.identifier,
        feedback,
        threadBinding: task.threadBinding,
      },
    });
    return response.then(() => undefined);
  }
```

In `receiveHostMessage`, resolve or reject `taskboard:continue-thread-response` before the host-context fallback:

```ts
      if (message.type === "taskboard:continue-thread-response" && message.payload) {
        const payload = message.payload as Partial<ContinueThreadHostResponse>;
        if (typeof payload.requestId !== "string") return;
        const pending = pendingContinueThreadRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingContinueThreadRequestsRef.current.delete(payload.requestId);
        if (payload.ok && typeof payload.turnId === "string") {
          pending.resolve(payload as ContinueThreadHostResponse);
        } else {
          pending.reject(new Error(payload.uncertain
            ? textRef.current(
                "Codex 响应超时，反馈可能已发送。请打开原任务确认后再决定是否重试。",
                "Codex timed out and the feedback may have been sent. Check the original task before retrying.",
              )
            : typeof payload.error === "string"
              ? payload.error
              : textRef.current(
                  "无法继续原 Codex 任务。",
                  "Could not continue the original Codex task.",
                )));
        }
        return;
      }
```

In the effect cleanup, reject and clear this pending map alongside automation requests:

```ts
      for (const pending of pendingContinueThreadRequestsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error(textRef.current(
          "Taskboard 消息桥已关闭",
          "The Taskboard host bridge was closed",
        )));
      }
      pendingContinueThreadRequestsRef.current.clear();
```

Pass `onContinueThread={continueTaskThread}` and `canContinueThread={embedded && window.parent !== window}` to `TaskDetail`.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
node --test test/inject.test.mjs
npm run typecheck
```

Expected: `test/inject.test.mjs` passes and TypeScript reports no errors.

Commit:

```bash
git add inject/codex-taskboard.user.js web/src/App.tsx test/inject.test.mjs
git commit -m "feat: bridge review feedback to Codex"
```

### Task 3: Add the In Review acceptance surface and return sequencing

**Files:**
- Modify: `test/board-interactions.test.mjs`
- Modify: `web/src/components/TaskDetail.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Add the failing direct-UI-path test**

Append this test to `test/board-interactions.test.mjs`:

```js
test("in-review details expose acceptance and exact-task return actions", () => {
  assert.match(detailSource, /currentTask\.status === "in_review"[\s\S]*?className="review-acceptance"/);
  assert.match(detailSource, /comments[\s\S]*?authorType === "agent"[\s\S]*?等待你验收/);
  assert.match(detailSource, /通过并完成[\s\S]*?onUpdate\(currentTask, \{ status: "done" \}\)/);
  assert.match(detailSource, /写退回意见[\s\S]*?composerRef\.current\?\.focus\(\)/);
  assert.match(detailSource, /createComment\([\s\S]*?getTask\([\s\S]*?onContinueThread\([\s\S]*?status: "in_progress"/);
  assert.match(detailSource, /仅改为等待认领（不通知）/);
  assert.match(detailSource, /退回并继续原任务/);
  assert.match(styles, /\.review-acceptance/);
});
```

- [ ] **Step 2: Run the UI test and verify RED**

Run:

```bash
node --test test/board-interactions.test.mjs
```

Expected: the new test fails because the acceptance surface and return action are absent.

- [ ] **Step 3: Add the acceptance props and derived delivery comment**

Extend `TaskDetailProps` in `web/src/components/TaskDetail.tsx`:

```ts
  canContinueThread: boolean;
  onContinueThread: (task: Task, feedback: string) => Promise<void>;
```

Add a `commentComposerFormRef` and a derived latest Agent comment before the return statement:

```ts
  const commentComposerFormRef = useRef<HTMLFormElement>(null);
  const latestAgentDelivery = [...comments]
    .reverse()
    .find((comment) => comment.authorType === "agent" && comment.body.trim());
```

- [ ] **Step 4: Render the acceptance surface**

Insert the surface between the issue editor/sub-issues block and the activity section:

```tsx
            {currentTask.status === "in_review" && (
              <section className="review-acceptance" aria-labelledby="review-acceptance-heading">
                <header>
                  <div>
                    <span>{text("等待你验收", "Waiting for your review")}</span>
                    <h2 id="review-acceptance-heading">{currentTask.title}</h2>
                  </div>
                  <button
                    className="button primary"
                    type="button"
                    disabled={savingProperty !== null || submitting}
                    onClick={() => {
                      setSavingProperty("review-complete");
                      void onUpdate(currentTask, { status: "done" })
                        .then(setCurrentTask)
                        .catch((error) => onError(issueMessageFor(error)))
                        .finally(() => setSavingProperty(null));
                    }}
                  >
                    {text("通过并完成", "Approve and complete")}
                  </button>
                </header>
                <div className="review-delivery">
                  {latestAgentDelivery
                    ? <DescriptionDocument
                        value={latestAgentDelivery.body}
                        referenceTasks={referenceTasks}
                        onOpenTask={onOpenTask}
                        attachments={latestAgentDelivery.attachments}
                        enableImagePreview
                        onOpenAttachment={handleAttachmentDownload}
                      />
                    : <p>{text(
                        "暂无 Agent 交付说明，请打开处理对话查看结果。",
                        "No Agent delivery note is available. Open the processing task to inspect the result.",
                      )}</p>}
                </div>
                <footer>
                  <span>{text("普通评论只保存记录，不会通知 Codex。", "Regular comments are recorded without notifying Codex.")}</span>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={!canContinueThread || !currentTask.threadBinding}
                    onClick={() => {
                      commentComposerFormRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                      requestAnimationFrame(() => composerRef.current?.focus());
                    }}
                  >
                    {text("写退回意见", "Write return feedback")}
                  </button>
                </footer>
              </section>
            )}
```

Use existing `button`, text, surface, border, and radius tokens; do not import external colors, fonts, icons, or assets.

- [ ] **Step 5: Sequence comment, exact send, and status update**

Change `submitComment` to accept an intent:

```ts
  async function submitComment(intent: "record" | "return" = "record") {
```

Before setting `submitting`, reject a return without body, complete binding, embedded capability, or `in_review` status:

```ts
    if (
      intent === "return"
      && (!body || currentTask.status !== "in_review" || !currentTask.threadBinding || !canContinueThread)
    ) return;
```

After comment creation/upload and `const relationAnchor = await getTask(currentTask.id)`, add the return branch before the existing Todo branch:

```ts
      if (intent === "return") {
        if (relationAnchor.status !== "in_review" || !relationAnchor.threadBinding) {
          throw new Error(text(
            "议题或任务绑定已变化，请刷新后重试。",
            "The issue or task binding changed. Refresh and try again.",
          ));
        }
        await onContinueThread(relationAnchor, body);
        try {
          const saved = await onUpdate(relationAnchor, { status: "in_progress" });
          setCurrentTask(saved);
          relationAnchor = saved;
        } catch (error) {
          setCommentsError(text(
            "反馈已发送，但状态更新失败。请刷新议题；不要再次发送反馈。",
            "Feedback was sent, but the status update failed. Refresh the issue; do not send the feedback again.",
          ));
          return;
        }
      }
```

Keep comment creation first. Keep the comment when send fails. Do not call `onUpdate` when `onContinueThread` rejects. Do not automatically retry either operation.

Give the form `ref={commentComposerFormRef}`. In Review, render both explicit submit buttons:

```tsx
                    <button className="button secondary" type="submit" disabled={...}>
                      {submitting ? text("发布中…", "Posting…") : text("仅记录评论", "Record comment")}
                    </button>
                    <button
                      className="button primary"
                      type="button"
                      disabled={!draft.trim() || submitting || !canContinueThread || !currentTask.threadBinding}
                      onClick={() => void submitComment("return")}
                    >
                      {submitting
                        ? text("发送中…", "Sending…")
                        : text("退回并继续原任务", "Return and continue original task")}
                    </button>
```

For non-review statuses, retain the current single Comment button. For the existing Todo switch, use `text("仅改为等待认领（不通知）", "Move to Todo only (no notification)")` while in review and preserve the existing copy elsewhere.

- [ ] **Step 6: Add minimal styles**

Add a `.review-acceptance` block near `.activity-section` in `web/src/styles.css` using only existing variables:

```css
.review-acceptance {
  margin: 0 14px 18px;
  padding: 16px;
  border: var(--border-hairline) solid color-mix(in srgb, var(--accent) 24%, var(--border));
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 4%, var(--surface));
}

.review-acceptance > header,
.review-acceptance > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.review-acceptance > header span,
.review-acceptance > footer span {
  color: var(--text-tertiary);
  font-size: 11px;
}

.review-acceptance h2 {
  margin: 2px 0 0;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
}

.review-delivery {
  margin: 14px 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.55;
}

.review-delivery > :first-child { margin-top: 0; }
.review-delivery > :last-child { margin-bottom: 0; }

@media (max-width: 719px) {
  .review-acceptance > header,
  .review-acceptance > footer {
    align-items: stretch;
    flex-direction: column;
  }
}
```

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
node --test test/board-interactions.test.mjs
npm run typecheck
npm run build:web
```

Expected: the focused test passes, TypeScript reports no errors, and Vite completes a Web build.

Commit:

```bash
git add web/src/components/TaskDetail.tsx web/src/styles.css test/board-interactions.test.mjs
git commit -m "feat: add in-review acceptance actions"
```

### Task 4: Direct-path verification and handoff

**Files:**
- No product files unless direct verification exposes a defect in the requested path.

- [ ] **Step 1: Run the focused verification set**

Run:

```bash
node --test test/injector-host-runtime.test.mjs test/inject.test.mjs test/board-interactions.test.mjs
npm run typecheck
npm run build:web
git diff --check upstream/main...HEAD
```

Expected: all focused tests pass; typecheck and Web build succeed; diff check is clean.

- [ ] **Step 2: Run simplify before completion**

Inspect:

```bash
git diff --stat upstream/main...HEAD
git diff upstream/main...HEAD -- scripts/codex-injector-runtime.mjs scripts/codex-injector.mjs inject/codex-taskboard.user.js web/src/App.tsx web/src/components/TaskDetail.tsx web/src/styles.css
```

Remove any new abstraction, retry, fallback, compatibility path, duplicate validation at the same boundary, or unrelated style change not required by the successful and failed direct paths. Retain authenticated-host validation, complete-binding validation, workspace matching, timeout uncertainty, and the comment/send/status ordering because they protect distinct trust or persistence boundaries.

- [ ] **Step 3: Verify the isolated success and failure paths**

Use a temporary Taskboard data directory and an isolated loopback port; never point at the active launcher runtime or real database. Seed one `in_review` fixture issue with an Agent delivery comment and a fake complete binding. Stub the authenticated host response for two cases:

1. Success: return `{ ok: true, turnId: "turn-fixture" }`; verify one click records one comment, sends one continue request containing the saved host/thread and body, then shows `in_progress`.
2. Failure: return `{ ok: false, error: "fixture send failure" }`; verify the comment remains visible, status remains `in_review`, and the error is visible.

Capture screenshots of the acceptance surface at desktop width and below 719px. Confirm hierarchy, legibility, spacing, contrast, keyboard focus, bilingual copy, and that external Linear brand colors/fonts/assets are absent. Stop only the exact isolated processes started for this verification.

- [ ] **Step 4: Prepare the working demo; do not push or open a PR yet**

Record:

- changed files and commits;
- exact HEAD SHA;
- RED then GREEN outputs;
- isolated success/failure receipts;
- screenshot paths;
- known limitation: a confirmed Codex send followed by a Taskboard status failure cannot be atomic, so the UI warns not to resend;
- review decision: Pro review is required after user confirmation because this changes the native host/Codex App Server external boundary.

Return the evidence to the coordinator. Do not merge, release, install, mark anything `done`, submit to Pro, push, or create a PR before the coordinator presents the working demo and the user confirms it works.
