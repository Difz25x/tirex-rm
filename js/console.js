// TiRex RM — Console Tab
// Log viewer with filtering, search, pause, auto-scroll

let consoleEntries = [];
let consoleCategoryFilter = CONSOLE_CATEGORY_ALL;
let consoleSearchKeyword = "";
let consolePaused = false;
let consoleAutoScroll = true;
let pendingPausedConsoleCount = 0;
let consoleMainListenerBound = false;
let rendererConsoleCaptureInstalled = false;
let rendererConsoleCaptureGuard = false;
let latestMainConsoleId = 0;

function truncateConsoleMessage(message) {
    const normalized = String(message || "");
    if (normalized.length <= CONSOLE_MESSAGE_LIMIT) return normalized;
    return `${normalized.slice(0, CONSOLE_MESSAGE_LIMIT)}... [truncated]`;
}

function normalizeConsoleEntry(rawEntry) {
    const message = truncateConsoleMessage(normalizeRuntimeTextToEnglish(String(rawEntry?.message || "(empty log message)")));
    const level = String(rawEntry?.level || "info").toLowerCase();
    const timestamp = Number(rawEntry?.timestamp) || Date.now();
    const category = typeof rawEntry?.category === "string" && rawEntry.category.trim() ? rawEntry.category.trim() : classifyConsoleCategory(level, message);
    const idCandidate = Number(rawEntry?.id);
    return {
        id: Number.isFinite(idCandidate) ? idCandidate : timestamp + Math.floor(Math.random() * 1000),
        timestamp, level, category,
        scope: String(rawEntry?.scope || "").trim() || (rawEntry?.origin === "main" ? "Main" : "Renderer"),
        origin: rawEntry?.origin === "main" ? "main" : "renderer",
        message,
    };
}

function formatConsoleTime(timestamp) {
    try { return new Date(timestamp).toLocaleTimeString("en-GB", { hour12: false }); } catch { return "--:--:--"; }
}

function getFilteredConsoleEntries() {
    return consoleEntries.filter((entry) => {
        if (consoleCategoryFilter !== CONSOLE_CATEGORY_ALL && entry.category !== consoleCategoryFilter) return false;
        if (!consoleSearchKeyword) return true;
        const haystack = `${entry.scope} ${entry.message} ${entry.category}`.toLowerCase();
        return haystack.includes(consoleSearchKeyword);
    });
}

function renderConsoleLogs() {
    const view = document.getElementById("consoleLogView");
    const stats = document.getElementById("consoleStats");
    if (!view || !stats) return;
    const filtered = getFilteredConsoleEntries();
    stats.textContent = `${filtered.length} / ${consoleEntries.length}${consolePaused ? ` (paused +${pendingPausedConsoleCount})` : ""}`;
    if (!filtered.length) { view.innerHTML = `<div class="console-empty">No logs match current filter.</div>`; return; }
    const rows = filtered.slice(-CONSOLE_RENDER_LIMIT).map((entry) => {
        const categoryKey = String(entry.category || "Info").toLowerCase();
        return `<div class="console-row"><div class="console-time">${escapeHtml(formatConsoleTime(entry.timestamp))}</div><div><span class="console-pill ${escapeHtml(categoryKey)}">[${escapeHtml(entry.category)}]</span></div><div class="console-source">${escapeHtml(entry.scope)}</div><div class="console-message">${escapeHtml(entry.message)}</div></div>`;
    }).join("");
    view.innerHTML = rows;
    if (consoleAutoScroll) view.scrollTop = view.scrollHeight;
}

function appendConsoleEntry(rawEntry) {
    if (!rawEntry) return;
    if (rawEntry.type === "cleared") { consoleEntries = []; pendingPausedConsoleCount = 0; renderConsoleLogs(); updateConsoleControlLabels(); return; }
    const entry = normalizeConsoleEntry(rawEntry);
    if (entry.origin === "main" && entry.id <= latestMainConsoleId) return;
    if (entry.origin === "main" && entry.id > latestMainConsoleId) latestMainConsoleId = entry.id;
    consoleEntries.push(entry);
    if (consoleEntries.length > CONSOLE_LOG_LIMIT) consoleEntries = consoleEntries.slice(-CONSOLE_LOG_LIMIT);
    if (consolePaused) { pendingPausedConsoleCount++; updateConsoleControlLabels(); return; }
    if (!isTabActive("console")) { updateConsoleControlLabels(); return; }
    renderConsoleLogs();
}

async function initializeConsoleLogs() {
    try {
        const response = await ipcRenderer.invoke("get-app-console-logs");
        if (response?.success && Array.isArray(response.logs)) {
            response.logs.forEach((entry) => appendConsoleEntry({ ...entry, origin: "main" }));
        }
    } catch (error) {
        appendConsoleEntry({ origin: "renderer", scope: "Console", level: "error", category: "Failed", message: `Failed to load console logs: ${error.message}` });
    }
    renderConsoleLogs();
}

function bindMainConsoleStream() {
    if (consoleMainListenerBound) return;
    consoleMainListenerBound = true;
    ipcRenderer.on("app-console-log", (event, entry) => appendConsoleEntry({ ...entry, origin: "main" }));
}

function installRendererConsoleCapture() {
    if (rendererConsoleCaptureInstalled) return;
    rendererConsoleCaptureInstalled = true;
    const original = { log: console.log.bind(console), info: console.info.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
    ["log", "info", "warn", "error"].forEach((level) => {
        console[level] = (...args) => {
            original[level](...args);
            if (rendererConsoleCaptureGuard) return;
            rendererConsoleCaptureGuard = true;
            try {
                const message = args.map((arg) => toConsoleText(arg)).join(" ");
                appendConsoleEntry({ origin: "renderer", timestamp: Date.now(), level, category: classifyConsoleCategory(level, message), scope: "Renderer", message });
            } finally { rendererConsoleCaptureGuard = false; }
        };
    });
}

function updateConsoleControlLabels() {
    const pauseBtn = document.getElementById("consolePauseBtn");
    const autoScrollBtn = document.getElementById("consoleAutoScrollBtn");
    if (pauseBtn) pauseBtn.textContent = consolePaused ? `Resume${pendingPausedConsoleCount ? ` (+${pendingPausedConsoleCount})` : ""}` : "Pause";
    if (autoScrollBtn) autoScrollBtn.textContent = `Auto Scroll: ${consoleAutoScroll ? "ON" : "OFF"}`;
}

function clearConsoleLogs() {
    consoleEntries = []; latestMainConsoleId = 0; pendingPausedConsoleCount = 0;
    renderConsoleLogs(); updateConsoleControlLabels();
    ipcRenderer.invoke("clear-app-console-logs").catch(() => {});
}

function toggleConsolePause() {
    consolePaused = !consolePaused;
    if (!consolePaused) { pendingPausedConsoleCount = 0; renderConsoleLogs(); }
    updateConsoleControlLabels();
}

function toggleConsoleAutoScroll() {
    consoleAutoScroll = !consoleAutoScroll;
    updateConsoleControlLabels();
    if (consoleAutoScroll) renderConsoleLogs();
}

function changeConsoleCategoryFilter(value) {
    consoleCategoryFilter = value || CONSOLE_CATEGORY_ALL;
    renderConsoleLogs();
}

function updateConsoleSearch(value) {
    consoleSearchKeyword = String(value || "").trim().toLowerCase();
    renderConsoleLogs();
}
