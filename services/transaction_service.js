"use strict";

require("dotenv").config({
    path: "/opt/LS_Inventory/.env",
    quiet: true
});

const crypto = require("crypto");

const local = require("./local_database");
const central = require("./central_api");

function normalize(value) {
    return String(value ?? "").trim().toUpperCase();
}

function getTimeConfig() {
    const settings = local.getSettingsObject();
    return {
        timezone: String(settings.TIMEZONE || "Asia/Jakarta"),
        gmtOffset: String(settings.GMT_OFFSET || "+07:00"),
        location: String(settings.LOCATION || "")
    };
}

function formatSystemTimestamp(date = new Date()) {
    const { timezone } = getTimeConfig();
    try {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        }).formatToParts(date);
        const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
        return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
    } catch (_) {
        return date.toISOString().replace("T", " ").slice(0, 19);
    }
}

function getLowStockThreshold() {
    const settings = local.getSettingsObject();
    const n = Number(settings.LOW_STOCK_THRESHOLD);
    return Number.isFinite(n) && n >= 0 ? n : 5;
}

function getDeviceName() {
    const admin = local.getAdminObject();
    return String(admin.DEVICE_NAME || process.env.DEVICE_NAME || process.env.DEVICE_ID || "LS Cabinet 01").trim();
}

function generateTransactionId() {
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return `TRX-${stamp}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function consumableStatus(stock) {
    if (stock <= 0) return "OUT_OF_STOCK";
    if (stock <= getLowStockThreshold()) return "LOW_STOCK";
    return "AVAILABLE";
}

function toCentralPayload(transaction) {
    return {
        transaction_uuid: transaction.transaction_uuid,
        transaction_id: transaction.transactionId,
        item_uuid: transaction.itemUUID,
        user_uuid: transaction.userUUID,
        action: transaction.action,
        qty: transaction.qty,
        occurred_at: transaction.occurred_at,
        metadata: {
            local_timestamp: transaction.timestamp,
            item_code: transaction.itemCode,
            item_name: transaction.itemName,
            user_name: transaction.userName,
            card_uid: transaction.cardUID,
            location: getTimeConfig().location
        }
    };
}

function centralItemToLocal(item) {
    if (!item) return;
    local.upsertItem(item);
}

function buildTransaction(user, item, action, qty, status) {
    const transactionUuid = crypto.randomUUID();
    const transactionId = generateTransactionId();
    const now = new Date();
    const deviceId = String(process.env.DEVICE_ID || process.env.DEVICE_NAME || "LS_Cab_Main").trim();

    return {
        transaction_uuid: transactionUuid,
        transactionId,
        transaction_id: transactionId,
        timestamp: formatSystemTimestamp(now),
        occurred_at: now.toISOString(),
        userUUID: user.UUID || user.uuid || "",
        user_uuid: user.UUID || user.uuid || "",
        userName: user.NAME || user.name || "",
        user_name: user.NAME || user.name || "",
        cardUID: user.CARD_UID || user.card_uid || "",
        card_uid: user.CARD_UID || user.card_uid || "",
        action,
        itemUUID: item.UUID || item.uuid || "",
        item_uuid: item.UUID || item.uuid || "",
        itemCode: item.ITEM_CODE || item.item_code || "",
        item_code: item.ITEM_CODE || item.item_code || "",
        itemName: item.ITEM_NAME || item.item_name || "",
        item_name: item.ITEM_NAME || item.item_name || "",
        qty,
        status,
        device: getDeviceName(),
        device_id: deviceId
    };
}

function rowToLegacyItem(row) {
    if (!row) return null;
    return local.localRowToItem(row);
}

async function tryImmediateSync(transaction, payload) {
    try {
        const response = await central.pushTransactions([payload]);
        const result = response.results?.[0];
        if (!result) throw new Error("EMPTY_CENTRAL_RESPONSE");

        if (result.success) {
            local.markTransactionSynced(transaction.transaction_uuid);
            if (result.item) centralItemToLocal(result.item);
            local.exportCaches();
            return { synced: true, pending: false, rejected: false };
        }

        if (result.error === "SERVER_TRANSACTION_ERROR") {
            local.markTransactionRetry(transaction.transaction_uuid, result.error);
            return { synced: false, pending: true, rejected: false, message: result.error };
        }

        local.markTransactionRejected(transaction.transaction_uuid, result.error || "REJECTED");
        if (result.item) centralItemToLocal(result.item);
        local.exportCaches();
        return { synced: false, pending: false, rejected: true, message: result.error || "REJECTED" };
    } catch (error) {
        local.markTransactionRetry(transaction.transaction_uuid, error.message);
        return { synced: false, pending: true, rejected: false, message: error.message };
    }
}

async function createBorrow(user, item) {
    if (!user) throw new Error("User tidak tersedia.");
    if (!item) throw new Error("Item tidak tersedia.");

    local.initLocalDatabase();
    const current = local.getItemByUuid(item.UUID || item.uuid);
    if (!current) throw new Error("Item tidak ditemukan di database lokal.");
    if (normalize(current.type) !== "BORROWABLE") throw new Error("Item bukan tipe BORROWABLE.");
    if (normalize(current.status) !== "AVAILABLE") throw new Error(`Item tidak dapat dipinjam. Status: ${current.status || "UNKNOWN"}`);

    const transaction = buildTransaction(user, rowToLegacyItem(current), "BORROW", 1, "BORROWED");
    const payload = toCentralPayload(transaction);

    local.db.exec("BEGIN IMMEDIATE");
    try {
        local.updateLocalItemAfterAction({
            itemUuid: current.uuid,
            status: "BORROWED",
            stock: current.stock,
            borrowedByUuid: transaction.userUUID,
            borrowedByName: transaction.userName,
            borrowedAt: transaction.timestamp
        });
        local.insertLocalTransaction(transaction, payload);
        local.db.exec("COMMIT");
    } catch (error) {
        try { local.db.exec("ROLLBACK"); } catch (_) {}
        throw error;
    }

    local.exportCaches();
    const sync = await tryImmediateSync(transaction, payload);
    if (sync.rejected) throw new Error(`Central rejected BORROW: ${sync.message}`);

    return { success: true, synced: sync.synced, pending: sync.pending, message: sync.message, transaction, item: rowToLegacyItem(local.getItemByUuid(current.uuid)) };
}

async function createReturn(user, item) {
    if (!user) throw new Error("User tidak tersedia.");
    if (!item) throw new Error("Item tidak tersedia.");

    local.initLocalDatabase();
    const current = local.getItemByUuid(item.UUID || item.uuid);
    if (!current) throw new Error("Item tidak ditemukan di database lokal.");
    if (normalize(current.type) !== "BORROWABLE") throw new Error("Item bukan tipe BORROWABLE.");
    if (normalize(current.status) !== "BORROWED") throw new Error(`Item tidak dapat dikembalikan. Status: ${current.status || "UNKNOWN"}`);

    const transaction = buildTransaction(user, rowToLegacyItem(current), "RETURN", 1, "AVAILABLE");
    const payload = toCentralPayload(transaction);

    local.db.exec("BEGIN IMMEDIATE");
    try {
        local.updateLocalItemAfterAction({
            itemUuid: current.uuid,
            status: "AVAILABLE",
            stock: current.stock,
            borrowedByUuid: null,
            borrowedByName: null,
            borrowedAt: null
        });
        local.insertLocalTransaction(transaction, payload);
        local.db.exec("COMMIT");
    } catch (error) {
        try { local.db.exec("ROLLBACK"); } catch (_) {}
        throw error;
    }

    local.exportCaches();
    const sync = await tryImmediateSync(transaction, payload);
    if (sync.rejected) throw new Error(`Central rejected RETURN: ${sync.message}`);

    return { success: true, synced: sync.synced, pending: sync.pending, message: sync.message, transaction, item: rowToLegacyItem(local.getItemByUuid(current.uuid)) };
}

async function createConsume(user, item, qty = 1) {
    if (!user) throw new Error("User tidak tersedia.");
    if (!item) throw new Error("Item tidak tersedia.");

    const quantity = Math.max(1, Math.trunc(Number(qty || 1)));
    local.initLocalDatabase();
    const current = local.getItemByUuid(item.UUID || item.uuid);
    if (!current) throw new Error("Item tidak ditemukan di database lokal.");
    if (normalize(current.type) !== "CONSUMABLE") throw new Error("Item bukan tipe CONSUMABLE.");
    if (current.stock < quantity) throw new Error(`Stock tidak cukup. Stock tersedia: ${current.stock}`);

    const newStock = current.stock - quantity;
    const newStatus = consumableStatus(newStock);
    const transaction = buildTransaction(user, rowToLegacyItem(current), "CONSUME", quantity, newStatus);
    const payload = toCentralPayload(transaction);

    local.db.exec("BEGIN IMMEDIATE");
    try {
        local.updateLocalItemAfterAction({
            itemUuid: current.uuid,
            status: newStatus,
            stock: newStock,
            borrowedByUuid: null,
            borrowedByName: null,
            borrowedAt: null
        });
        local.insertLocalTransaction(transaction, payload);
        local.db.exec("COMMIT");
    } catch (error) {
        try { local.db.exec("ROLLBACK"); } catch (_) {}
        throw error;
    }

    local.exportCaches();
    const sync = await tryImmediateSync(transaction, payload);
    if (sync.rejected) throw new Error(`Central rejected CONSUME: ${sync.message}`);

    return {
        success: true,
        synced: sync.synced,
        pending: sync.pending,
        message: sync.message,
        transaction,
        stock: local.getItemByUuid(current.uuid)?.stock ?? newStock,
        item: rowToLegacyItem(local.getItemByUuid(current.uuid))
    };
}

async function syncPending() {
    local.initLocalDatabase();
    const rows = local.getPendingTransactions(100);
    if (!rows.length) {
        await central.sendHeartbeat({ pending_count: 0 }).catch(() => null);
        return { total: 0, synced: 0, rejected: 0, failed: 0, remaining: 0 };
    }

    const payloads = rows.map(row => JSON.parse(row.payload_json));

    try {
        const response = await central.pushTransactions(payloads);
        let synced = 0;
        let rejected = 0;
        let failed = 0;

        for (const result of response.results || []) {
            if (result.success) {
                local.markTransactionSynced(result.transaction_uuid);
                if (result.item) centralItemToLocal(result.item);
                synced++;
            } else if (result.error === "SERVER_TRANSACTION_ERROR") {
                local.markTransactionRetry(result.transaction_uuid, result.error);
                failed++;
            } else {
                local.markTransactionRejected(result.transaction_uuid, result.error || "REJECTED");
                if (result.item) centralItemToLocal(result.item);
                rejected++;
            }
        }

        local.exportCaches();
        const remaining = local.getPendingCount();
        await central.sendHeartbeat({ pending_count: remaining, last_sync_at: new Date().toISOString() }).catch(() => null);
        return { total: rows.length, synced, rejected, failed, remaining };
    } catch (error) {
        for (const row of rows) local.markTransactionRetry(row.transaction_uuid, error.message);
        return { total: rows.length, synced: 0, rejected: 0, failed: rows.length, remaining: local.getPendingCount(), error: error.message };
    }
}

module.exports = {
    createBorrow,
    createReturn,
    createConsume,
    syncPending,
    getTimeConfig,
    formatSystemTimestamp,
    getLowStockThreshold
};
