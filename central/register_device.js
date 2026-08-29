"use strict";

const crypto = require("crypto");
const { createOrRotateDevice } = require("./db");

const deviceId = String(process.argv[2] || "").trim();
const name = String(process.argv[3] || deviceId).trim();
const location = String(process.argv[4] || "").trim();

if (!deviceId) {
    console.error('Usage: node central/register_device.js DEVICE_ID "Device Name" "Location"');
    process.exit(1);
}

const key = crypto.randomBytes(32).toString("hex");
createOrRotateDevice(deviceId, name, location, key);

console.log("\nDevice registered / key rotated.");
console.log(`DEVICE_ID=${deviceId}`);
console.log(`DEVICE_API_KEY=${key}`);
console.log("\nSave these values on the target Raspberry Pi .env.\n");
