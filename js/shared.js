// TiRex RM — Shared Utilities
// Core helpers used across all modules

const { ipcRenderer, clipboard } = require("electron");

// ─── Constants ───────────────────────────────────────────────────────────────
const MAIN_ACCOUNT_TYPE = "Main Account";
const ALT_ACCOUNT_TYPE = "Alt Account";
const DEFAULT_SHARED_RBXIDCHECK = "89a52e66-1c42-4d40-9a4c-5f2a2a45d922";
const LAST_ACTIVE_TAB_STORAGE_KEY = "tirex:last-tab";
const QUICK_SIGNIN_CODE_TTL_MS = 5 * 60 * 1000;
const ACCOUNT_SEARCH_DEBOUNCE_MS = 120;
const INSTANCE_REFRESH_INTERVAL_MS = 3000;
const INSTANCE_UPTIME_BUCKET_MS = 15000;
const CONSOLE_LOG_LIMIT = 500;
const CONSOLE_RENDER_LIMIT = 160;
const CONSOLE_MESSAGE_LIMIT = 700;
const CONSOLE_CATEGORY_ALL = "all";

// ─── Indonesian → English Translation ───────────────────────────────────────
const RUNTIME_TEXT_PHRASE_MAP = [
    [/Process ini terdeteksi via PID\. Launch dari TiRex dulu untuk setting instance penuh\./gi, "This process was detected by PID. Launch it from TiRex first to access full instance settings."],
    [/Akun\s+(.+?)\s+masih\s+berjalan\s+\(PID\s+(\d+)\)\.\s*Tunggu\s+sebelum\s+launching\s+lagi\s+agar\s+tidak\s+force\s+logout\./gi, "Account $1 is still running (PID $2). Wait before launching again to avoid forced logout."],
];
const RUNTIME_TEXT_WORD_MAP = [
    [/\b(silakan|mohon|harap)\b/gi, "please"], [/\bgagal\b/gi, "failed"],
    [/\bberhasil\b/gi, "successful"], [/\btidak\b/gi, "not"],
    [/\bbelum\b/gi, "not yet"], [/\bsudah\b/gi, "already"],
    [/\bakun\b/gi, "account"], [/\bproses\b/gi, "process"],
    [/\bpengaturan\b/gi, "settings"], [/\bversi\b/gi, "version"],
    [/\bunduh\b/gi, "download"], [/\binstal\b/gi, "install"],
    [/\bhapus\b/gi, "remove"], [/\bsimpan\b/gi, "save"],
    [/\bmemuat\b/gi, "loading"], [/\bmuat\b/gi, "load"],
    [/\bselesai\b/gi, "complete"], [/\bkesalahan\b/gi, "error"],
    [/\bperingatan\b/gi, "warning"], [/\bmasuk\b/gi, "sign in"],
    [/\bkeluar\b/gi, "sign out"], [/\bterdeteksi\b/gi, "detected"],
    [/\bgunakan\b/gi, "use"], [/\blanjut\b/gi, "continue"],
    [/\bbatal\b/gi, "cancel"], [/\bcoba\b/gi, "try"], [/\bulang\b/gi, "retry"],
];
const INDONESIAN_RUNTIME_HINT_REGEX = /\b(silakan|mohon|harap|gagal|berhasil|tidak|belum|sudah|akun|proses|pengaturan|versi|unduh|instal|hapus|simpan|memuat|muat|selesai|kesalahan|peringatan|masuk|keluar|terdeteksi|gunakan|lanjut|batal|coba|ulang)\b/i;

function normalizeRuntimeTextToEnglish(input) {
    if (input == null) return "";
    let text = String(input);
    for (const [pattern, replacement] of RUNTIME_TEXT_PHRASE_MAP) {
        text = text.replace(pattern, replacement);
    }
    if (!INDONESIAN_RUNTIME_HINT_REGEX.test(text)) return text;
    for (const [pattern, replacement] of RUNTIME_TEXT_WORD_MAP) {
        text = text.replace(pattern, replacement);
    }
    return text.replace(/\s{2,}/g, " ").trim();
}

function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function toConsoleText(value) {
    if (value instanceof Error) return value.stack || value.message || String(value);
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    if (value == null) return String(value);
    try { return JSON.stringify(value); } catch { return Object.prototype.toString.call(value); }
}

function classifyConsoleCategory(level, message) {
    const text = String(message || "").toLowerCase();
    const lvl = String(level || "info").toLowerCase();
    if (lvl === "error" || /fail|failed|error|crash|fatal|terminated|exception|unable|missing/.test(text)) return "Failed";
    if (/retry|retrying|attempt|backoff|timeout/.test(text)) return "Retrying";
    if (/success|completed|done|ready|applied|enabled/.test(text)) return "Success";
    if (/starting|launch|loading|downloading|extract|scanning|waiting|processing|monitor|checking|resolving|opening|joining|refresh|updating|reopening|stabilizing/.test(text)) return "Processing";
    if (lvl === "warn" || /warn|warning|caution/.test(text)) return "Warning";
    return "Info";
}

function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

function isTabActive(tabId) {
    return document.body?.dataset?.activeTab === tabId;
}

// ─── Cookie Helpers ──────────────────────────────────────────────────────────
function normalizeNamedCookieValue(rawValue, cookieName, options = {}) {
    if (typeof rawValue !== "string" || !cookieName) return "";
    const acceptBareValue = options.acceptBareValue !== false;
    let normalized = rawValue.trim();
    if (!normalized) return "";
    normalized = normalized.replace(/^cookie:\s*/i, "");
    const escapedName = String(cookieName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const keyRegex = new RegExp(`(?:^|;\\s*)${escapedName}\\s*=\\s*`, "i");
    const keyMatch = normalized.match(keyRegex);
    const keyIndex = keyMatch ? keyMatch.index : -1;
    if (keyIndex >= 0) {
        const prefixLength = keyMatch ? keyMatch[0].length : `${cookieName}=`.length;
        normalized = normalized.slice(keyIndex + prefixLength);
    } else if (!acceptBareValue) { return ""; } else if (/^[^=;]+\s*=/.test(normalized)) { return ""; }
    const semicolonIndex = normalized.indexOf(";");
    if (semicolonIndex >= 0) normalized = normalized.slice(0, semicolonIndex);
    if (normalized.length >= 2 && ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'")))) {
        normalized = normalized.slice(1, -1);
    }
    if (normalized.includes("%")) {
        try { const decoded = decodeURIComponent(normalized); if (decoded) normalized = decoded; } catch {}
    }
    return normalized.replace(/\s+/g, "").trim();
}

function extractRobloxAuthCookies(primaryInput = "", secondaryInput = "", legacyBundleInput = "") {
    const p = typeof primaryInput === "string" ? primaryInput : "";
    const s = typeof secondaryInput === "string" ? secondaryInput : "";
    const l = typeof legacyBundleInput === "string" ? legacyBundleInput : "";
    return {
        cookie: normalizeNamedCookieValue(p || l, ".ROBLOSECURITY"),
        rbxIdCheck: normalizeNamedCookieValue(s || p || l, ".RBXIDCHECK", { acceptBareValue: !!s }),
    };
}

function formatAuthCookieBundle(account) {
    const parts = [];
    if (account?.cookie) parts.push(`.ROBLOSECURITY=${account.cookie}`);
    const rbx = getEffectiveAccountRbxIdCheck(account);
    if (rbx) parts.push(`.RBXIDCHECK=${rbx}`);
    return parts.join("; ");
}

function getSharedRbxIdCheckSettingValue() {
    const configuredValue = normalizeNamedCookieValue(
        typeof settings?.globalRbxIdCheck === "string" ? settings.globalRbxIdCheck : "", ".RBXIDCHECK"
    );
    return configuredValue || DEFAULT_SHARED_RBXIDCHECK;
}

function getEffectiveAccountRbxIdCheck(account = {}) {
    const val = normalizeNamedCookieValue(
        typeof account?.rbxIdCheck === "string" ? account.rbxIdCheck
        : typeof account?.rbxidcheck === "string" ? account.rbxidcheck
        : typeof account?.rbxId === "string" ? account.rbxId : "", ".RBXIDCHECK"
    );
    return val || getSharedRbxIdCheckSettingValue();
}

function normalizeAccountType(value) {
    const n = String(value || "").trim().toLowerCase();
    if (n === "main" || n === "main account") return MAIN_ACCOUNT_TYPE;
    return ALT_ACCOUNT_TYPE;
}

function normalizeAccountRecord(account = {}) {
    const authCookies = extractRobloxAuthCookies(
        typeof account.cookie === "string" ? account.cookie : typeof account.roblosecurity === "string" ? account.roblosecurity : "",
        typeof account.rbxIdCheck === "string" ? account.rbxIdCheck : typeof account.rbxidcheck === "string" ? account.rbxidcheck : typeof account.rbxId === "string" ? account.rbxId : typeof account[".RBXIDCHECK"] === "string" ? account[".RBXIDCHECK"] : "",
        typeof account.authCookieBundle === "string" ? account.authCookieBundle : ""
    );
    const r = { ...account, cookie: authCookies.cookie, rbxIdCheck: authCookies.rbxIdCheck };
    delete r.rbxidcheck; delete r.roblosecurity; delete r.rbxId; delete r[".RBXIDCHECK"]; delete r.authCookieBundle;
    r.type = normalizeAccountType(r.type);
    return r;
}

function isMainAccountRecord(account) {
    return normalizeAccountType(account?.type) === MAIN_ACCOUNT_TYPE;
}

function getAccountDisplayName(account) {
    const alias = String(account?.alias || "").trim();
    const username = String(account?.username || "").trim();
    if (alias && username && alias.toLowerCase() !== username.toLowerCase()) return `${alias} (${username})`;
    return alias || username || `Account ${account?.id ?? ""}`.trim();
}

function setSingleMainAccount(accountList, mainAccountId) {
    const targetId = Number(mainAccountId);
    return (Array.isArray(accountList) ? accountList : []).map((a) => ({ ...a, type: Number(a.id) === targetId ? MAIN_ACCOUNT_TYPE : ALT_ACCOUNT_TYPE }));
}

function resolveMainAccountState(accountList, options = {}) {
    let changed = false;
    let nextAccounts = (Array.isArray(accountList) ? accountList : []).map((a) => {
        const nt = normalizeAccountType(a?.type);
        if (nt !== a?.type) changed = true;
        return { ...a, type: nt };
    });
    if (!nextAccounts.length) return { accounts: nextAccounts, changed, needsSelection: false, selectedMainId: null, candidateIds: [] };
    const mainAccounts = nextAccounts.filter((a) => isMainAccountRecord(a));
    if (mainAccounts.length > 1) {
        const preferredMainId = Number(options.preferredMainId);
        const chosenMainId = mainAccounts.some((a) => Number(a.id) === preferredMainId) ? preferredMainId : Number(mainAccounts[0].id);
        nextAccounts = setSingleMainAccount(nextAccounts, chosenMainId);
        changed = true;
        return { accounts: nextAccounts, changed, needsSelection: false, selectedMainId: chosenMainId, candidateIds: nextAccounts.map((a) => a.id) };
    }
    if (mainAccounts.length === 1) return { accounts: nextAccounts, changed, needsSelection: false, selectedMainId: Number(mainAccounts[0].id), candidateIds: nextAccounts.map((a) => a.id) };
    if (nextAccounts.length === 1) {
        nextAccounts = setSingleMainAccount(nextAccounts, nextAccounts[0].id);
        changed = true;
        return { accounts: nextAccounts, changed, needsSelection: false, selectedMainId: Number(nextAccounts[0].id), candidateIds: nextAccounts.map((a) => a.id), autoAssigned: true };
    }
    return { accounts: nextAccounts, changed, needsSelection: true, selectedMainId: null, candidateIds: nextAccounts.map((a) => a.id) };
}

function accountHasCookie(account) {
    return !!(account && typeof account.cookie === "string" && account.cookie.trim());
}

function accountHasSessionBundle(account) {
    return !!(accountHasCookie(account) && getEffectiveAccountRbxIdCheck(account));
}

// ─── Date Formatters ────────────────────────────────────────────────────────
const compactDateTimeFormatter = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const compactCardDateTimeFormatter = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });

function formatCompactDateTime(value) {
    const ts = Number(value || 0);
    if (!Number.isFinite(ts) || ts <= 0) return "Never";
    return compactDateTimeFormatter.format(new Date(ts));
}

function formatCompactCardDateTime(value) {
    const ts = Number(value || 0);
    if (!Number.isFinite(ts) || ts <= 0) return "Never";
    return compactCardDateTimeFormatter.format(new Date(ts));
}

function getAccountStateConfig(hasBundle, hasCookie) {
    if (hasBundle) return { tone: "ready", shortLabel: "Ready", detailLabel: "Session Ready", title: "Full session bundle detected" };
    if (hasCookie) return { tone: "partial", shortLabel: "Partial", detailLabel: "Primary Only", title: ".RBXIDCHECK is missing for this account" };
    return { tone: "offline", shortLabel: "Login", detailLabel: "Needs Login", title: "Account needs sign-in" };
}

function renderAccountStateIcon(tone) {
    if (tone === "ready") return `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="8" fill="currentColor" opacity="0.18"></circle><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"></circle><path d="M6.2 10.2 8.7 12.7 13.8 7.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
    if (tone === "partial") return `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 2.4 18 16.4a1.1 1.1 0 0 1-.95 1.65H2.95A1.1 1.1 0 0 1 2 16.4l8-14Z" fill="currentColor" opacity="0.18"></path><path d="M10 2.4 18 16.4a1.1 1.1 0 0 1-.95 1.65H2.95A1.1 1.1 0 0 1 2 16.4l8-14Z" fill="none" stroke="currentColor" stroke-width="1.5"></path><path d="M10 7v4.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path><circle cx="10" cy="14.4" r="1" fill="currentColor"></circle></svg>`;
    return `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="8" fill="currentColor" opacity="0.16"></circle><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"></circle><path d="M7.2 7.2 12.8 12.8M12.8 7.2 7.2 12.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>`;
}

function isGuardLaunchError(errorMessage) {
    const m = String(errorMessage || "").toLowerCase();
    return m.includes("multi-instance guard") || m.includes("guard is not ready") || m.includes("guard failed");
}

function extractUserIdFromInput(value) {
    const input = (value || '').trim();
    if (!input) return null;
    const userMatch = input.match(/roblox\.com\/users\/(\d+)/i);
    if (userMatch) return userMatch[1];
    if (/^\d+$/.test(input)) return input;
    return null;
}
