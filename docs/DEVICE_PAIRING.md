# Device Pairing from Web Admin

## Purpose

This feature lets the primary Raspberry Pi register new LS Inventory cabinet devices from Web Admin without manually creating or copying API keys.

The primary Pi remains:

```text
Central Server + HMI Lab Cabinet
```

Additional Raspberry Pis are cabinet clients only.

## Web Admin flow

Open:

```text
http://<PRIMARY_PI>:3100/ls-admin/
```

Then:

```text
Devices & Maintenance
→ + Add Device
```

Example:

```text
Device ID   LS_Cab_Workshop01
Device Name Workshop Cabinet 01
Site        Cikarang
Location    Workshop
Description Tools inventory cabinet
Status      ACTIVE
```

Click **Create Device**.

Central generates a 6-digit pairing code:

```text
583921
```

Properties:

- single-use
- valid for 15 minutes by default
- stored only as a SHA-256 hash in `central.db`
- old pairing codes for the same device are invalidated when a new one is created
- successful pairing rotates the device API key

## New Raspberry Pi

Clone/install the same LS Inventory repository, connect it to the same Tailscale network, then run:

```bash
cd /opt/LS_Inventory
node scripts/pair_device.js
```

Example:

```text
Central Server [http://ls-inventory:3100]:
Enter 6-digit Pairing Code: 583921
```

After success, the script writes:

```text
/opt/LS_Inventory/.env
```

with:

```env
DEVICE_ID=LS_Cab_Workshop01
DEVICE_NAME="Workshop Cabinet 01"
DEVICE_API_KEY=<generated-secret>
CENTRAL_API_URL=http://ls-inventory:3100
```

The API key plaintext is returned only once to that Raspberry Pi and is not shown in Web Admin.

Then the script automatically runs:

```bash
node services/google_sync.js
```

for the initial Central synchronization.

## Start the cabinet

On a client cabinet:

```bash
cd /opt/LS_Inventory

pm2 start app.js \
  --name LS_Inventory \
  --cwd /opt/LS_Inventory

pm2 save
```

Do not run:

```text
LS_Inventory_Central
```

on the client cabinet.

## Re-pair

Use **Re-pair** when:

- SD card is replaced
- Raspberry Pi is reinstalled
- the device credential needs to be rotated

Web Admin:

```text
Devices
→ Re-pair
→ Generate code
```

Then run again on that Raspberry Pi:

```bash
node scripts/pair_device.js
```

The old device API key becomes invalid only when the new pairing code is successfully consumed.

## Disable

Disabling a device immediately prevents its existing API key from authenticating.

Use this for:

- maintenance
- lost Raspberry Pi
- suspected credential exposure
- temporarily retired cabinets

## Delete

Delete is a soft-delete.

Transaction history is preserved, while the device disappears from the active Web Admin device list and can no longer authenticate.

## Security

The pairing endpoint:

```text
POST /api/v1/device/pair
```

uses:

- a single-use 6-digit code
- 15-minute expiry by default
- hash-only code storage
- source-address rate limiting
- API key rotation after successful pairing

For production use, keep Central private through Tailscale or another trusted private network.
