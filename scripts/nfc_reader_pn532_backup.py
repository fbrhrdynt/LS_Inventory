#!/usr/bin/env python3

import json
import os
import time

import serial
from adafruit_pn532.uart import PN532_UART


ROOT = "/opt/LS_Inventory"
USERS_FILE = os.path.join(ROOT, "cache", "users.json")

SERIAL_PORT = "/dev/serial0"
BAUDRATE = 115200


def format_uid(uid):
    return ":".join(f"{byte:02X}" for byte in uid)


def load_users():
    if not os.path.exists(USERS_FILE):
        print("WARNING: users.json tidak ditemukan.", flush=True)
        return []

    try:
        with open(USERS_FILE, "r", encoding="utf-8") as file:
            data = json.load(file)

        if isinstance(data, list):
            return data

        return []

    except Exception as error:
        print(
            f"Error loading users.json: {error}",
            flush=True
        )
        return []


def find_user(card_uid):
    users = load_users()

    target_uid = str(card_uid).strip().upper()

    for user in users:
        stored_uid = str(
            user.get("CARD_UID", "")
        ).strip().upper()

        status = str(
            user.get("STATUS", "")
        ).strip().upper()

        if (
            stored_uid == target_uid
            and status == "ACTIVE"
        ):
            return user

    return None


def main():
    print("")
    print("======================================")
    print("       LS_Inventory NFC Reader")
    print("======================================")
    print("Interface : HSU / UART")
    print("")

    uart = None

    try:
        uart = serial.Serial(
            SERIAL_PORT,
            baudrate=BAUDRATE,
            timeout=1
        )

        # Beri waktu UART stabil.
        time.sleep(0.5)

        # Bersihkan data lama dari buffer serial.
        uart.reset_input_buffer()
        uart.reset_output_buffer()

        time.sleep(0.2)

        pn532 = PN532_UART(
            uart,
            debug=False
        )

        ic, ver, rev, support = (
            pn532.firmware_version
        )

        print(
            f"PN532 Firmware : {ver}.{rev}",
            flush=True
        )

        print(
            f"Chip           : 0x{ic:02X}",
            flush=True
        )

        pn532.SAM_configuration()

        users = load_users()

        print(
            f"Users Cache    : {len(users)} user(s)",
            flush=True
        )

        print("")
        print("NFC Reader Ready", flush=True)
        print("")
        print(
            "Tempelkan kartu NFC...",
            flush=True
        )
        print(
            "Tekan Ctrl+C untuk berhenti.",
            flush=True
        )
        print("")

        last_uid = None
        last_read_time = 0

        while True:
            uid = pn532.read_passive_target(
                timeout=0.5
            )

            if uid is None:
                continue

            uid_text = format_uid(uid)

            now = time.time()

            if (
                uid_text == last_uid
                and now - last_read_time < 2
            ):
                continue

            last_uid = uid_text
            last_read_time = now

            print("")
            print(
                "======================================"
            )
            print("CARD DETECTED")
            print(f"UID : {uid_text}")
            print("")

            user = find_user(uid_text)

            if user:
                print("USER FOUND")
                print(
                    f"Name       : "
                    f"{user.get('NAME', '-')}"
                )
                print(
                    f"Role       : "
                    f"{user.get('ROLE', '-')}"
                )
                print(
                    f"Status     : "
                    f"{user.get('STATUS', '-')}"
                )
                print("")
                print("ACCESS : ALLOWED")

                # Digunakan Node.js/Socket.IO.
                print(
                    "USER_JSON:"
                    + json.dumps(
                        user,
                        ensure_ascii=False
                    ),
                    flush=True
                )

            else:
                print("USER NOT REGISTERED")
                print("")
                print(
                    "ACCESS : DENIED",
                    flush=True
                )

            print(
                "======================================"
            )
            print("")

    except KeyboardInterrupt:
        print("")
        print(
            "NFC Reader stopped.",
            flush=True
        )

    except Exception as error:
        print("")
        print(
            "NFC Reader Error:",
            flush=True
        )
        print(
            str(error),
            flush=True
        )

    finally:
        if uart is not None:
            try:
                uart.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()
