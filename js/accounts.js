// TiRex RM — Accounts Tab
// Account management: grid, CRUD, multi-select, launch, search/filter

let accounts = [];
let selectedAccountId = null;
let editingAccountId = null;
let selectedAccountIds = new Set();
let accountMultiSelectMode = false;
let pendingLaunchAccountSelection = null;
let launchSelectedAccountIds = new Set();
let accountSearchQuery = "";
let accountCookieFilter = "all";
let pendingMainAccountSelection = null;
let accountSearchDebounceTimer = null;

async function persistAccountsToDisk(accountList) {
    accounts = (Array.isArray(accountList) ? accountList : []).map((a) => normalizeAccountRecord(a));
    try { await ipcRenderer.invoke("save-accounts", accounts); return { success: true }; }
    catch (error) { console.error("Failed to save accounts:", error); return { success: false, error }; }
}

function refreshAccountViews() { renderAccounts(); updateAccountSelects(); updateStats(); }

function getFilteredAccounts() {
    const q = accountSearchQuery.trim().toLowerCase();
    return accounts.filter((a) => {
        const hasBundle = accountHasSessionBundle(a);
        if (accountCookieFilter === "active" && !hasBundle) return false;
        if (accountCookieFilter === "inactive" && hasBundle) return false;
        if (!q) return true;
        const haystack = [a.username, a.alias, a.type, a.description, a.userId].filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(q);
    });
}

function setAccountSearch(value) {
    accountSearchQuery = String(value || "").trim();
    if (accountSearchDebounceTimer) clearTimeout(accountSearchDebounceTimer);
    accountSearchDebounceTimer = setTimeout(() => { accountSearchDebounceTimer = null; renderAccounts(); }, ACCOUNT_SEARCH_DEBOUNCE_MS);
}

function setAccountCookieFilter(value) {
    accountCookieFilter = ["all", "active", "inactive"].includes(value) ? value : "all";
    renderAccounts();
}

function renderAccountCardHtml(account) {
    const hasCookie = accountHasCookie(account);
    const hasBundle = accountHasSessionBundle(account);
    const accountState = getAccountStateConfig(hasBundle, hasCookie);
    const selectedForEdit = !accountMultiSelectMode && account.id === selectedAccountId;
    const selectedForLaunch = selectedAccountIds.has(account.id);
    const accountTypeLabel = String(account.type || "Account").replace(/\s+account$/i, "").trim() || "Account";
    const indicatorClass = accountState.tone === 'success' ? 'ready' : (accountState.tone === 'error' || accountState.tone === 'danger' ? 'error' : '');
    return `<div class="account-card ${selectedForEdit ? "selected" : ""} ${selectedForLaunch ? "multi-selected" : ""}" data-account-id="${account.id}">
        <div class="account-card-info"><div class="account-avatar"><img src="https://ui-avatars.com/api/?name=${encodeURIComponent(account.username)}&background=222&color=fff&size=128" alt="Avatar"></div>
        <div class="account-text"><h3>${escapeHtml(account.username)}</h3><p>${escapeHtml(accountTypeLabel)}</p></div></div>
        <div class="account-status"><span class="status-indicator ${indicatorClass}"></span><span class="account-status-text">${escapeHtml(accountState.shortLabel)}</span></div>
        ${accountMultiSelectMode ? `<div class="badge ${selectedForLaunch ? "checked" : ""}">${selectedForLaunch ? "Selected" : "Select"}</div>` : ""}</div>`;
}

function bindAccountsGridInteractions() {
    const grid = document.getElementById("accountsGrid");
    if (!grid || grid.dataset.bound === "1") return;
    grid.dataset.bound = "1";
    grid.addEventListener("click", (event) => {
        const card = event.target.closest(".account-card[data-account-id]");
        if (!card || !grid.contains(card)) return;
        const accountId = Number(card.dataset.accountId);
        if (!Number.isFinite(accountId)) return;
        if (accountMultiSelectMode) { toggleAccountSelection(accountId); return; }
        openEditModal(accountId);
    });
}

function renderAccounts() {
    syncSelectedAccountsWithData();
    const grid = document.getElementById("accountsGrid");
    if (!grid) return;
    bindAccountsGridInteractions();
    const filteredAccounts = getFilteredAccounts();
    const summaryEl = document.getElementById("accountsFilterSummary");
    if (summaryEl) {
        const queryLabel = accountSearchQuery.trim() ? ` matching "${accountSearchQuery.trim()}"` : "";
        const filterLabel = accountCookieFilter === "active" ? " with active auth" : accountCookieFilter === "inactive" ? " missing auth" : "";
        summaryEl.textContent = `${filteredAccounts.length}/${accounts.length} account${accounts.length === 1 ? "" : "s"}${queryLabel}${filterLabel}`;
    }
    if (!filteredAccounts.length) {
        grid.innerHTML = `<div class="empty-state empty-state-inline"><div class="empty-text">No accounts match the current filter</div></div>`;
        updateSelectedAccountsUI();
        return;
    }
    grid.innerHTML = filteredAccounts.map((account) => renderAccountCardHtml(account)).join("");
    updateSelectedAccountsUI();
}

async function loadAccounts() {
    try {
        let loadedAccounts = await ipcRenderer.invoke("load-accounts");
        if (!Array.isArray(loadedAccounts)) loadedAccounts = [];
        loadedAccounts = loadedAccounts.map((a) => normalizeAccountRecord(a));
        const resolution = resolveMainAccountState(loadedAccounts);
        accounts = resolution.accounts.map((a) => normalizeAccountRecord(a));
        if (resolution.needsSelection) {
            queueRequiredMainAccountSelection({
                title: "Choose Main Account", description: "At least one account must be marked as Main. Choose which account should keep the Main role for this roster.",
                note: "Main is required whenever there are saved accounts.", draftAccounts: accounts, candidateIds: resolution.candidateIds, successMessage: "Main account updated",
            });
        } else if (resolution.changed) { await persistAccountsToDisk(accounts); }
    } catch (error) { accounts = []; }
}

async function saveAccounts() {
    const resolution = resolveMainAccountState(accounts);
    if (resolution.needsSelection) return { success: false, requiresMainSelection: true, resolution };
    return persistAccountsToDisk(resolution.accounts);
}

function syncSelectedAccountsWithData() {
    const validIds = new Set(accounts.map((a) => a.id));
    selectedAccountIds.forEach((id) => { if (!validIds.has(id)) selectedAccountIds.delete(id); });
}

function updateSelectedAccountsUI() {
    const selectedCount = selectedAccountIds.size;
    const toggleBtn = document.getElementById("toggleMultiSelectBtn");
    const clearBtn = document.getElementById("clearSelectedBtn");
    const launchBtn = document.getElementById("launchSelectedBtn");
    const badge = document.getElementById("selectedAccountsBadge");
    if (toggleBtn) toggleBtn.textContent = accountMultiSelectMode ? "Done Selecting" : "Select Multiple";
    if (clearBtn) { clearBtn.style.display = accountMultiSelectMode ? "flex" : "none"; clearBtn.disabled = selectedCount === 0; }
    if (launchBtn) launchBtn.disabled = selectedCount === 0;
    if (badge) { badge.style.display = accountMultiSelectMode ? "inline-flex" : "none"; badge.textContent = `${selectedCount} selected`; }
}

function toggleAccountMultiSelectMode() {
    accountMultiSelectMode = !accountMultiSelectMode;
    if (!accountMultiSelectMode) selectedAccountIds.clear();
    renderAccounts();
}

function toggleAccountSelection(accountId) {
    if (!accountMultiSelectMode) return;
    if (selectedAccountIds.has(accountId)) selectedAccountIds.delete(accountId); else selectedAccountIds.add(accountId);
    renderAccounts();
}

function clearSelectedAccounts() { selectedAccountIds.clear(); renderAccounts(); }

async function launchSelectedAccounts() {
    if (!selectedAccountIds.size) { showNotification("Select at least one account", "error"); return; }
    if (!robloxVersions.installed.length) { showNotification("No Roblox version installed", "error"); return; }
    const selectedAccounts = accounts.filter((a) => selectedAccountIds.has(a.id));
    const launchableAccounts = selectedAccounts.filter((a) => accountHasSessionBundle(a));
    if (!launchableAccounts.length) { showNotification("Selected accounts need full cookie bundle (.ROBLOSECURITY + .RBXIDCHECK)", "error"); return; }
    if (launchableAccounts.length < selectedAccounts.length) showNotification(`${selectedAccounts.length - launchableAccounts.length} account skipped (missing cookie bundle)`, "warning");
    openVersionSelectModal({ type: "multi-only", accounts: launchableAccounts });
}

function getLaunchableAccounts() { return accounts.filter((a) => accountHasSessionBundle(a)); }

function updateStats() {
    let activeAccounts = 0, latestLastUsed = 0;
    for (const a of accounts) {
        if (accountHasSessionBundle(a)) activeAccounts++;
        const lastUsed = Number(a?.lastUsed || 0);
        if (Number.isFinite(lastUsed) && lastUsed > latestLastUsed) latestLastUsed = lastUsed;
    }
    const inactiveAccounts = Math.max(0, accounts.length - activeAccounts);
    document.getElementById("accountCount").textContent = `${accounts.length} Account${accounts.length !== 1 ? "s" : ""}`;
    document.getElementById("instanceCount").textContent = `${robloxInstances.size} Instance${robloxInstances.size !== 1 ? "s" : ""}`;
    const totalEl = document.getElementById("accountsHeroTotal"); if (totalEl) totalEl.textContent = String(accounts.length);
    const activeEl = document.getElementById("accountsHeroActive"); if (activeEl) activeEl.textContent = String(activeAccounts);
    const inactiveEl = document.getElementById("accountsHeroInactive"); if (inactiveEl) inactiveEl.textContent = String(inactiveAccounts);
    const lastUsedEl = document.getElementById("accountsHeroLastUsed"); if (lastUsedEl) lastUsedEl.textContent = formatCompactDateTime(latestLastUsed);
}

function updateAccountSelects() {
    const selects = [document.getElementById("utilityAccountSelect")];
    const optionHtml = ['<option value="">Choose account...</option>', ...accounts.map((a) => {
        const label = `${getAccountDisplayName(a)}${isMainAccountRecord(a) ? " [Main]" : ""}${a.cookie ? " (Active)" : ""}`;
        return `<option value="${a.id}">${escapeHtml(label)}</option>`;
    })].join("");
    selects.forEach((select) => {
        if (!select) return;
        const previousValue = select.value;
        select.innerHTML = optionHtml;
        if (previousValue && accounts.some((a) => String(a.id) === String(previousValue))) select.value = previousValue;
    });
}

function refreshAccounts() {
    loadAccounts().then(() => { renderAccounts(); updateAccountSelects(); showNotification("Accounts refreshed", "success"); });
}

async function addAccountFromLogin(data) {
    try {
        const authCookies = extractRobloxAuthCookies(typeof data?.cookie === "string" ? data.cookie : "", typeof data?.rbxIdCheck === "string" ? data.rbxIdCheck : "");
        if (!authCookies.cookie) throw new Error("Missing captured .ROBLOSECURITY cookie");
        const resolvedUsername = String(data?.username || "").trim() || String(data?.displayName || "").trim() || (data?.userId != null ? `User ${data.userId}` : "");
        if (!resolvedUsername) throw new Error("Missing captured account identity");
        const resolvedAlias = String(data?.displayName || "").trim() || resolvedUsername;
        const resolvedUserId = Number.isFinite(Number(data?.userId)) ? Number(data.userId) : null;
        const existing = accounts.find((a) => (resolvedUserId != null && Number(a.userId) === resolvedUserId) || String(a.username || "").trim().toLowerCase() === resolvedUsername.toLowerCase());
        if (existing) {
            existing.username = existing.username || resolvedUsername; existing.alias = resolvedAlias || existing.alias || resolvedUsername;
            existing.cookie = authCookies.cookie || existing.cookie || ""; existing.rbxIdCheck = authCookies.rbxIdCheck || existing.rbxIdCheck || "";
            existing.userId = resolvedUserId ?? existing.userId ?? null; existing.lastUsed = Date.now();
            showNotification(`Updated cookie for ${resolvedUsername}`, "success");
        } else {
            const maxId = accounts.length > 0 ? Math.max(...accounts.map((a) => a.id)) : 0;
            const defaultType = accounts.some((a) => isMainAccountRecord(a)) ? ALT_ACCOUNT_TYPE : MAIN_ACCOUNT_TYPE;
            accounts.push({ id: maxId + 1, username: resolvedUsername, alias: resolvedAlias, type: defaultType, description: `Captured from login on ${new Date().toLocaleString()}`, cookie: authCookies.cookie, rbxIdCheck: authCookies.rbxIdCheck || "", userId: resolvedUserId, lastUsed: Date.now() });
            showNotification(`Added account: ${resolvedUsername}`, "success");
        }
        const saveResult = await saveAccounts();
        if (saveResult?.requiresMainSelection) {
            openMainAccountSelectionModal({ title: "Select Main Account", description: "At least one saved account must stay marked as Main. Choose which account should keep that role.", note: "Only one Main account is allowed at a time.", draftAccounts: saveResult.resolution.accounts, candidateIds: saveResult.resolution.candidateIds, confirmLabel: "Set Main", allowCancel: false, successMessage: "Main account updated" });
        } else if (!saveResult?.success) { showNotification("Failed to save account list", "error"); return; }
        else { refreshAccountViews(); }
        await ipcRenderer.invoke("close-login-window");
    } catch (error) { showNotification(`Error adding account: ${error.message}`, "error"); }
}

// ─── Main Account Selection ──────────────────────────────────────────────────
function openMainAccountSelectionModal(options = {}) {
    const modal = document.getElementById("mainAccountSelectionModal");
    const select = document.getElementById("mainAccountSelectionInput");
    if (!modal || !select) return false;
    const draftAccounts = (Array.isArray(options.draftAccounts) ? options.draftAccounts : accounts).map((a) => normalizeAccountRecord({ ...a }));
    const candidateIds = Array.isArray(options.candidateIds) && options.candidateIds.length ? new Set(options.candidateIds.map((id) => Number(id))) : new Set(draftAccounts.map((a) => Number(a.id)));
    const candidateAccounts = draftAccounts.filter((a) => candidateIds.has(Number(a.id)));
    if (!candidateAccounts.length) { showNotification("No account available to set as Main", "error"); return false; }
    pendingMainAccountSelection = { ...options, draftAccounts, candidateIds: candidateAccounts.map((a) => Number(a.id)) };
    document.getElementById("mainAccountSelectionTitle").textContent = options.title || "Select Main Account";
    document.getElementById("mainAccountSelectionDescription").textContent = options.description || "Choose which account should keep the Main role.";
    document.getElementById("mainAccountSelectionNote").textContent = options.note || "Exactly one account must be marked as Main.";
    document.getElementById("mainAccountSelectionConfirmBtn").textContent = options.confirmLabel || "Set Main";
    const allowCancel = options.allowCancel !== false;
    const cancelBtn = document.getElementById("mainAccountSelectionCancelBtn");
    const closeBtn = document.getElementById("mainAccountSelectionCloseBtn");
    if (cancelBtn) cancelBtn.style.display = allowCancel ? "inline-flex" : "none";
    if (closeBtn) closeBtn.style.display = allowCancel ? "inline-flex" : "none";
    select.innerHTML = candidateAccounts.map((a) => `<option value="${a.id}">${getAccountDisplayName(a)}</option>`).join("");
    const preferredMainId = Number(options.preferredMainId);
    const selectedCandidate = candidateAccounts.some((a) => Number(a.id) === preferredMainId) ? preferredMainId : Number(candidateAccounts[0].id);
    select.value = String(selectedCandidate);
    if (options.hideAccountModal) document.getElementById("accountModal")?.classList.remove("active");
    modal.classList.add("active");
    return true;
}

function closeMainAccountSelectionModal(options = {}) {
    const pending = pendingMainAccountSelection;
    if (pending && pending.allowCancel === false && !options.force) return;
    const modal = document.getElementById("mainAccountSelectionModal");
    if (modal) modal.classList.remove("active");
    const shouldRestoreAccountModal = !options.skipRestore && pending?.reopenAccountModalOnCancel;
    pendingMainAccountSelection = null;
    if (shouldRestoreAccountModal) document.getElementById("accountModal")?.classList.add("active");
}

async function confirmMainAccountSelection() {
    if (!pendingMainAccountSelection) return;
    const pendingState = pendingMainAccountSelection;
    const select = document.getElementById("mainAccountSelectionInput");
    const selectedMainId = Number(select?.value);
    if (!Number.isFinite(selectedMainId)) { showNotification("Choose one account to keep as Main", "error"); return; }
    const nextAccounts = setSingleMainAccount(pendingMainAccountSelection.draftAccounts, selectedMainId);
    const saveResult = await persistAccountsToDisk(nextAccounts);
    if (!saveResult.success) { showNotification("Failed to save Main account selection", "error"); return; }
    if (pendingState?.clearSelectedAccountId) selectedAccountId = null;
    if (pendingState?.clearEditingAccountId) editingAccountId = null;
    if (pendingState?.selectedAccountIdOnSuccess !== null && pendingState?.selectedAccountIdOnSuccess !== undefined && Number.isFinite(Number(pendingState.selectedAccountIdOnSuccess))) selectedAccountId = Number(pendingState.selectedAccountIdOnSuccess);
    if (pendingState?.editingAccountIdOnSuccess !== null && pendingState?.editingAccountIdOnSuccess !== undefined && Number.isFinite(Number(pendingState.editingAccountIdOnSuccess))) editingAccountId = Number(pendingState.editingAccountIdOnSuccess);
    closeMainAccountSelectionModal({ force: true, skipRestore: true });
    if (pendingState?.closeAccountModalOnSuccess) closeAccountModal();
    refreshAccountViews();
    if (pendingState?.successMessage) showNotification(pendingState.successMessage, "success");
    else { const selectedAccount = accounts.find((a) => Number(a.id) === selectedMainId); showNotification(`Main account set to ${getAccountDisplayName(selectedAccount)}`, "success"); }
}

function queueRequiredMainAccountSelection(options = {}) {
    const modal = document.getElementById("mainAccountSelectionModal");
    if (pendingMainAccountSelection || modal?.classList.contains("active")) return;
    setTimeout(() => {
        const activeModal = document.getElementById("mainAccountSelectionModal");
        if (pendingMainAccountSelection || activeModal?.classList.contains("active")) return;
        openMainAccountSelectionModal({ allowCancel: false, confirmLabel: "Set Main", ...options });
    }, 0);
}
