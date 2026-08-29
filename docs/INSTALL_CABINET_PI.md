# Add a New LS Inventory Cabinet Raspberry Pi

This is the procedure for Raspberry Pi 2, 3, 4, etc.

A new cabinet is a **client**, not a Central server.

## What is installed on a new cabinet

Install:

```text
app.js
views/
public/
scripts/
services/
package.json
package-lock.json
```

The cabinet creates/uses:

```text
data/device.db
cache/
```

Do not run:

```text
central/server.js
```

Do not copy:

```text
central/data/central.db
data/device.db from another cabinet
.env from another cabinet
DEVICE_API_KEY from another cabinet
```

Every cabinet has its own device identity.

---

# 1. Hardware

Use the same hardware layout as the primary cabinet.

RC522:

```text
RC522        Raspberry Pi
3.3V    ->   Pin 1
GND     ->   Pin 6
SCK     ->   GPIO21 / Pin 40
MOSI    ->   GPIO20 / Pin 38
MISO    ->   GPIO19 / Pin 35
SDA/SS  ->   GPIO16 / Pin 36
RST     ->   3.3V
IRQ     ->   not used
```

Camera:

```text
CSI camera connector
```

TFT:

```text
SPI0
```

---

# 2. Raspberry Pi packages

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

Install Node.js 22 and PM2 if not already installed.

Verify:

```bash
node -v
npm -v
pm2 -v
```

---

# 3. Tailscale

Install Tailscale and join the same tailnet as Raspberry Pi 1.

Verify:

```bash
tailscale status
```

From the new Pi, confirm the primary Pi is reachable.

Example:

```bash
ping <PRIMARY_PI_TAILSCALE_IP>
```

or:

```bash
curl http://<PRIMARY_PI_TAILSCALE_IP>:3100/health
```

---

# 4. Register the new cabinet on Raspberry Pi 1

Run this on **Raspberry Pi 1**:

```bash
cd /opt/LS_Inventory

node central/register_device.js \
    LS_Cab_Workshop01 \
    "LS Cabinet Workshop 01" \
    "Workshop"
```

Example result:

```text
DEVICE_ID=LS_Cab_Workshop01
DEVICE_API_KEY=xxxxxxxxxxxxxxxx
```

Save the API key securely.

Do not send the API key to chat or commit it to GitHub.

---

# 5. Clone LS Inventory on the new cabinet

On Raspberry Pi 2:

```bash
sudo mkdir -p /opt/LS_Inventory
sudo chown -R "$USER":"$USER" /opt/LS_Inventory

git clone https://github.com/fbrhrdynt/LS_Inventory.git \
    /opt/LS_Inventory

cd /opt/LS_Inventory

npm install
```

---

# 6. Configure the new cabinet

Create:

```bash
nano /opt/LS_Inventory/.env
```

Example:

```env
APP_NAME="LS Inventory"
PORT=3000

DEVICE_ID=LS_Cab_Workshop01
DEVICE_NAME="LS Cabinet Workshop 01"
DEVICE_API_KEY=<KEY_FROM_PRIMARY_PI>

CENTRAL_API_URL=http://<PRIMARY_PI_TAILSCALE_IP>:3100
```

Use a Tailscale address or internal Tailscale DNS name.

Do not use:

```text
127.0.0.1:3100
```

on Pi 2. That address would point to Pi 2 itself.

---

# 7. TFT and SPI

Edit:

```bash
sudo nano /boot/firmware/config.txt
```

Required lines for the current hardware design:

```text
dtparam=spi=on
dtoverlay=tft35a:rotate=0
dtoverlay=spi1-1cs,cs0_pin=16
```

The `tft35a` overlay must exist.

If the new Pi does not have it, copy the currently working overlay from Pi 1:

On Pi 1:

```bash
ls -l /boot/firmware/overlays/tft35a.dtbo
```

From Pi 2:

```bash
scp <PI1_USER>@<PI1_TAILSCALE_IP>:/boot/firmware/overlays/tft35a.dtbo \
    /tmp/tft35a.dtbo

sudo cp /tmp/tft35a.dtbo \
    /boot/firmware/overlays/tft35a.dtbo
```

Reboot after changing boot configuration:

```bash
sudo reboot
```

---

# 8. Verify RC522

After reboot:

```bash
ls -l /dev/spidev1.0
```

Expected:

```text
/dev/spidev1.0
```

Run:

```bash
cd /opt/LS_Inventory

python3 scripts/nfc_reader.py
```

Expected:

```text
RC522 Ver : 0x92
Waiting for NFC card...
```

Press `Ctrl+C` when finished.

---

# 9. Test Central connectivity

```bash
cd /opt/LS_Inventory

node services/google_sync.js
```

Despite the legacy filename, this is now the Central synchronization service.

Expected:

```text
CENTRAL SYNC COMPLETE
Users cache      : ...
Items cache      : ...
```

The new cabinet should receive users/items from Pi 1.

---

# 10. Start Cabinet

```bash
cd /opt/LS_Inventory

pm2 start app.js \
    --name LS_Inventory \
    --cwd /opt/LS_Inventory

pm2 save
```

Do **not** start:

```text
LS_Inventory_Central
```

on a client cabinet.

---

# 11. Cabinet test

Test:

```text
NFC login
Borrow
Return
Consumable
QR UUID
5-digit CODE
```

Health:

```bash
curl http://127.0.0.1:3000/health
```

---

# 12. Offline test

After normal operation works:

1. Disconnect the new Pi from the Central node.
2. Perform a test transaction.
3. Confirm it becomes pending locally.
4. Restore connectivity.
5. Confirm pending transactions synchronize.

---

# 13. New cabinet checklist

```text
[ ] Unique DEVICE_ID
[ ] Unique DEVICE_API_KEY
[ ] Tailscale connected
[ ] Central :3100 reachable
[ ] /dev/spidev1.0 exists
[ ] RC522 Version 0x92
[ ] Camera working
[ ] TFT working
[ ] Initial Central sync successful
[ ] NFC user login successful
[ ] QR scan successful
[ ] 5-digit CODE successful
[ ] Borrow successful
[ ] Return successful
[ ] Consume successful
[ ] PM2 startup saved
```
