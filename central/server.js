"use strict";

require("dotenv").config({
    path: "/opt/LS_Inventory/.env",
    quiet: true
});

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn, execFile } = require("child_process");
const QRCode = require("qrcode");
const license = require("../services/license_service");

const {
    db,
    nowIso,
    normalize,
    asInt,
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
    createDevice,
    updateDevice,
    softDeleteDevice,
    createDevicePairing,
    consumeDevicePairing,
    generateItemCode
} = require("./db");

const ROOT = "/opt/LS_Inventory";
const PORT = Number(process.env.CENTRAL_PORT || 3100);
const HOST = process.env.CENTRAL_HOST || "0.0.0.0";
const SESSION_HOURS = Math.max(1, Number(process.env.ADMIN_SESSION_HOURS || 12));
const PUBLIC_DIR = path.join(ROOT, "central", "public");
const LOCAL_DEVICE_ID = String(
    process.env.DEVICE_ID ||
    process.env.DEVICE_NAME ||
    "LS_Cab_Main"
).trim();

function provisioningSecret() {
    const value = String(process.env.DEVICE_LICENSE_PROVISIONING_SECRET || "").trim();
    if (!value) throw new Error("DEVICE_LICENSE_PROVISIONING_SECRET_NOT_CONFIGURED");
    return crypto.createHash("sha256").update(value).digest();
}

function encryptProvisioningPayload(payload) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", provisioningSecret(), iv);
    const plaintext = Buffer.from(JSON.stringify(payload || {}), "utf8");
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, encrypted].map(value => value.toString("base64url")).join(".");
}

function decryptProvisioningPayload(value) {
    const parts = String(value || "").split(".");
    if (parts.length !== 3) throw new Error("INVALID_LICENSE_PROVISIONING_PAYLOAD");
    const [ivText, tagText, encryptedText] = parts;
    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        provisioningSecret(),
        Buffer.from(ivText, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedText, "base64url")),
        decipher.final()
    ]);
    return JSON.parse(decrypted.toString("utf8"));
}

function getDeviceOrThrow(deviceId) {
    const row = db.prepare(`
        SELECT *
        FROM devices
        WHERE device_id=?
          AND (deleted_at IS NULL OR TRIM(deleted_at)='')
        LIMIT 1
    `).get(String(deviceId || "").trim());
    if (!row) throw new Error("DEVICE_NOT_FOUND");
    return row;
}

function licenseAccessFromStatus(plan, status) {
    const normalizedPlan = String(plan || "trial").toLowerCase();
    const normalizedStatus = String(status || "TRIAL_ACTIVE").toUpperCase();
    const lifetime = normalizedPlan === "lifetime";
    const trialActive = normalizedStatus === "TRIAL_ACTIVE";
    return {
        borrow_enabled: lifetime || trialActive,
        return_enabled: true,
        consume_enabled: lifetime || trialActive,
        sync_enabled: true,
        write_enabled: lifetime || trialActive
    };
}

function deviceLicenseStatus(row) {
    const access = licenseAccessFromStatus(row.license_plan, row.license_status);
    return {
        plan: String(row.license_plan || "trial").toLowerCase(),
        status: row.license_status || "TRIAL_ACTIVE",
        fingerprint: row.license_fingerprint || null,
        last_verified_at: row.license_last_verified_at || null,
        trial_expires_at: row.license_trial_expires_at || null,
        trial_started_at: row.license_trial_started_at || null,
        days_remaining: row.license_days_remaining == null ? null : Number(row.license_days_remaining),
        product_slug: row.license_product_slug || "ls-inventory-hmilab",
        hostname: row.license_hostname || null,
        license_key_masked: row.license_key_masked || null,
        offline: Boolean(row.license_offline),
        error: row.license_last_error || null,
        ...access
    };
}

function updateDeviceLicenseStatus(deviceId, status) {
    const safe = status || {};
    db.prepare(`
        UPDATE devices SET
            license_plan=?,
            license_status=?,
            license_fingerprint=?,
            license_last_verified_at=?,
            license_trial_expires_at=?,
            license_trial_started_at=?,
            license_days_remaining=?,
            license_product_slug=?,
            license_hostname=?,
            license_key_masked=?,
            license_offline=?,
            license_last_error=?,
            updated_at=?
        WHERE device_id=?
    `).run(
        safe.plan ?? null,
        safe.status ?? null,
        safe.fingerprint ?? null,
        safe.last_verified_at ?? null,
        safe.trial_expires_at ?? null,
        safe.trial_started_at ?? null,
        safe.days_remaining ?? null,
        safe.product_slug ?? null,
        safe.hostname ?? null,
        safe.license_key_masked ?? null,
        safe.offline ? 1 : 0,
        safe.error ?? null,
        nowIso(),
        deviceId
    );
}

function latestDeviceLicenseCommand(deviceId) {
    const row = db.prepare(`
        SELECT id, device_id, command, status, created_by, created_at,
               expires_at, delivered_at, completed_at, result_json, error_text
        FROM device_license_commands
        WHERE device_id=?
        ORDER BY id DESC
        LIMIT 1
    `).get(deviceId);

    if (!row) return null;
    return {
        ...row,
        result: row.result_json ? JSON.parse(row.result_json) : null
    };
}

function queueDeviceLicenseCommand(deviceId, action, payload, actor) {
    const device = getDeviceOrThrow(deviceId);
    if (!device.active) throw new Error("DEVICE_INACTIVE");

    const command = String(action || "").trim().toUpperCase();
    if (!["ACTIVATE", "VERIFY"].includes(command)) throw new Error("INVALID_LICENSE_COMMAND");

    const ts = nowIso();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
        UPDATE device_license_commands
        SET status='CANCELLED', completed_at=?, error_text='SUPERSEDED'
        WHERE device_id=? AND command=? AND status='PENDING'
    `).run(ts, deviceId, command);

    const payloadEnc = payload ? encryptProvisioningPayload(payload) : null;
    const result = db.prepare(`
        INSERT INTO device_license_commands(
            device_id, command, payload_enc, status, created_by,
            created_at, expires_at
        ) VALUES (?, ?, ?, 'PENDING', ?, ?, ?)
    `).run(deviceId, command, payloadEnc, actor || null, ts, expiresAt);

    return {
        id: Number(result.lastInsertRowid),
        device_id: deviceId,
        command,
        status: "PENDING",
        created_at: ts,
        expires_at: expiresAt
    };
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

function safeLimit(value, def = 50, max = 200) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) return def;
    return Math.min(n, max);
}

function safePage(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : 1;
}

function parseCookies(req) {
    const out = {};
    const raw = String(req.headers.cookie || "");
    for (const part of raw.split(";")) {
        const index = part.indexOf("=");
        if (index <= 0) continue;
        const key = decodeURIComponent(part.slice(0, index).trim());
        const value = decodeURIComponent(part.slice(index + 1).trim());
        out[key] = value;
    }
    return out;
}

function normalizeCardUid(value) {
    const clean = normalize(value).replace(/[^0-9A-F]/g, "");
    return clean ? (clean.match(/.{1,2}/g)?.join(":") ?? clean) : null;
}

function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function lowStockThreshold() {
    const value = db.prepare("SELECT value FROM settings WHERE key='LOW_STOCK_THRESHOLD'").get()?.value;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 5;
}

function calculateConsumableStatus(stock) {
    if (stock <= 0) return "OUT_OF_STOCK";
    if (stock <= lowStockThreshold()) return "LOW_STOCK";
    return "AVAILABLE";
}

function requireAdmin(req, res, next) {
    const token = parseCookies(req).ls_admin_session;
    if (!token) return res.status(401).json({ success: false, error: "UNAUTHORIZED" });

    const tokenHash = hashSecret(token);
    const session = db.prepare(`
        SELECT a.id, a.username, a.display_name, a.role
        FROM admin_sessions s
        JOIN admin_accounts a ON a.id=s.admin_id
        WHERE s.token_hash=? AND s.expires_at>? AND a.active=1
        LIMIT 1
    `).get(tokenHash, nowIso());

    if (!session) return res.status(401).json({ success: false, error: "SESSION_EXPIRED" });
    req.admin = session;
    next();
}


function normalizeAdminAccountRole(value) {
    const role = String(value ?? "")
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, "_");

    if (role === "SUPERADMIN" || role === "ADMINISTRATOR") {
        return "ADMINISTRATOR";
    }

    if (role === "ADMIN_STAFF" || role === "STAFF") {
        return "ADMIN_STAFF";
    }

    throw new Error("INVALID_ADMIN_ROLE");
}

function isAdministratorRole(value) {
    try {
        return normalizeAdminAccountRole(value) === "ADMINISTRATOR";
    } catch (_) {
        return false;
    }
}

function requireAdministrator(req, res, next) {
    if (!req.admin || !isAdministratorRole(req.admin.role)) {
        return res.status(403).json({
            success: false,
            error: "ADMINISTRATOR_REQUIRED"
        });
    }

    next();
}

function adminAccountView(row) {
    return {
        id: Number(row.id),
        username: row.username,
        display_name: row.display_name ?? "",
        role: normalizeAdminAccountRole(row.role),
        active: Boolean(row.active),
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function validateAdminUsername(value) {
    const username = String(value ?? "").trim();

    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
        throw new Error("INVALID_ADMIN_USERNAME");
    }

    return username;
}

function countOtherActiveAdministrators(adminId) {
    const rows = db.prepare(`
        SELECT id, role
        FROM admin_accounts
        WHERE active=1
          AND id<>?
    `).all(Number(adminId));

    return rows.filter(row => isAdministratorRole(row.role)).length;
}

function requireWritableLicense(req, res, next) {
    const status = license.getCachedStatus();

    if (license.canAdminWrite(status)) {
        return next();
    }

    return res.status(402).json({
        success: false,
        error: "LICENSE_TRIAL_EXPIRED",
        message: "Trial license has expired. Web Admin is read-only until a Lifetime license is activated.",
        license: license.publicStatus(status)
    });
}

/*
 * All Web Admin GET requests remain available after trial expiration so data
 * can still be inspected. Mutations are blocked, except login/logout and
 * license activation/verification.
 */
app.use("/api/v1/admin", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        return next();
    }

    const allowed = new Set([
        "/login",
        "/logout",
        "/license/activate",
        "/license/verify"
    ]);

    if (
        allowed.has(req.path) ||
        /^\/devices\/[^/]+\/license(?:\/activate|\/verify)?$/.test(req.path)
    ) {
        return next();
    }

    return requireWritableLicense(req, res, next);
});

function requireDevice(req, res, next) {
    const deviceId = String(req.headers["x-device-id"] || "").trim();
    const deviceKey = String(req.headers["x-device-key"] || "").trim();
    if (!deviceId || !deviceKey) return res.status(401).json({ success: false, error: "DEVICE_CREDENTIALS_REQUIRED" });

    const device = db.prepare(`
        SELECT *
        FROM devices
        WHERE device_id=?
          AND active=1
          AND (deleted_at IS NULL OR TRIM(deleted_at)='')
        LIMIT 1
    `).get(deviceId);
    if (!device || device.api_key_hash !== hashSecret(deviceKey)) {
        return res.status(401).json({ success: false, error: "INVALID_DEVICE_CREDENTIALS" });
    }

    req.device = device;
    next();
}


const pairingAttemptBuckets = new Map();

function pairingClientKey(req) {
    /*
     * Do not trust X-Forwarded-For here unless Express is explicitly
     * configured with a trusted reverse proxy. The socket address cannot
     * be spoofed through a normal HTTP header.
     */
    return String(
        req.socket?.remoteAddress
        || "unknown"
    ).trim();
}

function allowPairingAttempt(req) {
    const key = pairingClientKey(req);
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const maxAttempts = 8;

    let bucket = pairingAttemptBuckets.get(key);

    if (!bucket || now - bucket.started_at >= windowMs) {
        bucket = { started_at: now, attempts: 0 };
    }

    bucket.attempts++;
    pairingAttemptBuckets.set(key, bucket);

    return {
        allowed: bucket.attempts <= maxAttempts,
        retry_after_seconds: Math.max(
            1,
            Math.ceil((bucket.started_at + windowMs - now) / 1000)
        )
    };
}

function clearPairingAttempts(req) {
    pairingAttemptBuckets.delete(pairingClientKey(req));
}

function begin() { db.exec("BEGIN IMMEDIATE"); }
function commit() { db.exec("COMMIT"); }
function rollback() { try { db.exec("ROLLBACK"); } catch (_) {} }

function execFileAsync(command, args = [], options = {}) {
    return new Promise((resolve, reject) => {
        execFile(command, args, {
            cwd: ROOT,
            timeout: options.timeout || 10000,
            maxBuffer: 1024 * 1024,
            encoding: "utf8"
        }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                return reject(error);
            }
            resolve({ stdout, stderr });
        });
    });
}

async function restartCabinetApp() {
    try {
        await execFileAsync("pm2", ["restart", "LS_Inventory", "--update-env"], { timeout: 15000 });
    } catch (error) {
        console.error("Failed to restart LS_Inventory after NFC capture:", error.message);
    }
}

let nfcCaptureBusy = false;

async function captureNfcCard(timeoutSeconds = 30) {
    if (nfcCaptureBusy) {
        const error = new Error("NFC_CAPTURE_BUSY");
        error.statusCode = 409;
        throw error;
    }

    nfcCaptureBusy = true;
    const timeoutMs = Math.max(10, Math.min(Number(timeoutSeconds) || 30, 60)) * 1000;

    try {
        /*
         * RC522 normally dipakai oleh process LS_Inventory.
         * Saat admin meminta kartu baru, cabinet dihentikan sementara supaya
         * hanya satu process yang mengakses /dev/spidev1.0.
         */
        try {
            await execFileAsync("pm2", ["stop", "LS_Inventory"], { timeout: 15000 });
        } catch (error) {
            console.warn("PM2 stop LS_Inventory warning:", error.message);
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        return await new Promise((resolve, reject) => {
            const child = spawn("python3", ["-u", path.join(ROOT, "scripts", "nfc_reader.py")], {
                cwd: ROOT,
                env: process.env
            });

            let stdoutBuffer = "";
            let settled = false;

            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { child.kill("SIGTERM"); } catch (_) {}
                if (error) reject(error);
                else resolve(result);
            };

            const inspectLine = line => {
                const text = String(line || "").trim();
                if (!text) return;

                const prefixes = ["CARD_UID:", "UNKNOWN_CARD:"];
                for (const prefix of prefixes) {
                    if (text.startsWith(prefix)) {
                        const cardUid = normalizeCardUid(text.slice(prefix.length));
                        if (cardUid) return finish(null, { card_uid: cardUid, source: prefix.slice(0, -1) });
                    }
                }

                if (text.startsWith("USER_JSON:")) {
                    try {
                        const user = JSON.parse(text.slice("USER_JSON:".length));
                        const cardUid = normalizeCardUid(user.CARD_UID || user.card_uid);
                        if (cardUid) return finish(null, { card_uid: cardUid, source: "USER_JSON", user });
                    } catch (_) {}
                }
            };

            child.stdout.on("data", chunk => {
                stdoutBuffer += chunk.toString();
                const lines = stdoutBuffer.split(/\r?\n/);
                stdoutBuffer = lines.pop() || "";
                for (const line of lines) inspectLine(line);
            });

            child.stderr.on("data", chunk => {
                const text = chunk.toString().trim();
                if (text) console.error("[ADMIN NFC]", text);
            });

            child.on("error", error => finish(error));
            child.on("close", code => {
                if (!settled) {
                    const error = new Error(`NFC_READER_STOPPED_${code}`);
                    error.statusCode = 500;
                    finish(error);
                }
            });

            const timer = setTimeout(() => {
                const error = new Error("NFC_CAPTURE_TIMEOUT");
                error.statusCode = 408;
                finish(error);
            }, timeoutMs);
        });
    } finally {
        await restartCabinetApp();
        nfcCaptureBusy = false;
    }
}

function insertRejectedTransaction(tx, deviceId, error) {
    if (!isUuid(tx.transaction_uuid) || !isUuid(tx.item_uuid) || !isUuid(tx.user_uuid)) return;
    if (db.prepare("SELECT 1 FROM transactions WHERE transaction_uuid=?").get(tx.transaction_uuid)) return;
    const item = db.prepare("SELECT * FROM items WHERE uuid=?").get(tx.item_uuid);
    const user = db.prepare("SELECT * FROM users WHERE uuid=?").get(tx.user_uuid);
    if (!item || !user) return;

    db.prepare(`
        INSERT INTO transactions(
            transaction_uuid, transaction_id, device_id, item_uuid, item_code, item_name,
            user_uuid, user_name, card_uid, action, qty, status, occurred_at, created_at,
            sync_error, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REJECTED', ?, ?, ?, ?)
    `).run(
        tx.transaction_uuid,
        tx.transaction_id || tx.transaction_uuid,
        deviceId,
        item.uuid,
        item.item_code,
        item.item_name,
        user.uuid,
        user.name,
        user.card_uid,
        normalize(tx.action),
        Math.max(1, asInt(tx.qty, 1)),
        tx.occurred_at || nowIso(),
        nowIso(),
        error,
        JSON.stringify(tx.metadata || {})
    );
}

function processDeviceTransaction(tx, device) {
    const transactionUuid = String(tx.transaction_uuid || "").trim();
    const itemUuid = String(tx.item_uuid || "").trim();
    const userUuid = String(tx.user_uuid || "").trim();
    const action = normalize(tx.action);
    const qty = Math.max(1, asInt(tx.qty, 1));
    const occurredAt = String(tx.occurred_at || nowIso());

    if (!isUuid(transactionUuid)) return { transaction_uuid: transactionUuid, success: false, error: "INVALID_TRANSACTION_UUID" };
    if (!isUuid(itemUuid) || !isUuid(userUuid)) return { transaction_uuid: transactionUuid, success: false, error: "INVALID_ITEM_OR_USER_UUID" };
    if (!["BORROW", "RETURN", "CONSUME"].includes(action)) return { transaction_uuid: transactionUuid, success: false, error: "INVALID_ACTION" };

    const existing = db.prepare("SELECT status, sync_error FROM transactions WHERE transaction_uuid=? LIMIT 1").get(transactionUuid);
    if (existing) {
        return {
            transaction_uuid: transactionUuid,
            success: existing.status === "COMMITTED",
            duplicate: true,
            status: existing.status,
            error: existing.sync_error || undefined
        };
    }

    begin();
    try {
        const user = db.prepare("SELECT * FROM users WHERE uuid=? AND active=1 AND deleted_at IS NULL LIMIT 1").get(userUuid);
        const item = db.prepare("SELECT * FROM items WHERE uuid=? AND deleted_at IS NULL LIMIT 1").get(itemUuid);

        if (!user || !item) {
            rollback();
            return { transaction_uuid: transactionUuid, success: false, error: !user ? "USER_NOT_FOUND_OR_INACTIVE" : "ITEM_NOT_FOUND" };
        }

        let error = null;
        let newStatus = item.status;
        let newStock = item.stock;
        let borrowedByUuid = item.borrowed_by_uuid;
        let borrowedByName = item.borrowed_by_name;
        let borrowedAt = item.borrowed_at;

        if (action === "BORROW") {
            if (item.type !== "BORROWABLE") error = "ITEM_NOT_BORROWABLE";
            else if (item.status !== "AVAILABLE") error = "ITEM_NOT_AVAILABLE";
            else {
                newStatus = "BORROWED";
                borrowedByUuid = user.uuid;
                borrowedByName = user.name;
                borrowedAt = occurredAt;
            }
        }

        if (action === "RETURN") {
            if (item.type !== "BORROWABLE") error = "ITEM_NOT_BORROWABLE";
            else if (item.status !== "BORROWED") error = "ITEM_NOT_BORROWED";
            else {
                newStatus = "AVAILABLE";
                borrowedByUuid = null;
                borrowedByName = null;
                borrowedAt = null;
            }
        }

        if (action === "CONSUME") {
            if (item.type !== "CONSUMABLE") error = "ITEM_NOT_CONSUMABLE";
            else if (item.stock < qty) error = "INSUFFICIENT_STOCK";
            else {
                newStock = item.stock - qty;
                newStatus = calculateConsumableStatus(newStock);
            }
        }

        if (error) {
            insertRejectedTransaction(tx, device.device_id, error);
            audit("DEVICE", device.device_id, `TRANSACTION_${action}_REJECTED`, "TRANSACTIONS", transactionUuid, { error, item_uuid: itemUuid, user_uuid: userUuid });
            commit();
            return { transaction_uuid: transactionUuid, success: false, status: "REJECTED", error, item: rowItem(item) };
        }

        const updateTs = nowIso();
        db.prepare(`
            UPDATE items SET
                status=?, stock=?, borrowed_by_uuid=?, borrowed_by_name=?, borrowed_at=?, updated_at=?
            WHERE uuid=?
        `).run(newStatus, newStock, borrowedByUuid, borrowedByName, borrowedAt, updateTs, itemUuid);

        const updatedItem = db.prepare("SELECT * FROM items WHERE uuid=?").get(itemUuid);

        db.prepare(`
            INSERT INTO transactions(
                transaction_uuid, transaction_id, device_id, item_uuid, item_code, item_name,
                user_uuid, user_name, card_uid, action, qty, status, occurred_at, created_at,
                sync_error, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMMITTED', ?, ?, NULL, ?)
        `).run(
            transactionUuid,
            tx.transaction_id || transactionUuid,
            device.device_id,
            item.uuid,
            item.item_code,
            item.item_name,
            user.uuid,
            user.name,
            user.card_uid,
            action,
            qty,
            occurredAt,
            nowIso(),
            JSON.stringify(tx.metadata || {})
        );

        if (action === "CONSUME") {
            db.prepare(`
                INSERT INTO stock_movements(
                    transaction_uuid, item_uuid, device_id, user_uuid, movement_type,
                    quantity_delta, stock_before, stock_after, created_at
                ) VALUES (?, ?, ?, ?, 'CONSUME', ?, ?, ?, ?)
            `).run(transactionUuid, item.uuid, device.device_id, user.uuid, -qty, item.stock, newStock, nowIso());
        }

        recordChange("ITEMS", itemUuid, "UPDATE", rowItem(updatedItem));
        audit("DEVICE", device.device_id, `TRANSACTION_${action}`, "TRANSACTIONS", transactionUuid, { item_uuid: itemUuid, user_uuid: userUuid, qty });
        commit();

        return {
            transaction_uuid: transactionUuid,
            success: true,
            status: "COMMITTED",
            item: rowItem(updatedItem)
        };
    } catch (error) {
        rollback();
        console.error("Transaction error:", error);
        return { transaction_uuid: transactionUuid, success: false, error: "SERVER_TRANSACTION_ERROR" };
    }
}

app.get("/health", (req, res) => {
    const counts = {
        users: Number(db.prepare("SELECT COUNT(*) AS c FROM users WHERE active=1 AND deleted_at IS NULL").get().c),
        items: Number(db.prepare("SELECT COUNT(*) AS c FROM items WHERE deleted_at IS NULL").get().c),
        transactions: Number(db.prepare("SELECT COUNT(*) AS c FROM transactions").get().c)
    };
    res.json({ success: true, application: "LS Inventory Central", database: "SQLite", host: os.hostname(), counts, server_time: nowIso() });
});

app.post("/api/v1/admin/login", (req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const admin = db.prepare("SELECT * FROM admin_accounts WHERE username=? AND active=1 LIMIT 1").get(username);

    if (!admin || !verifyPassword(password, admin.password_salt, admin.password_hash)) {
        return res.status(401).json({ success: false, error: "INVALID_LOGIN" });
    }

    db.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").run(nowIso());
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600000).toISOString();
    db.prepare("INSERT INTO admin_sessions(token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(hashSecret(token), admin.id, expiresAt, nowIso());
    audit("ADMIN", admin.username, "LOGIN", "ADMIN", admin.username, {});

    res.setHeader("Set-Cookie", `ls_admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
    res.json({
        success: true,
        user: { id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role },
        license: license.publicStatus(license.getCachedStatus())
    });
});

app.post("/api/v1/admin/logout", requireAdmin, (req, res) => {
    const token = parseCookies(req).ls_admin_session;
    if (token) db.prepare("DELETE FROM admin_sessions WHERE token_hash=?").run(hashSecret(token));
    res.setHeader("Set-Cookie", "ls_admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    res.json({ success: true });
});

app.get("/api/v1/admin/me", requireAdmin, (req, res) => {
    res.json({
        success: true,
        user: req.admin,
        license: license.publicStatus(license.getCachedStatus())
    });
});

app.get("/api/v1/admin/license", requireAdmin, async (req, res) => {
    const status = await license.verify({ force: false });
    res.json({
        success: true,
        data: license.publicStatus(status)
    });
});

app.post(
    "/api/v1/admin/license/verify",
    requireAdmin,
    requireAdministrator,
    async (req, res, next) => {
        try {
            const status = await license.verify({ force: true });
            audit("ADMIN", req.admin.username, "LICENSE_VERIFY", "LICENSE", status.fingerprint, {
                plan: status.plan,
                status: status.status,
                product_slug: status.product_slug
            });
            res.json({ success: true, data: license.publicStatus(status) });
        } catch (error) {
            next(error);
        }
    }
);

app.post(
    "/api/v1/admin/license/activate",
    requireAdmin,
    requireAdministrator,
    async (req, res, next) => {
        try {
            const key = String(req.body?.license_key || "").trim();
            if (!key) {
                return res.status(400).json({ success: false, error: "LICENSE_KEY_REQUIRED" });
            }

            const result = await license.activate(key);
            const status = result.status;

            audit("ADMIN", req.admin.username, "LICENSE_ACTIVATE", "LICENSE", status.fingerprint, {
                plan: status.plan,
                status: status.status,
                product_slug: status.product_slug
            });

            res.json({
                success: true,
                data: license.publicStatus(status)
            });
        } catch (error) {
            if (["LICENSE_KEY_REQUIRED"].includes(error.message)) {
                return res.status(400).json({ success: false, error: error.message });
            }
            if (error.remoteResponse) {
                return res.status(error.status || 400).json({
                    success: false,
                    error: error.message,
                    details: error.data || null
                });
            }
            next(error);
        }
    }
);

app.get("/api/v1/admin/dashboard", requireAdmin, (req, res) => {
    const one = sql => Number(db.prepare(sql).get().c || 0);
    const recent = db.prepare(`
        SELECT transaction_uuid, action, qty, status, occurred_at, item_code, item_name, user_name, device_id
        FROM transactions ORDER BY occurred_at DESC LIMIT 10
    `).all();
    res.json({
        success: true,
        stats: {
            items: one("SELECT COUNT(*) AS c FROM items WHERE deleted_at IS NULL"),
            users: one("SELECT COUNT(*) AS c FROM users WHERE active=1 AND deleted_at IS NULL"),
            borrowed: one("SELECT COUNT(*) AS c FROM items WHERE status='BORROWED' AND deleted_at IS NULL"),
            low_stock: one("SELECT COUNT(*) AS c FROM items WHERE status='LOW_STOCK' AND deleted_at IS NULL"),
            out_of_stock: one("SELECT COUNT(*) AS c FROM items WHERE status='OUT_OF_STOCK' AND deleted_at IS NULL"),
            transactions: one("SELECT COUNT(*) AS c FROM transactions"),
            online_devices: one("SELECT COUNT(*) AS c FROM devices WHERE active=1 AND (deleted_at IS NULL OR TRIM(deleted_at)='') AND last_seen_at IS NOT NULL AND julianday(last_seen_at) >= julianday('now','-3 minutes')")
        },
        recent
    });
});

app.get("/api/v1/admin/items", requireAdmin, (req, res) => {
    const page = safePage(req.query.page);
    const limit = safeLimit(req.query.limit, 50, 200);
    const offset = (page - 1) * limit;
    const where = ["deleted_at IS NULL"];
    const args = [];

    const search = String(req.query.search || "").trim();
    if (search) {
        where.push("(item_name LIKE ? COLLATE NOCASE OR item_code LIKE ? COLLATE NOCASE OR item_no LIKE ? COLLATE NOCASE OR qr_code LIKE ? COLLATE NOCASE)");
        const s = `%${search}%`; args.push(s, s, s, s);
    }
    for (const [key, col] of [["status","status"],["type","type"],["location","location"],["category","category"]]) {
        const v = String(req.query[key] || "").trim();
        if (v) { where.push(`${col}=?`); args.push(v); }
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM items ${whereSql}`).get(...args).c);
    const data = db.prepare(`SELECT * FROM items ${whereSql} ORDER BY item_name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...args, limit, offset).map(rowItem);
    res.json({ success: true, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), data });
});

app.get("/api/v1/admin/items/:uuid/qr", requireAdmin, async (req, res, next) => {
    try {
        const item = db.prepare("SELECT * FROM items WHERE uuid=? AND deleted_at IS NULL LIMIT 1").get(req.params.uuid);
        if (!item) return res.status(404).json({ success: false, error: "ITEM_NOT_FOUND" });

        const dataUrl = await QRCode.toDataURL(String(item.qr_code), {
            errorCorrectionLevel: "M",
            type: "image/png",
            width: 420,
            margin: 2
        });

        res.json({
            success: true,
            item: rowItem(item),
            qr_code: item.qr_code,
            data_url: dataUrl
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/v1/admin/items", requireAdmin, (req, res) => {
    try {
        const body = req.body || {};
        const itemName = String(body.item_name || body.ITEM_NAME || "").trim();
        const type = normalize(body.type || body.TYPE || "BORROWABLE");
        if (!itemName) return res.status(400).json({ success: false, error: "ITEM_NAME_REQUIRED" });
        if (!["BORROWABLE", "CONSUMABLE"].includes(type)) return res.status(400).json({ success: false, error: "INVALID_TYPE" });

        const uuid = crypto.randomUUID();
        const generated = generateItemCode();
        const stock = type === "BORROWABLE" ? Math.max(1, asInt(body.stock ?? body.STOCK, 1)) : Math.max(0, asInt(body.stock ?? body.STOCK, 0));
        const status = type === "CONSUMABLE" ? calculateConsumableStatus(stock) : normalize(body.status || body.STATUS || "AVAILABLE");
        const row = upsertItem({
            UUID: uuid,
            QR_CODE: body.qr_code || body.QR_CODE || uuid,
            ITEM_CODE: body.item_code || body.ITEM_CODE || generated.itemCode,
            ITEM_NO: body.item_no || body.ITEM_NO || generated.itemNo,
            ITEM_NAME: itemName,
            CATEGORY: body.category || body.CATEGORY || "",
            LOCATION: body.location || body.LOCATION || "",
            TYPE: type,
            STATUS: status,
            STOCK: stock
        }, req.admin.username);
        res.status(201).json({ success: true, data: rowItem(row) });
    } catch (error) {
        if (String(error.message).includes("UNIQUE constraint failed")) return res.status(409).json({ success: false, error: "ITEM_CODE_OR_QR_ALREADY_EXISTS" });
        throw error;
    }
});

app.put("/api/v1/admin/items/:uuid", requireAdmin, (req, res) => {
    const old = db.prepare("SELECT * FROM items WHERE uuid=? AND deleted_at IS NULL").get(req.params.uuid);
    if (!old) return res.status(404).json({ success: false, error: "ITEM_NOT_FOUND" });
    const body = req.body || {};
    const type = normalize(body.type ?? body.TYPE ?? old.type);
    let stock = Math.max(0, asInt(body.stock ?? body.STOCK, old.stock));
    let status = normalize(body.status ?? body.STATUS ?? old.status);
    if (type === "CONSUMABLE") status = calculateConsumableStatus(stock);

    const row = upsertItem({
        UUID: old.uuid,
        QR_CODE: body.qr_code ?? body.QR_CODE ?? old.qr_code,
        ITEM_CODE: body.item_code ?? body.ITEM_CODE ?? old.item_code,
        ITEM_NO: body.item_no ?? body.ITEM_NO ?? old.item_no,
        ITEM_NAME: body.item_name ?? body.ITEM_NAME ?? old.item_name,
        CATEGORY: body.category ?? body.CATEGORY ?? old.category,
        LOCATION: body.location ?? body.LOCATION ?? old.location,
        TYPE: type,
        STATUS: status,
        STOCK: stock,
        BORROWED_BY_UUID: old.borrowed_by_uuid,
        BORROWED_BY_NAME: old.borrowed_by_name,
        BORROWED_AT: old.borrowed_at,
        CREATED_AT: old.created_at
    }, req.admin.username);
    res.json({ success: true, data: rowItem(row) });
});

app.delete("/api/v1/admin/items/:uuid", requireAdmin, (req, res) => {
    const old = db.prepare("SELECT * FROM items WHERE uuid=? AND deleted_at IS NULL").get(req.params.uuid);

    if (!old) {
        return res.status(404).json({
            success: false,
            error: "ITEM_NOT_FOUND"
        });
    }

    /*
     * A borrowed item must be returned first.
     * Otherwise the cabinet would no longer be able to perform its return.
     */
    if (normalize(old.status) === "BORROWED") {
        return res.status(409).json({
            success: false,
            error: "ITEM_CURRENTLY_BORROWED"
        });
    }

    const ts = nowIso();

    db.prepare(`
        UPDATE items
        SET deleted_at=?, updated_at=?
        WHERE uuid=?
    `).run(ts, ts, old.uuid);

    const row = db.prepare("SELECT * FROM items WHERE uuid=?").get(old.uuid);

    recordChange(
        "ITEMS",
        old.uuid,
        "DELETE",
        rowItem(row)
    );

    audit(
        "ADMIN",
        req.admin.username,
        "ITEM_DELETE",
        "ITEMS",
        old.uuid,
        {
            item_code: old.item_code,
            item_name: old.item_name
        }
    );

    res.json({
        success: true
    });
});

app.get("/api/v1/admin/users", requireAdmin, (req, res) => {
    const page = safePage(req.query.page);
    const limit = safeLimit(req.query.limit, 50, 200);
    const offset = (page - 1) * limit;
    const search = String(req.query.search || "").trim();
    const args = [];
    let where = "WHERE deleted_at IS NULL";
    if (search) {
        const s = `%${search}%`;
        where += " AND (name LIKE ? COLLATE NOCASE OR employee_id LIKE ? COLLATE NOCASE OR card_uid LIKE ? COLLATE NOCASE)";
        args.push(s, s, s);
    }
    const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM users ${where}`).get(...args).c);
    const data = db.prepare(`SELECT * FROM users ${where} ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...args, limit, offset).map(rowUser);
    res.json({ success: true, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), data });
});

app.post("/api/v1/admin/users", requireAdmin, (req, res) => {
    try {
        const body = req.body || {};
        const name = String(body.name || body.NAME || "").trim();
        if (!name) return res.status(400).json({ success: false, error: "NAME_REQUIRED" });
        const row = upsertUser({
            UUID: body.uuid || body.UUID || crypto.randomUUID(),
            EMPLOYEE_ID: body.employee_id || body.EMPLOYEE_ID || null,
            NAME: name,
            CARD_UID: normalizeCardUid(body.card_uid || body.CARD_UID),
            DEPARTMENT: body.department || body.DEPARTMENT || null,
            ROLE: normalize(body.role || body.ROLE || "USER"),
            ACTIVE: body.active ?? body.ACTIVE ?? true
        }, req.admin.username);
        res.status(201).json({ success: true, data: rowUser(row) });
    } catch (error) {
        if (String(error.message).includes("UNIQUE constraint failed")) return res.status(409).json({ success: false, error: "EMPLOYEE_ID_OR_CARD_UID_ALREADY_EXISTS" });
        throw error;
    }
});

app.put("/api/v1/admin/users/:uuid", requireAdmin, (req, res) => {
    try {
        const old = db.prepare("SELECT * FROM users WHERE uuid=? AND deleted_at IS NULL").get(req.params.uuid);
        if (!old) return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
        const body = req.body || {};
        const row = upsertUser({
            UUID: old.uuid,
            EMPLOYEE_ID: body.employee_id ?? body.EMPLOYEE_ID ?? old.employee_id,
            NAME: body.name ?? body.NAME ?? old.name,
            CARD_UID: normalizeCardUid(body.card_uid ?? body.CARD_UID ?? old.card_uid),
            DEPARTMENT: body.department ?? body.DEPARTMENT ?? old.department,
            ROLE: normalize(body.role ?? body.ROLE ?? old.role),
            ACTIVE: body.active ?? body.ACTIVE ?? old.active,
            CREATED_AT: old.created_at
        }, req.admin.username);
        res.json({ success: true, data: rowUser(row) });
    } catch (error) {
        if (String(error.message).includes("UNIQUE constraint failed")) return res.status(409).json({ success: false, error: "EMPLOYEE_ID_OR_CARD_UID_ALREADY_EXISTS" });
        throw error;
    }
});

app.post("/api/v1/admin/nfc-capture", requireAdmin, async (req, res, next) => {
    try {
        const timeoutSeconds = Number(req.body?.timeout_seconds || 30);
        const result = await captureNfcCard(timeoutSeconds);
        audit("ADMIN", req.admin.username, "NFC_CARD_CAPTURE", "USERS", result.card_uid, { source: result.source });
        res.json({ success: true, ...result });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
        next(error);
    }
});

app.get("/api/v1/admin/transactions", requireAdmin, (req, res) => {
    const page = safePage(req.query.page);
    const limit = safeLimit(req.query.limit, 50, 200);
    const offset = (page - 1) * limit;
    const where = [];
    const args = [];
    const action = normalize(req.query.action || "");
    const search = String(req.query.search || "").trim();
    if (action) { where.push("action=?"); args.push(action); }
    if (search) {
        const s = `%${search}%`;
        where.push("(item_code LIKE ? COLLATE NOCASE OR item_name LIKE ? COLLATE NOCASE OR user_name LIKE ? COLLATE NOCASE OR transaction_id LIKE ? COLLATE NOCASE)");
        args.push(s, s, s, s);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM transactions ${whereSql}`).get(...args).c);
    const data = db.prepare(`SELECT * FROM transactions ${whereSql} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json({ success: true, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), data });
});

app.get("/api/v1/admin/devices", requireAdmin, requireAdministrator, (req, res) => {
    const data = db.prepare(`
        SELECT
            d.device_id,
            d.name,
            d.location,
            d.site,
            d.description,
            d.active,
            d.app_version,
            d.local_ip,
            d.tailscale_ip,
            d.cpu_temperature,
            d.disk_usage,
            d.uptime_seconds,
            d.nfc_status,
            d.camera_status,
            d.pending_count,
            d.last_sync_at,
            d.last_seen_at,
            d.paired_at,
            d.license_plan,
            d.license_status,
            d.license_fingerprint,
            d.license_last_verified_at,
            d.license_trial_expires_at,
            d.license_trial_started_at,
            d.license_days_remaining,
            d.license_product_slug,
            d.license_hostname,
            d.license_key_masked,
            d.license_offline,
            d.license_last_error,
            d.created_at,
            d.updated_at,
            (
                SELECT p.expires_at
                FROM device_pairings p
                WHERE p.device_id=d.device_id
                  AND p.consumed_at IS NULL
                  AND p.expires_at>?
                ORDER BY p.id DESC
                LIMIT 1
            ) AS pairing_expires_at
        FROM devices d
        WHERE d.deleted_at IS NULL OR TRIM(d.deleted_at)=''
        ORDER BY d.name COLLATE NOCASE
    `).all(nowIso()).map(row => ({
        ...row,
        is_local_central: row.device_id === LOCAL_DEVICE_ID
    }));

    res.json({ success: true, data });
});

app.post("/api/v1/admin/devices", requireAdmin, requireAdministrator, (req, res, next) => {
    try {
        const body = req.body || {};

        const device = createDevice({
            deviceId: body.device_id,
            name: body.name,
            location: body.location,
            site: body.site,
            description: body.description,
            active: body.active ?? true,
            actor: req.admin.username
        });

        let pairing = null;

        if (device.active) {
            pairing = createDevicePairing(
                device.device_id,
                req.admin.username,
                body.pairing_ttl_minutes ?? 15
            );
        }

        res.status(201).json({
            success: true,
            data: {
                device_id: device.device_id,
                name: device.name,
                location: device.location,
                site: device.site,
                description: device.description,
                active: Boolean(device.active),
                paired_at: device.paired_at
            },
            pairing
        });
    } catch (error) {
        if (error.message === "DEVICE_ID_ALREADY_EXISTS") {
            return res.status(409).json({ success: false, error: error.message });
        }
        if (["INVALID_DEVICE_ID", "DEVICE_NAME_REQUIRED"].includes(error.message)) {
            return res.status(400).json({ success: false, error: error.message });
        }
        next(error);
    }
});

app.put("/api/v1/admin/devices/:deviceId", requireAdmin, requireAdministrator, (req, res, next) => {
    try {
        const device = updateDevice(
            req.params.deviceId,
            req.body || {},
            req.admin.username
        );

        res.json({
            success: true,
            data: {
                device_id: device.device_id,
                name: device.name,
                location: device.location,
                site: device.site,
                description: device.description,
                active: Boolean(device.active),
                paired_at: device.paired_at,
                last_seen_at: device.last_seen_at
            }
        });
    } catch (error) {
        if (error.message === "DEVICE_NOT_FOUND") {
            return res.status(404).json({ success: false, error: error.message });
        }
        if (error.message === "DEVICE_NAME_REQUIRED") {
            return res.status(400).json({ success: false, error: error.message });
        }
        next(error);
    }
});

app.post("/api/v1/admin/devices/:deviceId/pairing", requireAdmin, requireAdministrator, (req, res, next) => {
    try {
        const pairing = createDevicePairing(
            req.params.deviceId,
            req.admin.username,
            req.body?.ttl_minutes ?? 15
        );

        res.json({
            success: true,
            device_id: req.params.deviceId,
            pairing
        });
    } catch (error) {
        if (error.message === "DEVICE_NOT_FOUND_OR_INACTIVE") {
            return res.status(404).json({ success: false, error: error.message });
        }
        next(error);
    }
});


app.get("/api/v1/admin/devices/:deviceId/license", requireAdmin, requireAdministrator, async (req, res, next) => {
    try {
        const device = getDeviceOrThrow(req.params.deviceId);
        let status;

        if (device.device_id === LOCAL_DEVICE_ID) {
            status = license.publicStatus(await license.verify({ force: false }));
            updateDeviceLicenseStatus(device.device_id, status);
        } else {
            status = deviceLicenseStatus(device);
        }

        res.json({
            success: true,
            device: {
                device_id: device.device_id,
                name: device.name,
                location: device.location,
                site: device.site,
                active: Boolean(device.active),
                paired_at: device.paired_at,
                last_seen_at: device.last_seen_at,
                is_local_central: device.device_id === LOCAL_DEVICE_ID
            },
            license: status,
            command: latestDeviceLicenseCommand(device.device_id)
        });
    } catch (error) {
        if (error.message === "DEVICE_NOT_FOUND") {
            return res.status(404).json({ success: false, error: error.message });
        }
        next(error);
    }
});

app.post("/api/v1/admin/devices/:deviceId/license/activate", requireAdmin, requireAdministrator, async (req, res, next) => {
    try {
        const device = getDeviceOrThrow(req.params.deviceId);
        const key = String(req.body?.license_key || "").trim();
        if (!key) return res.status(400).json({ success: false, error: "LICENSE_KEY_REQUIRED" });

        if (device.device_id === LOCAL_DEVICE_ID) {
            const result = await license.activate(key);
            const status = license.publicStatus(result.status);
            updateDeviceLicenseStatus(device.device_id, status);
            audit("ADMIN", req.admin.username, "DEVICE_LICENSE_ACTIVATE", "DEVICE", device.device_id, {
                mode: "DIRECT",
                plan: status.plan,
                status: status.status,
                fingerprint: status.fingerprint
            });
            return res.json({
                success: true,
                mode: "DIRECT",
                device_id: device.device_id,
                license: status
            });
        }

        const command = queueDeviceLicenseCommand(
            device.device_id,
            "ACTIVATE",
            { license_key: key },
            req.admin.username
        );

        audit("ADMIN", req.admin.username, "DEVICE_LICENSE_ACTIVATE_QUEUED", "DEVICE", device.device_id, {
            command_id: command.id
        });

        res.status(202).json({
            success: true,
            mode: "QUEUED",
            device_id: device.device_id,
            command,
            message: "License activation queued. The cabinet will apply it on its next heartbeat."
        });
    } catch (error) {
        if (["DEVICE_NOT_FOUND"].includes(error.message)) {
            return res.status(404).json({ success: false, error: error.message });
        }
        if (["DEVICE_INACTIVE", "LICENSE_KEY_REQUIRED", "DEVICE_LICENSE_PROVISIONING_SECRET_NOT_CONFIGURED"].includes(error.message)) {
            return res.status(400).json({ success: false, error: error.message });
        }
        if (error.remoteResponse) {
            return res.status(error.status || 400).json({
                success: false,
                error: error.message,
                details: error.data || null
            });
        }
        next(error);
    }
});

app.post("/api/v1/admin/devices/:deviceId/license/verify", requireAdmin, requireAdministrator, async (req, res, next) => {
    try {
        const device = getDeviceOrThrow(req.params.deviceId);

        if (device.device_id === LOCAL_DEVICE_ID) {
            const status = license.publicStatus(await license.verify({ force: true }));
            updateDeviceLicenseStatus(device.device_id, status);
            audit("ADMIN", req.admin.username, "DEVICE_LICENSE_VERIFY", "DEVICE", device.device_id, {
                mode: "DIRECT",
                plan: status.plan,
                status: status.status
            });
            return res.json({
                success: true,
                mode: "DIRECT",
                device_id: device.device_id,
                license: status
            });
        }

        const command = queueDeviceLicenseCommand(
            device.device_id,
            "VERIFY",
            null,
            req.admin.username
        );

        audit("ADMIN", req.admin.username, "DEVICE_LICENSE_VERIFY_QUEUED", "DEVICE", device.device_id, {
            command_id: command.id
        });

        res.status(202).json({
            success: true,
            mode: "QUEUED",
            device_id: device.device_id,
            command,
            message: "License verification queued."
        });
    } catch (error) {
        if (error.message === "DEVICE_NOT_FOUND") {
            return res.status(404).json({ success: false, error: error.message });
        }
        if (["DEVICE_INACTIVE", "DEVICE_LICENSE_PROVISIONING_SECRET_NOT_CONFIGURED"].includes(error.message)) {
            return res.status(400).json({ success: false, error: error.message });
        }
        next(error);
    }
});

app.delete("/api/v1/admin/devices/:deviceId", requireAdmin, requireAdministrator, (req, res, next) => {
    try {
        softDeleteDevice(req.params.deviceId, req.admin.username);
        res.json({ success: true });
    } catch (error) {
        if (error.message === "DEVICE_NOT_FOUND") {
            return res.status(404).json({ success: false, error: error.message });
        }
        next(error);
    }
});



/* =========================================================
   ADMIN WEB ACCOUNTS
========================================================= */

app.get(
    "/api/v1/admin/admin-users",
    requireAdmin,
    requireAdministrator,
    (req, res) => {
        const page = safePage(req.query.page);
        const limit = safeLimit(req.query.limit, 50, 200);
        const offset = (page - 1) * limit;
        const search = String(req.query.search || "").trim();

        const args = [];
        let where = "";

        if (search) {
            const s = `%${search}%`;
            where = `
                WHERE username LIKE ? COLLATE NOCASE
                   OR display_name LIKE ? COLLATE NOCASE
            `;
            args.push(s, s);
        }

        const total = Number(
            db.prepare(`
                SELECT COUNT(*) AS c
                FROM admin_accounts
                ${where}
            `).get(...args).c || 0
        );

        const rows = db.prepare(`
            SELECT
                id,
                username,
                display_name,
                role,
                active,
                created_at,
                updated_at
            FROM admin_accounts
            ${where}
            ORDER BY
                active DESC,
                display_name COLLATE NOCASE,
                username COLLATE NOCASE
            LIMIT ?
            OFFSET ?
        `).all(...args, limit, offset);

        res.json({
            success: true,
            page,
            limit,
            total,
            pages: Math.max(1, Math.ceil(total / limit)),
            data: rows.map(adminAccountView)
        });
    }
);

app.post(
    "/api/v1/admin/admin-users",
    requireAdmin,
    requireAdministrator,
    (req, res, next) => {
        try {
            const body = req.body || {};

            const username =
                validateAdminUsername(
                    body.username
                );

            const displayName =
                String(
                    body.display_name
                    ??
                    ""
                ).trim()
                ||
                username;

            const role =
                normalizeAdminAccountRole(
                    body.role
                    ??
                    "ADMIN_STAFF"
                );

            const password =
                String(
                    body.password
                    ??
                    ""
                );

            const active =
                body.active === undefined
                    ?
                    1
                    :
                    (body.active ? 1 : 0);

            if (password.length < 8) {
                return res.status(400).json({
                    success: false,
                    error: "ADMIN_PASSWORD_MIN_8"
                });
            }

            if (
                db.prepare(`
                    SELECT 1
                    FROM admin_accounts
                    WHERE username=?
                    LIMIT 1
                `).get(username)
            ) {
                return res.status(409).json({
                    success: false,
                    error: "ADMIN_USERNAME_ALREADY_EXISTS"
                });
            }

            const { salt, hash } =
                hashPassword(
                    password
                );

            const ts =
                nowIso();

            const result = db.prepare(`
                INSERT INTO admin_accounts(
                    username,
                    password_salt,
                    password_hash,
                    display_name,
                    role,
                    active,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                username,
                salt,
                hash,
                displayName,
                role,
                active,
                ts,
                ts
            );

            const row = db.prepare(`
                SELECT
                    id,
                    username,
                    display_name,
                    role,
                    active,
                    created_at,
                    updated_at
                FROM admin_accounts
                WHERE id=?
            `).get(
                Number(result.lastInsertRowid)
            );

            audit(
                "ADMIN",
                req.admin.username,
                "ADMIN_ACCOUNT_CREATE",
                "ADMIN_ACCOUNTS",
                String(row.id),
                {
                    username: row.username,
                    role: normalizeAdminAccountRole(row.role),
                    active: Boolean(row.active)
                }
            );

            res.status(201).json({
                success: true,
                data: adminAccountView(row)
            });

        } catch (error) {
            if (
                String(error.message)
                    .includes("UNIQUE constraint failed")
            ) {
                return res.status(409).json({
                    success: false,
                    error: "ADMIN_USERNAME_ALREADY_EXISTS"
                });
            }

            if (
                [
                    "INVALID_ADMIN_USERNAME",
                    "INVALID_ADMIN_ROLE"
                ].includes(error.message)
            ) {
                return res.status(400).json({
                    success: false,
                    error: error.message
                });
            }

            next(error);
        }
    }
);

app.put(
    "/api/v1/admin/admin-users/:id",
    requireAdmin,
    requireAdministrator,
    (req, res, next) => {
        try {
            const id =
                Number(
                    req.params.id
                );

            if (
                !Number.isInteger(id)
                ||
                id <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    error: "INVALID_ADMIN_ID"
                });
            }

            const current = db.prepare(`
                SELECT *
                FROM admin_accounts
                WHERE id=?
                LIMIT 1
            `).get(id);

            if (!current) {
                return res.status(404).json({
                    success: false,
                    error: "ADMIN_ACCOUNT_NOT_FOUND"
                });
            }

            const body =
                req.body
                ||
                {};

            const username =
                body.username === undefined
                    ?
                    current.username
                    :
                    validateAdminUsername(
                        body.username
                    );

            const displayName =
                body.display_name === undefined
                    ?
                    current.display_name
                    :
                    (
                        String(
                            body.display_name
                            ??
                            ""
                        ).trim()
                        ||
                        username
                    );

            const role =
                body.role === undefined
                    ?
                    normalizeAdminAccountRole(
                        current.role
                    )
                    :
                    normalizeAdminAccountRole(
                        body.role
                    );

            const active =
                body.active === undefined
                    ?
                    Number(current.active)
                    :
                    (body.active ? 1 : 0);

            /*
             * The signed-in administrator cannot remove their own
             * administrator permission or disable their own account.
             */
            if (
                Number(req.admin.id) === id
                &&
                (
                    !active
                    ||
                    !isAdministratorRole(role)
                )
            ) {
                return res.status(409).json({
                    success: false,
                    error: "CANNOT_RESTRICT_CURRENT_ACCOUNT"
                });
            }

            /*
             * Always keep at least one active Administrator.
             */
            if (
                isAdministratorRole(current.role)
                &&
                (
                    !active
                    ||
                    !isAdministratorRole(role)
                )
                &&
                countOtherActiveAdministrators(id) < 1
            ) {
                return res.status(409).json({
                    success: false,
                    error: "LAST_ADMINISTRATOR_REQUIRED"
                });
            }

            const duplicate = db.prepare(`
                SELECT 1
                FROM admin_accounts
                WHERE username=?
                  AND id<>?
                LIMIT 1
            `).get(
                username,
                id
            );

            if (duplicate) {
                return res.status(409).json({
                    success: false,
                    error: "ADMIN_USERNAME_ALREADY_EXISTS"
                });
            }

            const password =
                body.password === undefined
                    ?
                    ""
                    :
                    String(
                        body.password
                        ??
                        ""
                    );

            let salt =
                current.password_salt;

            let hash =
                current.password_hash;

            let passwordChanged =
                false;

            if (password) {
                if (password.length < 8) {
                    return res.status(400).json({
                        success: false,
                        error: "ADMIN_PASSWORD_MIN_8"
                    });
                }

                const generated =
                    hashPassword(
                        password
                    );

                salt =
                    generated.salt;

                hash =
                    generated.hash;

                passwordChanged =
                    true;
            }

            const ts =
                nowIso();

            db.prepare(`
                UPDATE admin_accounts
                SET
                    username=?,
                    display_name=?,
                    role=?,
                    active=?,
                    password_salt=?,
                    password_hash=?,
                    updated_at=?
                WHERE id=?
            `).run(
                username,
                displayName,
                role,
                active,
                salt,
                hash,
                ts,
                id
            );

            /*
             * Password/security changes invalidate other sessions.
             * The currently signed-in session is preserved when
             * editing the current account.
             */
            if (
                passwordChanged
                ||
                !active
            ) {
                if (
                    Number(req.admin.id) === id
                ) {
                    const currentToken =
                        parseCookies(req)
                            .ls_admin_session;

                    const currentTokenHash =
                        currentToken
                            ?
                            hashSecret(
                                currentToken
                            )
                            :
                            "";

                    db.prepare(`
                        DELETE FROM admin_sessions
                        WHERE admin_id=?
                          AND token_hash<>?
                    `).run(
                        id,
                        currentTokenHash
                    );

                } else {
                    db.prepare(`
                        DELETE FROM admin_sessions
                        WHERE admin_id=?
                    `).run(id);
                }
            }

            const row = db.prepare(`
                SELECT
                    id,
                    username,
                    display_name,
                    role,
                    active,
                    created_at,
                    updated_at
                FROM admin_accounts
                WHERE id=?
            `).get(id);

            audit(
                "ADMIN",
                req.admin.username,
                "ADMIN_ACCOUNT_UPDATE",
                "ADMIN_ACCOUNTS",
                String(id),
                {
                    username: row.username,
                    role: normalizeAdminAccountRole(row.role),
                    active: Boolean(row.active),
                    password_changed: passwordChanged
                }
            );

            res.json({
                success: true,
                data: adminAccountView(row)
            });

        } catch (error) {
            if (
                String(error.message)
                    .includes("UNIQUE constraint failed")
            ) {
                return res.status(409).json({
                    success: false,
                    error: "ADMIN_USERNAME_ALREADY_EXISTS"
                });
            }

            if (
                [
                    "INVALID_ADMIN_USERNAME",
                    "INVALID_ADMIN_ROLE"
                ].includes(error.message)
            ) {
                return res.status(400).json({
                    success: false,
                    error: error.message
                });
            }

            next(error);
        }
    }
);

app.delete(
    "/api/v1/admin/admin-users/:id",
    requireAdmin,
    requireAdministrator,
    (req, res) => {
        const id =
            Number(
                req.params.id
            );

        if (
            !Number.isInteger(id)
            ||
            id <= 0
        ) {
            return res.status(400).json({
                success: false,
                error: "INVALID_ADMIN_ID"
            });
        }

        const current = db.prepare(`
            SELECT *
            FROM admin_accounts
            WHERE id=?
            LIMIT 1
        `).get(id);

        if (!current) {
            return res.status(404).json({
                success: false,
                error: "ADMIN_ACCOUNT_NOT_FOUND"
            });
        }

        if (
            Number(req.admin.id) === id
        ) {
            return res.status(409).json({
                success: false,
                error: "CANNOT_DELETE_CURRENT_ACCOUNT"
            });
        }

        if (
            isAdministratorRole(current.role)
            &&
            current.active
            &&
            countOtherActiveAdministrators(id) < 1
        ) {
            return res.status(409).json({
                success: false,
                error: "LAST_ADMINISTRATOR_REQUIRED"
            });
        }

        const ts =
            nowIso();

        db.prepare(`
            UPDATE admin_accounts
            SET active=0, updated_at=?
            WHERE id=?
        `).run(
            ts,
            id
        );

        db.prepare(`
            DELETE FROM admin_sessions
            WHERE admin_id=?
        `).run(id);

        audit(
            "ADMIN",
            req.admin.username,
            "ADMIN_ACCOUNT_DELETE",
            "ADMIN_ACCOUNTS",
            String(id),
            {
                username: current.username
            }
        );

        res.json({
            success: true
        });
    }
);

app.get("/api/v1/admin/settings", requireAdmin, requireAdministrator, (req, res) => {
    const settings = {};
    const admin = {};
    for (const row of db.prepare("SELECT key, value FROM settings ORDER BY key").all()) settings[row.key] = row.value;
    for (const row of db.prepare("SELECT key, value FROM admin_config ORDER BY key").all()) admin[row.key] = row.value;
    res.json({ success: true, settings, admin });
});

app.put("/api/v1/admin/settings", requireAdmin, requireAdministrator, (req, res) => {
    const settings = req.body?.settings || {};
    const adminConfig = req.body?.admin || {};
    for (const [k, v] of Object.entries(settings)) setSetting(k, v, req.admin.username);
    for (const [k, v] of Object.entries(adminConfig)) setAdminConfig(k, v, req.admin.username);
    res.json({ success: true });
});


/*
 * =========================================================
 * DEVICE PAIRING
 *
 * Public only inside the Central HTTP service. Authentication
 * is the short-lived single-use 6-digit pairing code.
 * Rate limited per source address.
 * =========================================================
 */
app.post("/api/v1/device/pair", (req, res, next) => {
    try {
        const limiter = allowPairingAttempt(req);

        if (!limiter.allowed) {
            res.setHeader("Retry-After", String(limiter.retry_after_seconds));
            return res.status(429).json({
                success: false,
                error: "PAIRING_RATE_LIMITED",
                retry_after_seconds: limiter.retry_after_seconds
            });
        }

        const code = String(req.body?.pairing_code || "").replace(/\D/g, "");

        if (code.length !== 6) {
            return res.status(400).json({
                success: false,
                error: "INVALID_PAIRING_CODE"
            });
        }

        const result = consumeDevicePairing(code, {
            hostname: String(req.body?.hostname || "").trim() || null,
            app_version: String(req.body?.app_version || "").trim() || null,
            local_ip: String(req.body?.local_ip || "").trim() || null,
            tailscale_ip: String(req.body?.tailscale_ip || "").trim() || null
        });

        clearPairingAttempts(req);

        res.json({
            success: true,
            device: {
                device_id: result.device_id,
                device_name: result.device_name,
                location: result.location,
                site: result.site,
                description: result.description,
                paired_at: result.paired_at
            },
            credentials: {
                device_api_key: result.device_api_key
            },
            server_time: nowIso()
        });
    } catch (error) {
        if (["PAIRING_CODE_INVALID_OR_EXPIRED", "INVALID_PAIRING_CODE"].includes(error.message)) {
            return res.status(401).json({ success: false, error: error.message });
        }
        next(error);
    }
});


app.get("/api/v1/device/license/provision", requireDevice, (req, res, next) => {
    try {
        const ts = nowIso();

        db.prepare(`
            UPDATE device_license_commands
            SET status='EXPIRED', completed_at=?, error_text='COMMAND_EXPIRED'
            WHERE device_id=?
              AND status IN ('PENDING','PROCESSING')
              AND expires_at<=?
        `).run(ts, req.device.device_id, ts);

        const row = db.prepare(`
            SELECT *
            FROM device_license_commands
            WHERE device_id=?
              AND status IN ('PENDING','PROCESSING')
              AND expires_at>?
            ORDER BY id ASC
            LIMIT 1
        `).get(req.device.device_id, ts);

        if (!row) {
            return res.json({ success: true, command: null, server_time: ts });
        }

        if (row.status === 'PENDING') {
            db.prepare(`
                UPDATE device_license_commands
                SET status='PROCESSING', delivered_at=COALESCE(delivered_at, ?)
                WHERE id=?
            `).run(ts, row.id);
        }

        const command = {
            id: Number(row.id),
            action: row.command,
            created_at: row.created_at,
            expires_at: row.expires_at
        };

        if (row.command === 'ACTIVATE') {
            const payload = decryptProvisioningPayload(row.payload_enc);
            command.license_key = String(payload.license_key || '').trim();
        }

        res.json({ success: true, command, server_time: ts });
    } catch (error) {
        next(error);
    }
});

app.post("/api/v1/device/license/provision/:commandId/ack", requireDevice, (req, res, next) => {
    try {
        const id = Number(req.params.commandId);
        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({ success: false, error: "INVALID_LICENSE_COMMAND_ID" });
        }

        const command = db.prepare(`
            SELECT *
            FROM device_license_commands
            WHERE id=? AND device_id=?
            LIMIT 1
        `).get(id, req.device.device_id);

        if (!command) {
            return res.status(404).json({ success: false, error: "LICENSE_COMMAND_NOT_FOUND" });
        }

        const body = req.body || {};
        const success = Boolean(body.success);
        const status = body.license && typeof body.license === "object" ? body.license : {};
        const ts = nowIso();

        db.prepare(`
            UPDATE device_license_commands
            SET status=?, completed_at=?, result_json=?, error_text=?, payload_enc=NULL
            WHERE id=?
        `).run(
            success ? "SUCCESS" : "FAILED",
            ts,
            JSON.stringify(status),
            success ? null : String(body.error || "LICENSE_COMMAND_FAILED"),
            id
        );

        if (Object.keys(status).length) {
            updateDeviceLicenseStatus(req.device.device_id, status);
        }

        audit("DEVICE", req.device.device_id, success ? "LICENSE_COMMAND_SUCCESS" : "LICENSE_COMMAND_FAILED", "DEVICE", req.device.device_id, {
            command_id: id,
            command: command.command,
            error: success ? null : String(body.error || "LICENSE_COMMAND_FAILED")
        });

        res.json({ success: true, server_time: ts });
    } catch (error) {
        next(error);
    }
});

app.get("/api/v1/device/snapshot/:entity", requireDevice, (req, res) => {
    const entity = normalize(req.params.entity);
    const page = safePage(req.query.page);
    const limit = safeLimit(req.query.limit, 500, 1000);
    const offset = (page - 1) * limit;
    const currentCursor = Number(db.prepare("SELECT COALESCE(MAX(change_id),0) AS c FROM sync_changes").get().c || 0);

    if (entity === "USERS") {
        const total = Number(db.prepare("SELECT COUNT(*) AS c FROM users WHERE active=1 AND deleted_at IS NULL").get().c);
        const data = db.prepare("SELECT * FROM users WHERE active=1 AND deleted_at IS NULL ORDER BY uuid LIMIT ? OFFSET ?").all(limit, offset).map(rowUser);
        return res.json({ success: true, entity, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), current_cursor: currentCursor, data });
    }
    if (entity === "ITEMS") {
        const total = Number(db.prepare("SELECT COUNT(*) AS c FROM items WHERE deleted_at IS NULL").get().c);
        const data = db.prepare("SELECT * FROM items WHERE deleted_at IS NULL ORDER BY uuid LIMIT ? OFFSET ?").all(limit, offset).map(rowItem);
        return res.json({ success: true, entity, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), current_cursor: currentCursor, data });
    }
    if (entity === "SETTINGS") {
        const data = db.prepare("SELECT key AS KEY, value AS VALUE, updated_at AS UPDATED_AT FROM settings ORDER BY key").all();
        return res.json({ success: true, entity, current_cursor: currentCursor, data });
    }
    if (entity === "ADMIN") {
        const data = db.prepare("SELECT key AS KEY, value AS VALUE, updated_at AS UPDATED_AT FROM admin_config ORDER BY key").all();
        return res.json({ success: true, entity, current_cursor: currentCursor, data });
    }
    res.status(400).json({ success: false, error: "INVALID_ENTITY" });
});

app.get("/api/v1/device/changes", requireDevice, (req, res) => {
    const after = Math.max(0, Number(req.query.after || 0));
    const limit = safeLimit(req.query.limit, 500, 1000);
    const rows = db.prepare(`
        SELECT change_id, entity_type, entity_key, operation, payload_json, created_at
        FROM sync_changes WHERE change_id>? ORDER BY change_id ASC LIMIT ?
    `).all(after, limit);
    const changes = rows.map(row => ({ ...row, payload: row.payload_json ? JSON.parse(row.payload_json) : null })).map(({ payload_json, ...row }) => row);
    const nextCursor = changes.length ? Number(changes[changes.length - 1].change_id) : after;
    const maxCursor = Number(db.prepare("SELECT COALESCE(MAX(change_id),0) AS c FROM sync_changes").get().c || 0);
    res.json({ success: true, after, next_cursor: nextCursor, max_cursor: maxCursor, has_more: nextCursor < maxCursor, count: changes.length, changes });
});

app.post("/api/v1/device/heartbeat", requireDevice, (req, res) => {
    const body = req.body || {};
    const ts = nowIso();
    db.prepare(`
        UPDATE devices SET
            app_version=COALESCE(?,app_version), local_ip=COALESCE(?,local_ip),
            tailscale_ip=COALESCE(?,tailscale_ip), cpu_temperature=COALESCE(?,cpu_temperature),
            disk_usage=COALESCE(?,disk_usage), uptime_seconds=COALESCE(?,uptime_seconds),
            nfc_status=COALESCE(?,nfc_status), camera_status=COALESCE(?,camera_status),
            pending_count=COALESCE(?,pending_count), last_sync_at=COALESCE(?,last_sync_at),
            license_plan=COALESCE(?,license_plan), license_status=COALESCE(?,license_status),
            license_fingerprint=COALESCE(?,license_fingerprint),
            license_last_verified_at=COALESCE(?,license_last_verified_at),
            license_trial_expires_at=COALESCE(?,license_trial_expires_at),
            license_trial_started_at=COALESCE(?,license_trial_started_at),
            license_days_remaining=COALESCE(?,license_days_remaining),
            license_product_slug=COALESCE(?,license_product_slug),
            license_hostname=COALESCE(?,license_hostname),
            license_key_masked=COALESCE(?,license_key_masked),
            license_offline=COALESCE(?,license_offline),
            license_last_error=?,
            paired_at=COALESCE(paired_at, ?),
            last_seen_at=?, updated_at=?
        WHERE device_id=?
    `).run(
        body.app_version ?? null,
        body.local_ip ?? null,
        body.tailscale_ip ?? null,
        body.cpu_temperature ?? null,
        body.disk_usage ?? null,
        body.uptime_seconds ?? null,
        body.nfc_status ?? null,
        body.camera_status ?? null,
        body.pending_count ?? null,
        body.last_sync_at ?? null,
        body.license_plan ?? null,
        body.license_status ?? null,
        body.license_fingerprint ?? null,
        body.license_last_verified_at ?? null,
        body.license_trial_expires_at ?? null,
        body.license_trial_started_at ?? null,
        body.license_days_remaining ?? null,
        body.license_product_slug ?? null,
        body.license_hostname ?? null,
        body.license_key_masked ?? null,
        body.license_offline ?? null,
        body.license_last_error ?? null,
        ts,
        ts,
        ts,
        req.device.device_id
    );
    res.json({ success: true, server_time: ts });
});

app.post("/api/v1/device/transactions", requireDevice, (req, res) => {
    const transactions = Array.isArray(req.body?.transactions) ? req.body.transactions : [];
    if (!transactions.length) return res.status(400).json({ success: false, error: "TRANSACTIONS_REQUIRED" });
    if (transactions.length > 100) return res.status(400).json({ success: false, error: "MAX_100_TRANSACTIONS_PER_BATCH" });
    const results = transactions.map(tx => processDeviceTransaction(tx, req.device));
    res.json({ success: true, total: results.length, successful: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results });
});

app.use("/ls-admin", express.static(path.join(PUBLIC_DIR, "ls-admin"), { index: "index.html" }));
app.get("/", (req, res) => res.redirect("/ls-admin/"));

app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) return next(error);
    res.status(500).json({ success: false, error: "INTERNAL_SERVER_ERROR", message: process.env.NODE_ENV === "development" ? error.message : undefined });
});

app.listen(PORT, HOST, () => {
    console.log("");
    console.log("========================================");
    console.log("      LS Inventory Central Server");
    console.log("========================================");
    console.log(`API      : http://${HOST}:${PORT}/api/v1`);
    console.log(`Web Admin: http://${HOST}:${PORT}/ls-admin/`);
    console.log(`Health   : http://${HOST}:${PORT}/health`);
    console.log("========================================");
    console.log("");

    license.verify({ force: false })
        .then(status => {
            console.log(`License  : ${String(status.plan).toUpperCase()} / ${status.status}`);
        })
        .catch(error => {
            console.error("License verification:", error.message);
        });
});

setInterval(() => {
    license.verify({ force: true }).catch(error => {
        console.error("Scheduled license verification:", error.message);
    });
}, 6 * 60 * 60 * 1000).unref();
