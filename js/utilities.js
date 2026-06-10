// TiRex RM — Utilities Tab
// Profile tools, friend actions, account utilities

function getSelectedUtilityAccount() {
    const accountSelect = document.getElementById('utilityAccountSelect');
    const accountId = accountSelect?.value || '';
    if (!accountId) { showNotification('Please select an account first', 'error'); return null; }
    const accountInfo = accounts.find(acc => String(acc.id) === String(accountId));
    if (!accountInfo) { showNotification('Account not found', 'error'); return null; }
    if (!accountInfo.cookie || !accountInfo.cookie.trim()) { showNotification('Selected account has no valid cookie', 'error'); return null; }
    return accountInfo;
}

async function ensureUtilityUserId(accountInfo) {
    if (accountInfo.userId) return String(accountInfo.userId);
    showNotification('Fetching user info...', 'info');
    const validation = await ipcRenderer.invoke('validate-cookie', { cookie: accountInfo.cookie, rbxIdCheck: getEffectiveAccountRbxIdCheck(accountInfo) });
    if (validation.valid && validation.userId) { accountInfo.userId = String(validation.userId); await saveAccounts(); return accountInfo.userId; }
    showNotification('Could not retrieve User ID from account', 'error');
    return null;
}

async function openUtilityUrl(url, pageLabel, accountInfo) {
    await ipcRenderer.invoke('open-browser-electron', { url, cookie: accountInfo.cookie, rbxIdCheck: getEffectiveAccountRbxIdCheck(accountInfo) });
    showNotification(`Opening ${pageLabel} for ${accountInfo.username}`, 'success');
}

async function openRobloxHome() { const a = getSelectedUtilityAccount(); if (!a) return; try { await openUtilityUrl('https://www.roblox.com/home', 'Roblox Home', a); } catch (e) { console.error('Error:', e); showNotification('Failed to open Roblox Home', 'error'); } }

async function openProfile() { const a = getSelectedUtilityAccount(); if (!a) return; try { const userId = await ensureUtilityUserId(a); if (!userId) return; await openUtilityUrl(`https://www.roblox.com/users/${userId}/profile`, 'Profile', a); } catch (e) { console.error('Error:', e); showNotification('Failed to open profile', 'error'); } }

async function openAvatarEditor() { const a = getSelectedUtilityAccount(); if (!a) return; try { await openUtilityUrl('https://www.roblox.com/my/avatar', 'Avatar Editor', a); } catch (e) { showNotification('Failed to open Avatar Editor', 'error'); } }

async function openInventory() { const a = getSelectedUtilityAccount(); if (!a) return; try { const userId = await ensureUtilityUserId(a); if (!userId) return; await openUtilityUrl(`https://www.roblox.com/users/${userId}/inventory`, 'Inventory', a); } catch (e) { showNotification('Failed to open Inventory', 'error'); } }

async function openFriendsPage() { const a = getSelectedUtilityAccount(); if (!a) return; try { const userId = await ensureUtilityUserId(a); if (!userId) return; await openUtilityUrl(`https://www.roblox.com/users/${userId}/friends#!/friends`, 'Friends', a); } catch (e) { showNotification('Failed to open Friends', 'error'); } }

async function openMessagesPage() { const a = getSelectedUtilityAccount(); if (!a) return; try { await openUtilityUrl('https://www.roblox.com/my/messages#!/inbox', 'Messages', a); } catch (e) { showNotification('Failed to open Messages', 'error'); } }

async function openCatalogPage() { const a = getSelectedUtilityAccount(); if (!a) return; try { await openUtilityUrl('https://www.roblox.com/catalog', 'Catalog', a); } catch (e) { showNotification('Failed to open Catalog', 'error'); } }

async function openGroupsPage() { const a = getSelectedUtilityAccount(); if (!a) return; try { await openUtilityUrl('https://www.roblox.com/my/groups', 'Groups', a); } catch (e) { showNotification('Failed to open Groups', 'error'); } }

async function openTradesPage() { const a = getSelectedUtilityAccount(); if (!a) return; try { await openUtilityUrl('https://www.roblox.com/trades', 'Trades', a); } catch (e) { showNotification('Failed to open Trades', 'error'); } }

async function copySelectedUserId() {
    const a = getSelectedUtilityAccount(); if (!a) return;
    try { const userId = await ensureUtilityUserId(a); if (!userId) return; clipboard.writeText(String(userId)); showNotification(`User ID copied: ${userId}`, 'success'); }
    catch (e) { showNotification('Failed to copy User ID', 'error'); }
}

async function followUser() {
    const userIdInput = document.getElementById('followUserId');
    const userIdValue = userIdInput.value.trim();
    const a = getSelectedUtilityAccount(); if (!a) return;
    if (!userIdValue) { showNotification('Please enter a user ID or URL', 'error'); return; }
    const userId = extractUserIdFromInput(userIdValue);
    if (!userId) { showNotification('Invalid user ID', 'error'); return; }
    try {
        const result = await ipcRenderer.invoke('follow-user', { userId, cookie: a.cookie, rbxIdCheck: getEffectiveAccountRbxIdCheck(a) });
        if (result.success) { showNotification('Successfully followed user', 'success'); userIdInput.value = ''; }
        else if (result.data && result.data.isCaptchaRequired) showNotification('Captcha required. Please follow manually in browser.', 'error');
        else { const message = result.data && result.data.errors && result.data.errors[0] ? result.data.errors[0].message : (result.error || 'Failed to follow'); showNotification(`Error: ${message}`, 'error'); }
    } catch (e) { console.error('Error following user:', e); showNotification(`Error: ${e.message}`, 'error'); }
}

async function sendFriendRequest() {
    const userIdInput = document.getElementById('friendRequestUserId');
    const userIdValue = userIdInput.value.trim();
    const a = getSelectedUtilityAccount(); if (!a) return;
    if (!userIdValue) { showNotification('Please enter a user ID or URL', 'error'); return; }
    const userId = extractUserIdFromInput(userIdValue);
    if (!userId) { showNotification('Invalid user ID', 'error'); return; }
    try {
        const result = await ipcRenderer.invoke('request-friendship', { userId, cookie: a.cookie, rbxIdCheck: getEffectiveAccountRbxIdCheck(a) });
        if (result.success) { showNotification('Friend request sent successfully', 'success'); userIdInput.value = ''; }
        else if (result.data && result.data.isCaptchaRequired) showNotification('Captcha required. Please send manually in browser.', 'error');
        else { const message = result.data && result.data.errors && result.data.errors[0] ? result.data.errors[0].message : (result.error || 'Failed to send request'); showNotification(`Error: ${message}`, 'error'); }
    } catch (e) { console.error('Error sending friend request:', e); showNotification(`Error: ${e.message}`, 'error'); }
}
