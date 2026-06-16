/**
 * publish.js — One-command release tool for TiRex RM.
 *
 * Usage:
 *   node publish.js               # auto patch bump + release
 *   node publish.js patch          # 1.6.0 → 1.6.1
 *   node publish.js minor          # 1.6.0 → 1.7.0
 *   node publish.js major          # 1.6.0 → 2.0.0
 *   node publish.js 1.6.0         # exact version
 *
 * What it does:
 *   1. Reads / bumps version in package.json
 *   2. Git commit (all dirty files)
 *   3. Git tag v<version>
 *   4. Push to origin (commit + tag)
 *   5. Run electron-builder --publish always
 *
 * Requires: gh CLI authenticated, or GH_TOKEN env var set.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PKG_PATH = path.join(__dirname, "package.json");

// ── helpers ──────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  return execSync(cmd, { stdio: "inherit", ...opts });
}

function runCapture(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function getToken() {
  const fromEnv = process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return runCapture("gh auth token");
  } catch {
    console.error(
      "\n[x] No GH_TOKEN env var and `gh auth token` failed.",
      "\n    Set GH_TOKEN or run `gh auth login` first.",
    );
    process.exit(1);
  }
}

function parseVersion(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`Invalid semver: ${v}`);
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
}

function bump(current, type) {
  const [major, minor, patch] = parseVersion(current);
  switch (type) {
    case "major": return `${major + 1}.0.0`;
    case "minor": return `${major}.${minor + 1}.0`;
    case "patch": return `${major}.${minor}.${patch + 1}`;
    default: return type; // assume it is an explicit version
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const bumpType = process.argv[2] || "patch";

  // 1. Read / bump version
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
  const oldVersion = pkg.version;
  const newVersion = bump(oldVersion, bumpType);

  if (newVersion === oldVersion) {
    console.log(`[Publish] Version unchanged (${oldVersion}), skipping bump.`);
  } else {
    console.log(`[Publish] ${oldVersion} → ${newVersion}`);
    pkg.version = newVersion;
    fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");
  }

  // 2. Git commit all dirty files
  const status = runCapture("git status --porcelain").trim();
  if (status) {
    const commitMsg = `Release v${newVersion}`;
    run(`git add -A`);
    run(`git commit -m "${commitMsg}"`);
  } else if (newVersion !== oldVersion) {
    run(`git commit -am "Release v${newVersion}"`);
  } else {
    console.log("[Publish] No changes to commit.");
  }

  // 3. Tag
  const tag = `v${newVersion}`;
  try { runCapture(`git tag -d ${tag} 2>/dev/null`); } catch {}
  run(`git tag ${tag}`);

  // 4. Push
  const token = getToken();
  const remote = `https://Difz25x:${token}@github.com/Difz25x/tirex-rm.git`;
  run(`git push --force "${remote}" main`);
  run(`git push --force "${remote}" ${tag}`);

  // 5. Fix local remote URL back to no-token form for safety
  try { run(`git remote set-url origin "${remote}" 2>/dev/null`); } catch {}

  // 6. Build + publish
  const cmd = `npx electron-builder --win --x64 --publish always`;
  run(cmd, { env: { ...process.env, GH_TOKEN: token } });

  console.log(`\n[Publish] ✅ v${newVersion} released!`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
