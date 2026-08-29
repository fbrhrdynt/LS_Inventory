"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = "/opt/LS_Inventory";
const CENTRAL_DIR = path.join(ROOT, "central");
const DATA_DIR = path.join(CENTRAL_DIR, "data");
const DB_FILE = path.join(DATA_DIR, "central.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode=WAL;");
db.exec("PRAGMA foreign_keys=ON;");
db.exec("PRAGMA busy_timeout=5000;");
db.exec("PRAGMA synchronous=NORMAL;");

function nowIso() {
    return new Date().toISOString();
}

function normalize(value) {
    return String(value ?? "").trim().toUpperCase();
}

function asInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function boolInt(value, fallback = 1) {
    if (value === undefined || value === null || value === "") return fallback;
    const s = normalize(value);
    if (["TRUE", "1", "YES", "Y", "ACTIVE", "ENABLED"].includes(s)) return 1;
    if (["FALSE", "0", "NO", "N", "INACTIVE", "DISABLED"].includes(s)) return 0;
    return value ? 1 : 0;
}

function hashSecret(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
    return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
    const actual = crypto.scryptSync(String(password), String(salt), 64);
    const expected = Buffer.from(String(expectedHash), "hex");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function tableColumns(tableName) {
    return new Set(
        db.prepare(`PRAGMA table_info(${tableName})`)
            .all()
            .map(row => String(row.name))
    );
}

function ensureColumn(tableName, columnName, definition) {
    const columns = tableColumns(tableName);
    if (columns.has(columnName)) return;
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function initCentralDatabase() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            uuid TEXT PRIMARY KEY,
            employee_id TEXT UNIQUE,
            name TEXT NOT NULL,
            card_uid TEXT UNIQUE,
            department TEXT,
            role TEXT NOT NULL DEFAULT 'USER',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_users_card_uid ON users(card_uid);
        CREATE INDEX IF NOT EXISTS idx_users_name ON users(name);
        CREATE INDEX IF NOT EXISTS idx_users_active ON users(active, deleted_at);

        CREATE TABLE IF NOT EXISTS items (
            uuid TEXT PRIMARY KEY,
            qr_code TEXT UNIQUE NOT NULL,
            item_code TEXT UNIQUE NOT NULL,
            item_no TEXT,
            item_name TEXT NOT NULL,
            category TEXT,
            location TEXT,
            type TEXT NOT NULL,
            status TEXT NOT NULL,
            stock INTEGER NOT NULL DEFAULT 0,
            borrowed_by_uuid TEXT,
            borrowed_by_name TEXT,
            borrowed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            FOREIGN KEY(borrowed_by_uuid) REFERENCES users(uuid)
        );
        CREATE INDEX IF NOT EXISTS idx_items_qr ON items(qr_code);
        CREATE INDEX IF NOT EXISTS idx_items_code ON items(item_code);
        CREATE INDEX IF NOT EXISTS idx_items_name ON items(item_name);
        CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_items_type ON items(type, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_items_location ON items(location, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_items_category ON items(category, deleted_at);

        CREATE TABLE IF NOT EXISTS transactions (
            transaction_uuid TEXT PRIMARY KEY,
            transaction_id TEXT,
            device_id TEXT NOT NULL,
            item_uuid TEXT NOT NULL,
            item_code TEXT,
            item_name TEXT,
            user_uuid TEXT NOT NULL,
            user_name TEXT,
            card_uid TEXT,
            action TEXT NOT NULL,
            qty INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            sync_error TEXT,
            metadata_json TEXT,
            FOREIGN KEY(device_id) REFERENCES devices(device_id),
            FOREIGN KEY(item_uuid) REFERENCES items(uuid),
            FOREIGN KEY(user_uuid) REFERENCES users(uuid)
        );
        CREATE INDEX IF NOT EXISTS idx_transactions_occurred ON transactions(occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_transactions_item ON transactions(item_uuid, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_uuid, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_transactions_action ON transactions(action, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_transactions_device ON transactions(device_id, occurred_at DESC);

        CREATE TABLE IF NOT EXISTS stock_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_uuid TEXT,
            item_uuid TEXT NOT NULL,
            device_id TEXT,
            user_uuid TEXT,
            movement_type TEXT NOT NULL,
            quantity_delta INTEGER NOT NULL,
            stock_before INTEGER NOT NULL,
            stock_after INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_stock_item ON stock_movements(item_uuid, created_at DESC);

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS admin_config (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS devices (
            device_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            location TEXT,
            site TEXT,
            description TEXT,
            api_key_hash TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            app_version TEXT,
            local_ip TEXT,
            tailscale_ip TEXT,
            cpu_temperature REAL,
            disk_usage REAL,
            uptime_seconds INTEGER,
            nfc_status TEXT,
            camera_status TEXT,
            pending_count INTEGER NOT NULL DEFAULT 0,
            last_sync_at TEXT,
            last_seen_at TEXT,
            paired_at TEXT,
            deleted_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at DESC);
        CREATE TABLE IF NOT EXISTS device_pairings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            code_hash TEXT UNIQUE NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            created_at TEXT NOT NULL,
            created_by TEXT,
            FOREIGN KEY(device_id) REFERENCES devices(device_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_device_pairings_device
        ON device_pairings(device_id, consumed_at, expires_at);

        CREATE TABLE IF NOT EXISTS sync_changes (
            change_id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_key TEXT NOT NULL,
            operation TEXT NOT NULL,
            payload_json TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_changes_id ON sync_changes(change_id);

        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_type TEXT,
            actor_id TEXT,
            action TEXT NOT NULL,
            entity_type TEXT,
            entity_key TEXT,
            details_json TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

        CREATE TABLE IF NOT EXISTS admin_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_salt TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            display_name TEXT,
            role TEXT NOT NULL DEFAULT 'SUPERADMIN',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS admin_sessions (
            token_hash TEXT PRIMARY KEY,
            admin_id INTEGER NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(admin_id) REFERENCES admin_accounts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);
    `);

    ensureColumn("devices", "site", "TEXT");
    ensureColumn("devices", "description", "TEXT");
    ensureColumn("devices", "paired_at", "TEXT");
    ensureColumn("devices", "deleted_at", "TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_devices_active ON devices(active, deleted_at)");

    /*
     * Existing authenticated cabinets predate paired_at.
     * If they have already sent a heartbeat, treat them as paired.
     */
    db.prepare(`
        UPDATE devices
        SET paired_at=COALESCE(paired_at, created_at)
        WHERE paired_at IS NULL
          AND last_seen_at IS NOT NULL
    `).run();

    if (!db.prepare("SELECT 1 FROM settings WHERE key='LOW_STOCK_THRESHOLD'").get()) {
        setSetting("LOW_STOCK_THRESHOLD", "5", "SYSTEM");
    }

    return db;
}

function rowUser(row) {
    return {
        UUID: row.uuid,
        EMPLOYEE_ID: row.employee_id ?? "",
        NAME: row.name,
        CARD_UID: row.card_uid ?? "",
        DEPARTMENT: row.department ?? "",
        ROLE: row.role,
        ACTIVE: row.active ? "TRUE" : "FALSE",
        UPDATED_AT: row.updated_at ?? "",
        DELETED_AT: row.deleted_at ?? ""
    };
}

function rowItem(row) {
    return {
        UUID: row.uuid,
        QR_CODE: row.qr_code,
        ITEM_CODE: row.item_code,
        ITEM_NAME: row.item_name,
        CATEGORY: row.category ?? "",
        LOCATION: row.location ?? "",
        TYPE: row.type,
        STATUS: row.status,
        STOCK: row.stock,
        UPDATED_AT: row.updated_at,
        ITEM_NO: row.item_no ?? "",
        BORROWED_BY_UUID: row.borrowed_by_uuid ?? "",
        BORROWED_BY_NAME: row.borrowed_by_name ?? "",
        BORROWED_AT: row.borrowed_at ?? "",
        DELETED_AT: row.deleted_at ?? ""
    };
}

function recordChange(entityType, entityKey, operation, payload) {
    db.prepare(`
        INSERT INTO sync_changes(entity_type, entity_key, operation, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(entityType, String(entityKey), operation, payload == null ? null : JSON.stringify(payload), nowIso());
    return Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);
}

function audit(actorType, actorId, action, entityType, entityKey, details = {}) {
    db.prepare(`
        INSERT INTO audit_logs(actor_type, actor_id, action, entity_type, entity_key, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(actorType ?? null, actorId ?? null, action, entityType ?? null, entityKey ?? null, JSON.stringify(details ?? {}), nowIso());
}

function upsertUser(user, actor = "IMPORT") {
    const uuid = String(user.UUID ?? user.uuid ?? crypto.randomUUID()).trim();
    const existing = db.prepare("SELECT uuid, created_at FROM users WHERE uuid=?").get(uuid);
    const ts = String(user.UPDATED_AT ?? user.updated_at ?? nowIso());
    const createdAt = existing?.created_at ?? String(user.CREATED_AT ?? user.created_at ?? ts);
    const cardRaw = user.CARD_UID ?? user.card_uid ?? null;
    const clean = cardRaw ? normalize(cardRaw).replace(/[^0-9A-F]/g, "") : "";
    const cardUid = clean ? (clean.match(/.{1,2}/g)?.join(":") ?? clean) : null;

    db.prepare(`
        INSERT INTO users(uuid, employee_id, name, card_uid, department, role, active, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uuid) DO UPDATE SET
            employee_id=excluded.employee_id,
            name=excluded.name,
            card_uid=excluded.card_uid,
            department=excluded.department,
            role=excluded.role,
            active=excluded.active,
            updated_at=excluded.updated_at,
            deleted_at=excluded.deleted_at
    `).run(
        uuid,
        user.EMPLOYEE_ID ?? user.employee_id ?? null,
        String(user.NAME ?? user.name ?? "Unknown User").trim(),
        cardUid,
        user.DEPARTMENT ?? user.department ?? null,
        normalize(user.ROLE ?? user.role ?? "USER") || "USER",
        boolInt(user.ACTIVE ?? user.active ?? user.STATUS, 1),
        createdAt,
        ts,
        user.DELETED_AT ?? user.deleted_at ?? null
    );

    const row = db.prepare("SELECT * FROM users WHERE uuid=?").get(uuid);
    recordChange("USERS", uuid, existing ? "UPDATE" : "INSERT", rowUser(row));
    audit(actor, actor, existing ? "USER_UPDATE" : "USER_CREATE", "USERS", uuid, { name: row.name });
    return row;
}

function upsertItem(item, actor = "IMPORT") {
    const uuid = String(item.UUID ?? item.uuid ?? crypto.randomUUID()).trim();
    const existing = db.prepare("SELECT uuid, created_at FROM items WHERE uuid=?").get(uuid);
    const ts = String(item.UPDATED_AT ?? item.updated_at ?? nowIso());
    const createdAt = existing?.created_at ?? String(item.CREATED_AT ?? item.created_at ?? ts);
    const qrCode = String(item.QR_CODE ?? item.qr_code ?? uuid).trim();
    const itemCode = String(item.ITEM_CODE ?? item.item_code ?? "").trim();
    if (!itemCode) throw new Error(`ITEM_CODE required for ${uuid}`);

    db.prepare(`
        INSERT INTO items(
            uuid, qr_code, item_code, item_no, item_name, category, location,
            type, status, stock, borrowed_by_uuid, borrowed_by_name, borrowed_at,
            created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uuid) DO UPDATE SET
            qr_code=excluded.qr_code,
            item_code=excluded.item_code,
            item_no=excluded.item_no,
            item_name=excluded.item_name,
            category=excluded.category,
            location=excluded.location,
            type=excluded.type,
            status=excluded.status,
            stock=excluded.stock,
            borrowed_by_uuid=excluded.borrowed_by_uuid,
            borrowed_by_name=excluded.borrowed_by_name,
            borrowed_at=excluded.borrowed_at,
            updated_at=excluded.updated_at,
            deleted_at=excluded.deleted_at
    `).run(
        uuid,
        qrCode,
        itemCode,
        item.ITEM_NO ?? item.item_no ?? null,
        String(item.ITEM_NAME ?? item.item_name ?? "Unnamed Item").trim(),
        item.CATEGORY ?? item.category ?? null,
        item.LOCATION ?? item.location ?? null,
        normalize(item.TYPE ?? item.type ?? "BORROWABLE") || "BORROWABLE",
        normalize(item.STATUS ?? item.status ?? "AVAILABLE") || "AVAILABLE",
        Math.max(0, asInt(item.STOCK ?? item.stock, 0)),
        item.BORROWED_BY_UUID ?? item.borrowed_by_uuid ?? null,
        item.BORROWED_BY_NAME ?? item.borrowed_by_name ?? null,
        item.BORROWED_AT ?? item.borrowed_at ?? null,
        createdAt,
        ts,
        item.DELETED_AT ?? item.deleted_at ?? null
    );

    const row = db.prepare("SELECT * FROM items WHERE uuid=?").get(uuid);
    recordChange("ITEMS", uuid, existing ? "UPDATE" : "INSERT", rowItem(row));
    audit(actor, actor, existing ? "ITEM_UPDATE" : "ITEM_CREATE", "ITEMS", uuid, { item_code: row.item_code });
    return row;
}

function setSetting(key, value, actor = "ADMIN") {
    const exists = db.prepare("SELECT 1 FROM settings WHERE key=?").get(String(key));
    const ts = nowIso();
    db.prepare(`
        INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(String(key), value == null ? "" : String(value), ts);
    const payload = { KEY: String(key), VALUE: value == null ? "" : String(value), UPDATED_AT: ts };
    recordChange("SETTINGS", String(key), exists ? "UPDATE" : "INSERT", payload);
    audit(actor, actor, "SETTING_SET", "SETTINGS", String(key), { value: payload.VALUE });
    return payload;
}

function setAdminConfig(key, value, actor = "ADMIN") {
    const exists = db.prepare("SELECT 1 FROM admin_config WHERE key=?").get(String(key));
    const ts = nowIso();
    db.prepare(`
        INSERT INTO admin_config(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(String(key), value == null ? "" : String(value), ts);
    const payload = { KEY: String(key), VALUE: value == null ? "" : String(value), UPDATED_AT: ts };
    recordChange("ADMIN", String(key), exists ? "UPDATE" : "INSERT", payload);
    audit(actor, actor, "ADMIN_CONFIG_SET", "ADMIN", String(key), { value: payload.VALUE });
    return payload;
}

function createAdmin(username, password, displayName = "Administrator") {
    const ts = nowIso();
    const { salt, hash } = hashPassword(password);
    db.prepare(`
        INSERT INTO admin_accounts(username, password_salt, password_hash, display_name, role, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'SUPERADMIN', 1, ?, ?)
        ON CONFLICT(username) DO UPDATE SET
            password_salt=excluded.password_salt,
            password_hash=excluded.password_hash,
            display_name=excluded.display_name,
            active=1,
            updated_at=excluded.updated_at
    `).run(username, salt, hash, displayName, ts, ts);
    return db.prepare("SELECT id, username, display_name, role, active FROM admin_accounts WHERE username=?").get(username);
}

function createOrRotateDevice(deviceId, name, location, plainKey) {
    const ts = nowIso();
    const exists = db.prepare("SELECT device_id, created_at FROM devices WHERE device_id=?").get(deviceId);

    db.prepare(`
        INSERT INTO devices(
            device_id, name, location, api_key_hash, active,
            paired_at, deleted_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
            name=excluded.name,
            location=excluded.location,
            api_key_hash=excluded.api_key_hash,
            active=1,
            paired_at=excluded.paired_at,
            deleted_at=NULL,
            updated_at=excluded.updated_at
    `).run(
        deviceId,
        name,
        location ?? null,
        hashSecret(plainKey),
        ts,
        exists?.created_at ?? ts,
        ts
    );

    audit("SYSTEM", "SETUP", exists ? "DEVICE_KEY_ROTATE" : "DEVICE_CREATE", "DEVICES", deviceId, { name });
    return db.prepare("SELECT * FROM devices WHERE device_id=?").get(deviceId);
}

function normalizeDeviceId(value) {
    const input = String(value ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(input)) {
        throw new Error("INVALID_DEVICE_ID");
    }
    return input;
}

function createDevice({
    deviceId,
    name,
    location = null,
    site = null,
    description = null,
    active = true,
    actor = "ADMIN"
}) {
    const id = normalizeDeviceId(deviceId);
    const cleanName = String(name ?? "").trim();

    if (!cleanName) throw new Error("DEVICE_NAME_REQUIRED");

    const exists = db.prepare(`
        SELECT 1 FROM devices
        WHERE device_id=?
          AND (deleted_at IS NULL OR TRIM(deleted_at)='')
        LIMIT 1
    `).get(id);

    if (exists) throw new Error("DEVICE_ID_ALREADY_EXISTS");

    const ts = nowIso();
    const placeholderSecret = crypto.randomBytes(32).toString("hex");

    db.prepare(`
        INSERT INTO devices(
            device_id, name, location, site, description,
            api_key_hash, active, paired_at, deleted_at,
            created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
            name=excluded.name,
            location=excluded.location,
            site=excluded.site,
            description=excluded.description,
            api_key_hash=excluded.api_key_hash,
            active=excluded.active,
            paired_at=NULL,
            deleted_at=NULL,
            updated_at=excluded.updated_at
    `).run(
        id,
        cleanName,
        String(location ?? "").trim() || null,
        String(site ?? "").trim() || null,
        String(description ?? "").trim() || null,
        hashSecret(placeholderSecret),
        boolInt(active, 1),
        ts,
        ts
    );

    audit("ADMIN", actor, "DEVICE_CREATE", "DEVICES", id, {
        name: cleanName,
        location: location ?? null,
        site: site ?? null
    });

    return db.prepare("SELECT * FROM devices WHERE device_id=?").get(id);
}

function updateDevice(deviceId, changes = {}, actor = "ADMIN") {
    const id = String(deviceId ?? "").trim();
    const current = db.prepare(`
        SELECT * FROM devices
        WHERE device_id=?
          AND (deleted_at IS NULL OR TRIM(deleted_at)='')
        LIMIT 1
    `).get(id);

    if (!current) throw new Error("DEVICE_NOT_FOUND");

    const name = changes.name === undefined ? current.name : String(changes.name ?? "").trim();
    if (!name) throw new Error("DEVICE_NAME_REQUIRED");

    const location = changes.location === undefined ? current.location : (String(changes.location ?? "").trim() || null);
    const site = changes.site === undefined ? current.site : (String(changes.site ?? "").trim() || null);
    const description = changes.description === undefined ? current.description : (String(changes.description ?? "").trim() || null);
    const active = changes.active === undefined ? current.active : boolInt(changes.active, current.active);
    const ts = nowIso();

    db.prepare(`
        UPDATE devices
        SET name=?, location=?, site=?, description=?, active=?, updated_at=?
        WHERE device_id=?
    `).run(name, location, site, description, active, ts, id);

    audit("ADMIN", actor, "DEVICE_UPDATE", "DEVICES", id, {
        name, location, site, active: Boolean(active)
    });

    return db.prepare("SELECT * FROM devices WHERE device_id=?").get(id);
}

function softDeleteDevice(deviceId, actor = "ADMIN") {
    const id = String(deviceId ?? "").trim();
    const current = db.prepare(`
        SELECT * FROM devices
        WHERE device_id=?
          AND (deleted_at IS NULL OR TRIM(deleted_at)='')
        LIMIT 1
    `).get(id);

    if (!current) throw new Error("DEVICE_NOT_FOUND");

    const ts = nowIso();
    db.exec("BEGIN IMMEDIATE");
    try {
        db.prepare(`
            UPDATE devices
            SET active=0, deleted_at=?, updated_at=?
            WHERE device_id=?
        `).run(ts, ts, id);

        db.prepare(`
            UPDATE device_pairings
            SET consumed_at=COALESCE(consumed_at, ?)
            WHERE device_id=?
        `).run(ts, id);

        audit("ADMIN", actor, "DEVICE_DELETE", "DEVICES", id, {});
        db.exec("COMMIT");
    } catch (error) {
        try { db.exec("ROLLBACK"); } catch (_) {}
        throw error;
    }

    return true;
}

function generatePairingCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function createDevicePairing(deviceId, actor = "ADMIN", ttlMinutes = 15) {
    const id = String(deviceId ?? "").trim();
    const device = db.prepare(`
        SELECT * FROM devices
        WHERE device_id=?
          AND active=1
          AND (deleted_at IS NULL OR TRIM(deleted_at)='')
        LIMIT 1
    `).get(id);

    if (!device) throw new Error("DEVICE_NOT_FOUND_OR_INACTIVE");

    const minutes = Math.max(5, Math.min(60, asInt(ttlMinutes, 15)));
    const ts = nowIso();
    const expiresAt = new Date(Date.now() + minutes * 60000).toISOString();

    let code;
    let codeHash;

    for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = generatePairingCode();
        const candidateHash = hashSecret(candidate);
        const duplicate = db.prepare(`
            SELECT 1 FROM device_pairings
            WHERE code_hash=?
              AND consumed_at IS NULL
              AND expires_at>?
            LIMIT 1
        `).get(candidateHash, ts);

        if (!duplicate) {
            code = candidate;
            codeHash = candidateHash;
            break;
        }
    }

    if (!code || !codeHash) throw new Error("PAIRING_CODE_GENERATION_FAILED");

    db.exec("BEGIN IMMEDIATE");
    try {
        db.prepare(`
            UPDATE device_pairings
            SET consumed_at=COALESCE(consumed_at, ?)
            WHERE device_id=? AND consumed_at IS NULL
        `).run(ts, id);

        db.prepare(`
            INSERT INTO device_pairings(
                device_id, code_hash, expires_at, consumed_at,
                created_at, created_by
            )
            VALUES (?, ?, ?, NULL, ?, ?)
        `).run(id, codeHash, expiresAt, ts, actor);

        audit("ADMIN", actor, device.paired_at ? "DEVICE_REPAIR_CODE" : "DEVICE_PAIR_CODE", "DEVICES", id, {
            expires_at: expiresAt
        });
        db.exec("COMMIT");
    } catch (error) {
        try { db.exec("ROLLBACK"); } catch (_) {}
        throw error;
    }

    return { pairing_code: code, expires_at: expiresAt, ttl_minutes: minutes };
}

function getActivePairingInfo(deviceId) {
    return db.prepare(`
        SELECT id, expires_at, created_at
        FROM device_pairings
        WHERE device_id=?
          AND consumed_at IS NULL
          AND expires_at>?
        ORDER BY id DESC
        LIMIT 1
    `).get(String(deviceId ?? "").trim(), nowIso()) ?? null;
}

function consumeDevicePairing(pairingCode, metadata = {}) {
    const code = String(pairingCode ?? "").replace(/\D/g, "");
    if (code.length !== 6) throw new Error("INVALID_PAIRING_CODE");

    const ts = nowIso();
    const row = db.prepare(`
        SELECT p.*, d.name, d.location, d.site, d.description
        FROM device_pairings p
        JOIN devices d ON d.device_id=p.device_id
        WHERE p.code_hash=?
          AND p.consumed_at IS NULL
          AND p.expires_at>?
          AND d.active=1
          AND (d.deleted_at IS NULL OR TRIM(d.deleted_at)='')
        LIMIT 1
    `).get(hashSecret(code), ts);

    if (!row) throw new Error("PAIRING_CODE_INVALID_OR_EXPIRED");

    const plainKey = crypto.randomBytes(32).toString("hex");

    db.exec("BEGIN IMMEDIATE");
    try {
        db.prepare(`
            UPDATE devices
            SET api_key_hash=?,
                app_version=COALESCE(?, app_version),
                local_ip=COALESCE(?, local_ip),
                tailscale_ip=COALESCE(?, tailscale_ip),
                paired_at=?, last_seen_at=?, updated_at=?
            WHERE device_id=?
        `).run(
            hashSecret(plainKey),
            metadata.app_version ?? null,
            metadata.local_ip ?? null,
            metadata.tailscale_ip ?? null,
            ts, ts, ts,
            row.device_id
        );

        db.prepare("UPDATE device_pairings SET consumed_at=? WHERE id=?").run(ts, row.id);
        db.prepare(`
            UPDATE device_pairings
            SET consumed_at=COALESCE(consumed_at, ?)
            WHERE device_id=? AND consumed_at IS NULL
        `).run(ts, row.device_id);

        audit("DEVICE", row.device_id, "DEVICE_PAIRED", "DEVICES", row.device_id, {
            hostname: metadata.hostname ?? null,
            tailscale_ip: metadata.tailscale_ip ?? null,
            app_version: metadata.app_version ?? null
        });

        db.exec("COMMIT");
    } catch (error) {
        try { db.exec("ROLLBACK"); } catch (_) {}
        throw error;
    }

    return {
        device_id: row.device_id,
        device_name: row.name,
        location: row.location,
        site: row.site,
        description: row.description,
        device_api_key: plainKey,
        paired_at: ts
    };
}


function generateItemCode() {
    /*
     * Manual CODE LS Inventory menggunakan tepat 5 digit.
     * Range: 00000 - 99999 = 100.000 kombinasi.
     * ITEM_CODE tetap memakai format ITEM_12345.
     */
    const used = new Set(
        db.prepare(`
            SELECT item_no
            FROM items
            WHERE item_no IS NOT NULL
              AND deleted_at IS NULL
        `).all().map(row => String(row.item_no).padStart(5, "0"))
    );

    if (used.size >= 100000) {
        throw new Error("Semua kode item 5 digit sudah terpakai (00000-99999).");
    }

    const start = crypto.randomInt(0, 100000);

    for (let offset = 0; offset < 100000; offset++) {
        const number = (start + offset) % 100000;
        const itemNo = String(number).padStart(5, "0");
        const code = `ITEM_${itemNo}`;

        if (used.has(itemNo)) continue;

        const exists = db.prepare(`
            SELECT 1
            FROM items
            WHERE deleted_at IS NULL
              AND (item_code=? OR item_no=?)
            LIMIT 1
        `).get(code, itemNo);

        if (!exists) {
            return { itemCode: code, itemNo };
        }
    }

    throw new Error("Tidak ada kode item 5 digit yang tersedia.");
}

initCentralDatabase();

module.exports = {
    db,
    DB_FILE,
    initCentralDatabase,
    nowIso,
    normalize,
    asInt,
    boolInt,
    hashSecret,
    hashPassword,
    verifyPassword,
    rowUser,
    rowItem,
    recordChange,
    audit,
    upsertUser,
    upsertItem,
    setSetting,
    setAdminConfig,
    createAdmin,
    createOrRotateDevice,
    normalizeDeviceId,
    createDevice,
    updateDevice,
    softDeleteDevice,
    createDevicePairing,
    getActivePairingInfo,
    consumeDevicePairing,
    generateItemCode
};
