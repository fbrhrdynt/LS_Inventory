require("dotenv").config({
    path: "/opt/LS_Inventory/.env",
    quiet: true
});

const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");
const { spawn } = require("child_process");

const {
    createBorrow,
    createReturn,
    createConsume,
    syncPending
} = require("./services/transaction_service");

/*
 * Pada LS Inventory V2 nama file service tetap google_sync.js
 * untuk compatibility, tetapi isinya melakukan sync ke Central.
 */
const { sync: syncMasterData } = require("./services/google_sync");
const license = require("./services/license_service");

const ROOT = "/opt/LS_Inventory";
const PORT = Number(process.env.PORT || 3000);
const CAMERA_PORT = 3001;

const ITEMS_FILE = path.join(ROOT, "cache", "items.json");
const USERS_FILE = path.join(ROOT, "cache", "users.json");
const ADMIN_FILE = path.join(ROOT, "cache", "admin.json");
const SETTINGS_FILE = path.join(ROOT, "cache", "settings.json");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let currentUser = null;
let currentOperation = null;
let nfcProcess = null;
let qrProcess = null;
let isShuttingDown = false;
let masterSyncTimer = null;
let masterSyncPromise = null;
let unknownCardSyncRunning = false;

/* =========================================================
   EXPRESS
========================================================= */

app.set("view engine", "ejs");
app.set("views", path.join(ROOT, "views"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, "public")));

/* =========================================================
   GENERIC HELPERS
========================================================= */

function normalize(value) {
    return String(value || "").trim().toUpperCase();
}

function normalizeCardUid(value) {
    return String(value || "")
        .replace(/[^0-9a-fA-F]/g, "")
        .toUpperCase();
}

function loadObject(file) {
    try {
        if (!fs.existsSync(file)) return {};
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        return data && !Array.isArray(data) && typeof data === "object"
            ? data
            : {};
    } catch (error) {
        console.error(`Load ${path.basename(file)}:`, error.message);
        return {};
    }
}

function loadArray(file) {
    try {
        if (!fs.existsSync(file)) return [];
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error(`Load ${path.basename(file)}:`, error.message);
        return [];
    }
}

function loadItems() {
    return loadArray(ITEMS_FILE);
}

function loadUsers() {
    return loadArray(USERS_FILE);
}

function getSettings() {
    return loadObject(SETTINGS_FILE);
}

function getSystemConfig() {
    const admin = loadObject(ADMIN_FILE);
    return {
        systemName: String(
            admin.SYSTEM_NAME ||
            admin.SYSTEMA_NAME ||
            process.env.APP_NAME ||
            "LS Inventory"
        ).trim(),
        deviceName: String(
            admin.DEVICE_NAME ||
            process.env.DEVICE_NAME ||
            "LS Cabinet 01"
        ).trim(),
        version: String(admin.VERSION || "1.0.0").trim(),
        license: license.publicStatus(license.getCachedStatus())
    };
}

function isSettingEnabled(key, defaultValue = true) {
    const settings = getSettings();
    if (!(key in settings)) return defaultValue;
    return !["FALSE", "0", "NO", "OFF", "DISABLED"].includes(
        normalize(settings[key])
    );
}

function getMasterSyncIntervalSeconds() {
    const value = Number(getSettings().SYNC_INTERVAL);
    if (!Number.isFinite(value)) return 60;

    /*
     * Incremental Central sync ringan. Minimum 15 detik.
     * Saat user melakukan operasi, sync juga dilakukan on-demand.
     */
    return Math.max(15, Math.min(3600, Math.floor(value)));
}

function emitSystemConfig(target = io) {
    const config = getSystemConfig();
    target.emit("system-config", config);
    target.emit("license-status", config.license);
    return config;
}

async function refreshLicense(force = false) {
    try {
        const status = await license.verify({ force });
        const safe = license.publicStatus(status);
        io.emit("license-status", safe);
        console.log(`License: ${String(safe.plan).toUpperCase()} / ${safe.status}`);
        return safe;
    } catch (error) {
        console.error("License verification:", error.message);
        return license.publicStatus(license.getCachedStatus());
    }
}

function assertLicenseForOperation(operation) {
    const status = license.getCachedStatus();
    const error = license.operationError(operation, status);
    if (error) {
        const exception = new Error(error);
        exception.code = "LICENSE_OPERATION_BLOCKED";
        exception.license = status;
        throw exception;
    }
    return status;
}

/* =========================================================
   CENTRAL MASTER SYNC
========================================================= */

function scheduleMasterSync() {
    if (isShuttingDown) return;

    if (masterSyncTimer) {
        clearTimeout(masterSyncTimer);
        masterSyncTimer = null;
    }

    const seconds = getMasterSyncIntervalSeconds();
    console.log(`Next Central master sync: ${seconds} seconds`);

    masterSyncTimer = setTimeout(async () => {
        await syncCentralNow("scheduled");
        scheduleMasterSync();
    }, seconds * 1000);
}

async function reloadNfcReader() {
    if (!isSettingEnabled("NFC_ENABLED", true)) return;

    stopNFCReader();

    await new Promise(resolve => setTimeout(resolve, 500));

    if (!isShuttingDown) {
        startNFCReader();
    }
}

async function syncCentralNow(reason = "manual") {
    if (isShuttingDown) return null;

    /*
     * Semua caller berbagi satu sync promise agar tidak terjadi
     * beberapa sync bersamaan dari timer, NFC, QR, dan numpad.
     */
    if (masterSyncPromise) {
        return masterSyncPromise;
    }

    masterSyncPromise = (async () => {
        try {
            console.log(`Central master sync (${reason})...`);

            const result = await syncMasterData();

            emitSystemConfig();
            applyRuntimeSettings();

            const applied = Number(result?.applied || 0);

            if (applied > 0) {
                console.log(`Central changes applied: ${applied}`);

                /*
                 * nfc_reader.py dapat menyimpan users.json di memory.
                 * Reload reader hanya ketika master data berubah.
                 */
                await reloadNfcReader();
            }

            return result;

        } catch (error) {
            console.error("Central master sync failed:", error.message);
            return null;
        } finally {
            masterSyncPromise = null;
        }
    })();

    return masterSyncPromise;
}

/* =========================================================
   WEB
========================================================= */

app.get("/", (req, res) => {
    const config = getSystemConfig();
    res.render("index", {
        appName: config.systemName,
        deviceName: config.deviceName,
        version: config.version
    });
});

app.get("/health", (req, res) => {
    const config = getSystemConfig();
    res.json({
        status: "OK",
        application: config.systemName,
        device: config.deviceName,
        version: config.version,
        user: currentUser ? currentUser.NAME : null,
        operation: currentOperation,
        camera: qrProcess ? "running" : "stopped",
        license: license.publicStatus(license.getCachedStatus()),
        timestamp: new Date().toISOString()
    });
});

/* =========================================================
   CAMERA HTTP PROXY
========================================================= */

app.get("/camera/stream", (req, res) => {
    const request = http.request({
        hostname: "127.0.0.1",
        port: CAMERA_PORT,
        path: "/stream.mjpg",
        method: "GET"
    }, response => {
        if (response.statusCode !== 200) {
            if (!res.headersSent) {
                res.status(503).send("Camera unavailable");
            }
            response.destroy();
            return;
        }

        res.writeHead(200, {
            "Content-Type": response.headers["content-type"] ||
                "multipart/x-mixed-replace; boundary=frame",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Expires": "0"
        });

        response.pipe(res);
        req.on("close", () => response.destroy());
    });

    request.on("error", error => {
        console.error("Camera proxy:", error.message);
        if (!res.headersSent) {
            res.status(503).send("Camera not ready");
        }
    });

    request.end();
});

/* =========================================================
   USER LOOKUP
========================================================= */

function findUserByCardUid(cardUid) {
    const target = normalizeCardUid(cardUid);
    if (!target) return null;

    return loadUsers().find(user =>
        normalizeCardUid(user.CARD_UID) === target
    ) || null;
}

/* =========================================================
   ITEM LOOKUP
========================================================= */

/*
 * QR scanner hanya menerima QR_CODE / UUID.
 * ITEM_CODE hanya melalui manual 5-digit numpad.
 */
function findItemByQR(qrCode) {
    const target = normalize(qrCode);
    if (!target) return null;

    return loadItems().find(item =>
        normalize(item.QR_CODE) === target ||
        normalize(item.UUID) === target
    ) || null;
}

/*
 * Format baru:
 *   48372 -> ITEM_48372
 *
 * Legacy 4 digit:
 *   ITEM_1526 -> masukkan 01526
 *   ITEM_0962 -> masukkan 00962
 */
function findItemByCodeDigits(digits) {
    const clean = String(digits || "").replace(/\D/g, "");
    if (clean.length !== 5) return null;

    const target = `ITEM_${clean}`;
    const legacyTarget = clean.startsWith("0")
        ? `ITEM_${clean.substring(1)}`
        : null;

    return loadItems().find(item => {
        const code = normalize(item.ITEM_CODE);
        return code === normalize(target) ||
            (legacyTarget && code === normalize(legacyTarget));
    }) || null;
}

function isConsumable(item) {
    return ["CONSUMABLE", "CONSUME"].includes(normalize(item?.TYPE));
}

function isBorrowable(item) {
    return ["BORROWABLE", "BORROW"].includes(normalize(item?.TYPE));
}

function validateItemForOperation(item, operation) {
    if (!item) return "Item tidak ditemukan.";

    const status = normalize(item.STATUS);

    if (operation === "borrow") {
        if (isConsumable(item)) return "Item ini adalah Consumable.";
        if (!isBorrowable(item)) return "Item bukan tipe BORROWABLE.";
        if (status !== "AVAILABLE") {
            return `Item tidak dapat dipinjam. Status: ${item.STATUS || "UNKNOWN"}`;
        }
    }

    if (operation === "return") {
        if (isConsumable(item)) return "Consumable tidak menggunakan Return.";
        if (!isBorrowable(item)) return "Item bukan tipe BORROWABLE.";
        if (status !== "BORROWED") {
            return `Item tidak dapat dikembalikan. Status: ${item.STATUS || "UNKNOWN"}`;
        }
    }

    if (operation === "consume") {
        if (!isConsumable(item)) return "Item bukan Consumable.";

        const stock = Number(item.STOCK);
        if (!Number.isInteger(stock) || stock < 0) {
            return "STOCK item tidak valid.";
        }
        if (stock === 0) return "Stock item habis.";
    }

    return null;
}

function getItemFromBrowser(item) {
    const uuid = item?.UUID;
    if (!uuid) return null;

    return loadItems().find(current =>
        normalize(current.UUID) === normalize(uuid)
    ) || null;
}

/* =========================================================
   NFC
========================================================= */

async function handleUnknownCard(uid) {
    if (unknownCardSyncRunning) return;

    unknownCardSyncRunning = true;

    try {
        console.log("Unknown card detected:", uid);
        console.log("Refreshing users from Central...");

        await syncCentralNow("unknown-nfc-card");

        const user = findUserByCardUid(uid);

        if (!user) {
            console.log("Card still not registered after sync:", uid);
            return;
        }

        console.log("New user found from Central:", user.NAME || user.UUID);

        currentUser = user;
        currentOperation = null;
        io.emit("nfc-user", user);

    } catch (error) {
        console.error("Unknown NFC card refresh:", error.message);
    } finally {
        unknownCardSyncRunning = false;
    }
}

function startNFCReader() {
    if (
        isShuttingDown ||
        nfcProcess ||
        !isSettingEnabled("NFC_ENABLED", true)
    ) {
        return;
    }

    console.log("Starting NFC Reader...");

    nfcProcess = spawn("python3", [
        path.join(ROOT, "scripts", "nfc_reader.py")
    ], {
        cwd: ROOT
    });

    const active = nfcProcess;
    let buffer = "";

    active.stdout.on("data", data => {
        const text = data.toString();
        process.stdout.write(`[NFC] ${text}`);

        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
            if (line.startsWith("UNKNOWN_CARD:")) {
                const uid = line.substring("UNKNOWN_CARD:".length).trim();
                handleUnknownCard(uid);
                continue;
            }

            if (!line.startsWith("USER_JSON:")) continue;

            try {
                const user = JSON.parse(
                    line.substring("USER_JSON:".length)
                );

                currentUser = user;
                currentOperation = null;
                io.emit("nfc-user", user);

            } catch (error) {
                console.error("NFC parse:", error.message);
            }
        }
    });

    active.stderr.on("data", data => {
        console.error("[NFC ERROR]", data.toString());
    });

    active.on("close", () => {
        if (nfcProcess === active) {
            nfcProcess = null;
        }

        if (
            !isShuttingDown &&
            isSettingEnabled("NFC_ENABLED", true)
        ) {
            setTimeout(startNFCReader, 3000);
        }
    });
}

function stopNFCReader() {
    if (!nfcProcess) return;

    const processToStop = nfcProcess;
    nfcProcess = null;

    try {
        processToStop.kill("SIGTERM");
    } catch (_) {
        // ignore
    }
}

/* =========================================================
   QR CAMERA
========================================================= */

function stopQRScanner() {
    if (!qrProcess) return;

    const processToStop = qrProcess;
    qrProcess = null;

    try {
        processToStop.kill("SIGTERM");
    } catch (_) {
        // ignore
    }
}

function startQRScanner() {
    if (!currentOperation) return;

    if (!isSettingEnabled("CAMERA_ENABLED", true)) {
        io.emit("system-error", {
            message: "Camera dinonaktifkan."
        });
        return;
    }

    if (qrProcess) return;

    console.log("Starting QR Camera...");

    qrProcess = spawn("python3", [
        path.join(ROOT, "scripts", "qr_camera_service.py")
    ], {
        cwd: ROOT
    });

    const active = qrProcess;
    let buffer = "";

    active.stdout.on("data", async data => {
        const text = data.toString();
        process.stdout.write(`[QR] ${text}`);

        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
            if (line.startsWith("CAMERA_STREAM_READY:")) {
                io.emit("camera-ready", {
                    operation: currentOperation
                });
                continue;
            }

            if (!line.startsWith("QR_DETECTED:")) continue;

            const qrCode = line.substring("QR_DETECTED:".length).trim();
            console.log("QR detected:", qrCode);

            let item = findItemByQR(qrCode);

            /*
             * Jika QR baru belum ada di local cache,
             * pull incremental changes dari Central lalu retry.
             */
            if (!item) {
                console.log("QR not found locally. Syncing Central...");
                await syncCentralNow("qr-miss");
                item = findItemByQR(qrCode);
            }

            if (!item) {
                io.emit("qr-error", {
                    message: "QR tidak ditemukan setelah sinkronisasi Central."
                });
                continue;
            }

            const validation = validateItemForOperation(
                item,
                currentOperation
            );

            if (validation) {
                io.emit("qr-error", { message: validation });
                continue;
            }

            io.emit("qr-item", {
                operation: currentOperation,
                source: "QR",
                item
            });

            setTimeout(stopQRScanner, 300);
        }
    });

    active.stderr.on("data", data => {
        console.error("[QR ERROR]", data.toString());
    });

    active.on("close", () => {
        if (qrProcess === active) {
            qrProcess = null;
        }
    });
}

/* =========================================================
   RUNTIME SETTINGS
========================================================= */

function applyRuntimeSettings() {
    if (isSettingEnabled("NFC_ENABLED", true)) {
        startNFCReader();
    } else {
        stopNFCReader();
    }

    if (!isSettingEnabled("CAMERA_ENABLED", true)) {
        stopQRScanner();
    }
}

/* =========================================================
   SOCKET.IO
========================================================= */

io.on("connection", socket => {
    console.log("Display connected:", socket.id);

    emitSystemConfig(socket);

    if (currentUser) {
        socket.emit("nfc-user", currentUser);
    }

    /* MENU */
    socket.on("select-menu", async menu => {
        if (!currentUser) {
            socket.emit("system-error", {
                message: "User belum login."
            });
            return;
        }

        if (!["borrow", "return", "consume"].includes(menu)) {
            return;
        }

        try {
            assertLicenseForOperation(menu);
        } catch (error) {
            socket.emit("system-error", {
                message: error.message,
                code: error.code || "LICENSE_OPERATION_BLOCKED",
                license: license.publicStatus(error.license || license.getCachedStatus())
            });
            return;
        }

        /*
         * Pastikan data terbaru dari Web Admin sudah masuk
         * sebelum cabinet mulai scan.
         */
        await syncCentralNow(`menu-${menu}`);

        currentOperation = menu;

        io.emit("operation-scan-start", {
            operation: menu
        });

        startQRScanner();
    });

    /* MANUAL CODE OPEN */
    socket.on("manual-code-open", () => {
        if (!currentUser || !currentOperation) {
            socket.emit("manual-code-error", {
                message: "Operation tidak aktif."
            });
            return;
        }

        stopQRScanner();

        socket.emit("manual-code-ready", {
            operation: currentOperation
        });
    });

    /* MANUAL CODE CANCEL */
    socket.on("manual-code-cancel", () => {
        if (currentUser && currentOperation) {
            startQRScanner();
        }
    });

    /* MANUAL ITEM CODE - 5 DIGIT */
    socket.on("manual-item-code", async payload => {
        if (!currentUser || !currentOperation) {
            socket.emit("manual-code-error", {
                message: "Operation tidak aktif."
            });
            return;
        }

        const digits = String(payload?.digits || "")
            .replace(/\D/g, "");

        if (digits.length !== 5) {
            socket.emit("manual-code-error", {
                message: "Masukkan 5 digit Item Code."
            });
            return;
        }

        let item = findItemByCodeDigits(digits);

        if (!item) {
            console.log(`ITEM_${digits} not found locally. Syncing Central...`);
            await syncCentralNow("manual-code-miss");
            item = findItemByCodeDigits(digits);
        }

        if (!item) {
            socket.emit("manual-code-error", {
                message: `ITEM_${digits} tidak ditemukan setelah sinkronisasi Central.`
            });
            return;
        }

        const validation = validateItemForOperation(
            item,
            currentOperation
        );

        if (validation) {
            socket.emit("manual-code-error", {
                message: validation
            });
            return;
        }

        console.log("Manual code found:", item.ITEM_CODE);

        socket.emit("qr-item", {
            operation: currentOperation,
            source: "CODE",
            item
        });
    });

    /* CANCEL */
    socket.on("cancel-scan", () => {
        stopQRScanner();
        currentOperation = null;
    });

    /* BORROW */
    socket.on("confirm-borrow", async itemData => {
        try {
            assertLicenseForOperation("borrow");

            if (!currentUser || currentOperation !== "borrow") {
                throw new Error("Borrow tidak aktif.");
            }

            let item = getItemFromBrowser(itemData);

            if (!item) {
                await syncCentralNow("confirm-borrow");
                item = getItemFromBrowser(itemData);
            }

            if (!item) throw new Error("Item tidak ditemukan.");

            const validation = validateItemForOperation(item, "borrow");
            if (validation) throw new Error(validation);

            const result = await createBorrow(currentUser, item);
            currentOperation = null;

            socket.emit("operation-success", {
                operation: "borrow",
                ...result
            });

        } catch (error) {
            socket.emit("system-error", {
                message: error.message
            });
        }
    });

    /* RETURN */
    socket.on("confirm-return", async itemData => {
        try {
            assertLicenseForOperation("return");

            if (!currentUser || currentOperation !== "return") {
                throw new Error("Return tidak aktif.");
            }

            let item = getItemFromBrowser(itemData);

            if (!item) {
                await syncCentralNow("confirm-return");
                item = getItemFromBrowser(itemData);
            }

            if (!item) throw new Error("Item tidak ditemukan.");

            const validation = validateItemForOperation(item, "return");
            if (validation) throw new Error(validation);

            const result = await createReturn(currentUser, item);
            currentOperation = null;

            socket.emit("operation-success", {
                operation: "return",
                ...result
            });

        } catch (error) {
            socket.emit("system-error", {
                message: error.message
            });
        }
    });

    /* CONSUMABLE */
    socket.on("confirm-consume", async payload => {
        try {
            assertLicenseForOperation("consume");

            if (!currentUser || currentOperation !== "consume") {
                throw new Error("Consumable tidak aktif.");
            }

            let item = getItemFromBrowser(payload?.item);

            if (!item) {
                await syncCentralNow("confirm-consume");
                item = getItemFromBrowser(payload?.item);
            }

            if (!item) throw new Error("Item tidak ditemukan.");

            const validation = validateItemForOperation(item, "consume");
            if (validation) throw new Error(validation);

            const result = await createConsume(
                currentUser,
                item,
                Number(payload?.qty)
            );

            currentOperation = null;

            socket.emit("operation-success", {
                operation: "consume",
                ...result
            });

        } catch (error) {
            socket.emit("system-error", {
                message: error.message
            });
        }
    });

    /* LOGOUT */
    socket.on("logout-user", () => {
        stopQRScanner();
        currentUser = null;
        currentOperation = null;
        io.emit("user-logout");
    });
});

/* =========================================================
   START
========================================================= */

server.listen(PORT, "0.0.0.0", () => {
    console.log(`LS Inventory Cabinet started on port ${PORT}.`);

    applyRuntimeSettings();

    /* License is local to this physical Raspberry Pi. */
    setTimeout(async () => {
        await refreshLicense(false);
    }, 250);

    /* Initial incremental sync */
    setTimeout(async () => {
        await syncCentralNow("startup");
        scheduleMasterSync();
    }, 1000);

    /* Revalidate Lifetime periodically; local Trial keeps its original timer. */
    setInterval(async () => {
        if (isShuttingDown) return;
        await refreshLicense(true);
    }, 6 * 60 * 60 * 1000).unref();

    /* Pending transaction push */
    setInterval(async () => {
        if (isShuttingDown) return;

        try {
            const result = await syncPending();

            if (Number(result?.total || 0) > 0) {
                console.log("Pending Sync:", result);
            }
        } catch (error) {
            console.error("Pending Sync:", error.message);
        }
    }, 60000);
});

/* =========================================================
   SHUTDOWN
========================================================= */

function shutdown() {
    if (isShuttingDown) return;

    isShuttingDown = true;

    stopQRScanner();
    stopNFCReader();

    if (masterSyncTimer) {
        clearTimeout(masterSyncTimer);
        masterSyncTimer = null;
    }

    server.close(() => process.exit(0));

    setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
