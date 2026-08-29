#!/usr/bin/env node
"use strict";

const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const license = require("../services/license_service");

function line(label, value) {
    console.log(`${String(label).padEnd(20)}: ${value ?? "-"}`);
}

function printStatus(status) {
    console.log("");
    console.log("========================================");
    console.log("       LS Inventory License Status");
    console.log("========================================");
    line("Plan", String(status.plan || "trial").toUpperCase());
    line("Status", status.status);
    line("Product", status.product_slug);
    line("Fingerprint", status.fingerprint);
    line("Hostname", status.hostname);
    line("License Key", status.license_key_masked || "Not configured");

    if (status.plan === "trial") {
        line("Trial Started", status.trial_started_at);
        line("Trial Expires", status.trial_expires_at);
        line("Days Remaining", status.days_remaining);
    }

    line("Last Verified", status.last_verified_at || "Never");
    line("Offline", status.offline ? "YES" : "NO");
    line("Borrow", status.borrow_enabled ? "ENABLED" : "DISABLED");
    line("Return", status.return_enabled ? "ENABLED" : "DISABLED");
    line("Consume", status.consume_enabled ? "ENABLED" : "DISABLED");
    line("Admin Write", status.write_enabled ? "ENABLED" : "READ ONLY");
    if (status.error) line("Last Error", status.error);
    console.log("========================================");
    console.log("");
}

async function promptLicenseKey() {
    const rl = readline.createInterface({ input, output });
    try {
        const key = await rl.question("Paste Lifetime License Key: ");
        return String(key || "").trim();
    } finally {
        rl.close();
    }
}

async function main() {
    const command = String(process.argv[2] || "status").trim().toLowerCase();

    if (["fingerprint", "id"].includes(command)) {
        console.log(license.getFingerprint());
        return;
    }

    if (command === "status") {
        printStatus(license.publicStatus(license.getCachedStatus()));
        return;
    }

    if (command === "verify") {
        console.log("Verifying license with LogiSource Digital...");
        const status = await license.verify({ force: true });
        printStatus(license.publicStatus(status));
        process.exitCode = status.valid || status.status === "TRIAL_ACTIVE" ? 0 : 2;
        return;
    }

    if (command === "activate") {
        const key = String(process.argv[3] || "").trim() || await promptLicenseKey();
        if (!key) throw new Error("LICENSE_KEY_REQUIRED");

        console.log("Activating this Raspberry Pi...");
        const result = await license.activate(key);
        printStatus(license.publicStatus(result.status));

        if (result.status.plan !== "lifetime") {
            throw new Error("Activation completed but Lifetime verification was not confirmed.");
        }

        console.log("Lifetime license activated successfully.");
        console.log("Restart LS Inventory services so all processes use the latest configuration:");
        console.log("  pm2 restart LS_Inventory --update-env");
        console.log("  pm2 restart LS_Inventory_Central --update-env");
        return;
    }

    console.log("Usage:");
    console.log("  node scripts/license_cli.js status");
    console.log("  node scripts/license_cli.js fingerprint");
    console.log("  node scripts/license_cli.js verify");
    console.log("  node scripts/license_cli.js activate");
    process.exitCode = 1;
}

main().catch(error => {
    console.error(`License error: ${error.message}`);
    process.exit(1);
});
