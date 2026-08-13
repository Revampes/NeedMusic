#!/usr/bin/env node
/**
 * deploy-web.mjs — publish the built web app (dist-web) to the gh-pages branch.
 *
 * Usage:
 *   npm run build:web        # just build (outputs to dist-web/)
 *   npm run deploy:web       # build + deploy to gh-pages (what you want)
 *
 * The gh-pages branch is the GitHub Pages deployment branch. It only contains
 * the compiled static site (index.html + assets/), not the source. The script:
 *
 *   1. requires dist-web/index.html (run the build first, or use deploy:web)
 *   2. resolves the gh-pages worktree (reuses an existing one, e.g.
 *      ../NeedMusic-pages, or creates a sibling worktree if missing)
 *   3. replaces the worktree contents with the dist-web build (+ .nojekyll)
 *   4. commits and pushes to origin gh-pages
 *
 * Requires: git on PATH. Safe to re-run — it only touches the gh-pages branch.
 */

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distWeb = path.join(repoRoot, "dist-web");
const REMOTE = "origin";
const BRANCH = "gh-pages";

/** `--dry-run` stages everything but does not commit or push. */
const DRY_RUN = process.argv.includes("--dry-run");

const run = (cmd, opts = {}) =>
  execSync(cmd, { cwd: repoRoot, stdio: "inherit", ...opts });

function sh(cmd) {
  return execSync(cmd, { cwd: repoRoot, encoding: "utf8" }).trim();
}

/** Copy a directory's contents (files + subdirs) into `dest` (created if needed). */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

/** Find the existing worktree path for the gh-pages branch, if any. */
function findGhPagesWorktree() {
  const out = sh("git worktree list --porcelain");
  for (const block of out.split(/\n{2,}/)) {
    const lines = block.split("\n");
    const worktree = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    const branch = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length);
    if (worktree && branch === `refs/heads/${BRANCH}`) return worktree;
  }
  return null;
}

/** Ensure a local gh-pages branch exists (created from the remote if available). */
function ensureBranchExists() {
  try {
    sh(`git rev-parse --verify ${BRANCH}`);
    return;
  } catch { /* missing locally — fall through */ }
  try {
    // Quiet: these can fail legitimately when the branch has never been pushed.
    run(`git fetch ${REMOTE} ${BRANCH}`, { stdio: "pipe" });
    run(`git branch ${BRANCH} ${REMOTE}/${BRANCH}`, { stdio: "pipe" });
  } catch { /* no remote branch either — will create an orphan below */ }
}

function main() {
  const indexPath = path.join(distWeb, "index.html");
  if (!fs.existsSync(indexPath)) {
    console.error(
      `\n[deploy:web] ${path.relative(repoRoot, indexPath)} not found.\n` +
        "Run `npm run build:web` first, or use `npm run deploy:web` which builds then deploys.\n"
    );
    process.exit(1);
  }

  console.log(`[deploy:web] Deploying dist-web → ${BRANCH} branch`);
  ensureBranchExists();

  // Reuse an existing worktree (the user keeps one at ../NeedMusic-pages), or
  // create a sibling worktree next to the repo.
  let pagesDir = findGhPagesWorktree();
  if (!pagesDir) {
    pagesDir = `${repoRoot}-pages`;
    try {
      run(`git worktree add "${pagesDir}" ${BRANCH}`, { stdio: "pipe" });
      console.log(`[deploy:web] Created worktree at ${pagesDir}`);
    } catch {
      // Branch exists nowhere — create an orphan gh-pages worktree.
      run(`git worktree add --orphan -b ${BRANCH} "${pagesDir}"`, { stdio: "pipe" });
      console.log(`[deploy:web] Created orphan worktree at ${pagesDir}`);
    }
  } else {
    console.log(`[deploy:web] Using existing worktree at ${pagesDir}`);
  }

  // Sync with the remote (non-fatal on first deploy, when the remote branch
  // does not exist yet).
  try {
    run(`git -C "${pagesDir}" reset --hard ${REMOTE}/${BRANCH}`, { stdio: "pipe" });
  } catch { /* remote branch not available yet — keep local state */ }

  // Replace contents: keep only .git (a file pointer in a linked worktree).
  console.log("[deploy:web] Replacing contents with the fresh build…");
  for (const entry of fs.readdirSync(pagesDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    fs.rmSync(path.join(pagesDir, entry.name), { recursive: true, force: true });
  }
  copyDir(distWeb, pagesDir);
  // GitHub Pages skips Jekyll processing with an empty .nojekyll marker.
  fs.writeFileSync(path.join(pagesDir, ".nojekyll"), "");

  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version || "web";
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const commitMsg = `Deploy web app v${version} (${stamp})`;
  run(`git -C "${pagesDir}" add -A`);
  const changed = sh(`git -C "${pagesDir}" status --porcelain`).length > 0;
  if (!changed) {
    console.log("[deploy:web] Nothing changed — already up to date.");
    return;
  }
  if (DRY_RUN) {
    console.log(`[deploy:web] --dry-run: would commit "${commitMsg}" and push ${REMOTE}/${BRANCH}.`);
    console.log(`[deploy:web] Staged changes in ${pagesDir}:`);
    run(`git -C "${pagesDir}" status --short`);
    return;
  }
  run(`git -C "${pagesDir}" commit -m "${commitMsg}"`);
  run(`git -C "${pagesDir}" push ${REMOTE} ${BRANCH}`);

  const m = (sh(`git config --get remote.origin.url`) || "")
    .match(/(?:github\.com[:/])([^/]+)\/([^/.]+?)(?:\.git)?/);
  const owner = m?.[1] ?? "<owner>";
  const repo = m?.[2] ?? "<repo>";
  console.log(`[deploy:web] ✅ Pushed to ${owner}/${repo}#${BRANCH}`);
  console.log(`[deploy:web] Live at https://${owner}.github.io/${repo}/ (usually 1–2 min)`);
}

main();
