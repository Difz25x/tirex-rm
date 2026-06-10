// TiRex RM — Instances Tab
// Runtime monitor: instance list, guard status, refresh

let robloxInstances = new Map();
let guardStatusState = { state: "unknown", detail: "Unknown" };
let instancesRefreshPromise = null;
let instancesRefreshNeedsForce = false;
let lastRenderedInstancesSignature = "";

function getInstancesRenderSignature(instances) {
    return (instances || []).map((i) => [i.pid, i.accountUsername || "", i.status || "", i.detected ? "1" : "0", i.placeId || "", Math.floor(Number(i.uptime || 0) / INSTANCE_UPTIME_BUCKET_MS)].join(":")).join("|");
}

function updateGuardStatusUI(status) {
    const container = document.getElementById("guardStatus");
    const textEl = document.getElementById("guardStatusText");
    if (!container || !textEl) return;
    const state = status?.state || "unknown";
    const detail = status?.detail || "Unknown";
    const stateLabelMap = { ready: "Ready", starting: "Starting", retrying: "Retrying", failed: "Failed", stopped: "Standby", unknown: "Unknown" };
    const label = stateLabelMap[state] || (state.charAt(0).toUpperCase() + state.slice(1));
    container.classList.remove("ready", "starting", "retrying", "failed", "stopped", "unknown");
    container.classList.add(state);
    textEl.textContent = `Guard: ${label}`;
    container.title = detail;
    guardStatusState = { state, detail };
}

async function refreshGuardStatus() {
    try { const status = await ipcRenderer.invoke("get-guard-status"); updateGuardStatusUI(status); }
    catch (error) { updateGuardStatusUI({ state: "unknown", detail: "Failed to load guard status" }); }
}

async function refreshInstances(options = {}) {
    if (instancesRefreshPromise) { if (options.force === true) instancesRefreshNeedsForce = true; return instancesRefreshPromise; }
    instancesRefreshPromise = (async () => {
        try {
            const instances = await ipcRenderer.invoke("get-running-instances");
            robloxInstances = new Map((instances || []).map((i) => [i.pid, i]));
            updateStats();
            const shouldRender = options.force === true || isTabActive("instances");
            if (!shouldRender) return;
            const container = document.getElementById("instancesContainer");
            if (!container) return;
            const nextSignature = getInstancesRenderSignature(instances);
            if (options.force !== true && nextSignature === lastRenderedInstancesSignature) return;
            lastRenderedInstancesSignature = nextSignature;
            if (!instances || instances.length === 0) {
                container.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.3;"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg></div><div class="empty-text">No Roblox instances running</div></div>`;
                return;
            }
            container.innerHTML = "";
            const fragment = document.createDocumentFragment();
            instances.forEach((instance) => {
                const uptime = formatUptime(instance.uptime);
                const statusText = String(instance.status || "Running");
                const statusLower = statusText.toLowerCase();
                const statusColor = statusLower.includes("detected") ? "var(--warning)" : "var(--success)";
                const statusBackground = statusLower.includes("detected") ? "rgba(243, 156, 18, 0.15)" : "rgba(50, 205, 47, 0.15)";
                const card = document.createElement("div");
                card.className = "instance-card";
                card.style.marginBottom = "16px";
                card.style.cursor = "pointer";
                card.onclick = (e) => {
                    if (e.target.closest('button')) return;
                    if (instance.detected) { showNotification("This process was detected by PID. Launch it from TiRex first to access full instance settings.", "info"); return; }
                    openInstanceSettings(instance.pid);
                };
                card.innerHTML = `<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; align-items: center;">
                    <div><div style="font-size: 12px; color: var(--text-dim); margin-bottom: 4px;">PID</div><div style="font-size: 18px; font-weight: 700; color: var(--primary);">${escapeHtml(instance.pid)}</div></div>
                    <div><div style="font-size: 12px; color: var(--text-dim); margin-bottom: 4px;">Account</div><div style="font-size: 14px; font-weight: 600;">${escapeHtml(instance.accountUsername)}</div></div>
                    <div><div style="font-size: 12px; color: var(--text-dim); margin-bottom: 4px;">Uptime</div><div style="font-size: 14px; font-weight: 600; color: var(--success);">${escapeHtml(uptime)}</div></div>
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div><div style="font-size: 12px; color: var(--text-dim); margin-bottom: 4px;">Status</div><div style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: ${statusBackground}; color: ${statusColor}; border-radius: 20px; font-size: 12px; font-weight: 600;"><div style="width: 6px; height: 6px; border-radius: 50%; background: ${statusColor};"></div>${escapeHtml(statusText)}</div></div>
                        <button class="btn btn-danger btn-icon" style="padding: 6px; border-radius: 6px; margin-left: 10px;" onclick="killInstance(${instance.pid}, event)" title="Kill Instance"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                    </div></div>${instance.placeId ? `<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);"><div style="font-size: 12px; color: var(--text-dim);">Place ID: <span style="color: var(--text); font-weight: 600;">${escapeHtml(instance.placeId)}</span></div></div>` : ""}`;
                fragment.appendChild(card);
            });
            container.replaceChildren(fragment);
        } catch (error) { console.error("Error refreshing instances:", error); }
        finally {
            instancesRefreshPromise = null;
            if (instancesRefreshNeedsForce) { instancesRefreshNeedsForce = false; if (isTabActive("instances")) refreshInstances({ force: true }); }
        }
    })();
    return instancesRefreshPromise;
}

async function killInstance(pid, event) {
    if (event) event.stopPropagation();
    try {
        const result = await ipcRenderer.invoke("kill-instance", pid);
        if (result && result.success) { showNotification(`Instance ${pid} terminated successfully.`, "success"); await refreshInstances(); }
        else showNotification(result?.error || `Failed to kill instance ${pid}`, "error");
    } catch (error) { showNotification(`Error killing instance: ${error.message}`, "error"); }
}

async function openInstanceSettings(pid) {
    const modal = document.getElementById('instanceSettingsModal');
    const content = document.getElementById('instanceSettingsContent');
    modal.classList.add('active');
    content.innerHTML = '<div style="text-align: center; padding: 20px;"><div class="loading-spinner"></div></div>';
    try {
        const result = await ipcRenderer.invoke('get-instance-settings', { pid });
        if (result.success) {
            const s = result.settings;
            content.innerHTML = `<div style="margin-bottom: 24px;"><div style="display: flex; align-items: center; gap: 16px; margin-bottom: 20px;"><div style="width: 48px; height: 48px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 24px;"><svg width="24" height="24" viewBox="0 0 24 24" fill="var(--primary)"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg></div><div><div style="font-size: 18px; font-weight: 700;">${s.accountUsername}</div><div style="font-size: 13px; color: var(--text-dim); font-family: 'Consolas', monospace;">PID: ${s.pid}</div></div></div>
            <div class="fflag-section"><div class="fflag-header"><h4 style="margin: 0;">Auto-Reopen Settings</h4></div><div style="font-size: 13px; color: var(--text-dim); margin-bottom: 16px; line-height: 1.5;">If this instance crashes or closes unexpectedly, TiRex will automatically relaunch it with the same account and game.</div>
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 16px; background: rgba(50, 205, 47, 0.05); border: 1px solid rgba(50, 205, 47, 0.2); border-radius: 12px;"><div style="display: flex; align-items: center; gap: 12px;"><div style="width: 32px; height: 32px; border-radius: 8px; background: rgba(50, 205, 47, 0.15); display: flex; align-items: center; justify-content: center; color: var(--success);"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg></div><div><div style="font-weight: 600; font-size: 14px;">Enable Auto-Reopen</div><div style="font-size: 11px; color: var(--text-dim);">Unlimited attempts</div></div></div><label class="switch-toggle"><input type="checkbox" id="reopenToggle-${s.pid}" ${s.autoReopenEnabled ? 'checked' : ''} onchange="toggleInstanceReopen(${s.pid}, this.checked)"><span class="slider-round"></span></label></div></div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;"><div style="background: var(--bg-dark); padding: 12px; border-radius: 8px; border: 1px solid var(--border);"><div style="font-size: 11px; color: var(--text-dim); margin-bottom: 4px;">Uptime</div><div style="font-weight: 600; font-family: 'Consolas', monospace;">${formatUptime(s.uptime)}</div></div><div style="background: var(--bg-dark); padding: 12px; border-radius: 8px; border: 1px solid var(--border);"><div style="font-size: 11px; color: var(--text-dim); margin-bottom: 4px;">Status</div><div style="font-weight: 600; color: var(--success);">${s.status}</div></div></div>
            <div style="margin-top: 24px; display: flex; justify-content: flex-end;"><button class="btn btn-secondary" onclick="closeInstanceSettings()">Close</button></div></div>`;
        } else { content.innerHTML = `<div style="text-align: center; padding: 20px; color: var(--error);">Error: ${result.error}</div>`; }
    } catch (error) { content.innerHTML = `<div style="text-align: center; padding: 20px; color: var(--error);">Error: ${error.message}</div>`; }
}

function closeInstanceSettings() { document.getElementById('instanceSettingsModal').classList.remove('active'); }

async function toggleInstanceReopen(pid, enabled) {
    try {
        const result = await ipcRenderer.invoke('toggle-instance-reopen', { pid, enabled });
        if (result.success) showNotification(enabled ? "Auto-reopen enabled" : "Auto-reopen disabled", "success");
        else { showNotification(result.error || "Failed to update settings", "error"); const toggle = document.getElementById(`reopenToggle-${pid}`); if (toggle) toggle.checked = !enabled; }
    } catch (error) { showNotification("Error updating settings", "error"); const toggle = document.getElementById(`reopenToggle-${pid}`); if (toggle) toggle.checked = !enabled; }
}
