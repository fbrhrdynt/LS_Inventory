#!/usr/bin/env python3

import serial
from adafruit_pn532.uart import PN532_UART


PORT = "/dev/serial0"
BAUDRATE = 115200


print("")
print("======================================")
print(" PN532 HSU/UART DEBUG")
print("======================================")
print("")

try:

    print(f"Serial Port : {PORT}")
    print(f"Baudrate    : {BAUDRATE}")
    print("")

    uart = serial.Serial(
        PORT,
        baudrate=BAUDRATE,
        timeout=1
    )

    print("Serial port opened.")
    print("")
    print("Initializing PN532...")
    print("")

    pn532 = PN532_UART(
        uart,
        debug=True
    )

    print("")
    print("Reading PN532 firmware...")
    print("")

    ic, ver, rev, support = pn532.firmware_version

    print("")
    print("======================================")
    print(" PN532 DETECTED")
    print("======================================")
    print("")
    print(f"IC       : 0x{ic:02X}")
    print(f"Firmware : {ver}.{rev}")
    print(f"Support  : 0x{support:02X}")
    print("")

    pn532.SAM_configuration()

    print("NFC Reader Ready")
    print("")

except Exception as error:

    print("")
    print("======================================")
    print(" PN532 UART DEBUG FAILED")
    print("======================================")
    print("")
    print(type(error).__name__)
    print(error)
    print("")
