# Install / Recover the Primary Raspberry Pi

This document describes Raspberry Pi 1, which currently has two roles:

- LS Inventory Central
- HMI Lab Cabinet

## Services

```text
LS_Inventory           port 3000
LS_Inventory_Central   port 3100
```

## Required software

```bash
sudo apt update
sudo apt install -y \
    git \
    curl \
    python3 \
    python3-spidev \
    python3-opencv \
    chromium \
    xinit
```

Node.js 22 and PM2 are required.

Check:

```bash
node -v
npm -v
pm2 -v
```

## Repository

```bash
sudo mkdir -p /opt/LS_Inventory
sudo chown -R "$USER":"$USER" /opt/LS_Inventory

git clone https://github.com/fbrhrdynt/LS_Inventory.git /opt/LS_Inventory
cd /opt/LS_Inventory

npm install
```

## Environment

Do not copy secrets to GitHub.

Create:

```text
/opt/LS_Inventory/.env
```

Primary Pi needs Cabinet configuration and Central configuration.

Example structure:

```env
APP_NAME="LS Inventory"
PORT=3000

DEVICE_ID=LS_Cab_LabHMI
DEVICE_NAME="LS Cabinet Lab HMI"
DEVICE_API_KEY=<PRIMARY_CABINET_DEVICE_KEY>

CENTRAL_API_URL=http://127.0.0.1:3100
CENTRAL_PORT=3100
```

Use the exact variable names implemented by the current codebase if they differ.

## Start Central

```bash
cd /opt/LS_Inventory

pm2 start central/server.js \
    --name LS_Inventory_Central \
    --cwd /opt/LS_Inventory
```

## Start Cabinet

```bash
cd /opt/LS_Inventory

pm2 start app.js \
    --name LS_Inventory \
    --cwd /opt/LS_Inventory
```

Save:

```bash
pm2 save
```

## Health checks

Central:

```bash
curl http://127.0.0.1:3100/health
```

Cabinet:

```bash
curl http://127.0.0.1:3000/health
```

## Web Admin

```text
http://127.0.0.1:3100/ls-admin/
```

## Database backup

Before upgrades:

```bash
mkdir -p /opt/LS_Inventory/backups

cp /opt/LS_Inventory/central/data/central.db \
   /opt/LS_Inventory/backups/central-$(date +%Y%m%d-%H%M%S).db

cp /opt/LS_Inventory/data/device.db \
   /opt/LS_Inventory/backups/device-$(date +%Y%m%d-%H%M%S).db
```

Do not commit database files to GitHub.
