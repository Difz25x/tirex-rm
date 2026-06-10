// TiRex RM — Modals
// All modal open/close logic: login, account, confirm, version select

// ─── Account Modal ───────────────────────────────────────────────────────────
function openAddModal() {
    editingAccountId = null;
    document.getElementById("modalTitle").textContent = "Add Account";
    document.getElementById("modalUsername").value = "";
    document.getElementById("modalAlias").value = "";
    document.getElementById("modalType").value = accounts.some((a) => isMainAccountRecord(a)) ? ALT_ACCOUNT_TYPE : MAIN_ACCOUNT_TYPE;
    document.getElementById("modalDescription").value = "";
    document.getElementById("modalCookie").value = "";
    document.getElementById("launchModalBtn").style.display = "none";
    document.getElementById("reopenModalBtn").style.display = "none";
    document.getElementById("deleteBtn").style.display = "none";
    document.getElementById("saveBtn").textContent = "Add Account";
    document.getElementById("accountModal").classList.add("active");
}

function openEditModal(id) {
    const account = accounts.find((a) => a.id === id);
    if (!account) return;
    editingAccountId = id; selectedAccountId = id;
    document.getElementById("modalTitle").textContent = "Edit Account";
    document.getElementById("modalUsername").value = account.username || "";
    document.getElementById("modalAlias").value = account.alias || "";
    document.getElementById("modalType").value = normalizeAccountType(account.type);
    document.getElementById("modalDescription").value = account.description || "";
    document.getElementById("modalCookie").value = account.cookie || "";
    document.getElementById("launchModalBtn").style.display = "flex";
    document.getElementById("reopenModalBtn").style.display = "flex";
    document.getElementById("deleteBtn").style.display = "flex";
    document.getElementById("saveBtn").textContent = "Save Changes";
    document.getElementById("accountModal").classList.add("active");
}

function closeAccountModal() { document.getElementById("accountModal").classList.remove("active"); }

async function saveAccount() {
    const username = document.getElementById("modalUsername").value.trim();
    const alias = document.getElementById("modalAlias").value.trim();
    const type = normalizeAccountType(document.getElementById("modalType").value);
    const description = document.getElementById("modalDescription").value.trim();
    const cookieInput = document.getElementById("modalCookie").value.trim();
    const authCookies = extractRobloxAuthCookies(cookieInput);
    if (!username) { showNotification("Username is required", "error"); return; }
    let nextAccounts = accounts.map((a) => ({ ...a }));
    let targetAccountId = editingAccountId;
    const successMessage = editingAccountId ? "Account updated" : "Account added";
    if (editingAccountId) {
        const account = nextAccounts.find((a) => a.id === editingAccountId);
        if (!account) { showNotification("Account not found", "error"); return; }
        account.username = username; account.alias = alias; account.type = type; account.description = description; account.cookie = authCookies.cookie; account.rbxIdCheck = authCookies.rbxIdCheck || account.rbxIdCheck || "";
    } else {
        const maxId = nextAccounts.length > 0 ? Math.max(...nextAccounts.map((a) => a.id)) : 0;
        targetAccountId = maxId + 1;
        nextAccounts.push({ id: targetAccountId, username, alias, type, description, cookie: authCookies.cookie, rbxIdCheck: authCookies.rbxIdCheck || "", lastUsed: Date.now() });
    }
    const preferredMainId = type === MAIN_ACCOUNT_TYPE ? Number(targetAccountId) : null;
    const resolution = resolveMainAccountState(nextAccounts, { preferredMainId });
    if (resolution.needsSelection) {
        openMainAccountSelectionModal({ title: "Select Main Account", description: "At least one account must stay marked as Main. Choose which account should keep the Main role before saving.", note: "Only one Main account is allowed at a time.", draftAccounts: resolution.accounts, candidateIds: resolution.candidateIds, preferredMainId, confirmLabel: editingAccountId ? "Save & Set Main" : "Add & Set Main", allowCancel: true, hideAccountModal: true, reopenAccountModalOnCancel: true, closeAccountModalOnSuccess: true, selectedAccountIdOnSuccess: targetAccountId, editingAccountIdOnSuccess: editingAccountId, successMessage });
        return;
    }
    const saveResult = await persistAccountsToDisk(resolution.accounts);
    if (!saveResult.success) { showNotification("Failed to save account", "error"); return; }
    selectedAccountId = Number(targetAccountId);
    refreshAccountViews(); closeAccountModal(); showNotification(successMessage, "success");
}

async function deleteAccount() {
    if (!editingAccountId) return;
    const account = accounts.find((a) => a.id === editingAccountId);
    if (!account) { showNotification("Account not found", "error"); return; }
    const displayName = getAccountDisplayName(account);
    const remainingAccounts = accounts.filter((a) => a.id !== editingAccountId);
    const isDeletingMain = isMainAccountRecord(account);
    const confirmMessage = isDeletingMain && remainingAccounts.length > 0 ? `Delete "${displayName}" permanently?\n\nThis account is currently Main. You will need to choose a new Main from the remaining accounts.` : `Delete "${displayName}" permanently?\n\nThis action cannot be undone.`;
    if (!confirm(confirmMessage)) return;
    if (isDeletingMain && remainingAccounts.length > 0) {
        openMainAccountSelectionModal({ title: "Replace Main Account", description: `"${displayName}" is currently set as Main. Choose which remaining account should become the new Main before deletion continues.`, note: "Deleting the active Main requires a replacement Main.", draftAccounts: remainingAccounts, candidateIds: remainingAccounts.map((c) => c.id), confirmLabel: "Delete & Set Main", allowCancel: true, hideAccountModal: true, reopenAccountModalOnCancel: true, closeAccountModalOnSuccess: true, clearSelectedAccountId: true, clearEditingAccountId: true, successMessage: "Account deleted" });
        return;
    }
    selectedAccountIds.delete(editingAccountId);
    if (selectedAccountId === editingAccountId) selectedAccountId = null;
    editingAccountId = null;
    const resolution = resolveMainAccountState(remainingAccounts);
    if (resolution.needsSelection) {
        openMainAccountSelectionModal({ title: "Select Main Account", description: "One remaining account must be marked as Main before deletion can finish.", note: "Only one Main account is allowed at a time.", draftAccounts: resolution.accounts, candidateIds: resolution.candidateIds, confirmLabel: "Set Main", allowCancel: true, hideAccountModal: true, reopenAccountModalOnCancel: true, closeAccountModalOnSuccess: true, successMessage: "Account deleted" });
        return;
    }
    const saveResult = await persistAccountsToDisk(resolution.accounts);
    if (!saveResult.success) { showNotification("Failed to delete account", "error"); return; }
    refreshAccountViews(); closeAccountModal(); showNotification("Account deleted", "success");
}

async function launchAccountFromModal(options = {}) {
    if (!editingAccountId) return;
    const account = accounts.find((a) => a.id === editingAccountId);
    if (!account || !accountHasSessionBundle(account)) { showNotification("Selected account is missing full cookie bundle", "error"); return; }
    closeAccountModal();
    if (!robloxVersions.installed.length) { showNotification("No Roblox version installed. Download one first.", "error"); return; }
    openVersionSelectModal({ type: 'only', account: account, forceAutoReopen: options.forceAutoReopen === true });
}

function sortAccounts() {
    const sortType = document.getElementById("sortSelect").value;
    if (sortType === "name") accounts.sort((a, b) => a.username.localeCompare(b.username));
    else if (sortType === "type") accounts.sort((a, b) => { if (normalizeAccountType(a.type) === MAIN_ACCOUNT_TYPE) return -1; if (normalizeAccountType(b.type) === MAIN_ACCOUNT_TYPE) return 1; return a.username.localeCompare(b.username); });
    else if (sortType === "recent") accounts.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
    saveAccounts(); renderAccounts(); showNotification("Accounts sorted", "success");
}

// ─── Login Modals ────────────────────────────────────────────────────────────
function openLoginMethodModal() { document.getElementById("loginMethodModal").classList.add("active"); }
function closeLoginMethodModal() { document.getElementById("loginMethodModal").classList.remove("active"); }
function openLoginModalFromMethod() { closeLoginMethodModal(); openLoginModal(); }
function openCodeLoginModalFromMethod() { closeLoginMethodModal(); openCodeLoginModal(); }

async function openBrowserLogin() {
    try { showNotification("Opening login window...", "info"); const result = await ipcRenderer.invoke("open-login-window", { loginMethod: "browser" }); if (result.success) { showNotification("Login window opened. Sign in to capture cookie.", "info"); closeLoginMethodModal(); } else throw new Error(result.error || "Failed to open login window"); }
    catch (error) { showNotification(`Error: ${error.message}`, "error"); }
}

function openManualAccount() { closeLoginMethodModal(); openAddModal(); }

function openLoginModal() { document.getElementById("loginUsername").value = ""; document.getElementById("loginPassword").value = ""; document.getElementById("loginModal").classList.add("active"); }
function closeLoginModal() { document.getElementById("loginPassword").value = ""; document.getElementById("loginModal").classList.remove("active"); }

function openCodeLoginModal() { document.getElementById("loginCodeInput").value = ""; document.getElementById("codeLoginModal").classList.add("active"); }
function closeCodeLoginModal() { document.getElementById("loginCodeInput").value = ""; document.getElementById("codeLoginModal").classList.remove("active"); }

async function startAutoLogin() {
    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;
    if (!username || !password) { showNotification("Username and password are required", "error"); return; }
    try { showNotification("Opening login window...", "info"); const result = await ipcRenderer.invoke("open-login-window", { loginMethod: "auto", username, password }); if (result.success) { showNotification("Login window opened. Auto-login in progress...", "info"); closeLoginModal(); } else throw new Error(result.error || "Failed to open login window"); }
    catch (error) { showNotification(`Error: ${error.message}`, "error"); }
    finally { document.getElementById("loginPassword").value = ""; }
}

async function startCodeLogin() {
    const rawCode = document.getElementById("loginCodeInput").value.trim();
    const code = String(rawCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (rawCode && code.length !== 6) { showNotification("Code login needs a 6-character Roblox code", "error"); return; }
    document.getElementById("loginCodeInput").value = code;
    try {
        if (!code) applyQuickSigninStatus({ active: true, state: "starting", code: "", expiresAt: 0 });
        else showNotification("Starting code login in headless browser...", "info");
        const result = await ipcRenderer.invoke("open-login-window", { loginMethod: "code", quickCode: code, headless: true });
        if (result.success) { if (code) showNotification("Code login started. Waiting for cookie capture...", "info"); closeCodeLoginModal(); }
        else throw new Error(result.error || "Failed to start code login");
    } catch (error) { showNotification(`Error: ${error.message}`, "error"); }
}

// ─── Version Select Modal ────────────────────────────────────────────────────
let pendingLaunchContext = null;
let isLaunchingFromVersionModal = false;

function openVersionSelectModal(context) {
    pendingLaunchContext = context;
    const modal = document.getElementById("versionSelectModal");
    const list = document.getElementById("versionSelectList");
    const titleEl = document.getElementById("versionSelectTitle");
    const descriptionEl = document.getElementById("versionSelectDescription");
    list.innerHTML = "";
    if (context.type === "multi-only" || context.type === "multi-server") {
        const count = Array.isArray(context.accounts) ? context.accounts.length : 0;
        if (titleEl) titleEl.textContent = context.type === "multi-server" ? "Join Game with Multiple Accounts" : "Launch Multiple Accounts";
        if (descriptionEl) descriptionEl.textContent = context.type === "multi-server" ? `Select version to join using ${count} account${count !== 1 ? "s" : ""} simultaneously:` : `Select version to launch ${count} account${count !== 1 ? "s" : ""} simultaneously:`;
    } else { if (titleEl) titleEl.textContent = "Select Roblox Version"; if (descriptionEl) descriptionEl.textContent = "Multiple Roblox versions detected. Select which version to launch:"; }
    const installedVersions = Array.isArray(robloxVersions.installed) ? [...robloxVersions.installed] : [];
    if (robloxVersions.live && installedVersions.includes(robloxVersions.live)) installedVersions.sort((a, b) => { if (a === robloxVersions.live) return -1; if (b === robloxVersions.live) return 1; return 0; });
    installedVersions.forEach((version, index) => {
        const versionItem = document.createElement("div");
        versionItem.style.marginBottom = "12px"; versionItem.style.cursor = "pointer";
        const isLive = version === robloxVersions.live;
        let bgStyle = "rgba(255, 255, 255, 0.03)", borderStyle = "1px solid rgba(255, 255, 255, 0.1)", glowStyle = "";
        if (isLive) { bgStyle = "linear-gradient(135deg, rgba(50, 205, 47, 0.1), rgba(50, 205, 47, 0.02))"; borderStyle = "1px solid rgba(50, 205, 47, 0.3)"; glowStyle = "box-shadow: 0 0 20px rgba(50, 205, 47, 0.1);"; }
        versionItem.innerHTML = `<div class="version-card-inner" style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: ${bgStyle}; border: ${borderStyle}; border-radius: 16px; ${glowStyle} transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); position: relative; overflow: hidden;" onmouseover="this.style.transform='translateY(-2px)'; this.style.borderColor='var(--primary)'; this.style.backgroundColor='rgba(255, 255, 255, 0.05)';" onmouseout="this.style.transform='translateY(0)'; this.style.borderColor='${isLive ? 'rgba(50, 205, 47, 0.3)' : 'rgba(255, 255, 255, 0.1)'}'; this.style.backgroundColor='${bgStyle}';"><div style="display: flex; flex-direction: column; gap: 6px;"><div style="display: flex; align-items: center; gap: 10px;"><span style="font-family: 'Consolas', monospace; font-size: 15px; font-weight: 600; color: var(--text); letter-spacing: 0.5px;">${version.substring(0, 18)}...</span>${isLive ? `<div style="display: flex; align-items: center; gap: 4px; background: rgba(50, 205, 47, 0.2); border: 1px solid rgba(50, 205, 47, 0.3); padding: 4px 10px; border-radius: 20px;"><div style="width: 6px; height: 6px; background: #32cd2f; border-radius: 50%; box-shadow: 0 0 8px #32cd2f;"></div><span style="font-size: 10px; font-weight: 700; color: #32cd2f; letter-spacing: 0.5px;">LIVE</span></div>` : ''}</div><span style="font-size: 12px; color: var(--text-dim); display: flex; align-items: center; gap: 6px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>Installed Version ${index + 1}</span></div><div style="width: 40px; height: 40px; border-radius: 12px; background: linear-gradient(135deg, var(--primary), var(--primary-dark)); display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(124, 124, 255, 0.3); transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);" class="launch-btn-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M8 5v14l11-7z"></path></svg></div></div>`;
        versionItem.onclick = () => launchWithSelectedVersion(version);
        list.appendChild(versionItem);
    });
    const reopenToggleDiv = document.createElement('div');
    reopenToggleDiv.innerHTML = `<div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border);"><div style="display: flex; align-items: center; justify-content: space-between; padding: 12px; background: rgba(50, 205, 47, 0.05); border: 1px solid rgba(50, 205, 47, 0.2); border-radius: 12px;"><div style="display: flex; align-items: center; gap: 12px;"><div style="width: 32px; height: 32px; border-radius: 8px; background: rgba(50, 205, 47, 0.15); display: flex; align-items: center; justify-content: center; color: var(--success);"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg></div><div><div style="font-weight: 600; font-size: 14px;">Enable Auto-Reopen</div><div style="font-size: 11px; color: var(--text-dim);">Automatically relaunch if Roblox crashes</div></div></div><label class="switch-toggle" style="transform: scale(0.9);"><input type="checkbox" id="launchAutoReopenToggle"><span class="slider-round"></span></label></div></div>`;
    list.appendChild(reopenToggleDiv);
    setTimeout(() => { const toggle = document.getElementById('launchAutoReopenToggle'); if (toggle) toggle.checked = context && context.forceAutoReopen === true ? true : settings.autoReopen !== false; }, 0);
    modal.classList.add("active");
}

function closeVersionSelectModal() { document.getElementById("versionSelectModal").classList.remove("active"); pendingLaunchContext = null; }

async function launchWithSelectedVersion(version) {
    if (isLaunchingFromVersionModal) { showNotification("Launch is already in progress. Please wait.", "warning"); return; }
    if (!pendingLaunchContext) { showNotification("No launch context data!", "error"); closeVersionSelectModal(); return; }
    isLaunchingFromVersionModal = true;
    const context = pendingLaunchContext;
    const autoReopenToggle = document.getElementById('launchAutoReopenToggle');
    const autoReopen = context && typeof context.forceAutoReopen === "boolean" ? context.forceAutoReopen : autoReopenToggle && typeof autoReopenToggle.checked === "boolean" ? autoReopenToggle.checked : settings.autoReopen !== false;
    closeVersionSelectModal();
    try {
        if (context.type === "multi-only" || context.type === "multi-server") {
            let selectedAccounts = Array.isArray(context.accounts) ? context.accounts : [];
            if (!selectedAccounts.length) { showNotification("No selected accounts to launch", "error"); return; }
            const seenCookies = new Set();
            const dedupedAccounts = [];
            let duplicateCookieCount = 0;
            selectedAccounts.forEach((account) => { const cookieKey = accountHasCookie(account) ? String(account.cookie).trim() : ""; const checkerKey = getEffectiveAccountRbxIdCheck(account); if (!cookieKey || !checkerKey) return; const bundleKey = `${cookieKey}:${checkerKey}`; if (seenCookies.has(bundleKey)) { duplicateCookieCount++; return; } seenCookies.add(bundleKey); dedupedAccounts.push(account); });
            selectedAccounts = dedupedAccounts;
            if (!selectedAccounts.length) { showNotification("No valid account cookie bundle found", "error"); return; }
            if (duplicateCookieCount > 0) showNotification(`${duplicateCookieCount} account skipped (duplicate cookie)`, "warning");
            const isServerLaunch = context.type === "multi-server";
            showNotification(`${isServerLaunch ? "Joining game with" : "Launching"} ${selectedAccounts.length} accounts (${autoReopen ? 'Auto-Reopen ON' : 'Auto-Reopen OFF'})...`, "info");
            const launchResults = [];
            const guardBlockedAccounts = [];
            const launchGapMs = 1800;
            for (let i = 0; i < selectedAccounts.length; i++) {
                const account = selectedAccounts[i];
                showNotification(`${isServerLaunch ? "Joining" : "Launching"} ${i + 1}/${selectedAccounts.length}: ${account.username}`, "info");
                let launchResult;
                try { launchResult = isServerLaunch ? await ipcRenderer.invoke("launch-roblox", { version, placeId: context.placeId, jobId: context.jobId, privateServerLinkCode: context.privateServerLinkCode || null, cookie: account.cookie, rbxIdCheck: getEffectiveAccountRbxIdCheck(account), accountInfo: { id: account.id, username: account.username }, autoReopen, launchOptions: { requireMultiInstance: true, stabilizeDelayMs: 3000, preventiveRestart: !!autoReopen, preventiveRestartBaseMinutes: 205, preventiveRestartJitterMinutes: 10 } }) : await ipcRenderer.invoke("launch-roblox-only", { version, cookie: account.cookie, rbxIdCheck: getEffectiveAccountRbxIdCheck(account), accountInfo: { id: account.id, username: account.username }, autoReopen, launchOptions: { requireMultiInstance: true, stabilizeDelayMs: 3000, preventiveRestart: !!autoReopen, preventiveRestartBaseMinutes: 205, preventiveRestartJitterMinutes: 10 } }); }
                catch (error) { launchResult = { success: false, error: error?.message || "Unknown error" }; }
                launchResults.push({ account, result: launchResult });
                if (!launchResult?.success && isGuardLaunchError(launchResult?.error)) { guardBlockedAccounts.push(...selectedAccounts.slice(i)); break; }
                if (i < selectedAccounts.length - 1) await new Promise((resolve) => setTimeout(resolve, launchGapMs));
            }
            let successCount = 0, failureCount = 0, firstError = null;
            launchResults.forEach((entry) => { if (entry.result?.success) { successCount++; const accountIndex = accounts.findIndex((a) => a.id === entry.account.id); if (accountIndex !== -1) accounts[accountIndex].lastUsed = Date.now(); } else { failureCount++; if (!firstError) firstError = entry.result?.error || "Unknown error"; } });
            if (successCount > 0) await ipcRenderer.invoke("save-accounts", accounts);
            if (guardBlockedAccounts.length > 0) {
                const fallbackCandidates = guardBlockedAccounts.filter((a) => a && typeof a.cookie === "string" && a.cookie.trim().length > 0);
                if (fallbackCandidates.length > 0) { showNotification("Multi-instance guard failed. Choose one account to launch.", "warning"); openAccountLaunchSelectModal({ type: isServerLaunch ? "guard-fallback-server" : "guard-fallback-only", selectionMode: "single", accounts: fallbackCandidates, preselectedAccountIds: [fallbackCandidates[0].id], version, placeId: context.placeId, jobId: context.jobId, privateServerLinkCode: context.privateServerLinkCode || null, autoReopen }); return; }
            }
            if (failureCount === 0) showNotification(`${isServerLaunch ? "Joined game with" : "Launched"} ${successCount} account${successCount !== 1 ? "s" : ""} successfully`, "success");
            else showNotification(`${isServerLaunch ? "Joined" : "Launched"} ${successCount}/${selectedAccounts.length}. ${failureCount} failed${firstError ? ` (${firstError})` : ""}`, failureCount === selectedAccounts.length ? "error" : "warning");
            clearSelectedAccounts();
            return;
        }
        const account = context.account;
        if (!accountHasSessionBundle(account)) { showNotification("Selected account is missing .ROBLOSECURITY/.RBXIDCHECK bundle", "error"); return; }
        showNotification(`Launching Roblox (${autoReopen ? 'Auto-Reopen ON' : 'Auto-Reopen OFF'})...`, "info");
        let result;
        if (context.type === 'game' || context.type === 'server') result = await ipcRenderer.invoke("launch-roblox", { version, placeId: context.placeId, jobId: context.jobId, privateServerLinkCode: context.privateServerLinkCode || null, cookie: account.cookie, rbxIdCheck: getEffectiveAccountRbxIdCheck(account), accountInfo: { id: account.id, username: account.username }, autoReopen, launchOptions: { stabilizeDelayMs: 2000 } });
        else result = await ipcRenderer.invoke("launch-roblox-only", { version, cookie: account.cookie, rbxIdCheck: getEffectiveAccountRbxIdCheck(account), accountInfo: { id: account.id, username: account.username }, autoReopen, launchOptions: { stabilizeDelayMs: 2000 } });
        if (!result.success) { showNotification(`Launch failed: ${result.error || "Unknown error"}`, "error"); return; }
        const accountIndex = accounts.findIndex(a => a.id === account.id);
        if (accountIndex !== -1) { accounts[accountIndex].lastUsed = Date.now(); await ipcRenderer.invoke("save-accounts", accounts); }
    } catch (error) { showNotification(`Launch error: ${error.message}`, "error"); }
    finally { isLaunchingFromVersionModal = false; }
}

// ─── Account Launch Select Modal ─────────────────────────────────────────────
function getLaunchSelectionCandidates() {
    const context = pendingLaunchAccountSelection;
    const fromContext = Array.isArray(context?.accounts) ? context.accounts : null;
    if (!fromContext) return getLaunchableAccounts();
    const deduped = []; const seenIds = new Set();
    fromContext.forEach((a) => { if (!a || seenIds.has(a.id)) return; if (!accountHasSessionBundle(a)) return; seenIds.add(a.id); deduped.push(a); });
    return deduped;
}

function updateLaunchAccountSelectionUI() {
    const count = launchSelectedAccountIds.size;
    const countLabel = document.getElementById("launchSelectedCountLabel");
    const confirmBtn = document.getElementById("accountLaunchConfirmBtn");
    const selectAllBtn = document.getElementById("launchSelectAllBtn");
    const launchableAccounts = getLaunchSelectionCandidates();
    const selectionMode = pendingLaunchAccountSelection?.selectionMode === "single" ? "single" : "multi";
    if (countLabel) countLabel.textContent = selectionMode === "single" ? `${count} selected (single)` : `${count} selected`;
    if (confirmBtn) confirmBtn.disabled = count === 0 || (selectionMode === "single" && count > 1);
    if (selectAllBtn) { if (selectionMode === "single") selectAllBtn.style.display = "none"; else { selectAllBtn.style.display = "inline-flex"; selectAllBtn.disabled = launchableAccounts.length === 0; } }
}

function renderLaunchAccountSelectionList() {
    const list = document.getElementById("accountLaunchSelectList");
    if (!list) return;
    const launchableAccounts = getLaunchSelectionCandidates();
    const selectionMode = pendingLaunchAccountSelection?.selectionMode === "single" ? "single" : "multi";
    list.innerHTML = "";
    if (!launchableAccounts.length) { list.innerHTML = `<div class="empty-state" style="padding: 20px 10px;"><div class="empty-text">No account with full cookie bundle found</div></div>`; updateLaunchAccountSelectionUI(); return; }
    launchableAccounts.forEach((account) => {
        const item = document.createElement("div");
        const selected = launchSelectedAccountIds.has(account.id);
        item.className = `launch-account-item ${selected ? "selected" : ""}`;
        item.onclick = () => { if (selectionMode === "single") { if (launchSelectedAccountIds.has(account.id)) launchSelectedAccountIds.delete(account.id); else { launchSelectedAccountIds.clear(); launchSelectedAccountIds.add(account.id); } } else { if (launchSelectedAccountIds.has(account.id)) launchSelectedAccountIds.delete(account.id); else launchSelectedAccountIds.add(account.id); } renderLaunchAccountSelectionList(); };
        item.innerHTML = `<div style="display: flex; justify-content: space-between; gap: 12px; align-items: flex-start;"><div><div style="font-size: 14px; font-weight: 600; color: var(--text);">${account.username || "Unknown"}</div>${account.alias ? `<div style="font-size: 12px; color: var(--primary); margin-top: 3px;">${account.alias}</div>` : ""}<div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">${account.type || "Alt Account"}</div></div><div style="border: 1px solid ${selected ? "rgba(124, 124, 255, 0.5)" : "var(--border)"}; background: ${selected ? "rgba(124, 124, 255, 0.2)" : "rgba(255, 255, 255, 0.03)"}; color: ${selected ? "var(--primary)" : "var(--text-dim)"}; border-radius: 999px; padding: 4px 10px; font-size: 11px; font-weight: 600;">${selected ? (selectionMode === "single" ? "Chosen" : "Selected") : (selectionMode === "single" ? "Choose" : "Select")}</div></div>`;
        list.appendChild(item);
    });
    updateLaunchAccountSelectionUI();
}

function openAccountLaunchSelectModal(context) {
    pendingLaunchAccountSelection = context;
    launchSelectedAccountIds = new Set();
    const launchableAccounts = getLaunchSelectionCandidates();
    if (!launchableAccounts.length) { pendingLaunchAccountSelection = null; showNotification("No account with full cookie bundle found", "error"); return; }
    const titleEl = document.getElementById("accountLaunchSelectTitle");
    const descEl = document.getElementById("accountLaunchSelectDescription");
    if (context.type === "server") { if (titleEl) titleEl.textContent = "Select Accounts for Server Launch"; if (descEl) descEl.textContent = "Choose one or more accounts to join this game/server."; }
    else if (context.type === "guard-fallback-only" || context.type === "guard-fallback-server") { if (titleEl) titleEl.textContent = "Guard Failed - Pick One Account"; if (descEl) descEl.textContent = "Multi-instance guard is unavailable. Choose one account to launch now."; }
    else { if (titleEl) titleEl.textContent = "Select Accounts to Launch Client"; if (descEl) descEl.textContent = "Choose one or more accounts. All selected accounts will launch together."; }
    const preselected = Array.isArray(context.preselectedAccountIds) ? context.preselectedAccountIds : [];
    preselected.forEach((accountId) => { if (launchableAccounts.some((a) => a.id === accountId)) launchSelectedAccountIds.add(accountId); });
    const singleMode = pendingLaunchAccountSelection?.selectionMode === "single";
    if (singleMode) { if (launchSelectedAccountIds.size > 1) { const firstSelected = [...launchSelectedAccountIds][0]; launchSelectedAccountIds = new Set([firstSelected]); } if (!launchSelectedAccountIds.size && launchableAccounts[0]) launchSelectedAccountIds.add(launchableAccounts[0].id); }
    renderLaunchAccountSelectionList();
    document.getElementById("accountLaunchSelectModal").classList.add("active");
}

function closeAccountLaunchSelectModal() { document.getElementById("accountLaunchSelectModal").classList.remove("active"); pendingLaunchAccountSelection = null; launchSelectedAccountIds.clear(); }

function selectAllLaunchAccounts() {
    const launchableAccounts = getLaunchSelectionCandidates();
    const singleMode = pendingLaunchAccountSelection?.selectionMode === "single";
    if (singleMode) launchSelectedAccountIds = new Set(launchableAccounts[0] ? [launchableAccounts[0].id] : []);
    else launchSelectedAccountIds = new Set(launchableAccounts.map((a) => a.id));
    renderLaunchAccountSelectionList();
}

function clearLaunchAccountSelection() { launchSelectedAccountIds.clear(); renderLaunchAccountSelectionList(); }

async function confirmAccountLaunchSelection() {
    if (!pendingLaunchAccountSelection) { showNotification("No launch action pending", "error"); closeAccountLaunchSelectModal(); return; }
    const selectionMode = pendingLaunchAccountSelection?.selectionMode === "single" ? "single" : "multi";
    const launchableAccounts = getLaunchSelectionCandidates();
    const selectedAccounts = launchableAccounts.filter((a) => launchSelectedAccountIds.has(a.id));
    if (!selectedAccounts.length) { showNotification("Select at least one valid account", "error"); return; }
    if (selectionMode === "single" && selectedAccounts.length !== 1) { showNotification("Choose exactly one account", "error"); return; }
    const confirmBtn = document.getElementById("accountLaunchConfirmBtn");
    if (confirmBtn) confirmBtn.disabled = true;
    const context = pendingLaunchAccountSelection;
    try {
        if (context.type === "only") { closeAccountLaunchSelectModal(); openVersionSelectModal({ type: "multi-only", accounts: selectedAccounts }); return; }
        if (context.type === "server") { showNotification("Preparing game launch...", "info"); const prepared = await resolveServerLaunchData(context.payload, selectedAccounts[0].cookie); closeAccountLaunchSelectModal(); openVersionSelectModal({ type: "multi-server", accounts: selectedAccounts, placeId: prepared.placeId, jobId: prepared.jobId, privateServerLinkCode: prepared.privateServerLinkCode }); return; }
        if (context.type === "guard-fallback-only" || context.type === "guard-fallback-server") {
            const account = selectedAccounts[0];
            const isServerLaunch = context.type === "guard-fallback-server";
            if (!context.version) throw new Error("Missing selected Roblox version");
            closeAccountLaunchSelectModal();
            showNotification(`Launching fallback account: ${account.username}`, "info");
            const result = isServerLaunch ? await ipcRenderer.invoke("launch-roblox", { version: context.version, placeId: context.placeId, jobId: context.jobId, privateServerLinkCode: context.privateServerLinkCode || null, cookie: account.cookie, rbxIdCheck: getEffectiveAccountRbxIdCheck(account), accountInfo: { id: account.id, username: account.username }, autoReopen: !!context.autoReopen, launchOptions: { stabilizeDelayMs: 2200, preventiveRestart: !!context.autoReopen, preventiveRestartBaseMinutes: 205, preventiveRestartJitterMinutes: 10 } }) : await ipcRenderer.invoke("launch-roblox-only", { version: context.version, cookie: account.cookie, rbxIdCheck: getEffectiveAccountRbxIdCheck(account), accountInfo: { id: account.id, username: account.username }, autoReopen: !!context.autoReopen, launchOptions: { stabilizeDelayMs: 2200, preventiveRestart: !!context.autoReopen, preventiveRestartBaseMinutes: 205, preventiveRestartJitterMinutes: 10 } });
            if (!result?.success) throw new Error(result?.error || "Unknown error");
            const accountIndex = accounts.findIndex((a) => a.id === account.id);
            if (accountIndex !== -1) { accounts[accountIndex].lastUsed = Date.now(); await ipcRenderer.invoke("save-accounts", accounts); }
            showNotification(`Fallback launch success: ${account.username}`, "success");
            return;
        }
    } catch (error) { showNotification(`Failed: ${error.message}`, "error"); }
    finally { const modal = document.getElementById("accountLaunchSelectModal"); if (modal?.classList.contains("active") && confirmBtn) confirmBtn.disabled = false; }
}

// ─── Quick Sign-in Confirm Modal ─────────────────────────────────────────────
let quickSigninConfirmAccountId = null;
let quickSigninConfirmPending = false;

function setQuickSigninConfirmStatus(message = "", type = "info") {
    const statusEl = document.getElementById("quickSigninConfirmStatus");
    if (!statusEl) return;
    const text = String(message || "").trim();
    if (!text) { statusEl.style.display = "none"; statusEl.textContent = ""; statusEl.className = "quick-signin-confirm-status"; return; }
    statusEl.style.display = "block"; statusEl.textContent = text; statusEl.className = `quick-signin-confirm-status ${type}`;
}

function openQuickSigninConfirmModalFromAccount() {
    if (!editingAccountId) { showNotification("Select an account first", "error"); return; }
    const account = accounts.find((a) => a.id === editingAccountId);
    if (!account) { showNotification("Account not found", "error"); return; }
    if (!account.cookie || !account.cookie.trim()) { showNotification("Selected account has no active cookie", "error"); return; }
    quickSigninConfirmAccountId = account.id;
    document.getElementById("quickSigninConfirmCodeInput").value = "";
    document.getElementById("quickSigninConfirmCookieInput").value = formatAuthCookieBundle(account) || account.cookie || "";
    document.getElementById("quickSigninConfirmTargetLabel").textContent = `Using: ${account.alias || account.username || "Selected account"}`;
    const submitBtn = document.getElementById("quickSigninConfirmSubmitBtn");
    if (submitBtn) submitBtn.disabled = false;
    setQuickSigninConfirmStatus("Paste the 6-character code, then press Confirm Code.", "info");
    document.getElementById("quickSigninConfirmModal").classList.add("active");
}

function closeQuickSigninConfirmModal() {
    if (quickSigninConfirmPending) return;
    quickSigninConfirmAccountId = null;
    setQuickSigninConfirmStatus("", "info");
    document.getElementById("quickSigninConfirmCodeInput").value = "";
    document.getElementById("quickSigninConfirmCookieInput").value = "";
    document.getElementById("quickSigninConfirmModal").classList.remove("active");
}

async function submitQuickSigninConfirm() {
    if (quickSigninConfirmPending) return;
    const code = String(document.getElementById("quickSigninConfirmCodeInput").value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const cookie = String(document.getElementById("quickSigninConfirmCookieInput").value || "").trim();
    const selectedAccount = quickSigninConfirmAccountId != null ? accounts.find((a) => a.id === quickSigninConfirmAccountId) : null;
    const authCookies = extractRobloxAuthCookies(cookie);
    if (!/^[A-Z0-9]{6}$/.test(code)) { setQuickSigninConfirmStatus("Code must be 6 letters/numbers.", "error"); return; }
    if (!authCookies.cookie) { setQuickSigninConfirmStatus(".ROBLOSECURITY is required for confirmation.", "error"); return; }
    const submitBtn = document.getElementById("quickSigninConfirmSubmitBtn");
    quickSigninConfirmPending = true;
    if (submitBtn) submitBtn.disabled = true;
    setQuickSigninConfirmStatus("Opening hidden Roblox confirmation page and submitting code...", "info");
    try {
        const result = await ipcRenderer.invoke("confirm-quick-signin-code", { code, cookie: authCookies.cookie, rbxIdCheck: authCookies.rbxIdCheck || getEffectiveAccountRbxIdCheck(selectedAccount) });
        if (!result || !result.success) throw new Error(result?.error || "Failed to submit Quick Sign-in code");
        setQuickSigninConfirmStatus(result.message || "Code submitted. Wait for the login side to capture cookie.", "success");
        showNotification(result.message || "Quick Sign-in code submitted");
        if (quickSigninConfirmAccountId != null) {
            const accountIndex = accounts.findIndex((a) => a.id === quickSigninConfirmAccountId);
            if (accountIndex !== -1) { accounts[accountIndex].cookie = authCookies.cookie; accounts[accountIndex].rbxIdCheck = authCookies.rbxIdCheck || accounts[accountIndex].rbxIdCheck || ""; await ipcRenderer.invoke("save-accounts", accounts); renderAccounts(); updateAccountSelects(); }
        }
    } catch (error) { setQuickSigninConfirmStatus(error.message || "Failed to confirm code.", "error"); showNotification(`Quick Sign-in failed: ${error.message}`, "error"); }
    finally { quickSigninConfirmPending = false; if (submitBtn) submitBtn.disabled = false; }
}

// ─── Quick Sign-in Panel ─────────────────────────────────────────────────────
let quickSigninUIState = { active: false, code: "", expiresAt: 0, state: "idle", sessionId: 0 };
let quickSigninUITimer = null;

function formatQuickSigninCountdown(expiresAt) {
    if (!expiresAt || !Number.isFinite(expiresAt)) return "--:--";
    const remainingMs = Math.max(0, expiresAt - Date.now());
    const totalSeconds = Math.floor(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getQuickSigninStateLabel(state) { const n = String(state || "").toLowerCase(); return { starting: "Starting", refreshing: "Refreshing", awaiting_confirm: "Waiting Confirm", confirmed: "Confirmed", error: "Error" }[n] || "Idle"; }

function getQuickSigninStatusText(state) { const n = String(state || "").toLowerCase(); return { starting: "Opening Quick Sign-in flow...", refreshing: "Code expired, fetching a new code...", awaiting_confirm: "Enter this code on your logged-in Roblox device, then wait for cookie capture.", confirmed: "Confirmation detected, finishing login...", closed: "Session closed.", inactive: "Session inactive.", error: "Failed to refresh code. Try again." }[n] || "Waiting for code..."; }

function clearQuickSigninUITimer() { if (quickSigninUITimer) { clearInterval(quickSigninUITimer); quickSigninUITimer = null; } }

function ensureQuickSigninUITimer() { if (quickSigninUITimer) return; quickSigninUITimer = setInterval(() => { if (!quickSigninUIState.active) { clearQuickSigninUITimer(); return; } renderQuickSigninPanel(); }, 1000); }

function renderQuickSigninPanel() {
    const panel = document.getElementById("quickSigninPanel");
    if (!panel) return;
    const isActive = quickSigninUIState.active === true;
    panel.classList.toggle("active", isActive);
    if (!isActive) return;
    const codeValue = document.getElementById("quickSigninCodeValue");
    const expiresText = document.getElementById("quickSigninExpiresText");
    const statusText = document.getElementById("quickSigninStatusText");
    const statePill = document.getElementById("quickSigninStatePill");
    const refreshBtn = document.getElementById("quickSigninRefreshBtn");
    const copyBtn = document.getElementById("quickSigninCopyBtn");
    const normalizedState = String(quickSigninUIState.state || "idle").toLowerCase();
    const code = (quickSigninUIState.code || "").trim().toUpperCase();
    const hasCode = /^[A-Z0-9]{6}$/.test(code);
    if (codeValue) codeValue.textContent = hasCode ? code : "------";
    if (expiresText) expiresText.textContent = hasCode ? `Expires in ${formatQuickSigninCountdown(quickSigninUIState.expiresAt)}` : "Expires in --:--";
    if (statusText) statusText.textContent = getQuickSigninStatusText(normalizedState);
    if (statePill) { statePill.className = `quick-signin-state-pill ${normalizedState}`; statePill.textContent = getQuickSigninStateLabel(normalizedState); }
    if (refreshBtn) refreshBtn.disabled = normalizedState === "refreshing" || normalizedState === "starting";
    if (copyBtn) copyBtn.disabled = !hasCode;
}

function applyQuickSigninStatus(data = {}) {
    const active = data.active === true;
    const state = typeof data.state === "string" && data.state.trim() ? data.state.trim() : quickSigninUIState.state;
    const code = typeof data.code === "string" ? data.code.trim().toUpperCase() : "";
    const expiresAtRaw = Number(data.expiresAt || 0);
    const expiresAt = Number.isFinite(expiresAtRaw) ? expiresAtRaw : 0;
    const sessionIdRaw = Number(data.sessionId || 0);
    const sessionId = Number.isFinite(sessionIdRaw) ? sessionIdRaw : 0;
    if (!active) {
        if (state === "confirmed") {
            const confirmedSessionId = sessionId || quickSigninUIState.sessionId;
            quickSigninUIState = { active: true, code: quickSigninUIState.code, expiresAt: 0, state: "confirmed", sessionId: confirmedSessionId };
            renderQuickSigninPanel(); clearQuickSigninUITimer();
            setTimeout(() => { if (quickSigninUIState.sessionId !== confirmedSessionId) return; quickSigninUIState = { active: false, code: "", expiresAt: 0, state: "idle", sessionId: 0 }; renderQuickSigninPanel(); }, 1800);
            return;
        }
        quickSigninUIState = { active: false, code: "", expiresAt: 0, state: state || "idle", sessionId };
        clearQuickSigninUITimer(); renderQuickSigninPanel(); return;
    }
    quickSigninUIState = { active: true, code: code || (state === "refreshing" ? "" : quickSigninUIState.code), expiresAt: expiresAt > 0 ? expiresAt : code ? Date.now() + QUICK_SIGNIN_CODE_TTL_MS : quickSigninUIState.expiresAt, state: state || "starting", sessionId };
    if (code) { try { clipboard.writeText(code); } catch {} }
    ensureQuickSigninUITimer(); renderQuickSigninPanel();
}

function copyQuickSigninCode() {
    const code = String(quickSigninUIState.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) { showNotification("No active Quick Sign-in code to copy", "error"); return; }
    try { clipboard.writeText(code); showNotification("Quick Sign-in code copied", "success"); } catch (error) { showNotification("Failed to copy Quick Sign-in code", "error"); }
}

async function refreshQuickSigninCode() {
    try { const result = await ipcRenderer.invoke("refresh-quick-signin-code"); if (!result || !result.success) showNotification(result?.error || "Failed to refresh code", "error"); }
    catch (error) { showNotification(`Failed to refresh code: ${error.message}`, "error"); }
}

async function cancelQuickSigninCode() {
    try { await ipcRenderer.invoke("close-login-window"); }
    catch (error) { showNotification(`Failed to close login: ${error.message}`, "error"); }
    finally { applyQuickSigninStatus({ active: false, state: "closed" }); }
}

// ─── Modal Backdrop Dismiss ──────────────────────────────────────────────────
const modalBackdropCloseHandlers = {
    instanceSettingsModal: () => closeInstanceSettings(),
    loginMethodModal: () => closeLoginMethodModal(),
    loginModal: () => closeLoginModal(),
    codeLoginModal: () => closeCodeLoginModal(),
    accountModal: () => closeAccountModal(),
    mainAccountSelectionModal: () => closeMainAccountSelectionModal(),
    quickSigninConfirmModal: () => closeQuickSigninConfirmModal(),
    accountLaunchSelectModal: () => closeAccountLaunchSelectModal(),
    versionSelectModal: () => closeVersionSelectModal(),
    reinstallModal: () => closeReinstallModal(),
};

function bindModalBackdropDismiss() {
    Object.entries(modalBackdropCloseHandlers).forEach(([modalId, closeHandler]) => {
        const modal = document.getElementById(modalId);
        if (!modal || modal.dataset.backdropDismissBound === "1") return;
        modal.dataset.backdropDismissBound = "1";
        modal.addEventListener("click", (event) => { if (event.target !== modal) return; if (typeof closeHandler === "function") closeHandler(); });
    });
}
