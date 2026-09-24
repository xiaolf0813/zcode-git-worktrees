#!/usr/bin/env node
// PreToolUse containment guard: a session (or subagent) rooted inside a linked
// worktree of a repo may not point file-edit tools at that repo's main
// checkout. Structured read tools (Read/Glob/Grep/NotebookRead) are policed
// the same way; a Glob/Grep with no path defaults to cwd (the worktree) and
// is allowed. Deliberately identity-free — subagents get session ids unrelated
// to their parent's, so git worktree topology (ZCODE_PROJECT_DIR + git
// rev-parse) is used instead of session bindings. Bash is NOT policed here
// (covered by injected instructions, like the auto-session guard); the guard
// fails open on every error.
import { readFile, realpath } from "node:fs/promises";
import { resolve as resolvePath, dirname, basename, join } from "node:path";
import * as git from "../../mcp/lib/git.mjs";

// Per-repo opt-out in .zcode/worktree.json ("mainCheckoutGuard": false).
async function mainCheckoutGuardOff(mainPath) {
  try {
    const cfg = JSON.parse(
      await readFile(join(mainPath, ".zcode", "worktree.json"), "utf8")
    );
    if (cfg && cfg.mainCheckoutGuard === false) return true;
  } catch {
    /* absent or invalid → no opt-out */
  }
  return false;
}

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "ApplyPatch", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead"]);

function readStdin() {
  return new Promise((resolvePromise) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolvePromise(data));
    process.stdin.on("error", () => resolvePromise(""));
    setTimeout(() => resolvePromise(data), 2000).unref?.();
  });
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      continue: false,
      reason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
}

// Canonicalize even when the target does not exist yet (new files are the
// common Write case): resolve the deepest existing ancestor and rejoin the
// rest, so lexical (/var/…) and canonical (/private/var/…) prefixes compare.
async function canonicalize(p) {
  let cur = p;
  const tail = [];
  for (let hops = 0; hops < 64; hops++) {
    try {
      return join(await realpath(cur), ...tail);
    } catch (err) {
      if (err.code !== "ENOENT") return p;
      tail.unshift(basename(cur));
      const parent = dirname(cur);
      if (parent === cur) return p;
      cur = parent;
    }
  }
  return p;
}

async function main() {
  let input = {};
  try {
    input = JSON.parse((await readStdin()).trim() || "{}");
  } catch {
    return;
  }
  const isRead = READ_TOOLS.has(input.tool_name);
  if (!EDIT_TOOLS.has(input.tool_name) && !isRead) return;
  const toolInput = input.tool_input || {};
  const filePath =
    toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  if (typeof filePath !== "string" || filePath.length === 0) return;

  const cwdRaw =
    process.env.ZCODE_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const cwd = await realpath(cwdRaw).catch(() => cwdRaw);

  let repo;
  try {
    repo = await git.resolveMainRepo(cwd);
  } catch {
    return;
  }
  const mainPath = await realpath(repo.mainPath).catch(() => repo.mainPath);
  const rooted = await realpath(repo.currentWorktree).catch(
    () => repo.currentWorktree
  );
  // Police only sessions rooted in a linked worktree; sessions rooted in the
  // main checkout itself (or a bare anchor) work normally — the auto-session
  // guard owns those.
  if (!rooted || rooted === mainPath || rooted.startsWith(mainPath + "/"))
    return;

  if (await mainCheckoutGuardOff(mainPath)) return;

  const abs = resolvePath(cwd, filePath); // handles relative and absolute
  const canonical = await canonicalize(abs);
  const inMain =
    canonical === mainPath || canonical.startsWith(mainPath + "/");
  if (!inMain) return; // edits inside the worktree (or anywhere else) are fine

  const reason = isRead
    ? `Main-checkout containment: this session is rooted in the linked worktree ${rooted}, ` +
      `so the main checkout (${mainPath}) is off-limits to reads — its working files may belong ` +
      `to a different branch, and reading them would poison the analysis with stale code. ` +
      `Work from the worktree's own files; when you need to compare against main, use git — ` +
      `\`git diff\` and \`git log\` read the shared object store, not the main checkout's working files. ` +
      `To lift the guard for this repo entirely, set "mainCheckoutGuard": false in ${mainPath}/.zcode/worktree.json.`
    : `Main-checkout containment: this session is rooted in the linked worktree ${rooted}, ` +
      `so the main checkout (${mainPath}) is protected from edits made here. ` +
      `Make this edit inside the worktree, or run it from a session rooted in the main checkout. ` +
      `To lift the guard for this repo entirely, set "mainCheckoutGuard": false in ${mainPath}/.zcode/worktree.json.`;
  return deny(reason);
}

main().catch(() => {
  // fail open — never block a tool because the guard itself errored
});
