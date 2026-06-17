/**
 * publish.js — One-command release tool for TiRex RM.
 *
 * Usage:
 *   node publish.js               # use package.json version as-is
 *   node publish.js patch          # 1.6.0 → 1.6.1
 *   node publish.js minor          # 1.6.0 → 1.7.0
 *   node publish.js major          # 1.6.0 → 2.0.0
 *   node publish.js 1.6.0         # exact version override
 *
 * What it does:
 *   1. Resolve version (bump or use current)
 *   2. Check if tag already exists (local + remote) — warns and asks
 *   3. Write version to package.json if bumped
 *   4. Git commit dirty files
 *   5. Git tag v<version>
 *   6. Force push to origin (commit + tag)
 *   7. Build with --publish never
 *   8. Delete stale GitHub release + tag ref (avoids 422 "already_exists")
 *   9. Create fresh release via API (target_commitish so GitHub creates tag atomically)
 *   10. Upload assets (exe, blockmap, zip)
 *
 * Requires: gh CLI authenticated, or GH_TOKEN env var set.
 * For interactive prompts: run in PowerShell/terminal (not headless).
 */

const { execSync } = require("child_process");
const https = require("https");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const PKG_PATH = path.join(__dirname, "package.json");
const OWNER = "Difz25x";
const REPO = "tirex-rm";
const GITHUB_API = "https://api.github.com";
const GITHUB_UPLOADS = "https://uploads.github.com";

// ── helpers ──────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
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
    default: return type; // assume explicit version string
  }
}

/**
 * Ask the user a yes/no question on the terminal.
 * Resolves true for 'y', false for anything else.
 */
function askYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

// ── GitHub API helpers ───────────────────────────────────────────────────────

function httpsRequest(method, url, token, body, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { "User-Agent": "tirex-publish", Authorization: `token ${token}` };
    if (body) {
      headers["Content-Length"] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
      if (contentType) headers["Content-Type"] = contentType;
    }
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}`));
          else resolve(data);
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function ghGet(path) {
  return (token) => httpsRequest("GET", `${GITHUB_API}${path}`, token);
}

function ghPost(path, json) {
  return (token) => httpsRequest("POST", `${GITHUB_API}${path}`, token, JSON.stringify(json), "application/json");
}

function ghDelete(path) {
  return (token) => httpsRequest("DELETE", `${GITHUB_API}${path}`, token);
}

/**
 * Delete stale release + git tag ref from GitHub.
 * Prevents 422 "already_exists" when tag_name was used before.
 */
async function cleanupStaleRelease(tag, token) {
  // Delete release
  try {
    const body = await ghGet(`/repos/${OWNER}/${REPO}/releases/tags/${tag}`)(token);
    const r = JSON.parse(body);
    if (r && r.id) {
      console.log(`  Deleting stale release id=${r.id}...`);
      await ghDelete(`/repos/${OWNER}/${REPO}/releases/${r.id}`)(token);
    }
  } catch {}
  // Delete tag ref (critical — this unblocks tag_name reuse)
  try {
    await ghDelete(`/repos/${OWNER}/${REPO}/git/refs/tags/${tag}`)(token);
    console.log(`  Deleted stale tag ref.`);
  } catch {}
}

/**
 * Create a release on GitHub. Uses target_commitish so GitHub creates
 * the tag + release atomically (no need for tag ref to pre-exist).
 */
async function createRelease(tag, version, token) {
  const body = await ghPost(`/repos/${OWNER}/${REPO}/releases`, {
    tag_name: tag,
    target_commitish: "main",
    name: `v${version}`,
    body: `TiRex RM v${version}\n\nAutomated release via publish.js`,
    draft: false,
    prerelease: false,
  })(token);
  return JSON.parse(body);
}

/**
 * Upload a single asset file to a release.
 */
async function uploadAsset(releaseId, assetPath, token) {
  const name = path.basename(assetPath);
  const stat = fs.statSync(assetPath);
  const buf = fs.readFileSync(assetPath);
  let ct = "application/octet-stream";
  if (name.endsWith(".exe")) ct = "application/x-msdownload";
  else if (name.endsWith(".zip")) ct = "application/zip";
  else if (name.endsWith(".blockmap")) ct = "application/json";

  const url = `${GITHUB_UPLOADS}/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
  console.log(`  Uploading ${name} (${(stat.size / 1024 / 1024).toFixed(1)} MB)...`);
  await httpsRequest("POST", url, token, buf, ct);
  console.log(`  ✓ ${name}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const token = getToken();

  // 1. Resolve version
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
  const arg = process.argv[2];
  let newVersion;

  if (!arg) {
    // No args = use current version as-is
    newVersion = pkg.version;
    console.log(`[Publish] Version from package.json: ${newVersion}`);
  } else if (["major", "minor", "patch"].includes(arg)) {
    newVersion = bump(pkg.version, arg);
    console.log(`[Publish] Bump ${arg}: ${pkg.version} → ${newVersion}`);
  } else {
    // Explicit version (e.g. "1.6.0")
    newVersion = bump(pkg.version, arg);
    console.log(`[Publish] Version override: ${pkg.version} → ${newVersion}`);
  }

  const tag = `v${newVersion}`;

  // 2. Check if tag exists (local or remote) — warn and ask
  let tagExists = false;
  let tagSource = [];

  // Check local
  try {
    const localTag = runCapture(`git tag -l "${tag}"`);
    if (localTag) {
      tagExists = true;
      tagSource.push("LOCAL");
    }
  } catch {}

  // Check remote
  try {
    const remoteRefs = runCapture(`git ls-remote --tags origin "${tag}"`);
    if (remoteRefs.includes(tag)) {
      tagExists = true;
      tagSource.push("REMOTE");
    }
  } catch {}

  if (tagExists) {
    console.log("");
    console.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.warn(`  WARNING: Tag ${tag} already exists (${tagSource.join(" + ")})`);
    console.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.warn("");
    const ok = await askYesNo(`  Delete and re-create? (y/N): `);
    if (!ok) {
      console.log("[Publish] Aborted by user.");
      process.exit(0);
    }

    // Delete local tag
    try { runCapture(`git tag -d ${tag}`); } catch {}
    // Delete remote tag
    try { runCapture(`git push --delete origin ${tag}`); } catch {}
    console.log(`[Publish] Existing tag deleted. Proceeding...`);
  }

  // 3. Write version to package.json (only if bumped)
  if (newVersion !== pkg.version) {
    pkg.version = newVersion;
    fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`[Publish] package.json updated.`);
  }

  // 4. Git commit dirty files
  const status = runCapture("git status --porcelain").trim();
  if (status) {
    run(`git add -A`);
    run(`git commit -m "Release v${newVersion}"`);
    console.log("[Publish] Committed.");
  } else if (newVersion !== pkg.version) {
    run(`git commit -am "Release v${newVersion}"`);
  } else {
    console.log("[Publish] No changes to commit.");
  }

  // 5. Tag
  run(`git tag ${tag}`);
  console.log(`[Publish] Tagged: ${tag}`);

  // 6. Force push
  const remote = `https://Difz25x:${token}@github.com/${OWNER}/${REPO}.git`;
  run(`git push --force "${remote}" main`);
  run(`git push --force "${remote}" ${tag}`);
  console.log("[Publish] Pushed.");

  // Fix local remote URL back to safe form
  try { run(`git remote set-url origin "${remote}"`); } catch {}

  // 7. Build (no publish — we handle GitHub release manually)
  run(`npx electron-builder --win --x64 --publish never`, {
    env: { ...process.env, GH_TOKEN: token },
  });
  console.log("[Publish] Build complete.");

  // 8. Create GitHub release + upload assets (manual, avoids 422 errors)
  const DIST = path.join(__dirname, "dist");
  const ASSETS = ["TiRex-RM.exe", "TiRex-RM.exe.blockmap", "update-pack.zip"];

  await cleanupStaleRelease(tag, token);

  const release = await createRelease(tag, newVersion, token);
  console.log(`[Publish] Release: ${release.html_url}`);

  for (const name of ASSETS) {
    const p = path.join(DIST, name);
    if (fs.existsSync(p)) {
      await uploadAsset(release.id, p, token);
    } else {
      console.warn(`  [warn] ${name} not found, skipping.`);
    }
  }

  console.log(`\n[Publish] ✅ v${newVersion} released!`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
