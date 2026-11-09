import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import { executionRecordSchema, type ExecutionRecord } from "../execution/records.js";
import { readExecutionOutput } from "../execution/output.js";
import { Workspace } from "../workspace/manager.js";
import { runGit } from "../workspace/git.js";

const text = (max = 1000) => z.string().trim().min(1).max(max);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_BYTES = 128 * 1024;

export const reviewTargetSchema = z.object({
  commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  complete: z.boolean(),
}).strict();

const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), path: text(500) }).strict(),
  z.object({ kind: z.literal("execution-output"), outputId: z.number().int().positive() }).strict(),
]);

export const reviewInputSchema = z.object({
  taskId: text(200),
  iteration: z.number().int().nonnegative().safe(),
  goal: text(2000),
  priority: z.number().int().min(0).max(100).default(50),
  dependsOn: z.array(text(200)).max(100).default([]),
  target: reviewTargetSchema,
  criteria: z.array(z.object({
    id: text(100), description: text(1000), status: z.enum(["pass", "fail", "unknown"]),
    evidence: z.array(evidenceSchema).max(20),
  }).strict()).max(50),
  assessment: z.enum(["accept", "revise", "evidence_needed", "user_decision"]),
  summary: text(2000),
  nextAction: z.object({ action: text(1000), owner: text(200), resumeWhen: text(1000) }).strict(),
  uncertainties: z.array(text(1000)).max(30).default([]),
  question: z.object({ key: text(200), text: text(1000), recommendation: text(1000) }).strict().optional(),
}).strict();
export type ReviewInput = z.infer<typeof reviewInputSchema>;
export type ReviewTarget = z.infer<typeof reviewTargetSchema>;

export const reviewRecordSchema = reviewInputSchema.extend({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  executionFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;

export const decisionInputSchema = z.object({ questionId: text(64).regex(/^[a-f0-9]{64}$/), answer: text(2000) }).strict();
export const decisionRecordSchema = decisionInputSchema.extend({
  id: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().datetime(),
}).strict();
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

export const reviewViewSchema = z.object({
  record: reviewRecordSchema,
  verdict: z.enum(["accept", "revise", "evidence_needed", "user_decision", "stale"]),
  reasons: z.array(z.string()),
  questionId: z.string().nullable(), answered: z.boolean(), decision: decisionRecordSchema.nullable(), blockedBy: z.array(z.string()),
}).strict();
export type ReviewView = z.infer<typeof reviewViewSchema>;

export const inboxItemSchema = z.object({
  id: z.string(), taskId: z.string(), iteration: z.number().int().nonnegative(),
  text: z.string(), recommendation: z.string(), priority: z.number(), reviewId: z.string(),
}).strict();
export type InboxItem = z.infer<typeof inboxItemSchema>;


/** Full HEAD plus index and permitted working file bytes. No file bodies leave this function.
 * Restricted/unreadable changes make complete=false, so the fingerprint cannot authorize acceptance.
 * This is a review-time snapshot, not proof that an earlier command tested these exact bytes. */
export function captureReviewTarget(workspace: Workspace): ReviewTarget {
  const head = runGit(workspace.root, ["rev-parse", "--verify", "HEAD"]);
  const commit = head.ok && /^[a-f0-9]{40,64}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
  const index = runGit(workspace.root, ["ls-files", "--stage", "-z", "--", "."]);
  const changed = runGit(workspace.root, ["diff", "--relative", "--name-only", "-z", "HEAD", "--", "."]);
  const working = runGit(workspace.root, ["diff", "--relative", "--name-only", "-z", "--", "."]);
  const untracked = runGit(workspace.root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
  let complete = Boolean(commit && index.ok && changed.ok && working.ok && untracked.ok);
  const files = [...new Set([changed.stdout, working.stdout, untracked.stdout].join("\0").split("\0").filter(Boolean))].sort();
  const entries: unknown[] = [];
  let totalBytes = 0;
  if (files.length > 5000) complete = false;
  for (const rel of files.slice(0, 5000)) {
    try {
      const resolved = workspace.resolve(rel);
      const stat = fs.statSync(resolved.abs);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || totalBytes + stat.size > 32 * 1024 * 1024) {
        complete = false;
        entries.push([rel, "unreadable"]);
        continue;
      }
      totalBytes += stat.size;
      const original = fs.lstatSync(path.join(workspace.root, rel));
      const link = original.isSymbolicLink() ? fs.readlinkSync(path.join(workspace.root, rel)) : null;
      entries.push([rel, stat.mode, link, createHash("sha256").update(fs.readFileSync(resolved.abs)).digest("hex")]);
    } catch (error) {
      // Deleted files are represented by their absent bytes; restricted paths are never read.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entries.push([rel, "deleted"]);
      else { complete = false; entries.push([rel, "restricted"]); }
    }
  }
  return { commit, complete, fingerprint: digest([commit, index.stdout, entries]) };
}

function ledgerFile(workspace: Workspace, kind: "reviews" | "review-decisions"): string {
  const dir = ensureDir(path.join(getStateDir(), kind));
  return path.join(dir, `${workspace.id}.jsonl`);
}

function readLedger<S extends z.ZodTypeAny>(file: string, schema: S, label = "review"): z.output<S>[] {
  if (!fs.existsSync(file)) return [];
  if (fs.statSync(file).size > MAX_LEDGER_BYTES) throw new Error("Review ledger exceeds the supported size; archive it explicitly before continuing.");
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line, index) => {
    try { return schema.parse(JSON.parse(line)); }
    catch { throw new Error(`Invalid ${label} ledger record at line ${index + 1}; review is unavailable until repaired.`); }
  });
}

function appendLedger(file: string, record: unknown): void {
  const line = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(line) > MAX_REPORT_BYTES) throw new Error("Review record is too large.");
  if ((fs.existsSync(file) ? fs.statSync(file).size : 0) + Buffer.byteLength(line) > MAX_LEDGER_BYTES) throw new Error("Review ledger is full; archive it explicitly before continuing.");
  fs.appendFileSync(file, line, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows may not support chmod. */ }
}

function executionMap(workspace: Workspace): Map<string, ExecutionRecord> {
  const records = readLedger(path.join(getStateDir(), "executions", `${workspace.id}.jsonl`), executionRecordSchema, "execution");
  const latest = new Map<string, ExecutionRecord>();
  for (const record of records) latest.set(record.taskId, record);
  return latest;
}

async function withMutationLock<T>(workspace: Workspace, run: () => Promise<T>): Promise<T> {
  const lock = path.join(ensureDir(path.join(getStateDir(), "reviews")), `${workspace.id}.lock`);
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another review update is in progress; retry after it finishes. A crashed writer's lock must be inspected locally before removal.");
    throw error;
  }
  try { return await run(); }
  finally { fs.rmdirSync(lock); }
}

function captureEvidenceFingerprint(workspace: Workspace, input: ReviewInput): string {
  const entries = input.criteria.flatMap(c => c.evidence).map(evidence => {
    if (evidence.kind === "execution-output") {
      const output = readExecutionOutput(workspace.id, evidence.outputId);
      return output.ok ? { evidence, meta: output.meta, bodyHash: digest(output.text) } : { evidence, unavailable: output.error };
    }
    try {
      const resolved = workspace.resolve(evidence.path);
      const stat = fs.statSync(resolved.abs);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return { evidence, unavailable: true };
      return { evidence, bodyHash: createHash("sha256").update(fs.readFileSync(resolved.abs)).digest("hex") };
    } catch { return { evidence, unavailable: true }; }
  });
  return digest(entries);
}

export async function recordReview(workspace: Workspace, raw: unknown): Promise<{record: ReviewRecord; duplicate: boolean}> {
  return withMutationLock(workspace, async () => {
  const input = reviewInputSchema.parse(raw);
  if (new Set(input.criteria.map(c => c.id)).size !== input.criteria.length) throw new Error("Criterion ids must be unique.");
  if (input.dependsOn.includes(input.taskId)) throw new Error("A task cannot depend on itself.");
  if (input.assessment === "user_decision" && !input.question) throw new Error("user_decision requires a concrete question.");
  if (input.assessment !== "user_decision" && input.question) throw new Error("Questions are only allowed for user_decision assessments.");
  const execution = executionMap(workspace).get(input.taskId);
  const executionFingerprint = execution ? digest(execution) : null;
  const evidenceFingerprint = captureEvidenceFingerprint(workspace, input);
  const id = digest({ input, executionFingerprint, evidenceFingerprint });
  const file = ledgerFile(workspace, "reviews");
  const previous = readLedger(file, reviewRecordSchema).find(record => record.id === id);
  if (previous) return { record: previous, duplicate: true };
  const record = reviewRecordSchema.parse({ ...input, id, executionFingerprint, evidenceFingerprint, createdAt: new Date().toISOString() });
  // Validate references before publishing even when the proposed conclusion is not acceptance.
  // Gate failures stay visible in the projection; they do not silently convert into acceptance.
  await evaluate(workspace, record, captureReviewTarget(workspace), execution, []);
  appendLedger(file, record);
  return { record, duplicate: false };
  });
}

function questionIdFor(record: ReviewRecord): string | null {
  if (!record.question || record.assessment !== "user_decision") return null;
  // Ignore cosmetic report wording; changes to execution, target, criteria or the question reopen it.
  return digest({ taskId: record.taskId, iteration: record.iteration, target: record.target,
    executionFingerprint: record.executionFingerprint, evidenceFingerprint: record.evidenceFingerprint, criteria: record.criteria,
    question: record.question, goal: record.goal });
}

async function evaluate(workspace: Workspace, record: ReviewRecord, target: ReviewTarget,
  execution: ExecutionRecord | undefined, decisions: DecisionRecord[]): Promise<ReviewView> {
  const reasons: string[] = [];
  const questionId = questionIdFor(record);
  const decision = (questionId ? decisions.find(d => d.questionId === questionId) : undefined) ?? null;
  const answered = Boolean(decision);
  let stale = false;
  let failed = false;
  let missing = false;
  if (record.evidenceFingerprint !== captureEvidenceFingerprint(workspace, record)) { stale = true; reasons.push("Referenced evidence changed or is no longer available."); }
  if (digest(record.target) !== digest(target)) { stale = true; reasons.push("Workspace target changed since this review."); }
  if (record.executionFingerprint !== (execution ? digest(execution) : null)) { stale = true; reasons.push("A different execution record is now current for this task."); }
  if (!target.complete || !target.commit) { missing = true; reasons.push("The current Git target could not be completely inspected."); }
  if (!execution || execution.iteration !== record.iteration) { missing = true; reasons.push("No matching current task/iteration execution record."); }
  else if (execution.exitStatus !== "ok") { failed = true; reasons.push("The current execution was not successful."); }
  // A successful free-form execution summary cannot override its linked failed command.
  if (execution?.iteration === record.iteration && execution.outputId !== undefined) {
    const output = readExecutionOutput(workspace.id, execution.outputId);
    if (!output.ok || output.meta.taskId !== record.taskId || output.meta.iteration !== record.iteration || !output.text.trim() || output.meta.exitCode === null) {
      missing = true; reasons.push("The execution's linked output is unavailable, mismatched or lacks an exit code.");
    } else if (output.meta.exitCode !== 0) {
      failed = true; reasons.push("The execution's linked command failed.");
    }
  }
  if (record.criteria.length === 0) { missing = true; reasons.push("No completion criteria were supplied."); }
  for (const criterion of record.criteria) {
    if (criterion.status === "fail") { failed = true; reasons.push(`Criterion ${criterion.id} failed.`); }
    if (criterion.status === "unknown" || criterion.evidence.length === 0) { missing = true; reasons.push(`Criterion ${criterion.id} needs evidence.`); }
    for (const evidence of criterion.evidence) {
      if (evidence.kind === "workspace") {
        try {
          const {abs} = workspace.resolve(evidence.path);
          if (fs.statSync(abs).size > 8 * 1024 * 1024) throw new Error("Evidence file exceeds review size limit.");
          await workspace.readFile(evidence.path, { maxLines: 1 });
        }
        catch { missing = true; reasons.push(`Criterion ${criterion.id} refers to an unavailable workspace file.`); }
      } else {
        const output = readExecutionOutput(workspace.id, evidence.outputId);
        if (!output.ok || output.meta.taskId !== record.taskId || output.meta.iteration !== record.iteration || !output.text.trim()) {
          missing = true; reasons.push(`Criterion ${criterion.id} refers to missing, restricted or mismatched execution output.`);
        } else if (output.meta.exitCode !== 0) {
          if (output.meta.exitCode === null) { missing = true; reasons.push(`Criterion ${criterion.id} has output with no exit code.`); }
          else { failed = true; reasons.push(`Criterion ${criterion.id} refers to a failed command.`); }
        }
      }
    }
  }
  let verdict: ReviewView["verdict"];
  if (stale) verdict = "stale";
  else if (failed || record.assessment === "revise") verdict = "revise";
  else if (missing) verdict = "evidence_needed";
  else if (record.assessment === "user_decision") {
    verdict = answered ? "evidence_needed" : "user_decision";
    if (answered) reasons.push("The user question was answered; reassess the task before accepting or executing.");
  } else if (missing || record.assessment === "evidence_needed" || record.uncertainties.length) verdict = "evidence_needed";
  else verdict = "accept";
  return { record, verdict, reasons, questionId: verdict === "stale" ? null : questionId, answered: verdict === "stale" ? false : answered, decision: verdict === "stale" ? null : decision, blockedBy: [] };
}

async function allReviewViews(workspace: Workspace): Promise<{target: ReviewTarget; items: ReviewView[]}> {
  const target = captureReviewTarget(workspace);
  const records = readLedger(ledgerFile(workspace, "reviews"), reviewRecordSchema);
  const decisions = readLedger(ledgerFile(workspace, "review-decisions"), decisionRecordSchema);
  const latest = new Map<string, ReviewRecord>();
  for (const record of records) latest.set(record.taskId, record);
  const executions = executionMap(workspace);
  const views = await Promise.all([...latest.values()].map(record => evaluate(workspace, record, target, executions.get(record.taskId), decisions)));
  const byTask = new Map(views.map(view => [view.record.taskId, view]));
  const accepted = new Map<string, boolean>();
  function dependencyAccepted(id: string, visiting = new Set<string>()): boolean {
    if (accepted.has(id)) return accepted.get(id)!;
    const view = byTask.get(id);
    if (!view || view.verdict !== "accept" || visiting.has(id)) return false;
    const next = new Set(visiting).add(id);
    const result = view.record.dependsOn.every(dependency => dependencyAccepted(dependency, next));
    accepted.set(id, result);
    return result;
  }
  // Resolve against the original gate results before updating projected verdicts.
  for (const view of views) dependencyAccepted(view.record.taskId);
  for (const view of views) {
    view.blockedBy = view.record.dependsOn.filter(id => !accepted.get(id));
    if (view.verdict === "accept" && view.blockedBy.length) {
      view.verdict = "evidence_needed";
      view.reasons.push("Dependencies are unresolved; this task cannot be accepted yet.");
    }
  }
  // Dependency-first order without inventing execution authority. Cycles remain visibly blocked.
  const ordered: ReviewView[] = [];
  const remaining = [...views].sort((a,b) => b.record.priority - a.record.priority || a.record.taskId.localeCompare(b.record.taskId));
  while (remaining.length) {
    const ready = remaining.findIndex(view => !view.record.dependsOn.some(id => remaining.some(v => v.record.taskId === id)));
    ordered.push(...remaining.splice(ready < 0 ? 0 : ready, 1));
  }
  return { target, items: ordered };
}

function page<T>(items: T[], opts: {limit?: number; offset?: number}) {
  const limit = z.number().int().min(1).max(50).parse(opts.limit ?? 20);
  const offset = z.number().int().nonnegative().safe().parse(opts.offset ?? 0);
  const selected = items.slice(offset, offset + limit);
  const hasMore = offset + selected.length < items.length;
  return { items: selected, hasMore, nextOffset: hasMore ? offset + selected.length : null };
}

export async function reviewSummary(workspace: Workspace, opts: {taskId?: string; limit?: number; offset?: number} = {}): Promise<{target: ReviewTarget; items: ReviewView[]; hasMore: boolean; nextOffset: number | null}> {
  const { target, items } = await allReviewViews(workspace);
  return { target, ...page(items.filter(v => !opts.taskId || v.record.taskId === opts.taskId), opts) };
}

export async function reviewInbox(workspace: Workspace, opts: {limit?: number; offset?: number} = {}): Promise<{items: InboxItem[]; hasMore: boolean; nextOffset: number | null}> {
  const { items } = await allReviewViews(workspace);
  // Filter before paginating: unrelated reviews must never hide a pending question.
  const questions: InboxItem[] = items.filter(v => v.verdict === "user_decision" && v.questionId && !v.answered).map(v => ({
    id: v.questionId!, taskId: v.record.taskId, iteration: v.record.iteration,
    text: v.record.question!.text, recommendation: v.record.question!.recommendation,
    priority: v.record.priority, reviewId: v.record.id,
  }));
  return page(questions, opts);
}

export async function recordDecision(workspace: Workspace, raw: unknown): Promise<{decision: DecisionRecord; duplicate: boolean}> {
  return withMutationLock(workspace, async () => {
    const input = decisionInputSchema.parse(raw);
    const file = ledgerFile(workspace, "review-decisions");
    const decisions = readLedger(file, decisionRecordSchema);
    const { items } = await allReviewViews(workspace);
    const current = items.find(item => item.questionId === input.questionId && (item.verdict === "user_decision" || item.answered));
    if (!current) throw new Error("Question is not currently pending; refresh the review inbox.");
    const previous = decisions.find(d => d.questionId === input.questionId);
    if (previous) {
      if (previous.answer !== input.answer) throw new Error("This question already has a different answer; submit a new review context to reopen it.");
      return { decision: previous, duplicate: true };
    }
    const decision = decisionRecordSchema.parse({ ...input, id: digest(input), createdAt: new Date().toISOString() });
    appendLedger(file, decision);
    return { decision, duplicate: false };
  });
}
