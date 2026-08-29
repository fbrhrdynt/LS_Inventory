"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const ROOT = "/opt/LS_Inventory";
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "license.json");
const ENV_FILE = path.join(ROOT, ".env");

const DEFAULT_API_BASE = "https://logisourcedigital.web.id/api/public/license";
const DEFAULT_PRODUCT_SLUG = "ls-inventory-hmilab";
const DEFAULT_TRIAL_DAYS = 14;
const DEFAULT_VERIFY_INTERVAL_HOURS = 6;
const DEFAULT_OFFLINE_GRACE_DAYS = 30;

fs.mkdirSync(DATA_DIR, { recursive: true });

function nowIso() {
    return new Date().toISOString();
}

function asNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function stripQuotes(value) {
    const text = String(value ?? "").trim();
    if (
        (text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith("'") && text.endsWith("'"))
    ) {
        return text.slice(1, -1);
    }
    return text;
}

function readEnvFile() {
    try {
        if (!fs.existsSync(ENV_FILE)) return {};
        const output = {};
        const text = fs.readFileSync(ENV_FILE, "utf8");
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith("#")) continue;
            const index = line.indexOf("=");
            if (index <= 0) continue;
            const key = line.slice(0, index).trim();
            const value = stripQuotes(line.slice(index + 1));
            output[key] = value;
        }
        return output;
    } catch (_) {
        return {};
    }
}

function writeEnvValue(key, value) {
    const safeKey = String(key).trim();
    const safeValue = String(value ?? "");
    let lines = [];

    if (fs.existsSync(ENV_FILE)) {
        lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
    }

    const replacement = `${safeKey}=${JSON.stringify(safeValue)}`;
    let found = false;

    lines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        const index = line.indexOf("=");
        if (index <= 0) return line;
        if (line.slice(0, index).trim() !== safeKey) return line;
        if (found) return null;
        found = true;
        return replacement;
    }).filter(line => line !== null);

    if (!found) {
        if (lines.length && lines[lines.length - 1] !== "") lines.push("");
        lines.push(replacement);
    }

    fs.writeFileSync(ENV_FILE, `${lines.join("\n").replace(/\n+$/, "")}\n`, {
        mode: 0o600
    });

    try { fs.chmodSync(ENV_FILE, 0o600); } catch (_) {}
}

function config() {
    const fileEnv = readEnvFile();
    return {
        apiBase: String(
            fileEnv.LOGI_LICENSE_API_BASE ||
            process.env.LOGI_LICENSE_API_BASE ||
            DEFAULT_API_BASE
        ).replace(/\/$/, ""),
        productSlug: String(
            fileEnv.LOGI_LICENSE_PRODUCT_SLUG ||
            process.env.LOGI_LICENSE_PRODUCT_SLUG ||
            DEFAULT_PRODUCT_SLUG
        ).trim(),
        licenseKey: String(
            fileEnv.LOGI_LICENSE_KEY ||
            process.env.LOGI_LICENSE_KEY ||
            ""
        ).trim(),
        trialDays: Math.max(1, Math.floor(asNumber(
            fileEnv.LOGI_TRIAL_DAYS || process.env.LOGI_TRIAL_DAYS,
            DEFAULT_TRIAL_DAYS
        ))),
        verifyIntervalHours: Math.max(1, asNumber(
            fileEnv.LOGI_LICENSE_VERIFY_INTERVAL_HOURS || process.env.LOGI_LICENSE_VERIFY_INTERVAL_HOURS,
            DEFAULT_VERIFY_INTERVAL_HOURS
        )),
        offlineGraceDays: Math.max(1, asNumber(
            fileEnv.LOGI_LICENSE_OFFLINE_GRACE_DAYS || process.env.LOGI_LICENSE_OFFLINE_GRACE_DAYS,
            DEFAULT_OFFLINE_GRACE_DAYS
        ))
    };
}

function readHardwareSerial() {
    const candidates = [
        "/sys/firmware/devicetree/base/serial-number",
        "/proc/device-tree/serial-number"
    ];

    for (const file of candidates) {
        try {
            const value = fs.readFileSync(file).toString("utf8").replace(/\0/g, "").trim();
            if (value) return `serial:${value}`;
        } catch (_) {}
    }

    try {
        const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
        const match = cpuinfo.match(/^Serial\s*:\s*(.+)$/im);
        if (match?.[1]?.trim()) return `serial:${match[1].trim()}`;
    } catch (_) {}

    try {
        const machineId = fs.readFileSync("/etc/machine-id", "utf8").trim();
        if (machineId) return `machine:${machineId}`;
    } catch (_) {}

    return `hostname:${os.hostname()}`;
}

function getFingerprint() {
    const raw = `LS-INVENTORY|${readHardwareSerial()}`;
    const digest = crypto.createHash("sha256").update(raw).digest("hex");
    return `lsinv-${digest}`;
}

function maskLicenseKey(value) {
    const key = String(value || "").trim();
    if (!key) return "";
    if (key.length <= 8) return "********";
    return `${key.slice(0, 5)}-****-****-${key.slice(-4)}`;
}

function defaultState() {
    const started = nowIso();
    return {
        version: 1,
        trial_started_at: started,
        last_plan: "trial",
        last_status: "TRIAL_ACTIVE",
        last_remote_valid: false,
        last_verified_at: null,
        last_successful_verify_at: null,
        last_error: null,
        last_remote_payload: null
    };
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            const state = defaultState();
            saveState(state);
            return state;
        }
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        const state = {
            ...defaultState(),
            ...(parsed && typeof parsed === "object" ? parsed : {})
        };
        if (!state.trial_started_at) state.trial_started_at = nowIso();
        return state;
    } catch (_) {
        const state = defaultState();
        saveState(state);
        return state;
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
    try { fs.chmodSync(STATE_FILE, 0o600); } catch (_) {}
}

function trialStatus(state = loadState(), overrides = {}) {
    const cfg = config();
    const startedAt = new Date(state.trial_started_at || nowIso());
    const startMs = Number.isNaN(startedAt.getTime()) ? Date.now() : startedAt.getTime();
    const expiresMs = startMs + cfg.trialDays * 86400000;
    const remainingMs = expiresMs - Date.now();
    const active = remainingMs > 0;
    const daysRemaining = active ? Math.max(1, Math.ceil(remainingMs / 86400000)) : 0;

    return {
        plan: "trial",
        status: active ? "TRIAL_ACTIVE" : "TRIAL_EXPIRED",
        valid: active,
        lifetime: false,
        trial_active: active,
        trial_days: cfg.trialDays,
        trial_started_at: new Date(startMs).toISOString(),
        trial_expires_at: new Date(expiresMs).toISOString(),
        days_remaining: daysRemaining,
        product_slug: cfg.productSlug,
        fingerprint: getFingerprint(),
        hostname: os.hostname(),
        license_key_configured: Boolean(cfg.licenseKey),
        license_key_masked: maskLicenseKey(cfg.licenseKey),
        last_verified_at: state.last_verified_at || null,
        last_successful_verify_at: state.last_successful_verify_at || null,
        offline: false,
        error: state.last_error || null,
        write_enabled: active,
        borrow_enabled: active,
        return_enabled: true,
        consume_enabled: active,
        sync_enabled: true,
        ...overrides
    };
}

function lifetimeStatus(state = loadState(), overrides = {}) {
    const cfg = config();
    return {
        plan: "lifetime",
        status: "LIFETIME",
        valid: true,
        lifetime: true,
        trial_active: false,
        trial_days: cfg.trialDays,
        trial_started_at: state.trial_started_at || null,
        trial_expires_at: null,
        days_remaining: null,
        product_slug: cfg.productSlug,
        fingerprint: getFingerprint(),
        hostname: os.hostname(),
        license_key_configured: Boolean(cfg.licenseKey),
        license_key_masked: maskLicenseKey(cfg.licenseKey),
        last_verified_at: state.last_verified_at || null,
        last_successful_verify_at: state.last_successful_verify_at || null,
        offline: false,
        error: null,
        write_enabled: true,
        borrow_enabled: true,
        return_enabled: true,
        consume_enabled: true,
        sync_enabled: true,
        ...overrides
    };
}

function getCachedStatus() {
    const state = loadState();
    const cfg = config();

    if (
        cfg.licenseKey &&
        state.last_remote_valid === true &&
        String(state.last_plan || "").toLowerCase() === "lifetime"
    ) {
        return lifetimeStatus(state, {
            status: state.last_status || "LIFETIME",
            offline: Boolean(state.last_offline)
        });
    }

    return trialStatus(state);
}

function remotePlan(payload) {
    const candidates = [
        payload?.plan,
        payload?.license?.plan,
        payload?.data?.plan,
        payload?.data?.license?.plan,
        payload?.subscription?.plan
    ];
    const value = candidates.find(v => v !== undefined && v !== null && String(v).trim());
    return String(value || "").trim().toLowerCase();
}

function remoteValid(payload) {
    const candidates = [
        payload?.valid,
        payload?.license?.valid,
        payload?.data?.valid,
        payload?.data?.license?.valid,
        payload?.active,
        payload?.license?.active
    ];

    for (const value of candidates) {
        if (typeof value === "boolean") return value;
        if (value === 1 || value === "1") return true;
        if (value === 0 || value === "0") return false;
    }

    const status = String(
        payload?.status ||
        payload?.license?.status ||
        payload?.data?.status ||
        ""
    ).trim().toLowerCase();

    if (["active", "valid", "activated", "lifetime"].includes(status)) return true;
    if (["inactive", "invalid", "revoked", "expired"].includes(status)) return false;

    return false;
}

async function postJson(url, body, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data.error || data.message || `LICENSE_HTTP_${response.status}`);
            error.status = response.status;
            error.data = data;
            error.remoteResponse = true;
            throw error;
        }
        return data;
    } catch (error) {
        if (error.name === "AbortError") {
            const timeoutError = new Error("LICENSE_TIMEOUT");
            timeoutError.networkError = true;
            throw timeoutError;
        }
        if (!error.remoteResponse) error.networkError = true;
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function withinMs(iso, milliseconds) {
    if (!iso) return false;
    const time = new Date(iso).getTime();
    return Number.isFinite(time) && (Date.now() - time) <= milliseconds;
}

async function verify(options = {}) {
    const cfg = config();
    const state = loadState();
    const force = Boolean(options.force);

    if (!cfg.licenseKey) {
        state.last_plan = "trial";
        state.last_status = trialStatus(state).status;
        state.last_remote_valid = false;
        state.last_error = null;
        state.last_offline = false;
        saveState(state);
        return trialStatus(state);
    }

    const verifyIntervalMs = cfg.verifyIntervalHours * 3600000;
    if (
        !force &&
        state.last_remote_valid === true &&
        String(state.last_plan).toLowerCase() === "lifetime" &&
        withinMs(state.last_successful_verify_at, verifyIntervalMs)
    ) {
        return lifetimeStatus(state);
    }

    const checkedAt = nowIso();
    state.last_verified_at = checkedAt;

    try {
        const payload = await postJson(`${cfg.apiBase}/verify`, {
            license_key: cfg.licenseKey,
            fingerprint: getFingerprint(),
            product_slug: cfg.productSlug
        });

        const plan = remotePlan(payload);
        const valid = remoteValid(payload);

        state.last_remote_payload = payload;
        state.last_error = null;
        state.last_offline = false;

        if (valid && plan === "lifetime") {
            state.last_plan = "lifetime";
            state.last_status = "LIFETIME";
            state.last_remote_valid = true;
            state.last_successful_verify_at = checkedAt;
            saveState(state);
            return lifetimeStatus(state, { remote: payload });
        }

        /*
         * Website may explicitly return plan=trial. The local trial timer is
         * still the enforcement source so a reinstall on another Pi gets its
         * own hardware-bound trial while the plan remains one of only two
         * values: trial or lifetime.
         */
        state.last_plan = "trial";
        state.last_status = trialStatus(state).status;
        state.last_remote_valid = false;
        state.last_error = valid ? "LICENSE_NOT_LIFETIME" : "LICENSE_INVALID_OR_INACTIVE";
        saveState(state);
        return trialStatus(state, { remote: payload });

    } catch (error) {
        state.last_error = error.message;

        /* Explicit response from LogiSource means revoke/invalid immediately. */
        if (error.remoteResponse) {
            state.last_plan = "trial";
            state.last_remote_valid = false;
            state.last_status = trialStatus(state).status;
            state.last_offline = false;
            saveState(state);
            return trialStatus(state, { error: error.message });
        }

        /* Network outage: keep a previously verified lifetime license for grace. */
        const graceMs = cfg.offlineGraceDays * 86400000;
        if (
            state.last_remote_valid === true &&
            String(state.last_plan).toLowerCase() === "lifetime" &&
            withinMs(state.last_successful_verify_at, graceMs)
        ) {
            state.last_status = "LIFETIME_OFFLINE_GRACE";
            state.last_offline = true;
            saveState(state);
            return lifetimeStatus(state, {
                status: "LIFETIME_OFFLINE_GRACE",
                offline: true,
                error: error.message
            });
        }

        state.last_plan = "trial";
        state.last_remote_valid = false;
        state.last_status = trialStatus(state).status;
        state.last_offline = true;
        saveState(state);
        return trialStatus(state, {
            offline: true,
            error: error.message
        });
    }
}

async function activate(licenseKey) {
    const key = String(licenseKey || "").trim();
    if (!key) throw new Error("LICENSE_KEY_REQUIRED");

    const cfg = config();
    const state = loadState();

    const payload = await postJson(`${cfg.apiBase}/activate`, {
        license_key: key,
        fingerprint: getFingerprint(),
        product_slug: cfg.productSlug,
        hostname: os.hostname()
    }, 10000);

    /* A successful 2xx activation may use different response shapes. */
    const plan = remotePlan(payload);
    const valid = remoteValid(payload);

    writeEnvValue("LOGI_LICENSE_KEY", key);
    writeEnvValue("LOGI_LICENSE_API_BASE", cfg.apiBase);
    writeEnvValue("LOGI_LICENSE_PRODUCT_SLUG", cfg.productSlug);

    if (valid && plan === "lifetime") {
        const ts = nowIso();
        state.last_plan = "lifetime";
        state.last_status = "LIFETIME";
        state.last_remote_valid = true;
        state.last_verified_at = ts;
        state.last_successful_verify_at = ts;
        state.last_remote_payload = payload;
        state.last_error = null;
        state.last_offline = false;
        saveState(state);
    }

    const status = await verify({ force: true });
    return { status, activation: payload };
}

function canAdminWrite(status = getCachedStatus()) {
    return status.plan === "lifetime" || status.status === "TRIAL_ACTIVE";
}

function canCabinetOperation(operation, status = getCachedStatus()) {
    const op = String(operation || "").trim().toLowerCase();
    if (op === "return") return true;
    if (op === "borrow") return Boolean(status.borrow_enabled);
    if (op === "consume") return Boolean(status.consume_enabled);
    return true;
}

function operationError(operation, status = getCachedStatus()) {
    if (canCabinetOperation(operation, status)) return null;
    return status.status === "TRIAL_EXPIRED"
        ? "Trial license telah berakhir. Borrow dan Consumable dinonaktifkan. Return dan sinkronisasi tetap tersedia."
        : "License tidak mengizinkan operasi ini.";
}

function heartbeatPayload() {
    const status = getCachedStatus();
    return {
        license_plan: status.plan,
        license_status: status.status,
        license_fingerprint: status.fingerprint,
        license_last_verified_at: status.last_verified_at,
        license_trial_expires_at: status.trial_expires_at,
        license_trial_started_at: status.trial_started_at,
        license_days_remaining: status.days_remaining,
        license_product_slug: status.product_slug,
        license_hostname: status.hostname,
        license_key_masked: status.license_key_masked,
        license_offline: status.offline ? 1 : 0,
        license_last_error: status.error || null
    };
}

function publicStatus(status = getCachedStatus()) {
    const {
        remote,
        ...safe
    } = status;
    return safe;
}

module.exports = {
    ROOT,
    STATE_FILE,
    ENV_FILE,
    config,
    getFingerprint,
    maskLicenseKey,
    loadState,
    getCachedStatus,
    verify,
    activate,
    canAdminWrite,
    canCabinetOperation,
    operationError,
    heartbeatPayload,
    publicStatus,
    writeEnvValue
};
