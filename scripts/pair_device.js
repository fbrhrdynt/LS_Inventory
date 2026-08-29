"use strict";

require("dotenv").config({
    path: "/opt/LS_Inventory/.env",
    quiet: true
});

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const license = require("../services/license_service");

const ROOT = "/opt/LS_Inventory";
const ENV_FILE = path.join(ROOT, ".env");

function normalizeBaseUrl(value) {
    let url = String(value || "").trim();
    if (!url) return "";

    if (!/^https?:\/\//i.test(url)) {
        url = `http://${url}`;
    }

    return url.replace(/\/+$/, "");
}

function getLocalIp() {
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const entry of addresses || []) {
            if (entry.family === "IPv4" && !entry.internal) {
                return entry.address;
            }
        }
    }

    return null;
}

function getTailscaleIp() {
    try {
        return execFileSync(
            "tailscale",
            ["ip", "-4"],
            {
                encoding: "utf8",
                timeout: 2000
            }
        ).trim().split(/\s+/)[0] || null;
    } catch (_) {
        return null;
    }
}

function readPackageVersion() {
    try {
        const pkg = JSON.parse(
            fs.readFileSync(
                path.join(ROOT, "package.json"),
                "utf8"
            )
        );

        return String(
            process.env.APP_VERSION
            || pkg.version
            || "1.0.0"
        );
    } catch (_) {
        return String(process.env.APP_VERSION || "1.0.0");
    }
}

function quoteEnv(value) {
    const text = String(value ?? "");
    if (/^[A-Za-z0-9_./:@-]+$/.test(text)) {
        return text;
    }

    return `"${text
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")}"`;
}

function setEnvValues(filepath, values) {
    let lines = [];

    if (fs.existsSync(filepath)) {
        lines = fs.readFileSync(filepath, "utf8").split(/\r?\n/);
    }

    const wanted = new Map(
        Object.entries(values).map(
            ([key, value]) => [key, String(value ?? "")]
        )
    );

    const written = new Set();

    lines = lines.map(line => {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);

        if (!match) return line;

        const key = match[1];

        if (!wanted.has(key)) {
            return line;
        }

        written.add(key);

        return `${key}=${quoteEnv(wanted.get(key))}`;
    });

    for (const [key, value] of wanted.entries()) {
        if (!written.has(key)) {
            if (lines.length && lines[lines.length - 1] !== "") {
                lines.push("");
            }

            lines.push(`${key}=${quoteEnv(value)}`);
        }
    }

    while (lines.length > 1 && lines[lines.length - 1] === "") {
        lines.pop();
    }

    lines.push("");

    fs.writeFileSync(filepath, lines.join("\n"), {
        mode: 0o600
    });

    fs.chmodSync(filepath, 0o600);
}

async function pairDevice(baseUrl, pairingCode) {
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(),
        10000
    );

    try {
        const response = await fetch(
            `${baseUrl}/api/v1/device/pair`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    pairing_code: pairingCode,
                    hostname: os.hostname(),
                    app_version: readPackageVersion(),
                    local_ip: getLocalIp(),
                    tailscale_ip: getTailscaleIp()
                }),
                signal: controller.signal
            }
        );

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            const error = new Error(
                data.error
                || `HTTP_${response.status}`
            );

            error.status = response.status;
            error.data = data;

            throw error;
        }

        return data;
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error("CENTRAL_TIMEOUT");
        }

        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function runInitialSync() {
    const result = spawnSync(
        process.execPath,
        [path.join(ROOT, "services", "google_sync.js")],
        {
            cwd: ROOT,
            stdio: "inherit",
            env: {
                ...process.env
            }
        }
    );

    return Number(result.status ?? 1);
}

async function main() {
    const rl = readline.createInterface({
        input,
        output
    });

    try {
        console.log("");
        console.log("======================================");
        console.log("     LS Inventory Device Pairing");
        console.log("======================================");
        console.log("");

        const defaultUrl = normalizeBaseUrl(
            process.env.CENTRAL_API_URL
            || "http://ls-inventory:3100"
        );

        const centralInput = await rl.question(
            `Central Server [${defaultUrl}]: `
        );

        const centralUrl = normalizeBaseUrl(
            centralInput.trim()
            || defaultUrl
        );

        if (!centralUrl) {
            throw new Error("CENTRAL_API_URL_REQUIRED");
        }

        const codeInput = await rl.question(
            "Enter 6-digit Pairing Code: "
        );

        const pairingCode = String(codeInput || "")
            .replace(/\D/g, "");

        if (pairingCode.length !== 6) {
            throw new Error("PAIRING_CODE_MUST_BE_6_DIGITS");
        }

        console.log("");
        console.log("Pairing with Central...");

        const result = await pairDevice(
            centralUrl,
            pairingCode
        );

        const device = result.device || {};
        const credentials = result.credentials || {};
        const apiKey = String(
            credentials.device_api_key
            || ""
        ).trim();

        if (!device.device_id || !apiKey) {
            throw new Error("PAIRING_RESPONSE_INCOMPLETE");
        }

        setEnvValues(
            ENV_FILE,
            {
                APP_NAME:
                    process.env.APP_NAME
                    || "LS Inventory",

                PORT:
                    process.env.PORT
                    || "3000",

                DEVICE_ID:
                    device.device_id,

                DEVICE_NAME:
                    device.device_name
                    || device.device_id,

                DEVICE_API_KEY:
                    apiKey,

                CENTRAL_API_URL:
                    centralUrl
            }
        );

        /*
         * Update current process only for the status message.
         * google_sync.js is executed as a fresh Node process and will
         * therefore read the new .env file normally.
         */
        process.env.DEVICE_ID = device.device_id;
        process.env.DEVICE_NAME = device.device_name || device.device_id;
        process.env.DEVICE_API_KEY = apiKey;
        process.env.CENTRAL_API_URL = centralUrl;

        console.log("");
        console.log("PAIRING SUCCESS");
        console.log("--------------------------------------");
        console.log("Device ID   :", device.device_id);
        console.log("Device Name :", device.device_name || "-");
        console.log("Location    :", device.location || "-");
        console.log("Site        :", device.site || "-");
        console.log("Central     :", centralUrl);
        console.log("Config      :", ENV_FILE);
        console.log("--------------------------------------");
        console.log("");
        console.log("Starting initial Central synchronization...");
        console.log("");

        const syncStatus = runInitialSync();

        console.log("");

        if (syncStatus === 0) {
            console.log("INITIAL SYNC COMPLETE");
        } else {
            console.log(
                "Pairing is complete, but initial sync did not finish successfully."
            );
            console.log(
                "After checking network access, run:"
            );
            console.log(
                "node services/google_sync.js"
            );
        }

        const licenseStatus = license.publicStatus(
            license.getCachedStatus()
        );

        console.log("");
        console.log("License:");
        console.log("Plan        :", String(licenseStatus.plan || "trial").toUpperCase());
        console.log("Status      :", licenseStatus.status);
        console.log("Fingerprint :", licenseStatus.fingerprint);

        if (licenseStatus.plan === "trial") {
            console.log("Trial Ends  :", licenseStatus.trial_expires_at);
            console.log("Days Left   :", licenseStatus.days_remaining);
            console.log("");
            console.log("No Lifetime key is configured, so this Raspberry Pi starts in Trial automatically.");
            console.log("To activate Lifetime later:");
            console.log("node scripts/license_cli.js activate");
        }

        console.log("");
        console.log("Next:");
        console.log("pm2 restart LS_Inventory --update-env");
        console.log("pm2 save");
        console.log("");
    } finally {
        rl.close();
    }
}

main().catch(error => {
    console.error("");
    console.error("PAIRING FAILED:", error.message);

    if (error.message === "PAIRING_CODE_INVALID_OR_EXPIRED") {
        console.error(
            "Generate a new pairing code from Web Admin > Devices."
        );
    }

    if (error.message === "PAIRING_RATE_LIMITED") {
        const retry = error.data?.retry_after_seconds;
        if (retry) {
            console.error(`Try again in about ${retry} seconds.`);
        }
    }

    if (error.message === "CENTRAL_TIMEOUT") {
        console.error(
            "Check Tailscale/LAN and make sure Central port 3100 is reachable."
        );
    }

    process.exit(1);
});
