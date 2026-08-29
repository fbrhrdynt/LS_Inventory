"use strict";

require("dotenv").config({
    path: "/opt/LS_Inventory/.env",
    quiet: true
});

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { google } = require("googleapis");
const { db, nowIso, normalize, audit } = require("./db");

const ROOT = "/opt/LS_Inventory";
const CLIENT_FILE = path.join(ROOT, "config", "oauth-client.json");
const TOKEN_FILE = path.join(ROOT, "config", "google-token.json");
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DEVICE_ID = process.env.DEVICE_ID;

function rowsToObjects(rows) {
    if (!rows?.length) return [];
    const headers = rows[0].map(v => normalize(v));
    return rows.slice(1).filter(row => row.some(v => String(v ?? "").trim())).map(row => {
        const obj = {};
        headers.forEach((h, i) => { if (h) obj[h] = row[i] ?? ""; });
        return obj;
    });
}

function legacyKey(value, row) {
    const raw = String(value || JSON.stringify(row));
    return `LEGACY-${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

async function main() {
    if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID tidak tersedia.");
    if (!DEVICE_ID) throw new Error("Jalankan central/setup.js terlebih dahulu agar DEVICE_ID tersedia.");
    if (!fs.existsSync(CLIENT_FILE) || !fs.existsSync(TOKEN_FILE)) throw new Error("Google OAuth files tidak ditemukan.");

    const clientData = JSON.parse(fs.readFileSync(CLIENT_FILE, "utf8"));
    const client = clientData.installed || clientData.web;
    const oauth = new google.auth.OAuth2(client.client_id, client.client_secret, client.redirect_uris?.[0] || "http://localhost");
    oauth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")));
    const sheets = google.sheets({ version: "v4", auth: oauth });

    console.log("Reading legacy TRANSACTIONS from Google Sheets...");
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "TRANSACTIONS!A:Z" });
    const rows = rowsToObjects(response.data.values || []);

    let imported = 0;
    let skipped = 0;
    let duplicates = 0;

    const insert = db.prepare(`
        INSERT INTO transactions(
            transaction_uuid, transaction_id, device_id, item_uuid, item_code, item_name,
            user_uuid, user_name, card_uid, action, qty, status, occurred_at, created_at,
            sync_error, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMMITTED', ?, ?, NULL, ?)
    `);

    for (const row of rows) {
        try {
            const action = normalize(row.ACTION);
            if (!["BORROW", "RETURN", "CONSUME", "ADJUSTMENT"].includes(action)) { skipped++; continue; }

            let item = null;
            const itemUuid = row.UUID || row.ITEM_UUID || row.ITEM_UUIDS || "";
            if (itemUuid) item = db.prepare("SELECT * FROM items WHERE uuid=? LIMIT 1").get(itemUuid);
            if (!item && row.ITEM_CODE) item = db.prepare("SELECT * FROM items WHERE UPPER(item_code)=UPPER(?) LIMIT 1").get(row.ITEM_CODE);

            let user = null;
            if (row.USER_UUID) user = db.prepare("SELECT * FROM users WHERE uuid=? LIMIT 1").get(row.USER_UUID);
            if (!user && row.USER_NAME) user = db.prepare("SELECT * FROM users WHERE UPPER(name)=UPPER(?) LIMIT 1").get(row.USER_NAME);

            if (!item || !user) { skipped++; continue; }

            const transactionId = String(row.TRANSACTION_ID || row.ID || "").trim() || legacyKey("", row);
            const transactionUuid = legacyKey(transactionId, row);
            if (db.prepare("SELECT 1 FROM transactions WHERE transaction_uuid=?").get(transactionUuid)) { duplicates++; continue; }

            const occurredAt = String(row.TIMESTAMP || row.CREATED_AT || nowIso()).trim();
            insert.run(
                transactionUuid,
                transactionId,
                DEVICE_ID,
                item.uuid,
                item.item_code,
                row.ITEM_NAME || item.item_name,
                user.uuid,
                row.USER_NAME || user.name,
                row.CARD_UID || user.card_uid,
                action,
                Math.max(1, Number(row.QTY || 1)),
                occurredAt,
                occurredAt,
                JSON.stringify({ legacy_google: true, original_status: row.STATUS || "", original_device: row.DEVICE || "" })
            );
            imported++;
        } catch (error) {
            console.error("Skip legacy row:", error.message);
            skipped++;
        }
    }

    audit("MIGRATION", "GOOGLE", "LEGACY_TRANSACTIONS_IMPORT", "TRANSACTIONS", "BATCH", { imported, skipped, duplicates });
    console.log(`Imported   : ${imported}`);
    console.log(`Duplicates : ${duplicates}`);
    console.log(`Skipped    : ${skipped}`);
}

main().catch(error => {
    console.error("LEGACY IMPORT FAILED:", error.message);
    process.exit(1);
});
