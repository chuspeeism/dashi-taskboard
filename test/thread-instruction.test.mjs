import assert from "node:assert/strict";
import test from "node:test";

import { buildThreadInstruction } from "../shared/thread-instruction.mjs";

test("the instruction carries the project, the issue, and the workspace", () => {
  const instruction = buildThreadInstruction({
    identifier: "LOCALFE705C9-8",
    projectName: "dashi-taskboard",
    projectId: "local",
    workspacePath: "/Users/sammore/codeLab/dashi-taskboard",
  });

  assert.equal(
    instruction,
    [
      "处理下面这个议题：",
      "",
      "- 项目: dashi-taskboard (id: local)",
      "- 议题: LOCALFE705C9-8",
      "- 工作区: /Users/sammore/codeLab/dashi-taskboard",
      "",
      "先执行 taskctl issue get LOCALFE705C9-8 读取标题、描述与评论，再开始。",
    ].join("\n"),
  );
});

test("a missing workspace drops its line instead of leaving a placeholder", () => {
  const instruction = buildThreadInstruction({
    identifier: "LOCALFE705C9-8",
    projectName: "dashi-taskboard",
    projectId: "local",
    workspacePath: null,
  });

  assert.doesNotMatch(instruction, /工作区/);
  assert.match(instruction, /- 项目: dashi-taskboard \(id: local\)\n- 议题: LOCALFE705C9-8\n\n/);
});

test("a project without a name falls back to its bare id", () => {
  const instruction = buildThreadInstruction({
    identifier: "LOCALFE705C9-8",
    projectName: undefined,
    projectId: "local",
    workspacePath: null,
  });

  assert.match(instruction, /^- 项目: local$/m);
});

test("a project without a name or an id drops its line", () => {
  const instruction = buildThreadInstruction({
    identifier: "LOCALFE705C9-8",
    projectName: "   ",
    projectId: "",
    workspacePath: null,
  });

  assert.doesNotMatch(instruction, /项目/);
  assert.match(instruction, /- 议题: LOCALFE705C9-8/);
});

test("the instruction tells the agent to read the issue before starting", () => {
  const instruction = buildThreadInstruction({
    identifier: "WEB-42",
    projectName: "www-v3",
    projectId: "web",
    workspacePath: "/tmp/www-v3",
  });

  assert.match(instruction, /taskctl issue get WEB-42/);
  assert.match(instruction, /读取标题、描述与评论/);
});

test("the instruction no longer carries the truncated english leftover", () => {
  const instruction = buildThreadInstruction({
    identifier: "LOCALFE705C9-8",
    projectName: "dashi-taskboard",
    projectId: "local",
    workspacePath: "/tmp/dashi",
  });

  assert.doesNotMatch(instruction, /e-taskboard Addressing the issues mentioned in/);
});

test("every field is trimmed before it reaches the composer", () => {
  const instruction = buildThreadInstruction({
    identifier: "  LOCALFE705C9-8  ",
    projectName: "  dashi-taskboard  ",
    projectId: "  local  ",
    workspacePath: "  /tmp/dashi  ",
  });

  assert.match(instruction, /- 项目: dashi-taskboard \(id: local\)/);
  assert.match(instruction, /- 议题: LOCALFE705C9-8/);
  assert.match(instruction, /- 工作区: \/tmp\/dashi/);
});
