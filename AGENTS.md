# Project Development Rules

For feature work in this repository, use this order:

1. Before implementation, prove the real operation path to the user: entry point → user or agent action → data change or other side effect → observable result. Cite the actual component, API, and file involved, or demonstrate the path in the product. This proof is not a test.
2. Implement the requested main path with the smallest direct change that makes it work.
3. After implementation, demonstrate or verify only that direct operation path and give the result to the user for confirmation.
4. Before the user confirms the feature works, do not proactively add guardrails, mutation or regression tests, legacy compatibility protection, defensive extensions, or speculative fallback behavior.
5. User confirmation does not automatically authorize that follow-up work. Add targeted protection or tests only when the user explicitly asks for them, or when the user reports a concrete failure scenario that requires them.

The primary objective is to make the requested function work. Focus on the feature implementation itself and avoid over-design; safety, guardrails, and testing must not dominate the work or turn the feature into a surrounding engineering project.

This ordering does not waive higher-priority safety or security requirements. Keep validation that is necessary at real external boundaries, such as user input or external APIs, but do not expand it into hypothetical protection beyond the requested path.

# Taskboard Delivery Workflow

Use this workflow when the user asks to process Taskboard work.

## 1. Read and claim work

- Read only the Taskboard states that the user asked to process. For the normal development flow, claim `todo` items and continue unfinished `in_progress` items.
- Never assign `backlog` items. Leave an item unclaimed when its description or latest comment explicitly requires waiting.
- Read the full issue description, attachments, and all comments before routing or changing it.
- GitHub Issue and PR synchronization is not a default step. Read or synchronize GitHub Issue/PR data only when the user explicitly requests it.
- Use the packaged or injected `taskctl` and the exact active Taskboard runtime. Do not fall back to a global CLI, a guessed port, or another data source.

## 2. Route for efficiency

- Read the complete eligible batch before dispatch. Group work by dependency, shared files, feature state, and runtime conflicts rather than by issue count.
- Do not force one issue into one conversation or one worktree.
- Group closely related issues in one conversation and worktree when they share the same feature chain and this reduces duplicate work or merge conflicts.
- Run independent work in parallel when the paths do not conflict. Queue conflict-prone work and keep it visible.
- Research, triage, replies, and other work that does not change code normally do not need a worktree.
- For code changes, start from verified current `origin/main`, create a feature branch, and use a worktree. Never implement directly on `main`.
- Every newly dispatched task conversation uses the same model and reasoning level as the coordinating conversation.
- Bind each claimed issue to the actual conversation, branch, and worktree used for it, and record the grouping decision in the issue.

### Work-in-progress limits and execution lanes

- Parallelize independent code paths. Do not parallelize access to a shared mutable runtime.
- Do not use a fixed total number of execution lanes or worktrees. Create one execution group for each independent conflict domain. Ten eligible issues may become several parallel groups or one coherent group, depending on overlap.
- Classify Web or product logic, native or platform work, and research or external contribution work for routing only. These categories are not concurrency limits; multiple independent groups within a category may run in parallel.
- Determine concurrency from shared files, feature state, the Codex App process, Launcher runtime, CDP, browser review state, CI capacity, and release resources. More issues alone do not justify more worktrees, and a category label does not justify serialization.
- Run only one Launcher, Codex injection, native host, updater, signing, or release task against the local App environment at a time. If isolated runtime descriptors, ports, CDP profiles, and user-data directories are available, separate instances may run in parallel.
- Keep external contributor PR maintenance in its own lane. Preserve contributor history and do not let unrelated internal work rewrite its branch.
- Group small changes that share a feature chain into one conversation, worktree, and PR. Amortize branch setup, CI, review, UI confirmation, merge, and cleanup instead of paying that fixed cost per issue.
- Queue work that shares a runtime or conflict domain. A visible queue is better than parallel work that later requires repeated restarts, conflict resolution, or CI reruns.
- A waiting issue does not stop the rest of the batch. Continue every other eligible lane while one item waits for CI, GPT-6 Pro, user input, or an external dependency.
- Requirement-collection and record-only issues are not active implementation. Leave them unassigned in `backlog` or another non-active tracking state; do not keep them in `in_progress` merely to preserve notes.

## 3. Follow E3

1. **Estimate**: estimate the context, steps, overlap, and risk.
2. **Execute**: prove and implement the smallest viable real path.
3. **Expand**: read or change more only when direct verification fails.

Before editing, record the real path in the issue:

`entry point -> user or agent action -> component/API/data change -> observable result`

Make the smallest root-cause change. Do not add unrelated refactors, abstractions, state machines, compatibility layers, speculative fallbacks, guardrails, or tests. Add targeted protection or tests only when the user explicitly requests them or reports a concrete failure that requires them.

- During **Estimate**, classify the work as small, medium, or high risk and state the intended direct verification before implementation.
- Classify complexity by operation-path breadth, number of affected components and data layers, persistence or process effects, platform reach, external dependencies, shared state, blast radius, and required evidence. Do not classify or stop work by elapsed time.
- Treat a single component or direct data path without persistence, process, or platform effects as small. Treat multiple components or an API and persistence chain as medium. Treat process management, Launcher or injection, updater, migration, destructive operations, cross-platform behavior, or external boundaries as high risk.
- The default verification budget is the user-reported failing path plus one successful main path. Stop when both pass.
- Use **Expand** only when direct verification fails, evidence disproves the estimated root cause, the user reports another concrete case, or the changed boundary creates a real additional risk. Do not expand into a general matrix by default.
- Stop expanding when the reported failure path and one successful main path pass, the root cause remains supported by evidence, and no required boundary check or review has found a real defect.
- Run focused checks that match the changed layer. Do not run a full App build, cross-platform packaging, or a broad test suite for documentation, copy, CSS, or isolated Web changes unless that exact path requires it.
- Do not repeat environment discovery in every task. Reuse a verified toolchain, project ID, packaged `taskctl`, and stable coordinator-owned runtime until evidence shows that one changed.

## 4. Preserve external contributions

- When an issue already has an external contributor PR, review and improve that PR before creating a replacement.
- Preserve the contributor's commits and authorship. Use a normal merge; do not squash, rebase, force-push, or rewrite the contributor's commits.
- If a PR contains a usable subset, merge that subset and put remaining work in a later PR.
- Close and replace an external PR only when it is abandoned, has the wrong direction, or cannot be maintained. Explain the reason first.
- When there is only an issue and no corresponding PR, create a new branch, worktree, and PR.
- Before final cleanup, verify that merged external authors are retained in repository history and Contributors.

## 5. Implement, verify, and report

- Keep the issue `in_progress` during implementation.
- Verify the direct user path. For changes on a UI surface, use the real browser/App surface. Capture visual evidence when the result has visual impact; this evidence supports review and does not by itself require a separate user UI confirmation.
- Report changed files, commit, exact head SHA, direct verification, PR, CI state, review complexity decision, review result, and remaining limitations in the issue.
- Show ongoing status in the Taskboard opened through the injected Codex App.
- Execution conversations do not merge, release, mark `done`, or claim user acceptance.
- The same execution conversation owns its group from issue reading and implementation through direct verification, PR, complexity decision, required review, CI diagnosis, and rework. Do not hand off between these stages without a real blocker.

### Shared runtime isolation

- The installed or injected Taskboard runtime used for issue reads and writes is coordinator-owned. An execution conversation must not stop it, replace its descriptor, overwrite the installed App, or reuse its CDP profile for worktree validation.
- Independent implementation may continue in parallel while shared App verification is queued. Concentrate real Codex, Launcher, Chrome, updater, signing, and release operations in a coordinator-owned integration lane instead of blocking unrelated code work.
- A worktree Launcher must use an isolated runtime descriptor, port, CDP port, and user-data directory when the product supports them.
- If the product cannot isolate worktree Launcher state, serialize Launcher verification. Do not run two tasks that can replace the same active runtime descriptor.
- Stop only processes that were started by the same task and were resolved by exact PID and executable path.

### Progress and context economy

- Write one initial Taskboard comment for claim, grouping, and E3 path, and one final comment for implementation, verification, review, PR, CI, and limitations.
- Add an intermediate comment only for a material blocker, scope correction, failed review, user-visible preview, or changed exact head. Do not write polling or unchanged waiting updates into the issue.
- A resumed conversation may reuse its recorded full issue snapshot. Read only comments and attachments added since that snapshot unless the issue version or requirement changed.
- Return a concise structured handoff. Do not paste full command logs, full API JSON, base64 images, or repeated rule text when identifiers, exact SHA, results, and artifact links are enough.
- The coordinator checks handoff evidence but does not repeat the execution conversation's full review or full validation matrix.

## 6. Review by risk

- In the ChatGPT web app, select **最新 → 推理强度 Pro** to use **GPT-6 Pro**.

- Each dispatched execution conversation decides the review complexity for its own implementation after direct-path verification. The coordinating conversation does not make this complexity decision or perform the code review.
- For lower-complexity work, the dispatched execution Agent performs the code review. It checks implementation correctness, the requested path, scope, and real bugs without sending the PR to GPT-6 Pro in the ChatGPT web app.
- For complex or risky work, the corresponding dispatched execution conversation opens GPT-6 Pro in the ChatGPT web app itself and submits the PR URL and exact head SHA for review. It asks GPT-6 Pro to review only implementation correctness and real bugs.
- The user grants standing authorization to submit the public PR URL, exact head SHA, and established review instructions to GPT-6 Pro in the ChatGPT web app; execution conversations send them directly without requesting confirmation each time.
- Development and review must avoid over-design and over-defensive recommendations. Do not request or add hypothetical guardrails, unrelated refactors, compatibility layers, style preferences, or scope expansion.
- Before any change is submitted to GPT-6 Pro in the ChatGPT web app, complete the requested function, verify its direct real path, and provide the user with a working demo that uses the relevant real data or runtime. Start GPT-6 Pro review only after the user confirms that the function works. This gate applies to UI and non-UI work. Do not use GPT-6 Pro to discover whether an unfinished function basically works.
- Independent dispatched conversations run their required reviews in parallel. Do not serialize independent Agent or GPT-6 Pro reviews through the coordinating conversation.
- For GPT-6 Pro review, wait for the complete answer. Do not use an instant-answer result. Check at approximately five-minute intervals when necessary; a complete review can take more than 30 minutes.
- Fix actionable blockers in the same PR. The dispatched execution conversation decides whether the changed complexity warrants another GPT-6 Pro review; trivial targeted follow-up edits can use its normal Agent review.
- Before accepting a handoff, the coordinating conversation checks that the execution evidence, scope, CI state, complexity decision, and required review result are present. It does not repeat the code review.
- Decide the UI confirmation gate from the actual visual impact and risk. Do not trigger it mechanically because code is in a UI component or changes a UI file.
- Logic-only changes on a UI surface do not need separate user UI confirmation when they do not cause a meaningful visual change. This includes interaction logic, data behavior, toggle behavior, popover close conditions, and copy-and-paste behavior.
- Small, low-risk, and visually unambiguous changes can skip user UI confirmation after the coordinator checks the real path and visual evidence. Examples include a local font-size, spacing, alignment, or color adjustment.
- Require user UI confirmation before merge when the change adds UI, meaningfully changes layout, information hierarchy, or the presentation of a core interaction, has multiple reasonable visual choices, or the user explicitly asks to confirm the style.
- User confirmation is a functional acceptance gate before GPT-6 Pro review. Ask only after the full function is complete and direct verification passes. Never ask the user to confirm a partially implemented UI. After confirmation, independent required GPT-6 Pro reviews may run in parallel.
- After GPT-6 Pro approval, visual-only adjustments made from the user's final UI feedback do not require another GPT-6 Pro review. The coordinator checks that the delta is limited to the requested visual change, reruns the real path, and can then proceed to merge. If the adjustment changes functional logic or introduces new complex risk, reassess whether code review or GPT-6 Pro review is required.
- The dispatched execution conversation closes its temporary review browser tabs after review finishes.

Use this review classification:

- **Agent review**: documentation, README, copy, CSS, a local font/spacing/color change, a small direct UI behavior change, or a narrow logic fix with no process, persistence, migration, concurrency, security, or cross-project effect.
- **GPT-6 Pro review**: Launcher lifecycle, native host or Codex injection, process management, updater or release behavior, persistent-data migration, destructive file handling, complex concurrency, cross-project state, external boundary changes, or a broad external contributor PR.
- File count and UI file location do not determine review level. Use blast radius and failure cost.
- Skipping GPT-6 Pro for a low-risk change is the expected path, not an exception that needs extra justification.
- Before starting GPT-6 Pro, obtain the user's confirmation from the working demo, then use a stable PR head based on the current merge wave. Submit only the public PR URL, exact head SHA, and the instruction to review implementation correctness and real bugs without over-design or over-defense.
- If main advances after GPT-6 Pro, repeat GPT-6 Pro only when the integration changes reviewed functional logic or creates a real overlapping risk. A conflict-free merge commit or trivial targeted fix uses Agent review and direct-path verification.

## 7. CI and integration waves

- Use one PR for a coherent group of small issues. Do not create one PR per issue when the changes share a feature chain and can be reviewed and accepted together.
- Establish a merge wave before review starts. Keep its base stable while independent PRs run CI and GPT-6 Pro in parallel, then merge them in a planned conflict order.
- Do not merge an early low-priority PR when doing so will force several active related PRs to update their base, rerun packaging, and invalidate exact-head review. Urgent blockers are the exception.
- After main advances, update only PRs that are actually conflicting, not mergeable, or affected by overlapping behavior. Do not mechanically merge main into every open branch.
- Local validation should be focused. Let PR CI provide the broad repository check. Do not duplicate a successful full CI run with the same full local packaging unless the direct task path requires the local artifact.
- Avoid duplicate branch `push` and `pull_request` CI for the same SHA. Workflow owners should use branch filters and concurrency cancellation so superseded or duplicate runs do not consume both macOS and Windows builders.
- Use path-aware CI when available: Web-only, documentation, CSS, and copy changes use the fast lane; platform packaging runs only for Launcher, bundle, platform, updater, release, or final integration changes.
- CI may run as soon as each PR reaches a stable exact head. After the working demo is confirmed by the user, run independent required GPT-6 Pro reviews in parallel. Do not serialize them through the coordinating conversation.
- Present each task's working demo as soon as that task completes implementation and direct verification. Do not hold completed demos until the whole batch is ready. Other tasks continue in parallel while the user checks it. Related changes may share one preview only when they become ready together or must be integrated to work; this must not delay an already usable demo.

## 8. Acceptance and issue status

- Reviewer approval means ready for user inspection, not user acceptance.
- When work meets the user confirmation gate, put the complete directly verified function into the Taskboard-launched Codex App and ask the user to confirm that the function and final visual style work before starting any required GPT-6 Pro review.
- Do not merge work that meets the UI confirmation gate until the user confirms its style. After visual-only feedback is applied and directly verified, the change can proceed without repeating GPT-6 Pro review.
- UI-surface work that does not meet the confirmation gate can proceed after the coordinator verifies the real path, visual impact, scope, and required review without a separate user UI pause.
- After implementation and required review pass, move the issue to `in_review`.
- Never move an issue to `done` unless the user explicitly accepts it or asks for completion.
- If the user explicitly authorizes finishing and releasing the whole batch without another pause, that instruction authorizes the remaining review, merge, and release steps, but still does not authorize marking issues `done`.
- When a Taskboard issue is linked to a GitHub Issue, keep completion-state changes synchronized across both systems. Record the local state change in the GitHub Issue and the GitHub state change in the local issue. The release gate below controls when the GitHub Issue can be closed.

- `in_progress` means active implementation, rework, verification, CI, or required review. Do not use it for indefinite notes, requirement collection, or an item that is only waiting to be scheduled.
- Keep explicit external waiting items visible, but do not count them as active code lanes or use them to block batch progress.

## 9. Merge and clean up

- Merge only reviewed and authorized PRs into `main`. Do not merge unrelated open PRs.
- Confirm the accepted commit is present on remote `main`.
- After merge, remove the merged worktree, local feature branch, remote feature branch, and disposable files from that task.
- Preserve all task conversations for traceability. Do not archive or delete them.
- Do not touch unrelated dirty worktrees, branches, files, or active sessions.

## 10. Release

- Release only when the user requests it or explicitly includes release in the task.
- Merge all included product PRs first. Use a minimal version PR for the required version fields; do not alter release infrastructure without a separate requirement.
- Use a short tag such as `v1.0.7`. Release notes contain product changes only.
- Keep the DMG as the first release asset.
- Record live build, signing, notarization, upload, and publication progress in the Taskboard.
- Verify the tag target, release target, workflow result, asset order, and updater metadata.
- Merging code does not authorize closing a linked GitHub Issue. Keep it open after merge and report that the implementation is merged and awaiting release.
- Close a linked GitHub Issue only after a new version containing the change is published and verified. Reply with the merged PR and released version before closing, then record the closure in the local issue.
- Do not overwrite the App in `/Applications`; leave the installed version available for update-check verification.

## 11. Batch completion

A requested batch is complete only when:

- all eligible `todo` items are handled;
- no item is unexpectedly left in `in_progress`;
- explicit waiting items are reported;
- included PRs are reviewed and merged into `main`;
- changed issues are in `in_review`, not `done`;
- the injected Codex App shows the latest status;
- merged worktrees and feature branches are cleaned up;
- task conversations remain available; and
- any requested release is published and verified.

Record-only and explicitly waiting issues are excluded from active implementation counts, but they must be reported accurately in the batch summary.
