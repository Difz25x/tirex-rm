// TiRex RM — App Bootstrap
// Main application entry, tab switching, startup sequence, IPC listeners

let startupOverlayHidden = false;

function setStartupLoadingProgress(message, percent) {
    const overlay = document.getElementById("startupLoadingOverlay");
    if (!overlay || startupOverlayHidden) return;
    const stepEl = document.getElementById("startupLoadingStep");
    const progressEl = document.getElementById("startupLoadingProgress");
    const percentEl = document.getElementById("startupLoadingPercent");
    if (stepEl && message) stepEl.textContent = normalizeRuntimeTextToEnglish(String(message));
    const hasPercent = Number.isFinite(percent);
    if (hasPercent) {
        const normalized = Math.max(0, Math.min(100, Math.round(percent)));
        if (progressEl) progressEl.style.width = `${normalized}%`;
        if (percentEl) percentEl.textContent = `${normalized}%`;
    }
}

function hideStartupLoadingOverlay() {
    if (startupOverlayHidden) return;
    startupOverlayHidden = true;
    const overlay = document.getElementById("startupLoadingOverlay");
    if (!overlay) return;
    overlay.classList.add("hidden");
    setTimeout(() => { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 320);
}

function getStoredActiveTab() { try { return localStorage.getItem(LAST_ACTIVE_TAB_STORAGE_KEY) || "accounts"; } catch { return "accounts"; } }

function syncWorkspaceHeader(tabId, selectedTab) {
    const tabElement = selectedTab || document.getElementById(`tab-${tabId}`);
    if (!tabElement) return;
    const kickerEl = document.getElementById("workspaceKicker");
    const titleEl = document.getElementById("workspaceTitle");
    const subtitleEl = document.getElementById("workspaceSubtitle");
    const valueEl = document.getElementById("workspaceTabValue");
    const nextKicker = tabElement.dataset.shellKicker || "Mission Control";
    const nextTitle = tabElement.dataset.shellTitle || "Workspace";
    const nextDescription = tabElement.dataset.shellDescription || "Operate the current TiRex RM workspace.";
    if (kickerEl) kickerEl.textContent = nextKicker;
    if (titleEl) titleEl.textContent = nextTitle;
    if (subtitleEl) subtitleEl.textContent = nextDescription;
    if (valueEl) valueEl.textContent = nextTitle;
    document.body.dataset.activeTab = tabId;
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => { el.style.display = 'none'; el.classList.remove('active'); });
    const selectedTab = document.getElementById(`tab-${tabId}`);
    if (selectedTab) { selectedTab.style.display = 'block'; setTimeout(() => selectedTab.classList.add('active'), 10); syncWorkspaceHeader(tabId, selectedTab); }
    document.querySelectorAll('.nav-btn').forEach(btn => { if (btn.getAttribute('onclick')?.includes(`'${tabId}'`)) btn.classList.add('active'); else btn.classList.remove('active'); });
    try { localStorage.setItem(LAST_ACTIVE_TAB_STORAGE_KEY, tabId); } catch {}
    if (tabId === "instances") { refreshInstances({ force: true }); refreshGuardStatus(); }
    else if (tabId === "robloxs" && (!robloxVersions.all || robloxVersions.all.length === 0)) checkRobloxVersionsFull();
    else if (tabId === "console") renderConsoleLogs();
}

function applyInteractionSafetyMode() {
    try {
        let styleEl = document.getElementById("interactionSafetyRuntime");
        if (!styleEl) { styleEl = document.createElement("style"); styleEl.id = "interactionSafetyRuntime"; document.head.appendChild(styleEl); }
        styleEl.textContent = `.tab-content.active { animation: none !important; } .btn, .nav-btn, .form-section, .quick-signin-panel, .game-preview, .version-dashboard, .modal-content, .account-card, .render-card, .server-item, .launch-account-item, .version-row, .install-btn { transform: none !important; transform-style: flat !important; perspective: none !important; clip-path: none !important; backface-visibility: hidden; } .btn:hover, .nav-btn:hover, .form-section:hover, .quick-signin-panel:hover, .game-preview:hover, .version-dashboard:hover, .modal-content:hover, .account-card:hover, .render-card:hover, .server-item:hover, .launch-account-item:hover, .version-row:hover, .install-btn:hover { transform: none !important; } .startup-loading-overlay { pointer-events: none !important; } .notification-container { pointer-events: none !important; } .notification { pointer-events: auto !important; } .modal { pointer-events: none; } .modal.active { pointer-events: auto; }`;
        const startupOverlay = document.getElementById("startupLoadingOverlay");
        if (startupOverlay) startupOverlay.style.pointerEvents = "none";
    } catch (error) { console.error("[UI] Interaction safety mode failed:", error); }
}

// ─── IPC Event Listeners ─────────────────────────────────────────────────────
function bindIpcListeners() {
    ipcRenderer.on("roblox-launched", (event, data) => {
        if (data.instanceData) { const pid = data.instanceData.pid; robloxInstances.set(pid, { ...data.instanceData, accountUsername: data.instanceData.accountUsername }); }
        updateStats(); refreshInstances(); showNotification("Roblox launched successfully", "success");
    });

    ipcRenderer.on("instance-closed", (event, data) => {
        console.log('[Frontend] Instance closed:', data.pid);
        robloxInstances.delete(data.pid); updateStats(); refreshInstances();
    });

    ipcRenderer.on("instance-pid-updated", (event, data) => {
        if (!data || !data.oldPid || !data.newPid) return;
        console.log('[Frontend] Instance PID updated:', data.oldPid, '->', data.newPid);
        const existing = robloxInstances.get(data.oldPid) || {};
        robloxInstances.delete(data.oldPid);
        robloxInstances.set(data.newPid, { ...existing, pid: data.newPid });
        refreshInstances();
    });

    ipcRenderer.on('pid-scan-status', (event, data) => {
        console.log('[PID Scan]', data.message);
        if (data.status === 'found') showNotification(`${data.message}`, 'success');
        else if (data.status === 'failed') showNotification(`${data.message}`, 'error');
        else if (data.status === 'error') showNotification(`${data.message}`, 'error');
    });

    ipcRenderer.on("guard-status", (event, data) => updateGuardStatusUI(data));

    ipcRenderer.on('instance-reopening', (event, data) => { console.log('[AutoReopen] Reopening instance:', data); showNotification(data.message || `Roblox crashed. Auto-reopening...`, 'warning'); });
    ipcRenderer.on('instance-reopened', (event, data) => { console.log('[AutoReopen] Instance reopened:', data); showNotification(data.message || `Roblox relaunched successfully (PID: ${data.newPid})`, 'success'); refreshInstances(); });
    ipcRenderer.on('instance-reopen-failed', (event, data) => { console.log('[AutoReopen] Reopen failed:', data); showNotification(data.message || `Auto-reopen failed: ${data.error}`, 'error'); });
    ipcRenderer.on('instance-reopen-exhausted', (event, data) => { console.log('[AutoReopen] Max attempts exhausted:', data); showNotification(data.message || `Max reopen attempts (${data.attempts}) reached`, 'error'); });

    ipcRenderer.on("cookie-captured", (event, data) => {
        const captureName = String(data?.username || data?.displayName || "").trim() || (data?.userId != null ? `User ${data.userId}` : "account");
        const hasFullCookieBundle = !!getEffectiveAccountRbxIdCheck({ rbxIdCheck: typeof data?.rbxIdCheck === "string" ? data.rbxIdCheck : "" });
        const methodSuffix = data.loginMethod ? ` via ${data.loginMethod}` : "";
        showNotification(hasFullCookieBundle ? `Cookie captured for ${captureName}${methodSuffix}` : `Cookie captured for ${captureName}${methodSuffix}. Waiting for .RBXIDCHECK...`, hasFullCookieBundle ? "success" : "warning");
        if (data.loginMethod === "code") applyQuickSigninStatus({ active: false, state: "confirmed" });
        addAccountFromLogin(data);
    });

    ipcRenderer.on("quick-signin-status", (event, data) => applyQuickSigninStatus(data));
    ipcRenderer.on("quick-signin-code", (event, data) => applyQuickSigninStatus({ active: true, state: "awaiting_confirm", code: data?.code || "", expiresAt: Date.now() + QUICK_SIGNIN_CODE_TTL_MS }));
    ipcRenderer.on('settings-loaded', (event, s) => { if (s && document.getElementById('hideCaptureToggle')) document.getElementById('hideCaptureToggle').checked = !!s.hideCapture; });

    setInterval(() => { if (document.hidden || !isTabActive("instances")) return; refreshInstances(); }, INSTANCE_REFRESH_INTERVAL_MS);
}

// ─── Startup Sequence ────────────────────────────────────────────────────────
const STARTUP_SAFETY_TIMEOUT_MS = 15000; // Force-hide overlay after 15s max

let startupSafetyTimer = setTimeout(() => {
    console.warn("[Startup] Safety timeout reached — forcing overlay hide");
    hideStartupLoadingOverlay();
}, STARTUP_SAFETY_TIMEOUT_MS);

async function init() {
    const startupErrors = [];
    const runStartupStep = async (label, percent, work) => { setStartupLoadingProgress(label, percent); try { await work(); } catch (error) { startupErrors.push({ label, error }); console.error(`[Startup] ${label} failed:`, error); } };

    try {
        await runStartupStep("Initializing app console...", 8, async () => { installRendererConsoleCapture(); await initializeConsoleLogs(); bindMainConsoleStream(); updateConsoleControlLabels(); });
        await runStartupStep("Loading accounts...", 24, async () => { await loadAccounts(); renderAccounts(); updateAccountSelects(); updateStats(); });
        await runStartupStep("Loading settings...", 40, async () => { await loadSettings(); applySavedPrivateServerUrl(); renderAdvancedFflagOptions(); loadFFlags(); });
        await runStartupStep("Resolving Roblox install paths...", 54, async () => { await loadRobloxPathInfo(); await loadFontSettings(); });
        await runStartupStep("Fetching Roblox deploy + installed versions...", 74, async () => { await checkRobloxVersionsFull({ silent: true, notifyResult: false }); });
        await runStartupStep("Syncing running Roblox instances...", 88, async () => { await refreshInstances(); await refreshGuardStatus(); });

        applyQuickSigninStatus({ active: false, state: "idle" });
        setStartupLoadingProgress(startupErrors.length > 0 ? `Startup complete with ${startupErrors.length} warning(s).` : "Startup complete.", 100);

        bindIpcListeners();
        initUpdateListeners();

        // Check for updates AFTER handlers are registered (fire & forget, don't block startup)
        setTimeout(() => { checkForUpdates(); }, 1000);

        if (startupErrors.length > 0) showNotification(`Startup completed with ${startupErrors.length} issue(s). Check Console tab for details.`, "warning");
    } finally {
        clearTimeout(startupSafetyTimer);
        startupSafetyTimer = null;
        setTimeout(() => hideStartupLoadingOverlay(), 180);
    }
}

// ─── DOMContentLoaded ────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
    applyInteractionSafetyMode();
    bindModalBackdropDismiss();
    await init();
    applyInteractionSafetyMode();
    setTimeout(applyInteractionSafetyMode, 250);
    switchTab('accounts');
    const preferredTab = getStoredActiveTab();
    switchTab(document.getElementById(`tab-${preferredTab}`) ? preferredTab : "accounts");
});
