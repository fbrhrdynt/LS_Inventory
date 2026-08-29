"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = "/opt/LS_Inventory";
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "device.db");
const CACHE_DIR = path.join(ROOT, "cache");

fs.mkdirSync(DATA_DIR, {
    recursive: true
});

fs.mkdirSync(CACHE_DIR, {
    recursive: true
});

const db =
    new DatabaseSync(
        DB_FILE
    );

db.exec(
    "PRAGMA journal_mode=WAL;"
);

db.exec(
    "PRAGMA foreign_keys=ON;"
);

db.exec(
    "PRAGMA busy_timeout=5000;"
);

db.exec(
    "PRAGMA synchronous=NORMAL;"
);


/* =========================================================
   HELPERS
========================================================= */

function nowIso() {

    return new Date()
        .toISOString();
}


function normalize(
    value
) {

    return String(
        value ??
        ""
    )
        .trim()
        .toUpperCase();
}


function nullable(
    value
) {

    if (
        value === undefined
        ||
        value === null
    ) {

        return null;
    }


    const text =
        String(
            value
        ).trim();


    if (
        text === ""
    ) {

        return null;
    }


    return text;
}


function asInt(
    value,
    fallback = 0
) {

    const number =
        Number(
            value
        );


    if (
        !Number.isFinite(
            number
        )
    ) {

        return fallback;
    }


    return Math.trunc(
        number
    );
}


function boolInt(
    value,
    fallback = 1
) {

    if (
        value === undefined
        ||
        value === null
        ||
        value === ""
    ) {

        return fallback;
    }


    const normalized =
        normalize(
            value
        );


    if (
        [
            "TRUE",
            "1",
            "YES",
            "Y",
            "ACTIVE",
            "ENABLED"
        ].includes(
            normalized
        )
    ) {

        return 1;
    }


    if (
        [
            "FALSE",
            "0",
            "NO",
            "N",
            "INACTIVE",
            "DISABLED"
        ].includes(
            normalized
        )
    ) {

        return 0;
    }


    return value
        ?
        1
        :
        0;
}


function normalizeCardUid(
    value
) {

    const clean =
        normalize(
            value
        )
            .replace(
                /[^0-9A-F]/g,
                ""
            );


    if (
        !clean
    ) {

        return null;
    }


    return (
        clean
            .match(
                /.{1,2}/g
            )
            ?.join(
                ":"
            )
        ??
        clean
    );
}


/*
 * Compatibility:
 *
 * data lama pernah menyimpan:
 *
 * deleted_at = ''
 *
 * Padahal secara database seharusnya:
 *
 * deleted_at = NULL
 *
 * Query aktif menerima keduanya.
 */

function activeRowSql(
    alias = ""
) {

    const prefix =
        alias
            ?
            `${alias}.`
            :
            "";


    return (
        `(${prefix}deleted_at IS NULL `
        +
        `OR TRIM(${prefix}deleted_at)='')`
    );
}


/* =========================================================
   LEGACY NORMALIZATION
========================================================= */

function normalizeLegacyNulls() {

    db.exec(`
        UPDATE users
        SET deleted_at = NULL
        WHERE deleted_at IS NOT NULL
          AND TRIM(deleted_at) = '';

        UPDATE items
        SET deleted_at = NULL
        WHERE deleted_at IS NOT NULL
          AND TRIM(deleted_at) = '';

        UPDATE items
        SET borrowed_by_uuid = NULL
        WHERE borrowed_by_uuid IS NOT NULL
          AND TRIM(borrowed_by_uuid) = '';

        UPDATE items
        SET borrowed_by_name = NULL
        WHERE borrowed_by_name IS NOT NULL
          AND TRIM(borrowed_by_name) = '';

        UPDATE items
        SET borrowed_at = NULL
        WHERE borrowed_at IS NOT NULL
          AND TRIM(borrowed_at) = '';
    `);
}


/* =========================================================
   DATABASE INIT
========================================================= */

function initLocalDatabase() {

    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            uuid TEXT PRIMARY KEY,
            employee_id TEXT,
            name TEXT NOT NULL,
            card_uid TEXT UNIQUE,
            department TEXT,
            role TEXT NOT NULL DEFAULT 'USER',
            active INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );

        CREATE INDEX IF NOT EXISTS
        idx_local_users_card_uid
        ON users(card_uid);

        CREATE INDEX IF NOT EXISTS
        idx_local_users_name
        ON users(name);

        CREATE INDEX IF NOT EXISTS
        idx_local_users_active
        ON users(active, deleted_at);


        CREATE TABLE IF NOT EXISTS items (
            uuid TEXT PRIMARY KEY,
            qr_code TEXT UNIQUE,
            item_code TEXT UNIQUE,
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
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );

        CREATE INDEX IF NOT EXISTS
        idx_local_items_qr
        ON items(qr_code);

        CREATE INDEX IF NOT EXISTS
        idx_local_items_code
        ON items(item_code);

        CREATE INDEX IF NOT EXISTS
        idx_local_items_status
        ON items(status);

        CREATE INDEX IF NOT EXISTS
        idx_local_items_name
        ON items(item_name);

        CREATE INDEX IF NOT EXISTS
        idx_local_items_deleted
        ON items(deleted_at);


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


        CREATE TABLE IF NOT EXISTS transactions (
            transaction_uuid TEXT PRIMARY KEY,
            transaction_id TEXT,
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
            device_id TEXT NOT NULL,
            sync_status TEXT NOT NULL DEFAULT 'PENDING',
            sync_error TEXT,
            created_at TEXT NOT NULL,
            synced_at TEXT
        );

        CREATE INDEX IF NOT EXISTS
        idx_local_transactions_sync
        ON transactions(sync_status, created_at);

        CREATE INDEX IF NOT EXISTS
        idx_local_transactions_item
        ON transactions(item_uuid, occurred_at);

        CREATE INDEX IF NOT EXISTS
        idx_local_transactions_user
        ON transactions(user_uuid, occurred_at);


        CREATE TABLE IF NOT EXISTS sync_queue (
            transaction_uuid TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TEXT NOT NULL,
            last_try_at TEXT,
            FOREIGN KEY(transaction_uuid)
                REFERENCES transactions(transaction_uuid)
                ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS
        idx_local_sync_queue_created
        ON sync_queue(created_at);


        CREATE TABLE IF NOT EXISTS sync_state (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT NOT NULL
        );
    `);


    normalizeLegacyNulls();


    if (
        !getSyncState(
            "master_cursor"
        )
    ) {

        setSyncState(
            "master_cursor",
            "0"
        );
    }


    return db;
}


/* =========================================================
   USERS
========================================================= */

function upsertUser(
    user
) {

    const uuid =
        String(
            user.UUID
            ??
            user.uuid
            ??
            ""
        ).trim();


    if (
        !uuid
    ) {

        return false;
    }


    const name =
        String(
            user.NAME
            ??
            user.name
            ??
            ""
        ).trim()
        ||
        "Unknown User";


    const cardUid =
        normalizeCardUid(
            user.CARD_UID
            ??
            user.card_uid
            ??
            null
        );


    const updatedAt =
        String(
            user.UPDATED_AT
            ??
            user.updated_at
            ??
            nowIso()
        );


    /*
     * PERMANENT FIX:
     *
     * "" -> NULL
     */

    const deletedAt =
        nullable(
            user.DELETED_AT
            ??
            user.deleted_at
            ??
            null
        );


    const activeSource =
        user.ACTIVE
        ??
        user.active
        ??
        user.STATUS
        ??
        1;


    db.prepare(`
        INSERT INTO users (
            uuid,
            employee_id,
            name,
            card_uid,
            department,
            role,
            active,
            updated_at,
            deleted_at
        )
        VALUES (
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?
        )

        ON CONFLICT(uuid)
        DO UPDATE SET
            employee_id = excluded.employee_id,
            name = excluded.name,
            card_uid = excluded.card_uid,
            department = excluded.department,
            role = excluded.role,
            active = excluded.active,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at
    `).run(
        uuid,

        nullable(
            user.EMPLOYEE_ID
            ??
            user.employee_id
            ??
            null
        ),

        name,

        cardUid,

        nullable(
            user.DEPARTMENT
            ??
            user.department
            ??
            null
        ),

        normalize(
            user.ROLE
            ??
            user.role
            ??
            "USER"
        )
        ||
        "USER",

        boolInt(
            activeSource,
            1
        ),

        updatedAt,

        deletedAt
    );


    return true;
}


/* =========================================================
   ITEMS
========================================================= */

function upsertItem(
    item
) {

    const uuid =
        String(
            item.UUID
            ??
            item.uuid
            ??
            ""
        ).trim();


    if (
        !uuid
    ) {

        return false;
    }


    const qrCode =
        String(
            item.QR_CODE
            ??
            item.qr_code
            ??
            uuid
        ).trim()
        ||
        uuid;


    const itemCode =
        nullable(
            item.ITEM_CODE
            ??
            item.item_code
            ??
            null
        );


    const itemNo =
        nullable(
            item.ITEM_NO
            ??
            item.item_no
            ??
            null
        );


    const deletedAt =
        nullable(
            item.DELETED_AT
            ??
            item.deleted_at
            ??
            null
        );


    db.prepare(`
        INSERT INTO items (
            uuid,
            qr_code,
            item_code,
            item_no,
            item_name,
            category,
            location,
            type,
            status,
            stock,
            borrowed_by_uuid,
            borrowed_by_name,
            borrowed_at,
            updated_at,
            deleted_at
        )
        VALUES (
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?
        )

        ON CONFLICT(uuid)
        DO UPDATE SET
            qr_code = excluded.qr_code,
            item_code = excluded.item_code,
            item_no = excluded.item_no,
            item_name = excluded.item_name,
            category = excluded.category,
            location = excluded.location,
            type = excluded.type,
            status = excluded.status,
            stock = excluded.stock,
            borrowed_by_uuid = excluded.borrowed_by_uuid,
            borrowed_by_name = excluded.borrowed_by_name,
            borrowed_at = excluded.borrowed_at,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at
    `).run(
        uuid,

        qrCode,

        itemCode,

        itemNo,

        String(
            item.ITEM_NAME
            ??
            item.item_name
            ??
            "Unnamed Item"
        ).trim(),

        nullable(
            item.CATEGORY
            ??
            item.category
            ??
            null
        ),

        nullable(
            item.LOCATION
            ??
            item.location
            ??
            null
        ),

        normalize(
            item.TYPE
            ??
            item.type
            ??
            "BORROWABLE"
        )
        ||
        "BORROWABLE",

        normalize(
            item.STATUS
            ??
            item.status
            ??
            "AVAILABLE"
        )
        ||
        "AVAILABLE",

        Math.max(
            0,
            asInt(
                item.STOCK
                ??
                item.stock,
                0
            )
        ),

        nullable(
            item.BORROWED_BY_UUID
            ??
            item.borrowed_by_uuid
            ??
            null
        ),

        nullable(
            item.BORROWED_BY_NAME
            ??
            item.borrowed_by_name
            ??
            null
        ),

        nullable(
            item.BORROWED_AT
            ??
            item.borrowed_at
            ??
            null
        ),

        String(
            item.UPDATED_AT
            ??
            item.updated_at
            ??
            nowIso()
        ),

        deletedAt
    );


    return true;
}


/* =========================================================
   SOFT DELETE
========================================================= */

function deleteUser(
    uuid,
    deletedAt = nowIso()
) {

    db.prepare(`
        UPDATE users
        SET
            active = 0,
            deleted_at = ?,
            updated_at = ?
        WHERE uuid = ?
    `).run(
        deletedAt,
        deletedAt,
        uuid
    );
}


function deleteItem(
    uuid,
    deletedAt = nowIso()
) {

    db.prepare(`
        UPDATE items
        SET
            deleted_at = ?,
            updated_at = ?
        WHERE uuid = ?
    `).run(
        deletedAt,
        deletedAt,
        uuid
    );
}


/* =========================================================
   SETTINGS
========================================================= */

function setSetting(
    key,
    value,
    updatedAt = nowIso()
) {

    db.prepare(`
        INSERT INTO settings (
            key,
            value,
            updated_at
        )
        VALUES (
            ?,
            ?,
            ?
        )

        ON CONFLICT(key)
        DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
    `).run(
        String(
            key
        ),

        value == null
            ?
            ""
            :
            String(
                value
            ),

        updatedAt
        ||
        nowIso()
    );
}


function setAdminConfig(
    key,
    value,
    updatedAt = nowIso()
) {

    db.prepare(`
        INSERT INTO admin_config (
            key,
            value,
            updated_at
        )
        VALUES (
            ?,
            ?,
            ?
        )

        ON CONFLICT(key)
        DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
    `).run(
        String(
            key
        ),

        value == null
            ?
            ""
            :
            String(
                value
            ),

        updatedAt
        ||
        nowIso()
    );
}


function getSettingsObject() {

    const output =
        {};


    const rows =
        db.prepare(`
            SELECT
                key,
                value
            FROM settings
            ORDER BY key
        `).all();


    for (
        const row
        of rows
    ) {

        output[
            row.key
        ] =
            row.value;
    }


    return output;
}


function getAdminObject() {

    const output =
        {};


    const rows =
        db.prepare(`
            SELECT
                key,
                value
            FROM admin_config
            ORDER BY key
        `).all();


    for (
        const row
        of rows
    ) {

        output[
            row.key
        ] =
            row.value;
    }


    return output;
}


/* =========================================================
   LOCAL LOOKUPS
========================================================= */

function getUserByCardUid(
    cardUid
) {

    const clean =
        normalize(
            cardUid
        )
            .replace(
                /[^0-9A-F]/g,
                ""
            );


    if (
        !clean
    ) {

        return null;
    }


    return (
        db.prepare(`
            SELECT *
            FROM users

            WHERE
                REPLACE(
                    REPLACE(
                        UPPER(card_uid),
                        ':',
                        ''
                    ),
                    ' ',
                    ''
                ) = ?

                AND active = 1

                AND ${activeRowSql()}

            LIMIT 1
        `).get(
            clean
        )

        ??

        null
    );
}


function getItemByUuid(
    uuid
) {

    return (
        db.prepare(`
            SELECT *
            FROM items

            WHERE
                uuid = ?

                AND ${activeRowSql()}

            LIMIT 1
        `).get(
            String(
                uuid
                ??
                ""
            ).trim()
        )

        ??

        null
    );
}


function getItemByQr(
    qr
) {

    const target =
        String(
            qr
            ??
            ""
        ).trim();


    return (
        db.prepare(`
            SELECT *
            FROM items

            WHERE
                ${activeRowSql()}

                AND (
                    UPPER(qr_code) = UPPER(?)
                    OR
                    UPPER(uuid) = UPPER(?)
                )

            LIMIT 1
        `).get(
            target,
            target
        )

        ??

        null
    );
}


function getItemByCode(
    code
) {

    return (
        db.prepare(`
            SELECT *
            FROM items

            WHERE
                ${activeRowSql()}

                AND UPPER(item_code) = UPPER(?)

            LIMIT 1
        `).get(
            String(
                code
                ??
                ""
            ).trim()
        )

        ??

        null
    );
}


/* =========================================================
   UPDATE ITEM AFTER TRANSACTION
========================================================= */

function updateLocalItemAfterAction({
    itemUuid,
    status,
    stock,
    borrowedByUuid,
    borrowedByName,
    borrowedAt,
    updatedAt = nowIso()
}) {

    db.prepare(`
        UPDATE items

        SET
            status = ?,

            stock =
                COALESCE(
                    ?,
                    stock
                ),

            borrowed_by_uuid = ?,
            borrowed_by_name = ?,
            borrowed_at = ?,
            updated_at = ?

        WHERE
            uuid = ?
    `).run(
        status,

        stock
        ??
        null,

        nullable(
            borrowedByUuid
        ),

        nullable(
            borrowedByName
        ),

        nullable(
            borrowedAt
        ),

        updatedAt,

        itemUuid
    );
}


/* =========================================================
   LOCAL TRANSACTIONS
========================================================= */

function insertLocalTransaction(
    transaction,
    payload
) {

    const createdAt =
        nowIso();


    db.prepare(`
        INSERT INTO transactions (
            transaction_uuid,
            transaction_id,
            item_uuid,
            item_code,
            item_name,
            user_uuid,
            user_name,
            card_uid,
            action,
            qty,
            status,
            occurred_at,
            device_id,
            sync_status,
            sync_error,
            created_at
        )
        VALUES (
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            'PENDING',
            NULL,
            ?
        )
    `).run(
        transaction.transaction_uuid,

        transaction.transactionId
        ??
        transaction.transaction_uuid,

        transaction.item_uuid,

        transaction.item_code
        ??
        null,

        transaction.item_name
        ??
        null,

        transaction.user_uuid,

        transaction.user_name
        ??
        null,

        transaction.card_uid
        ??
        null,

        transaction.action,

        transaction.qty
        ??
        1,

        transaction.status,

        transaction.occurred_at,

        transaction.device_id,

        createdAt
    );


    db.prepare(`
        INSERT OR REPLACE
        INTO sync_queue (
            transaction_uuid,
            payload_json,
            retry_count,
            last_error,
            created_at,
            last_try_at
        )
        VALUES (
            ?,
            ?,

            COALESCE(
                (
                    SELECT retry_count
                    FROM sync_queue
                    WHERE transaction_uuid = ?
                ),
                0
            ),

            NULL,
            ?,
            NULL
        )
    `).run(
        transaction.transaction_uuid,

        JSON.stringify(
            payload
        ),

        transaction.transaction_uuid,

        createdAt
    );
}


/* =========================================================
   SYNC TRANSACTION STATUS
========================================================= */

function markTransactionSynced(
    transactionUuid
) {

    const timestamp =
        nowIso();


    db.prepare(`
        UPDATE transactions

        SET
            sync_status = 'SYNCED',
            sync_error = NULL,
            synced_at = ?

        WHERE
            transaction_uuid = ?
    `).run(
        timestamp,
        transactionUuid
    );


    db.prepare(`
        DELETE FROM sync_queue
        WHERE transaction_uuid = ?
    `).run(
        transactionUuid
    );
}


function markTransactionRejected(
    transactionUuid,
    error
) {

    db.prepare(`
        UPDATE transactions

        SET
            sync_status = 'REJECTED',
            sync_error = ?

        WHERE
            transaction_uuid = ?
    `).run(
        String(
            error
            ??
            "REJECTED"
        ),

        transactionUuid
    );


    db.prepare(`
        DELETE FROM sync_queue
        WHERE transaction_uuid = ?
    `).run(
        transactionUuid
    );
}


function markTransactionRetry(
    transactionUuid,
    error
) {

    db.prepare(`
        UPDATE sync_queue

        SET
            retry_count = retry_count + 1,
            last_error = ?,
            last_try_at = ?

        WHERE
            transaction_uuid = ?
    `).run(
        String(
            error
            ??
            "SYNC_ERROR"
        ),

        nowIso(),

        transactionUuid
    );


    db.prepare(`
        UPDATE transactions

        SET
            sync_status = 'PENDING',
            sync_error = ?

        WHERE
            transaction_uuid = ?
    `).run(
        String(
            error
            ??
            "SYNC_ERROR"
        ),

        transactionUuid
    );
}


/* =========================================================
   PENDING QUEUE
========================================================= */

function getPendingTransactions(
    limit = 100
) {

    const safeLimit =
        Math.max(
            1,
            Math.min(
                500,
                asInt(
                    limit,
                    100
                )
            )
        );


    return db.prepare(`
        SELECT
            q.transaction_uuid,
            q.payload_json,
            q.retry_count,
            q.last_error,
            q.created_at

        FROM
            sync_queue q

        ORDER BY
            q.created_at ASC

        LIMIT ?
    `).all(
        safeLimit
    );
}


function getPendingCount() {

    return Number(
        db.prepare(`
            SELECT COUNT(*) AS c
            FROM sync_queue
        `).get().c
        ??
        0
    );
}


/* =========================================================
   SYNC STATE
========================================================= */

function setSyncState(
    key,
    value
) {

    db.prepare(`
        INSERT INTO sync_state (
            key,
            value,
            updated_at
        )
        VALUES (
            ?,
            ?,
            ?
        )

        ON CONFLICT(key)
        DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
    `).run(
        String(
            key
        ),

        String(
            value
        ),

        nowIso()
    );
}


function getSyncState(
    key
) {

    return (
        db.prepare(`
            SELECT value

            FROM sync_state

            WHERE
                key = ?

            LIMIT 1
        `).get(
            String(
                key
            )
        )
        ?.value

        ??

        null
    );
}


/* =========================================================
   DB ROW -> CABINET CACHE
========================================================= */

function localRowToUser(
    row
) {

    return {

        UUID:
            row.uuid,

        EMPLOYEE_ID:
            row.employee_id
            ??
            "",

        NAME:
            row.name,

        CARD_UID:
            row.card_uid
            ??
            "",

        DEPARTMENT:
            row.department
            ??
            "",

        ROLE:
            row.role,

        ACTIVE:
            row.active
                ?
                "TRUE"
                :
                "FALSE",

        UPDATED_AT:
            row.updated_at
            ??
            ""

    };
}


function localRowToItem(
    row
) {

    return {

        UUID:
            row.uuid,

        QR_CODE:
            row.qr_code
            ??
            row.uuid,

        ITEM_CODE:
            row.item_code
            ??
            "",

        ITEM_NAME:
            row.item_name,

        CATEGORY:
            row.category
            ??
            "",

        LOCATION:
            row.location
            ??
            "",

        TYPE:
            row.type,

        STATUS:
            row.status,

        STOCK:
            row.stock,

        UPDATED_AT:
            row.updated_at
            ??
            "",

        ITEM_NO:
            row.item_no
            ??
            "",

        BORROWED_BY_UUID:
            row.borrowed_by_uuid
            ??
            "",

        BORROWED_BY_NAME:
            row.borrowed_by_name
            ??
            "",

        BORROWED_AT:
            row.borrowed_at
            ??
            ""

    };
}


/* =========================================================
   ACTIVE COUNTS
========================================================= */

function getActiveCounts() {

    const users =
        Number(
            db.prepare(`
                SELECT COUNT(*) AS c

                FROM users

                WHERE
                    active = 1

                    AND ${activeRowSql()}
            `).get().c
            ??
            0
        );


    const items =
        Number(
            db.prepare(`
                SELECT COUNT(*) AS c

                FROM items

                WHERE
                    ${activeRowSql()}
            `).get().c
            ??
            0
        );


    return {
        users,
        items
    };
}


/* =========================================================
   EXPORT DEVICE.DB -> JSON CACHE
========================================================= */

function exportCaches() {

    /*
     * Safety repair setiap export.
     */

    normalizeLegacyNulls();


    const users =
        db.prepare(`
            SELECT *

            FROM users

            WHERE
                active = 1

                AND ${activeRowSql()}

            ORDER BY
                name COLLATE NOCASE
        `)
            .all()
            .map(
                localRowToUser
            );


    const items =
        db.prepare(`
            SELECT *

            FROM items

            WHERE
                ${activeRowSql()}

            ORDER BY
                item_name COLLATE NOCASE
        `)
            .all()
            .map(
                localRowToItem
            );


    const settings =
        getSettingsObject();


    const admin =
        getAdminObject();


    fs.writeFileSync(
        path.join(
            CACHE_DIR,
            "users.json"
        ),

        JSON.stringify(
            users,
            null,
            2
        )
    );


    fs.writeFileSync(
        path.join(
            CACHE_DIR,
            "items.json"
        ),

        JSON.stringify(
            items,
            null,
            2
        )
    );


    fs.writeFileSync(
        path.join(
            CACHE_DIR,
            "settings.json"
        ),

        JSON.stringify(
            settings,
            null,
            2
        )
    );


    fs.writeFileSync(
        path.join(
            CACHE_DIR,
            "admin.json"
        ),

        JSON.stringify(
            admin,
            null,
            2
        )
    );


    return {

        users:
            users.length,

        items:
            items.length,

        settings:
            Object.keys(
                settings
            ).length,

        admin:
            Object.keys(
                admin
            ).length

    };
}


/* =========================================================
   READ JSON CACHE
========================================================= */

function readJsonFile(
    file,
    fallback
) {

    try {

        if (
            !fs.existsSync(
                file
            )
        ) {

            return fallback;
        }


        return JSON.parse(
            fs.readFileSync(
                file,
                "utf8"
            )
        );

    }
    catch (error) {

        return fallback;
    }
}


/* =========================================================
   IMPORT OLD CACHE IF LOCAL DB EMPTY
========================================================= */

function importCachesIfEmpty() {

    normalizeLegacyNulls();


    const usersCount =
        Number(
            db.prepare(`
                SELECT COUNT(*) AS c
                FROM users
            `).get().c
            ??
            0
        );


    const itemsCount =
        Number(
            db.prepare(`
                SELECT COUNT(*) AS c
                FROM items
            `).get().c
            ??
            0
        );


    let importedUsers =
        0;


    let importedItems =
        0;


    if (
        usersCount === 0
    ) {

        const rows =
            readJsonFile(
                path.join(
                    CACHE_DIR,
                    "users.json"
                ),
                []
            );


        if (
            Array.isArray(
                rows
            )
        ) {

            for (
                const row
                of rows
            ) {

                if (
                    upsertUser(
                        row
                    )
                ) {

                    importedUsers++;
                }
            }
        }
    }


    if (
        itemsCount === 0
    ) {

        const rows =
            readJsonFile(
                path.join(
                    CACHE_DIR,
                    "items.json"
                ),
                []
            );


        if (
            Array.isArray(
                rows
            )
        ) {

            for (
                const row
                of rows
            ) {

                if (
                    upsertItem(
                        row
                    )
                ) {

                    importedItems++;
                }
            }
        }
    }


    const settings =
        readJsonFile(
            path.join(
                CACHE_DIR,
                "settings.json"
            ),
            {}
        );


    if (
        settings
        &&
        typeof settings ===
            "object"
        &&
        !Array.isArray(
            settings
        )
    ) {

        for (
            const [
                key,
                value
            ]
            of Object.entries(
                settings
            )
        ) {

            setSetting(
                key,
                value
            );
        }
    }


    const admin =
        readJsonFile(
            path.join(
                CACHE_DIR,
                "admin.json"
            ),
            {}
        );


    if (
        admin
        &&
        typeof admin ===
            "object"
        &&
        !Array.isArray(
            admin
        )
    ) {

        for (
            const [
                key,
                value
            ]
            of Object.entries(
                admin
            )
        ) {

            setAdminConfig(
                key,
                value
            );
        }
    }


    exportCaches();


    return {

        importedUsers,
        importedItems

    };
}


/* =========================================================
   CENTRAL CHANGE -> DEVICE.DB
========================================================= */

function applyMasterChange(
    change
) {

    const entity =
        normalize(
            change.entity_type
        );


    const operation =
        normalize(
            change.operation
        );


    const payload =
        change.payload
        ??
        {};


    /* USERS */

    if (
        entity ===
        "USERS"
    ) {

        if (
            operation ===
            "DELETE"
        ) {

            deleteUser(
                change.entity_key,
                change.created_at
                ||
                nowIso()
            );

        }
        else {

            upsertUser(
                payload
            );
        }


        return;
    }


    /* ITEMS */

    if (
        entity ===
        "ITEMS"
    ) {

        if (
            operation ===
            "DELETE"
        ) {

            deleteItem(
                change.entity_key,
                change.created_at
                ||
                nowIso()
            );

        }
        else {

            upsertItem(
                payload
            );
        }


        return;
    }


    /* SETTINGS */

    if (
        entity ===
        "SETTINGS"
    ) {

        if (
            operation ===
            "DELETE"
        ) {

            db.prepare(`
                DELETE FROM settings
                WHERE key = ?
            `).run(
                change.entity_key
            );

        }
        else {

            setSetting(
                payload.KEY
                ??
                payload.key
                ??
                change.entity_key,

                payload.VALUE
                ??
                payload.value
                ??
                "",

                payload.UPDATED_AT
                ??
                payload.updated_at
                ??
                change.created_at
                ??
                nowIso()
            );
        }


        return;
    }


    /* ADMIN */

    if (
        entity ===
        "ADMIN"
    ) {

        if (
            operation ===
            "DELETE"
        ) {

            db.prepare(`
                DELETE FROM admin_config
                WHERE key = ?
            `).run(
                change.entity_key
            );

        }
        else {

            setAdminConfig(
                payload.KEY
                ??
                payload.key
                ??
                change.entity_key,

                payload.VALUE
                ??
                payload.value
                ??
                "",

                payload.UPDATED_AT
                ??
                payload.updated_at
                ??
                change.created_at
                ??
                nowIso()
            );
        }
    }
}


/* =========================================================
   INITIALIZE
========================================================= */

initLocalDatabase();


/* =========================================================
   EXPORTS
========================================================= */

module.exports = {

    db,

    DB_FILE,

    initLocalDatabase,

    normalizeLegacyNulls,

    importCachesIfEmpty,

    exportCaches,

    upsertUser,

    upsertItem,

    getUserByCardUid,

    getItemByUuid,

    getItemByQr,

    getItemByCode,

    updateLocalItemAfterAction,

    insertLocalTransaction,

    markTransactionSynced,

    markTransactionRejected,

    markTransactionRetry,

    getPendingTransactions,

    getPendingCount,

    getSettingsObject,

    getAdminObject,

    setSetting,

    setAdminConfig,

    getSyncState,

    setSyncState,

    applyMasterChange,

    localRowToUser,

    localRowToItem,

    getActiveCounts,

    nullable,

    normalizeCardUid

};
