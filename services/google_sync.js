"use strict";

require("dotenv").config({
    path: "/opt/LS_Inventory/.env",
    quiet: true
});

const fs = require("fs");
const path = require("path");

const local = require("./local_database");
const central = require("./central_api");

const ROOT = "/opt/LS_Inventory";
const CACHE_DIR = path.join(ROOT, "cache");

function loadJson(filename, fallback) {
    const file = path.join(CACHE_DIR, filename);
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {
        return fallback;
    }
}

function rowsToObjects(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const headers = (rows[0] || []).map(v => String(v ?? "").trim());
    return rows.slice(1).filter(row => Array.isArray(row) && row.some(v => String(v ?? "").trim() !== "")).map(row => {
        const out = {};
        headers.forEach((header, index) => {
            if (header) out[header] = row[index] ?? "";
        });
        return out;
    });
}

function keyValueToObject(rows) {
    const out = {};
    if (!Array.isArray(rows)) return out;
    for (const row of rows) {
        if (!Array.isArray(row) || row.length < 1) continue;
        const key = String(row[0] ?? "").trim();
        if (key) out[key] = row[1] ?? "";
    }
    return out;
}

function objectsToRows(objects) {
    if (!Array.isArray(objects) || !objects.length) return [];
    const headers = Array.from(new Set(objects.flatMap(obj => Object.keys(obj || {}))));
    return [headers, ...objects.map(obj => headers.map(h => obj?.[h] ?? ""))];
}

async function readSheet(sheetName) {
    const name = String(sheetName || "").trim().toUpperCase();
    if (name === "USERS") return objectsToRows(loadJson("users.json", []));
    if (name === "ITEMS") return objectsToRows(loadJson("items.json", []));
    if (name === "SETTINGS") return [["KEY", "VALUE"], ...Object.entries(loadJson("settings.json", {}))];
    if (name === "ADMIN") return [["KEY", "VALUE"], ...Object.entries(loadJson("admin.json", {}))];
    return [];
}

async function bootstrapEntity(entity) {
    let page = 1;
    let currentCursor = 0;

    while (true) {
        const result = await central.getSnapshot(entity, page, 500);
        currentCursor = Math.max(currentCursor, Number(result.current_cursor || 0));

        if (entity === "USERS") {
            for (const row of result.data || []) local.upsertUser(row);
        } else if (entity === "ITEMS") {
            for (const row of result.data || []) local.upsertItem(row);
        } else if (entity === "SETTINGS") {
            for (const row of result.data || []) local.setSetting(row.KEY ?? row.key, row.VALUE ?? row.value ?? "", row.UPDATED_AT ?? row.updated_at);
        } else if (entity === "ADMIN") {
            for (const row of result.data || []) local.setAdminConfig(row.KEY ?? row.key, row.VALUE ?? row.value ?? "", row.UPDATED_AT ?? row.updated_at);
        }

        if (!result.pages || page >= result.pages) break;
        page++;
    }

    return currentCursor;
}

function localCounts() {
    return {
        users: Number(local.db.prepare("SELECT COUNT(*) AS c FROM users WHERE active=1 AND deleted_at IS NULL").get().c || 0),
        items: Number(local.db.prepare("SELECT COUNT(*) AS c FROM items WHERE deleted_at IS NULL").get().c || 0)
    };
}

async function sync() {
    local.initLocalDatabase();
    local.importCachesIfEmpty();

    try {
        const counts = localCounts();
        let cursor = Number(local.getSyncState("master_cursor") || 0);

        if (cursor === 0 && (counts.users === 0 || counts.items === 0)) {
            console.log("Initial Central snapshot sync...");
            const cursors = [];
            for (const entity of ["USERS", "ITEMS", "SETTINGS", "ADMIN"]) {
                cursors.push(await bootstrapEntity(entity));
            }
            cursor = Math.max(...cursors, 0);
            local.setSyncState("master_cursor", String(cursor));
        }

        let applied = 0;
        let batches = 0;

        while (true) {
            const result = await central.pullChanges(cursor, 500);
            batches++;

            for (const change of result.changes || []) {
                local.applyMasterChange(change);
                applied++;
            }

            cursor = Number(result.next_cursor || cursor);
            local.setSyncState("master_cursor", String(cursor));

            if (!result.has_more || !(result.changes || []).length) break;
            if (batches >= 2000) throw new Error("CENTRAL_SYNC_TOO_MANY_BATCHES");
        }

        const cacheResult = local.exportCaches();
        const syncTime = new Date().toISOString();
        local.setSyncState("last_successful_sync", syncTime);

        await central.sendHeartbeat({
            pending_count: local.getPendingCount(),
            last_sync_at: syncTime,
            nfc_status: fs.existsSync("/dev/spidev1.0") ? "READY" : "CHECK",
            camera_status: fs.existsSync(path.join(ROOT, "scripts", "qr_camera_service.py")) ? "READY" : "CHECK"
        }).catch(() => null);

        console.log("CENTRAL SYNC COMPLETE");
        console.log(`Changes applied : ${applied}`);
        console.log(`Users cache     : ${cacheResult.users}`);
        console.log(`Items cache     : ${cacheResult.items}`);
        console.log(`Cursor          : ${cursor}`);

        return { success: true, offline: false, applied, cursor, ...cacheResult };
    } catch (error) {
        console.error("Central sync unavailable:", error.message);
        local.exportCaches();
        return {
            success: false,
            offline: true,
            error: error.message,
            pending: local.getPendingCount(),
            ...localCounts()
        };
    }
}

if (require.main === module) {
    sync().then(result => {
        console.log(result);
        process.exit(result.success ? 0 : 2);
    }).catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = {
    sync,
    readSheet,
    rowsToObjects,
    keyValueToObject
};
