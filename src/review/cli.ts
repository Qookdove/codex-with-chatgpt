import fs from "node:fs";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { Workspace } from "../workspace/manager.js";
import {
  captureReviewTarget,
  recordDecision,
  recordReview,
  reviewInbox,
  reviewSummary,
} from "./manager.js";

const MAX_INPUT_BYTES = 256 * 1024;
interface ReviewOptions {
  workspace?: string;
  json?: boolean;
  file?: string;
  task?: string;
  limit?: number;
  offset?: number;
}

function readInput(file: string): unknown {
  const resolved = path.resolve(file);
  const fd = fs.openSync(resolved, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) {
      throw new Error("Review input must be a JSON file of at most 256 KiB.");
    }
    const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > MAX_INPUT_BYTES) throw new Error("Review input exceeds 256 KiB.");
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function limit(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 50) {
    throw new InvalidArgumentError("must be an integer between 1 and 50");
  }
  return Number(value);
}

function offset(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError("must be a non-negative safe integer");
  }
  return Number(value);
}

/** Local-only writes. The remote connector exposes review reads only. */
export function registerReviewCommands(program: Command): void {
  const review = program.command("review").description("Record and inspect the existing GPT review loop");
  const action = (
    run: (workspace: Workspace, opts: ReviewOptions) => unknown | Promise<unknown>
  ) => async (opts: ReviewOptions) => {
    try {
      const workspace = new Workspace(path.resolve(opts.workspace ?? process.cwd()));
      const result = await run(workspace, opts);
      process.stdout.write(JSON.stringify(result, null, opts.json ? 0 : 2) + "\n");
    } catch (error) {
      // Schema errors can contain user-supplied data: expose issues, not input bodies.
      const message = error instanceof SyntaxError ? "Invalid JSON input." : error instanceof Error ? error.message : "Review operation failed.";
      if (opts.json) process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
      else process.stderr.write(message + "\n");
      process.exitCode = 1;
    }
  };
  const options = (command: Command): Command => command
    .option("-w, --workspace <path>")
    .option("--json", "machine-readable output", false);

  options(review.command("target").description("Capture the current target before reviewing"))
    .action(action((workspace) => captureReviewTarget(workspace)));

  options(review.command("record").description("Persist a detailed review without changing execution state"))
    .requiredOption("--file <path>", "review JSON file; never a C2C control message")
    .action(action((workspace, opts) => recordReview(workspace, readInput(opts.file!))));

  options(review.command("summary").description("Inspect latest review per task and its current validity"))
    .option("--task <id>", "existing task id")
    .option("--limit <n>", "maximum tasks (1-50)", limit, 20)
    .option("--offset <n>", "pagination offset", offset, 0)
    .action(action((workspace, opts) => reviewSummary(workspace, { taskId: opts.task, limit: opts.limit, offset: opts.offset })));

  options(review.command("inbox").description("Read unresolved user choices; evidence collection stays with agents"))
    .option("--limit <n>", "maximum questions (1-50)", limit, 20)
    .option("--offset <n>", "pagination offset", offset, 0)
    .action(action((workspace, opts) => reviewInbox(workspace, { limit: opts.limit, offset: opts.offset })));

  options(review.command("decide").description("Record an answer for an exact question; does not resume execution"))
    .requiredOption("--file <path>", "decision JSON: questionId and answer")
    .action(action((workspace, opts) => recordDecision(workspace, readInput(opts.file!))));
}
