// TiRex RM — Servers Tab
// Favorites, server list, game preview, join

let currentGameInfo = null;

function renderFavoriteGames() {
    const list = document.getElementById('favoriteGamesList');
    if (!list) return;
    list.innerHTML = '';
    const favs = settings.favoriteGames || [];
    if (favs.length === 0) { list.innerHTML = '<div style="text-align: center; opacity: 0.3; font-size: 11px; padding: 10px;">No favorites saved</div>'; return; }
    favs.forEach((fav, index) => {
        const item = document.createElement('div');
        item.className = 'fflag-kv';
        item.style.cssText = 'padding: 8px; background: rgba(255,255,255,0.03); border-radius: 8px; justify-content: space-between;';
        item.innerHTML = `<div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; margin-right: 10px;"><div style="font-weight: 600; font-size: 12px; color: var(--text);">${fav.alias || 'Untitled'}</div><div style="font-size: 10px; opacity: 0.5; font-family: monospace;">${fav.id}</div></div><div style="display: flex; gap: 6px;"><button class="btn btn-secondary" onclick="applyFavoriteGame('${fav.id}')" style="padding: 4px 8px; font-size: 10px;">Select</button><button class="btn btn-secondary" onclick="removeFavoriteGame(${index})" style="padding: 4px 8px; font-size: 10px; color: #ff5555;">X</button></div>`;
        list.appendChild(item);
    });
}

async function addFavoriteGame() {
    const idInput = document.getElementById('favPlaceId');
    const aliasInput = document.getElementById('favAlias');
    const id = idInput.value.trim();
    const alias = aliasInput.value.trim();
    if (!id) { showNotification('Please enter a Place ID', 'warning'); return; }
    if (!settings.favoriteGames) settings.favoriteGames = [];
    settings.favoriteGames.push({ id, alias: alias || ('Game ' + id) });
    idInput.value = ''; aliasInput.value = '';
    try { await ipcRenderer.invoke('save-settings', settings); renderFavoriteGames(); showNotification('Added to favorites', 'success'); }
    catch (error) { console.error('Failed to save favorites:', error); }
}

async function removeFavoriteGame(index) {
    if (!settings.favoriteGames) return;
    settings.favoriteGames.splice(index, 1);
    try { await ipcRenderer.invoke('save-settings', settings); renderFavoriteGames(); }
    catch (error) { console.error('Failed to remove favorite:', error); }
}

function applyFavoriteGame(id) {
    const placeIdInput = document.getElementById('placeId');
    if (placeIdInput) { placeIdInput.value = id; fetchGamePreview(); showNotification('Game ID selected', 'info'); }
}

async function fetchGamePreview() {
    const placeIdInput = document.getElementById("placeId").value.trim();
    function extractId(input) { if (!input) return null; const urlMatch = input.match(/\/games\/(\d+)\//); if (urlMatch) return urlMatch[1]; if (/^\d+$/.test(input)) return input; return null; }
    const placeId = extractId(placeIdInput);
    if (!placeId) { showNotification("Enter a valid Place ID or game URL", "error"); return; }
    try {
        showNotification("Fetching game info...", "info");
        const gameInfo = await ipcRenderer.invoke("fetch-game-info", { id: placeId, mode: "place" });
        if (gameInfo.error) throw new Error(gameInfo.error);
        currentGameInfo = gameInfo;
        const setSafeText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        setSafeText("gameName", gameInfo.name); setSafeText("gameCreator", `by ${gameInfo.creator}`);
        setSafeText("gameDescription", gameInfo.description); setSafeText("gamePlaying", gameInfo.playing?.toLocaleString() || "0");
        setSafeText("gameVisits", gameInfo.visits?.toLocaleString() || "0"); setSafeText("gameLikes", gameInfo.likes?.toLocaleString() || "0");
        setSafeText("gameMaxPlayers", gameInfo.maxPlayers || "N/A"); setSafeText("gameFavorites", gameInfo.favoritedCount?.toLocaleString() || "0");
        setSafeText("gameGenre", gameInfo.genre || "All");
        if (gameInfo.updated) { const date = new Date(gameInfo.updated); setSafeText("gameUpdated", date.toLocaleDateString()); }
        else setSafeText("gameUpdated", "N/A");
        const thumb = document.getElementById("gameThumbnail"); if (thumb) thumb.src = gameInfo.thumbnail;
        const previewEl = document.getElementById("gamePreview"); if (previewEl) { previewEl.style.display = "flex"; previewEl.classList.add("active"); }
        showNotification("Game loaded", "success");
    } catch (error) { showNotification(`Failed: ${error.message}`, "error"); }
}

async function loadServerList() {
    const placeIdInput = document.getElementById("placeId").value.trim();
    function extractId(input) { if (!input) return null; const urlMatch = input.match(/\/games\/(\d+)\//); if (urlMatch) return urlMatch[1]; if (/^\d+$/.test(input)) return input; return null; }
    const placeId = extractId(placeIdInput);
    if (!placeId) { showNotification("Enter a valid Place ID or game URL", "error"); return; }
    try {
        showNotification("Loading servers...", "info");
        const servers = await ipcRenderer.invoke("fetch-server-list", { id: placeId, mode: "place" });
        if (servers.error) throw new Error(servers.error);
        const serverList = document.getElementById("serverList");
        serverList.innerHTML = "";
        if (!servers || servers.length === 0) { serverList.innerHTML = '<div class="empty-state"><div class="empty-text">No servers available</div></div>'; return; }
        servers.forEach((server) => {
            const item = document.createElement("div");
            item.className = "server-card-premium";
            item.onclick = (e) => {
                if (e.target.classList.contains('server-id-mini')) return;
                document.getElementById("jobId").value = server.id;
                document.querySelectorAll(".server-card-premium").forEach((i) => i.classList.remove("selected"));
                item.classList.add("selected");
                showNotification("Server selected", "success");
            };
            item.innerHTML = `<div class="server-card-inner"><div class="server-card-top"><div class="server-players-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: var(--primary);"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle></svg><span style="font-size: 14px;">${server.playing}/${server.maxPlayers}</span></div><div class="server-ping-badge ${server.ping < 100 ? 'good' : server.ping < 200 ? 'medium' : 'bad'}">${server.ping || '?'} ms</div></div><div class="server-card-bottom"><div class="server-fps-tag"><div class="tag-label">ENGINE</div><div class="tag-value">${server.fps ? server.fps.toFixed(0) : 60} FPS</div></div><div class="server-id-mini" title="Click to copy ID" onclick="navigator.clipboard.writeText('${server.id}'); showNotification('Job ID copied!', 'success');">${server.id.substring(0, 10)}...</div></div></div>`;
            serverList.appendChild(item);
        });
        showNotification(`Loaded ${servers.length} servers`, "success");
    } catch (error) { showNotification(`Failed: ${error.message}`, "error"); }
}

async function resolveServerLaunchData(payload, resolverCookie) {
    const placeIdInput = (payload.placeIdInput || "").trim();
    let jobId = (payload.jobId || "").trim();
    const privateServerInputRaw = (payload.privateServerInputRaw || "").trim();
    let privateServerInput = privateServerInputRaw;
    if (!privateServerInput && jobId && (jobId.includes("privateServerLinkCode") || jobId.includes("roblox.com/share") || jobId.includes("roblox.com/share-links") || jobId.includes("ro.blox.com"))) { privateServerInput = jobId; jobId = ""; }
    const shareLinkPattern = /roblox\.com\/share|roblox\.com\/share-links|ro\.blox\.com/i;
    const shareLinkInput = shareLinkPattern.test(privateServerInput) ? privateServerInput : (shareLinkPattern.test(placeIdInput) ? placeIdInput : "");
    const isShareLink = !!shareLinkInput;
    const psSaveCandidate = privateServerInput || shareLinkInput;
    if (psSaveCandidate) persistPrivateServerUrl(psSaveCandidate);
    const privateServerLooksLikeLink = !!privateServerInput && (/roblox\.com|ro\.blox\.com/i.test(privateServerInput) || privateServerInput.includes("privateServerLinkCode"));
    let inputForGame = placeIdInput || privateServerInput;
    if (privateServerLooksLikeLink) inputForGame = privateServerInput;
    function extractId(input) { if (!input) return null; const urlMatch = input.match(/\/games\/(\d+)\//); if (urlMatch) return urlMatch[1]; if (/^\d+$/.test(input)) return input; return null; }
    function extractPrivateServerLinkCode(input) { if (!input) return null; const match = input.match(/privateServerLinkCode=([^&]+)/i); if (match && match[1]) { try { return decodeURIComponent(match[1]); } catch { return match[1]; } } return null; }
    if (!inputForGame) throw new Error("Enter a Place ID or link");
    const cleanPlaceId = extractId(inputForGame);
    const explicitPrivateServerLinkCode = extractPrivateServerLinkCode(privateServerInput || placeIdInput);
    if (!cleanPlaceId && !isShareLink) throw new Error("Invalid Place ID or link. If you only have a private server code, enter the Place ID too.");
    let finalPlaceId = cleanPlaceId;
    let finalPrivateServerLinkCode = explicitPrivateServerLinkCode;
    if (isShareLink) {
        showNotification("Resolving share link...", "info");
        const shareResult = await ipcRenderer.invoke("resolve-share-link", { input: shareLinkInput, cookie: resolverCookie });
        if (!shareResult || !shareResult.success) throw new Error(shareResult?.error || "Failed to resolve share link");
        finalPlaceId = shareResult.placeId; finalPrivateServerLinkCode = shareResult.privateServerLinkCode;
    } else {
        if (currentGameInfo && cleanPlaceId && currentGameInfo.placeId.toString() === cleanPlaceId) { finalPlaceId = currentGameInfo.placeId; if (!finalPrivateServerLinkCode && currentGameInfo.privateServerLinkCode) finalPrivateServerLinkCode = currentGameInfo.privateServerLinkCode; }
        else { try { showNotification("Resolving Game ID/Link...", "info"); const gameInfo = await ipcRenderer.invoke("fetch-game-info", { id: inputForGame, mode: "place" }); if (gameInfo && gameInfo.placeId) { finalPlaceId = gameInfo.placeId; if (!finalPrivateServerLinkCode && gameInfo.privateServerLinkCode) finalPrivateServerLinkCode = gameInfo.privateServerLinkCode; currentGameInfo = gameInfo; } } catch (error) { console.warn("Failed to resolve ID:", error); } }
    }
    if (!finalPlaceId) throw new Error("Failed to resolve Place ID");
    return { placeId: finalPlaceId, jobId, privateServerLinkCode: finalPrivateServerLinkCode || null };
}

async function joinGame() {
    if (!robloxVersions.installed.length) { showNotification("No Roblox version installed", "error"); return; }
    const payload = { placeIdInput: document.getElementById("placeId").value.trim(), jobId: document.getElementById("jobId").value.trim(), privateServerInputRaw: document.getElementById("privateServerLink").value.trim() };
    if (!payload.placeIdInput && !payload.jobId && !payload.privateServerInputRaw) { showNotification("Enter a Place ID or link", "error"); return; }
    openAccountLaunchSelectModal({ type: "server", payload, preselectedAccountIds: [] });
}
