<p align="center">
  <img src="assets/LogiSource_Digital_Logo_HD.png"
       alt="LogiSource Digital"
       width="420">
</p>

# LS Inventory

Multi-cabinet Raspberry Pi inventory system with NFC,
QR scanning, local SQLite/offline operation,
Central Web Admin, device pairing, Tailscale connectivity,
and per-device Trial/Lifetime licensing.

## Documentation

- [Panduan Instalasi - Bahasa Indonesia](docs/pdf/LS_Inventory_Installation_Guide_ID.pdf)
- [Installation Guide - English](docs/pdf/LS_Inventory_Installation_Guide_EN.pdf)

## Current topology

- **Raspberry Pi 1 (Primary + HMI Lab Cabinet)**
  - LS Inventory Cabinet UI on port `3000`
  - RC522 NFC reader
  - CSI QR camera
  - TFT kiosk UI
  - Local SQLite `device.db`
  - LS Inventory Central service on port `3100`
  - Central SQLite `central.db`
  - Web Admin at `/ls-admin/`
  - Tailscale

- **Raspberry Pi 2, 3, ... (Cabinet Clients)**
  - LS Inventory Cabinet UI on port `3000`
  - RC522 NFC reader
  - CSI QR camera
  - TFT kiosk UI
  - Local SQLite `device.db`
  - Tailscale
  - Sync to Raspberry Pi 1 Central service

## Data model

`central.db` is the single central master for administrative data and system-wide transactions.

Each cabinet has its own `device.db` so the cabinet can keep operating when the central node or network is temporarily unavailable.

Typical flow:

```text
Web Admin
   |
   v
central.db (Primary Pi)
   ^
   |
Central API
   ^
   |
Tailscale / LAN
   |
+--+------------------+
|                     |
Pi 1 Cabinet       Pi 2 Cabinet
device.db           device.db
|                   |
RC522/Camera        RC522/Camera
```

## Important directories

Primary Pi:

```text
/opt/LS_Inventory/
├── app.js
├── views/
├── public/
├── scripts/
├── services/
├── data/
│   └── device.db
├── central/
│   ├── server.js
│   ├── data/
│   │   └── central.db
│   └── public/
│       └── ls-admin/
└── cache/
```

Cabinet Client Pi:

```text
/opt/LS_Inventory/
├── app.js
├── views/
├── public/
├── scripts/
├── services/
├── data/
│   └── device.db
└── cache/
```

A client cabinet does **not** run `central/server.js`.

## Manual Item Code

Current manual item code format is 5 digits:

```text
ITEM_00000 ... ITEM_99999
```

The QR content is the item UUID.

## Services

Primary Pi:

```text
PM2:
- LS_Inventory           -> Cabinet UI :3000
- LS_Inventory_Central   -> Central API + Web Admin :3100
```

Cabinet Client Pi:

```text
PM2:
- LS_Inventory           -> Cabinet UI :3000
```

## Web Admin

Local on the primary Pi:

```text
http://127.0.0.1:3100/ls-admin/
```

From another machine on the same LAN:

```text
http://<PRIMARY_PI_LAN_IP>:3100/ls-admin/
```

For remote/private access, use Tailscale.

## Deployment

See:

- `docs/ARCHITECTURE.md`
- `docs/INSTALL_PRIMARY_PI.md`
- `docs/INSTALL_CABINET_PI.md`
- `docs/GITHUB_WORKFLOW.md`

## GitHub

Recommended repository:

```text
fbrhrdynt/LS_Inventory
```

Never commit:

```text
.env
*.db
*.db-wal
*.db-shm
google-token.json
oauth-client.json
API keys
passwords
```
