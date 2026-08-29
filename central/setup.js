"use strict";

require("dotenv").config({
    path: "/opt/LS_Inventory/.env",
    quiet: true
});

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
    db: centralDb,
    upsertUser: centralUpsertUser,
    upsertItem: centralUpsertItem,
    setSetting: centralSetSetting,
    setAdminConfig: centralSetAdminConfig,
    createAdmin,
    createOrRotateDevice
} = require("./db");

const local = require("../services/local_database");

const ROOT = "/opt/LS_Inventory";
const ENV_FILE = path.join(ROOT, ".env");
const CACHE_DIR = path.join(ROOT, "cache");

function readJson(filename, fallback) {
    const file = path.join(CACHE_DIR, filename);
    if (!fs.existsSync(file)) return fallback;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { console.error(`Cannot read ${file}:`, error.message); return fallback; }
}

function sanitizeDeviceId(value) {
    const s = String(value || "LS_Cab_Main").trim().replace(/[^A-Za-z0-9_-]+/g, "_");
    return s || "LS_Cab_Main";
}

function updateEnv(values) {
    let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
    for (const [key, value] of Object.entries(values)) {
        const line = `${key}=${String(value)}`;
        const regex = new RegExp(`^${key}=.*$`, "m");
        if (regex.test(text)) text = text.replace(regex, line);
        else text += `${text.endsWith("\n") || !text ? "" : "\n"}${line}\n`;
    }
    fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
}

function randomPassword(length = 18) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(0, alphabet.length)];
    return out;
}

async function main() {
    console.log("\n========================================");
    console.log(" LS Inventory Central + Cabinet Setup");
    console.log("========================================\n");

    const users = readJson("users.json", []);
    const items = readJson("items.json", []);
    const settings = readJson("settings.json", {});
    const admin = readJson("admin.json", {});

    let userCount = 0;
    let itemCount = 0;
    let skippedItems = 0;

    if (Array.isArray(users)) {
        for (const user of users) {
            try {
                centralUpsertUser(user, "MIGRATION");
                local.upsertUser(user);
                userCount++;
            } catch (error) {
                console.error("Skip user:", user.NAME || user.UUID || "?", error.message);
            }
        }
    }

    if (Array.isArray(items)) {
        for (const item of items) {
            try {
                centralUpsertItem(item, "MIGRATION");
                local.upsertItem(item);
                itemCount++;
            } catch (error) {
                skippedItems++;
                console.error("Skip item:", item.ITEM_NAME || item.UUID || "?", error.message);
            }
        }
    }

    if (settings && typeof settings === "object" && !Array.isArray(settings)) {
        for (const [key, value] of Object.entries(settings)) {
            centralSetSetting(key, value, "MIGRATION");
            local.setSetting(key, value);
        }
    }

    if (admin && typeof admin === "object" && !Array.isArray(admin)) {
        for (const [key, value] of Object.entries(admin)) {
            centralSetAdminConfig(key, value, "MIGRATION");
            local.setAdminConfig(key, value);
        }
    }

    const adminUsername = process.env.LS_ADMIN_USERNAME || "admin";
    let adminPassword = null;
    const adminExists = centralDb.prepare("SELECT 1 FROM admin_accounts WHERE username=?").get(adminUsername);
    const resetAdmin = process.argv.includes("--reset-admin");
    if (!adminExists || resetAdmin) {
        adminPassword = randomPassword();
        createAdmin(adminUsername, adminPassword, "LS Inventory Administrator");
    }

    const deviceName = String(admin.DEVICE_NAME || process.env.DEVICE_NAME || "LS Cabinet Main").trim();
    const deviceId = sanitizeDeviceId(process.env.DEVICE_ID || deviceName);
    let deviceKey = String(process.env.DEVICE_API_KEY || "").trim();
    if (!deviceKey) deviceKey = crypto.randomBytes(32).toString("hex");

    createOrRotateDevice(deviceId, deviceName, admin.LOCATION || settings.LOCATION || "Main Cabinet", deviceKey);

    const maxCursor = Number(centralDb.prepare("SELECT COALESCE(MAX(change_id),0) AS c FROM sync_changes").get().c || 0);
    local.setSyncState("master_cursor", String(maxCursor));
    local.exportCaches();

    updateEnv({
        CENTRAL_API_URL: process.env.CENTRAL_API_URL || "http://127.0.0.1:3100",
        CENTRAL_PORT: process.env.CENTRAL_PORT || "3100",
        DEVICE_ID: deviceId,
        DEVICE_API_KEY: deviceKey
    });

    console.log(`Users imported : ${userCount}`);
    console.log(`Items imported : ${itemCount}`);
    if (skippedItems) console.log(`Items skipped  : ${skippedItems}`);
    console.log(`Device ID      : ${deviceId}`);
    console.log(`Sync cursor    : ${maxCursor}`);
    console.log(`Central DB     : /opt/LS_Inventory/central/data/central.db`);
    console.log(`Device DB      : /opt/LS_Inventory/data/device.db`);
    console.log("\nDevice API key has been saved to /opt/LS_Inventory/.env (mode 600).");

    if (adminPassword) {
        console.log("\n========================================");
        console.log(" SAVE THIS ADMIN LOGIN NOW");
        console.log("========================================");
        console.log(`Username : ${adminUsername}`);
        console.log(`Password : ${adminPassword}`);
        console.log("========================================");
        console.log("Password is stored only as a hash in central.db.");
    } else {
        console.log(`\nAdmin '${adminUsername}' already exists. Use --reset-admin if you need a new password.`);
    }

    console.log("\nSetup complete.\n");
}

main().catch(error => {
    console.error("SETUP FAILED:", error);
    process.exit(1);
});
