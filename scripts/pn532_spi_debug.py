#!/usr/bin/env python3

import board
import busio

from digitalio import DigitalInOut
from adafruit_pn532.spi import PN532_SPI


print("")
print("======================================")
print(" PN532 SPI DEBUG")
print("======================================")
print("")

try:

    print("Creating SPI bus...")

    spi = busio.SPI(
        board.SCK,
        board.MOSI,
        board.MISO
    )

    print("SPI bus OK")

    print("Creating CS on GPIO5...")

    cs = DigitalInOut(board.D5)

    print("CS OK")

    print("")
    print("Initializing PN532 with DEBUG ON...")
    print("")

    pn532 = PN532_SPI(
        spi,
        cs,
        debug=True
    )

    print("")
    print("PN532 object created.")
    print("Reading firmware...")
    print("")

    ic, ver, rev, support = pn532.firmware_version

    print("")
    print("======================================")
    print(" PN532 DETECTED")
    print("======================================")
    print(f"IC       : 0x{ic:02X}")
    print(f"Firmware : {ver}.{rev}")
    print(f"Support  : {support}")
    print("")

except Exception as error:

    print("")
    print("======================================")
    print(" PN532 DEBUG FAILED")
    print("======================================")
    print("")
    print(type(error).__name__)
    print(error)
    print("")
