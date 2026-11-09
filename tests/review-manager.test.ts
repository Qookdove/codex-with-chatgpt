import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { captureReviewTarget, recordDecision, recordReview, reviewInbox, reviewSummary, type ReviewInput } from "../src/review/manager.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

let workspace: Workspace;
let root: string;
let state: string;
let oldState: string | undefined;

beforeEach(() => {
  oldState = process.env.C2C_STATE_DIR;
  root = makeTmpDir("review-workspace");
  state = makeTmpDir("review-state");
  process.env.C2C_STATE_DIR = state;
  makeGitRepo(root);
  workspace = new Workspace(root);
});
afterEach(() => {
  if (oldState === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = oldState;
  cleanup(root); cleanup(state);
});

function execution(taskId = "task-a", iteration = 1, exitStatus = "ok") {
  appendExecutionRecord(workspace.id, { taskId, iteration, changedFiles: 0,
    tests: "checked", exitStatus, timestamp: new Date().toISOString() });
}
function report(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    taskId: "task-a", iteration: 1, goal: "Keep the source correct", target: captureReviewTarget(workspace),
    priority: 50, dependsOn: [], assessment: "accept", summary: "The reviewer inspected the current source.",
    criteria: [{ id: "source", description: "The answer is 42", status: "pass", evidence: [{kind:"workspace",path:"src/index.ts"}] }],
    nextAction: {action:"Close this review",owner:"reviewer",resumeWhen:"Relevant code changes"}, uncertainties:[],
    ...overrides,
  };
}
async function latest() { return (await reviewSummary(workspace)).items[0]; }

describe("review acceptance gates", () => {
  it("accepts a matching reviewed execution without changing its execution or session state", async () => {
    execution();
    const before = fs.readFileSync(path.join(state,"executions",`${workspace.id}.jsonl`),"utf8");
    const saved = await recordReview(workspace, report());
    expect(saved.duplicate).toBe(false);
    expect((await latest()).verdict).toBe("accept");
    expect(fs.readFileSync(path.join(state,"executions",`${workspace.id}.jsonl`),"utf8")).toBe(before);
    expect(fs.existsSync(path.join(state,"sessions",`${workspace.id}.json`))).toBe(false);
  });
  it("does not turn exit zero alone or unknown criteria into acceptance", async () => {
    execution();
    await recordReview(workspace, report({criteria:[]}));
    expect((await latest()).verdict).toBe("evidence_needed");
    await recordReview(workspace, report({criteria:[{id:"test",description:"Check behavior",status:"unknown",evidence:[]}]}));
    expect((await latest()).verdict).toBe("evidence_needed");
    expect((await reviewInbox(workspace)).items).toEqual([]);
  });
  it("prioritizes failed evidence over a claimed acceptance", async () => {
    execution();
    const output = saveExecutionOutput(workspace.id,{command:"test",raw:"assertion failed",exitCode:1,taskId:"task-a",iteration:1});
    await recordReview(workspace,report({criteria:[{id:"test",description:"behavior",status:"pass",evidence:[{kind:"execution-output",outputId:output.id}]}]}));
    expect((await latest()).verdict).toBe("revise");
  });
  it("requires output to be released, readable and for this exact task and iteration", async () => {
    execution();
    const other = saveExecutionOutput(workspace.id,{command:"test",raw:"passed",exitCode:0,taskId:"other",iteration:1});
    const restricted = saveExecutionOutput(workspace.id,{command:"test",raw:"-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",exitCode:0,taskId:"task-a",iteration:1});
    expect(restricted.allowed).toBe(false);
    for (const outputId of [other.id, restricted.id, 123456]) {
      await recordReview(workspace,report({criteria:[{id:"test",description:"behavior",status:"pass",evidence:[{kind:"execution-output",outputId}]}]}));
      expect((await latest()).verdict).toBe("evidence_needed");
    }
  });
  it("permits readable successful output references", async () => {
    execution();
    const output = saveExecutionOutput(workspace.id,{command:"test",raw:"one passed",exitCode:0,taskId:"task-a",iteration:1});
    await recordReview(workspace,report({criteria:[{id:"test",description:"behavior",status:"pass",evidence:[{kind:"execution-output",outputId:output.id}]}]}));
    expect((await latest()).verdict).toBe("accept");
  });
  it("denies sensitive and outside-workspace evidence without disclosing the body", async () => {
    execution();
    write(root,".env","TOKEN=hidden_value");
    for (const filename of [".env", "../../outside"]) {
      await recordReview(workspace,report({criteria:[{id:"source",description:"evidence",status:"pass",evidence:[{kind:"workspace",path:filename}]}]}));
      const view = await latest();
      expect(view.verdict).toBe("evidence_needed");
      expect(JSON.stringify(view)).not.toContain("hidden_value");
    }
  });
  it("uses matching task records beyond the latest ten workspace executions", async () => {
    execution();
    for(let i=0;i<15;i++) execution(`other-${i}`);
    await recordReview(workspace, report());
    expect((await latest()).verdict).toBe("accept");
  });
  it("does not accept an unsuccessful execution or a mismatched iteration", async () => {
    execution("task-a",1,"failed");
    await recordReview(workspace,report());
    expect((await latest()).verdict).toBe("revise");
    execution("task-a",2);
    await recordReview(workspace,report());
    expect((await latest()).verdict).toBe("evidence_needed");
  });
});

describe("review freshness, deduplication and state integrity", () => {
  it("marks a previous review stale when dirty file bytes change with the same dirty flag", async () => {
    execution();
    write(root,"src/index.ts","export const answer = 43;\n");
    await recordReview(workspace,report());
    expect((await latest()).verdict).toBe("accept");
    write(root,"src/index.ts","export const answer = 44;\n");
    expect((await latest()).verdict).toBe("stale");
  });
  it("fingerprints staged changes and permitted untracked file bytes", () => {
    const first = captureReviewTarget(workspace);
    write(root,"new.txt","one");
    const second = captureReviewTarget(workspace);
    write(root,"new.txt","two");
    const third = captureReviewTarget(workspace);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(third.fingerprint).not.toBe(second.fingerprint);
    git(root,"add","new.txt");
    expect(captureReviewTarget(workspace).fingerprint).not.toBe(third.fingerprint);
  });
  it("marks an earlier review stale when a new execution arrives", async () => {
    execution();
    await recordReview(workspace,report());
    execution("task-a",2);
    expect((await latest()).verdict).toBe("stale");
  });
  it("deduplicates identical submissions and does not repeat the question", async () => {
    execution();
    const input=report({assessment:"user_decision",question:{key:"scope",text:"Choose scope",recommendation:"Keep scope"}});
    const first=await recordReview(workspace,input);
    const second=await recordReview(workspace,input);
    expect(second.duplicate).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect((await reviewInbox(workspace)).items).toHaveLength(1);
  });
  it("records an answer once, does not auto-accept, and reopens only with changed context", async () => {
    execution();
    const input=report({assessment:"user_decision",question:{key:"scope",text:"Choose scope",recommendation:"Keep scope"}});
    await recordReview(workspace,input);
    const id=(await reviewInbox(workspace)).items[0].id;
    expect((await recordDecision(workspace,{questionId:id,answer:"Keep scope"})).duplicate).toBe(false);
    expect((await recordDecision(workspace,{questionId:id,answer:"Keep scope"})).duplicate).toBe(true);
    expect((await reviewInbox(workspace)).items).toEqual([]);
    expect((await latest()).verdict).toBe("evidence_needed");
    expect((await latest()).decision?.answer).toBe("Keep scope");
    await recordReview(workspace,{...input,summary:"Cosmetic report edit"});
    expect((await reviewInbox(workspace)).items).toEqual([]);
    write(root,"src/index.ts","export const answer = 43;\n");
    await recordReview(workspace,report({assessment:"user_decision",question:input.question}));
    const newQuestion=(await reviewInbox(workspace)).items[0];
    expect(newQuestion.id).not.toBe(id);
  });
  it("rejects a stale question id and conflicting answers", async () => {
    execution();
    const input=report({assessment:"user_decision",question:{key:"scope",text:"Choose scope",recommendation:"Keep scope"}});
    await recordReview(workspace,input);
    const id=(await reviewInbox(workspace)).items[0].id;
    write(root,"hello.txt","changed");
    await expect(recordDecision(workspace,{questionId:id,answer:"yes"})).rejects.toThrow("not currently pending");
  });
  it("does not rerun execution when the next action is result redelivery", async () => {
    execution();
    await recordReview(workspace,report({nextAction:{action:"Redeliver existing result",owner:"transport",resumeWhen:"receipt observed"}}));
    expect((await latest()).record.nextAction.action).toBe("Redeliver existing result");
    expect(fs.readFileSync(path.join(state,"executions",`${workspace.id}.jsonl`),"utf8").trim().split("\n")).toHaveLength(1);
  });
  it("orders dependencies first and leaves missing dependencies explicitly blocked", async () => {
    execution("dependency"); execution("dependent");
    await recordReview(workspace,report({taskId:"dependent",priority:100,dependsOn:["dependency","unknown"]}));
    await recordReview(workspace,report({taskId:"dependency",priority:1}));
    const {items}=await reviewSummary(workspace);
    expect(items.map(v=>v.record.taskId)).toEqual(["dependency","dependent"]);
    expect(items[1].blockedBy).toEqual(["unknown"]);
  });
  it("fails closed on corrupt review ledger data", async () => {
    execution();
    await recordReview(workspace,report());
    fs.appendFileSync(path.join(state,"reviews",`${workspace.id}.jsonl`),"{broken}\n");
    await expect(reviewSummary(workspace)).rejects.toThrow("Invalid review ledger");
  });
  it("does not turn arbitrary task ids into filesystem paths", async () => {
    execution("../../other");
    await recordReview(workspace,report({taskId:"../../other"}));
    expect(fs.readdirSync(path.join(state,"reviews"))).toEqual([`${workspace.id}.jsonl`]);
  });
});

describe("review boundary regressions", () => {
  it("keeps a failed linked command from being hidden by successful workspace evidence", async () => {
    const output = saveExecutionOutput(workspace.id,{command:"test",raw:"assertion failed",exitCode:1,taskId:"task-a",iteration:1});
    appendExecutionRecord(workspace.id,{taskId:"task-a",iteration:1,changedFiles:0,tests:"claimed pass",exitStatus:"ok",timestamp:new Date().toISOString(),outputId:output.id,outputAvailable:true});
    await recordReview(workspace,report());
    expect((await latest()).verdict).toBe("revise");
  });
  it("does not escalate missing agent evidence into a user question", async () => {
    execution();
    await recordReview(workspace,report({criteria:[],assessment:"user_decision",question:{key:"approve",text:"Approve?",recommendation:"Approve"}}));
    expect((await latest()).verdict).toBe("evidence_needed");
    expect((await reviewInbox(workspace)).items).toEqual([]);
  });
  it("fails closed when the newest execution ledger line is corrupt", async () => {
    execution();
    await recordReview(workspace,report());
    fs.appendFileSync(path.join(state,"executions",`${workspace.id}.jsonl`),"{broken}\n");
    await expect(reviewSummary(workspace)).rejects.toThrow("Invalid execution ledger");
  });
  it("serializes writers before deduplication so concurrent calls cannot append twice", async () => {
    execution();
    const results = await Promise.allSettled([recordReview(workspace,report()),recordReview(workspace,report())]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const rejected=results.find(r=>r.status==="rejected") as PromiseRejectedResult;
    expect(rejected.reason.message).toContain("update is in progress");
    expect(fs.readFileSync(path.join(state,"reviews",`${workspace.id}.jsonl`),"utf8").trim().split("\n")).toHaveLength(1);
    expect((await recordReview(workspace,report())).duplicate).toBe(true);
  });
  it("fingerprints ignored evidence independently of the Git target", async () => {
    write(root,".gitignore","ignored.log\n");
    git(root,"add",".gitignore"); git(root,"commit","-m","ignore log");
    write(root,"ignored.log","first evidence");
    execution();
    const target=captureReviewTarget(workspace);
    await recordReview(workspace,report({criteria:[{id:"log",description:"evidence",status:"pass",evidence:[{kind:"workspace",path:"ignored.log"}]}]}));
    expect((await latest()).verdict).toBe("accept");
    write(root,"ignored.log","different evidence");
    expect(captureReviewTarget(workspace)).toEqual(target);
    expect((await latest()).verdict).toBe("stale");
  });
  it("filters user questions before paginating across more than 100 reviewed tasks", async () => {
    const basic=report();
    // Real Git snapshots for 102 tasks need extra process-startup time on Windows.
    for (let i=0;i<101;i++) {
      const taskId=`regular-${i}`;
      execution(taskId);
      await recordReview(workspace,{...basic,taskId,priority:100});
    }
    execution("question-task");
    await recordReview(workspace,report({taskId:"question-task",priority:0,assessment:"user_decision",question:{key:"scope",text:"Choose scope",recommendation:"Keep scope"}}));
    const inbox=await reviewInbox(workspace);
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].taskId).toBe("question-task");
    const first=await reviewSummary(workspace,{limit:50});
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(50);
    const second=await reviewSummary(workspace,{limit:50,offset:first.nextOffset!});
    expect(second.items).toHaveLength(50);
    await expect(reviewSummary(workspace,{limit:Number.NaN})).rejects.toThrow();
  },60000);
});

describe("nested workspace target scope", () => {
  it("tracks changed file bytes relative to a nested workspace rather than the repository root", async () => {
    write(root,"project/source.txt","first");
    git(root,"add","project/source.txt"); git(root,"commit","-m","nested project");
    const nested=new Workspace(path.join(root,"project"));
    write(root,"project/source.txt","second");
    const first=captureReviewTarget(nested);
    write(root,"project/source.txt","third");
    const second=captureReviewTarget(nested);
    expect(first.complete).toBe(true);
    expect(second.complete).toBe(true);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });
});

describe("dependency completion gate", () => {
  it("blocks acceptance through unresolved transitive dependencies and cycles", async () => {
    for (const id of ["a","b","c","cycle-a","cycle-b"]) execution(id);
    await recordReview(workspace,report({taskId:"a",dependsOn:["missing"]}));
    await recordReview(workspace,report({taskId:"b",dependsOn:["a"]}));
    await recordReview(workspace,report({taskId:"c",dependsOn:["b"]}));
    await recordReview(workspace,report({taskId:"cycle-a",dependsOn:["cycle-b"]}));
    await recordReview(workspace,report({taskId:"cycle-b",dependsOn:["cycle-a"]}));
    const {items}=await reviewSummary(workspace);
    for(const view of items) {
      expect(view.verdict).toBe("evidence_needed");
      expect(view.blockedBy).not.toEqual([]);
    }
  });
});
