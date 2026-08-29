# Per-Device Licensing

## Plans

LS Inventory has two plans:

```text
TRIAL
LIFETIME
```

A Raspberry Pi without a configured Lifetime license automatically uses its local Trial.

## One Raspberry Pi = one license activation

Example:

```text
Raspberry Pi 1 / HMI Lab
Fingerprint A
Lifetime License #1

Raspberry Pi 2 / Workshop
Fingerprint B
Trial initially
Lifetime License #2 when activated
```

Do not copy `.env` or `data/license.json` between Raspberry Pi devices.

## Web Admin location

License management is inside:

```text
Devices & Maintenance
  -> Device Card
  -> License Details
```

The old standalone License menu is intentionally removed.

## Roles

Only **Administrator** can access Devices & Maintenance and submit license keys.

`Admin Staff` remains limited to:

```text
Dashboard
Inventory
Users
Transactions
```

## Raspberry Pi 1

Raspberry Pi 1 is both:

```text
Central Server
+
HMI Lab Cabinet
```

Its License Details page activates the local license immediately through:

```text
https://logisourcedigital.web.id/api/public/license/activate
```

## Raspberry Pi 2 and later

Remote cabinets are activated from the same Web Admin.

The Administrator submits the key on Raspberry Pi 1. Central creates an encrypted provisioning command for the selected `DEVICE_ID`.

On the target Raspberry Pi, `services/central_api.js` checks for a pending license command before sending heartbeat. The target Pi then:

1. receives the command using its own authenticated Device API key;
2. activates the license using its own hardware fingerprint;
3. saves `LOGI_LICENSE_KEY` only in that Raspberry Pi's local `.env`;
4. verifies the license;
5. acknowledges the command;
6. sends updated license status in heartbeat.

The Central command clears the encrypted license payload after acknowledgement.

## Offline device

If a remote cabinet is offline when the Administrator submits a license, the command remains queued for up to 7 days.

When the device reconnects and performs sync/heartbeat, activation is applied automatically.

## Device License Details

The modal shows:

```text
Plan
Status
Product
Hostname
Fingerprint
Masked License Key
Last Verified
Trial Started
Trial Expires
Days Remaining
Provisioning Command Status
Borrow access
Return access
Consumable access
Central Sync access
```

For Raspberry Pi 1 it additionally shows Web Admin write access.

## Security

Central uses `DEVICE_LICENSE_PROVISIONING_SECRET` to encrypt pending remote license payloads using AES-256-GCM.

The installer generates this secret automatically on Raspberry Pi 1 if it does not exist.

Never commit these files/values to GitHub:

```text
.env
DEVICE_LICENSE_PROVISIONING_SECRET
LOGI_LICENSE_KEY
data/license.json
data/device.db
central/data/central.db
```
