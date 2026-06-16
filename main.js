const electron = require("electron");
const { app, BrowserWindow, ipcMain, shell, session } = electron;
const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");
const https = require("https");
const { exec, execFile, spawn } = require("child_process");
const AdmZip = require("adm-zip");
const { setupHotUpdater } = require("./updater.js");
const { chromium } = require("patchright");

if (!app || typeof app.getPath !== "function") {
    console.error("[Startup] This app must be launched with Electron, not plain Node.js.");
    console.error("[Startup] Use: npx electron .");
    process.exit(1);
}

let mainWindow;
let loginBrowser = null;
let loginPage = null;
let loginCookieChangeListener = null;
let loginCookiePollInterval = null;
let loginQuickCodeWatcher = null;
let loginQuickCodeRefreshTimer = null;
let loginWindowHeadlessMode = false;
let activeLoginCaptureMethod = "browser";
let activeLoginQuickSigninMode = false;
let loginQuickSigninState = {
    active: false,
    code: "",
    expiresAt: 0,
    sessionId: 0,
};
const dataDir = path.join(app.getPath("userData"), "data");
const accountsFile = path.join(dataDir, "accounts.json");
const settingsFile = path.join(dataDir, "settings.json");
const DOWNLOAD_DIR = path.join(app.getPath("userData"), "downloads");
const VERSIONS_DIR = path.join(app.getPath("userData"), "roblox-versions");
const HOT_UPDATE_DIR = path.join(app.getPath("userData"), "hot-update");
const ROBLOX_AUTH_COOKIE_NAMES = Object.freeze({
    auth: ".ROBLOSECURITY",
    checker: ".RBXIDCHECK",
});
const DEFAULT_GLOBAL_RBXIDCHECK = "89a52e66-1c42-4d40-9a4c-5f2a2a45d922";
const RENDERER_HEALTH_MARKERS = Object.freeze([
    'id="accountsGrid"',
    'id="tab-accounts"',
    '<script src="js/shared.js"></script>',
]);
const DEFAULT_ROBLOX_DIR = path.join(
    process.env.LOCALAPPDATA || "",
    "Roblox",
    "Versions",
);
const ROBLOX_CDN = "https://setup-aws.rbxcdn.com";

let multiInstanceProcess = null;
let isMutexHeld = false;
let guardStartPromise = null;
let guardStatus = {
    state: "stopped",
    detail: "Not started",
    lastChange: Date.now(),
};
const runningInstances = new Map();
const installedVersionPaths = new Map();
const reopenMetadata = new Map(); // pid -> { account, placeId, jobId, version, attempts, maxAttempts, enabled }
const LAUNCH_MIN_GAP_MS = 2500;
const PID_SCAN_MAX_ATTEMPTS = 24;
const PID_SCAN_INTERVAL_MS = 900;
const PROCESS_EXIT_CONFIRMATION_CHECKS = 3;
const AUTH_TICKET_MAX_RETRIES = 3;
const AUTH_TICKET_RETRY_BASE_DELAY_MS = 650;
const QUICK_SIGNIN_CODE_TTL_MS = 5 * 60 * 1000;
const QUICK_SIGNIN_CONFIRM_PARTITION = "persist:roblox-quick-signin-confirm";
const QUICK_SIGNIN_CONFIRM_URL = "https://www.roblox.com/crossdevicelogin/ConfirmCode";
const PREVENTIVE_RESTART_BASE_MINUTES = 205; // 3h25m
const PREVENTIVE_RESTART_JITTER_MINUTES = 10; // spread restarts per account
const PREVENTIVE_RESTART_RETRY_COOLDOWN_MS = 30 * 1000;
const APP_CONSOLE_BUFFER_LIMIT = 400;
const APP_CONSOLE_MESSAGE_LIMIT = 700;
const APP_CONSOLE_EVENT = "app-console-log";
const ROBLOX_PROCESS_SNAPSHOT_TTL_MS = 1200;
let launchQueue = Promise.resolve();
let lastLaunchStartedAt = 0;
const csrfTokenFetchLocks = new Map();
const authTicketRequestLocks = new Map();
const appConsoleLogBuffer = [];
let appConsoleSeq = 0;
let consoleCaptureInProgress = false;
let robloxProcessSnapshotCache = { timestamp: 0, processes: [] };
let robloxProcessSnapshotPromise = null;
const nativeConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

function toConsoleText(value) {
    if (value instanceof Error) {
        return value.stack || value.message || String(value);
    }
    if (typeof value === "string") return value;
    if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint"
    ) {
        return String(value);
    }
    if (value == null) return String(value);
    try {
        return JSON.stringify(value);
    } catch (error) {
        return Object.prototype.toString.call(value);
    }
}

function detectConsoleCategory(level, message) {
    const text = String(message || "").toLowerCase();

    if (
        level === "error" ||
        /fail|failed|error|crash|fatal|terminated|exception|unable|missing/.test(
            text,
        )
    ) {
        return "Failed";
    }
    if (/retry|retrying|attempt|backoff|timeout/.test(text)) {
        return "Retrying";
    }
    if (/success|completed|done|ready|applied|enabled/.test(text)) {
        return "Success";
    }
    if (
        /starting|launch|loading|downloading|extract|scanning|waiting|processing|monitor|checking|resolving|opening|joining|refresh|updating|reopening|stabilizing/.test(
            text,
        )
    ) {
        return "Processing";
    }
    if (level === "warn" || /warn|warning|caution/.test(text)) {
        return "Warning";
    }
    return "Info";
}

function detectConsoleScope(message) {
    const match = String(message || "").match(/^\[([^\]]{1,42})\]/);
    if (!match || !match[1]) return "App";
    return match[1];
}

function pushAppConsoleLog(level, args) {
    let message = (args || [])
        .map((arg) => toConsoleText(arg))
        .filter((part) => part && part.trim().length > 0)
        .join(" ");

    if (message.length > APP_CONSOLE_MESSAGE_LIMIT) {
        message = `${message.slice(0, APP_CONSOLE_MESSAGE_LIMIT)}... [truncated]`;
    }

    const entry = {
        id: ++appConsoleSeq,
        timestamp: Date.now(),
        level,
        category: detectConsoleCategory(level, message),
        scope: detectConsoleScope(message),
        message: message || "(empty log message)",
        origin: "main",
    };

    appConsoleLogBuffer.push(entry);
    if (appConsoleLogBuffer.length > APP_CONSOLE_BUFFER_LIMIT) {
        appConsoleLogBuffer.shift();
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            mainWindow.webContents.send(APP_CONSOLE_EVENT, entry);
        } catch (error) {
            // Ignore send failures while renderer is reloading or not yet ready.
        }
    }
}

function installMainConsoleCapture() {
    ["log", "info", "warn", "error"].forEach((level) => {
        const original = nativeConsole[level];
        console[level] = (...args) => {
            original(...args);

            if (consoleCaptureInProgress) return;
            consoleCaptureInProgress = true;
            try {
                pushAppConsoleLog(level, args);
            } finally {
                consoleCaptureInProgress = false;
            }
        };
    });
}

installMainConsoleCapture();


const EXTRACT_ROOTS = {
    "RobloxApp.zip": "",
    "redist.zip": "",
    "shaders.zip": "shaders/",
    "ssl.zip": "ssl/",
    "WebView2.zip": "",
    "WebView2RuntimeInstaller.zip": "WebView2RuntimeInstaller/",
    "content-avatar.zip": "content/avatar/",
    "content-configs.zip": "content/configs/",
    "content-fonts.zip": "content/fonts/",
    "content-sky.zip": "content/sky/",
    "content-sounds.zip": "content/sounds/",
    "content-textures2.zip": "content/textures/",
    "content-models.zip": "content/models/",
    "content-platform-fonts.zip": "PlatformContent/pc/fonts/",
    "content-platform-dictionaries.zip":
        "PlatformContent/pc/shared_compression_dictionaries/",
    "content-terrain.zip": "PlatformContent/pc/terrain/",
    "content-textures3.zip": "PlatformContent/pc/textures/",
    "extracontent-luapackages.zip": "ExtraContent/LuaPackages/",
    "extracontent-translations.zip": "ExtraContent/translations/",
    "extracontent-models.zip": "ExtraContent/models/",
    "extracontent-textures.zip": "ExtraContent/textures/",
    "extracontent-places.zip": "ExtraContent/places/",
};

const SETTINGS_TOKEN_BODY_LENGTH = 7;
const SETTINGS_TOKEN_LENGTH = 8;
const SETTINGS_TOKEN_ON = "N";
const SETTINGS_TOKEN_OFF = "F";
const DEFAULT_USER_SETTINGS = {
    appFont: "Segoe UI Variable",
    autoDownload: false,
    multiInstance: true,
    autoInject: true,
    notifications: true,
    robloxVersion: "latest",
    autoReopen: true,
    autoRejoinLastSession: true,
    maxReopenAttempts: 3,
    reopenDelay: 2000,
    lastPrivateServerUrl: "",
    globalRbxIdCheck: DEFAULT_GLOBAL_RBXIDCHECK,
    fflags: {
        fpsUnlocker: true,
        fpsLimit: 60,
        renderer: "d3d11",
        disableShadows: false,
        noTextures: false,
        lowQualityAudio: false,
        debugRendering: false,
        renderShadowmap: false,
        renderVoxelPerf: false,
        simAdaptiveTimestepping: false,
        networkDebugDraw: false,
        unifiedPhysicsSender: false,
        studioMaterialGenerator: false,
        studioPivotTools: false,
        studioEmulatorPerfStats: false,
        cameraGamepadZoom: false,
        topbarNewHover: false,
        emotesMenuV3: false,
        newAssembliesPGS: false,
        solverPrestepBudget: false,
        physicsPerfProfile: false,
        soundEngineFastSeek: false,
        spatialVoiceNoiseSuppression: false,
        audioOutputDeviceSelect: false,
        securityLuauBytecodeHash: false,
        clientIntegrityCheck: false,
        scriptPerformanceGuardrails: false,
        mobileGpuSkinning: false,
        dynamicResolutionV2: false,
        throttleBackgroundClients: false,
        logAnalyticsHttpFailures: false,
        errorReportStacktrace: false,
        perfTelemetryGpuCpuSplit: false,
    },
    memoryOptimization: {
        closeCrashHandler: false,
        memoryTrim: false,
        memoryTrimInterval: 60,
        systemMemoryCleaner: "never",
    },
    allowPrerelease: true,
    hideCapture: false,
    favoriteGames: [],
    lastSession: null,
};
const SETTINGS_BOOL_CODE_MAP = {
    autoDownload: "KQJJFNQ",
    multiInstance: "AFIWMFO",
    autoInject: "TMRXQPL",
    notifications: "NTFQCFG",
    autoReopen: "RPOENQK",
    autoRejoinLastSession: "AURJOIN",
    allowPrerelease: "ALWPRER",
    hideCapture: "HIDECAP",
    "memoryOptimization.closeCrashHandler": "CLSCRSH",
    "memoryOptimization.memoryTrim": "MEMTRIM",
    "fflags.fpsUnlocker": "FPSUNLK",
    "fflags.disableShadows": "SHDWDSB",
    "fflags.noTextures": "NOTXTRS",
    "fflags.lowQualityAudio": "LQAUDOX",
    "fflags.debugRendering": "DBGRNDR",
    "fflags.renderShadowmap": "RSHDMPA",
    "fflags.renderVoxelPerf": "RVXLPER",
    "fflags.simAdaptiveTimestepping": "SADATMP",
    "fflags.networkDebugDraw": "NWDBGDW",
    "fflags.unifiedPhysicsSender": "UNIPHSN",
    "fflags.studioMaterialGenerator": "STMATGN",
    "fflags.studioPivotTools": "STPIVOT",
    "fflags.studioEmulatorPerfStats": "STEMUPS",
    "fflags.cameraGamepadZoom": "CAMGPZM",
    "fflags.topbarNewHover": "TOPHOVR",
    "fflags.emotesMenuV3": "EMTVTHR",
    "fflags.newAssembliesPGS": "NWASPGS",
    "fflags.solverPrestepBudget": "SLVPBGT",
    "fflags.physicsPerfProfile": "PHPRPFL",
    "fflags.soundEngineFastSeek": "SNDFSKK",
    "fflags.spatialVoiceNoiseSuppression": "SPVNSUP",
    "fflags.audioOutputDeviceSelect": "AODSLCX",
    "fflags.securityLuauBytecodeHash": "SELBYTH",
    "fflags.clientIntegrityCheck": "CLNTINT",
    "fflags.scriptPerformanceGuardrails": "SCPGRDL",
    "fflags.mobileGpuSkinning": "MBGPSKN",
    "fflags.dynamicResolutionV2": "DYNRSLV",
    "fflags.throttleBackgroundClients": "THBKGCL",
    "fflags.logAnalyticsHttpFailures": "LGANHTF",
    "fflags.errorReportStacktrace": "ERRSTCK",
    "fflags.perfTelemetryGpuCpuSplit": "PFTGPCS",
};
const SETTINGS_CODE_TO_PATH = Object.fromEntries(
    Object.entries(SETTINGS_BOOL_CODE_MAP).map(([keyPath, code]) => [code, keyPath]),
);
const SETTINGS_RENDERER_CODE_MAP = {
    d3d11: "RDQNNUN",
    vulkan: "VKQNNUN",
    opengl: "OPQNNUN",
};
const SETTINGS_CODE_TO_RENDERER = Object.fromEntries(
    Object.entries(SETTINGS_RENDERER_CODE_MAP).map(([renderer, code]) => [code, renderer]),
);
const ADVANCED_FFLAG_APPLY_MAP = {
    debugRendering: {
        FFlagDebugRendering: "True",
    },
    renderShadowmap: {
        FFlagRenderShadowmap: "True",
    },
    renderVoxelPerf: {
        FFlagRenderVoxelPerf: "True",
    },
    simAdaptiveTimestepping: {
        DFFlagSimAdaptiveTimestepping: "True",
    },
    networkDebugDraw: {
        FFlagNetworkDebugDraw: "True",
    },
    unifiedPhysicsSender: {
        FFlagUnifiedPhysicsSender: "True",
    },
    studioMaterialGenerator: {
        FFlagStudioEnableMaterialGenerator: "True",
    },
    studioPivotTools: {
        FFlagStudioPivotTools: "True",
    },
    studioEmulatorPerfStats: {
        FFlagStudioEmulatorPerfStats: "True",
    },
    cameraGamepadZoom: {
        FFlagUserCameraToggleGamepadZoom: "True",
    },
    topbarNewHover: {
        FFlagTopbarNewHover: "True",
    },
    emotesMenuV3: {
        FFlagUserEmotesMenuV3: "True",
    },
    newAssembliesPGS: {
        FFlagNewAssembliesPGS: "True",
    },
    solverPrestepBudget: {
        FFlagSolverPrestepBudget: "True",
    },
    physicsPerfProfile: {
        FFlagPhysicsPerfProfile: "True",
    },
    soundEngineFastSeek: {
        FFlagSoundEngineFastSeek: "True",
    },
    spatialVoiceNoiseSuppression: {
        FFlagSpatialVoiceNoiseSuppression: "True",
    },
    audioOutputDeviceSelect: {
        FFlagAudioOutputDeviceSelect: "True",
    },
    securityLuauBytecodeHash: {
        DFFlagSecurityLuauBytecodeHash: "True",
    },
    clientIntegrityCheck: {
        FFlagClientIntegrityCheck: "True",
    },
    scriptPerformanceGuardrails: {
        FFlagScriptPerformanceGuardrails: "True",
    },
    mobileGpuSkinning: {
        FFlagMobileGpuSkinning: "True",
    },
    dynamicResolutionV2: {
        FFlagDynamicResolutionV2: "True",
    },
    throttleBackgroundClients: {
        FFlagThrottleBackgroundClients: "True",
    },
    logAnalyticsHttpFailures: {
        FFlagLogAnalyticsHttpFailures: "True",
    },
    errorReportStacktrace: {
        FFlagErrorReportStacktrace: "True",
    },
    perfTelemetryGpuCpuSplit: {
        FFlagPerfTelemetryGpuCpuSplit: "True",
    },
};
const SETTINGS_SECRET_PREFIX = "SC1:";

function createDefaultUserSettings() {
    return JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS));
}

function mergeSettingsWithDefaults(settings = {}) {
    const defaults = createDefaultUserSettings();
    const merged = {
        ...defaults,
        ...(settings || {}),
    };

    merged.fflags = {
        ...defaults.fflags,
        ...((settings && settings.fflags) || {}),
    };

    merged.memoryOptimization = {
        ...defaults.memoryOptimization,
        ...((settings && settings.memoryOptimization) || {}),
    };

    return merged;
}

function getNestedValue(target, keyPath) {
    return keyPath.split(".").reduce((acc, key) => {
        if (acc == null) return undefined;
        return acc[key];
    }, target);
}

function setNestedValue(target, keyPath, value) {
    const keys = keyPath.split(".");
    let current = target;

    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (!current[key] || typeof current[key] !== "object") {
            current[key] = {};
        }
        current = current[key];
    }

    current[keys[keys.length - 1]] = value;
}

function encodeSettingsBooleanCode(settings = {}) {
    const normalizedSettings = mergeSettingsWithDefaults(settings);
    return Object.entries(SETTINGS_BOOL_CODE_MAP)
        .map(([keyPath, code]) => {
            const boolValue = !!getNestedValue(normalizedSettings, keyPath);
            const state = boolValue ? SETTINGS_TOKEN_ON : SETTINGS_TOKEN_OFF;
            return `${code}${state}`;
        })
        .join("");
}

function decodeSettingsBooleanCode(rawCode, baseSettings = {}) {
    const normalizedCode = (rawCode || "")
        .toUpperCase()
        .replace(/[^A-Z]/g, "");
    const nextSettings = mergeSettingsWithDefaults(baseSettings);

    if (!normalizedCode) {
        return {
            settings: nextSettings,
            applied: 0,
            totalChunks: 0,
            unknownChunks: 0,
        };
    }

    let applied = 0;
    let totalChunks = 0;
    let unknownChunks = 0;

    for (
        let index = 0;
        index + SETTINGS_TOKEN_LENGTH <= normalizedCode.length;
        index += SETTINGS_TOKEN_LENGTH
    ) {
        const chunk = normalizedCode.slice(index, index + SETTINGS_TOKEN_LENGTH);
        const code = chunk.slice(0, SETTINGS_TOKEN_BODY_LENGTH);
        const state = chunk.slice(SETTINGS_TOKEN_BODY_LENGTH);

        totalChunks++;
        if (state !== SETTINGS_TOKEN_ON && state !== SETTINGS_TOKEN_OFF) {
            unknownChunks++;
            continue;
        }

        const keyPath = SETTINGS_CODE_TO_PATH[code];
        if (!keyPath) {
            unknownChunks++;
            continue;
        }

        setNestedValue(nextSettings, keyPath, state === SETTINGS_TOKEN_ON);
        applied++;
    }

    return {
        settings: nextSettings,
        applied,
        totalChunks,
        unknownChunks,
    };
}

function encodeSecretText(value) {
    if (typeof value !== "string" || !value) return "";
    return `${SETTINGS_SECRET_PREFIX}${Buffer.from(value, "utf8").toString("base64url")}`;
}

function decodeSecretText(value) {
    if (typeof value !== "string" || !value) return "";
    if (!value.startsWith(SETTINGS_SECRET_PREFIX)) {
        return value;
    }

    const payload = value.slice(SETTINGS_SECRET_PREFIX.length);
    if (!payload) return "";

    try {
        return Buffer.from(payload, "base64url").toString("utf8");
    } catch (error) {
        return "";
    }
}

function parseCompactSettingsExtras(rawExtras) {
    const extras = rawExtras && typeof rawExtras === "object" ? rawExtras : {};
    const parsed = {};

    const reopenDelayRaw = Number(extras.rd);
    if (Number.isFinite(reopenDelayRaw)) {
        parsed.reopenDelay = Math.min(10000, Math.max(500, Math.round(reopenDelayRaw)));
    }

    const maxReopenRaw = Number(extras.ma);
    if (Number.isFinite(maxReopenRaw)) {
        parsed.maxReopenAttempts = Math.min(20, Math.max(0, Math.round(maxReopenRaw)));
    }

    const fpsLimitRaw = Number(extras.fp);
    if (Number.isFinite(fpsLimitRaw)) {
        parsed.fflags = parsed.fflags || {};
        parsed.fflags.fpsLimit = Math.min(360, Math.max(15, Math.round(fpsLimitRaw)));
    }

    if (typeof extras.rr === "string") {
        const rendererCode = extras.rr.toUpperCase();
        const mappedRenderer =
            SETTINGS_CODE_TO_RENDERER[rendererCode] || extras.rr.toLowerCase();
        if (
            mappedRenderer === "d3d11" ||
            mappedRenderer === "vulkan" ||
            mappedRenderer === "opengl"
        ) {
            parsed.fflags = parsed.fflags || {};
            parsed.fflags.renderer = mappedRenderer;
        }
    }

    if (typeof extras.ps === "string") {
        parsed.lastPrivateServerUrl = decodeSecretText(extras.ps);
    }

    if (typeof extras.rv === "string") {
        const robloxVersion = extras.rv.trim();
        if (robloxVersion) {
            parsed.robloxVersion = robloxVersion;
        }
    }

    if (typeof extras.af === "string") {
        const appFont = decodeSecretText(extras.af);
        if (appFont) {
            parsed.appFont = appFont;
        }
    }

    if (typeof extras.ri === "string") {
        parsed.globalRbxIdCheck = decodeSecretText(extras.ri);
    }

    const memoryTrimIntervalRaw = Number(extras.mt);
    if (Number.isFinite(memoryTrimIntervalRaw)) {
        parsed.memoryOptimization = parsed.memoryOptimization || {};
        parsed.memoryOptimization.memoryTrimInterval = Math.min(
            300,
            Math.max(5, Math.round(memoryTrimIntervalRaw)),
        );
    }

    if (typeof extras.sm === "string") {
        const cleanerMode = extras.sm.trim().toLowerCase();
        if (cleanerMode) {
            parsed.memoryOptimization = parsed.memoryOptimization || {};
            parsed.memoryOptimization.systemMemoryCleaner = cleanerMode;
        }
    }

    if (typeof extras.fg === "string") {
        const favoriteGamesPayload = decodeSecretText(extras.fg);
        if (favoriteGamesPayload) {
            try {
                const parsedFavorites = JSON.parse(favoriteGamesPayload);
                if (Array.isArray(parsedFavorites)) {
                    parsed.favoriteGames = parsedFavorites
                        .map((entry) => {
                            const id = String(entry?.id || "").trim();
                            const alias = String(entry?.alias || "").trim();
                            if (!id) return null;
                            return {
                                id,
                                alias: alias || `Game ${id}`,
                            };
                        })
                        .filter(Boolean);
                }
            } catch (error) {
                // Ignore malformed favorite game payloads from older/corrupt exports.
            }
        }
    }

    return parsed;
}

function buildCompactSettingsExtras(settings = {}) {
    const normalized = mergeSettingsWithDefaults(settings);
    const renderer = typeof normalized.fflags?.renderer === "string"
        ? normalized.fflags.renderer.toLowerCase()
        : "d3d11";

    return {
        rd: Number(normalized.reopenDelay) || 2000,
        ma: Number(normalized.maxReopenAttempts) || 3,
        fp: Number(normalized.fflags?.fpsLimit) || 60,
        rr: SETTINGS_RENDERER_CODE_MAP[renderer] || SETTINGS_RENDERER_CODE_MAP.d3d11,
        ps: encodeSecretText(
            typeof normalized.lastPrivateServerUrl === "string"
                ? normalized.lastPrivateServerUrl
                : "",
        ),
        rv:
            typeof normalized.robloxVersion === "string" &&
                normalized.robloxVersion.trim()
                ? normalized.robloxVersion.trim()
                : "latest",
        af: encodeSecretText(
            typeof normalized.appFont === "string" ? normalized.appFont : "",
        ),
        ri: encodeSecretText(
            typeof normalized.globalRbxIdCheck === "string"
                ? normalized.globalRbxIdCheck
                : DEFAULT_GLOBAL_RBXIDCHECK,
        ),
        mt:
            Number(normalized.memoryOptimization?.memoryTrimInterval) || 60,
        sm:
            typeof normalized.memoryOptimization?.systemMemoryCleaner ===
                "string" &&
                normalized.memoryOptimization.systemMemoryCleaner
                ? normalized.memoryOptimization.systemMemoryCleaner
                : "never",
        fg: encodeSecretText(
            JSON.stringify(
                Array.isArray(normalized.favoriteGames)
                    ? normalized.favoriteGames
                    : [],
            ),
        ),
    };
}

async function ensureDirectories() {
    try {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
        await fs.mkdir(VERSIONS_DIR, { recursive: true });
    } catch (error) {
        console.error("[Data] Failed to create directories:", error);
    }
}

function setGuardStatus(state, detail) {
    guardStatus = {
        ...guardStatus,
        state,
        detail: detail || guardStatus.detail,
        lastChange: Date.now(),
    };

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("guard-status", guardStatus);
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeNamedCookie(cookie, cookieName, options = {}) {
    if (typeof cookie !== "string" || !cookieName) return "";

    const acceptBareValue = options.acceptBareValue !== false;
    let normalized = cookie.trim();
    if (!normalized) return "";

    normalized = normalized.replace(/^cookie:\s*/i, "");

    const escapedName = escapeRegex(cookieName);
    const keyRegex = new RegExp(`(?:^|;\\s*)${escapedName}\\s*=\\s*`, "i");
    const keyMatch = normalized.match(keyRegex);
    const keyIndex = keyMatch ? keyMatch.index : -1;

    if (keyIndex >= 0) {
        const prefixLength = keyMatch ? keyMatch[0].length : `${cookieName}=`.length;
        normalized = normalized.slice(keyIndex + prefixLength);
    } else if (!acceptBareValue) {
        return "";
    } else if (/^[^=;]+\s*=/.test(normalized)) {
        return "";
    }

    const semicolonIndex = normalized.indexOf(";");
    if (semicolonIndex >= 0) {
        normalized = normalized.slice(0, semicolonIndex);
    }

    if (
        normalized.length >= 2 &&
        ((normalized.startsWith('"') && normalized.endsWith('"')) ||
            (normalized.startsWith("'") && normalized.endsWith("'")))
    ) {
        normalized = normalized.slice(1, -1);
    }

    if (normalized.includes("%")) {
        try {
            const decoded = decodeURIComponent(normalized);
            if (decoded) {
                normalized = decoded;
            }
        } catch (error) {
            // Keep original value when decoding fails.
        }
    }

    normalized = normalized.replace(/\s+/g, "");
    return normalized.trim();
}

function extractRobloxAuthCookies(rawInput, seed = {}) {
    const authSeed = seed && typeof seed === "object" ? seed : {};
    const cookie = normalizeNamedCookie(
        authSeed.cookie || authSeed.roblosecurity || rawInput,
        ROBLOX_AUTH_COOKIE_NAMES.auth,
    );
    const hasExplicitRbxIdCheck =
        typeof authSeed.rbxIdCheck === "string" ||
        typeof authSeed.rbxidcheck === "string";
    const rbxIdCheck = normalizeNamedCookie(
        authSeed.rbxIdCheck || authSeed.rbxidcheck || rawInput,
        ROBLOX_AUTH_COOKIE_NAMES.checker,
        { acceptBareValue: hasExplicitRbxIdCheck },
    );

    return {
        cookie,
        rbxIdCheck,
    };
}

function normalizeRbxIdCheck(cookie) {
    return normalizeNamedCookie(cookie, ROBLOX_AUTH_COOKIE_NAMES.checker);
}

async function resolveGlobalRbxIdCheck(candidate = "") {
    const directValue = normalizeRbxIdCheck(candidate || "");
    if (directValue) {
        return directValue;
    }

    try {
        const loadedSettings = await loadSettings();
        const sharedValue = normalizeRbxIdCheck(
            typeof loadedSettings?.globalRbxIdCheck === "string"
                ? loadedSettings.globalRbxIdCheck
                : "",
        );
        if (sharedValue) {
            return sharedValue;
        }
    } catch (error) {
        console.warn("[Auth] Failed to resolve shared .RBXIDCHECK:", error.message);
    }

    return normalizeRbxIdCheck(DEFAULT_GLOBAL_RBXIDCHECK);
}

function normalizeLaunchAuthCookies(payload = {}) {
    const safePayload = payload && typeof payload === "object" ? payload : {};
    const accountInfo =
        safePayload.accountInfo && typeof safePayload.accountInfo === "object"
            ? safePayload.accountInfo
            : {};
    const primaryCookie =
        typeof safePayload.cookie === "string" ? safePayload.cookie : "";
    const fallbackCookie =
        typeof accountInfo.cookie === "string"
            ? accountInfo.cookie
            : typeof accountInfo.roblosecurity === "string"
                ? accountInfo.roblosecurity
                : "";

    const rbxIdCheck =
        typeof safePayload.rbxIdCheck === "string"
            ? safePayload.rbxIdCheck
            : typeof safePayload.rbxidcheck === "string"
                ? safePayload.rbxidcheck
                : typeof accountInfo.rbxIdCheck === "string"
                    ? accountInfo.rbxIdCheck
                    : typeof accountInfo.rbxidcheck === "string"
                        ? accountInfo.rbxidcheck
                        : typeof accountInfo.rbxId === "string"
                            ? accountInfo.rbxId
                            : "";

    return extractRobloxAuthCookies(primaryCookie || fallbackCookie, {
        cookie: primaryCookie || fallbackCookie,
        roblosecurity: fallbackCookie,
        rbxIdCheck,
        rbxidcheck: rbxIdCheck,
    });
}

async function applyRobloxSessionCookies(targetSession, input = {}) {
    const authCookies = extractRobloxAuthCookies(
        typeof input === "string" ? input : "",
        input,
    );

    await targetSession.clearStorageData({ storages: ["cookies"] });

    const expirationDate =
        Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
    const cookiesToSet = [
        authCookies.cookie
            ? {
                name: ROBLOX_AUTH_COOKIE_NAMES.auth,
                value: authCookies.cookie,
                httpOnly: true,
                sameSite: "no_restriction",
            }
            : null,
        authCookies.rbxIdCheck
            ? {
                name: ROBLOX_AUTH_COOKIE_NAMES.checker,
                value: authCookies.rbxIdCheck,
            }
            : null,
    ].filter(Boolean);

    for (const cookieEntry of cookiesToSet) {
        await targetSession.cookies.set({
            url: "https://www.roblox.com",
            domain: ".roblox.com",
            path: "/",
            secure: true,
            expirationDate,
            ...cookieEntry,
        });
    }

    return authCookies;
}

function readTextFileSafe(filePath) {
    try {
        return fsSync.readFileSync(filePath, "utf8");
    } catch (error) {
        return "";
    }
}

function isRendererHtmlHealthy(indexPath) {
    const html = readTextFileSafe(indexPath);
    if (!html) return false;

    return RENDERER_HEALTH_MARKERS.every((marker) => html.includes(marker));
}

function recoverHotRendererBundle(reason = "startup_validation") {
    if (!app.isPackaged) {
        return false;
    }

    const bundledIndex = path.join(__dirname, "index.html");
    const bundledStyles = path.join(__dirname, "styles.css");
    const hotIndex = path.join(HOT_UPDATE_DIR, "index.html");
    const hotStyles = path.join(HOT_UPDATE_DIR, "styles.css");

    try {
        fsSync.mkdirSync(HOT_UPDATE_DIR, { recursive: true });

        if (fsSync.existsSync(bundledIndex)) {
            fsSync.copyFileSync(bundledIndex, hotIndex);
        }
        if (fsSync.existsSync(bundledStyles)) {
            fsSync.copyFileSync(bundledStyles, hotStyles);
        }

        const recovered =
            fsSync.existsSync(hotIndex) &&
            fsSync.existsSync(hotStyles) &&
            isRendererHtmlHealthy(hotIndex);

        if (recovered) {
            console.warn(
                `[Renderer] Recovered hot-update renderer bundle (${reason})`,
            );
        }

        return recovered;
    } catch (error) {
        console.warn(
            `[Renderer] Failed to recover hot-update renderer bundle (${reason}):`,
            error.message,
        );
        return false;
    }
}

function getRendererIndexPath() {
    const bundledIndex = path.join(__dirname, "index.html");

    // In development/source runs, always use workspace renderer file.
    if (!app.isPackaged) {
        return bundledIndex;
    }

    const hotIndex = path.join(HOT_UPDATE_DIR, "index.html");
    const hotStyles = path.join(HOT_UPDATE_DIR, "styles.css");

    if (fsSync.existsSync(hotIndex)) {
        const hotRendererHealthy =
            fsSync.existsSync(hotStyles) && isRendererHtmlHealthy(hotIndex);

        if (!hotRendererHealthy) {
            console.warn(
                "[Renderer] Hot-update renderer is incomplete or unhealthy; attempting recovery",
            );
            recoverHotRendererBundle("startup_validation");
        }

        if (fsSync.existsSync(hotStyles) && isRendererHtmlHealthy(hotIndex)) {
            return hotIndex;
        }
        console.warn(
            "[Renderer] Hot-update renderer unavailable after recovery; using bundled renderer",
        );
    }

    return bundledIndex;
}

function resolvePowerShellExecutable() {
    if (process.platform !== "win32") {
        return "pwsh";
    }

    const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const candidatePaths = [
        path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        path.join(systemRoot, "Sysnative", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ];

    for (const candidatePath of candidatePaths) {
        try {
            if (fsSync.existsSync(candidatePath)) {
                return candidatePath;
            }
        } catch (error) {
            // Ignore path check errors and continue to fallback candidates.
        }
    }

    return "powershell.exe";
}

function isSpawnFailure(error) {
    if (!error) return false;
    if (error.code === "ENOENT" || error.code === "UNKNOWN") return true;
    const message = (error.message || "").toLowerCase();
    return message.includes("spawn");
}

function runPowerShellFile(scriptFile, options = {}, callback = () => { }) {
    const powerShellExecutable = resolvePowerShellExecutable();

    try {
        return execFile(
            powerShellExecutable,
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptFile],
            { windowsHide: true, ...options },
            (error, stdout, stderr) => {
                callback(error || null, stdout || "", stderr || "");
            },
        );
    } catch (error) {
        callback(error, "", "");
        return null;
    }
}

function queueRobloxLaunch(task, label = "launch") {
    const runTask = async () => {
        const elapsed = Date.now() - lastLaunchStartedAt;
        if (lastLaunchStartedAt && elapsed < LAUNCH_MIN_GAP_MS) {
            const waitMs = LAUNCH_MIN_GAP_MS - elapsed;
            console.log(`[LaunchQueue] Waiting ${waitMs}ms before ${label}`);
            await delay(waitMs);
        }

        lastLaunchStartedAt = Date.now();
        return await task();
    };

    const queuedTask = launchQueue.then(runTask, runTask);
    launchQueue = queuedTask.catch((error) => {
        console.log(
            `[LaunchQueue] ${label} failed: ${error?.message || String(error)}`,
        );
    });
    return queuedTask;
}

function isChildProcessRunning(childProc) {
    if (!childProc || !childProc.pid) return false;
    if (childProc.killed) return false;
    if (typeof childProc.exitCode === "number") return false;
    try {
        process.kill(childProc.pid, 0);
        return true;
    } catch (error) {
        return false;
    }
}

function normalizePathForComparison(filePath) {
    if (typeof filePath !== "string") return "";
    return filePath
        .replace(/\//g, "\\")
        .replace(/\\\\/g, "\\")
        .trim()
        .toLowerCase();
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const code = String(error?.code || "").toUpperCase();
        if (code === "ESRCH") return false;
        const message = String(error?.message || "").toLowerCase();
        if (message.includes("no such process")) return false;
        // Treat uncertain failures as alive to avoid false crash detection.
        return true;
    }
}

function listRobloxProcessesByPath(exePath = null) {
    const hasPathFilter =
        typeof exePath === "string" && exePath.trim().length > 0;
    const targetPath = hasPathFilter
        ? normalizePathForComparison(exePath)
        : "";
    if (hasPathFilter && !targetPath) return Promise.resolve([]);

    const psCmd =
        'powershell -NoProfile -Command "Get-Process -Name RobloxPlayerBeta -ErrorAction SilentlyContinue | ForEach-Object { $start = 0; try { $start = ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch { $start = 0 }; $procPath = \'\'; try { $procPath = $_.Path } catch { $procPath = \'\' }; Write-Output ($_.Id.ToString() + \'|\' + $procPath + \'|\' + $start.ToString()) }"';

    return new Promise((resolve) => {
        exec(
            psCmd,
            { windowsHide: true, maxBuffer: 1024 * 1024 },
            (error, stdout) => {
                if (error || !stdout) {
                    resolve([]);
                    return;
                }

                const processes = [];
                const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
                for (const line of lines) {
                    const parts = line.split("|");
                    if (parts.length < 2) continue;

                    const pid = parseInt(parts[0], 10);
                    if (!Number.isInteger(pid) || pid <= 0) continue;

                    const processPath = normalizePathForComparison(parts[1]);
                    if (hasPathFilter && processPath && processPath !== targetPath)
                        continue;

                    const startedAtMs = parseInt(parts[2] || "0", 10) || 0;
                    processes.push({
                        pid,
                        path: processPath,
                        startedAtMs,
                    });
                }

                resolve(processes);
            },
        );
    });
}

async function getRobloxProcessSnapshot(forceRefresh = false) {
    const now = Date.now();
    if (
        !forceRefresh &&
        now - robloxProcessSnapshotCache.timestamp <
        ROBLOX_PROCESS_SNAPSHOT_TTL_MS
    ) {
        return robloxProcessSnapshotCache.processes;
    }

    if (robloxProcessSnapshotPromise) {
        return robloxProcessSnapshotPromise;
    }

    robloxProcessSnapshotPromise = listRobloxProcessesByPath()
        .then((processes) => {
            const safeProcesses = Array.isArray(processes) ? processes : [];
            robloxProcessSnapshotCache = {
                timestamp: Date.now(),
                processes: safeProcesses,
            };
            return safeProcesses;
        })
        .catch(() => robloxProcessSnapshotCache.processes)
        .finally(() => {
            robloxProcessSnapshotPromise = null;
        });

    return robloxProcessSnapshotPromise;
}

async function reconcileRunningInstances(options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const emitCloseEvents = options.emitCloseEvents === true;
    const removedPids = [];

    try {
        const processes = await getRobloxProcessSnapshot(forceRefresh);
        const processByPid = new Map();
        for (const processInfo of processes || []) {
            if (!processInfo || !Number.isInteger(processInfo.pid)) continue;
            processByPid.set(processInfo.pid, processInfo);
        }

        const now = Date.now();
        const launchingGraceMs = PID_SCAN_MAX_ATTEMPTS * PID_SCAN_INTERVAL_MS;

        for (const [pid, instanceData] of runningInstances.entries()) {
            const processInfo = processByPid.get(pid);
            if (!processInfo) {
                const startedAt = Number(instanceData?.startTime) || now;
                const isLaunching =
                    instanceData?.status === "Launching" &&
                    now - startedAt <= launchingGraceMs;

                if (isLaunching && isProcessAlive(pid)) {
                    continue;
                }

                runningInstances.delete(pid);
                reopenMetadata.delete(pid);
                removedPids.push(pid);
                continue;
            }

            const expectedPath = normalizePathForComparison(instanceData?.exePath);
            const processPath = normalizePathForComparison(processInfo.path);
            if (expectedPath && processPath && processPath !== expectedPath) {
                runningInstances.delete(pid);
                reopenMetadata.delete(pid);
                removedPids.push(pid);
            }
        }

        if (
            emitCloseEvents &&
            removedPids.length > 0 &&
            mainWindow &&
            !mainWindow.isDestroyed()
        ) {
            for (const pid of removedPids) {
                mainWindow.webContents.send("instance-closed", { pid });
            }
        }
    } catch (error) {
        console.warn(
            `[InstanceSync] Failed to reconcile running instances: ${error.message}`,
        );
    }

    return removedPids;
}

async function findLikelyProcessSuccessor({
    previousPid,
    exePath,
    launchedAfterMs = 0,
}) {
    if (!exePath) return null;

    try {
        const processes = await listRobloxProcessesByPath(exePath);
        const candidates = processes
            .filter((processInfo) => {
                if (!processInfo || processInfo.pid === previousPid) return false;
                if (runningInstances.has(processInfo.pid)) return false;
                if (!isProcessAlive(processInfo.pid)) return false;
                if (launchedAfterMs > 0 && processInfo.startedAtMs > 0) {
                    return processInfo.startedAtMs >= launchedAfterMs;
                }
                return true;
            })
            .sort((a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0));

        return candidates[0] || null;
    } catch (error) {
        return null;
    }
}

async function ensureMultiInstanceGuardForLaunch() {
    if (isChildProcessRunning(multiInstanceProcess)) {
        isMutexHeld = true;
        if (guardStatus.state !== "ready") {
            setGuardStatus("ready", "Guard ready for launch");
        }
        // Tambah: beri sedikit jeda agar Roblox sebelumnya sudah fully lock mutex-nya
        if (runningInstances.size > 0) {
            await delay(800);
        }
        return true;
    }

    if (multiInstanceProcess) {
        multiInstanceProcess = null;
    }
    isMutexHeld = false;

    const started = await startMultiInstanceMutex({
        force: false,
        maxAttempts: 3,
        retryDelayMs: 900,
        timeoutMs: 9000,
    });
    return !!started;
}

// Ganti fungsi closeRobloxSingletonHandles & buildHandleCloserScript

function buildHandleCloserScript(excludedPids = []) {
    const excludedPidsStr = excludedPids.length > 0
        ? excludedPids.join(',')
        : '';

    const lines = [];
    lines.push('$ErrorActionPreference = "Continue"');
    lines.push(`$ExcludedPids = @(${excludedPidsStr})`);
    lines.push('Add-Type @"');
    lines.push('using System;');
    lines.push('using System.Threading;');
    lines.push('using System.Collections.Generic;');
    lines.push('using System.Runtime.InteropServices;');
    lines.push('using System.Diagnostics;');
    lines.push('');
    lines.push('public class RobloxHandleCloser {');
    lines.push('    [DllImport("ntdll.dll")]');
    lines.push('    static extern int NtQuerySystemInformation(int c, IntPtr i, int s, out int r);');
    lines.push('    [DllImport("ntdll.dll")]');
    lines.push('    static extern int NtQueryObject(IntPtr h, int c, IntPtr i, int s, out int r);');
    lines.push('    [DllImport("kernel32.dll", SetLastError=true)]');
    lines.push('    static extern IntPtr OpenProcess(int a, bool b, int p);');
    lines.push('    [DllImport("kernel32.dll", SetLastError=true)]');
    lines.push('    [return: MarshalAs(UnmanagedType.Bool)]');
    lines.push('    static extern bool DuplicateHandle(IntPtr s, IntPtr sh, IntPtr t, out IntPtr th, int a, bool i, int o);');
    lines.push('    [DllImport("kernel32.dll", SetLastError=true)]');
    lines.push('    [return: MarshalAs(UnmanagedType.Bool)]');
    lines.push('    static extern bool CloseHandle(IntPtr h);');
    lines.push('    [DllImport("kernel32.dll")]');
    lines.push('    static extern IntPtr GetCurrentProcess();');
    lines.push('');
    lines.push('    [StructLayout(LayoutKind.Sequential)]');
    lines.push('    struct SHE { public int Pid; public byte OT; public byte F; public short HV; public IntPtr OP; public int GA; }');
    lines.push('');
    lines.push('    static string QName(IntPtr ph, IntPtr hv) {');
    lines.push('        IntPtr dh; if (!DuplicateHandle(ph,hv,GetCurrentProcess(),out dh,0,false,2)) return null;');
    lines.push('        string res=null;');
    lines.push('        Thread t=new Thread(()=>{');
    lines.push('            IntPtr b=Marshal.AllocHGlobal(1024);');
    lines.push('            try{ int r; if(NtQueryObject(dh,1,b,1024,out r)==0){');
    lines.push('                int nl=Marshal.ReadInt16(b,0); if(nl>0){');
    lines.push('                    IntPtr np=Marshal.ReadIntPtr(b,IntPtr.Size==8?8:4);');
    lines.push('                    res=Marshal.PtrToStringUni(np,nl/2);');
    lines.push('            }}}catch{}finally{Marshal.FreeHGlobal(b);}');
    lines.push('        }); t.IsBackground=true; t.Start();');
    lines.push('        if(!t.Join(200)){try{t.Interrupt();}catch{}}');
    lines.push('        CloseHandle(dh); return res;');
    lines.push('    }');
    lines.push('');
    lines.push('    public static int Run(HashSet<int> excluded) {');
    lines.push('        int closed=0;');
    lines.push('        var pids=new HashSet<int>();');
    lines.push('        foreach(var p in Process.GetProcessesByName("RobloxPlayerBeta")) {');
    lines.push('            if (!excluded.Contains(p.Id)) pids.Add(p.Id);');
    lines.push('        }');
    lines.push('        if(pids.Count==0){Console.WriteLine("HC:no_eligible_roblox");return 0;}');
    lines.push('        Console.WriteLine("HC:eligible_pids:"+pids.Count);');
    lines.push('        int bs=4*1024*1024; IntPtr buf; int rl;');
    lines.push('        while(true){');
    lines.push('            buf=Marshal.AllocHGlobal(bs);');
    lines.push('            int st=NtQuerySystemInformation(16,buf,bs,out rl);');
    lines.push('            if(st==unchecked((int)0xC0000004)){Marshal.FreeHGlobal(buf);bs*=2;if(bs>256*1024*1024)return 0;continue;}');
    lines.push('            if(st!=0){Marshal.FreeHGlobal(buf);Console.WriteLine("HC:qfail:"+st);return 0;}');
    lines.push('            break;');
    lines.push('        }');
    lines.push('        try{');
    lines.push('            long cnt=IntPtr.Size==8?Marshal.ReadInt64(buf,0):Marshal.ReadInt32(buf,0);');
    lines.push('            int es=Marshal.SizeOf(typeof(SHE)); int off=IntPtr.Size;');
    lines.push('            var ph=new Dictionary<int,IntPtr>();');
    lines.push('            for(long i=0;i<cnt;i++){');
    lines.push('                SHE e=(SHE)Marshal.PtrToStructure(new IntPtr(buf.ToInt64()+off+i*es),typeof(SHE));');
    lines.push('                if(!pids.Contains(e.Pid))continue;');
    lines.push('                IntPtr p; if(!ph.TryGetValue(e.Pid,out p)){p=OpenProcess(0x40,false,e.Pid);if(p==IntPtr.Zero)continue;ph[e.Pid]=p;}');
    lines.push('                try{string n=QName(p,new IntPtr(e.HV));');
    lines.push('                    if(n!=null&&n.Contains("ROBLOX_singleton")){');
    lines.push('                        IntPtr d;if(DuplicateHandle(p,new IntPtr(e.HV),IntPtr.Zero,out d,0,false,1)){');
    lines.push('                            Console.WriteLine("HC_CLOSED:"+e.Pid+":"+n);closed++;}');
    lines.push('                }}catch{}');
    lines.push('            }');
    lines.push('            foreach(var kv in ph)CloseHandle(kv.Value);');
    lines.push('        }finally{Marshal.FreeHGlobal(buf);}');
    lines.push('        Console.WriteLine("HC:closed:"+closed);');
    lines.push('        return closed;');
    lines.push('    }');
    lines.push('}');
    lines.push('"@');

    // Pass excluded PIDs dari PowerShell ke C# method
    if (excludedPids.length > 0) {
        lines.push(`$excSet = [System.Collections.Generic.HashSet[int]]::new(@(${excludedPidsStr}))`);
    } else {
        lines.push('$excSet = [System.Collections.Generic.HashSet[int]]::new()');
    }
    lines.push('[RobloxHandleCloser]::Run($excSet)');

    return lines.join('\r\n');
}

async function closeRobloxSingletonHandles() {
    // Kumpulkan PIDs yang sedang dikelola — JANGAN sentuh mereka
    const excludedPids = Array.from(runningInstances.keys()).filter(
        pid => Number.isInteger(pid) && pid > 0
    );

    return new Promise((resolve) => {
        const tmpFile = path.join(app.getPath('temp'), 'tirex_hc_' + Date.now() + '.ps1');
        const script = buildHandleCloserScript(excludedPids);
        require('fs').writeFileSync(tmpFile, script);

        if (excludedPids.length > 0) {
            console.log(`[MultiInstance] Handle closer skipping active PIDs: [${excludedPids.join(', ')}]`);
        }
        console.log('[MultiInstance] Running handle closer...');

        runPowerShellFile(tmpFile, { timeout: 6000 }, (error, stdout, stderr) => {
            if (stdout) console.log('[MultiInstance] HC:', stdout.trim());
            if (stderr) console.error('[MultiInstance] HC stderr:', stderr.trim());
            if (error) {
                console.error("[MultiInstance] Handle closer failed:", error.message);
            }
            try { require('fs').unlinkSync(tmpFile); } catch (e) { }
            const match = stdout && stdout.match(/closed:(\d+)/);
            resolve(match ? parseInt(match[1]) : 0);
        });
    });
}

function buildMultiInstanceScript() {
    return `
$ErrorActionPreference = "Continue"
Add-Type @"
using System;
using System.Threading;
using System.Collections.Generic;

public class RobloxMultiInstanceGuard {
    private static List<Mutex> Mutexes = new List<Mutex>();
    private static List<EventWaitHandle> Events = new List<EventWaitHandle>();

    public static bool Start() {
        string[] mutexNames = new string[] {
            "ROBLOX_singletonMutex",
            "Global\\\\ROBLOX_singletonMutex",
            "Local\\\\ROBLOX_singletonMutex"
        };

        string[] eventNames = new string[] {
            "ROBLOX_singletonEvent",
            "Global\\\\ROBLOX_singletonEvent",
            "Local\\\\ROBLOX_singletonEvent"
        };

        bool acquired = false;
        bool eventCreated = false;

        foreach (string name in mutexNames) {
            try {
                bool createdNew;
                Mutex m = new Mutex(true, name, out createdNew);
                if (!createdNew) {
                    try {
                        if (m.WaitOne(TimeSpan.Zero)) {
                            acquired = true;
                        }
                    } catch (AbandonedMutexException) {
                        acquired = true;
                    }
                } else {
                    acquired = true;
                }
                Mutexes.Add(m);
                Console.WriteLine("MUTEX_OK:" + name + ":" + createdNew);
            } catch (Exception ex) {
                Console.WriteLine("MUTEX_ERR:" + name + ":" + ex.GetType().Name);
            }
        }

        foreach (string name in eventNames) {
            try {
                bool createdNew;
                EventWaitHandle e = new EventWaitHandle(false, EventResetMode.AutoReset, name, out createdNew);
                Events.Add(e);
                if (createdNew) {
                    eventCreated = true;
                }
                Console.WriteLine("EVENT_OK:" + name + ":" + createdNew);
            } catch (Exception ex) {
                Console.WriteLine("EVENT_ERR:" + name + ":" + ex.GetType().Name);
            }
        }

        if (!acquired && eventCreated) {
            acquired = true;
        }

        if (!acquired) {
            Console.WriteLine("GUARD_FAILED");
            Console.Out.Flush();
            return false;
        }

        Console.WriteLine("GUARD_READY");
        Console.Out.Flush();
        Thread.Sleep(Timeout.Infinite);
        return true;
    }
}
"@

[RobloxMultiInstanceGuard]::Start()
`;
}

async function startMultiInstanceMutex(options = {}) {
    const {
        force = false,
        maxAttempts = 3,
        retryDelayMs = 1200,
        timeoutMs = 8000,
    } = options;

    if (guardStartPromise && !force) {
        return guardStartPromise;
    }

    if (multiInstanceProcess) {
        if (!force) {
            console.log("[MultiInstance] Mutex already held");
            setGuardStatus("ready", "Guard already running");
            return true;
        }
        stopMultiInstanceMutex({ reason: "Force restarting guard" });
    }

    guardStartPromise = (async () => {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const attemptLabel = `Attempt ${attempt}/${maxAttempts}`;
            setGuardStatus(
                attempt === 1 ? "starting" : "retrying",
                `Starting guard (${attemptLabel})`,
            );

            const result = await startMultiInstanceMutexOnce({ timeoutMs });
            if (result.ok) {
                return true;
            }

            const reason = result.reason || "Guard failed";
            if (attempt < maxAttempts) {
                setGuardStatus(
                    "retrying",
                    `${reason}. Retrying... (${attemptLabel})`,
                );
                await delay(retryDelayMs);
            } else {
                setGuardStatus(
                    "failed",
                    `${reason}. Failed after ${maxAttempts} attempts`,
                );
            }
        }

        return false;
    })();

    try {
        return await guardStartPromise;
    } finally {
        guardStartPromise = null;
    }
}

function startMultiInstanceMutexOnce({ timeoutMs }) {
    return new Promise(async (resolve) => {
        console.log("[MultiInstance] Starting mutex/event guard...");

        // First: close Roblox's singleton handles so we can acquire them
        try {
            const closed = await closeRobloxSingletonHandles();
            console.log(`[MultiInstance] Handle closer finished (closed ${closed} handles)`);
        } catch (err) {
            console.error("[MultiInstance] Handle closer error:", err.message);
        }

        const psScript = buildMultiInstanceScript();
        let guardProcess = null;

        let resolved = false;
        let timeoutId = null;

        const finalize = (ok, reason) => {
            if (resolved) return;
            resolved = true;

            if (timeoutId) {
                clearTimeout(timeoutId);
            }

            if (!ok && guardProcess) {
                try {
                    guardProcess.kill();
                } catch (error) {
                    console.log("[MultiInstance] Failed to kill guard:", error.message);
                }
            }

            resolve({ ok, reason });
        };

        try {
            guardProcess = spawn(
                resolvePowerShellExecutable(),
                ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
                {
                    stdio: ["ignore", "pipe", "pipe"],
                    windowsHide: true,
                },
            );
        } catch (error) {
            console.error("[MultiInstance] Guard spawn failed:", error.message);
            setGuardStatus("failed", `Guard spawn failed: ${error.message}`);
            finalize(false, `Guard spawn failed: ${error.message}`);
            return;
        }

        guardProcess.stdout.on("data", (data) => {
            const output = data.toString().trim();
            console.log("[MultiInstance]", output);

            if (output.includes("GUARD_READY")) {
                isMutexHeld = true;
                multiInstanceProcess = guardProcess;
                console.log("[MultiInstance] Guard ready - Multi-instance enabled");
                setGuardStatus("ready", "Guard ready - Multi-instance enabled");
                finalize(true);
            } else if (output.includes("GUARD_FAILED")) {
                console.log("[MultiInstance] Failed to acquire mutex");
                isMutexHeld = false;
                setGuardStatus("failed", "Failed to acquire mutex");
                finalize(false, "Failed to acquire mutex");
            }
        });

        guardProcess.stderr.on("data", (data) => {
            console.error("[MultiInstance] Error:", data.toString());
        });

        guardProcess.on("error", (error) => {
            console.error("[MultiInstance] Guard process error:", error.message);
            isMutexHeld = false;
            setGuardStatus("failed", `Guard process error: ${error.message}`);
            finalize(false, `Guard process error: ${error.message}`);
        });

        guardProcess.on("exit", (code) => {
            console.log("[MultiInstance] Process exited with code:", code);

            if (multiInstanceProcess === guardProcess) {
                isMutexHeld = false;
                multiInstanceProcess = null;
                setGuardStatus(
                    "stopped",
                    `Guard exited (code ${code ?? "unknown"})`,
                );
            }

            if (!resolved) {
                finalize(false, `Guard exited (code ${code ?? "unknown"})`);
            }
        });

        timeoutId = setTimeout(() => {
            if (!resolved) {
                console.log("[MultiInstance] Timeout acquiring mutex");
                isMutexHeld = false;
                setGuardStatus("failed", "Timeout acquiring mutex");
                finalize(false, "Timeout acquiring mutex");
            }
        }, timeoutMs);
    });
}

function stopMultiInstanceMutex(options = {}) {
    if (multiInstanceProcess) {
        console.log("[MultiInstance] Releasing mutex...");
        try {
            multiInstanceProcess.kill();
        } catch (error) {
            console.log("[MultiInstance] Failed to kill guard:", error.message);
        }
        multiInstanceProcess = null;
        isMutexHeld = false;
        console.log("[MultiInstance] Mutex released");
    }

    if (options.reason) {
        setGuardStatus("stopped", options.reason);
    } else {
        setGuardStatus("stopped", "Guard stopped");
    }
}

async function clearRobloxCache() {
    try {
        const robloxLocalAppData = path.join(
            process.env.LOCALAPPDATA || "",
            "Roblox"
        );

        console.log("[Cache] Clearing recently visited games data...");

        // Clear LocalStorage which contains recently visited games
        const localStoragePath = path.join(robloxLocalAppData, "LocalStorage");
        try {
            if (fsSync.existsSync(localStoragePath)) {
                const files = await fs.readdir(localStoragePath);
                for (const file of files) {
                    // Only delete leveldb files that store game history
                    if (file.includes('leveldb') || file.endsWith('.log') || file.endsWith('.ldb')) {
                        const filePath = path.join(localStoragePath, file);
                        await fs.unlink(filePath);
                        console.log(`[Cache] Cleared: ${filePath}`);
                    }
                }
            }
        } catch (error) {
            console.log(`[Cache] Could not clear LocalStorage:`, error.message);
        }

        // Clear blob_storage which may contain game data
        const blobStoragePath = path.join(robloxLocalAppData, "blob_storage");
        try {
            if (fsSync.existsSync(blobStoragePath)) {
                await fs.rm(blobStoragePath, { recursive: true, force: true });
                console.log(`[Cache] Cleared: ${blobStoragePath}`);
            }
        } catch (error) {
            console.log(`[Cache] Could not clear blob_storage:`, error.message);
        }

        // Clear IndexedDB which may store game history
        const indexedDBPath = path.join(robloxLocalAppData, "IndexedDB");
        try {
            if (fsSync.existsSync(indexedDBPath)) {
                await fs.rm(indexedDBPath, { recursive: true, force: true });
                console.log(`[Cache] Cleared: ${indexedDBPath}`);
            }
        } catch (error) {
            console.log(`[Cache] Could not clear IndexedDB:`, error.message);
        }

        // Clear http cache but preserve settings
        const httpCachePath = path.join(robloxLocalAppData, "http");
        try {
            if (fsSync.existsSync(httpCachePath)) {
                await fs.rm(httpCachePath, { recursive: true, force: true });
                console.log(`[Cache] Cleared: ${httpCachePath}`);
            }
        } catch (error) {
            console.log(`[Cache] Could not clear http:`, error.message);
        }

        console.log("[Cache] âœ… Recently visited games cleared");
        return { success: true };
    } catch (error) {
        console.error("[Cache] Error clearing cache:", error);
        return { success: false, error: error.message };
    }
}

async function loadAccounts() {
    try {
        const data = await fs.readFile(accountsFile, "utf8");
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

async function saveAccounts(accounts) {
    try {
        await ensureDirectories();
        await fs.writeFile(accountsFile, JSON.stringify(accounts, null, 2));
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function loadSettings() {
    try {
        const data = await fs.readFile(settingsFile, "utf8");
        const mergedSettings = mergeSettingsWithDefaults(JSON.parse(data));
        mergedSettings.globalRbxIdCheck =
            normalizeRbxIdCheck(mergedSettings.globalRbxIdCheck || "") ||
            DEFAULT_GLOBAL_RBXIDCHECK;
        return mergedSettings;
    } catch (error) {
        return createDefaultUserSettings();
    }
}

async function saveSettings(settings) {
    try {
        await ensureDirectories();
        const normalizedSettings = mergeSettingsWithDefaults(settings);
        normalizedSettings.globalRbxIdCheck =
            normalizeRbxIdCheck(normalizedSettings.globalRbxIdCheck || "") ||
            DEFAULT_GLOBAL_RBXIDCHECK;
        await fs.writeFile(settingsFile, JSON.stringify(normalizedSettings, null, 2));
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function applyFFlags(version, settings) {
    try {
        const exePath = resolveRobloxExe(version);
        if (!exePath) return { success: false, error: 'Roblox executable not found' };
        const versionPath = path.dirname(exePath);
        const clientSettingsDir = path.join(versionPath, "ClientSettings");

        // Ensure ClientSettings directory exists
        if (!fsSync.existsSync(clientSettingsDir)) {
            fsSync.mkdirSync(clientSettingsDir, { recursive: true });
        }

        const clientSettingsFile = path.join(clientSettingsDir, "ClientAppSettings.json");
        const fflags = settings?.fflags || {};

        // Build FFlags JSON
        const fflagsJson = {};

        // FPS Unlocker
        if (fflags.fpsUnlocker && fflags.fpsLimit) {
            fflagsJson["DFIntTaskSchedulerTargetFps"] = parseInt(fflags.fpsLimit);
            console.log(`[FFlags] FPS Cap set to: ${fflags.fpsLimit}`);
        }

        // Rendering API
        if (fflags.renderer) {
            switch (fflags.renderer) {
                case 'vulkan':
                    fflagsJson["FFlagDebugGraphicsPreferVulkan"] = "True";
                    fflagsJson["FFlagDebugGraphicsDisableDirect3D11"] = "True";
                    fflagsJson["FFlagDebugGraphicsDisableOpenGL"] = "True";
                    console.log('[FFlags] Renderer: Vulkan');
                    break;
                case 'opengl':
                    fflagsJson["FFlagDebugGraphicsPreferOpenGL"] = "True";
                    fflagsJson["FFlagDebugGraphicsDisableDirect3D11"] = "True";
                    fflagsJson["FFlagDebugGraphicsDisableVulkan"] = "True";
                    console.log('[FFlags] Renderer: OpenGL');
                    break;
                case 'd3d11':
                default:
                    fflagsJson["FFlagDebugGraphicsPreferD3D11"] = "True";
                    fflagsJson["FFlagDebugGraphicsDisableVulkan"] = "True";
                    fflagsJson["FFlagDebugGraphicsDisableOpenGL"] = "True";
                    console.log('[FFlags] Renderer: Direct3D 11');
                    break;
            }
        }

        // Optimizations
        if (fflags.disableShadows) {
            fflagsJson["FIntRenderShadowIntensity"] = "0";
            fflagsJson["DFIntCullFactorPixelThresholdShadowMapHighQuality"] = "2147483647";
            fflagsJson["DFIntCullFactorPixelThresholdShadowMapLowQuality"] = "2147483647";
            console.log('[FFlags] Shadows disabled');
        }

        if (fflags.noTextures) {
            fflagsJson["FIntDebugTextureManagerSkipMips"] = "9999";
            console.log('[FFlags] Textures minimized');
        }

        if (fflags.lowQualityAudio) {
            fflagsJson["DFIntDefaultAudioSampleRate"] = "22050";
            console.log('[FFlags] Audio quality reduced');
        }

        Object.entries(ADVANCED_FFLAG_APPLY_MAP).forEach(([settingKey, flagValues]) => {
            if (!fflags[settingKey]) return;
            Object.entries(flagValues).forEach(([flagName, flagValue]) => {
                fflagsJson[flagName] = flagValue;
            });
        });

        // Write the file
        await fs.writeFile(clientSettingsFile, JSON.stringify(fflagsJson, null, 4));
        console.log(`[FFlags] Applied to: ${clientSettingsFile}`);

        return { success: true, applied: Object.keys(fflagsJson).length };
    } catch (error) {
        console.error('[FFlags] Error applying:', error);
        return { success: false, error: error.message };
    }
}

// Settings and Accounts IPC Handlers
ipcMain.handle("load-accounts", async () => {
    try {
        const data = await fs.readFile(accountsFile, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.log('[Accounts] No accounts file found, returning empty array');
        return [];
    }
});

ipcMain.handle("save-accounts", async (event, accounts) => {
    try {
        await ensureDirectories();
        await fs.writeFile(accountsFile, JSON.stringify(accounts, null, 2));
        return { success: true };
    } catch (error) {
        console.error('[Accounts] Error saving:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle("load-settings", async () => {
    return await loadSettings();
});

ipcMain.handle("save-settings", async (event, settings) => {
    return await saveSettings(settings);
});

ipcMain.handle("clear-roblox-cache", async () => {
    try {
        return await clearRobloxCache();
    } catch (error) {
        console.error('[Cache] Error clearing:', error);
        return { success: false, error: error.message };
    }
});

// â”€â”€ Memory Optimization IPC Handlers â”€â”€

let memoryTrimInterval = null;
let systemCleanerInterval = null;
let memoryTrimRunning = false;
let systemCleanerRunning = false;
let memoryTrimProcess = null;
let systemCleanerProcess = null;
let memoryTrimScriptFile = null;
let systemCleanerScriptFile = null;

function cleanupMemoryScript(scriptPath) {
    if (!scriptPath) return;
    try {
        if (fsSync.existsSync(scriptPath)) {
            fsSync.unlinkSync(scriptPath);
        }
    } catch (error) {
        console.warn(`[MemOpt] Failed to cleanup ${scriptPath}: ${error.message}`);
    }
}

function stopMemoryServicesInternal() {
    if (memoryTrimInterval) {
        clearInterval(memoryTrimInterval);
        memoryTrimInterval = null;
    }
    if (systemCleanerInterval) {
        clearInterval(systemCleanerInterval);
        systemCleanerInterval = null;
    }

    if (isChildProcessRunning(memoryTrimProcess)) {
        try {
            memoryTrimProcess.kill();
        } catch (error) {
            console.warn(`[MemOpt] Failed to stop memory trim process: ${error.message}`);
        }
    }
    if (isChildProcessRunning(systemCleanerProcess)) {
        try {
            systemCleanerProcess.kill();
        } catch (error) {
            console.warn(`[MemOpt] Failed to stop system cleaner process: ${error.message}`);
        }
    }

    memoryTrimProcess = null;
    systemCleanerProcess = null;
    memoryTrimRunning = false;
    systemCleanerRunning = false;

    cleanupMemoryScript(memoryTrimScriptFile);
    cleanupMemoryScript(systemCleanerScriptFile);
    memoryTrimScriptFile = null;
    systemCleanerScriptFile = null;
}

ipcMain.handle("close-crash-handler", async () => {
    try {
        return new Promise((resolve) => {
            exec('taskkill /F /IM RobloxCrashHandler.exe /T', { windowsHide: true }, (error, stdout, stderr) => {
                if (error) {
                    // Process might not exist, that's fine
                    if (error.message && error.message.includes('not found')) {
                        console.log('[MemOpt] RobloxCrashHandler.exe not running');
                        resolve({ success: true, message: 'Process not running' });
                    } else {
                        console.log('[MemOpt] Close crash handler result:', error.message);
                        resolve({ success: true, message: error.message });
                    }
                } else {
                    console.log('[MemOpt] RobloxCrashHandler.exe killed successfully');
                    resolve({ success: true, message: 'Crash handler closed' });
                }
            });
        });
    } catch (error) {
        console.error('[MemOpt] Error closing crash handler:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle("trim-roblox-memory", async () => {
    try {
        const scriptContent = [
            'Add-Type -TypeDefinition @"',
            'using System;',
            'using System.Runtime.InteropServices;',
            'public class MemTrim {',
            '    [DllImport("kernel32.dll")]',
            '    public static extern bool SetProcessWorkingSetSizeEx(IntPtr hProcess, IntPtr dwMinimumWorkingSetSize, IntPtr dwMaximumWorkingSetSize, int flags);',
            '}',
            '"@ -ErrorAction SilentlyContinue',
            '',
            'Get-Process -Name "RobloxPlayerBeta" -ErrorAction SilentlyContinue | ForEach-Object {',
            '    $ws = $_.WorkingSet64',
            '    $id = $_.Id',
            '    [MemTrim]::SetProcessWorkingSetSizeEx($_.Handle, [IntPtr]::new(-1), [IntPtr]::new(-1), 0) | Out-Null',
            '    $newWs = (Get-Process -Id $id -ErrorAction SilentlyContinue).WorkingSet64',
            '    Write-Output "Trimmed PID $id : $([math]::Round($ws/1MB,1))MB -> $([math]::Round($newWs/1MB,1))MB"',
            '}',
        ].join('\r\n');

        const tmpFile = path.join(
            app.getPath('temp'),
            `tirex_memtrim_${process.pid}_${Date.now()}.ps1`,
        );
        await fs.writeFile(tmpFile, scriptContent);

        return new Promise((resolve) => {
            runPowerShellFile(tmpFile, {}, (error, stdout, stderr) => {
                cleanupMemoryScript(tmpFile);
                if (error) {
                    console.log('[MemOpt] Memory trim error:', error.message);
                    resolve({ success: false, error: error.message });
                } else {
                    const output = stdout.trim();
                    console.log('[MemOpt] Memory trim:', output || 'No Roblox processes found');
                    resolve({ success: true, message: output || 'No Roblox processes' });
                }
            });
        });
    } catch (error) {
        console.error('[MemOpt] Error trimming memory:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle("clean-system-memory", async () => {
    try {
        const scriptContent = [
            'Add-Type -TypeDefinition @"',
            'using System;',
            'using System.Runtime.InteropServices;',
            'public class SysMemClean {',
            '    [DllImport("kernel32.dll")]',
            '    public static extern bool SetProcessWorkingSetSizeEx(IntPtr hProcess, IntPtr dwMinimumWorkingSetSize, IntPtr dwMaximumWorkingSetSize, int flags);',
            '}',
            '"@ -ErrorAction SilentlyContinue',
            '',
            '$exclude = @("RobloxPlayerBeta","RobloxCrashHandler")',
            'Get-Process | Where-Object { $exclude -notcontains $_.ProcessName } | ForEach-Object {',
            '    try { [SysMemClean]::SetProcessWorkingSetSizeEx($_.Handle, [IntPtr]::new(-1), [IntPtr]::new(-1), 0) | Out-Null } catch { }',
            '}',
            'Write-Output "System memory cleaned"',
        ].join('\r\n');

        const tmpFile = path.join(
            app.getPath('temp'),
            `tirex_sysclean_${process.pid}_${Date.now()}.ps1`,
        );
        await fs.writeFile(tmpFile, scriptContent);

        return new Promise((resolve) => {
            runPowerShellFile(tmpFile, {}, (error, stdout, stderr) => {
                cleanupMemoryScript(tmpFile);
                if (error) {
                    console.log('[MemOpt] System clean error:', error.message);
                    resolve({ success: false, error: error.message });
                } else {
                    console.log('[MemOpt] System memory cleaned');
                    resolve({ success: true, message: 'System memory cleaned' });
                }
            });
        });
    } catch (error) {
        console.error('[MemOpt] Error cleaning system memory:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle("start-memory-services", async (event, config) => {
    try {
        const safeConfig = config && typeof config === "object" ? config : {};

        // Stop existing intervals and in-flight workers.
        stopMemoryServicesInternal();

        // Write periodic trim script to temp
        const trimScript = [
            'Add-Type -TypeDefinition @"',
            'using System;',
            'using System.Runtime.InteropServices;',
            'public class MT {',
            '    [DllImport("kernel32.dll")]',
            '    public static extern bool SetProcessWorkingSetSizeEx(IntPtr h, IntPtr min, IntPtr max, int f);',
            '}',
            '"@ -ErrorAction SilentlyContinue',
            'Get-Process -Name "RobloxPlayerBeta" -ErrorAction SilentlyContinue | ForEach-Object {',
            '    [MT]::SetProcessWorkingSetSizeEx($_.Handle, [IntPtr]::new(-1), [IntPtr]::new(-1), 0) | Out-Null',
            '}',
        ].join('\r\n');
        memoryTrimScriptFile = path.join(
            app.getPath('temp'),
            `tirex_periodic_trim_${process.pid}_${Date.now()}.ps1`,
        );
        await fs.writeFile(memoryTrimScriptFile, trimScript);

        // Write periodic system clean script to temp
        const sysCleanScript = [
            'Add-Type -TypeDefinition @"',
            'using System;',
            'using System.Runtime.InteropServices;',
            'public class SC {',
            '    [DllImport("kernel32.dll")]',
            '    public static extern bool SetProcessWorkingSetSizeEx(IntPtr h, IntPtr min, IntPtr max, int f);',
            '}',
            '"@ -ErrorAction SilentlyContinue',
            '$exclude = @("RobloxPlayerBeta","RobloxCrashHandler")',
            'Get-Process | Where-Object { $exclude -notcontains $_.ProcessName } | ForEach-Object {',
            '    try { [SC]::SetProcessWorkingSetSizeEx($_.Handle, [IntPtr]::new(-1), [IntPtr]::new(-1), 0) | Out-Null } catch { }',
            '}',
        ].join('\r\n');
        systemCleanerScriptFile = path.join(
            app.getPath('temp'),
            `tirex_periodic_sysclean_${process.pid}_${Date.now()}.ps1`,
        );
        await fs.writeFile(systemCleanerScriptFile, sysCleanScript);

        // Start memory trim interval
        if (safeConfig.memoryTrim && safeConfig.memoryTrimInterval > 0) {
            const trimIntervalSec = Number(safeConfig.memoryTrimInterval) || 0;
            const intervalMs = Math.max(5, Math.min(300, trimIntervalSec)) * 1000;
            console.log(`[MemOpt] Starting memory trim every ${intervalMs / 1000}s`);
            memoryTrimInterval = setInterval(() => {
                if (memoryTrimRunning) {
                    return;
                }
                memoryTrimRunning = true;
                memoryTrimProcess = runPowerShellFile(memoryTrimScriptFile, { timeout: 20000 }, (error) => {
                    memoryTrimRunning = false;
                    memoryTrimProcess = null;
                    if (isSpawnFailure(error)) {
                        console.error(`[MemOpt] Stopping memory trim service: ${error.message}`);
                        clearInterval(memoryTrimInterval);
                        memoryTrimInterval = null;
                    }
                });
                if (!memoryTrimProcess) {
                    memoryTrimRunning = false;
                }
            }, intervalMs);
        }

        // Start system memory cleaner interval
        if (safeConfig.systemMemoryCleaner && safeConfig.systemMemoryCleaner !== 'never') {
            const cleanIntervalSec = parseInt(safeConfig.systemMemoryCleaner, 10);
            if (cleanIntervalSec > 0) {
                const safeCleanerSec = Math.max(10, Math.min(3600, cleanIntervalSec));
                const intervalMs = safeCleanerSec * 1000;
                console.log(`[MemOpt] Starting system cleaner every ${safeCleanerSec}s`);
                systemCleanerInterval = setInterval(() => {
                    if (systemCleanerRunning) {
                        return;
                    }
                    systemCleanerRunning = true;
                    systemCleanerProcess = runPowerShellFile(systemCleanerScriptFile, { timeout: 45000 }, (error) => {
                        systemCleanerRunning = false;
                        systemCleanerProcess = null;
                        if (isSpawnFailure(error)) {
                            console.error(`[MemOpt] Stopping system cleaner service: ${error.message}`);
                            clearInterval(systemCleanerInterval);
                            systemCleanerInterval = null;
                        }
                    });
                    if (!systemCleanerProcess) {
                        systemCleanerRunning = false;
                    }
                }, intervalMs);
            }
        }

        // Close crash handler if enabled
        if (safeConfig.closeCrashHandler) {
            exec('taskkill /F /IM RobloxCrashHandler.exe /T', { windowsHide: true }, () => { });
        }

        return { success: true };
    } catch (error) {
        console.error('[MemOpt] Error starting services:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle("stop-memory-services", async () => {
    stopMemoryServicesInternal();
    console.log('[MemOpt] All memory services stopped');
    return { success: true };
});

let browserWindow = null;

ipcMain.handle("open-browser-electron", async (event, payload = {}) => {
    try {
        const browserSession = session.fromPartition("persist:roblox-browser");

        const url =
            typeof payload.url === "string" ? payload.url : "";
        const authCookies = extractRobloxAuthCookies(
            typeof payload.cookie === "string" ? payload.cookie : "",
            {
                ...(payload.authCookies && typeof payload.authCookies === "object"
                    ? payload.authCookies
                    : {}),
                cookie: typeof payload.cookie === "string" ? payload.cookie : "",
                rbxIdCheck:
                    typeof payload.rbxIdCheck === "string"
                        ? payload.rbxIdCheck
                        : "",
            },
        );
        authCookies.rbxIdCheck = await resolveGlobalRbxIdCheck(authCookies.rbxIdCheck);

        if (authCookies.cookie) {
            await applyRobloxSessionCookies(browserSession, authCookies);
        }

        if (browserWindow && !browserWindow.isDestroyed()) {
            browserWindow.focus();
            if (url) browserWindow.loadURL(url);
            return { success: true, message: "Browser focused and URL loaded" };
        }


        browserWindow = new BrowserWindow({
            width: 1200,
            height: 800,
            show: false,
            webPreferences: {
                partition: "persist:roblox-browser",
                nodeIntegration: false,
                contextIsolation: true,
                javascript: true,
                nativeWindowOpen: true,
                sandbox: true,
                spellcheck: true,
            },
            backgroundColor: "#232527",
            title: "Roblox Browser",
        });

        browserWindow.setMenuBarVisibility(false);
        browserWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
            if (targetUrl) {
                shell.openExternal(targetUrl);
            }
            return { action: "deny" };
        });

        browserWindow.webContents.on("did-finish-load", () => {
            browserWindow.show();
        });

        browserWindow.on("closed", () => {
            browserWindow = null;
        });

        await browserWindow.loadURL(url || "https://www.roblox.com");

        return { success: true };
    } catch (error) {
        console.error("[Browser] Error:", error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle("close-browser", async () => {
    if (browserWindow && !browserWindow.isDestroyed()) {
        browserWindow.close();
        browserWindow = null;
    }
    return { success: true };
});

let profileWindow = null;

ipcMain.handle("open-profile-electron", async (event, { userId }) => {
    try {
        if (!userId) {
            return { success: false, error: "No userId provided" };
        }

        if (profileWindow && !profileWindow.isDestroyed()) {
            profileWindow.focus();
            profileWindow.loadURL(
                `https://www.roblox.com/users/${userId}/profile`,
            );
            return { success: true, message: "Profile window already open" };
        }


        const profileSession = session.fromPartition("persist:roblox-profile");

        profileWindow = new BrowserWindow({
            width: 1200,
            height: 800,
            show: false,
            webPreferences: {
                partition: "persist:roblox-profile",
                nodeIntegration: false,
                contextIsolation: true,
                javascript: true,
            },
            backgroundColor: "#232527",
            title: "Roblox Profile",
        });

        profileWindow.setMenuBarVisibility(false);

        profileWindow.webContents.on("did-finish-load", () => {
            profileWindow.show();
        });

        profileWindow.on("closed", () => {
            profileWindow = null;
        });

        await profileWindow.loadURL(
            `https://www.roblox.com/users/${userId}/profile`,
        );

        return { success: true };
    } catch (error) {
        console.error("[Profile] Error:", error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle("close-profile", async () => {
    if (profileWindow && !profileWindow.isDestroyed()) {
        profileWindow.close();
        profileWindow = null;
    }
    return { success: true };
});

function buildAutoLoginScript(username, password) {
    const safeUsername = JSON.stringify(username || "");
    const safePassword = JSON.stringify(password || "");
    return `
(() => {
    const USERNAME = ${safeUsername};
    const PASSWORD = ${safePassword};

    const pick = (selectors) =>
        selectors.map((sel) => document.querySelector(sel)).find(Boolean);

    const setValue = (input, value) => {
        const descriptor = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
        );
        const setter = descriptor && descriptor.set ? descriptor.set : null;
        if (setter) {
            setter.call(input, value);
        } else {
            input.value = value;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const attempt = () => {
        const userInput = pick([
            "#login-username",
            "input[name='username']",
            "input[name='email']",
            "input[type='text']",
        ]);
        const passInput = pick([
            "#login-password",
            "input[name='password']",
            "input[type='password']",
        ]);
        if (!userInput || !passInput) return false;

        setValue(userInput, USERNAME);
        setValue(passInput, PASSWORD);

        const submitBtn = pick([
            "#login-button",
            "button[type='submit']",
            "button[data-testid='login-button']",
            "button[data-test='login-button']",
        ]);
        if (submitBtn) {
            submitBtn.click();
        } else if (passInput.form) {
            passInput.form.submit();
        } else {
            const form = userInput.closest("form");
            if (form) form.submit();
        }
        return true;
    };

    let tries = 0;
    const maxTries = 30;
    const timer = setInterval(() => {
        tries += 1;
        if (attempt() || tries >= maxTries) {
            clearInterval(timer);
        }
    }, 500);
})();
`;
}

async function tryAutoLogin(page, username, password) {
    if (!page || !username || !password) return;
    try {
        await page.evaluate(buildAutoLoginScript(username, password));
    } catch (error) {
        console.error("[Login] Auto-login failed:", error);
    }
}

function buildCodeLoginScript(code) {
    const safeCode = JSON.stringify(code || "");
    return `
(() => {
    const RAW_CODE = ${safeCode};
    const CODE = String(RAW_CODE || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6);
    const HAS_CODE = CODE.length > 0;

    const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.visibility === "hidden" || style.display === "none") {
            return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };

    const normalizeText = (value) =>
        String(value || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\\s+/g, " ")
            .trim();

    const setInputValue = (input, value) => {
        const descriptor = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
        );
        const setter = descriptor && descriptor.set ? descriptor.set : null;
        if (setter) {
            setter.call(input, value);
        } else {
            input.value = value;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const pickCodeInput = () => {
        const directSelectors = [
            "input[name='code']",
            "input[name='quickLoginCode']",
            "input[name='oneTimeCode']",
            "input[autocomplete='one-time-code']",
            "input[inputmode='numeric']",
            "input[type='tel']",
            "input[data-testid*='code']",
            "input[id*='code']",
        ];
        for (const selector of directSelectors) {
            const input = document.querySelector(selector);
            if (input && isVisible(input) && !input.disabled && !input.readOnly) {
                return input;
            }
        }

        const fallbackInputs = Array.from(document.querySelectorAll("input")).filter(
            (input) => isVisible(input) && !input.disabled && !input.readOnly,
        );
        const hinted = fallbackInputs.find((input) => {
            const hint = normalizeText(
                [
                    input.name,
                    input.id,
                    input.placeholder,
                    input.getAttribute("aria-label"),
                ].join(" "),
            );
            return /code|otp|quick|temporary|recovery|pin|signin/.test(hint);
        });
        if (hinted) return hinted;

        return (
            fallbackInputs.find((input) => {
                const maxLength = Number(input.maxLength || 0);
                return maxLength >= 4 && maxLength <= 12;
            }) || null
        );
    };

    const clickQuickSignInTrigger = () => {
        const candidates = Array.from(
            document.querySelectorAll("a, button, [role='button']"),
        ).filter(isVisible);
        const normalizedCandidates = candidates.map((el) => ({
            el,
            text: normalizeText(el.innerText || el.textContent || el.value),
        }));
        const priorityMatchers = [
            (text) => text.includes("quick sign in"),
            (text) => text.includes("quick login"),
            (text) => text.includes("another logged in device"),
            (text) => text.includes("logged in device"),
            (text) => text.includes("use code"),
            (text) => text.includes("temporary code"),
            (text) => text.includes("recovery code"),
            (text) => text.includes("one time code"),
            (text) => text.includes("email me a one time code"),
        ];

        let trigger = null;
        for (const matcher of priorityMatchers) {
            const match = normalizedCandidates.find((item) => matcher(item.text));
            if (match) {
                trigger = match.el;
                break;
            }
        }
        if (trigger) {
            trigger.click();
            return true;
        }
        return false;
    };

    const clickSubmitButton = () => {
        const candidates = Array.from(
            document.querySelectorAll("button, input[type='submit'], [role='button']"),
        ).filter(isVisible);
        const submit = candidates.find((el) => {
            const text = normalizeText(el.innerText || el.value || el.textContent);
            return (
                text.includes("sign in") ||
                text.includes("verify") ||
                text.includes("continue") ||
                text.includes("submit") ||
                text.includes("next") ||
                text.includes("confirm")
            );
        });
        if (submit) {
            submit.click();
            return true;
        }
        return false;
    };

    const submitCodeInput = (input) => {
        if (!input) return false;
        if (clickSubmitButton()) {
            return true;
        }

        const form = input.form;
        if (form && typeof form.requestSubmit === "function") {
            form.requestSubmit();
            return true;
        }

        input.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
            }),
        );
        input.dispatchEvent(
            new KeyboardEvent("keyup", {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
            }),
        );
        return true;
    };

    const captureQuickSignInCode = () => {
        const containers = Array.from(
            document.querySelectorAll("[role='dialog'], .modal-dialog, .modal"),
        ).filter(isVisible);
        for (const container of containers) {
            const text = normalizeText(container.innerText || container.textContent);
            if (!text.includes("quick sign in") && !text.includes("logged in device")) {
                continue;
            }

            const rawText = String(container.innerText || container.textContent || "");
            const matches = rawText.match(/\\b[A-Z0-9]{6}\\b/g) || [];
            const blacklist = new Set([
                "OPTION",
                "DEVICE",
                "CAMERA",
                "SIGNIN",
                "ROBLOX",
                "CODE",
                "CLOSE",
            ]);
            const candidate = matches.find(
                (value) => !blacklist.has(String(value || "").toUpperCase()),
            );
            if (candidate) {
                window.__TRX_QUICK_SIGN_IN_CODE = String(candidate).toUpperCase();
                return window.__TRX_QUICK_SIGN_IN_CODE;
            }
        }
        return "";
    };

    let hasSubmittedCode = false;
    let tries = 0;
    const maxTries = 140;
    const tryOpenCodeFlow = () => {
        const lastTriggerAt = Number(window.__TRX_LAST_QUICK_SIGNIN_TRIGGER_AT || 0);
        const now = Date.now();
        const triggerCooldown = HAS_CODE ? 2_000 : 4_000;
        if (now - lastTriggerAt < triggerCooldown) {
            return false;
        }

        const clicked = clickQuickSignInTrigger();
        if (clicked) {
            window.__TRX_LAST_QUICK_SIGNIN_TRIGGER_AT = now;
        }
        return clicked;
    };

    if (!pickCodeInput() && !captureQuickSignInCode()) {
        tryOpenCodeFlow();
    }

    const timer = setInterval(() => {
        tries += 1;
        const existingQuickCode = captureQuickSignInCode();
        const input = pickCodeInput();
        if (input && HAS_CODE && !hasSubmittedCode) {
            const maxLength = Number(input.maxLength || 0);
            const value = maxLength > 0 ? CODE.slice(0, maxLength) : CODE;
            setInputValue(input, value);
            submitCodeInput(input);
            hasSubmittedCode = true;
        } else if (!input && !existingQuickCode) {
            tryOpenCodeFlow();
        }

        if (tries >= maxTries) {
            clearInterval(timer);
        }
    }, 250);
})();
`;
}

async function tryCodeLogin(page, quickCode) {
    if (!page) return;
    try {
        await page.evaluate(buildCodeLoginScript(quickCode));
    } catch (error) {
        console.error("[Login] Code login automation failed:", error);
    }
}

function normalizeQuickSigninCode(code) {
    return String(code || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6);
}

function buildQuickSigninConfirmSubmitScript(code) {
    const safeCode = JSON.stringify(code || "");
    return `
(() => {
    const RAW_CODE = ${safeCode};
    const CODE = String(RAW_CODE || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6);

    const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.visibility === "hidden" || style.display === "none") {
            return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };

    const normalizeText = (value) =>
        String(value || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\\s+/g, " ")
            .trim();

    const setInputValue = (input, value) => {
        const descriptor = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
        );
        const setter = descriptor && descriptor.set ? descriptor.set : null;
        if (setter) {
            setter.call(input, value);
        } else {
            input.value = value;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const pickCodeInput = () => {
        const directSelectors = [
            "input[name='code']",
            "input[id*='code']",
            "input[autocomplete='one-time-code']",
            "input[inputmode='numeric']",
            "input[type='tel']",
        ];
        for (const selector of directSelectors) {
            const input = document.querySelector(selector);
            if (input && isVisible(input) && !input.disabled && !input.readOnly) {
                return input;
            }
        }

        const fallbackInputs = Array.from(document.querySelectorAll("input")).filter(
            (input) => isVisible(input) && !input.disabled && !input.readOnly,
        );
        const hinted = fallbackInputs.find((input) => {
            const hint = normalizeText(
                [
                    input.name,
                    input.id,
                    input.placeholder,
                    input.getAttribute("aria-label"),
                ].join(" "),
            );
            return /code|otp|quick|signin|login/.test(hint);
        });
        if (hinted) return hinted;

        return (
            fallbackInputs.find((input) => {
                const maxLength = Number(input.maxLength || 0);
                return maxLength >= 4 && maxLength <= 12;
            }) || null
        );
    };

    const findButtonByText = (patterns) => {
        const candidates = Array.from(
            document.querySelectorAll("button, input[type='submit'], [role='button'], a"),
        ).filter(isVisible);
        for (const candidate of candidates) {
            const text = normalizeText(
                candidate.innerText || candidate.textContent || candidate.value,
            );
            if (patterns.some((pattern) => pattern.test(text))) {
                return candidate;
            }
        }
        return null;
    };

    const input = pickCodeInput();
    if (input && CODE) {
        const maxLength = Number(input.maxLength || 0);
        const value = maxLength > 0 ? CODE.slice(0, maxLength) : CODE;
        setInputValue(input, value);

        const submitBtn = findButtonByText([
            /confirm/,
            /continue/,
            /submit/,
            /verify/,
            /enter/,
            /log in/,
            /sign in/,
        ]);
        if (submitBtn) {
            submitBtn.click();
            window.__TRX_QUICK_SIGNIN_CONFIRM_SUBMITTED_AT = Date.now();
            return { submitted: true, action: "enter_code_submitted" };
        }

        if (input.form) {
            input.form.submit();
            window.__TRX_QUICK_SIGNIN_CONFIRM_SUBMITTED_AT = Date.now();
            return { submitted: true, action: "enter_code_submitted" };
        }

        return { submitted: false, reason: "submit_not_found" };
    }

    const confirmLoginBtn = findButtonByText([
        /confirm login/,
        /^confirm$/,
        /please confirm this is you/,
    ]);
    if (confirmLoginBtn) {
        confirmLoginBtn.click();
        window.__TRX_QUICK_SIGNIN_CONFIRM_FINAL_AT = Date.now();
        return { submitted: true, action: "confirm_login_clicked" };
    }

    const triggerBtn = findButtonByText([
        /another logged in device/,
        /quick sign in/,
        /quick login/,
        /logged in device/,
    ]);
    if (triggerBtn) {
        triggerBtn.click();
        return { submitted: false, reason: "opened_quick_signin_form" };
    }

    return { submitted: false, reason: "code_input_not_found" };
})();
`;
}

async function readQuickSigninConfirmPageState(webContents) {
    return webContents.executeJavaScript(
        `(() => {
            const href = String(window.location.href || "");
            const rawText = String(
                document.body?.innerText || document.body?.textContent || "",
            );
            const text = rawText.toLowerCase().replace(/\\s+/g, " ").trim();

            const hasLoginFields = !!document.querySelector(
                "input[type='password'], input[name='password'], #login-password",
            );

            const visibleCodeInput = Array.from(document.querySelectorAll("input")).find(
                (input) => {
                    const style = window.getComputedStyle(input);
                    if (
                        !style ||
                        style.visibility === "hidden" ||
                        style.display === "none" ||
                        input.disabled ||
                        input.readOnly
                    ) {
                        return false;
                    }
                    const rect = input.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) return false;

                    const hint = String(
                        [
                            input.name,
                            input.id,
                            input.placeholder,
                            input.getAttribute("aria-label"),
                        ]
                            .filter(Boolean)
                            .join(" "),
                    ).toLowerCase();
                    const maxLength = Number(input.maxLength || 0);
                    return (
                        /code|otp|quick|signin|login/.test(hint) ||
                        (maxLength >= 4 && maxLength <= 12)
                    );
                },
            );

            const hasConfirmLoginButton = Array.from(
                document.querySelectorAll("button, [role='button'], input[type='submit']"),
            ).some((button) => {
                const style = window.getComputedStyle(button);
                if (
                    !style ||
                    style.visibility === "hidden" ||
                    style.display === "none" ||
                    button.disabled
                ) {
                    return false;
                }
                const rect = button.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                const value = String(
                    button.innerText || button.textContent || button.value || "",
                )
                    .toLowerCase()
                    .replace(/\\s+/g, " ")
                    .trim();
                return value === "confirm login" || value === "confirm";
            });

            let errorMessage = "";
            const errorPatterns = [
                /invalid\\s+code/i,
                /incorrect\\s+code/i,
                /code\\s+has\\s+expired/i,
                /expired\\s+code/i,
                /something\\s+went\\s+wrong/i,
                /log\\s*in\\s*failed/i,
                /not\\s+verified/i,
                /codeinvalid/i,
            ];
            for (const pattern of errorPatterns) {
                if (pattern.test(rawText)) {
                    errorMessage = rawText.match(pattern)?.[0] || "Invalid Quick Sign-in code";
                    break;
                }
            }

            const successHint = /code\\s+(accepted|confirmed|verified)|confirmation\\s+successful|successfully/i.test(
                rawText,
            );

            return {
                href,
                isConfirmRoute: /crossdevicelogin\\/confirmcode/i.test(href),
                isLoginRoute: /\\/newlogin|\\/login/i.test(href),
                hasLoginFields,
                hasCodeInput: !!visibleCodeInput,
                hasQuickTrigger: /another\\s+logged\\s+in\\s+device|quick\\s+sign\\s*-?in|quick\\s+log\\s*in/i.test(
                    text,
                ),
                hasConfirmLoginButton,
                errorMessage,
                successHint,
            };
        })()`,
        true,
    );
}

async function installQuickSigninLoginApiMonitor(webContents) {
    return webContents.executeJavaScript(
        `(() => {
            if (window.__TRX_QS_LOGIN_API_MONITOR_INSTALLED) {
                return true;
            }

            window.__TRX_QS_LOGIN_API_MONITOR_INSTALLED = true;
            window.__TRX_QS_LOGIN_API_RESPONSES = [];
            const targetPrefix = "/auth-token-service/v1/login/";
            const maxEntries = 80;

            const pushEntry = (entry) => {
                try {
                    const list = Array.isArray(window.__TRX_QS_LOGIN_API_RESPONSES)
                        ? window.__TRX_QS_LOGIN_API_RESPONSES
                        : [];
                    list.push({
                        ts: Date.now(),
                        ...entry,
                    });
                    if (list.length > maxEntries) {
                        list.shift();
                    }
                    window.__TRX_QS_LOGIN_API_RESPONSES = list;
                } catch (error) {
                    // Ignore monitor push errors.
                }
            };

            const normalizeUrl = (value) => {
                try {
                    return String(value || "");
                } catch (error) {
                    return "";
                }
            };

            const getEndpoint = (url) => {
                const normalized = normalizeUrl(url);
                const match = normalized.match(
                    /\\/auth-token-service\\/v1\\/login\\/([a-zA-Z0-9_-]+)/i,
                );
                return match && match[1] ? String(match[1]).toLowerCase() : "";
            };

            const isTargetUrl = (url) =>
                typeof url === "string" && url.includes(targetPrefix);

            const originalFetch = window.fetch;
            window.fetch = async (...args) => {
                const [input, init] = args;
                const url =
                    typeof input === "string"
                        ? input
                        : typeof input?.url === "string"
                            ? input.url
                            : "";
                const method = String(init?.method || "GET").toUpperCase();
                const body = init?.body;
                try {
                    const response = await originalFetch(...args);
                    if (isTargetUrl(url) && method === "POST") {
                        let responseText = "";
                        try {
                            responseText = await response.clone().text();
                        } catch (error) {
                            // Ignore body-read failures.
                        }
                        pushEntry({
                            transport: "fetch",
                            method,
                            url,
                            endpoint: getEndpoint(url),
                            body,
                            status: Number(response.status || 0),
                            responseText,
                        });
                    }
                    return response;
                } catch (error) {
                    if (isTargetUrl(url) && method === "POST") {
                        pushEntry({
                            transport: "fetch",
                            method,
                            url,
                            endpoint: getEndpoint(url),
                            body,
                            status: 0,
                            error: String(error?.message || error),
                        });
                    }
                    throw error;
                }
            };

            const OriginalXHR = window.XMLHttpRequest;
            function WrappedXHR() {
                const xhr = new OriginalXHR();
                let method = "GET";
                let url = "";
                let body = null;

                const originalOpen = xhr.open;
                xhr.open = function (m, u, ...rest) {
                    method = String(m || "GET").toUpperCase();
                    url = String(u || "");
                    return originalOpen.call(this, m, u, ...rest);
                };

                const originalSend = xhr.send;
                xhr.send = function (payload) {
                    body = payload;
                    xhr.addEventListener("loadend", () => {
                        if (!isTargetUrl(url) || method !== "POST") {
                            return;
                        }
                        let responseText = "";
                        try {
                            responseText = String(xhr.responseText || "");
                        } catch (error) {
                            // Ignore response read errors.
                        }
                        pushEntry({
                            transport: "xhr",
                            method,
                            url,
                            endpoint: getEndpoint(url),
                            body,
                            status: Number(xhr.status || 0),
                            responseText,
                        });
                    });
                    return originalSend.call(this, payload);
                };

                return xhr;
            }

            window.XMLHttpRequest = WrappedXHR;
            return true;
        })()`,
        true,
    );
}

function extractQuickSigninLoginEndpoint(entry) {
    const endpointFromEntry =
        typeof entry?.endpoint === "string" ? entry.endpoint : "";
    if (endpointFromEntry) {
        return endpointFromEntry.toLowerCase();
    }

    const url = typeof entry?.url === "string" ? entry.url : "";
    const match = url.match(/\/auth-token-service\/v1\/login\/([a-zA-Z0-9_-]+)/i);
    if (match && match[1]) {
        return String(match[1]).toLowerCase();
    }
    return "";
}

function mapQuickSigninLoginApiResponse(entry) {
    if (!entry || typeof entry !== "object") {
        return null;
    }

    const endpoint = extractQuickSigninLoginEndpoint(entry);
    if (!endpoint) {
        return null;
    }

    const status = Number(entry.status || 0);
    const body = String(entry.responseText || "").trim();
    const normalizedBody = body.replace(/^["']|["']$/g, "");
    const lowerBody = normalizedBody.toLowerCase();

    if (status >= 200 && status < 300) {
        if (endpoint === "entercode") {
            return {
                endpoint,
                state: "enter_code_accepted",
                message: "Quick Sign-in code accepted. Confirming login...",
            };
        }
        if (endpoint === "validatecode") {
            return {
                endpoint,
                state: "confirmed",
                message: "Quick Sign-in code confirmed.",
            };
        }
        return {
            endpoint,
            state: "success",
            message: `Quick Sign-in ${endpoint} succeeded.`,
        };
    }

    if (status === 400) {
        if (/codeinvalid/i.test(lowerBody)) {
            return {
                endpoint,
                state: "error",
                message: "Quick Sign-in failed: code invalid.",
            };
        }
        if (/codeexpired|expired/i.test(lowerBody)) {
            return {
                endpoint,
                state: "error",
                message: "Quick Sign-in failed: code expired.",
            };
        }
        return {
            endpoint,
            state: "error",
            message: `Quick Sign-in failed: ${normalizedBody || "bad request"}.`,
        };
    }

    if (status === 401 || status === 403) {
        return {
            endpoint,
            state: "error",
            message:
                "Quick Sign-in failed: cookie is invalid/expired or confirmation was blocked.",
        };
    }

    if (status >= 500) {
        return {
            endpoint,
            state: "error",
            message: "Quick Sign-in failed: Roblox service error, try again.",
        };
    }

    const errorText = String(entry.error || "").trim();
    if (errorText) {
        return {
            endpoint,
            state: "error",
            message: `Quick Sign-in failed: ${errorText}`,
        };
    }

    if (status > 0) {
        return {
            endpoint,
            state: "error",
            message: `Quick Sign-in failed (status ${status}).`,
        };
    }

    return null;
}

async function waitForQuickSigninLoginApiResponse(
    webContents,
    expectedEndpoints = [],
    timeoutMs = 15_000,
) {
    const deadline = Date.now() + timeoutMs;
    const targetEndpoints = new Set(
        (Array.isArray(expectedEndpoints) ? expectedEndpoints : [])
            .map((value) => String(value || "").toLowerCase())
            .filter(Boolean),
    );
    let cursor = 0;

    while (Date.now() < deadline) {
        if (!webContents || webContents.isDestroyed()) {
            return {
                state: "error",
                message: "Confirmation browser was closed before request finished.",
            };
        }

        let entries = [];
        try {
            entries = await webContents.executeJavaScript(
                `(() => {
                    const list = Array.isArray(window.__TRX_QS_LOGIN_API_RESPONSES)
                        ? window.__TRX_QS_LOGIN_API_RESPONSES
                        : [];
                    return list.slice();
                })()`,
                true,
            );
        } catch (error) {
            const message = error?.message || "";
            if (/Execution context|Cannot find context|destroyed/i.test(message)) {
                await delay(300);
                continue;
            }
            throw error;
        }

        if (!Array.isArray(entries)) {
            entries = [];
        }

        while (cursor < entries.length) {
            const entry = entries[cursor];
            cursor += 1;

            const mapped = mapQuickSigninLoginApiResponse(entry);
            if (!mapped) continue;

            if (
                targetEndpoints.size > 0 &&
                !targetEndpoints.has(String(mapped.endpoint || "").toLowerCase())
            ) {
                continue;
            }

            return mapped;
        }

        await delay(250);
    }

    return null;
}

async function submitQuickSigninConfirmCode(webContents, code) {
    const deadline = Date.now() + 30_000;
    let lastReason = "code_input_not_found";

    while (Date.now() < deadline) {
        if (!webContents || webContents.isDestroyed()) {
            return { success: false, error: "Confirmation browser was closed." };
        }

        let pageState;
        try {
            pageState = await readQuickSigninConfirmPageState(webContents);
        } catch (error) {
            const message = error?.message || "";
            if (/Execution context|Cannot find context|destroyed/i.test(message)) {
                await delay(350);
                continue;
            }
            throw error;
        }
        if (
            pageState.isLoginRoute &&
            !pageState.isConfirmRoute &&
            pageState.hasLoginFields
        ) {
            return {
                success: false,
                error: "Cookie is invalid or expired. Please paste an active .ROBLOSECURITY cookie.",
            };
        }

        let attempt = null;
        try {
            attempt = await webContents.executeJavaScript(
                buildQuickSigninConfirmSubmitScript(code),
                true,
            );
        } catch (error) {
            const message = error?.message || "";
            if (/Execution context|Cannot find context|destroyed/i.test(message)) {
                await delay(350);
                continue;
            }
            throw error;
        }
        if (attempt && attempt.submitted) {
            return {
                success: true,
                action:
                    typeof attempt.action === "string" && attempt.action
                        ? attempt.action
                        : "submitted",
            };
        }
        if (attempt && typeof attempt.reason === "string" && attempt.reason) {
            lastReason = attempt.reason;
        }

        await delay(450);
    }

    if (lastReason === "submit_not_found") {
        return { success: false, error: "Quick Sign-in form opened, but submit button was not found." };
    }
    return {
        success: false,
        error: "Failed to find Quick Sign-in code input on confirmation page.",
    };
}

async function clickQuickSigninFinalConfirmButton(webContents) {
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
        if (!webContents || webContents.isDestroyed()) {
            return {
                success: false,
                error: "Confirmation browser was closed before final confirm.",
            };
        }

        let pageState;
        try {
            pageState = await readQuickSigninConfirmPageState(webContents);
        } catch (error) {
            const message = error?.message || "";
            if (/Execution context|Cannot find context|destroyed/i.test(message)) {
                await delay(350);
                continue;
            }
            throw error;
        }

        if (
            pageState.isLoginRoute &&
            !pageState.isConfirmRoute &&
            pageState.hasLoginFields
        ) {
            return {
                success: false,
                error: "Cookie is invalid or expired. Please paste an active .ROBLOSECURITY cookie.",
            };
        }

        let attempt = null;
        try {
            attempt = await webContents.executeJavaScript(
                buildQuickSigninConfirmSubmitScript(""),
                true,
            );
        } catch (error) {
            const message = error?.message || "";
            if (/Execution context|Cannot find context|destroyed/i.test(message)) {
                await delay(350);
                continue;
            }
            throw error;
        }
        if (
            attempt &&
            attempt.submitted &&
            attempt.action === "confirm_login_clicked"
        ) {
            return { success: true };
        }

        if (pageState.errorMessage) {
            return {
                success: false,
                error: `Quick Sign-in rejected: ${pageState.errorMessage}`,
            };
        }

        await delay(400);
    }

    return {
        success: false,
        error: "Confirm Login button not found on Quick Sign-in confirmation page.",
    };
}

async function waitForQuickSigninConfirmResult(webContents) {
    const deadline = Date.now() + 12_000;

    while (Date.now() < deadline) {
        if (!webContents || webContents.isDestroyed()) {
            return {
                state: "error",
                message: "Confirmation browser was closed before status was detected.",
            };
        }

        let pageState;
        try {
            pageState = await readQuickSigninConfirmPageState(webContents);
        } catch (error) {
            const message = error?.message || "";
            if (/Execution context|Cannot find context|destroyed/i.test(message)) {
                await delay(400);
                continue;
            }
            throw error;
        }

        if (pageState.errorMessage) {
            return {
                state: "error",
                message: `Quick Sign-in rejected: ${pageState.errorMessage}`,
            };
        }

        if (
            pageState.isLoginRoute &&
            pageState.hasLoginFields &&
            !pageState.isConfirmRoute
        ) {
            return {
                state: "error",
                message:
                    "Cookie is invalid or expired. Please paste an active .ROBLOSECURITY cookie.",
            };
        }

        if (pageState.successHint || !pageState.isConfirmRoute) {
            return {
                state: "confirmed",
                message: "Quick Sign-in code confirmed.",
            };
        }

        await delay(700);
    }

    return {
        state: "submitted",
        message:
            "Quick Sign-in code submitted. If code is valid, login side should finish in a few seconds.",
    };
}

async function confirmQuickSigninCodeWithCookie(code, cookie, rbxIdCheck = "") {
    const normalizedCode = normalizeQuickSigninCode(code);
    if (!/^[A-Z0-9]{6}$/.test(normalizedCode)) {
        return { success: false, error: "Code must be 6 letters/numbers." };
    }

    const cleanCookie = normalizeCookie(cookie);
    const cleanRbxIdCheck = await resolveGlobalRbxIdCheck(rbxIdCheck);
    if (!cleanCookie) {
        return { success: false, error: "Missing .ROBLOSECURITY cookie." };
    }
    if (!cleanRbxIdCheck) {
        return { success: false, error: "Missing .RBXIDCHECK cookie." };
    }

    const confirmSession = session.fromPartition(QUICK_SIGNIN_CONFIRM_PARTITION);
    let confirmWindow = null;
    try {
        await applyRobloxSessionCookies(confirmSession, {
            cookie: cleanCookie,
            rbxIdCheck: cleanRbxIdCheck,
        });

        confirmWindow = new BrowserWindow({
            width: 500,
            height: 700,
            show: false,
            webPreferences: {
                partition: QUICK_SIGNIN_CONFIRM_PARTITION,
                nodeIntegration: false,
                contextIsolation: true,
                javascript: true,
                nativeWindowOpen: true,
                sandbox: true,
                spellcheck: true,
            },
            backgroundColor: "#232527",
            title: "Roblox Quick Sign-in Confirm",
        });
        confirmWindow.setMenuBarVisibility(false);

        await confirmWindow.loadURL(QUICK_SIGNIN_CONFIRM_URL);
        await installQuickSigninLoginApiMonitor(confirmWindow.webContents);

        const submitResult = await submitQuickSigninConfirmCode(
            confirmWindow.webContents,
            normalizedCode,
        );
        if (!submitResult.success) {
            return submitResult;
        }

        let validateResult = null;

        if (submitResult.action === "confirm_login_clicked") {
            validateResult = await waitForQuickSigninLoginApiResponse(
                confirmWindow.webContents,
                ["validatecode"],
                15_000,
            );
        } else {
            const enterResult = await waitForQuickSigninLoginApiResponse(
                confirmWindow.webContents,
                ["entercode"],
                15_000,
            );
            if (!enterResult) {
                return {
                    success: false,
                    error:
                        "No response detected for enterCode. Please retry with a fresh code.",
                };
            }
            if (enterResult.state === "error") {
                return { success: false, error: enterResult.message };
            }

            const finalConfirmResult = await clickQuickSigninFinalConfirmButton(
                confirmWindow.webContents,
            );
            if (!finalConfirmResult.success) {
                return finalConfirmResult;
            }

            validateResult = await waitForQuickSigninLoginApiResponse(
                confirmWindow.webContents,
                ["validatecode"],
                15_000,
            );
        }

        if (validateResult) {
            if (validateResult.state === "error") {
                return { success: false, error: validateResult.message };
            }
            if (validateResult.state === "confirmed") {
                return {
                    success: true,
                    state: "confirmed",
                    message: validateResult.message,
                };
            }
        }

        const result = await waitForQuickSigninConfirmResult(confirmWindow.webContents);
        if (result.state === "submitted") {
            return {
                success: false,
                error:
                    "No validateCode response detected from Roblox. Please retry with a fresh code.",
            };
        }
        if (result.state === "error") {
            return { success: false, error: result.message };
        }
        return { success: true, state: result.state, message: result.message };
    } finally {
        if (confirmWindow && !confirmWindow.isDestroyed()) {
            confirmWindow.close();
        }
        try {
            await confirmSession.clearStorageData({ storages: ["cookies"] });
        } catch (error) {
            // Ignore cleanup failures.
        }
    }
}

async function primeLoginArtifactsForCookie(cookie, rbxIdCheck) {
    const cleanCookie = normalizeCookie(cookie);
    const cleanRbxIdCheck = await resolveGlobalRbxIdCheck(rbxIdCheck);
    if (!cleanCookie || !cleanRbxIdCheck) {
        return { csrfToken: "", authTicket: "" };
    }

    let csrfToken = "";
    let authTicket = "";

    try {
        csrfToken = await getCSRFToken(cleanCookie, cleanRbxIdCheck, { forceRefresh: true });
    } catch (error) {
        console.warn("[Login] Failed to prefetch CSRF token:", error.message);
    }

    try {
        authTicket = await getAuthTicketWithRetry(cleanCookie, cleanRbxIdCheck);
    } catch (error) {
        console.warn(
            "[Login] Failed to prefetch authentication ticket:",
            error.message,
        );
    }

    return { csrfToken, authTicket };
}

function detachLoginCookieListener(loginSession) {
    if (!loginCookieChangeListener) return;
    try {
        loginSession.cookies.removeListener("changed", loginCookieChangeListener);
    } catch (error) {
        // Ignore listener cleanup errors.
    }
    loginCookieChangeListener = null;
}

function emitLoginQuickSigninStatus(payload = {}) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        mainWindow.webContents.send("quick-signin-status", {
            active: !!loginQuickSigninState.active,
            code: loginQuickSigninState.code || "",
            expiresAt: loginQuickSigninState.expiresAt || 0,
            sessionId: loginQuickSigninState.sessionId || 0,
            ...payload,
        });
    } catch (error) {
        // Ignore renderer send failures during reload.
    }
}

function clearLoginQuickCodeWatcher() {
    if (loginQuickCodeWatcher) {
        clearInterval(loginQuickCodeWatcher);
        loginQuickCodeWatcher = null;
    }
}

function clearLoginQuickCodeRefreshTimer() {
    if (loginQuickCodeRefreshTimer) {
        clearTimeout(loginQuickCodeRefreshTimer);
        loginQuickCodeRefreshTimer = null;
    }
}

function stopLoginQuickSigninSession(state = "idle", options = {}) {
    const shouldEmit = options.emit !== false;
    clearLoginQuickCodeWatcher();
    clearLoginQuickCodeRefreshTimer();
    activeLoginQuickSigninMode = false;

    loginQuickSigninState = {
        active: false,
        code: "",
        expiresAt: 0,
        sessionId: (loginQuickSigninState.sessionId || 0) + 1,
    };

    if (shouldEmit) {
        emitLoginQuickSigninStatus({
            active: false,
            state,
            code: "",
            expiresAt: 0,
        });
    }
}

function startLoginQuickSigninSession() {
    clearLoginQuickCodeRefreshTimer();
    activeLoginQuickSigninMode = true;
    loginQuickSigninState = {
        active: true,
        code: "",
        expiresAt: 0,
        sessionId: (loginQuickSigninState.sessionId || 0) + 1,
    };
    emitLoginQuickSigninStatus({
        active: true,
        state: "starting",
    });
}

function scheduleLoginQuickSigninRefresh(sessionId) {
    clearLoginQuickCodeRefreshTimer();
    if (!loginQuickSigninState.active) return;
    if (!loginQuickSigninState.expiresAt) return;

    const delayMs = Math.max(1500, loginQuickSigninState.expiresAt - Date.now());
    loginQuickCodeRefreshTimer = setTimeout(async () => {
        if (!loginQuickSigninState.active) return;
        if (sessionId !== loginQuickSigninState.sessionId) return;
        try {
            await refreshLoginQuickSigninCode("expired");
        } catch (error) {
            console.warn(
                "[Login] Failed to refresh Quick Sign-in code after expiry:",
                error.message,
            );
            emitLoginQuickSigninStatus({
                active: true,
                state: "error",
                error: error.message,
            });
        }
    }, delayMs);
}

function setLoginQuickSigninCode(code) {
    if (!loginQuickSigninState.active) return;
    const normalizedCode =
        typeof code === "string" ? code.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{6}$/.test(normalizedCode)) return;

    const now = Date.now();
    const isSameCode = normalizedCode === loginQuickSigninState.code;
    if (isSameCode && loginQuickSigninState.expiresAt - now > 15 * 1000) {
        return;
    }

    loginQuickSigninState.code = normalizedCode;
    loginQuickSigninState.expiresAt = now + QUICK_SIGNIN_CODE_TTL_MS;
    const sessionId = loginQuickSigninState.sessionId;

    emitLoginQuickSigninStatus({
        active: true,
        state: "awaiting_confirm",
        code: normalizedCode,
        expiresAt: loginQuickSigninState.expiresAt,
        ttlMs: QUICK_SIGNIN_CODE_TTL_MS,
    });
    scheduleLoginQuickSigninRefresh(sessionId);
}

async function refreshLoginQuickSigninCode(reason = "manual") {
    if (!loginQuickSigninState.active) {
        return { success: false, error: "Quick Sign-in session is not active." };
    }
    if (!loginBrowser) {
        return { success: false, error: "Login window is not open." };
    }

    const targetSessionId = loginQuickSigninState.sessionId;
    loginQuickSigninState.code = "";
    loginQuickSigninState.expiresAt = 0;
    clearLoginQuickCodeRefreshTimer();

    emitLoginQuickSigninStatus({
        active: true,
        state: "refreshing",
        reason,
    });

    if (loginPage) {
        const contexts = loginBrowser.contexts();
        if (contexts.length > 0) {
            await contexts[0].clearCookies();
        }

        // Wait for page to finish loading after navigation
        loginPage.once("load", () => {
            if (!loginBrowser || !loginPage) return;
            if (!loginQuickSigninState.active) return;
            if (targetSessionId !== loginQuickSigninState.sessionId) return;
            tryCodeLogin(loginPage, "");
        });
        await loginPage.goto("https://www.roblox.com/login");
    }

    return { success: true };
}

function startLoginQuickCodeWatcher(page) {
    clearLoginQuickCodeWatcher();
    if (!page) return;

    let busy = false;

    loginQuickCodeWatcher = setInterval(async () => {
        if (busy) return;
        if (!loginQuickSigninState.active) return;
        if (!page || !loginBrowser) {
            clearLoginQuickCodeWatcher();
            return;
        }

        busy = true;
        try {
            const code = await page.evaluate(
                `(() => {
                    const cached = String(window.__TRX_QUICK_SIGN_IN_CODE || "")
                        .trim()
                        .toUpperCase();
                    if (/^[A-Z0-9]{6}$/.test(cached)) return cached;

                    const containers = Array.from(
                        document.querySelectorAll("[role='dialog'], .modal-dialog, .modal"),
                    );
                    for (const container of containers) {
                        const style = window.getComputedStyle(container);
                        const rect = container.getBoundingClientRect();
                        if (
                            style.visibility === "hidden" ||
                            style.display === "none" ||
                            rect.width <= 0 ||
                            rect.height <= 0
                        ) {
                            continue;
                        }
                        const text = String(container.innerText || container.textContent || "");
                        if (!/quick\\s*sign\\s*[-\\s]?in|logged\\s*in\\s*device/i.test(text)) {
                            continue;
                        }
                        const matches = text.match(/\\b[A-Z0-9]{6}\\b/g) || [];
                        const candidate = matches.find((value) => /^[A-Z0-9]{6}$/.test(value));
                        if (candidate) {
                            const normalized = candidate.toUpperCase();
                            window.__TRX_QUICK_SIGN_IN_CODE = normalized;
                            return normalized;
                        }
                    }
                    return "";
                })()`
            );

            const normalizedCode =
                typeof code === "string" ? code.trim().toUpperCase() : "";
            if (normalizedCode && /^[A-Z0-9]{6}$/.test(normalizedCode)) {
                setLoginQuickSigninCode(normalizedCode);
            }
        } catch (error) {
            const message = error?.message || "";
            if (!/destroyed|Target closed|Execution context/i.test(message)) {
                console.warn("[Login] Quick Sign In code watcher error:", message);
            }
        } finally {
            busy = false;
        }
    }, 600);
}

ipcMain.handle("open-login-window", async (event, payload = {}) => {
    try {
        const loginMethod =
            typeof payload.loginMethod === "string"
                ? payload.loginMethod.toLowerCase()
                : "";
        const autoLogin = {
            username:
                typeof payload.username === "string" ? payload.username : "",
            password:
                typeof payload.password === "string" ? payload.password : "",
        };
        const quickCodeRaw =
            typeof payload.quickCode === "string"
                ? payload.quickCode
                : typeof payload.code === "string"
                    ? payload.code
                    : "";
        const quickCode = normalizeQuickSigninCode(quickCodeRaw);
        const shouldRunCodeLogin =
            loginMethod === "code" || (!!quickCode && !autoLogin.username);
        const isQuickSigninSession =
            shouldRunCodeLogin && quickCode.length === 0;
        const requestedLoginMethod = shouldRunCodeLogin
            ? "code"
            : autoLogin.username && autoLogin.password
                ? "auto"
                : "browser";
        const headlessCodeLogin =
            shouldRunCodeLogin && payload.headless !== false;
        loginWindowHeadlessMode = headlessCodeLogin;
        activeLoginCaptureMethod = requestedLoginMethod;
        activeLoginQuickSigninMode = isQuickSigninSession;

        let autoLoginQueued = !!(
            autoLogin.username && autoLogin.password
        );
        const codeLoginCode = shouldRunCodeLogin ? quickCode : "";
        const runAutoLogin = (contents) => {
            if (!autoLoginQueued) return;
            autoLoginQueued = false;
            const username = autoLogin.username;
            const password = autoLogin.password;
            autoLogin.username = "";
            autoLogin.password = "";
            tryAutoLogin(contents, username, password);
        };
        const runCodeLogin = (contents) => {
            if (!shouldRunCodeLogin) return;
            tryCodeLogin(contents, codeLoginCode);
        };
        const runLoginAutomation = (page) => {
            runAutoLogin(page);
            runCodeLogin(page);
        };

        if (loginBrowser) {
            // Already open, just navigate and apply
            const contexts = loginBrowser.contexts();
            if (contexts.length > 0) {
                await contexts[0].clearCookies();
            }
            if (isQuickSigninSession && loginPage) {
                startLoginQuickSigninSession();
                startLoginQuickCodeWatcher(loginPage);
            } else {
                stopLoginQuickSigninSession("inactive");
            }
            if ((autoLoginQueued || shouldRunCodeLogin) && loginPage) {
                loginPage.removeAllListeners("load");
                loginPage.once("load", () => {
                    if (loginPage) runLoginAutomation(loginPage);
                });
                await loginPage.goto("https://www.roblox.com/login");
            }
            return { success: true, message: "Login window already open" };
        }

        // --- NEW PATCHRIGHT IMPLEMENTATION ---

        const getLocalAppData = () => new Promise((resolve) => {
            exec('echo %LOCALAPPDATA%', (err, stdout) => {
                resolve(stdout ? stdout.trim() : process.env.LOCALAPPDATA);
            });
        });
        const localAppDataStr = await getLocalAppData();

        const chromePaths = [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            localAppDataStr + "\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
        ];
        
        let executablePath = undefined;
        for (const p of chromePaths) {
            if (fsSync.existsSync(p)) {
                executablePath = p;
                break;
            }
        }

        loginBrowser = await chromium.launch({
            executablePath: executablePath,
            headless: headlessCodeLogin,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--start-maximized',
            ],
            ignoreDefaultArgs: ['--enable-automation'],
        });

        const context = await loginBrowser.newContext({
            viewport: null // match window size
        });
        loginPage = await context.newPage();

        let lastCapturedAuthKey = "";
        let cookieDebounceTimer = null;
        if (loginCookiePollInterval) clearInterval(loginCookiePollInterval);

        // Periodically poll patchright context cookies
        loginCookiePollInterval = setInterval(async () => {
            if (!context || !loginBrowser) return;

            try {
                const cookies = await context.cookies();

                let roblosecurityCookie = "";
                let rbxIdCheck = "";

                for (const c of cookies) {
                    const nameUpper = c.name.toUpperCase();
                    if (nameUpper.includes("ROBLOSECURITY")) {
                        roblosecurityCookie = normalizeCookie(c.value);
                    }
                    if (nameUpper.includes("RBXIDCHECK")) {
                        rbxIdCheck = normalizeRbxIdCheck(c.value);
                    }
                }

                if (roblosecurityCookie) {
                    const authKey = `${roblosecurityCookie}:${rbxIdCheck}`;
                    if (authKey === lastCapturedAuthKey) {
                        return;
                    }

                    if (cookieDebounceTimer) clearTimeout(cookieDebounceTimer);
                    cookieDebounceTimer = setTimeout(async () => {
                        const previousAuthKey = lastCapturedAuthKey;
                        lastCapturedAuthKey = authKey;

                        const accountInfo = await validateCookie(
                            roblosecurityCookie,
                            rbxIdCheck,
                        );

                        if (
                            accountInfo.valid &&
                            mainWindow &&
                            !mainWindow.isDestroyed()
                        ) {
                            if (activeLoginQuickSigninMode) {
                                stopLoginQuickSigninSession("confirmed");
                            }
                            const artifacts = await primeLoginArtifactsForCookie(
                                roblosecurityCookie,
                                rbxIdCheck,
                            );

                            mainWindow.webContents.send("cookie-captured", {
                                cookie: roblosecurityCookie,
                                rbxIdCheck,
                                username: accountInfo.username,
                                userId: accountInfo.userId,
                                displayName: accountInfo.displayName,
                                csrfToken: artifacts.csrfToken,
                                authTicket: artifacts.authTicket,
                                loginMethod: activeLoginCaptureMethod,
                            });
                        } else {
                            lastCapturedAuthKey = previousAuthKey;
                        }
                    }, 350);
                }
            } catch (error) {
                const msg = error?.message || "";
                if (!/Target closed|Browser has been closed/i.test(msg)) {
                    console.error("[Login] Cookie monitor error:", error);
                }
            }
        }, 1200);

        if (isQuickSigninSession) {
            startLoginQuickSigninSession();
            startLoginQuickCodeWatcher(loginPage);
        } else {
            stopLoginQuickSigninSession("inactive");
        }

        loginBrowser.on("disconnected", () => {
            if (loginCookiePollInterval) {
                clearInterval(loginCookiePollInterval);
                loginCookiePollInterval = null;
            }
            if (cookieDebounceTimer) {
                clearTimeout(cookieDebounceTimer);
                cookieDebounceTimer = null;
            }
            stopLoginQuickSigninSession("closed");
            loginWindowHeadlessMode = false;
            loginBrowser = null;
            loginPage = null;
        });

        loginPage.removeAllListeners("load");
        loginPage.once("load", () => {
            if (loginPage) runLoginAutomation(loginPage);
        });
        await loginPage.goto("https://www.roblox.com/login");

        return { success: true };
    } catch (error) {
        console.error("[Login] Error:", error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle("close-login-window", async () => {
    stopLoginQuickSigninSession("closed");
    activeLoginCaptureMethod = "browser";
    activeLoginQuickSigninMode = false;
    loginWindowHeadlessMode = false;

    if (loginCookiePollInterval) {
        clearInterval(loginCookiePollInterval);
        loginCookiePollInterval = null;
    }
    if (loginBrowser) {
        try {
            await loginBrowser.close();
        } catch (e) {
            // Ignore close errors
        }
        loginBrowser = null;
        loginPage = null;
    }
    return { success: true };
});

ipcMain.handle("refresh-quick-signin-code", async () => {
    try {
        return await refreshLoginQuickSigninCode("manual");
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle("confirm-quick-signin-code", async (event, payload = {}) => {
    try {
        const code =
            typeof payload.code === "string" ? payload.code.trim() : "";
        const cookie =
            typeof payload.cookie === "string" ? payload.cookie : "";
        const rbxIdCheck =
            typeof payload.rbxIdCheck === "string" ? payload.rbxIdCheck : "";
        return await confirmQuickSigninCodeWithCookie(
            code,
            cookie,
            rbxIdCheck,
        );
    } catch (error) {
        return { success: false, error: error.message };
    }
});

function getAuthLockKey(cookie, rbxIdCheck = "") {
    const cleanCookie = normalizeCookie(cookie);
    const cleanRbxIdCheck = normalizeRbxIdCheck(rbxIdCheck || "");
    return cleanRbxIdCheck ? `${cleanCookie}:${cleanRbxIdCheck}` : cleanCookie;
}

function enqueueAuthTask(lockMap, key, task) {
    const previous = lockMap.get(key) || Promise.resolve();
    const runTask = previous.catch(() => { }).then(task);
    const tail = runTask.catch(() => { });
    lockMap.set(key, tail);
    tail.finally(() => {
        if (lockMap.get(key) === tail) {
            lockMap.delete(key);
        }
    });
    return runTask;
}

function getHeaderString(headerValue) {
    if (Array.isArray(headerValue)) {
        return typeof headerValue[0] === "string" ? headerValue[0] : "";
    }
    return typeof headerValue === "string" ? headerValue : "";
}

function getRetryAfterMs(headerValue) {
    const rawValue = getHeaderString(headerValue).trim();
    if (!rawValue) return 0;

    const seconds = Number(rawValue);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, 10000);
    }

    const retryAt = Date.parse(rawValue);
    if (Number.isNaN(retryAt)) return 0;
    return Math.max(0, Math.min(retryAt - Date.now(), 10000));
}

function createAuthStatusError(kind, response = {}, detail = "") {
    const statusCode = response.statusCode || 0;
    const suffix = detail ? ` ${detail}` : "";
    const error = new Error(`Failed to get ${kind}. Status: ${statusCode || "unknown"}.${suffix}`);
    error.statusCode = statusCode;
    error.retryAfterMs = response.retryAfterMs || 0;
    return error;
}

function createUnauthorizedTicketError(response = {}, triedCookieOnly = false) {
    const detail = triedCookieOnly
        ? "Roblox rejected this .ROBLOSECURITY cookie. Refresh/re-login this account."
        : "Roblox rejected the cookie bundle. Retrying without .RBXIDCHECK may be required.";
    return createAuthStatusError("Ticket", response, detail);
}

function httpsRequestWithTimeout(options, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, resolve);
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timeout after ${timeoutMs}ms: ${options.hostname}${options.path}`));
        });
        req.on('error', reject);
        req.end();
    });
}

function requestCsrfTokenFromLogout(cleanCookie, rbxIdCheck) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: "auth.roblox.com",
            path: "/v2/logout",
            method: "POST",
            headers: {
                Cookie: formatRobloxCookieHeader(cleanCookie, rbxIdCheck),
                Referer: "https://www.roblox.com/",
                Origin: "https://www.roblox.com",
                Accept: "application/json, text/plain, */*",
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Content-Type": "application/json;charset=UTF-8",
                "Content-Length": "0",
            },
        };

        const req = https.request(options, (res) => {
            res.resume();
            resolve({
                statusCode: res.statusCode || 0,
                csrfToken: getHeaderString(res.headers["x-csrf-token"]),
                retryAfterMs: getRetryAfterMs(res.headers["retry-after"]),
            });
        });

        req.setTimeout(12000, () => {
            req.destroy(new Error("CSRF request timeout (12s)"));
        });
        req.on("error", reject);
        req.end();
    });
}

function requestAuthTicketResponseByPath(
    cleanCookie,
    rbxIdCheck,
    csrfToken = "",
    requestPath = "/v1/authentication-ticket/",
) {
    return new Promise((resolve, reject) => {
        const headers = {
            Cookie: formatRobloxCookieHeader(cleanCookie, rbxIdCheck),
            Referer: "https://www.roblox.com/",
            Origin: "https://www.roblox.com",
            Accept: "application/json, text/plain, */*",
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Content-Type": "application/json;charset=UTF-8",
            "Content-Length": "0",
        };
        if (csrfToken) {
            headers["X-CSRF-TOKEN"] = csrfToken;
        }

        const options = {
            hostname: "auth.roblox.com",
            path: requestPath,
            method: "POST",
            headers,
        };

        const req = https.request(options, (res) => {
            res.resume();
            resolve({
                statusCode: res.statusCode || 0,
                csrfToken: getHeaderString(res.headers["x-csrf-token"]),
                ticket: getHeaderString(res.headers["rbx-authentication-ticket"]),
                retryAfterMs: getRetryAfterMs(res.headers["retry-after"]),
            });
        });

        req.setTimeout(12000, () => {
            req.destroy(new Error("Auth ticket request timeout (12s)"));
        });

        req.on("error", reject);
        req.end();
    });
}

async function requestAuthTicketResponse(cleanCookie, rbxIdCheck, csrfToken = "") {
    const candidatePaths = [
        "/v1/authentication-ticket/",
        "/v1/authentication-ticket",
    ];
    let lastResponse = { statusCode: 0, csrfToken: "", ticket: "", retryAfterMs: 0 };

    for (const requestPath of candidatePaths) {
        const response = await requestAuthTicketResponseByPath(
            cleanCookie,
            rbxIdCheck,
            csrfToken,
            requestPath,
        );
        lastResponse = response;

        if (response.ticket || response.statusCode !== 404) {
            return response;
        }
    }

    return lastResponse;
}

async function getCSRFToken(cookie, rbxIdCheck, options = {}) {
    const cleanCookie = normalizeCookie(cookie);
    const cleanRbxIdCheck =
        options.useGlobalRbxIdCheck === false
            ? normalizeRbxIdCheck(rbxIdCheck || "")
            : await resolveGlobalRbxIdCheck(rbxIdCheck || "");
    if (!cleanCookie) {
        throw new Error("Missing .ROBLOSECURITY cookie");
    }

    const lockKey = getAuthLockKey(cleanCookie, cleanRbxIdCheck);
    return await enqueueAuthTask(csrfTokenFetchLocks, lockKey, async () => {
        const logoutResponse = await requestCsrfTokenFromLogout(
            cleanCookie,
            cleanRbxIdCheck,
        );
        if (logoutResponse.csrfToken) {
            return logoutResponse.csrfToken;
        }

        const authTicketResponse = await requestAuthTicketResponse(
            cleanCookie,
            cleanRbxIdCheck,
            "",
        );
        if (authTicketResponse.csrfToken) {
            return authTicketResponse.csrfToken;
        }

        throw createAuthStatusError("CSRF", {
            statusCode: authTicketResponse.statusCode || logoutResponse.statusCode,
            retryAfterMs:
                authTicketResponse.retryAfterMs || logoutResponse.retryAfterMs || 0,
        });
    });
}

async function getAuthTicketForCookieBundle(cleanCookie, cleanRbxIdCheck) {
    const normalizedCookie = normalizeCookie(cleanCookie);
    const normalizedRbxIdCheck = normalizeRbxIdCheck(cleanRbxIdCheck || "");
    const response = await requestAuthTicketResponse(
        normalizedCookie,
        normalizedRbxIdCheck,
        "",
    );
    if (response.ticket) {
        return response.ticket;
    }

    if (response.statusCode === 401 || response.statusCode === 403) {
        const retryToken =
            response.csrfToken
                ? response.csrfToken
                : await getCSRFToken(normalizedCookie, normalizedRbxIdCheck, {
                    forceRefresh: true,
                    useGlobalRbxIdCheck: !!normalizedRbxIdCheck,
                });
        const retryResponse = await requestAuthTicketResponse(
            normalizedCookie,
            normalizedRbxIdCheck,
            retryToken,
        );
        if (retryResponse.ticket) {
            return retryResponse.ticket;
        }

        if (
            (retryResponse.statusCode === 401 || retryResponse.statusCode === 403) &&
            retryResponse.csrfToken &&
            retryResponse.csrfToken !== retryToken
        ) {
            const finalResponse = await requestAuthTicketResponse(
                normalizedCookie,
                normalizedRbxIdCheck,
                retryResponse.csrfToken,
            );
            if (finalResponse.ticket) {
                return finalResponse.ticket;
            }
            throw createAuthStatusError("Ticket", finalResponse);
        }

        throw createAuthStatusError("Ticket", retryResponse);
    }

    throw createAuthStatusError("Ticket", response);
}

async function getAuthTicket(cookie, rbxIdCheck) {
    const cleanCookie = normalizeCookie(cookie);
    const cleanRbxIdCheck = await resolveGlobalRbxIdCheck(rbxIdCheck || "");
    if (!cleanCookie) {
        throw new Error("Missing .ROBLOSECURITY cookie");
    }

    const candidates = [];
    if (cleanRbxIdCheck) {
        candidates.push(cleanRbxIdCheck);
    }
    candidates.push("");

    let lastError = null;
    let triedCookieOnly = false;

    for (const checkerCandidate of candidates) {
        triedCookieOnly = !checkerCandidate;
        try {
            return await getAuthTicketForCookieBundle(cleanCookie, checkerCandidate);
        } catch (error) {
            lastError = error;
            const statusCode = getStatusCodeFromAuthError(error);
            const canTryCookieOnly =
                (statusCode === 401 || statusCode === 403) &&
                !!checkerCandidate &&
                candidates.includes("");

            if (!canTryCookieOnly) {
                break;
            }

            console.warn(
                `[AuthTicket] Cookie bundle was rejected with ${statusCode}; retrying with .ROBLOSECURITY only.`,
            );
        }
    }

    const finalStatus = getStatusCodeFromAuthError(lastError);
    if (finalStatus === 401 || finalStatus === 403) {
        throw createUnauthorizedTicketError(lastError, triedCookieOnly);
    }

    throw lastError || new Error("Failed to get authentication ticket.");
}

function parseStatusCodeFromErrorMessage(message) {
    if (typeof message !== "string") return null;
    const match = message.match(/Status:\s*(\d{3})/i);
    if (!match || !match[1]) return null;
    const code = parseInt(match[1], 10);
    return Number.isNaN(code) ? null : code;
}

function getStatusCodeFromAuthError(error) {
    if (Number.isInteger(error?.statusCode)) {
        return error.statusCode;
    }
    return parseStatusCodeFromErrorMessage(error?.message || "");
}

function isRetryableAuthTicketError(error) {
    const message = error?.message || "";
    if (
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timeout/i.test(
            message,
        )
    ) {
        return true;
    }

    const statusCode = getStatusCodeFromAuthError(error);
    if (!statusCode) return false;
    return statusCode === 429 || statusCode >= 500;
}

async function getAuthTicketWithRetryUnlocked(cookie, rbxIdCheck) {
    let lastError = null;

    for (let attempt = 1; attempt <= AUTH_TICKET_MAX_RETRIES; attempt++) {
        try {
            return await getAuthTicket(cookie, rbxIdCheck);
        } catch (error) {
            lastError = error;
            const retryable = isRetryableAuthTicketError(error);
            if (!retryable || attempt >= AUTH_TICKET_MAX_RETRIES) {
                break;
            }

            const retryAfterMs =
                Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0
                    ? error.retryAfterMs
                    : 0;
            const waitMs =
                retryAfterMs ||
                attempt * AUTH_TICKET_RETRY_BASE_DELAY_MS +
                Math.floor(Math.random() * 250);
            console.warn(
                `[AuthTicket] Attempt ${attempt}/${AUTH_TICKET_MAX_RETRIES} failed: ${error.message}. Retrying in ${waitMs}ms...`,
            );
            await delay(waitMs);
        }
    }

    throw lastError || new Error("Failed to get authentication ticket.");
}

async function getAuthTicketWithRetry(cookie, rbxIdCheck) {
    const cleanCookie = normalizeCookie(cookie);
    const cleanRbxIdCheck = await resolveGlobalRbxIdCheck(rbxIdCheck || "");
    if (!cleanCookie) {
        throw new Error("Missing .ROBLOSECURITY cookie");
    }

    const lockKey = getAuthLockKey(cleanCookie, cleanRbxIdCheck);
    return await enqueueAuthTask(
        authTicketRequestLocks,
        lockKey,
        () => getAuthTicketWithRetryUnlocked(cleanCookie, cleanRbxIdCheck),
    );
}

async function validateCookie(cookie, rbxIdCheck) {
    const cleanCookie = normalizeCookie(cookie);
    const cleanRbxIdCheck = await resolveGlobalRbxIdCheck(rbxIdCheck || "");
    if (!cleanCookie) {
        return { valid: false };
    }

    return new Promise((resolve, reject) => {
        const options = {
            hostname: "users.roblox.com",
            path: "/v1/users/authenticated",
            method: "GET",
            headers: {
                Cookie: formatRobloxCookieHeader(cleanCookie, cleanRbxIdCheck),
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
        };

        const req = https.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    if (res.statusCode === 200) {
                        const json = JSON.parse(data);
                        resolve({
                            valid: true,
                            username: json.name,
                            userId: json.id,
                            displayName: json.displayName,
                        });
                    } else {
                        resolve({ valid: false });
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.setTimeout(10000, () => {
            req.destroy(new Error("Cookie validation timeout (10s)"));
        });

        req.on("error", reject);
        req.end();
    });
}

function requestRobloxPresence(cleanCookie, userId, csrfToken) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            userIds: [Number(userId)],
        });

        const options = {
            hostname: "presence.roblox.com",
            path: "/v1/presence/users",
            method: "POST",
            headers: {
                Cookie: `.ROBLOSECURITY=${cleanCookie}`,
                "X-CSRF-TOKEN": csrfToken,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
        };

        const req = https.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(data || "{}");
                    if (res.statusCode !== 200) {
                        return reject(
                            new Error(
                                parsed?.errors?.[0]?.message ||
                                `Presence request failed (${res.statusCode})`,
                            ),
                        );
                    }
                    resolve(parsed);
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

async function persistLastSession({
    placeId,
    gameId,
    userId = null,
    username = null,
}) {
    const settings = await loadSettings();
    settings.lastSession = {
        placeId: placeId ? String(placeId) : null,
        gameId: gameId ? String(gameId) : null,
        userId: userId != null ? Number(userId) : null,
        username: username || null,
        updatedAt: Date.now(),
    };
    await saveSettings(settings);
    return settings.lastSession;
}

async function refreshLastSessionFromPresence(cookie, fallback = {}) {
    const cleanCookie = normalizeCookie(cookie);
    if (!cleanCookie) {
        throw new Error("Missing or invalid cookie");
    }

    const account = await validateCookie(cleanCookie);
    if (!account?.valid || !account.userId) {
        throw new Error("Cookie is invalid or expired");
    }

    const csrfToken = await getCSRFToken(cleanCookie);
    const presencePayload = await requestRobloxPresence(
        cleanCookie,
        account.userId,
        csrfToken,
    );
    const userPresence = Array.isArray(presencePayload?.userPresences)
        ? presencePayload.userPresences[0]
        : null;

    const placeId =
        userPresence?.placeId ||
        fallback.placeId ||
        null;
    const gameId =
        userPresence?.gameId ||
        fallback.jobId ||
        fallback.gameId ||
        null;

    if (!placeId || !gameId) {
        throw new Error("No active session found for this account");
    }

    const session = await persistLastSession({
        placeId,
        gameId,
        userId: account.userId,
        username: account.username || fallback.username || null,
    });

    return {
        session,
        presence: userPresence,
        csrfToken,
        account,
    };
}

function resolveShareUrl(url, attempt = 0) {
    console.log(`[ShareURL] Resolving URL (Attempt ${attempt}):`, url);
    if (attempt > 5) {
        console.log(`[ShareURL] Max redirects reached for: ${url}`);
        return Promise.resolve(url);
    }

    return new Promise((resolve, reject) => {
        // Basic validation
        if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
            return resolve(url);
        }

        const options = {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }
        };

        const lib = url.startsWith("https:") ? https : require('http');

        const req = lib.request(url, options, (res) => {
            console.log(`[ShareURL] Status: ${res.statusCode}`);
            console.log(`[ShareURL] Location: ${res.headers.location}`);

            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // Handle relative redirects if any (though unlikely for share links)
                let redirectUrl = res.headers.location;
                if (redirectUrl.startsWith("/")) {
                    const u = new URL(url);
                    redirectUrl = `${u.protocol}//${u.host}${redirectUrl}`;
                }

                resolveShareUrl(redirectUrl, attempt + 1).then(resolve).catch(resolve);
            } else if (res.statusCode === 200) {
                const contentType = String(res.headers["content-type"] || "");
                const shouldParseHtml = contentType.includes("text/html");

                if (!shouldParseHtml) {
                    resolve(url);
                    return;
                }

                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    // Extract Place ID from meta tag
                    // <meta name="roblox:start_place_id" content="103754275310547">
                    const placeIdMatch = data.match(/name="roblox:start_place_id"\s+content="(\d+)"/i);

                    if (placeIdMatch) {
                        const placeId = placeIdMatch[1];
                        console.log(`[ShareURL] Found Place ID in HTML: ${placeId}`);

                        // Construct a fake game URL that fetchGameInfo can understand
                        const constructedUrl = `https://www.roblox.com/games/${placeId}/`;
                        resolve(constructedUrl);
                    } else {
                        console.log("[ShareURL] No Place ID found in body, returning URL as is");
                        resolve(url);
                    }
                });
            } else {
                resolve(url);
            }
        });

        req.on("error", (err) => {
            console.error("[ShareURL] Error resolving:", err);
            resolve(url);
        });
        req.end();
    });
}

function parseShareLinkInput(input) {
    if (!input || typeof input !== "string") return null;
    try {
        const parsed = new URL(input);
        const code = parsed.searchParams.get("code");
        const type = parsed.searchParams.get("type");
        if (code) {
            return {
                code: code.trim(),
                type: (type || "Server").trim(),
            };
        }
    } catch (e) {
        // Not a URL
    }
    return null;
}

function fetchShareLinkInfoFromUrl(url, attempt = 0) {
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
        return Promise.resolve(null);
    }
    if (attempt > 5) {
        return Promise.resolve(null);
    }

    const parsedInfo = parseShareLinkInput(url);
    if (parsedInfo) return Promise.resolve(parsedInfo);

    return new Promise((resolve) => {
        const options = {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }
        };

        const lib = url.startsWith("https:") ? https : require("http");
        const req = lib.request(url, options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let redirectUrl = res.headers.location;
                if (redirectUrl.startsWith("/")) {
                    try {
                        const u = new URL(url);
                        redirectUrl = `${u.protocol}//${u.host}${redirectUrl}`;
                    } catch (e) {
                        resolve(null);
                        return;
                    }
                }
                fetchShareLinkInfoFromUrl(redirectUrl, attempt + 1).then(resolve);
                return;
            }

            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                const codeMatch = data.match(/data-link-id=\"([^\"]+)\"/i);
                const typeMatch = data.match(/data-link-type=\"([^\"]+)\"/i);
                if (codeMatch) {
                    resolve({
                        code: codeMatch[1],
                        type: typeMatch ? typeMatch[1] : "Server",
                    });
                    return;
                }
                resolve(null);
            });
        });

        req.on("error", () => resolve(null));
        req.end();
    });
}

async function resolveShareLinkData(input, linkType, cookie) {
    try {
        const cleanCookie = normalizeCookie(cookie);
        if (!cleanCookie) {
            return { success: false, error: "Cookie is required to resolve share link." };
        }

        const rawInput = typeof input === "string" ? input.trim() : "";
        let info = parseShareLinkInput(rawInput);
        const isUrlInput = rawInput.startsWith("http");

        if (!info && isUrlInput) {
            info = await fetchShareLinkInfoFromUrl(rawInput);
        }

        if (!info && isUrlInput) {
            return { success: false, error: "Share link code not found." };
        }

        const linkId = (info && info.code) ? info.code : rawInput;
        const resolvedType = (linkType || (info && info.type) || "Server").trim();

        if (!linkId) {
            return { success: false, error: "Share link code not found." };
        }

        if (resolvedType.toLowerCase() !== "server") {
            return { success: false, error: `Unsupported share link type: ${resolvedType}` };
        }

        const csrfToken = await getCSRFToken(cleanCookie);
        const payload = JSON.stringify({
            linkId: linkId,
            linkType: resolvedType,
        });

        const data = await new Promise((resolve, reject) => {
            const options = {
                hostname: "apis.roblox.com",
                path: "/sharelinks/v1/resolve-link",
                method: "POST",
                headers: {
                    Cookie: `.ROBLOSECURITY=${cleanCookie}`,
                    "X-CSRF-TOKEN": csrfToken,
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                    Referer: "https://www.roblox.com/",
                    Origin: "https://www.roblox.com",
                },
            };

            const req = https.request(options, (res) => {
                let body = "";
                res.on("data", (chunk) => (body += chunk));
                res.on("end", () => {
                    try {
                        const json = JSON.parse(body || "{}");
                        if (json.errors && json.errors.length > 0) {
                            const message = json.errors[0].message || "Failed to resolve share link";
                            reject(new Error(message));
                            return;
                        }
                        resolve(json);
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on("error", reject);
            req.write(payload);
            req.end();
        });

        const invite = data && data.privateServerInviteData ? data.privateServerInviteData : data;
        if (!invite || !invite.universeId || !invite.linkCode) {
            const status = invite && invite.status ? invite.status : "";
            if (status === "Expired") {
                return { success: false, error: "Share link expired." };
            }
            return { success: false, error: "Share link is invalid or expired." };
        }

        const status = invite.status || "";
        if (status === "Expired") {
            return { success: false, error: "Share link expired." };
        }
        if (status && status !== "Valid") {
            return { success: false, error: `Share link status: ${status}` };
        }

        let placeId = invite.placeId || null;
        if (!placeId) {
            const gameInfo = await fetchGameInfo(String(invite.universeId), { mode: "universe" });
            if (!gameInfo || !gameInfo.placeId) {
                return { success: false, error: "Failed to resolve Place ID from share link." };
            }
            placeId = gameInfo.placeId;
        }

        return {
            success: true,
            placeId: placeId,
            privateServerLinkCode: invite.linkCode,
            universeId: invite.universeId,
            status: status || "Unknown",
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function fetchGameInfo(inputId, options = {}) {
    return new Promise(async (resolve, reject) => {
        try {
            const mode = String(options.mode || "auto").toLowerCase();

            const tryUniverseId = async (universeId) => {
                return new Promise((resolveUniverse, rejectUniverse) => {
                    const url = `https://games.roblox.com/v1/games?universeIds=${universeId}`;
                    https
                        .get(url, (res) => {
                            let data = "";
                            res.on("data", (chunk) => (data += chunk));
                            res.on("end", () => {
                                try {
                                    const json = JSON.parse(data);
                                    if (json.data && json.data.length > 0) {
                                        resolveUniverse(json.data[0]);
                                    } else {
                                        rejectUniverse(
                                            new Error("No game data"),
                                        );
                                    }
                                } catch (e) {
                                    rejectUniverse(e);
                                }
                            });
                        })
                        .on("error", rejectUniverse);
                });
            };

            const convertPlaceToUniverse = async (placeId) => {
                return new Promise((resolvePlac, rejectPlace) => {
                    const placeUrl = `https://apis.roblox.com/universes/v1/places/${placeId}/universe`;
                    https
                        .get(placeUrl, (placeRes) => {
                            let placeData = "";
                            placeRes.on(
                                "data",
                                (chunk) => (placeData += chunk),
                            );
                            placeRes.on("end", () => {
                                try {
                                    const placeJson = JSON.parse(placeData);
                                    if (placeJson.universeId) {
                                        resolvePlac(placeJson.universeId);
                                    } else {
                                        rejectPlace(
                                            new Error("No universe ID"),
                                        );
                                    }
                                } catch (e) {
                                    rejectPlace(e);
                                }
                            });
                        })
                        .on("error", rejectPlace);
                });
            };

            const extractNumericId = (value) => {
                if (value === null || value === undefined) return null;
                if (typeof value === "number") return String(value);
                if (typeof value !== "string") return null;
                const trimmed = value.trim();
                if (!trimmed) return null;
                const urlMatch = trimmed.match(/\/games\/(\d+)\//);
                if (urlMatch) return urlMatch[1];
                if (/^\d+$/.test(trimmed)) return trimmed;
                return null;
            };

            let gameData = null;
            let universeId = null;
            let resolvedInput = inputId;

            if (
                typeof inputId === "string" &&
                inputId.includes("roblox.com/share")
            ) {
                const resolvedUrl = await resolveShareUrl(inputId);
                console.log("[ShareURL] Final Resolved:", resolvedUrl);

                if (resolvedUrl) {
                    resolvedInput = resolvedUrl;
                    const transformMatch = resolvedUrl.match(
                        /\/games\/(\d+)\//,
                    );
                    if (transformMatch) {
                        console.log(
                            "[ShareURL] Extracted PlaceID:",
                            transformMatch[1],
                        );
                    }
                }
            }

            const extractedId = extractNumericId(resolvedInput);

            if (mode === "place") {
                if (!extractedId) {
                    reject(new Error("Invalid Place ID"));
                    return;
                }
                try {
                    universeId = await convertPlaceToUniverse(extractedId);
                    gameData = await tryUniverseId(universeId);
                } catch (e) {
                    reject(new Error("Invalid Place ID"));
                    return;
                }
            } else if (mode === "universe") {
                if (!extractedId) {
                    reject(new Error("Invalid Universe ID"));
                    return;
                }
                try {
                    universeId = extractedId;
                    console.log(
                        "[FetchGame] Calling tryUniverseId with:",
                        universeId,
                    );
                    gameData = await tryUniverseId(universeId);
                } catch (e) {
                    reject(new Error("Invalid Universe ID"));
                    return;
                }
            } else {
                const finalInputId = extractedId || inputId;

                try {
                    console.log(
                        "[FetchGame] Calling tryUniverseId with:",
                        finalInputId,
                    );
                    universeId = finalInputId;
                    gameData = await tryUniverseId(finalInputId);
                } catch (e) {
                    try {
                        if (!extractedId) {
                            throw e;
                        }
                        universeId = await convertPlaceToUniverse(extractedId);
                        gameData = await tryUniverseId(universeId);
                    } catch (e2) {
                        reject(new Error("Invalid Universe/Place ID"));
                        return;
                    }
                }
            }

            // If we have a resolved URL from a share link (e.g. redirected from share),
            // extract the private server code if present.
            let privateServerLinkCode = null;
            if (
                typeof inputId === "string" &&
                inputId.includes("roblox.com") &&
                inputId.includes("privateServerLinkCode")
            ) {
                const match = inputId.match(
                    /privateServerLinkCode=([^&]+)/,
                );
                if (match) {
                    try {
                        privateServerLinkCode = decodeURIComponent(match[1]);
                    } catch (e) {
                        privateServerLinkCode = match[1];
                    }
                }
            }

            const thumbUrl = `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=512x512&format=Png`;
            https
                .get(thumbUrl, (thumbRes) => {
                    let thumbData = "";
                    thumbRes.on("data", (chunk) => (thumbData += chunk));
                    thumbRes.on("end", () => {
                        let thumbnail = "";
                        try {
                            const thumbJson = JSON.parse(thumbData);
                            thumbnail =
                                thumbJson.data && thumbJson.data.length > 0
                                    ? thumbJson.data[0].imageUrl
                                    : "";
                        } catch (e) { }

                        resolve({
                            universeId: universeId,
                            placeId: gameData.rootPlaceId || 0,
                            name: gameData.name || "Unknown Game",
                            description:
                                gameData.description || "No description",
                            creator: gameData.creator?.name || "Unknown",
                            playing: gameData.playing || 0,
                            visits: gameData.visits || 0,
                            likes: gameData.favoritedCount || 0,
                            thumbnail: thumbnail,
                            privateServerLinkCode: privateServerLinkCode
                        });
                    });
                })
                .on("error", () => {
                    resolve({
                        universeId: universeId,
                        placeId: gameData.rootPlaceId || 0,
                        name: gameData.name || "Unknown Game",
                        description: gameData.description || "No description",
                        creator: gameData.creator?.name || "Unknown",
                        playing: gameData.playing || 0,
                        visits: gameData.visits || 0,
                        likes: gameData.favoritedCount || 0,
                        thumbnail: "",
                    });
                });
        } catch (error) {
            reject(error);
        }
    });
}

async function fetchServerList(inputId, options = {}) {
    return new Promise(async (resolve, reject) => {
        try {
            const mode = String(options.mode || "place").toLowerCase();

            const extractNumericId = (value) => {
                if (value === null || value === undefined) return null;
                if (typeof value === "number") return String(value);
                if (typeof value !== "string") return null;
                const trimmed = value.trim();
                if (!trimmed) return null;
                const urlMatch = trimmed.match(/\/games\/(\d+)\//);
                if (urlMatch) return urlMatch[1];
                if (/^\d+$/.test(trimmed)) return trimmed;
                return null;
            };

            const tryAsUniverse = async (universeId) => {
                return new Promise((resolveUni, rejectUni) => {
                    const url = `https://games.roblox.com/v1/games?universeIds=${universeId}`;
                    https
                        .get(url, (res) => {
                            let data = "";
                            res.on("data", (chunk) => (data += chunk));
                            res.on("end", () => {
                                try {
                                    const json = JSON.parse(data);
                                    if (
                                        json.data &&
                                        json.data.length > 0 &&
                                        json.data[0].rootPlaceId
                                    ) {
                                        resolveUni(json.data[0].rootPlaceId);
                                    } else {
                                        rejectUni(new Error("No place data"));
                                    }
                                } catch (e) {
                                    rejectUni(e);
                                }
                            });
                        })
                        .on("error", rejectUni);
                });
            };

            let placeId = extractNumericId(inputId);
            if (!placeId) {
                reject(
                    new Error(
                        mode === "universe"
                            ? "Invalid Universe ID"
                            : "Invalid Place ID",
                    ),
                );
                return;
            }

            if (mode === "universe") {
                placeId = await tryAsUniverse(placeId);
            }

            const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100`;

            https
                .get(url, (res) => {
                    let data = "";
                    res.on("data", (chunk) => (data += chunk));
                    res.on("end", () => {
                        try {
                            const json = JSON.parse(data);
                            const servers = (json.data || []).map((server) => ({
                                id: server.id,
                                maxPlayers: server.maxPlayers,
                                playing: server.playing,
                                ping: server.ping || null,
                                fps: server.fps || 60,
                            }));
                            resolve(servers);
                        } catch (error) {
                            reject(error);
                        }
                    });
                })
                .on("error", reject);
        } catch (error) {
            reject(error);
        }
    });
}

async function getRobloxDeployHistory() {
    const normalizeVersion = (value) => {
        if (typeof value !== "string") return null;
        const match = value.trim().match(/^version-([a-f0-9]{12,})$/i);
        return match ? `version-${match[1].toLowerCase()}` : null;
    };

    const fetchWeaoVersion = (endpoint) =>
        new Promise((resolve, reject) => {
            const req = https.get(
                `https://weao.xyz/api/versions/${endpoint}`,
                { headers: { "User-Agent": "WEAO-3PService" } },
                (res) => {
                    if (res.statusCode !== 200) {
                        res.resume();
                        reject(new Error(`WEAO ${endpoint} HTTP ${res.statusCode}`));
                        return;
                    }

                    let data = "";
                    res.on("data", (chunk) => (data += chunk));
                    res.on("end", () => {
                        if (res.statusCode !== 200) {
                            reject(new Error(`WEAO HTTP ${res.statusCode}`));
                            return;
                        }
                        try {
                            const json = JSON.parse(data);
                            const winVersion = json?.Windows || json?.windows || "";
                            if (winVersion && !/^version-[a-f0-9]{8,}$/i.test(winVersion)) {
                                console.warn(`[Version] WEAO returned non-hex version: ${winVersion}, ignoring`);
                                delete json.Windows;
                                delete json.windows;
                            }
                            resolve(json);
                        } catch (error) {
                            reject(new Error("WEAO JSON parse failed"));
                        }
                    });
                }
            );

            req.setTimeout(8000, () => {
                req.destroy(new Error(`WEAO ${endpoint} timeout`));
            });
            req.on("error", reject);
        });

    const fetchWeaoCurrentVersions = async () => {
        try {
            return await fetchWeaoVersion("current");
        } catch (err) {
            console.warn(`[Version] WEAO /current failed (${err.message}), trying /past...`);
            try {
                return await fetchWeaoVersion("past");
            } catch (err2) {
                throw new Error(`WEAO all endpoints failed: ${err2.message}`);
            }
        }
    };

    const fetchDeployHistoryVersions = () =>
        new Promise((resolve, reject) => {
            const req = https.get("https://setup.rbxcdn.com/DeployHistory.txt", (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        const lines = data.split("\n");
                        const versionRegex = /version-([a-f0-9]+)/i;
                        const dateRegex =
                            /\sat\s([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}\s[0-9]{1,2}:[0-9]{2}:[0-9]{2}\s(?:AM|PM))/i;
                        const seen = new Map();

                        for (let index = 0; index < lines.length; index++) {
                            const line = lines[index];
                            if (!line || !line.includes("New WindowsPlayer")) {
                                continue;
                            }

                            const versionMatch = line.match(versionRegex);
                            if (!versionMatch || !versionMatch[1]) continue;

                            const version = `version-${versionMatch[1]}`;
                            const dateMatch = line.match(dateRegex);
                            const parsedTs =
                                dateMatch && dateMatch[1]
                                    ? Date.parse(dateMatch[1])
                                    : NaN;
                            const timestamp = Number.isNaN(parsedTs)
                                ? null
                                : parsedTs;

                            const existing = seen.get(version);
                            if (!existing) {
                                seen.set(version, { version, timestamp, index });
                                continue;
                            }

                            // Keep the newest occurrence of this version.
                            if (
                                timestamp !== null &&
                                (existing.timestamp === null ||
                                    timestamp > existing.timestamp)
                            ) {
                                seen.set(version, { version, timestamp, index });
                            } else if (
                                existing.timestamp === null &&
                                timestamp === null &&
                                index < existing.index
                            ) {
                                seen.set(version, { version, timestamp, index });
                            }
                        }

                        const versions = Array.from(seen.values())
                            .sort((a, b) => {
                                if (a.timestamp !== null && b.timestamp !== null) {
                                    return b.timestamp - a.timestamp;
                                }
                                if (a.timestamp !== null) return -1;
                                if (b.timestamp !== null) return 1;
                                // Fallback to text order (top lines are newer in DeployHistory)
                                return a.index - b.index;
                            })
                            .map((entry) => entry.version);
                        resolve(versions);
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            req.setTimeout(10000, () => {
                req.destroy(new Error("DeployHistory.txt timeout after 10s"));
            });
            req.on("error", reject);
        });

    try {
        const [current, history] = await Promise.all([
            fetchWeaoCurrentVersions().catch(() => ({})),
            fetchDeployHistoryVersions().catch(() => []),
        ]);

        const deployLive = history[0] || null;
        const weaoLive = normalizeVersion(
            current?.WindowsPlayer ??
            current?.windowsPlayer ??
            current?.Windows ??
            current?.windows ??
            null,
        );
        const live = weaoLive || deployLive;

        if (weaoLive && deployLive && weaoLive !== deployLive) {
            console.warn(
                `[Version] WEAO live (${weaoLive}) differs from DeployHistory head (${deployLive}). Using WEAO as live source.`,
            );
        }

        if (!weaoLive) {
            console.warn("[Version] WEAO returned no valid version, falling back to DeployHistory only.");
        }

        const allVersions = [];
        const seenVersions = new Set();
        if (live) {
            allVersions.push(live);
            seenVersions.add(live);
        }

        for (const version of history) {
            if (!version || seenVersions.has(version)) continue;
            allVersions.push(version);
            seenVersions.add(version);
        }

        const previous =
            live && allVersions.length > 1
                ? allVersions[1]
                : null;
        const future = [];

        return {
            live,
            previous,
            future,
            all: allVersions,
        };
    } catch (error) {
        return {
            live: null,
            previous: null,
            future: [],
            all: [],
        };
    }
}

async function getLatestRobloxVersion() {
    try {
        const history = await getRobloxDeployHistory();
        return history.live;
    } catch (error) {
        console.error("[Version] Failed to get latest:", error);
        return null;
    }
}

async function getInstalledVersions() {
    const entries = [];

    async function collectFromDir(dirPath, source) {
        if (!dirPath) return;
        try {
            const versions = await fs.readdir(dirPath);
            for (const version of versions) {
                const exePath = path.join(dirPath, version, "RobloxPlayerBeta.exe");
                try {
                    const stat = await fs.stat(exePath);
                    entries.push({
                        version,
                        exePath,
                        mtime: stat.mtimeMs,
                        source,
                    });
                } catch (e) { }
            }
        } catch (error) {
        }
    }

    await collectFromDir(VERSIONS_DIR, "custom");
    await collectFromDir(DEFAULT_ROBLOX_DIR, "default");

    const deduped = new Map();
    for (const entry of entries) {
        const existing = deduped.get(entry.version);
        const preferEntry =
            !existing ||
            entry.source === "custom" ||
            entry.mtime > existing.mtime;
        if (preferEntry) {
            deduped.set(entry.version, entry);
        }
    }

    const sorted = Array.from(deduped.values()).sort(
        (a, b) => b.mtime - a.mtime,
    );

    installedVersionPaths.clear();
    sorted.forEach((entry) => {
        installedVersionPaths.set(entry.version, entry.exePath);
    });

    return sorted.map((entry) => entry.version);
}

function downloadFile(url, filePath, onProgress) {
    return new Promise((resolve, reject) => {
        const file = fsSync.createWriteStream(filePath);

        https
            .get(url, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}`));
                    return;
                }

                const totalSize = parseInt(
                    response.headers["content-length"],
                    10,
                );
                let downloadedSize = 0;

                response.on("data", (chunk) => {
                    downloadedSize += chunk.length;
                    if (onProgress && totalSize) {
                        const percentage = Math.round(
                            (downloadedSize / totalSize) * 100,
                        );
                        onProgress(downloadedSize, totalSize, percentage);
                    }
                });

                response.pipe(file);

                file.on("finish", () => {
                    file.close();
                    resolve(filePath);
                });

                file.on("error", (err) => {
                    fsSync.unlink(filePath, () => { });
                    reject(err);
                });
            })
            .on("error", (err) => {
                fsSync.unlink(filePath, () => { });
                reject(err);
            });
    });
}

function fetchRemoteContentLength(url, method = "HEAD", redirectCount = 0) {
    const MAX_REDIRECTS = 5;

    return new Promise((resolve, reject) => {
        const req = https.request(
            url,
            {
                method,
                headers: {
                    "User-Agent": "TiRex/1.0",
                },
            },
            (res) => {
                const statusCode = res.statusCode || 0;

                if (
                    statusCode >= 300 &&
                    statusCode < 400 &&
                    res.headers.location
                ) {
                    if (redirectCount >= MAX_REDIRECTS) {
                        res.resume();
                        reject(new Error("Too many redirects"));
                        return;
                    }

                    const redirectUrl = new URL(
                        res.headers.location,
                        url,
                    ).toString();
                    res.resume();
                    fetchRemoteContentLength(
                        redirectUrl,
                        method,
                        redirectCount + 1,
                    )
                        .then(resolve)
                        .catch(reject);
                    return;
                }

                if (statusCode < 200 || statusCode >= 400) {
                    res.resume();
                    reject(new Error(`HTTP ${statusCode}`));
                    return;
                }

                const rawLength = res.headers["content-length"];
                const parsed = rawLength ? parseInt(rawLength, 10) : NaN;
                const contentLength =
                    Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

                if (method === "GET") {
                    // We only need headers for size probing.
                    res.destroy();
                } else {
                    res.resume();
                }

                resolve(contentLength);
            },
        );

        req.on("error", reject);
        req.end();
    });
}

async function getRemoteFileSize(url) {
    try {
        const headSize = await fetchRemoteContentLength(url, "HEAD");
        if (headSize > 0) return headSize;
    } catch (error) {
    }

    try {
        const getSize = await fetchRemoteContentLength(url, "GET");
        if (getSize > 0) return getSize;
    } catch (error) {
    }

    return 0;
}

async function fetchManifest(version) {
    const url = `${ROBLOX_CDN}/${version}-rbxPkgManifest.txt`;
    return new Promise((resolve, reject) => {
        https
            .get(url, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => resolve(data));
            })
            .on("error", reject);
    });
}

function parseManifest(manifestBody) {
    const lines = manifestBody.split("\n").map((line) => line.trim());
    if (lines[0] !== "v0") {
        throw new Error(`Unknown manifest version: ${lines[0]}`);
    }
    return lines.filter((line) => line.endsWith(".zip"));
}

function extractPackage(packagePath, extractPath, packageName) {
    return new Promise((resolve, reject) => {
        try {
            const zip = new AdmZip(packagePath);
            const extractRoot = EXTRACT_ROOTS[packageName] || "";
            const targetPath = path.join(extractPath, extractRoot);

            if (!fsSync.existsSync(targetPath)) {
                fsSync.mkdirSync(targetPath, { recursive: true });
            }

            const entries = zip.getEntries();
            entries.forEach((entry) => {
                if (entry.isDirectory) return;
                const entryPath = entry.entryName.replace(/\\/g, "/");
                const outputPath = path.join(targetPath, entryPath);
                const outputDir = path.dirname(outputPath);

                if (!fsSync.existsSync(outputDir)) {
                    fsSync.mkdirSync(outputDir, { recursive: true });
                }

                const content = entry.getData();
                fsSync.writeFileSync(outputPath, content);
            });

            resolve();
        } catch (error) {
            reject(error);
        }
    });
}

async function downloadAndExtractPackages(
    version,
    packages,
    extractPath,
    event,
) {
    const tempDir = path.join(DOWNLOAD_DIR, version);
    if (!fsSync.existsSync(tempDir)) {
        fsSync.mkdirSync(tempDir, { recursive: true });
    }

    let completedPackages = 0;
    const totalPackages = packages.length;
    let completedBytes = 0;

    event.reply("status-update", "Calculating total package size...");
    const packageSizeEntries = await Promise.all(
        packages.map(async (packageName) => {
            const packageUrl = `${ROBLOX_CDN}/${version}-${packageName}`;
            const bytes = await getRemoteFileSize(packageUrl);
            return [packageName, bytes];
        }),
    );
    const packageSizes = new Map(packageSizeEntries);
    let totalBytesAllPackages = packageSizeEntries.reduce(
        (sum, [, bytes]) => sum + (bytes || 0),
        0,
    );

    for (const packageName of packages) {
        try {
            const packageUrl = `${ROBLOX_CDN}/${version}-${packageName}`;
            const packagePath = path.join(tempDir, packageName);
            const expectedPackageBytes = packageSizes.get(packageName) || 0;
            let latestDownloadedBytes = 0;
            let latestTotalBytes = expectedPackageBytes;

            event.reply("status-update", `Fetching ${packageName}...`);

            await downloadFile(
                packageUrl,
                packagePath,
                (downloaded, total, percentage) => {
                    latestDownloadedBytes = downloaded;
                    latestTotalBytes = total || latestTotalBytes || 0;

                    const overallDownloadedBytes =
                        completedBytes + downloaded;
                    const hasOverallTotal = totalBytesAllPackages > 0;
                    const fallbackProgress =
                        completedPackages +
                        (latestTotalBytes > 0
                            ? downloaded / latestTotalBytes
                            : 0);
                    const overallPercentage = hasOverallTotal
                        ? Math.round(
                            (overallDownloadedBytes / totalBytesAllPackages) *
                            100,
                        )
                        : Math.round(
                            (fallbackProgress / Math.max(totalPackages, 1)) *
                            100,
                        );
                    const safeOverallPercentage = Math.max(
                        0,
                        Math.min(100, overallPercentage),
                    );

                    const fileCurrentMB = downloaded / 1024 / 1024;
                    const fileTotalMB = latestTotalBytes / 1024 / 1024;
                    const overallCurrentMB =
                        overallDownloadedBytes / 1024 / 1024;
                    const overallTotalMB =
                        totalBytesAllPackages / 1024 / 1024;

                    event.reply("download-progress", {
                        fileName: packageName,
                        // Backward-compatible fields now represent OVERALL progress.
                        currentMB: parseFloat(overallCurrentMB.toFixed(2)),
                        totalMB: parseFloat(overallTotalMB.toFixed(2)),
                        percentage: safeOverallPercentage,
                        // Detailed fields for UI.
                        fileCurrentMB: parseFloat(fileCurrentMB.toFixed(2)),
                        fileTotalMB: parseFloat(fileTotalMB.toFixed(2)),
                        filePercentage: Math.max(
                            0,
                            Math.min(100, Number(percentage || 0)),
                        ),
                        overallCurrentMB: parseFloat(
                            overallCurrentMB.toFixed(2),
                        ),
                        overallTotalMB: parseFloat(overallTotalMB.toFixed(2)),
                        overallPercentage: safeOverallPercentage,
                        packageIndex: completedPackages + 1,
                        totalPackages: totalPackages,
                    });
                },
            );

            let completedPackageBytes =
                latestTotalBytes || expectedPackageBytes || latestDownloadedBytes;
            if (!completedPackageBytes || completedPackageBytes <= 0) {
                try {
                    completedPackageBytes = fsSync.statSync(packagePath).size;
                } catch (error) {
                    completedPackageBytes = latestDownloadedBytes || 0;
                }
            }
            completedBytes += completedPackageBytes;
            if (
                (!expectedPackageBytes || expectedPackageBytes <= 0) &&
                completedPackageBytes > 0
            ) {
                totalBytesAllPackages += completedPackageBytes;
            }

            event.reply("status-update", `Extracting ${packageName}...`);
            await extractPackage(packagePath, extractPath, packageName);
            fsSync.unlinkSync(packagePath);

            completedPackages++;
        } catch (error) {
            console.error(`[Download] Error processing ${packageName}:`, error);
            throw error;
        }
    }

    try {
        fsSync.rmdirSync(tempDir);
    } catch (err) {
    }
}

function createAppSettings(extractPath) {
    const appSettingsPath = path.join(extractPath, "AppSettings.xml");
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<Settings>
\t<ContentFolder>content</ContentFolder>
\t<BaseUrl>http://www.roblox.com</BaseUrl>
</Settings>`;
    fsSync.writeFileSync(appSettingsPath, content);
}

async function loadAppSettings() {
    try {
        if (fsSync.existsSync(settingsFile)) {
            const data = await fs.readFile(settingsFile, "utf8");
            return JSON.parse(data);
        }
    } catch (error) {
        console.error("[Settings] Error loading:", error);
    }
    return { customRobloxPath: null };
}

async function saveAppSettings(settings) {
    try {
        await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2));
    } catch (error) {
        console.error("[Settings] Error saving:", error);
    }
}

let appSettings = { customRobloxPath: null };

function resolveRobloxExe(version) {
    if (installedVersionPaths.has(version)) {
        return installedVersionPaths.get(version);
    }

    const candidates = [
        path.join(VERSIONS_DIR, version, "RobloxPlayerBeta.exe"),
        path.join(DEFAULT_ROBLOX_DIR, version, "RobloxPlayerBeta.exe"),
    ];

    // Add custom path if set
    if (appSettings.customRobloxPath) {
        candidates.unshift(path.join(appSettings.customRobloxPath, version, "RobloxPlayerBeta.exe"));
    }

    for (const exePath of candidates) {
        if (fsSync.existsSync(exePath)) {
            installedVersionPaths.set(version, exePath);
            return exePath;
        }
    }
    return null;
}

function normalizeCookie(cookie) {
    return normalizeNamedCookie(cookie, ROBLOX_AUTH_COOKIE_NAMES.auth);
}

function formatRobloxCookieHeader(cookie, rbxIdCheck) {
    const cleanCookie = normalizeCookie(cookie);
    const cleanRbxIdCheck = normalizeRbxIdCheck(rbxIdCheck || "");
    const parts = [];
    if (cleanCookie) parts.push(`.ROBLOSECURITY=${cleanCookie}`);
    if (cleanRbxIdCheck) parts.push(`.RBXIDCHECK=${cleanRbxIdCheck}`);
    return parts.join("; ");
}

async function findRunningInstanceByCookie(cookie) {
    const normalizedCookie = normalizeCookie(cookie);
    if (!normalizedCookie) return null;

    await reconcileRunningInstances({ forceRefresh: true });
    const liveProcesses = await getRobloxProcessSnapshot(false);
    const liveProcessMap = new Map();
    for (const processInfo of liveProcesses || []) {
        if (!processInfo || !Number.isInteger(processInfo.pid)) continue;
        liveProcessMap.set(processInfo.pid, processInfo);
    }

    for (const [pid, instanceData] of runningInstances.entries()) {
        const instanceCookie = normalizeCookie(instanceData?.cookie);
        if (!instanceCookie || instanceCookie !== normalizedCookie) continue;

        const processInfo = liveProcessMap.get(pid);
        if (!processInfo) {
            runningInstances.delete(pid);
            reopenMetadata.delete(pid);
            continue;
        }

        const expectedPath = normalizePathForComparison(instanceData?.exePath);
        const processPath = normalizePathForComparison(processInfo.path);
        if (expectedPath && processPath && expectedPath !== processPath) {
            runningInstances.delete(pid);
            reopenMetadata.delete(pid);
            continue;
        }

        return instanceData;
    }

    return null;
}

function normalizePrivateServerLinkCode(code) {
    if (typeof code !== "string") return "";
    const trimmed = code.trim();
    if (!trimmed) return "";
    const match = trimmed.match(/privateServerLinkCode=([^&]+)/i);
    const value = match && match[1] ? match[1] : trimmed;
    try {
        return decodeURIComponent(value);
    } catch (e) {
        return value;
    }
}

function extractPlaceIdFromInput(input) {
    if (typeof input !== "string") return null;
    const trimmed = input.trim();
    if (!trimmed) return null;

    const pathMatch = trimmed.match(/\/games\/(\d+)\//i);
    if (pathMatch && pathMatch[1]) return pathMatch[1];

    const queryMatch = trimmed.match(/[?&]placeId=(\d+)/i);
    if (queryMatch && queryMatch[1]) return queryMatch[1];

    return null;
}

function getPreventiveRestartTargetMs(launchStartedAt, launchOptions = {}) {
    if (!Number.isFinite(launchStartedAt) || launchStartedAt <= 0) return 0;
    if (!launchOptions || launchOptions.preventiveRestart !== true) return 0;

    const baseMinutesRaw = Number(launchOptions.preventiveRestartBaseMinutes);
    const jitterMinutesRaw = Number(launchOptions.preventiveRestartJitterMinutes);

    const baseMinutes = Number.isFinite(baseMinutesRaw)
        ? Math.max(30, Math.min(360, Math.round(baseMinutesRaw)))
        : PREVENTIVE_RESTART_BASE_MINUTES;
    const jitterMinutes = Number.isFinite(jitterMinutesRaw)
        ? Math.max(0, Math.min(120, Math.round(jitterMinutesRaw)))
        : PREVENTIVE_RESTART_JITTER_MINUTES;

    const jitterMs =
        jitterMinutes > 0
            ? Math.floor(Math.random() * jitterMinutes * 60 * 1000)
            : 0;
    return launchStartedAt + baseMinutes * 60 * 1000 + jitterMs;
}

function buildReopenMetadata(instanceData) {
    return {
        account: instanceData.accountInfo || { username: instanceData.accountUsername },
        placeId: instanceData.placeId || null,
        jobId: instanceData.jobId || null,
        version: instanceData.version || null,
        exePath: instanceData.exePath || null,
        cookie: instanceData.cookie || null,
        rbxIdCheck:
            instanceData.rbxIdCheck ||
            instanceData.accountInfo?.rbxIdCheck ||
            instanceData.accountInfo?.rbxidcheck ||
            null,
        settings: instanceData.settings || {},
        launchOptions:
            instanceData.launchOptions && typeof instanceData.launchOptions === "object"
                ? { ...instanceData.launchOptions }
                : {},
        privateServerLinkCode: instanceData.privateServerLinkCode || null,
        enabled: true,
    };
}

function launchRoblox(version, placeId, jobId, cookie, rbxIdCheck, accountInfo, settings = {}, autoReopen = false, privateServerLinkCode = null, launchOptions = {}) {
    console.log(`[Launch] Starting launch - AutoReopen: ${autoReopen}, PS Code: ${privateServerLinkCode ? 'Yes' : 'No'}`);
    return new Promise(async (resolve, reject) => {
        try {
            const normalizedLaunchOptions =
                launchOptions && typeof launchOptions === "object"
                    ? { ...launchOptions }
                    : {};
            const exePath = resolveRobloxExe(version);

            if (!exePath || !fsSync.existsSync(exePath)) {
                const errMsg =
                    "Roblox executable missing. Download first or install Roblox.";
                return reject(new Error(errMsg));
            }

            const cleanCookie = normalizeCookie(cookie);
            const allowDuplicateCookie =
                normalizedLaunchOptions.allowDuplicateCookie === true;
            if (cleanCookie && !allowDuplicateCookie) {
                const existingCookieInstance =
                    await findRunningInstanceByCookie(cleanCookie);
                if (existingCookieInstance) {
                    return reject(
                        new Error(
                            `Account ${existingCookieInstance.accountUsername || "Unknown"} is still running (PID ${existingCookieInstance.pid}). Wait before launching again to avoid forced logout.`,
                        ),
                    );
                }
            }
            const stabilizeDelayRaw = Number(
                launchOptions && launchOptions.stabilizeDelayMs,
            );
            const stabilizeDelayMs = Number.isFinite(stabilizeDelayRaw)
                ? Math.max(0, Math.min(10000, Math.round(stabilizeDelayRaw)))
                : 0;
            const placeIdFromPrivateLink = extractPlaceIdFromInput(privateServerLinkCode);
            if (placeIdFromPrivateLink) {
                if (placeId && String(placeId).trim() !== placeIdFromPrivateLink) {
                    console.log(`[Launch] Private server link placeId (${placeIdFromPrivateLink}) overrides provided placeId (${placeId}).`);
                }
                placeId = placeIdFromPrivateLink;
            }
            const cleanPrivateServerLinkCode = normalizePrivateServerLinkCode(privateServerLinkCode);
            const cleanJobId = typeof jobId === "string" ? jobId.trim() : "";
            const cleanRbxIdCheck = await resolveGlobalRbxIdCheck(rbxIdCheck || "");
            let authTicket = null;
            if (cleanCookie && cleanRbxIdCheck) {
                authTicket = await getAuthTicketWithRetry(cleanCookie, cleanRbxIdCheck);
            }
            const encodedAuthTicket = authTicket ? encodeURIComponent(authTicket) : "";

            const launchTime = Date.now();
            const browserTrackerId = Math.floor(Math.random() * 900000) + 100000;
            let launchUrl;

            if (placeId && String(placeId).trim()) {
                const gameInstanceId = cleanJobId && !cleanJobId.startsWith('http') ? `+gameInstanceId:${cleanJobId}` : '';

                let joinUrl;

                if (cleanPrivateServerLinkCode) {
                    const baseUrl = "https://assetgame.roblox.com/game/PlaceLauncher.ashx";
                    const rawUrl = `${baseUrl}?request=RequestPrivateGame&browserTrackerId=${browserTrackerId}&placeId=${placeId}&linkCode=${cleanPrivateServerLinkCode}`;
                    joinUrl = encodeURIComponent(rawUrl);
                } else if (cleanJobId && cleanJobId.startsWith('http')) {
                    joinUrl = encodeURIComponent(cleanJobId);
                } else {
                    joinUrl = `https%3A%2F%2Fassetgame.roblox.com%2Fgame%2FPlaceLauncher.ashx%3Frequest%3DRequestGame%26browserTrackerId%3D${browserTrackerId}%26placeId%3D${placeId}%26isPlayTogetherGame%3Dfalse${gameInstanceId}`;
                }

                launchUrl = `roblox-player:1+launchmode:play+gameinfo:${encodedAuthTicket}+launchtime:${launchTime}+placelauncherurl:${joinUrl}+browsertrackerid:${browserTrackerId}+robloxLocale:en_us+gameLocale:en_us+channel:`;
            } else {
                launchUrl = `roblox-player:1+launchmode:app+gameinfo:${encodedAuthTicket}+launchtime:${launchTime}+browsertrackerid:${browserTrackerId}+robloxLocale:en_us+gameLocale:en_us+channel:`;
            }

            const baselineProcesses = await listRobloxProcessesByPath(exePath);
            const baselineProcessPids = new Set(
                baselineProcesses.map((processInfo) => processInfo.pid),
            );
            const launchStartedAt = Date.now();
            console.log(
                `[PIDScan] Baseline process count for target path: ${baselineProcessPids.size}`,
            );

            const robloxProcess = spawn(exePath, [launchUrl], {
                detached: true,
                stdio: "ignore",
                windowsHide: false,
                shell: false,
            });
            robloxProcess.unref();
            robloxProcess.on("error", (err) => {
                console.error("[Roblox] Spawn error:", err);
            });
            const prePid = robloxProcess.pid;

            if (prePid) {
                runningInstances.set(prePid, {
                    pid: prePid,
                    startTime: launchStartedAt,
                    placeId: placeId || null,
                    accountUsername: accountInfo?.username || "Unknown",
                    status: "Launching",
                    version: version || null,
                    exePath: exePath,
                    jobId: cleanJobId || null,
                    cookie: cleanCookie || null,
                    rbxIdCheck: cleanRbxIdCheck || null,
                    accountInfo: accountInfo || null,
                    settings: settings || {},
                    autoReopen: !!autoReopen,
                    launchOptions: normalizedLaunchOptions,
                    privateServerLinkCode: cleanPrivateServerLinkCode || null,
                });
            }
            robloxProcess.on("exit", () => {
                if (prePid && runningInstances.has(prePid)) {
                    runningInstances.delete(prePid);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send("instance-closed", {
                            pid: prePid,
                        });
                    }
                }
            });

            let attempts = 0;
            const maxAttempts = PID_SCAN_MAX_ATTEMPTS;
            let resolved = false;
            let scanInProgress = false;
            let preferredPidSeenCount = 0;

            console.log('[PIDScan] Starting PID detection loop...');
            console.log('[PIDScan] Target executable:', exePath);
            console.log('[PIDScan] Will scan for', maxAttempts, 'attempts');

            // Notify frontend that scan is starting
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('pid-scan-status', {
                    status: 'scanning',
                    attempt: 0,
                    maxAttempts: maxAttempts,
                    message: 'Scanning for Roblox process...'
                });
            }
            const handlePidFound = (pid) => {
                if (resolved) return;
                resolved = true;
                clearInterval(scanInterval);

                if (prePid && prePid !== pid && runningInstances.has(prePid)) {
                    runningInstances.delete(prePid);
                    reopenMetadata.delete(prePid);
                }

                // Notify frontend of success
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('pid-scan-status', {
                        status: 'found',
                        pid: pid,
                        attempt: attempts,
                        maxAttempts: maxAttempts,
                        message: `PID detected: ${pid}`
                    });
                }

                const instanceData = {
                    pid: pid,
                    startTime: launchStartedAt,
                    placeId: placeId || null,
                    accountUsername: accountInfo?.username || "Unknown",
                    status: "Running",
                    version: version || null,
                    exePath: exePath,
                    jobId: cleanJobId || null,
                    cookie: cleanCookie || null,
                    rbxIdCheck: cleanRbxIdCheck || null,
                    accountInfo: accountInfo || null,
                    settings: settings || {},
                    autoReopen: !!autoReopen,
                    launchOptions: normalizedLaunchOptions,
                    preventiveRestartAtMs: 0,
                    preventiveRestartRequestedAtMs: 0,
                    privateServerLinkCode: cleanPrivateServerLinkCode || null,
                };

                if (autoReopen) {
                    const preventiveRestartAtMs = getPreventiveRestartTargetMs(
                        launchStartedAt,
                        normalizedLaunchOptions,
                    );
                    if (preventiveRestartAtMs > 0) {
                        instanceData.preventiveRestartAtMs = preventiveRestartAtMs;
                        console.log(
                            `[Monitor] Preventive restart scheduled for PID ${pid} at ${new Date(preventiveRestartAtMs).toISOString()}`,
                        );
                    }
                }

                runningInstances.set(pid, instanceData);
                console.log(`[Instance] Added PID ${pid} to runningInstances`);
                console.log(`[Instance] Total running instances: ${runningInstances.size}`);

                console.log(`[AutoReopen] Checking autoReopen flag: ${autoReopen}`);
                if (autoReopen) {
                    reopenMetadata.set(pid, buildReopenMetadata(instanceData));
                    console.log(`[AutoReopen] AUTO-REOPEN ENABLED for PID ${pid} (UNLIMITED)`);
                    console.log(`[AutoReopen] Config:`, {
                        account: accountInfo?.username || 'Unknown',
                        placeId: placeId || 'App Only',
                        jobId: cleanJobId || 'None',
                        reopenDelay: settings.reopenDelay || 2000
                    });
                    console.log(`[AutoReopen] Will automatically relaunch if process crashes`);
                } else {
                    console.log(`[AutoReopen] AUTO-REOPEN DISABLED for PID ${pid}`);
                }

                let monitoredPid = pid;
                let missedAliveChecks = 0;
                let monitorCheckInProgress = false;
                const monitorInterval = setInterval(async () => {
                    if (monitorCheckInProgress) {
                        return;
                    }
                    monitorCheckInProgress = true;
                    try {
                        if (isProcessAlive(monitoredPid)) {
                            missedAliveChecks = 0;

                            const reopenDataWhileAlive = reopenMetadata.get(monitoredPid);
                            const preventiveRestartDue =
                                instanceData.preventiveRestartAtMs > 0 &&
                                Date.now() >= instanceData.preventiveRestartAtMs &&
                                reopenDataWhileAlive &&
                                reopenDataWhileAlive.enabled;

                            if (preventiveRestartDue) {
                                const elapsedSinceRequest = instanceData.preventiveRestartRequestedAtMs
                                    ? Date.now() - instanceData.preventiveRestartRequestedAtMs
                                    : Number.POSITIVE_INFINITY;

                                if (elapsedSinceRequest >= PREVENTIVE_RESTART_RETRY_COOLDOWN_MS) {
                                    instanceData.preventiveRestartRequestedAtMs = Date.now();
                                    console.log(
                                        `[Monitor] Triggering preventive restart for PID ${monitoredPid} (${instanceData.accountUsername || "Unknown"})`,
                                    );

                                    if (mainWindow && !mainWindow.isDestroyed()) {
                                        mainWindow.webContents.send("instance-reopening", {
                                            pid: monitoredPid,
                                            account: reopenDataWhileAlive.account?.username,
                                            message: "Scheduled refresh before long-uptime crash...",
                                        });
                                    }

                                    try {
                                        process.kill(monitoredPid);
                                    } catch (error) {
                                        console.warn(
                                            `[Monitor] Preventive restart signal failed for PID ${monitoredPid}: ${error.message}`,
                                        );
                                        instanceData.preventiveRestartRequestedAtMs = 0;
                                        instanceData.preventiveRestartAtMs =
                                            Date.now() + 10 * 60 * 1000;
                                    }
                                }
                            }
                            return;
                        }

                        missedAliveChecks++;
                        if (missedAliveChecks < PROCESS_EXIT_CONFIRMATION_CHECKS) {
                            return;
                        }

                        const successor = await findLikelyProcessSuccessor({
                            previousPid: monitoredPid,
                            exePath: instanceData.exePath,
                            launchedAfterMs: launchStartedAt - 3000,
                        });

                        if (successor && Number.isInteger(successor.pid) && successor.pid > 0) {
                            const oldPid = monitoredPid;
                            const successorPid = successor.pid;
                            monitoredPid = successorPid;
                            missedAliveChecks = 0;

                            runningInstances.delete(oldPid);
                            const nextInstanceData = {
                                ...instanceData,
                                pid: successorPid,
                                status: "Running",
                            };
                            runningInstances.set(successorPid, nextInstanceData);
                            Object.assign(instanceData, nextInstanceData);
                            instanceData.preventiveRestartRequestedAtMs = 0;
                            nextInstanceData.preventiveRestartRequestedAtMs = 0;

                            if (reopenMetadata.has(oldPid)) {
                                const metadata = reopenMetadata.get(oldPid);
                                reopenMetadata.delete(oldPid);
                                reopenMetadata.set(successorPid, metadata);
                            }

                            console.log(
                                `[Monitor] PID handoff detected ${oldPid} -> ${successorPid}. Keeping instance alive.`,
                            );
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.send("instance-pid-updated", {
                                    oldPid,
                                    newPid: successorPid,
                                });
                            }
                            return;
                        }

                        const terminatedPid = monitoredPid;
                        console.log(`[Monitor] Process ${terminatedPid} has TERMINATED`);
                        clearInterval(monitorInterval);
                        runningInstances.delete(terminatedPid);
                        console.log(`[Monitor] Removed PID ${terminatedPid} from runningInstances`);
                        console.log(`[Monitor] Remaining instances: ${runningInstances.size}`);

                        const reopenData = reopenMetadata.get(terminatedPid);
                        console.log(
                            `[Monitor] Checking reopen data for PID ${terminatedPid}:`,
                            reopenData ? 'FOUND' : 'NOT FOUND',
                        );

                        if (reopenData && reopenData.enabled) {
                            console.log(`[AutoReopen] PROCESS ${terminatedPid} CRASHED!`);
                            console.log(`[AutoReopen] Account: ${reopenData.account?.username || 'Unknown'}`);
                            console.log(`[AutoReopen] PlaceID: ${reopenData.placeId || 'App Only'}`);

                            console.log(`[AutoReopen] Notifying frontend - Reopen in progress...`);
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.send("instance-reopening", {
                                    pid: terminatedPid,
                                    account: reopenData.account?.username,
                                    message: `Roblox crashed. Auto-reopening...`
                                });
                            }

                            const reopenDelay =
                                (reopenData.settings && reopenData.settings.reopenDelay) || 2000;
                            console.log(`[AutoReopen] Waiting ${reopenDelay}ms before relaunch...`);

                            setTimeout(async () => {
                                const latestReopenData = reopenMetadata.get(terminatedPid);
                                if (!latestReopenData || !latestReopenData.enabled) {
                                    console.log(
                                        `[AutoReopen] Relaunch canceled for PID ${terminatedPid} (disabled while waiting)`,
                                    );
                                    reopenMetadata.delete(terminatedPid);
                                    return;
                                }

                                console.log(`[AutoReopen] RELAUNCHING NOW...`);
                                try {
                                    const result = await queueRobloxLaunch(
                                        async () => {
                                            const currentReopenData = reopenMetadata.get(terminatedPid);
                                            if (!currentReopenData || !currentReopenData.enabled) {
                                                throw new Error("Auto-reopen disabled");
                                            }

                                            const shouldRequireGuardNow =
                                                currentReopenData?.settings?.multiInstance !== false &&
                                                (
                                                    currentReopenData?.launchOptions?.requireMultiInstance === true ||
                                                    runningInstances.size > 0
                                                );
                                            if (shouldRequireGuardNow) {
                                                const guardReady = await ensureMultiInstanceGuardForLaunch();
                                                if (!guardReady) {
                                                    throw new Error(
                                                        "Multi-instance guard is not ready for auto-reopen.",
                                                    );
                                                }
                                            }

                                            if (currentReopenData.version) {
                                                const fflagResult = await applyFFlags(
                                                    currentReopenData.version,
                                                    currentReopenData.settings || {},
                                                );
                                                if (!fflagResult?.success) {
                                                    console.warn(
                                                        `[AutoReopen] Failed to reapply FFlags: ${fflagResult?.error || "Unknown error"}`,
                                                    );
                                                }
                                            }

                                            const reopenLaunchOptions = {
                                                ...(currentReopenData.launchOptions || {}),
                                                allowDuplicateCookie: true,
                                            };

                                            return await launchRoblox(
                                                currentReopenData.version,
                                                currentReopenData.placeId,
                                                currentReopenData.jobId,
                                                currentReopenData.cookie,
                                                currentReopenData.rbxIdCheck,
                                                currentReopenData.account,
                                                currentReopenData.settings,
                                                true,
                                                currentReopenData.privateServerLinkCode || null,
                                                reopenLaunchOptions,
                                            );
                                        },
                                        `auto-reopen:${latestReopenData.account?.username || "unknown"}`,
                                    );

                                    if (result.success && result.instanceData) {
                                        const newPid = result.instanceData.pid;
                                        reopenMetadata.delete(terminatedPid);
                                        console.log(
                                            `[AutoReopen] Relaunched successfully with new PID ${newPid}`,
                                        );

                                        if (mainWindow && !mainWindow.isDestroyed()) {
                                            mainWindow.webContents.send("instance-reopened", {
                                                oldPid: terminatedPid,
                                                newPid: newPid,
                                                message: `Roblox relaunched successfully (PID: ${newPid})`
                                            });
                                        }
                                    }
                                } catch (error) {
                                    if (error && error.message === "Auto-reopen disabled") {
                                        console.log(
                                            `[AutoReopen] Relaunch skipped for PID ${terminatedPid} (disabled)`,
                                        );
                                        reopenMetadata.delete(terminatedPid);
                                        return;
                                    }
                                    console.error('[AutoReopen] Failed to relaunch:', error.message);
                                    console.error('[AutoReopen] Error details:', error);
                                    reopenMetadata.delete(terminatedPid);
                                    if (mainWindow && !mainWindow.isDestroyed()) {
                                        mainWindow.webContents.send("instance-reopen-failed", {
                                            pid: terminatedPid,
                                            error: error.message,
                                            message: `Auto-reopen failed: ${error.message}`
                                        });
                                    }
                                }
                            }, reopenDelay);
                        } else {
                            console.log(
                                `[Monitor] Auto-reopen disabled or not configured for PID ${terminatedPid}`,
                            );
                            reopenMetadata.delete(terminatedPid);
                        }

                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send("instance-closed", { pid: terminatedPid });
                        }
                    } finally {
                        monitorCheckInProgress = false;
                    }
                }, 1000);

                console.log(`[Monitor] Started monitoring PID ${pid} for crashes`);

                const finalizeLaunch = () => {
                    resolve({ success: true, instanceData });
                };

                if (stabilizeDelayMs > 0) {
                    console.log(
                        `[Launch] Stabilizing ${accountInfo?.username || "account"} for ${stabilizeDelayMs}ms`,
                    );
                    setTimeout(finalizeLaunch, stabilizeDelayMs);
                } else {
                    finalizeLaunch();
                }
            };

            const scanInterval = setInterval(async () => {
                if (resolved || scanInProgress) {
                    return;
                }

                scanInProgress = true;
                try {
                    attempts++;
                    console.log(`[PIDScan] Attempt ${attempts}/${maxAttempts}`);

                    if (attempts > maxAttempts) {
                        resolved = true;
                        clearInterval(scanInterval);

                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('pid-scan-status', {
                                status: 'failed',
                                attempt: attempts,
                                maxAttempts: maxAttempts,
                                message: 'PID detection failed - Process may not have started'
                            });
                        }

                        if (prePid && runningInstances.has(prePid)) {
                            runningInstances.delete(prePid);
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.send("instance-closed", {
                                    pid: prePid,
                                });
                            }
                        }

                        reject(new Error("Roblox process failed to start within timeout."));
                        return;
                    }

                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('pid-scan-status', {
                            status: 'scanning',
                            attempt: attempts,
                            maxAttempts: maxAttempts,
                            message: `Scanning for PID... (${attempts}/${maxAttempts})`
                        });
                    }

                    const processes = await listRobloxProcessesByPath(exePath);
                    const freshCandidates = processes.filter(
                        (processInfo) =>
                            !baselineProcessPids.has(processInfo.pid) &&
                            !runningInstances.has(processInfo.pid),
                    );

                    const nonBootstrapCandidates = prePid
                        ? freshCandidates.filter((processInfo) => processInfo.pid !== prePid)
                        : freshCandidates;

                    if (nonBootstrapCandidates.length > 0) {
                        nonBootstrapCandidates.sort(
                            (a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0),
                        );
                        handlePidFound(nonBootstrapCandidates[0].pid);
                        return;
                    }

                    const prePidFound =
                        Number.isInteger(prePid) &&
                        (processes.some((processInfo) => processInfo.pid === prePid) ||
                            isProcessAlive(prePid));

                    if (prePidFound) {
                        preferredPidSeenCount++;
                        if (preferredPidSeenCount >= 2) {
                            handlePidFound(prePid);
                            return;
                        }
                    } else {
                        preferredPidSeenCount = 0;
                    }

                    if (!baselineProcessPids.size && freshCandidates.length > 0) {
                        freshCandidates.sort(
                            (a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0),
                        );
                        handlePidFound(freshCandidates[0].pid);
                    }
                } catch (scanError) {
                    console.warn(
                        `[PIDScan] Scan error on attempt ${attempts}: ${scanError?.message || scanError}`,
                    );
                } finally {
                    scanInProgress = false;
                }
            }, PID_SCAN_INTERVAL_MS);
        } catch (error) {
            console.error('[Roblox] Launch Error:', error);
            reject(error);
        }
    });
}



ipcMain.handle("resolve-share-link", async (event, { input, linkType, cookie }) => {
    return await resolveShareLinkData(input, linkType, cookie);
});

ipcMain.handle("fetch-game-info", async (event, payload) => {
    try {
        let id = payload;
        let mode = "auto";

        if (payload && typeof payload === "object") {
            id =
                payload.id ??
                payload.input ??
                payload.placeId ??
                payload.universeId;
            mode = payload.mode || payload.type || "auto";
        }

        return await fetchGameInfo(id, { mode });
    } catch (error) {
        return { error: error.message };
    }
});

ipcMain.handle("fetch-server-list", async (event, payload) => {
    try {
        let id = payload;
        let mode = "place";

        if (payload && typeof payload === "object") {
            id =
                payload.id ??
                payload.input ??
                payload.placeId ??
                payload.universeId;
            mode = payload.mode || payload.type || "place";
        }

        return await fetchServerList(id, { mode });
    } catch (error) {
        return { error: error.message };
    }
});

ipcMain.handle("get-roblox-versions", async () => {
    try {
        const installed = await getInstalledVersions();
        const history = await getRobloxDeployHistory();

        const installedSet = new Set(installed);
        const orderedInstalled = history.all
            ? history.all.filter((v) => installedSet.has(v))
            : [];
        const orphanedInstalled = installed.filter(
            (v) => !orderedInstalled.includes(v),
        );
        let sortedInstalled =
            orderedInstalled.length > 0
                ? [...orderedInstalled, ...orphanedInstalled]
                : installed;

        if (history.live && sortedInstalled.includes(history.live)) {
            sortedInstalled = [
                history.live,
                ...sortedInstalled.filter((v) => v !== history.live),
            ];
        }


        return {
            installed: sortedInstalled,
            latest: history.live,
            live: history.live,
            previous: history.previous,
            future: history.future,
            all: history.all,
        };
    } catch (error) {
        return {
            installed: [],
            latest: null,
            live: null,
            previous: null,
            future: [],
            all: [],
        };
    }
});

ipcMain.on("download-roblox-version", async (event, version, force = false) => {
    try {
        const extractPath = path.join(VERSIONS_DIR, version);
        const exePath = path.join(extractPath, "RobloxPlayerBeta.exe");

        if (fsSync.existsSync(exePath) && !force) {
            event.reply("roblox-download-complete", { success: true, version });
            return;
        }

        if (force && fsSync.existsSync(extractPath)) {
            try {
                event.reply("status-update", "Removing existing version...");
                fsSync.rmSync(extractPath, { recursive: true, force: true });
            } catch (err) {
                console.error("[Main] Failed to remove existing version:", err);
                throw new Error("Failed to clean up existing version. Please try again or delete the folder manually.");
            }
        }

        if (!fsSync.existsSync(extractPath)) {
            fsSync.mkdirSync(extractPath, { recursive: true });
        }

        event.reply("status-update", "Fetching manifest...");
        const manifestBody = await fetchManifest(version);
        const packages = parseManifest(manifestBody);

        event.reply(
            "status-update",
            `Downloading ${packages.length} packages...`,
        );
        await downloadAndExtractPackages(version, packages, extractPath, event);

        createAppSettings(extractPath);
        event.reply("status-update", "Installation complete!");
        event.reply("roblox-download-complete", { success: true, version });
    } catch (error) {
        console.error("[Main] Download error:", error);
        event.reply("roblox-download-complete", {
            success: false,
            error: error.message,
        });
    }
});

ipcMain.handle(
    "launch-roblox",
    async (event, { version, placeId, jobId, cookie, rbxIdCheck, accountInfo, autoReopen, maxReopenAttempts, privateServerLinkCode, launchOptions }) => {
        try {
            const authCookies = normalizeLaunchAuthCookies({
                cookie,
                rbxIdCheck,
                accountInfo,
            });
            const cleanCookie = authCookies.cookie;
            const cleanRbxIdCheck = await resolveGlobalRbxIdCheck(authCookies.rbxIdCheck);
            const cleanPlaceId =
                placeId == null ? "" : String(placeId).trim();
            const hasLaunchTarget =
                !!cleanPlaceId
                || (typeof privateServerLinkCode === "string" && privateServerLinkCode.trim());

            if (!hasLaunchTarget) {
                return {
                    success: false,
                    error: "Place ID or private server link/code is required.",
                };
            }
            if (!cleanCookie) {
                return {
                    success: false,
                    error: "Account is missing .ROBLOSECURITY cookie.",
                };
            }
            if (!cleanRbxIdCheck) {
                return {
                    success: false,
                    error: "Account is missing .RBXIDCHECK cookie.",
                };
            }

            const exePath = resolveRobloxExe(version);

            if (!exePath || !fsSync.existsSync(exePath)) {
                return {
                    success: false,
                    error: "Roblox not installed. Download it first.",
                };
            }

            const settings = await loadSettings();
            const normalizedLaunchOptions =
                launchOptions && typeof launchOptions === "object"
                    ? launchOptions
                    : {};
            const shouldAutoReopen =
                typeof autoReopen === "boolean"
                    ? autoReopen
                    : settings.autoReopen !== false;

            const result = await queueRobloxLaunch(
                async () => {
                    await reconcileRunningInstances({
                        forceRefresh: true,
                        emitCloseEvents: true,
                    });
                    const shouldRequireGuardNow =
                        settings.multiInstance !== false &&
                        (!!normalizedLaunchOptions.requireMultiInstance ||
                            runningInstances.size > 0);
                    if (shouldRequireGuardNow) {
                        const guardReady = await ensureMultiInstanceGuardForLaunch();
                        if (!guardReady) {
                            throw new Error(
                                "Multi-instance guard is not ready. Wait a moment and try again.",
                            );
                        }
                    }

                    // Apply FFlags before launching
                    await applyFFlags(version, settings);
                    console.log('[Launch] FFlags applied for version:', version);

                    return await launchRoblox(
                        version,
                        placeId,
                        jobId,
                        cleanCookie,
                        cleanRbxIdCheck,
                        accountInfo,
                        settings,
                        shouldAutoReopen,
                        privateServerLinkCode,
                        normalizedLaunchOptions,
                    );
                },
                `launch-roblox:${accountInfo?.username || "unknown"}`,
            );

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("roblox-launched", {
                    instanceData: result.instanceData,
                    totalInstances: runningInstances.size,
                });
            }

            if (cleanCookie && cleanPlaceId) {
                try {
                    await refreshLastSessionFromPresence(cleanCookie, {
                        placeId: cleanPlaceId,
                        jobId,
                        username: accountInfo?.username || null,
                    });
                } catch (sessionError) {
                    console.warn("[Session] Failed to persist launch session:", sessionError.message);
                    if (jobId) {
                        await persistLastSession({
                            placeId: cleanPlaceId || placeId,
                            gameId: jobId,
                            userId: accountInfo?.id || null,
                            username: accountInfo?.username || null,
                        });
                    }
                }
            }

            return result;
        } catch (error) {
            return { success: false, error: error.message };
        }
    },
);

ipcMain.handle(
    "launch-roblox-only",
    async (event, { version, cookie, rbxIdCheck, accountInfo, autoReopen, maxReopenAttempts, launchOptions }) => {
        try {
            const authCookies = normalizeLaunchAuthCookies({
                cookie,
                rbxIdCheck,
                accountInfo,
            });
            const cleanCookie = authCookies.cookie;
            const cleanRbxIdCheck = await resolveGlobalRbxIdCheck(authCookies.rbxIdCheck);

            if (!cleanCookie || !cleanRbxIdCheck) {
                return {
                    success: false,
                    error: "Account has missing cookies (.ROBLOSECURITY or .RBXIDCHECK).",
                };
            }

            const exePath = resolveRobloxExe(version);

            if (!exePath || !fsSync.existsSync(exePath)) {
                return {
                    success: false,
                    error: "Roblox not installed. Download it first.",
                };
            }

            const settings = await loadSettings();
            const normalizedLaunchOptions =
                launchOptions && typeof launchOptions === "object"
                    ? launchOptions
                    : {};
            const shouldAutoReopen =
                typeof autoReopen === "boolean"
                    ? autoReopen
                    : settings.autoReopen !== false;

            const result = await queueRobloxLaunch(
                async () => {
                    await reconcileRunningInstances({
                        forceRefresh: true,
                        emitCloseEvents: true,
                    });
                    const shouldRequireGuardNow =
                        settings.multiInstance !== false &&
                        (!!normalizedLaunchOptions.requireMultiInstance ||
                            runningInstances.size > 0);
                    if (shouldRequireGuardNow) {
                        const guardReady = await ensureMultiInstanceGuardForLaunch();
                        if (!guardReady) {
                            throw new Error(
                                "Multi-instance guard is not ready. Wait a moment and try again.",
                            );
                        }
                    }

                    // Apply FFlags before launching
                    await applyFFlags(version, settings);
                    console.log('[Launch] FFlags applied for version:', version);

                    return await launchRoblox(
                        version,
                        null,
                        null,
                        cleanCookie,
                        cleanRbxIdCheck,
                        accountInfo,
                        settings,
                        shouldAutoReopen,
                        null,
                        normalizedLaunchOptions,
                    );
                },
                `launch-roblox-only:${accountInfo?.username || "unknown"}`,
            );

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("roblox-launched", {
                    instanceData: result.instanceData,
                    totalInstances: runningInstances.size,
                });
            }

            if (cleanCookie) {
                try {
                    await refreshLastSessionFromPresence(cleanCookie, {
                        username: accountInfo?.username || null,
                    });
                } catch (sessionError) {
                    console.warn("[Session] Presence session unavailable after app-only launch:", sessionError.message);
                }
            }

            return result;
        } catch (error) {
            return { success: false, error: error.message };
        }
    },
);

ipcMain.handle("toggle-instance-reopen", async (event, { pid, enabled }) => {
    try {
        if (!enabled) {
            // Hard-disable by removing metadata so pending reopen checks can see it's disabled.
            reopenMetadata.delete(pid);
            if (runningInstances.has(pid)) {
                runningInstances.get(pid).autoReopen = false;
            }
            console.log(`[AutoReopen] Disabled for PID ${pid}`);
            return { success: true, enabled: false };
        }

        if (reopenMetadata.has(pid)) {
            reopenMetadata.get(pid).enabled = true;
            if (runningInstances.has(pid)) {
                runningInstances.get(pid).autoReopen = true;
            }
            console.log(`[AutoReopen] Enabled for PID ${pid}`);
            return { success: true, enabled: true };
        }

        if (runningInstances.has(pid)) {
            const instanceData = runningInstances.get(pid);
            if (!instanceData.version || !instanceData.cookie) {
                return {
                    success: false,
                    error: "Missing launch data for auto-reopen. Relaunch with Auto-Reopen enabled.",
                };
            }

            const reopenData = buildReopenMetadata(instanceData);
            reopenMetadata.set(pid, reopenData);
            instanceData.autoReopen = true;
            console.log(`[AutoReopen] Enabled for PID ${pid} (previously disabled)`);
            return { success: true, enabled: true };
        }

        return { success: false, error: "Instance not found" };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle("get-instance-settings", async (event, { pid }) => {
    try {
        await reconcileRunningInstances({ forceRefresh: true });
        const normalizedPid = Number(pid);
        const targetPid = Number.isInteger(normalizedPid) ? normalizedPid : pid;
        const instanceData = runningInstances.get(targetPid);
        const reopenData = reopenMetadata.get(targetPid);

        if (!instanceData) {
            return { success: false, error: "Instance not found" };
        }

        return {
            success: true,
            settings: {
                pid: targetPid,
                accountUsername: instanceData.accountUsername,
                placeId: instanceData.placeId,
                startTime: instanceData.startTime,
                uptime: Date.now() - (instanceData.startTime || Date.now()),
                status: instanceData.status,
                autoReopenEnabled: reopenData ? reopenData.enabled : !!instanceData.autoReopen,
            }
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle("disable-instance-reopen", async (event, { pid }) => {
    try {
        reopenMetadata.delete(pid);
        if (runningInstances.has(pid)) {
            runningInstances.get(pid).autoReopen = false;
        }
        console.log(`[AutoReopen] Disabled for PID ${pid}`);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle("kill-instance", async (event, pid) => {
    try {
        const normalizedPid = Number(pid);
        if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
            return { success: false, error: "Invalid PID" };
        }

        console.log(`[Kill] Attempting to terminate instance with PID ${normalizedPid}`);

        if (reopenMetadata.has(normalizedPid)) {
            reopenMetadata.delete(normalizedPid);
            console.log(`[Kill] Auto-reopen disabled for PID ${normalizedPid} before kill`);
        }
        if (runningInstances.has(normalizedPid)) {
            runningInstances.get(normalizedPid).autoReopen = false;
        }

        await new Promise((resolve) => {
            exec(`taskkill /F /PID ${normalizedPid} /T`, (error, stdout, stderr) => {
                if (error) {
                    console.warn(`[Kill] taskkill failed for PID ${normalizedPid}: ${stderr || error.message}`);
                } else {
                    console.log(`[Kill] successfully killed process ${normalizedPid}`);
                }
                resolve();
            });
        });


        // Wait a bit for the process to fully exit and the OS to reflect it.
        await delay(500);

        await reconcileRunningInstances({
            forceRefresh: true,
            emitCloseEvents: true,
        });

        return { success: true };
    } catch (error) {
        console.error(`[Kill] Failed to kill PID ${pid}:`, error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle("get-running-instances", async () => {
    await reconcileRunningInstances({
        forceRefresh: true,
        emitCloseEvents: false,
    });
    const instances = [];
    const now = Date.now();
    const trackedPids = new Set();
    runningInstances.forEach((data, pid) => {
        trackedPids.add(pid);
        instances.push({
            pid,
            accountUsername: data.accountUsername,
            placeId: data.placeId,
            startTime: data.startTime || now,
            uptime: now - (data.startTime || now),
            status: data.status || "Running",
            detected: false,
        });
    });

    const liveProcesses = await getRobloxProcessSnapshot(false);
    for (const processInfo of liveProcesses || []) {
        if (!processInfo || !Number.isInteger(processInfo.pid)) continue;
        if (trackedPids.has(processInfo.pid)) continue;

        const startedAt = processInfo.startedAtMs > 0 ? processInfo.startedAtMs : now;
        instances.push({
            pid: processInfo.pid,
            accountUsername: "Detected Roblox Process",
            placeId: null,
            startTime: startedAt,
            uptime: Math.max(0, now - startedAt),
            status: "Detected (PID)",
            detected: true,
        });
    }

    return instances.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
});

ipcMain.handle("get-guard-status", async () => {
    return guardStatus;
});

ipcMain.handle("follow-user", async (event, { userId, cookie, rbxIdCheck }) => {
    try {
        const cleanCookie = normalizeCookie(cookie);
        const cleanRbxIdCheck = await resolveGlobalRbxIdCheck(rbxIdCheck);
        if (!userId || !cleanCookie || !cleanRbxIdCheck) {
            return { success: false, error: "Missing userId or cookie bundle" };
        }

        const csrfToken = await getCSRFToken(cleanCookie, cleanRbxIdCheck);

        return new Promise((resolve) => {
            const options = {
                hostname: "friends.roblox.com",
                path: `/v1/users/${userId}/follow`,
                method: "POST",
                headers: {
                    Cookie: formatRobloxCookieHeader(cleanCookie, cleanRbxIdCheck),
                    "X-CSRF-TOKEN": csrfToken,
                    "Content-Type": "application/json",
                    "Content-Length": 0,
                },
            };

            const req = https.request(options, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        const json = JSON.parse(data);
                        resolve({
                            success: res.statusCode === 200 && (json.success === true),
                            data: json,
                            statusCode: res.statusCode
                        });
                    } catch (e) {
                        resolve({ success: false, error: "Failed to parse response", statusCode: res.statusCode });
                    }
                });
            });

            req.on("error", (error) => {
                resolve({ success: false, error: error.message });
            });

            req.end();
        });
    } catch (error) {
        console.error("[Follow] Error:", error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle("request-friendship", async (event, { userId, cookie, rbxIdCheck }) => {
    try {
        const cleanCookie = normalizeCookie(cookie);
        const cleanRbxIdCheck = await resolveGlobalRbxIdCheck(rbxIdCheck);
        if (!userId || !cleanCookie || !cleanRbxIdCheck) {
            return { success: false, error: "Missing userId or cookie bundle" };
        }

        const csrfToken = await getCSRFToken(cleanCookie, cleanRbxIdCheck);
        const postData = JSON.stringify({
            FriendsshipOriginSourceType: 'UserProfile'
        });

        return new Promise((resolve) => {
            const options = {
                hostname: "friends.roblox.com",
                path: `/v1/users/${userId}/request-friendship`,
                method: "POST",
                headers: {
                    Cookie: formatRobloxCookieHeader(cleanCookie, cleanRbxIdCheck),
                    "X-CSRF-TOKEN": csrfToken,
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(postData),
                },
            };

            const req = https.request(options, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        const json = JSON.parse(data);
                        resolve({
                            success: res.statusCode === 200 && (json.success === true),
                            data: json,
                            statusCode: res.statusCode
                        });
                    } catch (e) {
                        resolve({ success: false, error: "Failed to parse response", statusCode: res.statusCode });
                    }
                });
            });

            req.on("error", (error) => {
                resolve({ success: false, error: error.message });
            });

            req.write(postData);
            req.end();
        });
    } catch (error) {
        console.error("[FriendRequest] Error:", error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle("validate-cookie", async (event, { cookie, rbxIdCheck }) => {
    try {
        return await validateCookie(cookie, rbxIdCheck);
    } catch (error) {
        return { valid: false, error: error.message };
    }
});

ipcMain.handle("get-last-session", async () => {
    try {
        const settings = await loadSettings();
        return { success: true, session: settings?.lastSession || null };
    } catch (error) {
        return { success: false, error: error.message, session: null };
    }
});

ipcMain.handle("rejoin-last-session", async (event, payload = {}) => {
    try {
        const currentSettings = await loadSettings();
        if (currentSettings?.autoRejoinLastSession === false) {
            return { success: false, error: "Auto Rejoin is disabled in settings." };
        }

        const cleanCookie = normalizeCookie(payload.cookie);
        const rbxIdCheck = await resolveGlobalRbxIdCheck(
            payload?.rbxIdCheck ||
            payload?.rbxidcheck ||
            payload?.accountInfo?.rbxIdCheck ||
            payload?.accountInfo?.rbxidcheck ||
            "",
        );
        if (!cleanCookie || !rbxIdCheck) {
            return { success: false, error: "Selected account has missing/invalid cookies." };
        }

        let latestSession = null;
        try {
            const refreshed = await refreshLastSessionFromPresence(cleanCookie, {
                username: payload?.accountInfo?.username || null,
            });
            latestSession = refreshed.session;
        } catch (presenceError) {
            const settings = await loadSettings();
            latestSession = settings?.lastSession || null;
            if (!latestSession?.placeId || !latestSession?.gameId) {
                throw presenceError;
            }
        }

        const placeId = String(latestSession.placeId || "").trim();
        const gameId = String(latestSession.gameId || "").trim();
        if (!placeId || !gameId) {
            return { success: false, error: "No saved session found." };
        }

        const launchTimestamp = Date.now();
        const protocolUrl =
            `roblox-player:1+launchmode:play+gameinstanceid:${gameId}+placeid:${placeId}+launchtime:${launchTimestamp}`;
        await shell.openExternal(protocolUrl);

        return {
            success: true,
            placeId,
            gameId,
            launchTimestamp,
            protocolUrl,
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle("export-accounts", async () => {
    try {
        const { dialog } = require("electron");
        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            title: "Export Data",
            defaultPath: "ram-accounts.json",
            filters: [{ name: "JSON", extensions: ["json"] }],
        });

        if (!filePath) return { success: false };

        const accounts = await loadAccounts();
        const settings = await loadSettings();
        const settingsCode = encodeSettingsBooleanCode(settings);
        const exportData = {
            v: 2,
            a: accounts,
            c: settingsCode,
            x: buildCompactSettingsExtras(settings),
            t: new Date().toISOString(),
        };

        await fs.writeFile(filePath, JSON.stringify(exportData, null, 2));

        return {
            success: true,
            path: filePath,
            accountsCount: accounts.length,
            settingsChunks: Math.floor(settingsCode.length / SETTINGS_TOKEN_LENGTH),
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle("import-accounts", async () => {
    try {
        const { dialog } = require("electron");
        const { filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: "Import Data",
            filters: [
                { name: "Data Files", extensions: ["json", "txt", "ramcfg"] },
                { name: "All Files", extensions: ["*"] },
            ],
            properties: ["openFile"],
        });

        if (!filePaths || filePaths.length === 0) return { success: false };

        const rawData = await fs.readFile(filePaths[0], "utf8");
        const trimmed = (rawData || "").trim();
        if (!trimmed) {
            return { success: false, error: "File is empty" };
        }

        let parsedPayload = null;
        try {
            parsedPayload = JSON.parse(trimmed);
        } catch (error) {
            parsedPayload = trimmed;
        }

        let importedAccounts = null;
        let settingsCode = "";
        let compactExtras = {};

        if (Array.isArray(parsedPayload)) {
            importedAccounts = parsedPayload;
        } else if (typeof parsedPayload === "string") {
            settingsCode = parsedPayload;
        } else if (parsedPayload && typeof parsedPayload === "object") {
            if (Array.isArray(parsedPayload.a)) {
                importedAccounts = parsedPayload.a;
            } else if (Array.isArray(parsedPayload.accounts)) {
                importedAccounts = parsedPayload.accounts;
            }

            settingsCode =
                (typeof parsedPayload.c === "string" && parsedPayload.c) ||
                (typeof parsedPayload.settingsCode === "string" && parsedPayload.settingsCode) ||
                (typeof parsedPayload.cfg === "string" && parsedPayload.cfg) ||
                (typeof parsedPayload.code === "string" && parsedPayload.code) ||
                "";

            compactExtras = parsedPayload.x || parsedPayload.extraSettings || {};
        }

        if (!importedAccounts && !settingsCode) {
            return { success: false, error: "Invalid file format" };
        }

        let accountCount = null;
        if (Array.isArray(importedAccounts)) {
            await saveAccounts(importedAccounts);
            accountCount = importedAccounts.length;
        }

        let settingsApplied = 0;
        let settingsImported = false;
        if (settingsCode) {
            const currentSettings = await loadSettings();
            const decoded = decodeSettingsBooleanCode(settingsCode, currentSettings);
            const extraSettings = parseCompactSettingsExtras(compactExtras);
            const mergedSettings = mergeSettingsWithDefaults({
                ...decoded.settings,
                ...extraSettings,
                fflags: {
                    ...(decoded.settings.fflags || {}),
                    ...((extraSettings && extraSettings.fflags) || {}),
                },
                memoryOptimization: {
                    ...(decoded.settings.memoryOptimization || {}),
                    ...((extraSettings && extraSettings.memoryOptimization) || {}),
                },
            });

            await saveSettings(mergedSettings);
            settingsApplied = decoded.applied;
            settingsImported = true;
        }

        return {
            success: true,
            count: accountCount,
            importedSettings: settingsImported,
            settingsApplied,
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle("select-custom-roblox-path", async () => {
    try {
        const { dialog } = require("electron");
        const { filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: "Select Roblox Versions Directory",
            properties: ["openDirectory"],
        });

        if (!filePaths || filePaths.length === 0) {
            return { success: false };
        }

        const selectedPath = filePaths[0];
        appSettings.customRobloxPath = selectedPath;
        await saveAppSettings(appSettings);

        // Clear cached paths to force re-resolution
        installedVersionPaths.clear();

        return { success: true, path: selectedPath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle("get-custom-roblox-path", async () => {
    return { path: appSettings.customRobloxPath };
});

ipcMain.handle("get-roblox-path-info", async () => {
    try {
        await ensureDirectories();
        const persistedSettings = await loadAppSettings();
        appSettings = { ...appSettings, ...persistedSettings };
        const customPath = appSettings.customRobloxPath || null;
        const currentPath = customPath || VERSIONS_DIR;
        return {
            success: true,
            currentPath,
            customPath,
            managedPath: VERSIONS_DIR,
            defaultPath: DEFAULT_ROBLOX_DIR,
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle("open-path-in-explorer", async (event, targetPath) => {
    try {
        if (typeof targetPath !== "string" || !targetPath.trim()) {
            return { success: false, error: "Path is empty" };
        }

        const normalizedPath = path.normalize(targetPath.trim());
        if (!fsSync.existsSync(normalizedPath)) {
            return { success: false, error: "Path does not exist" };
        }

        const openResult = await shell.openPath(normalizedPath);
        if (openResult) {
            return { success: false, error: openResult };
        }

        return { success: true, path: normalizedPath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle("clear-custom-roblox-path", async () => {
    appSettings.customRobloxPath = null;
    await saveAppSettings(appSettings);
    installedVersionPaths.clear();
    return { success: true };
});

ipcMain.handle("get-app-console-logs", async () => {
    return {
        success: true,
        logs: appConsoleLogBuffer.slice(-APP_CONSOLE_BUFFER_LIMIT),
    };
});

ipcMain.handle("clear-app-console-logs", async () => {
    appConsoleLogBuffer.length = 0;
    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            mainWindow.webContents.send(APP_CONSOLE_EVENT, {
                type: "cleared",
                timestamp: Date.now(),
            });
        } catch (error) {
            // Ignore send failures while renderer is not ready.
        }
    }
    return { success: true };
});

ipcMain.handle("apply-custom-roblox-font", async () => {
    try {
        const { canceled, filePaths } = await electron.dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [{ name: 'Fonts', extensions: ['ttf'] }]
        });
        if (canceled || filePaths.length === 0) return { success: false, cancelled: true };

        const selectedFont = filePaths[0];
        let applied = false;

        const pathsToScan = new Set(installedVersionPaths.values());
        try {
            const children = await fs.readdir(DEFAULT_ROBLOX_DIR);
            for (const child of children) {
                if (child.startsWith('version-')) {
                    pathsToScan.add(path.join(DEFAULT_ROBLOX_DIR, child));
                }
            }
        } catch (e) { }

        try {
            const children = await fs.readdir(VERSIONS_DIR);
            for (const child of children) {
                if (child.startsWith('version-')) {
                    pathsToScan.add(path.join(VERSIONS_DIR, child));
                }
            }
        } catch (e) { }

        if (typeof appSettings !== 'undefined' && appSettings && appSettings.customRobloxPath) {
            try {
                const children = await fs.readdir(appSettings.customRobloxPath);
                for (const child of children) {
                    if (child.startsWith('version-')) {
                        pathsToScan.add(path.join(appSettings.customRobloxPath, child));
                    }
                }
            } catch (e) { }
        }

        for (const robloxPath of pathsToScan) {
            const fontsDir = path.join(robloxPath, 'content', 'fonts');
            try {
                const stat = await fs.stat(fontsDir);
                if (!stat.isDirectory()) continue;

                const backupDir = path.join(fontsDir, '_backup');
                await fs.mkdir(backupDir, { recursive: true }).catch(() => { });

                // scan all font files in directory
                const allFiles = await fs.readdir(fontsDir);
                const fontsToReplace = allFiles.filter(file => {
                    const ext = path.extname(file).toLowerCase();
                    return ext === '.ttf' || ext === '.otf';
                });

                for (const fontName of fontsToReplace) {
                    const targetFile = path.join(fontsDir, fontName);
                    const backupFile = path.join(backupDir, fontName);
                    try {
                        const targetStat = await fs.stat(targetFile);
                        if (targetStat.isFile()) {
                            // backup if not backed up yet
                            try {
                                await fs.stat(backupFile);
                            } catch (err) {
                                await fs.copyFile(targetFile, backupFile);
                            }
                            // overwrite
                            await fs.copyFile(selectedFont, targetFile);
                            applied = true;
                        }
                    } catch (e) { /* ignore errors for individual files */ }
                }
            } catch (err) { /* ignore invalid paths */ }
        }

        if (applied) {
            appSettings.selectedRobloxFont = selectedFont;
            await saveAppSettings(appSettings);
            return { success: true };
        } else {
            return { success: false, error: "No valid Roblox installation found to apply font." };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle("restore-roblox-font", async () => {
    try {
        let restored = false;
        const pathsToScan = new Set(installedVersionPaths.values());
        try {
            if (fsSync.existsSync(DEFAULT_ROBLOX_DIR)) {
                const children = await fs.readdir(DEFAULT_ROBLOX_DIR);
                for (const child of children) {
                    if (child.startsWith('version-')) {
                        pathsToScan.add(path.join(DEFAULT_ROBLOX_DIR, child));
                    }
                }
            }
        } catch (e) { }

        try {
            if (fsSync.existsSync(VERSIONS_DIR)) {
                const children = await fs.readdir(VERSIONS_DIR);
                for (const child of children) {
                    if (child.startsWith('version-')) {
                        pathsToScan.add(path.join(VERSIONS_DIR, child));
                    }
                }
            }
        } catch (e) { }
        if (typeof appSettings !== 'undefined' && appSettings && appSettings.customRobloxPath) {
            try {
                if (fsSync.existsSync(appSettings.customRobloxPath)) {
                    const children = await fs.readdir(appSettings.customRobloxPath);
                    for (const child of children) {
                        if (child.startsWith('version-')) {
                            pathsToScan.add(path.join(appSettings.customRobloxPath, child));
                        }
                    }
                }
            } catch (e) { }
        }

        for (const robloxPath of pathsToScan) {
            const fontsDir = path.join(robloxPath, 'content', 'fonts');
            const backupDir = path.join(fontsDir, '_backup');
            try {
                const stat = await fs.stat(backupDir);
                if (stat.isDirectory()) {
                    const files = await fs.readdir(backupDir);
                    for (const file of files) {
                        try {
                            await fs.copyFile(path.join(backupDir, file), path.join(fontsDir, file));
                            restored = true;
                        } catch (e) { }
                    }
                    try { await fs.rm(backupDir, { recursive: true, force: true }); } catch (e) { }
                }
            } catch (err) { }
        }
        if (restored) {
            appSettings.selectedRobloxFont = null;
            await saveAppSettings(appSettings);
            return { success: true };
        } else {
            return { success: false, error: "No backup found or nothing to restore." };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle("get-font-settings", async () => {
    try {
        const selectedFontPath = appSettings.selectedRobloxFont || null;

        const pathsToScan = new Set(installedVersionPaths.values());
        try {
            if (fsSync.existsSync(DEFAULT_ROBLOX_DIR)) {
                const children = await fs.readdir(DEFAULT_ROBLOX_DIR);
                for (const child of children) {
                    if (child.startsWith('version-')) {
                        pathsToScan.add(path.join(DEFAULT_ROBLOX_DIR, child));
                    }
                }
            }
        } catch (e) { }

        if (appSettings.customRobloxPath && fsSync.existsSync(appSettings.customRobloxPath)) {
            try {
                const children = await fs.readdir(appSettings.customRobloxPath);
                for (const child of children) {
                    if (child.startsWith('version-')) {
                        pathsToScan.add(path.join(appSettings.customRobloxPath, child));
                    }
                }
            } catch (e) { }
        }

        let robloxFontsPath = null;
        let latestMtime = 0;

        for (const robloxPath of pathsToScan) {
            const fontsDir = path.join(robloxPath, 'content', 'fonts');
            try {
                const stat = await fs.stat(fontsDir);
                if (stat.isDirectory()) {
                    if (stat.mtimeMs > latestMtime) {
                        latestMtime = stat.mtimeMs;
                        robloxFontsPath = fontsDir;
                    }
                }
            } catch (err) { }
        }

        return {
            success: true,
            selectedFontPath,
            robloxFontsPath
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle("set-hide-capture", async (event, enabled) => {
    try {
        appSettings.hideCapture = enabled;
        await saveAppSettings(appSettings);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setContentProtection(enabled);
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1480,
        height: 940,
        minWidth: 1280,
        minHeight: 760,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
        backgroundColor: "#0b0c0f",
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.webContents.setZoomFactor(0.84);
    let currentRendererPath = getRendererIndexPath();
    let rendererFallbackUsed = false;
    const bundledRendererPath = path.join(__dirname, "index.html");
    const loadRenderer = async (htmlPath) => {
        currentRendererPath = htmlPath;
        await mainWindow.loadFile(htmlPath);
    };
    const loadBundledRendererFallback = async (reason) => {
        if (rendererFallbackUsed) return;
        rendererFallbackUsed = true;
        recoverHotRendererBundle(reason);
        try {
            await loadRenderer(bundledRendererPath);
        } catch (error) {
            console.error("[Renderer] Bundled fallback failed:", error.message);
        }
    };

    mainWindow.webContents.on(
        "did-fail-load",
        async (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
            if (!isMainFrame || errorCode === -3) {
                return;
            }

            console.warn(
                `[Renderer] Main frame failed to load (${errorCode}: ${errorDescription}) at ${validatedURL || currentRendererPath}`,
            );

            if (
                path.resolve(currentRendererPath) !==
                path.resolve(bundledRendererPath)
            ) {
                await loadBundledRendererFallback("did_fail_load");
            }
        },
    );

    mainWindow.webContents.on("did-finish-load", () => {
        rendererFallbackUsed = false;
    });

    // Register IPC handlers BEFORE loading the renderer
    // to prevent race where renderer calls checkForUpdates() before handlers exist
    setupHotUpdater(mainWindow);

    void loadRenderer(currentRendererPath);
    mainWindow.on("ready-to-show", async () => {
        mainWindow.show();

        // Load app settings
        appSettings = await loadAppSettings();
        console.log("[Settings] Loaded:", appSettings);

        // Apply content protection if enabled
        if (appSettings.hideCapture) {
            mainWindow.setContentProtection(true);
        }

        // Send settings to renderer
        mainWindow.webContents.send('settings-loaded', appSettings);

        setGuardStatus(
            "stopped",
            "Standby mode: guard starts automatically when multi-instance launch is requested",
        );
    });

    mainWindow.on("closed", () => {
        stopMultiInstanceMutex();
        mainWindow = null;
    });
}

app.on("ready", async () => {
    await ensureDirectories();
    createWindow();
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on("window-all-closed", () => {
    stopMultiInstanceMutex();
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("before-quit", (event) => {
    // If we're quitting for an update, we might want to skip some cleanup or handle it differently
    // But generally, we want to ensure mutexes are released.
    stopMultiInstanceMutex();
});

module.exports = { mainWindow };
