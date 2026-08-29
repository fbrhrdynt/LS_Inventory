"use strict";

const state = {
    view: "dashboard",
    itemsPage: 1,
    usersPage: 1,
    transactionsPage: 1,
    pageSize: 50,
    me: null
};

const $ = id => document.getElementById(id);
const api = async (url, options = {}) => {
    const response = await fetch(url, {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || `HTTP_${response.status}`);
        error.status = response.status;
        throw error;
    }
    return data;
};

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.remove("hidden");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add("hidden"), 2600);
}

function badge(value) {
    const text = String(value || "-");
    return `<span class="badge ${text.toLowerCase()}">${escapeHtml(text)}</span>`;
}

function formatDate(value) {
    if (!value) return "-";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? escapeHtml(value) : d.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
}

function online(lastSeen) {
    if (!lastSeen) return false;
    return Date.now() - new Date(lastSeen).getTime() < 180000;
}

async function checkSession() {
    try {
        const data = await api("/api/v1/admin/me");
        state.me = data.user;
        showApp();
    } catch (_) {
        showLogin();
    }
}

function showLogin() {
    $("appView").classList.add("hidden");
    $("loginView").classList.remove("hidden");
}

function showApp() {
    $("loginView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    $("adminIdentity").innerHTML = `<strong>${escapeHtml(state.me?.display_name || state.me?.username || "Admin")}</strong><br><span>${escapeHtml(state.me?.role || "ADMIN")}</span>`;
    navigate("dashboard");
}

$("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    $("loginError").textContent = "";
    try {
        const data = await api("/api/v1/admin/login", {
            method: "POST",
            body: JSON.stringify({ username: $("loginUsername").value.trim(), password: $("loginPassword").value })
        });
        state.me = data.user;
        $("loginPassword").value = "";
        showApp();
    } catch (error) {
        $("loginError").textContent = error.message === "INVALID_LOGIN" ? "Username atau password salah." : error.message;
    }
});

$("logoutBtn").addEventListener("click", async () => {
    try { await api("/api/v1/admin/logout", { method: "POST", body: "{}" }); } catch (_) {}
    showLogin();
});

function navigate(view) {
    state.view = view;
    document.querySelectorAll(".nav-item").forEach(btn => btn.classList.toggle("active", btn.dataset.view === view));
    document.querySelectorAll(".view").forEach(el => el.classList.add("hidden"));
    $(`${view}View`).classList.remove("hidden");
    $("sidebar").classList.remove("open");

    const titles = {
        dashboard: ["Dashboard", "Overview of LS Inventory"],
        items: ["Inventory", "Search, add, and manage items"],
        users: ["Users", "NFC users and access status"],
        transactions: ["Transactions", "Borrow, Return, and Consumable history"],
        devices: ["Devices & Maintenance", "Cabinet health and synchronization"],
        settings: ["Settings", "Central configuration distributed to cabinets"]
    };
    $("pageTitle").textContent = titles[view][0];
    $("pageSubtitle").textContent = titles[view][1];

    const loaders = { dashboard: loadDashboard, items: loadItems, users: loadUsers, transactions: loadTransactions, devices: loadDevices, settings: loadSettings };
    loaders[view]().catch(handleError);
}

document.querySelectorAll(".nav-item").forEach(btn => btn.addEventListener("click", () => navigate(btn.dataset.view)));
$("menuBtn").addEventListener("click", () => $("sidebar").classList.toggle("open"));

function handleError(error) {
    console.error(error);
    if (error.status === 401) return showLogin();
    $("connectionBadge").textContent = "Central Error";
    $("connectionBadge").className = "status-pill bad";
    toast(error.message || "Request failed");
}

async function loadDashboard() {
    const data = await api("/api/v1/admin/dashboard");
    $("connectionBadge").textContent = "Central Online";
    $("connectionBadge").className = "status-pill ok";
    const s = data.stats;
    $("dashboardView").innerHTML = `
        <div class="stat-grid">
            ${stat("Items", s.items)}${stat("Users", s.users)}${stat("Borrowed", s.borrowed)}${stat("Low Stock", s.low_stock)}${stat("Transactions", s.transactions)}${stat("Online Devices", s.online_devices)}
        </div>
        <div class="grid-2">
            <div class="panel">
                <div class="panel-head"><h3>Recent Transactions</h3><button class="btn ghost small" onclick="navigate('transactions')">View All</button></div>
                <div class="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Item</th><th>User</th><th>Device</th><th>Status</th></tr></thead><tbody>
                ${data.recent.length ? data.recent.map(t => `<tr><td>${formatDate(t.occurred_at)}</td><td>${badge(t.action)}</td><td><strong>${escapeHtml(t.item_code || "-")}</strong><br><span class="muted">${escapeHtml(t.item_name || "")}</span></td><td>${escapeHtml(t.user_name || "-")}</td><td>${escapeHtml(t.device_id || "-")}</td><td>${badge(t.status)}</td></tr>`).join("") : `<tr><td colspan="6" class="empty">No transactions yet.</td></tr>`}
                </tbody></table></div>
            </div>
            <div class="panel">
                <div class="panel-head"><h3>Quick Actions</h3></div>
                <div class="quick-actions" style="padding:18px">
                    <button class="btn ghost" onclick="navigate('items'); setTimeout(openNewItem,150)">+ Add Item</button>
                    <button class="btn ghost" onclick="navigate('users'); setTimeout(openNewUser,150)">+ Add User</button>
                    <button class="btn ghost" onclick="navigate('devices')">Device Maintenance</button>
                    <button class="btn ghost" onclick="navigate('settings')">System Settings</button>
                </div>
            </div>
        </div>`;
}

function stat(label, value) {
    return `<div class="stat-card"><span>${escapeHtml(label)}</span><strong>${Number(value || 0).toLocaleString("id-ID")}</strong></div>`;
}

let itemSearchTimer;
$("itemSearch").addEventListener("input", () => { clearTimeout(itemSearchTimer); itemSearchTimer = setTimeout(() => { state.itemsPage = 1; loadItems().catch(handleError); }, 250); });
$("itemTypeFilter").addEventListener("change", () => { state.itemsPage = 1; loadItems().catch(handleError); });
$("itemStatusFilter").addEventListener("change", () => { state.itemsPage = 1; loadItems().catch(handleError); });
$("addItemBtn").addEventListener("click", openNewItem);

async function loadItems() {
    const q = new URLSearchParams({ page: state.itemsPage, limit: state.pageSize });
    if ($("itemSearch").value.trim()) q.set("search", $("itemSearch").value.trim());
    if ($("itemTypeFilter").value) q.set("type", $("itemTypeFilter").value);
    if ($("itemStatusFilter").value) q.set("status", $("itemStatusFilter").value);
    const data = await api(`/api/v1/admin/items?${q}`);
    $("itemsBody").innerHTML = data.data.length ? data.data.map(item => `<tr>
        <td><strong>${escapeHtml(item.ITEM_CODE)}</strong><br><span class="muted">${escapeHtml(item.ITEM_NO)}</span></td>
        <td><strong>${escapeHtml(item.ITEM_NAME)}</strong><br><span class="muted">${escapeHtml(item.CATEGORY)}</span></td>
        <td>${escapeHtml(item.TYPE)}</td><td>${escapeHtml(item.STOCK)}</td><td>${badge(item.STATUS)}</td><td>${escapeHtml(item.LOCATION || "-")}</td><td>${escapeHtml(item.BORROWED_BY_NAME || "-")}</td>
        <td style="white-space:nowrap"><button class="btn ghost small" data-qr-item='${encodeURIComponent(JSON.stringify(item))}'>QR</button> <button class="btn ghost small" data-edit-item='${encodeURIComponent(JSON.stringify(item))}'>Edit</button></td></tr>`).join("") : `<tr><td colspan="8" class="empty">No items found.</td></tr>`;
    document.querySelectorAll("[data-qr-item]").forEach(btn => btn.addEventListener("click", () => showItemQr(JSON.parse(decodeURIComponent(btn.dataset.qrItem)))));
    document.querySelectorAll("[data-edit-item]").forEach(btn => btn.addEventListener("click", () => openEditItem(JSON.parse(decodeURIComponent(btn.dataset.editItem)))));
    renderPager("itemsPager", data, page => { state.itemsPage = page; loadItems().catch(handleError); });
}

function openNewItem() {
    openModal("Add Item", itemForm(), async form => {
        const payload = Object.fromEntries(new FormData(form).entries());
        payload.stock = Number(payload.stock || 0);
        const created = await api("/api/v1/admin/items", { method: "POST", body: JSON.stringify(payload) });
        toast(`Item ${created.data.ITEM_CODE} added`);
        loadItems().catch(handleError);
        loadDashboard().catch(()=>{});
        await showItemQr(created.data, true);
    });
}

function openEditItem(item) {
    openModal("Edit Item", itemForm(item), async form => {
        const payload = Object.fromEntries(new FormData(form).entries());
        payload.stock = Number(payload.stock || 0);
        await api(`/api/v1/admin/items/${encodeURIComponent(item.UUID)}`, { method: "PUT", body: JSON.stringify(payload) });
        closeModal(); toast("Item updated"); loadItems().catch(handleError);
    });
}

function itemForm(item = {}) {
    const editing = Boolean(item.UUID);
    return `
        <label class="full-row">Item Name<input name="item_name" required value="${escapeHtml(item.ITEM_NAME || "")}"></label>
        ${editing ? `<label>Item Code<input value="${escapeHtml(item.ITEM_CODE || "")}" readonly></label><label>Item Number<input value="${escapeHtml(item.ITEM_NO || "")}" readonly></label>` : `<div class="full-row" style="padding:12px 14px;border:1px solid #dbe4ef;border-radius:12px;background:#f8fafc;font-size:13px"><strong>Item Code otomatis</strong><br><span class="muted">Sistem akan membuat 5 digit acak: ITEM_00000 sampai ITEM_99999.</span></div>`}
        <label>Category<input name="category" value="${escapeHtml(item.CATEGORY || "")}"></label>
        <label>Location<input name="location" value="${escapeHtml(item.LOCATION || "")}"></label>
        <label>Type<select name="type"><option ${item.TYPE === "BORROWABLE" ? "selected" : ""}>BORROWABLE</option><option ${item.TYPE === "CONSUMABLE" ? "selected" : ""}>CONSUMABLE</option></select></label>
        <label>Stock<input name="stock" type="number" min="0" value="${escapeHtml(item.STOCK ?? 1)}"></label>
        <div class="form-actions"><button type="button" class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" type="submit">Save Item</button></div>`;
}

async function showItemQr(item, createdNow = false) {
    const qr = await api(`/api/v1/admin/items/${encodeURIComponent(item.UUID)}/qr`);
    const current = qr.item;

    openModal(createdNow ? "Item Added · QR Ready" : "Item QR", `
        <div class="full-row" style="text-align:center">
            <div style="font-weight:800;font-size:18px;margin-bottom:4px">${escapeHtml(current.ITEM_NAME)}</div>
            <div style="font-weight:800;color:#1769e0;font-size:20px">${escapeHtml(current.ITEM_CODE)}</div>
            <div class="muted" style="margin-bottom:14px">Item Number: ${escapeHtml(current.ITEM_NO)}</div>
            <img id="itemQrPreview" src="${qr.data_url}" alt="QR ${escapeHtml(current.ITEM_CODE)}" style="display:block;width:min(320px,90%);height:auto;margin:0 auto 14px;border:1px solid #e3eaf3;border-radius:16px;padding:10px;background:white">
            <div style="font-size:11px;word-break:break-all;color:#64748b;margin-bottom:16px">QR content: ${escapeHtml(qr.qr_code)}</div>
            <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
                <button id="printQrBtn" type="button" class="btn primary">Print QR Label</button>
                <button type="button" class="btn ghost" onclick="closeModal()">Close</button>
            </div>
        </div>
    `);

    $("printQrBtn").addEventListener("click", () => printQrLabel(current, qr.data_url));
}

function printQrLabel(item, dataUrl) {
    const win = window.open("", "_blank", "width=520,height=700");
    if (!win) return toast("Popup blocked. Allow popups to print QR.");
    win.document.write(`<!doctype html><html><head><title>${escapeHtml(item.ITEM_CODE)}</title><style>body{font-family:Arial,sans-serif;margin:0;display:flex;justify-content:center;background:#fff}.label{width:220px;text-align:center;padding:16px}.name{font-size:12px;font-weight:700;margin-bottom:5px}.code{font-size:15px;font-weight:800;margin-bottom:4px}.no{font-size:18px;font-weight:900;letter-spacing:2px;margin-top:4px}img{width:170px;height:170px;object-fit:contain}@media print{body{margin:0}.label{break-inside:avoid}}</style></head><body><div class="label"><div class="name">${escapeHtml(item.ITEM_NAME)}</div><div class="code">${escapeHtml(item.ITEM_CODE)}</div><img src="${dataUrl}"><div class="no">${escapeHtml(item.ITEM_NO)}</div></div><script>window.onload=()=>{window.print();};<\/script></body></html>`);
    win.document.close();
}

let userSearchTimer;
$("userSearch").addEventListener("input", () => { clearTimeout(userSearchTimer); userSearchTimer = setTimeout(() => { state.usersPage = 1; loadUsers().catch(handleError); }, 250); });
$("addUserBtn").addEventListener("click", openNewUser);

async function loadUsers() {
    const q = new URLSearchParams({ page: state.usersPage, limit: state.pageSize });
    if ($("userSearch").value.trim()) q.set("search", $("userSearch").value.trim());
    const data = await api(`/api/v1/admin/users?${q}`);
    $("usersBody").innerHTML = data.data.length ? data.data.map(user => `<tr>
        <td><strong>${escapeHtml(user.NAME)}</strong></td><td>${escapeHtml(user.EMPLOYEE_ID || "-")}</td><td>${escapeHtml(user.CARD_UID || "-")}</td><td>${escapeHtml(user.DEPARTMENT || "-")}</td><td>${escapeHtml(user.ROLE)}</td><td>${badge(user.ACTIVE === "TRUE" ? "ACTIVE" : "INACTIVE")}</td>
        <td><button class="btn ghost small" data-edit-user='${encodeURIComponent(JSON.stringify(user))}'>Edit</button></td></tr>`).join("") : `<tr><td colspan="7" class="empty">No users found.</td></tr>`;
    document.querySelectorAll("[data-edit-user]").forEach(btn => btn.addEventListener("click", () => openEditUser(JSON.parse(decodeURIComponent(btn.dataset.editUser)))));
    renderPager("usersPager", data, page => { state.usersPage = page; loadUsers().catch(handleError); });
}

function openNewUser() {
    openModal("Add User", userForm(), async form => {
        const payload = Object.fromEntries(new FormData(form).entries());
        payload.active = payload.active === "true";
        await api("/api/v1/admin/users", { method: "POST", body: JSON.stringify(payload) });
        closeModal(); toast("User added"); loadUsers().catch(handleError);
    });
    bindNfcCaptureButton();
}

function openEditUser(user) {
    openModal("Edit User", userForm(user), async form => {
        const payload = Object.fromEntries(new FormData(form).entries());
        payload.active = payload.active === "true";
        await api(`/api/v1/admin/users/${encodeURIComponent(user.UUID)}`, { method: "PUT", body: JSON.stringify(payload) });
        closeModal(); toast("User updated"); loadUsers().catch(handleError);
    });
    bindNfcCaptureButton();
}

function userForm(user = {}) {
    const active = user.ACTIVE !== "FALSE";
    return `
        <label class="full-row">Name<input name="name" required value="${escapeHtml(user.NAME || "")}"></label>
        <label>Employee ID<input name="employee_id" value="${escapeHtml(user.EMPLOYEE_ID || "")}"></label>
        <label>Card UID<input name="card_uid" placeholder="Tap card using button below" value="${escapeHtml(user.CARD_UID || "")}"></label>
        <label>Department<input name="department" value="${escapeHtml(user.DEPARTMENT || "")}"></label>
        <div class="full-row" style="padding:14px;border:1px solid #dbe4ef;border-radius:12px;background:#f8fafc">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
                <div><strong>NFC Card Reader</strong><div id="nfcCaptureStatus" class="muted" style="font-size:12px;margin-top:3px">Click Read NFC Card, then tap the new card on RC522.</div></div>
                <button id="readNfcBtn" type="button" class="btn ghost">Read NFC Card</button>
            </div>
        </div>
        <label>Role<select name="role"><option ${user.ROLE !== "ADMIN" ? "selected" : ""}>USER</option><option ${user.ROLE === "ADMIN" ? "selected" : ""}>ADMIN</option></select></label>
        <label>Status<select name="active"><option value="true" ${active ? "selected" : ""}>ACTIVE</option><option value="false" ${!active ? "selected" : ""}>INACTIVE</option></select></label>
        <div class="form-actions"><button type="button" class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" type="submit">Save User</button></div>`;
}

function bindNfcCaptureButton() {
    const button = $("readNfcBtn");
    const status = $("nfcCaptureStatus");
    if (!button || !status) return;

    button.addEventListener("click", async () => {
        const cardInput = document.querySelector('#modalForm [name="card_uid"]');
        button.disabled = true;
        button.textContent = "Waiting for card...";
        status.textContent = "Cabinet app is paused temporarily. Tap one NFC card on the RC522 within 30 seconds.";

        try {
            const result = await api("/api/v1/admin/nfc-capture", {
                method: "POST",
                body: JSON.stringify({ timeout_seconds: 30 })
            });
            if (cardInput) cardInput.value = result.card_uid || "";
            status.textContent = `Card detected: ${result.card_uid}. Cabinet app restarted automatically.`;
            toast(`NFC detected: ${result.card_uid}`);
        } catch (error) {
            console.error(error);
            status.textContent = error.message === "NFC_CAPTURE_TIMEOUT" ? "No card detected. Try again." : `NFC read failed: ${error.message}`;
            toast(error.message === "NFC_CAPTURE_TIMEOUT" ? "No NFC card detected" : `NFC read failed: ${error.message}`);
        } finally {
            button.disabled = false;
            button.textContent = "Read NFC Card";
        }
    });
}

let trxSearchTimer;
$("trxSearch").addEventListener("input", () => { clearTimeout(trxSearchTimer); trxSearchTimer = setTimeout(() => { state.transactionsPage = 1; loadTransactions().catch(handleError); }, 250); });
$("trxActionFilter").addEventListener("change", () => { state.transactionsPage = 1; loadTransactions().catch(handleError); });

async function loadTransactions() {
    const q = new URLSearchParams({ page: state.transactionsPage, limit: state.pageSize });
    if ($("trxSearch").value.trim()) q.set("search", $("trxSearch").value.trim());
    if ($("trxActionFilter").value) q.set("action", $("trxActionFilter").value);
    const data = await api(`/api/v1/admin/transactions?${q}`);
    $("transactionsBody").innerHTML = data.data.length ? data.data.map(t => `<tr><td>${formatDate(t.occurred_at)}</td><td>${badge(t.action)}</td><td><strong>${escapeHtml(t.item_code || "-")}</strong><br><span class="muted">${escapeHtml(t.item_name || "")}</span></td><td>${escapeHtml(t.user_name || "-")}</td><td>${escapeHtml(t.qty)}</td><td>${escapeHtml(t.device_id)}</td><td>${badge(t.status)}</td></tr>`).join("") : `<tr><td colspan="7" class="empty">No transactions found.</td></tr>`;
    renderPager("transactionsPager", data, page => { state.transactionsPage = page; loadTransactions().catch(handleError); });
}

async function loadDevices() {
    const data = await api("/api/v1/admin/devices");
    $("devicesGrid").innerHTML = data.data.length ? data.data.map(d => {
        const isOnline = online(d.last_seen_at);
        return `<article class="device-card"><div class="device-title"><div><h3>${escapeHtml(d.name)}</h3><p>${escapeHtml(d.device_id)} · ${escapeHtml(d.location || "No location")}</p></div>${badge(isOnline ? "ACTIVE" : "INACTIVE")}</div><div class="device-metrics">
            ${metric("Last Seen", formatDate(d.last_seen_at))}${metric("Last Sync", formatDate(d.last_sync_at))}${metric("NFC", d.nfc_status || "-")}${metric("Camera", d.camera_status || "-")}${metric("Pending", d.pending_count ?? 0)}${metric("CPU", d.cpu_temperature == null ? "-" : `${d.cpu_temperature} °C`)}${metric("Disk", d.disk_usage == null ? "-" : `${d.disk_usage}%`)}${metric("Uptime", humanUptime(d.uptime_seconds))}
        </div></article>`;
    }).join("") : `<div class="panel empty">No devices registered.</div>`;
}

function metric(label, value) { return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? "-")}</strong></div>`; }
function humanUptime(seconds) { const s = Number(seconds || 0); if (!s) return "-"; const d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60); return `${d}d ${h}h ${m}m`; }

async function loadSettings() {
    const data = await api("/api/v1/admin/settings");
    $("settingSystemName").value = data.admin.SYSTEM_NAME || data.admin.SYSTEMA_NAME || "LS Inventory";
    $("settingDeviceName").value = data.admin.DEVICE_NAME || "LS Cabinet 01";
    $("settingVersion").value = data.admin.VERSION || "1.0.0";
    $("settingLowStock").value = data.settings.LOW_STOCK_THRESHOLD || "5";
    $("settingTimezone").value = data.settings.TIMEZONE || "Asia/Jakarta";
    $("settingSyncInterval").value = data.settings.SYNC_INTERVAL || "60";
}

$("saveSettingsBtn").addEventListener("click", async () => {
    try {
        await api("/api/v1/admin/settings", { method: "PUT", body: JSON.stringify({
            admin: { SYSTEM_NAME: $("settingSystemName").value.trim(), DEVICE_NAME: $("settingDeviceName").value.trim(), VERSION: $("settingVersion").value.trim() },
            settings: { LOW_STOCK_THRESHOLD: $("settingLowStock").value, TIMEZONE: $("settingTimezone").value.trim(), SYNC_INTERVAL: $("settingSyncInterval").value }
        }) });
        toast("Settings saved. Cabinets will receive the update on next sync.");
    } catch (error) { handleError(error); }
});

function renderPager(id, data, onPage) {
    const el = $(id);
    if (data.pages <= 1) { el.innerHTML = `<span>${Number(data.total).toLocaleString("id-ID")} records</span>`; return; }
    el.innerHTML = `<button class="btn ghost small" ${data.page <= 1 ? "disabled" : ""}>Prev</button><span>Page ${data.page} / ${data.pages} · ${Number(data.total).toLocaleString("id-ID")} records</span><button class="btn ghost small" ${data.page >= data.pages ? "disabled" : ""}>Next</button>`;
    const buttons = el.querySelectorAll("button");
    buttons[0].addEventListener("click", () => onPage(data.page - 1));
    buttons[1].addEventListener("click", () => onPage(data.page + 1));
}

function openModal(title, html, submitHandler = null) {
    $("modalTitle").textContent = title;
    $("modalForm").innerHTML = html;
    $("modal").classList.remove("hidden");
    $("modalForm").onsubmit = async event => {
        event.preventDefault();
        if (typeof submitHandler !== "function") return;
        const submit = event.submitter;
        if (submit) submit.disabled = true;
        try { await submitHandler(event.currentTarget); }
        catch (error) { handleError(error); }
        finally { if (submit) submit.disabled = false; }
    };
}

function closeModal() { $("modal").classList.add("hidden"); }
window.closeModal = closeModal;
window.navigate = navigate;
window.openNewItem = openNewItem;
window.openNewUser = openNewUser;
$("modalClose").addEventListener("click", closeModal);
$("modal").addEventListener("click", event => { if (event.target === $("modal")) closeModal(); });

checkSession();
