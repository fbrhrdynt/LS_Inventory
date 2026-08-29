# LS Inventory Architecture

## 1. Roles

### Primary Raspberry Pi

Raspberry Pi 1 has two roles:

1. **Central Server**
2. **HMI Lab Cabinet**

It is the current single central node for LS Inventory.

Services:

```text
LS_Inventory           :3000
LS_Inventory_Central   :3100
```

Databases:

```text
/opt/LS_Inventory/data/device.db
/opt/LS_Inventory/central/data/central.db
```

### Additional Raspberry Pi Cabinets

A second cabinet has only:

```text
Cabinet UI
RC522
QR camera
TFT
device.db
sync client
Tailscale
```

It does not contain the master database.

---

## 2. Central master and local database

### central.db

Central administrative/master database.

Contains system-wide data such as:

```text
users
items
transactions
devices
settings
sync changes
```

### device.db

Local operational database on each cabinet.

Purpose:

- fast local NFC lookup
- fast item lookup
- offline Borrow/Return/Consume
- local pending transaction queue
- local master-data cache

The cabinet should still work if the primary Pi becomes temporarily unreachable.

---

## 3. Synchronization

Master data direction:

```text
Web Admin
   |
   v
Central
   |
   v
Cabinet device.db
```

Transactions:

```text
Cabinet
   |
   v
device.db
   |
   v
Central API
   |
   v
central.db
```

If Central cannot be reached:

```text
Cabinet transaction
   |
   v
device.db
   |
   v
PENDING queue
```

When Central returns:

```text
PENDING queue
   |
   v
Central API
   |
   v
central.db
```

---

## 4. Device identity

Every cabinet must have a unique:

```text
DEVICE_ID
DEVICE_NAME
DEVICE_API_KEY
```

Example:

```text
LS_Cab_LabHMI
LS_Cab_Workshop01
LS_Cab_Warehouse01
```

Never reuse a `DEVICE_ID` or API key between cabinets.

---

## 5. Networking

Preferred network:

```text
Tailscale
```

The central database itself should not be shared over SMB/NFS and should not be mounted directly by client cabinets.

Client cabinets communicate with the Central API.

Recommended:

```text
Pi 2
  |
  | HTTPS / private Tailscale
  v
Pi 1 Central API
  |
  v
central.db
```

---

## 6. Scale

For large datasets:

- SQLite indexes are used for local lookups.
- Web Admin must use pagination.
- Central sync is incremental.
- Initial sync is paged/batched.
- Transactions have unique IDs to prevent duplicate processing.
- Do not load the complete transaction history into a cabinet.

---

## 7. Hardware bus layout

Current design:

```text
SPI0.0 -> TFT display
SPI0.1 -> ADS7846/XPT2046 touchscreen
SPI1.0 -> RC522
CSI    -> Camera
```

RC522 wiring:

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

Boot overlay:

```text
dtparam=spi=on
dtoverlay=tft35a:rotate=0
dtoverlay=spi1-1cs,cs0_pin=16
```

The TFT overlay must exist in:

```text
/boot/firmware/overlays/
```

---

## 8. Future migration

The architecture intentionally separates Cabinet and Central.

Later the Central node can move from Raspberry Pi 1 to:

```text
Mini PC
NAS
VPS
dedicated server
```

The cabinet configuration only needs its Central API URL changed.

The client cabinet application should not depend on the physical location of Central.
