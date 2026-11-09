// Reproducible, isolated CLI roundtrip. No GPT, network, tunnel or installed service required.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-review-smoke-"));
const workspace = path.join(temp, "workspace");
const state = path.join(temp, "state");
const env = { ...process.env, C2C_STATE_DIR: state };
fs.mkdirSync(workspace);

function cli(args) {
  const result = spawnSync(process.execPath, [path.join(project, "bin/c2c.js"), ...args, "-w", workspace], {
    env, encoding: "utf8", cwd: project,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
function json(args) { return JSON.parse(cli([...args, "--json"])); }
function git(...args) {
  const result = spawnSync("git", args, {
    cwd: workspace, encoding: "utf8", env: {
      ...env, GIT_AUTHOR_NAME: "C2C smoke", GIT_AUTHOR_EMAIL: "smoke@c2c.local",
      GIT_COMMITTER_NAME: "C2C smoke", GIT_COMMITTER_EMAIL: "smoke@c2c.local",
    },
  });
  assert.equal(result.status, 0, result.stderr);
}

try {
  fs.writeFileSync(path.join(workspace, "value.json"), '{"answer":43}\n');
  fs.writeFileSync(path.join(workspace, "value.test.cjs"), [
    'const {test} = require("node:test");',
    'const assert = require("node:assert/strict");',
    'test("answer is 42", () => assert.equal(require("./value.json").answer, 42));',
  ].join("\n") + "\n");
  git("init", "-b", "main");
  git("add", ".");
  git("commit", "-m", "smoke fixture with failing behavior");

  const verdicts = [];
  let finalRecord;
  for (const iteration of [1, 2]) {
    if (iteration === 2) fs.writeFileSync(path.join(workspace, "value.json"), '{"answer":42}\n');
    const result = spawnSync(process.execPath, ["--test", "value.test.cjs"], { cwd: workspace, env, encoding: "utf8" });
    assert.equal(result.status, iteration === 1 ? 1 : 0, result.stdout + result.stderr);
    const log = path.join(temp, `test-${iteration}.log`);
    fs.writeFileSync(log, result.stdout + result.stderr);
    cli(["record", "--task", "c2c_review_smoke", "--iteration", String(iteration),
      "--changed-files", "value.json", "--tests", iteration === 1 ? "1 failed" : "1 passed",
      "--exit-status", iteration === 1 ? "failed" : "ok", "--command", "node --test value.test.cjs",
      "--output-file", log, "--exit-code", String(result.status)]);
    const report = {
      taskId: "c2c_review_smoke", iteration, goal: "The answer equals 42", target: json(["review", "target"]),
      criteria: [{ id: "answer", description: "Actual Node test passes and value is 42",
        status: iteration === 1 ? "fail" : "pass", evidence: [{kind: "workspace", path: "value.json"}] }],
      assessment: iteration === 1 ? "revise" : "accept", summary: iteration === 1 ? "Real assertion failed" : "Real assertion passed",
      nextAction: { action: iteration === 1 ? "Change answer to 42" : "Deliver result", owner: "Codex", resumeWhen: iteration === 1 ? "Same task, next iteration" : "Review accepted" },
    };
    const reportFile = path.join(temp, `review-${iteration}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(report));
    const recorded = json(["review", "record", "--file", reportFile]);
    assert.equal(recorded.duplicate, false);
    const duplicate = json(["review", "record", "--file", reportFile]);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.record.id, recorded.record.id);
    const summary = json(["review", "summary", "--task", "c2c_review_smoke"]);
    assert.equal(summary.items.length, 1);
    assert.equal(summary.items[0].verdict, iteration === 1 ? "revise" : "accept");
    verdicts.push(summary.items[0].verdict);
    finalRecord = summary.items[0].record;
  }
  console.log(JSON.stringify({ ok: true, taskId: finalRecord.taskId, iterations: [1, 2],
    actualTestExitCodes: [1, 0], verdicts, duplicateReused: true,
    scope: "Built local CLI and real Node tests; GPT artifact transfer and Windows installation not exercised" }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
