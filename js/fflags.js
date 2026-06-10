// TiRex RM — FFlags Tab
// Performance toggles, renderer selection, memory optimization

const ADVANCED_FFLAG_OPTIONS = [
    { key: "debugRendering", label: "Debug Rendering", description: "Enable rendering diagnostics flags." },
    { key: "renderShadowmap", label: "Render Shadowmap", description: "Use shadowmap rendering experiment flags." },
    { key: "renderVoxelPerf", label: "Render Voxel Perf", description: "Enable voxel rendering performance tuning flags." },
    { key: "simAdaptiveTimestepping", label: "Adaptive Timestepping", description: "Enable adaptive physics simulation timesteps." },
    { key: "networkDebugDraw", label: "Network Debug Draw", description: "Enable network debug draw instrumentation." },
    { key: "unifiedPhysicsSender", label: "Unified Physics Sender", description: "Enable unified physics replication sender." },
    { key: "studioMaterialGenerator", label: "Studio Material Generator", description: "Enable material generator flags where supported." },
    { key: "studioPivotTools", label: "Studio Pivot Tools", description: "Enable pivot tool experiments where supported." },
    { key: "studioEmulatorPerfStats", label: "Studio Emulator Perf Stats", description: "Enable emulator performance stats where supported." },
    { key: "cameraGamepadZoom", label: "Camera Gamepad Zoom", description: "Enable gamepad zoom behavior in camera flags." },
    { key: "topbarNewHover", label: "Topbar New Hover", description: "Enable updated topbar hover behavior flags." },
    { key: "emotesMenuV3", label: "Emotes Menu V3", description: "Enable Emotes Menu V3 flags." },
    { key: "newAssembliesPGS", label: "New Assemblies PGS", description: "Enable new PGS assemblies behavior." },
    { key: "solverPrestepBudget", label: "Solver Prestep Budget", description: "Enable prestep budget solver flags." },
    { key: "physicsPerfProfile", label: "Physics Perf Profile", description: "Enable physics performance profiling flags." },
    { key: "soundEngineFastSeek", label: "Sound Engine Fast Seek", description: "Enable fast seek behavior in audio engine." },
    { key: "spatialVoiceNoiseSuppression", label: "Spatial Voice Noise Suppression", description: "Enable voice noise suppression flags." },
    { key: "audioOutputDeviceSelect", label: "Audio Output Device Select", description: "Enable audio output device selection flags." },
    { key: "securityLuauBytecodeHash", label: "Luau Bytecode Hash", description: "Enable Luau bytecode hash security flag." },
    { key: "clientIntegrityCheck", label: "Client Integrity Check", description: "Enable client integrity check flags." },
    { key: "scriptPerformanceGuardrails", label: "Script Performance Guardrails", description: "Enable script performance guardrail flags." },
    { key: "mobileGpuSkinning", label: "Mobile GPU Skinning", description: "Enable mobile GPU skinning flags." },
    { key: "dynamicResolutionV2", label: "Dynamic Resolution V2", description: "Enable dynamic resolution v2 behavior." },
    { key: "throttleBackgroundClients", label: "Throttle Background Clients", description: "Enable background client throttling flags." },
    { key: "logAnalyticsHttpFailures", label: "Log Analytics HTTP Failures", description: "Enable HTTP failure analytics logging flags." },
    { key: "errorReportStacktrace", label: "Error Report Stacktrace", description: "Enable stacktrace error report flags." },
    { key: "perfTelemetryGpuCpuSplit", label: "Perf Telemetry GPU/CPU Split", description: "Enable split GPU/CPU telemetry flags." },
];

function getAdvancedFflagToggleId(key) { return `toggleAdvanced${key.charAt(0).toUpperCase()}${key.slice(1)}`; }

function renderAdvancedFflagOptions() {
    const container = document.getElementById("advancedFflagsList");
    if (!container) return;
    container.className = "fflag-compact-grid";
    container.innerHTML = ADVANCED_FFLAG_OPTIONS.map((option) => `<div class="fflag-compact-item"><label class="fflag-compact-label"><input type="checkbox" id="${getAdvancedFflagToggleId(option.key)}" onchange="saveFFlags()"><span class="fflag-compact-check"></span><span class="fflag-compact-text">${option.label}</span></label></div>`).join("");
}

async function saveFFlags() {
    if (!settings.fflags) settings.fflags = {};
    settings.fflags.fpsUnlocker = document.getElementById('fpsUnlockerToggle').checked;
    settings.fflags.fpsLimit = parseInt(document.getElementById('fpsSlider').value);
    settings.fflags.disableShadows = document.getElementById('toggleDisableShadows').checked;
    settings.fflags.noTextures = document.getElementById('toggleNoTextures').checked;
    settings.fflags.lowQualityAudio = document.getElementById('toggleLowQualityAudio').checked;
    ADVANCED_FFLAG_OPTIONS.forEach((option) => { const toggle = document.getElementById(getAdvancedFflagToggleId(option.key)); settings.fflags[option.key] = !!toggle?.checked; });
    settings.autoReopen = document.getElementById('toggleAutoReopen').checked;
    settings.allowPrerelease = document.getElementById('toggleAllowPrerelease').checked;
    settings.reopenDelay = parseInt(document.getElementById('reopenDelay').value);
    if (!settings.memoryOptimization) settings.memoryOptimization = {};
    settings.memoryOptimization.closeCrashHandler = document.getElementById('toggleCloseCrashHandler').checked;
    settings.memoryOptimization.memoryTrim = document.getElementById('toggleMemoryTrim').checked;
    settings.memoryOptimization.memoryTrimInterval = parseInt(document.getElementById('memoryTrimInterval').value) || 60;
    settings.memoryOptimization.systemMemoryCleaner = document.getElementById('systemMemoryCleaner').value;
    try { await ipcRenderer.invoke('save-settings', settings); console.log('[Settings] Saved:', settings); await ipcRenderer.invoke('start-memory-services', settings.memoryOptimization); }
    catch (error) { console.error('[Settings] Failed to save:', error); showNotification('Failed to save settings', 'error'); }
}

function loadFFlags() {
    if (settings.fflags) {
        document.getElementById('fpsUnlockerToggle').checked = settings.fflags.fpsUnlocker !== false;
        document.getElementById('fpsSlider').value = settings.fflags.fpsLimit || 60;
        document.getElementById('fpsValue').textContent = settings.fflags.fpsLimit || 60;
        document.getElementById('toggleDisableShadows').checked = settings.fflags.disableShadows || false;
        document.getElementById('toggleNoTextures').checked = settings.fflags.noTextures || false;
        document.getElementById('toggleLowQualityAudio').checked = settings.fflags.lowQualityAudio || false;
        ADVANCED_FFLAG_OPTIONS.forEach((option) => { const toggle = document.getElementById(getAdvancedFflagToggleId(option.key)); if (toggle) toggle.checked = settings.fflags[option.key] || false; });
        const renderer = settings.fflags.renderer || 'd3d11';
        document.querySelectorAll('#tab-fflags .render-card[data-renderer]').forEach(card => { if (card.dataset.renderer === renderer) card.classList.add('active'); else card.classList.remove('active'); });
    }
    document.getElementById('toggleAutoReopen').checked = settings.autoReopen !== false;
    document.getElementById('toggleAllowPrerelease').checked = !!settings.allowPrerelease;
    document.getElementById('reopenDelay').value = settings.reopenDelay || 2000;
    const memOpt = settings.memoryOptimization || {};
    document.getElementById('toggleCloseCrashHandler').checked = memOpt.closeCrashHandler || false;
    document.getElementById('toggleMemoryTrim').checked = memOpt.memoryTrim || false;
    document.getElementById('memoryTrimInterval').value = memOpt.memoryTrimInterval || 60;
    document.getElementById('systemMemoryCleaner').value = memOpt.systemMemoryCleaner || 'never';
    console.log('[Settings] Loaded:', settings);
    if (memOpt.memoryTrim || memOpt.closeCrashHandler || (memOpt.systemMemoryCleaner && memOpt.systemMemoryCleaner !== 'never')) {
        ipcRenderer.invoke('start-memory-services', memOpt).catch(err => console.error('[MemOpt] Failed to start services:', err));
    }
}

async function selectRenderer(element, renderer) {
    document.querySelectorAll('#tab-fflags .render-card[data-renderer]').forEach(c => c.classList.remove('active'));
    element.classList.add('active');
    settings.fflags.renderer = renderer;
    try { await ipcRenderer.invoke('save-settings', settings); showNotification(`Renderer set to ${renderer}`, 'success'); console.log('[FFlags] Renderer changed to:', renderer); }
    catch (error) { console.error('[FFlags] Failed to save renderer:', error); showNotification('Failed to save renderer setting', 'error'); }
}
