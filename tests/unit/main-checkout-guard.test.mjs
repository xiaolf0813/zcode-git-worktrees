// PreToolUse main-checkout containment guard: denies file-edit tools pointing
// at a repo's main checkout from any session rooted in one of its linked
// worktrees — with no session identity and no store dependency (subagents
// included); allows everything else; fails open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { makeRepo, tmpDir, git as gitRun } from "../fixtures/helpers.mjs";

const guardPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../plugins/git-worktrees/hooks/scripts/main-checkout-guard.mjs"
);

function runGuard(env, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [guardPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    setTimeout(() => child.kill(), 45000).unref();
  });
}

// Plain git fixtures only — no StateStore/Ops, and ZCODE_WORKTREE_STORE_ROOT
// is deliberately never set: the guard must work from topology alone.
async function setupRepoWithWorktree() {
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const worktree = `${repo}-wt`; // nonexistent sibling path
  gitRun(repo, "worktree", "add", worktree, "-b", "wt/one");
  return { repo, worktree };
}

test("containment guard denies Write into the main checkout from a worktree-rooted session", async () => {
  const { repo, worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    {
      tool_name: "Write",
      tool_input: { file_path: join(repo, "README.md"), content: "x" },
    }
  );
  assert.equal(res.code, 0);
  const decision = JSON.parse(res.out);
  assert.equal(decision.continue, false);
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(decision.reason, /main checkout/);
  assert.ok(decision.reason.includes(repo), "reason names the protected repo");
});

test("containment guard denies new files (nonexistent paths) in the main checkout", async () => {
  const { repo, worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    {
      tool_name: "Write",
      tool_input: { file_path: join(repo, "src", "new-file.js"), content: "x" },
    }
  );
  const decision = JSON.parse(res.out);
  assert.equal(decision.continue, false);
});

test("containment guard allows writes inside the worktree", async () => {
  const { worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    {
      tool_name: "Write",
      tool_input: { file_path: join(worktree, "src", "ok.js"), content: "x" },
    }
  );
  assert.equal(res.out, "", "worktree write allowed (no output)");
});

test("containment guard resolves relative paths against the worktree cwd", async () => {
  const { worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    {
      tool_name: "Write",
      tool_input: { file_path: "README.md", content: "x" },
    }
  );
  assert.equal(res.out, "", "relative path lands inside the worktree → allowed");
});

test("containment guard allows writes outside the repo entirely", async () => {
  const { worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    {
      tool_name: "Write",
      tool_input: { file_path: join(tmpDir(), "unrelated.txt"), content: "x" },
    }
  );
  assert.equal(res.out, "", "write outside the repo allowed");
});

test("containment guard never polices sessions rooted in the main checkout", async () => {
  const { repo } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: repo },
    {
      tool_name: "Write",
      tool_input: { file_path: join(repo, "README.md"), content: "x" },
    }
  );
  assert.equal(res.out, "", "main-rooted session editing main checkout allowed");
});

test("containment guard allows main-rooted sessions to edit their own worktrees", async () => {
  const { repo, worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: repo },
    {
      tool_name: "Write",
      tool_input: { file_path: join(worktree, "src", "ok.js"), content: "x" },
    }
  );
  assert.equal(res.out, "", "main-rooted session editing worktree allowed");
});

test("containment guard denies NotebookEdit via notebook_path", async () => {
  const { repo, worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    {
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: join(repo, "notebook.ipynb") },
    }
  );
  const decision = JSON.parse(res.out);
  assert.equal(decision.continue, false);
});

test("containment guard ignores non-edit tools", async () => {
  const { worktree } = await setupRepoWithWorktree();
  const bash = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    { tool_name: "Bash", tool_input: { command: "echo hi" } }
  );
  assert.equal(bash.out, "", "Bash not policed");

  const read = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    { tool_name: "Read", tool_input: { file_path: "/etc/hostname" } }
  );
  assert.equal(read.out, "", "Read always allowed");
});

test("containment guard fails open on missing/invalid input", async () => {
  const { worktree } = await setupRepoWithWorktree();
  const garbage = await runGuard({ ZCODE_PROJECT_DIR: worktree }, "garbage{");
  assert.equal(garbage.code, 0);
  assert.equal(garbage.out, "");
  const noPath = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    { tool_name: "Write", tool_input: {} }
  );
  assert.equal(noPath.out, "");
});

test("containment guard honors the per-repo mainCheckoutGuard opt-out", async () => {
  const { repo, worktree } = await setupRepoWithWorktree();
  mkdirSync(join(repo, ".zcode"), { recursive: true });
  writeFileSync(
    join(repo, ".zcode", "worktree.json"),
    JSON.stringify({ mainCheckoutGuard: false })
  );
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    {
      tool_name: "Write",
      tool_input: { file_path: join(repo, "README.md"), content: "x" },
    }
  );
  assert.equal(res.out, "", "repo opt-out → guard inactive");
});

test("containment guard works when the session cwd is a subdirectory of the worktree", async () => {
  const { repo, worktree } = await setupRepoWithWorktree();
  const sub = join(worktree, "src");
  mkdirSync(sub, { recursive: true });
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: sub },
    {
      tool_name: "Write",
      tool_input: { file_path: join(repo, "README.md"), content: "x" },
    }
  );
  const decision = JSON.parse(res.out);
  assert.equal(decision.continue, false, "subdir cwd still resolves to the worktree");
});

test("containment guard only protects the session's OWN main checkout", async () => {
  const { worktree } = await setupRepoWithWorktree();
  const other = tmpDir();
  makeRepo(other, { remote: false });
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    {
      tool_name: "Write",
      tool_input: { file_path: join(other, "README.md"), content: "x" },
    }
  );
  assert.equal(res.out, "", "unrelated repo not protected from this session");
});

// --- structured read tools: same containment, stale-code rationale ---

test("containment guard denies Read of a main-checkout file from a worktree-rooted session", async () => {
  const { repo, worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    { tool_name: "Read", tool_input: { file_path: join(repo, "README.md") } }
  );
  assert.equal(res.code, 0);
  const decision = JSON.parse(res.out);
  assert.equal(decision.continue, false);
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(decision.reason, /read/i, "reason is about reads");
  assert.match(
    decision.reason,
    /stale|different branch/,
    "reason explains the stale-code rationale"
  );
});

test("containment guard allows Read inside the worktree", async () => {
  const { worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    { tool_name: "Read", tool_input: { file_path: join(worktree, "README.md") } }
  );
  assert.equal(res.out, "", "worktree read allowed (no output)");
});

test("containment guard denies Grep targeting the main checkout", async () => {
  const { repo, worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    { tool_name: "Grep", tool_input: { pattern: "test", path: repo } }
  );
  const decision = JSON.parse(res.out);
  assert.equal(decision.continue, false);
});

test("containment guard allows Grep with no path (defaults to the worktree cwd)", async () => {
  const { worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    { tool_name: "Grep", tool_input: { pattern: "test" } }
  );
  assert.equal(res.out, "", "pathless Grep stays inside the worktree → allowed");
});

test("containment guard denies Glob targeting the main checkout", async () => {
  const { repo, worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    { tool_name: "Glob", tool_input: { pattern: "**/*.js", path: repo } }
  );
  const decision = JSON.parse(res.out);
  assert.equal(decision.continue, false);
});

test("containment guard allows Glob with no path (defaults to the worktree cwd)", async () => {
  const { worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    { tool_name: "Glob", tool_input: { pattern: "**/*.js" } }
  );
  assert.equal(res.out, "", "pathless Glob stays inside the worktree → allowed");
});

test("containment guard resolves Grep's relative path against the worktree cwd", async () => {
  const { worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    { tool_name: "Grep", tool_input: { pattern: "test", path: "src" } }
  );
  assert.equal(res.out, "", "relative path lands inside the worktree → allowed");
});

test("containment guard denies NotebookRead via notebook_path", async () => {
  const { repo, worktree } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    { tool_name: "NotebookRead", tool_input: { notebook_path: join(repo, "notebook.ipynb") } }
  );
  const decision = JSON.parse(res.out);
  assert.equal(decision.continue, false);
});

test("containment guard never polices reads from main-rooted sessions", async () => {
  const { repo } = await setupRepoWithWorktree();
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: repo },
    { tool_name: "Read", tool_input: { file_path: join(repo, "README.md") } }
  );
  assert.equal(res.out, "", "main-rooted session reading main checkout allowed");
});

test("containment guard read opt-out: mainCheckoutGuard false lifts reads too", async () => {
  const { repo, worktree } = await setupRepoWithWorktree();
  mkdirSync(join(repo, ".zcode"), { recursive: true });
  writeFileSync(
    join(repo, ".zcode", "worktree.json"),
    JSON.stringify({ mainCheckoutGuard: false })
  );
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: worktree },
    { tool_name: "Read", tool_input: { file_path: join(repo, "README.md") } }
  );
  assert.equal(res.out, "", "one switch lifts read and write containment");
});

test("containment guard denies reads when the session cwd is a subdirectory of the worktree", async () => {
  const { repo, worktree } = await setupRepoWithWorktree();
  const sub = join(worktree, "src");
  mkdirSync(sub, { recursive: true });
  const res = await runGuard(
    { ZCODE_PROJECT_DIR: sub },
    { tool_name: "Read", tool_input: { file_path: join(repo, "README.md") } }
  );
  const decision = JSON.parse(res.out);
  assert.equal(decision.continue, false, "subdir cwd still resolves to the worktree");
});
