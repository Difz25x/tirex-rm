// TiRex RM — Notification System
// Toast notifications and update progress overlay

function showNotification(message, type = "info") {
    const normalizedMessage = normalizeRuntimeTextToEnglish(message);
    const notificationCategoryMap = { success: "Success", error: "Failed", warning: "Warning", info: "Info" };

    if (type === "error" || type === "warning" || isTabActive("console")) {
        appendConsoleEntry({
            origin: "renderer", timestamp: Date.now(),
            level: type === "error" ? "error" : type === "warning" ? "warn" : "info",
            category: notificationCategoryMap[type] || "Info", scope: "Notification", message: normalizedMessage,
        });
    }

    if (!settings.notifications && type !== "error") return;

    const container = document.getElementById("notificationContainer");
    const notif = document.createElement("div");
    notif.className = `notification ${type}`;
    const titles = { success: "Success", error: "Error", warning: "Warning", info: "Info" };
    notif.innerHTML = `
        <div class="notification-header">
            <div class="notification-title">${titles[type]}</div>
            <button onclick="this.parentElement.parentElement.remove()" style="background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 18px;">X</button>
        </div>
        <div class="notification-message">${normalizedMessage}</div>
    `;
    container.appendChild(notif);
    setTimeout(() => {
        if (notif.parentElement) {
            notif.style.opacity = "0";
            setTimeout(() => notif.remove(), 300);
        }
    }, 5000);
}

// ─── Hot Update IPC Listeners ────────────────────────────────────────────────
function initUpdateListeners() {
    ipcRenderer.on("hot-update-available", (event, info) => {
        showNotification(`Update available: v${info.version}`, "info");
    });

    ipcRenderer.on("hot-update-not-available", () => {});

    ipcRenderer.on("hot-update-progress", (event, data) => {
        document.getElementById("updateProgressBar").style.width = data.percent + "%";
        document.getElementById("updateProgressPercent").textContent = data.percent + "%";
    });

    ipcRenderer.on("hot-update-status", (event, data) => {
        const statusMap = { downloading: "Downloading update...", extracting: "Extracting files..." };
        document.getElementById("updateStatusText").textContent = normalizeRuntimeTextToEnglish(statusMap[data.status] || data.status);
    });

    ipcRenderer.on("hot-update-applied", (event, data) => {
        document.getElementById("updateStatusText").textContent = normalizeRuntimeTextToEnglish(data.message || "Update applied!");
        document.getElementById("updateProgressBar").style.width = "100%";
        document.getElementById("updateProgressPercent").textContent = "100%";
        if (!data.needsRelaunch && data.filesUpdated && data.filesUpdated.length > 0) {
            showNotification(`Updated ${data.filesUpdated.length} file(s). Reloading...`, "success");
        }
    });

    ipcRenderer.on("hot-update-error", (event, data) => {
        document.getElementById("updateModal").classList.remove("active");
        showNotification("Update failed: " + (data.message || "Unknown error"), "error");
    });
}

async function checkForUpdates() {
    showNotification("Checking for updates...", "info");
    try {
        const result = await ipcRenderer.invoke("check-hot-update");
        if (result.updateAvailable) {
            if (result.error) {
                showNotification("Update available but can't auto-apply: " + result.error, "warning");
                return;
            }
            document.getElementById("updateModal").classList.add("active");
            document.getElementById("updateStatusText").textContent = normalizeRuntimeTextToEnglish(`Version ${result.version} found. Downloading...`);
            document.getElementById("updateProgressBar").style.width = "0%";
            document.getElementById("updateProgressPercent").textContent = "0%";
            const applyResult = await ipcRenderer.invoke("apply-hot-update", { downloadUrl: result.downloadUrl, version: result.version });
            if (!applyResult.success) {
                document.getElementById("updateModal").classList.remove("active");
                showNotification("Update failed: " + (applyResult.error || "Unknown error"), "error");
            }
        } else if (result.error) {
            showNotification("Update check failed: " + result.error, "error");
        } else {
            showNotification("You are already using the latest version.", "success");
        }
    } catch (error) {
        showNotification("Update check failed: " + error.message, "error");
    }
}
