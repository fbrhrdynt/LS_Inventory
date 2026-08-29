"use strict";

require("dotenv").config({
    path: "/opt/LS_Inventory/.env",
    quiet: true
});

const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const license = require("./license_service");

const BASE_URL = String(process.env.CENTRAL_API_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
const DEVICE_ID = String(process.env.DEVICE_ID || process.env.DEVICE_NAME || "LS_Cab_Main").trim();
const DEVICE_API_KEY = String(process.env.DEVICE_API_KEY || "").trim();

function headers() {
    return {
        "Content-Type": "application/json",
        "x-device-id": DEVICE_ID,
        "x-device-key": DEVICE_API_KEY
    };
}

async function request(path, options = {}) {
    if (!DEVICE_API_KEY) throw new Error("DEVICE_API_KEY belum tersedia di .env");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 7000));

    try {
        const response = await fetch(`${BASE_URL}${path}`, {
            method: options.method || "GET",
            headers: { ...headers(), ...(options.headers || {}) },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data.error || `HTTP_${response.status}`);
            error.status = response.status;
            error.data = data;
            throw error;
        }
        return data;
    } catch (error) {
        if (error.name === "AbortError") throw new Error("CENTRAL_TIMEOUT");
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function getLocalIp() {
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const entry of addresses || []) {
            if (entry.family === "IPv4" && !entry.internal) return entry.address;
        }
    }
    return null;
}

function getTailscaleIp() {
    try {
        return execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", timeout: 1500 }).trim().split(/\s+/)[0] || null;
    } catch (_) {
        return null;
    }
}

function getCpuTemperature() {
    try {
        const raw = Number(fs.readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8").trim());
        return Number.isFinite(raw) ? Math.round((raw / 1000) * 10) / 10 : null;
    } catch (_) {
        return null;
    }
}

function getDiskUsage() {
    try {
        const stat = fs.statfsSync("/opt/LS_Inventory");
        const total = Number(stat.blocks) * Number(stat.bsize);
        const free = Number(stat.bavail) * Number(stat.bsize);
        if (!total) return null;
        return Math.round(((total - free) / total) * 1000) / 10;
    } catch (_) {
        return null;
    }
}

async function pullChanges(after, limit = 500) {
    return request(`/api/v1/device/changes?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`);
}

async function getSnapshot(entity, page = 1, limit = 500) {
    return request(`/api/v1/device/snapshot/${encodeURIComponent(entity)}?page=${encodeURIComponent(page)}&limit=${encodeURIComponent(limit)}`);
}

async function pushTransactions(transactions) {
    return request("/api/v1/device/transactions", { method: "POST", body: { transactions }, timeoutMs: 12000 });
}


async function processLicenseProvisioning() {
    const pending = await request("/api/v1/device/license/provision", {
        method: "GET",
        timeoutMs: 7000
    });

    const command = pending?.command;
    if (!command) return null;

    let status = null;

    try {
        if (String(command.action || "").toUpperCase() === "ACTIVATE") {
            const key = String(command.license_key || "").trim();
            if (!key) throw new Error("LICENSE_KEY_NOT_DELIVERED");
            const result = await license.activate(key);
            status = result.status;
        } else if (String(command.action || "").toUpperCase() === "VERIFY") {
            status = await license.verify({ force: true });
        } else {
            throw new Error("UNKNOWN_LICENSE_COMMAND");
        }

        await request(`/api/v1/device/license/provision/${encodeURIComponent(command.id)}/ack`, {
            method: "POST",
            body: {
                success: true,
                license: license.publicStatus(status)
            },
            timeoutMs: 7000
        });

        return {
            success: true,
            command_id: command.id,
            action: command.action,
            license: license.publicStatus(status)
        };

    } catch (error) {
        try {
            await request(`/api/v1/device/license/provision/${encodeURIComponent(command.id)}/ack`, {
                method: "POST",
                body: {
                    success: false,
                    error: error.message,
                    license: license.publicStatus(status || license.getCachedStatus())
                },
                timeoutMs: 7000
            });
        } catch (_) {}

        throw error;
    }
}

async function sendHeartbeat(extra = {}) {
    /*
     * Remote license commands are intentionally processed before heartbeat.
     * This lets Web Admin on Raspberry Pi 1 provision a Lifetime license to
     * Raspberry Pi 2/3/... without exposing the key in the device list.
     */
    try {
        await processLicenseProvisioning();
    } catch (error) {
        console.error("License provisioning:", error.message);
    }

    return request("/api/v1/device/heartbeat", {
        method: "POST",
        body: {
            app_version: process.env.APP_VERSION || "1.0.0",
            local_ip: getLocalIp(),
            tailscale_ip: getTailscaleIp(),
            cpu_temperature: getCpuTemperature(),
            disk_usage: getDiskUsage(),
            uptime_seconds: Math.floor(os.uptime()),
            ...license.heartbeatPayload(),
            ...extra
        }
    });
}

module.exports = {
    BASE_URL,
    DEVICE_ID,
    request,
    pullChanges,
    getSnapshot,
    pushTransactions,
    sendHeartbeat,
    processLicenseProvisioning,
    getLocalIp,
    getTailscaleIp,
    getCpuTemperature,
    getDiskUsage
};
