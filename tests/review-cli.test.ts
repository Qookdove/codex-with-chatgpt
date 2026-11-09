import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { captureReviewTarget } from "../src/review/manager.js";
import { sessionFile, writeSession } from "../src/session/state.js";
import { cleanup, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

type Fixture = { root: string; stateDir: string; workspace: Workspace };

function withEnvironment(run: (fixture: Fixture) => void): void {
  const root = makeTmpDir("review-cli-workspace");
  const stateDir = makeTmpDir("review-cli-state");
  const previousStateDir = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;
  try {
    makeGitRepo(root);
    run({ root, stateDir, workspace: new Workspace(root) });
  } finally {
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    cleanup(root);
    cleanup(stateDir);
  }
}

function runReview(root: string, ...args: string[]) {
  return spawnSync(process.execPath,
    ["--import", "tsx", cliEntry, "review", ...args, "--workspace", root, "--json"],
    { cwd: projectRoot, encoding: "utf8", env: process.env });
}

function json(result: ReturnType<typeof runReview>) {
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout);
}

function inputFile(stateDir: string, name: string, value: unknown): string {
  return write(stateDir, name, JSON.stringify(value));
}

function execution(workspace: Workspace, iteration: number, exitStatus = "ok"): void {
  appendExecutionRecord(workspace.id, {
    taskId: "c2c_review_cli",
    iteration,
    changedFiles: ["src/index.ts"],
    tests: exitStatus === "ok" ? "assertion passed" : "assertion failed",
    exitStatus,
    timestamp: new Date().toISOString(),
  });
}

function report(workspace: Workspace, iteration: number, assessment = "accept") {
  return {
    taskId: "c2c_review_cli",
    iteration,
    goal: "Ensure the exported answer is correct",
    priority: 10,
    dependsOn: [],
    target: captureReviewTarget(workspace),
    criteria: [{
      id: "answer",
      description: "The exported answer is 42",
      status: assessment === "revise" ? "fail" : "pass",
      evidence: [{ kind: "workspace", path: "src/index.ts" }],
    }],
    assessment,
    summary: assessment === "revise" ? "The implementation needs a correction" : "Inspected the current implementation",
    nextAction: {
      action: assessment === "revise" ? "Correct only the exported answer" : "Deliver the existing result",
      owner: assessment === "revise" ? "Codex" : "coordinator",
      resumeWhen: assessment === "revise" ? "Next PLAN is received" : "Result receipt is available",
    },
    uncertainties: [],
  };
}

describe("c2c review local workflow", () => {
  it("continues a failed review into a corrected iteration of the same task, without mutating execution or session state", () => {
    withEnvironment(({ root, stateDir, workspace }) => {
      writeSession(workspace.id, {
        taskId: "c2c_review_cli", iteration: 1, lastState: "EXECUTED",
        checkpoint: {
          taskId: "c2c_review_cli", iteration: 1,
          protocolState: "EXECUTED_LOCAL", waitingFor: "GPT_REVIEW",
          nextExpectedStep: "Review the existing result", updatedAt: new Date().toISOString(),
        },
        savedAt: new Date().toISOString(),
      });
      const sessionBefore = fs.readFileSync(sessionFile(workspace.id), "utf8");
      write(root, "src/index.ts", "export const answer = 43;\n");
      execution(workspace, 1, "failed");
      const firstRecords = readExecutionRecords(workspace.id);
      const target = json(runReview(root, "target"));
      expect(target).toEqual(captureReviewTarget(workspace));
      const first = report(workspace, 1, "revise");
      const firstFile = inputFile(stateDir, "first.json", first);
      const stored = json(runReview(root, "record", "--file", firstFile));
      expect(stored.duplicate).toBe(false);
      const failed = json(runReview(root, "summary", "--task", "c2c_review_cli"));
      expect(failed.items).toHaveLength(1);
      expect(failed.items[0].verdict).toBe("revise");
      expect(failed.items[0].record.nextAction.action).toBe("Correct only the exported answer");
      expect(readExecutionRecords(workspace.id)).toEqual(firstRecords);

      write(root, "src/index.ts", "export const answer = 42;\n");
      execution(workspace, 2);
      const allRecords = readExecutionRecords(workspace.id);
      const secondFile = inputFile(stateDir, "second.json", report(workspace, 2));
      const accepted = json(runReview(root, "record", "--file", secondFile));
      const repeated = json(runReview(root, "record", "--file", secondFile));
      expect(repeated.duplicate).toBe(true);
      expect(repeated.record.id).toBe(accepted.record.id);
      const summary = json(runReview(root, "summary", "--task", "c2c_review_cli", "--limit", "1"));
      expect(summary.items).toHaveLength(1);
      expect(summary.items[0].record.taskId).toBe("c2c_review_cli");
      expect(summary.items[0].record.iteration).toBe(2);
      expect(summary.items[0].verdict).toBe("accept");
      expect(readExecutionRecords(workspace.id)).toEqual(allRecords);
      expect(fs.readFileSync(sessionFile(workspace.id), "utf8")).toBe(sessionBefore);
    });
  }, 20_000);

  it("deduplicates genuine user choices and records an answer without auto accepting or resuming the task", () => {
    withEnvironment(({ root, stateDir, workspace }) => {
      execution(workspace, 1);
      const review = {
        ...report(workspace, 1, "user_decision"),
        question: { key: "release", text: "Release this result today?", recommendation: "Review the preview first" },
      };
      const file = inputFile(stateDir, "question.json", review);
      json(runReview(root, "record", "--file", file));
      json(runReview(root, "record", "--file", file));
      const inbox = json(runReview(root, "inbox"));
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0].text).toBe("Release this result today?");
      const before = readExecutionRecords(workspace.id);
      const decision = inputFile(stateDir, "decision.json", { questionId: inbox.items[0].id, answer: "Keep the result for preview review" });
      json(runReview(root, "decide", "--file", decision));
      expect(json(runReview(root, "inbox")).items).toEqual([]);
      const current = json(runReview(root, "summary", "--task", "c2c_review_cli")).items[0];
      expect(current.answered).toBe(true);
      expect(current.verdict).not.toBe("accept");
      expect(readExecutionRecords(workspace.id)).toEqual(before);
    });
  }, 20_000);

  it("rejects malformed, oversized and invalid review input before persisting any report", () => {
    withEnvironment(({ root, stateDir }) => {
      const invalidFiles = [
        write(stateDir, "malformed.json", "{\"taskId\":"),
        write(stateDir, "oversized.json", " ".repeat(256 * 1024 + 1)),
        inputFile(stateDir, "invalid.json", { taskId: "c2c_review_cli", iteration: -1 }),
      ];
      for (const file of invalidFiles) {
        const result = runReview(root, "record", "--file", file);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).ok).toBe(false);
      }
      expect(json(runReview(root, "summary")).items).toEqual([]);
      expect(json(runReview(root, "inbox")).items).toEqual([]);
    });
  }, 15_000);

  it("marks an accepted result stale after source changes and rejects unknown question IDs", () => {
    withEnvironment(({ root, stateDir, workspace }) => {
      execution(workspace, 1);
      const file = inputFile(stateDir, "review.json", report(workspace, 1));
      json(runReview(root, "record", "--file", file));
      expect(json(runReview(root, "summary")).items[0].verdict).toBe("accept");
      write(root, "src/index.ts", "export const answer = 43;\n");
      expect(json(runReview(root, "summary")).items[0].verdict).toBe("stale");
      const decision = inputFile(stateDir, "unknown-question.json", { questionId: "0".repeat(64), answer: "Proceed" });
      const rejected = runReview(root, "decide", "--file", decision);
      expect(rejected.status).toBe(1);
      expect(json(runReview(root, "inbox")).items).toEqual([]);
    });
  }, 15_000);
});
