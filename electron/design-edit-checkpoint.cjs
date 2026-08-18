const { spawn } = require("node:child_process");

function runGit(root, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", arguments_, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error((stderr || stdout || "Git command failed").trim().slice(-6000))));
  });
}

async function beginDesignEditCheckpoint(root, now = new Date()) {
  const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]).catch(() => "false");
  if (inside !== "true") throw new Error("Visual editing requires the connected project to be a Git repository");
  const status = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) throw new Error("Commit or stash the connected project's existing changes before starting a visual edit");
  const originalBranch = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
  if (!originalBranch) throw new Error("Visual editing requires a named Git branch, not a detached HEAD");
  const startCommit = await runGit(root, ["rev-parse", "HEAD"]);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").toLowerCase();
  const branchName = `ui-sync/design-edit-${stamp}`;
  await runGit(root, ["switch", "-c", branchName]);
  return { root, originalBranch, startCommit, branchName, commits: [] };
}

async function commitDesignEditIteration(checkpoint, iteration) {
  await runGit(checkpoint.root, ["add", "-A"]);
  const staged = await runGit(checkpoint.root, ["diff", "--cached", "--name-only"]);
  const changedFiles = staged.split("\n").map((value) => value.trim()).filter(Boolean);
  if (changedFiles.length === 0) throw new Error("Codex completed without changing source files");
  await runGit(checkpoint.root, ["commit", "-m", `UI Sync visual edit (iteration ${iteration})`]);
  const commit = await runGit(checkpoint.root, ["rev-parse", "HEAD"]);
  checkpoint.commits.push(commit);
  return { commit, changedFiles };
}

async function abortDesignEditCheckpoint(checkpoint) {
  await runGit(checkpoint.root, ["reset", "--hard", checkpoint.startCommit]);
  await runGit(checkpoint.root, ["switch", checkpoint.originalBranch]);
  await runGit(checkpoint.root, ["branch", "-D", checkpoint.branchName]);
}

async function resolveDesignEditCheckpoint(checkpoint, resolution) {
  if (resolution !== "accept" && resolution !== "reject") throw new Error("Unknown visual edit resolution");
  if (resolution === "reject") {
    await abortDesignEditCheckpoint(checkpoint);
    return;
  }
  const currentCommit = await runGit(checkpoint.root, ["rev-parse", "HEAD"]);
  await runGit(checkpoint.root, ["switch", checkpoint.originalBranch]);
  await runGit(checkpoint.root, ["merge", "--ff-only", currentCommit]);
  await runGit(checkpoint.root, ["branch", "-d", checkpoint.branchName]);
}

module.exports = {
  abortDesignEditCheckpoint,
  beginDesignEditCheckpoint,
  commitDesignEditIteration,
  resolveDesignEditCheckpoint,
  runGit
};
