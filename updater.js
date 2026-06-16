const electron = require("electron");
const { app, ipcMain } = electron;
const path = require("path");
const fs = require("fs");
const https = require("https");
const AdmZip = require("adm-zip");

const GITHUB_OWNER = "Difz25x";
const GITHUB_REPO = "tirex-rm";
const GITHUB_RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=100`;

// Name of the release asset that contains updatable files
const UPDATE_ASSET_NAME = "update-pack.zip";

// Files that are allowed to be updated
const UPDATABLE_FILES = [
    "index.html",
    "styles.css",
    "main.js",
    "updater.js",
    "clean.js",
    "package.json",
    "js/shared.js",
    "js/notifications.js",
    "js/console.js",
    "js/accounts.js",
    "js/servers.js",
    "js/instances.js",
    "js/fflags.js",
    "js/settings.js",
    "js/utilities.js",
    "js/modals.js",
    "js/app.js",
];
const PACKAGED_UPDATABLE_FILES = [
    "index.html",
    "styles.css",
    "js/shared.js",
    "js/notifications.js",
    "js/console.js",
    "js/accounts.js",
    "js/servers.js",
    "js/instances.js",
    "js/fflags.js",
    "js/settings.js",
    "js/utilities.js",
    "js/modals.js",
    "js/app.js",
];

function getHotUpdateDir() {
    return path.join(app.getPath("userData"), "hot-update");
}

function getHotUpdateIndexPath() {
    return path.join(getHotUpdateDir(), "index.html");
}

function getHotUpdateStylesPath() {
    return path.join(getHotUpdateDir(), "styles.css");
}

function rendererHtmlLooksHealthy(filePath) {
    try {
        const html = fs.readFileSync(filePath, "utf8");
        return (
            html.includes('id="accountsGrid"') &&
            html.includes('id="tab-accounts"') &&
            html.includes('<script src="js/shared.js"></script>')
        );
    } catch (error) {
        return false;
    }
}

function hasCompleteHotRendererBundle() {
    return (
        fs.existsSync(getHotUpdateIndexPath()) &&
        fs.existsSync(getHotUpdateStylesPath()) &&
        rendererHtmlLooksHealthy(getHotUpdateIndexPath())
    );
}

let mainWindow = null;
let isUpdating = false;
let pendingUpdateVersion = null;
let ipcHandlersRegistered = false;

function getLocalVersion() {
    try {
        const pkg = JSON.parse(
            fs.readFileSync(path.join(__dirname, "package.json"), "utf8"),
        );
        return pkg.version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}

function getUpdateStatePath() {
    return path.join(app.getPath("userData"), "hot-update-state.json");
}

function readUpdateState() {
    try {
        const statePath = getUpdateStatePath();
        if (!fs.existsSync(statePath)) {
            return {};
        }
        const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function writeUpdateState(nextState) {
    try {
        const statePath = getUpdateStatePath();
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2), "utf8");
    } catch (error) {
        console.error("[HotUpdater] Failed to write state:", error.message);
    }
}

function markAppliedVersion(version, result) {
    const normalizedVersion = (version || "").replace(/^v/i, "");
    if (!normalizedVersion) return;

    const previousState = readUpdateState();
    writeUpdateState({
        ...previousState,
        lastAppliedVersion: normalizedVersion,
        lastAppliedAt: new Date().toISOString(),
        lastResult: result || "updated",
    });
}

function getEffectiveLocalVersion() {
    const localVersion = getLocalVersion();
    const state = readUpdateState();
    const stateVersion =
        typeof state.lastAppliedVersion === "string"
            ? state.lastAppliedVersion.replace(/^v/i, "")
            : "";

    if (stateVersion && compareVersions(stateVersion, localVersion) > 0) {
        return stateVersion;
    }

    return localVersion;
}

function splitPrereleasePart(part) {
    const raw = String(part || "").trim().toLowerCase();
    if (!raw) return [];

    const pieces = raw.match(/[a-z]+|\d+/g);
    if (!pieces) return [raw];
    return pieces.map((piece) => (/^\d+$/.test(piece) ? Number(piece) : piece));
}

function parseVersion(versionInput) {
    const raw = String(versionInput || "").trim().replace(/^v/i, "");
    const match = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) return null;

    const prerelease = match[4]
        ? match[4]
            .split(".")
            .flatMap(splitPrereleasePart)
        : [];

    return {
        raw,
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease,
    };
}

function comparePrereleasePart(a, b) {
    const aNum = typeof a === "number";
    const bNum = typeof b === "number";

    if (aNum && bNum) return a - b;
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

function compareVersions(remote, local) {
    const r = parseVersion(remote);
    const l = parseVersion(local);

    if (!r && !l) return 0;
    if (!r) return -1;
    if (!l) return 1;

    if (r.major !== l.major) return r.major > l.major ? 1 : -1;
    if (r.minor !== l.minor) return r.minor > l.minor ? 1 : -1;
    if (r.patch !== l.patch) return r.patch > l.patch ? 1 : -1;

    const rPre = r.prerelease;
    const lPre = l.prerelease;

    if (rPre.length === 0 && lPre.length === 0) return 0;
    if (rPre.length === 0) return -1;
    if (lPre.length === 0) return 1;

    const maxLen = Math.max(rPre.length, lPre.length);
    for (let i = 0; i < maxLen; i++) {
        const rv = rPre[i];
        const lv = lPre[i];

        if (rv === undefined) return -1;
        if (lv === undefined) return 1;

        const cmp = comparePrereleasePart(rv, lv);
        if (cmp !== 0) return cmp;
    }

    return 0;
}

function selectLatestRelease(releases, allowPrerelease = true) {
    if (!Array.isArray(releases)) return null;

    const candidates = releases
        .filter((release) => {
            if (!release || release.draft || typeof release.tag_name !== "string") return false;
            if (!allowPrerelease && release.prerelease) return false;
            return true;
        })
        .map((release) => ({
            release,
            version: release.tag_name.replace(/^v/i, ""),
        }))
        .filter((entry) => parseVersion(entry.version));

    if (candidates.length === 0) {
        return null;
    }

    candidates.sort((a, b) => {
        const versionCompare = compareVersions(b.version, a.version);
        if (versionCompare !== 0) return versionCompare;

        const dateA = new Date(a.release.published_at);
        const dateB = new Date(b.release.published_at);
        return dateB - dateA;
    });
    return candidates[0];
}

function sendToRenderer(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

function httpsGet(url, options = {}) {
    return new Promise((resolve, reject) => {
        const timeoutMs = options.timeout || 15000;
        const maxRedirects = options.maxRedirects || 5;
        let redirectCount = 0;

        const doRequest = (reqUrl) => {
            if (redirectCount > maxRedirects) {
                reject(new Error(`Too many redirects (${maxRedirects})`));
                return;
            }

            const u = new URL(reqUrl);
            const opts = {
                hostname: u.hostname,
                path: u.pathname + u.search,
                headers: {
                    "User-Agent": "TiRex-RM-Updater",
                    ...options.headers,
                },
            };

            const req = https.get(opts, (res) => {
                // Follow redirects
                if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
                    res.resume();
                    redirectCount++;
                    doRequest(res.headers.location);
                    return;
                }

                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => resolve(Buffer.concat(chunks)));
                res.on("error", reject);
            });

            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
            });
            req.on("error", reject);
        };

        doRequest(url);
    });
}

function httpsGetJson(url) {
    return httpsGet(url).then((buf) => JSON.parse(buf.toString("utf8")));
}

function downloadWithProgress(url, destPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const timeoutMs = 60000;
        const maxRedirects = 5;
        let redirectCount = 0;

        const doRequest = (requestUrl) => {
            if (redirectCount > maxRedirects) {
                reject(new Error(`Too many redirects (${maxRedirects})`));
                return;
            }

            const u = new URL(requestUrl);
            const reqOptions = {
                hostname: u.hostname,
                path: u.pathname + u.search,
                headers: {
                    "User-Agent": "TiRex-RM-Updater",
                    ...headers,
                },
            };

            const req = https.get(reqOptions, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
                    res.resume();
                    redirectCount++;
                    doRequest(res.headers.location);
                    return;
                }

                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
                let downloadedBytes = 0;

                const fileStream = fs.createWriteStream(destPath);

                res.on("data", (chunk) => {
                    downloadedBytes += chunk.length;
                    fileStream.write(chunk);

                    if (totalBytes > 0) {
                        const percent = Math.round((downloadedBytes / totalBytes) * 100);
                        sendToRenderer("hot-update-progress", {
                            percent,
                            downloaded: downloadedBytes,
                            total: totalBytes,
                        });
                    }
                });

                res.on("end", () => {
                    fileStream.end(() => resolve(destPath));
                });

                res.on("error", (err) => {
                    fileStream.close();
                    reject(err);
                });
            });

            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error(`Download timed out after ${timeoutMs}ms`));
            });
            req.on("error", reject);
        };

        doRequest(url);
    });
}

async function checkForUpdates(options = {}) {
    const allowPrerelease = options.allowPrerelease !== false;
    console.log(`[HotUpdater] Checking for updates (allowPrerelease: ${allowPrerelease})...`);

    try {
        const releases = await httpsGetJson(GITHUB_RELEASES_API);
        const selectedRelease = selectLatestRelease(releases, allowPrerelease);
        if (!selectedRelease) {
            return {
                updateAvailable: false,
                error: "No published GitHub release found (drafts are ignored).",
            };
        }

        const release = selectedRelease.release;
        const remoteVersion = selectedRelease.version;
        const localVersion = getEffectiveLocalVersion();

        console.log(`[HotUpdater] Local: ${localVersion}, Remote: ${remoteVersion}`);

        // Find the update-pack.zip asset in release assets
        const assets = release.assets || [];
        const updateAsset = assets.find(
            (a) => a.name.toLowerCase() === UPDATE_ASSET_NAME.toLowerCase(),
        );

        const cmp = compareVersions(remoteVersion, localVersion);

        if (cmp > 0) {
            pendingUpdateVersion = remoteVersion;
            if (!updateAsset) {
                console.log(`[HotUpdater] Update available but no '${UPDATE_ASSET_NAME}' asset found in release`);
                sendToRenderer("hot-update-error", {
                    message: `Update v${remoteVersion} available, but '${UPDATE_ASSET_NAME}' asset not found in release. Please add it.`,
                });
                return {
                    updateAvailable: true,
                    version: remoteVersion,
                    currentVersion: localVersion,
                    error: `'${UPDATE_ASSET_NAME}' asset not found`,
                };
            }

            console.log(`[HotUpdater] Update available: ${remoteVersion}`);
            console.log(`[HotUpdater] Asset URL: ${updateAsset.browser_download_url}`);

            sendToRenderer("hot-update-available", {
                version: remoteVersion,
                isPrerelease: !!release.prerelease,
                currentVersion: localVersion,
                releaseNotes: release.body || "Bug fixes and improvements",
                downloadUrl: updateAsset.browser_download_url,
            });

            return {
                updateAvailable: true,
                version: remoteVersion,
                isPrerelease: !!release.prerelease,
                currentVersion: localVersion,
                downloadUrl: updateAsset.browser_download_url,
                releaseNotes: release.body || "",
            };
        } else {
            pendingUpdateVersion = null;
            console.log("[HotUpdater] Already up to date");
            sendToRenderer("hot-update-not-available", {
                version: localVersion,
            });
            return { updateAvailable: false, version: localVersion };
        }
    } catch (error) {
        console.error("[HotUpdater] Check failed:", error.message);
        sendToRenderer("hot-update-error", { message: error.message });
        return { updateAvailable: false, error: error.message };
    }
}

async function downloadAndApply(downloadInput) {
    if (isUpdating) {
        console.log("[HotUpdater] Already updating, skipping...");
        return { success: false, error: "Already updating" };
    }

    const parsedInput =
        typeof downloadInput === "string"
            ? { downloadUrl: downloadInput }
            : (downloadInput || {});

    const downloadUrl =
        typeof parsedInput.downloadUrl === "string"
            ? parsedInput.downloadUrl
            : "";
    const targetVersion =
        (
            typeof parsedInput.version === "string"
                ? parsedInput.version
                : pendingUpdateVersion
        )?.replace(/^v/i, "") || "";

    if (!downloadUrl) {
        return { success: false, error: "Missing update download URL" };
    }

    const appPath = app.getAppPath();
    const isPackagedAsar = app.isPackaged && appPath.toLowerCase().includes(".asar");

    isUpdating = true;
    const updateDir = path.join(app.getPath("userData"), "updates");
    const zipPath = path.join(updateDir, "update-pack.zip");
    const hotUpdateDir = getHotUpdateDir();

    // Critical paths that should NEVER be deleted or messed with
    const PROTECTED_PATHS = [
        "node_modules",
        ".git",
        "dist",
        "hot-update",
        "userData", // Generic name for user data if exists
        "data",     // Local data storage
        "hot-update-state.json",
        "package-lock.json",
    ];

    try {
        // Ensure update directory
        if (!fs.existsSync(updateDir)) {
            fs.mkdirSync(updateDir, { recursive: true });
        }
        if (isPackagedAsar && !fs.existsSync(hotUpdateDir)) {
            fs.mkdirSync(hotUpdateDir, { recursive: true });
        }

        // Download the update-pack.zip asset
        console.log("[HotUpdater] Downloading update-pack.zip...");
        sendToRenderer("hot-update-status", { status: "downloading" });

        await downloadWithProgress(downloadUrl, zipPath, {
            Accept: "application/octet-stream",
        });
        console.log("[HotUpdater] Download complete");

        // Extract
        console.log("[HotUpdater] Extracting and Reconciling...");
        sendToRenderer("hot-update-status", { status: "extracting" });
        sendToRenderer("hot-update-progress", { percent: 100 });

        const zip = new AdmZip(zipPath);
        const entries = zip.getEntries();
        const destRoot = isPackagedAsar ? hotUpdateDir : __dirname;

        let mainJsChanged = false;
        let updatedFiles = [];
        const filesInZip = new Set();

        // 1. Extract/Update files from ZIP
        for (const entry of entries) {
            if (entry.isDirectory) continue;

            const relativePath = entry.entryName;
            filesInZip.add(relativePath);

            const destPath = path.join(destRoot, relativePath);
            const destDir = path.dirname(destPath);

            // Ensure directory exists
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }

            const newContent = entry.getData();

            // Check if content actually changed
            try {
                if (fs.existsSync(destPath)) {
                    const oldContent = fs.readFileSync(destPath);
                    if (Buffer.compare(oldContent, newContent) === 0) {
                        continue;
                    }
                }
            } catch (e) {
                console.warn(`[HotUpdater] Error checking ${relativePath}:`, e.message);
            }

            // Write the new file
            console.log(`[HotUpdater] Updating: ${relativePath}`);
            fs.writeFileSync(destPath, newContent);
            updatedFiles.push(relativePath);

            if (relativePath === "main.js" || relativePath === "updater.js") {
                mainJsChanged = true;
            }
        }

        // 2. Delete obsolete files (Local files NOT in ZIP and NOT protected)
        if (!isPackagedAsar) { // Only perform deletions in dev/root mode for now to avoid risking userData in packaged mode
            const localFiles = fs.readdirSync(destRoot, { recursive: true });
            for (const localFile of localFiles) {
                const relativePath = path.relative(destRoot, path.join(destRoot, localFile)).replace(/\\/g, '/');

                // Skip directories (we'll clean empty ones later if needed)
                if (fs.statSync(path.join(destRoot, localFile)).isDirectory()) continue;

                // Check if file is in ZIP
                if (filesInZip.has(relativePath)) continue;

                // Check if file is protected
                const isProtected = PROTECTED_PATHS.some(p =>
                    relativePath === p || relativePath.startsWith(p + '/')
                );

                if (!isProtected) {
                    console.log(`[HotUpdater] Deleting obsolete file: ${relativePath}`);
                    try {
                        fs.unlinkSync(path.join(destRoot, localFile));
                        updatedFiles.push(`- ${relativePath}`);
                    } catch (e) {
                        console.error(`[HotUpdater] Failed to delete ${relativePath}:`, e.message);
                    }
                }
            }
        }

        // Cleanup
        try {
            fs.unlinkSync(zipPath);
            fs.rmSync(updateDir, { recursive: true, force: true });
        } catch (e) {
            console.log("[HotUpdater] Cleanup warning:", e.message);
        }

        if (updatedFiles.length === 0) {
            console.log("[HotUpdater] No changes detected.");
            markAppliedVersion(targetVersion, "no_changes");
            sendToRenderer("hot-update-applied", {
                filesUpdated: [],
                needsRelaunch: false,
                message: "Already up to date — no changes detected",
            });
            isUpdating = false;
            return { success: true, filesUpdated: [], needsRelaunch: false };
        }

        console.log(`[HotUpdater] Sync complete. Changes: ${updatedFiles.length}`);
        markAppliedVersion(targetVersion, "updated");
        pendingUpdateVersion = null;

        sendToRenderer("hot-update-applied", {
            filesUpdated: updatedFiles,
            needsRelaunch: mainJsChanged,
            message: mainJsChanged
                ? "Full sync complete! Restarting app..."
                : "Full sync complete! Reloading...",
        });

        // Apply
        if (mainJsChanged) {
            console.log("[HotUpdater] Relaunching...");
            setTimeout(() => {
                app.relaunch();
                app.exit(0);
            }, 1500);
        } else {
            console.log("[HotUpdater] Reloading window...");
            setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    if (isPackagedAsar && hasCompleteHotRendererBundle()) {
                        mainWindow.loadFile(getHotUpdateIndexPath());
                    } else {
                        mainWindow.reload();
                    }
                }
            }, 1500);
        }

        isUpdating = false;
        return { success: true, filesUpdated: updatedFiles, needsRelaunch: mainJsChanged };
    } catch (error) {
        console.error("[HotUpdater] Update failed:", error);
        sendToRenderer("hot-update-error", { message: error.message });
        isUpdating = false;

        // Cleanup on error
        try {
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        } catch (e) { }

        return { success: false, error: error.message };
    }
}

function setupHotUpdater(window) {
    mainWindow = window;
    console.log("[HotUpdater] Hot updater initialized");

    registerIpcHandlers();

    // Auto-check after 5 seconds
    setTimeout(() => {
        checkForUpdates({ allowPrerelease: true });
    }, 5000);
}

function registerIpcHandlers() {
    if (ipcHandlersRegistered) {
        return;
    }

    if (!ipcMain || typeof ipcMain.handle !== "function") {
        console.warn("[HotUpdater] ipcMain.handle unavailable; skipping IPC registration");
        return;
    }

    ipcMain.handle("check-hot-update", async (event, options = {}) => {
        return await checkForUpdates(options);
    });

    ipcMain.handle("apply-hot-update", async (event, downloadUrl) => {
        return await downloadAndApply(downloadUrl);
    });

    ipcHandlersRegistered = true;
}

module.exports = { setupHotUpdater, checkForUpdates };
