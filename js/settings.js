// TiRex RM — Settings Tab
// Settings persistence, versions, paths, fonts, import/export, reset

let settings = createDefaultFrontendSettings();
let robloxVersions = { installed: [], latest: null, live: null, previous: null, future: [], all: [] };
let versionSearchQuery = "";
let selectedVersionToDownload = null;
let versionToReinstall = null;

function createDefaultFrontendSettings() {
    return {
        appFont: "Segoe UI Variable", autoDownload: false, multiInstance: true, autoInject: true, notifications: true, autoReopen: true, autoRejoinLastSession: true, maxReopenAttempts: 3, reopenDelay: 2000, robloxVersion: "latest", globalRbxIdCheck: DEFAULT_SHARED_RBXIDCHECK, lastPrivateServerUrl: "", allowPrerelease: true, hideCapture: false,
        fflags: { fpsUnlocker: true, fpsLimit: 60, renderer: 'd3d11', disableShadows: false, noTextures: false, lowQualityAudio: false, debugRendering: false, renderShadowmap: false, renderVoxelPerf: false, simAdaptiveTimestepping: false, networkDebugDraw: false, unifiedPhysicsSender: false, studioMaterialGenerator: false, studioPivotTools: false, studioEmulatorPerfStats: false, cameraGamepadZoom: false, topbarNewHover: false, emotesMenuV3: false, newAssembliesPGS: false, solverPrestepBudget: false, physicsPerfProfile: false, soundEngineFastSeek: false, spatialVoiceNoiseSuppression: false, audioOutputDeviceSelect: false, securityLuauBytecodeHash: false, clientIntegrityCheck: false, scriptPerformanceGuardrails: false, mobileGpuSkinning: false, dynamicResolutionV2: false, throttleBackgroundClients: false, logAnalyticsHttpFailures: false, errorReportStacktrace: false, perfTelemetryGpuCpuSplit: false },
        memoryOptimization: { closeCrashHandler: false, memoryTrim: false, memoryTrimInterval: 60, systemMemoryCleaner: 'never' },
        favoriteGames: [], lastSession: null,
    };
}

async function loadSettings() {
    try {
        const loaded = await ipcRenderer.invoke("load-settings");
        settings = { ...settings, ...loaded };
        settings.globalRbxIdCheck = normalizeNamedCookieValue(typeof settings.globalRbxIdCheck === "string" ? settings.globalRbxIdCheck : "", ".RBXIDCHECK") || DEFAULT_SHARED_RBXIDCHECK;
        if (settings.appFont) { document.body.style.fontFamily = settings.appFont === 'Inter' ? '"Inter", system-ui, sans-serif' : `"${settings.appFont}", sans-serif`; const s = document.getElementById('appFontSelect'); if (s) s.value = settings.appFont; }
        if (settings.hasOwnProperty('allowPrerelease')) { const t = document.getElementById('toggleAllowPrerelease'); if (t) t.checked = !!settings.allowPrerelease; }
        if (settings.hasOwnProperty('autoReopen')) { const t = document.getElementById('toggleAutoReopen'); if (t) t.checked = !!settings.autoReopen; }
        if (settings.hasOwnProperty('autoRejoinLastSession')) { const t = document.getElementById('toggleAutoRejoinSession'); if (t) t.checked = !!settings.autoRejoinLastSession; }
        renderFavoriteGames(); updateLastSessionMeta(settings.lastSession || null); updateSessionRejoinUi(); applySavedSharedRbxIdCheck(); refreshAccountViews();
    } catch (error) { console.error("Failed to load settings:", error); }
}

async function saveSettings(newSettings) {
    try { settings = { ...settings, ...newSettings }; const res = await ipcRenderer.invoke("save-settings", settings); if (!res.success) throw new Error(res.error); }
    catch (error) { console.error("Failed to save settings:", error); showNotification(`Error saving settings: ${error.message}`, "error"); }
}

function updateLastSessionMeta(lastSession) {
    const metaEl = document.getElementById("lastSessionMeta");
    if (!metaEl) return;
    if (!lastSession || !lastSession.placeId || !lastSession.gameId) { metaEl.textContent = "Last session: not available"; return; }
    const updatedAt = lastSession.updatedAt ? new Date(lastSession.updatedAt).toLocaleString() : "unknown";
    metaEl.textContent = `Last session: Place ${lastSession.placeId} | Job ${lastSession.gameId} | ${updatedAt}`;
}

function updateSessionRejoinUi() {
    const actionBtn = document.getElementById("rejoinLastSessionBtn");
    if (!actionBtn) return;
    const enabled = settings.autoRejoinLastSession !== false;
    actionBtn.disabled = !enabled; actionBtn.style.opacity = enabled ? "1" : "0.55"; actionBtn.title = enabled ? "Rejoin saved session now" : "Enable Auto Rejoin first";
}

function getBestAccountForSessionAction() {
    if (selectedAccountId) { const selected = accounts.find((a) => a.id === selectedAccountId); if (selected?.cookie?.trim()) return selected; }
    const preferredFromMulti = Array.from(selectedAccountIds || []);
    for (const accountId of preferredFromMulti) { const account = accounts.find((a) => a.id === accountId); if (account?.cookie?.trim()) return account; }
    return accounts.find((a) => typeof a.cookie === "string" && a.cookie.trim().length > 0) || null;
}

async function rejoinLastSession() {
    const actionBtn = document.getElementById("rejoinLastSessionBtn");
    if (settings.autoRejoinLastSession === false) { showNotification("Auto Rejoin is disabled", "warning"); return; }
    const account = getBestAccountForSessionAction();
    if (!account) { showNotification("No account with valid cookie available", "error"); return; }
    if (actionBtn) actionBtn.disabled = true;
    try {
        const result = await ipcRenderer.invoke("rejoin-last-session", { cookie: account.cookie, rbxIdCheck: getEffectiveAccountRbxIdCheck(account), accountInfo: { id: account.id, username: account.username } });
        if (!result?.success) throw new Error(result?.error || "Failed to rejoin last session");
        await loadSettings();
        showNotification(`Rejoining session: Place ${result.placeId}, Job ${result.gameId}`, "success");
    } catch (error) { showNotification(`Rejoin failed: ${error.message}`, "error"); }
    finally { if (actionBtn) actionBtn.disabled = false; }
}

async function applyAppFont(fontFamily) {
    document.body.style.fontFamily = fontFamily === 'Inter' ? '"Inter", system-ui, sans-serif' : `"${fontFamily}", sans-serif`;
    settings.appFont = fontFamily;
    try { await ipcRenderer.invoke("save-settings", settings); } catch (error) { console.error("Failed to save app font:", error); }
}

async function selectAndApplyRobloxFont() {
    showNotification('Selecting custom Roblox font...', 'info');
    try { const result = await ipcRenderer.invoke('apply-custom-roblox-font'); if (result.success) { showNotification('Roblox font applied successfully!', 'success'); await loadFontSettings(); } else if (!result.cancelled) showNotification('Failed to apply font: ' + result.error, 'error'); }
    catch (error) { showNotification('Error applying Roblox font: ' + error.message, 'error'); }
}

async function restoreRobloxFont() {
    showNotification('Restoring original Roblox font...', 'info');
    try { const result = await ipcRenderer.invoke('restore-roblox-font'); if (result.success) { showNotification('Roblox font restored successfully!', 'success'); await loadFontSettings(); } else showNotification('Failed to restore font: ' + result.error, 'error'); }
    catch (error) { showNotification('Error restoring Roblox font: ' + error.message, 'error'); }
}

async function loadFontSettings() {
    try { const result = await ipcRenderer.invoke('get-font-settings'); if (result.success) { const s = document.getElementById('selectedRobloxFontPath'); const d = document.getElementById('detectedRobloxFontsPath'); if (s) { s.textContent = result.selectedFontPath || 'Not applied'; s.title = result.selectedFontPath || 'Not applied'; } if (d) { d.textContent = result.robloxFontsPath || 'Not detected'; d.title = result.robloxFontsPath || 'Not detected'; } } }
    catch (error) { console.error('Error loading font settings:', error); }
}

function applySavedPrivateServerUrl() { const input = document.getElementById("privateServerLink"); if (!input) return; if (settings.lastPrivateServerUrl && !input.value.trim()) input.value = settings.lastPrivateServerUrl; }
function applySavedSharedRbxIdCheck() { const input = document.getElementById("sharedRbxIdCheckInput"); if (!input) return; input.value = getSharedRbxIdCheckSettingValue(); }

async function saveSharedRbxIdCheck() {
    const input = document.getElementById("sharedRbxIdCheckInput"); if (!input) return;
    const rawValue = input.value || "";
    const normalizedValue = normalizeNamedCookieValue(rawValue, ".RBXIDCHECK") || DEFAULT_SHARED_RBXIDCHECK;
    const revertedToDefault = normalizedValue === DEFAULT_SHARED_RBXIDCHECK && !normalizeNamedCookieValue(rawValue, ".RBXIDCHECK");
    input.value = normalizedValue;
    if (settings.globalRbxIdCheck === normalizedValue) { refreshAccountViews(); return; }
    settings.globalRbxIdCheck = normalizedValue;
    try { const result = await ipcRenderer.invoke("save-settings", settings); if (!result?.success) throw new Error(result?.error || "Failed to save shared .RBXIDCHECK"); refreshAccountViews(); showNotification(revertedToDefault ? "Shared .RBXIDCHECK reverted to default" : "Shared .RBXIDCHECK updated", "success"); }
    catch (error) { console.error("Failed to save shared .RBXIDCHECK:", error); showNotification(`Error saving shared .RBXIDCHECK: ${error.message}`, "error"); }
}

async function persistPrivateServerUrl(url) {
    const trimmed = (url || "").trim(); if (!trimmed) return; if (settings.lastPrivateServerUrl === trimmed) return;
    settings.lastPrivateServerUrl = trimmed;
    try { await ipcRenderer.invoke("save-settings", settings); } catch (error) { console.error("Failed to save private server URL:", error); }
}

async function exportAccounts() {
    try { const result = await ipcRenderer.invoke("export-accounts"); if (result.success) { showNotification(`Data exported (${result.accountsCount || accounts.length} accounts)`, "success"); } else showNotification(result.error || "Export failed", "error"); }
    catch (error) { showNotification("Export failed", "error"); }
}

async function importAccounts() {
    try { const result = await ipcRenderer.invoke("import-accounts"); if (result.success) { if (typeof result.count === "number") { await loadAccounts(); renderAccounts(); updateAccountSelects(); updateStats(); } if (result.importedSettings) { await loadSettings(); applySavedPrivateServerUrl(); loadFFlags(); } showNotification("Import complete", "success"); } else showNotification(result.error || "Import failed", "error"); }
    catch (error) { showNotification("Import failed", "error"); }
}

async function clearAllData() {
    if (!confirm("Delete ALL accounts and settings?")) return;
    accounts = []; selectedAccountId = null; editingAccountId = null; selectedAccountIds.clear(); accountMultiSelectMode = false;
    await saveAccounts();
    settings = createDefaultFrontendSettings();
    try { await ipcRenderer.invoke("save-settings", settings); } catch (error) { console.error("Failed to reset settings:", error); }
    applySavedPrivateServerUrl(); applySavedSharedRbxIdCheck(); renderAccounts(); updateAccountSelects(); updateStats();
    document.getElementById("privateServerLink").value = ""; loadFFlags(); showNotification("All data cleared", "success");
}

async function toggleHideCapture(enabled) {
    try { const result = await ipcRenderer.invoke('set-hide-capture', enabled); if (result.success) showNotification(enabled ? 'Hide Capture enabled' : 'Hide Capture disabled', 'success'); else { showNotification(result.error || 'Failed to update Hide Capture', 'error'); document.getElementById('hideCaptureToggle').checked = !enabled; } }
    catch (error) { showNotification('Error updating Hide Capture', 'error'); document.getElementById('hideCaptureToggle').checked = !enabled; }
}

// ─── Version Management ──────────────────────────────────────────────────────
function hasInstalledVersion(versions, version) { return !!version && Array.isArray(versions?.installed) && versions.installed.includes(version); }
function getPreferredInstalledVersion(versions, targetVersion) { if (hasInstalledVersion(versions, targetVersion)) return targetVersion; if (Array.isArray(versions?.installed) && versions.installed.length) return versions.installed[0]; return null; }

async function checkRobloxVersions(options = {}) {
    const silent = options.silent === true; const notifyResult = options.notifyResult !== false;
    try {
        if (!silent) showNotification("Checking for updates...", "info");
        const versions = await ipcRenderer.invoke("get-roblox-versions");
        versions.all = Array.from(new Set(versions.all || []));
        robloxVersions = { ...versions };
        document.getElementById("installedVersion").textContent = getPreferredInstalledVersion(versions, versions.latest) || "None";
        document.getElementById("latestVersion").textContent = versions.latest || "Unknown";
        if (versions.latest && !silent && notifyResult) { if (hasInstalledVersion(versions, versions.latest)) showNotification("Your version is up-to-date!", "success"); else showNotification("Update available: " + versions.latest, "warning"); }
    } catch (error) { console.error("Failed to check versions:", error); if (!silent) showNotification("Failed to check versions", "error"); }
}

async function checkRobloxVersionsFull(options = {}) {
    const silent = options.silent === true; const notifyResult = options.notifyResult !== false;
    try {
        if (!silent) showNotification("Fetching version data...", "info");
        const versions = await ipcRenderer.invoke("get-roblox-versions");
        versions.all = Array.from(new Set(versions.all || []));
        robloxVersions = versions;
        const installedVersion = getPreferredInstalledVersion(versions, versions.live);
        document.getElementById("installedVersion").textContent = installedVersion || "None";
        document.getElementById("latestVersion").textContent = versions.live || "Unknown";
        document.getElementById("dashInstalledVersion").textContent = installedVersion || "None";
        document.getElementById("dashLiveVersion").textContent = versions.live || "Unknown";
        const dashStatus = document.getElementById("dashStatusText");
        const dashUpdateBtn = document.getElementById("dashUpdateBtn");
        if (installedVersion === versions.live) { dashStatus.innerHTML = `<span style="color: var(--success); font-weight: 600;">Up to date</span>`; dashUpdateBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> Re-Install Live`; dashUpdateBtn.className = "btn btn-secondary"; }
        else if (!installedVersion) { dashStatus.innerHTML = `<span style="color: var(--error); font-weight: 600;">Not Installed</span>`; dashUpdateBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Install Live`; dashUpdateBtn.className = "btn btn-primary"; }
        else { dashStatus.innerHTML = `<span style="color: var(--warning); font-weight: 600;">Update Available</span>`; dashUpdateBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Update to Live`; dashUpdateBtn.className = "btn btn-primary"; }
        renderVersionsList(versions);
        if (!silent && notifyResult) showNotification(`Found ${new Set(versions.all || []).size} versions`, "success");
    } catch (error) { console.error("Failed to check versions:", error); if (!silent) showNotification("Failed to check versions", "error"); }
}

function handleVersionSearchInput(value) { versionSearchQuery = String(value || "").trim().toLowerCase(); renderVersionsList(robloxVersions); }
function clearVersionSearch() { versionSearchQuery = ""; const s = document.getElementById("versionsSearchInput"); if (s) { s.value = ""; s.focus(); } renderVersionsList(robloxVersions); }

function renderVersionsList(versions) {
    const container = document.getElementById("versionsList"); container.innerHTML = "";
    const allVersions = Array.from(new Set(versions.all || []));
    const searchQuery = String(versionSearchQuery || "").trim().toLowerCase();
    const versionList = searchQuery ? allVersions.filter((v) => String(v).toLowerCase().includes(searchQuery)) : allVersions;
    const countLabel = document.getElementById("versionsSearchCount");
    if (countLabel) countLabel.textContent = searchQuery ? `Showing ${versionList.length} of ${allVersions.length}` : `From DeployHistory (${allVersions.length})`;
    if (!versionList.length) { container.innerHTML = '<div class="empty-state"><div class="empty-text">No versions available</div></div>'; return; }
    versionList.forEach((version) => {
        const isInstalled = versions.installed.includes(version);
        const isLive = version === versions.live;
        let statusLabel = "", statusColor = "var(--text-dim)";
        if (isLive) { statusLabel = "LIVE"; statusColor = "var(--success)"; }
        const card = document.createElement("div"); card.className = "version-row" + (isInstalled ? " installed" : "");
        card.innerHTML = `<div style="display: flex; flex-direction: column; gap: 4px;"><div style="font-family: var(--font-mono); font-size: 13px; font-weight: 600;">${version}</div><div style="display: flex; gap: 12px; align-items: center;">${statusLabel ? `<div style="font-size: 10px; font-weight: 700; color: ${statusColor}; padding: 2px 8px; background: rgba(255,255,255,0.05); border-radius: 12px;">${statusLabel}</div>` : ""}${isInstalled ? '<div style="font-size: 10px; font-weight: 700; color: var(--primary); padding: 2px 8px; background: rgba(108, 92, 231, 0.1); border-radius: 12px;">INSTALLED</div>' : ""}</div></div><button class="install-btn" onclick="downloadSpecificVersion('${version}')">${isInstalled ? 'Re-Install' : 'Install'}</button>`;
        container.appendChild(card);
    });
}

async function downloadSpecificVersion(version) {
    const ver = version || selectedVersionToDownload;
    if (!ver) { showNotification("No version selected", "error"); return; }
    if (robloxVersions.installed.includes(ver)) { openReinstallModal(ver); return; }
    startDownload(ver, false);
}

function openReinstallModal(version) { versionToReinstall = version; document.getElementById("reinstallVersionDisplay").textContent = version; document.getElementById("reinstallModal").classList.add("active"); }
function closeReinstallModal() { versionToReinstall = null; document.getElementById("reinstallModal").classList.remove("active"); }
function confirmReinstall() { if (!versionToReinstall) return; closeReinstallModal(); startDownload(versionToReinstall, true); }

function startDownload(ver, force) {
    try {
        document.getElementById("downloadModal").classList.add("active");
        document.getElementById("downloadStatus").textContent = "Starting download...";
        document.getElementById("downloadProgressBar").style.width = "0%";
        document.getElementById("downloadProgressTextOverlay").textContent = "0%";
        const statusListener = (event, message) => { document.getElementById("downloadStatus").textContent = normalizeRuntimeTextToEnglish(message); };
        const progressListener = (event, data) => {
            const percent = Math.max(0, Math.min(100, Number(data.overallPercentage ?? data.percentage ?? 0)));
            document.getElementById("downloadProgressBar").style.width = `${percent}%`;
            document.getElementById("downloadProgressTextOverlay").textContent = `${percent}%`;
        };
        const completeListener = (event, result) => {
            ipcRenderer.removeListener("status-update", statusListener);
            ipcRenderer.removeListener("download-progress", progressListener);
            ipcRenderer.removeListener("roblox-download-complete", completeListener);
            if (result.success) { showNotification("Version installed successfully", "success"); setTimeout(() => { document.getElementById("downloadModal").classList.remove("active"); checkRobloxVersionsFull(); }, 2000); }
            else showNotification(`Download failed: ${result.error}`, "error");
        };
        ipcRenderer.on("status-update", statusListener);
        ipcRenderer.on("download-progress", progressListener);
        ipcRenderer.on("roblox-download-complete", completeListener);
        ipcRenderer.send("download-roblox-version", ver, !!force);
    } catch (error) { showNotification("Download failed", "error"); document.getElementById("downloadModal").classList.remove("active"); }
}

async function downloadLatestRoblox() {
    if (!robloxVersions.latest) { showNotification("No version available", "error"); return; }
    if (hasInstalledVersion(robloxVersions, robloxVersions.latest)) { showNotification("Already up-to-date!", "success"); return; }
    startDownload(robloxVersions.latest, false);
}

async function handleDashboardLiveVersionAction() { const v = String(robloxVersions?.live || robloxVersions?.latest || "").trim(); if (!v) { showNotification("No live version available", "error"); return; } await downloadSpecificVersion(v); }

// ─── Path Management ─────────────────────────────────────────────────────────
async function selectCustomRobloxPath() {
    try { const r = await ipcRenderer.invoke('select-custom-roblox-path'); if (r.success) { await loadRobloxPathInfo(); showNotification('Custom path set', 'success'); } else showNotification('Cancelled', 'info'); }
    catch { showNotification('Error setting custom path', 'error'); }
}

async function clearCustomRobloxPath() {
    try { const r = await ipcRenderer.invoke('clear-custom-roblox-path'); if (r.success) { await loadRobloxPathInfo(); showNotification('Custom path cleared', 'success'); } }
    catch { showNotification('Error clearing custom path', 'error'); }
}

function updateRobloxPathUI(info) {
    const c = document.getElementById('currentRobloxPath'); const cu = document.getElementById('customRobloxPath');
    if (c) { c.textContent = info?.currentPath || 'Not available'; c.title = info?.currentPath || 'Not available'; }
    if (cu) { cu.textContent = info?.customPath || 'Not set'; cu.title = info?.customPath || 'Not set'; }
}

async function loadRobloxPathInfo() {
    try { const r = await ipcRenderer.invoke('get-roblox-path-info'); updateRobloxPathUI(r?.success ? r : null); }
    catch { updateRobloxPathUI(null); }
}

async function viewRobloxPathInExplorer() {
    try { const p = document.getElementById('currentRobloxPath')?.textContent; if (!p || p === 'Not available') { showNotification('Path not available', 'error'); return; } const r = await ipcRenderer.invoke('open-path-in-explorer', p); if (r.success) showNotification('Opened in Explorer', 'success'); else showNotification(r.error || 'Failed', 'error'); }
    catch { showNotification('Error opening Explorer', 'error'); }
}
