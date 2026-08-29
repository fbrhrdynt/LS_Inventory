#!/usr/bin/env python3

import json
import os
import re
import signal
import sys
import time

import spidev


# ============================================================
# CONFIGURATION
# ============================================================

ROOT = "/opt/LS_Inventory"

USERS_FILE = os.path.join(
    ROOT,
    "cache",
    "users.json"
)

SPI_BUS = 1
SPI_DEVICE = 0

SPI_SPEED = 1_000_000

SCAN_DELAY = 0.15

CARD_COOLDOWN = 2.0


# ============================================================
# RC522 REGISTERS
# ============================================================

CommandReg = 0x01
ComIEnReg = 0x02
DivIEnReg = 0x03
ComIrqReg = 0x04
DivIrqReg = 0x05
ErrorReg = 0x06
Status1Reg = 0x07
Status2Reg = 0x08
FIFODataReg = 0x09
FIFOLevelReg = 0x0A
WaterLevelReg = 0x0B
ControlReg = 0x0C
BitFramingReg = 0x0D
CollReg = 0x0E

ModeReg = 0x11
TxModeReg = 0x12
RxModeReg = 0x13
TxControlReg = 0x14
TxASKReg = 0x15

CRCResultRegH = 0x21
CRCResultRegL = 0x22

ModWidthReg = 0x24
RFCfgReg = 0x26
GsNReg = 0x27
CWGsPReg = 0x28
ModGsPReg = 0x29
TModeReg = 0x2A
TPrescalerReg = 0x2B
TReloadRegH = 0x2C
TReloadRegL = 0x2D

VersionReg = 0x37


# ============================================================
# RC522 COMMANDS
# ============================================================

PCD_IDLE = 0x00
PCD_CALCCRC = 0x03
PCD_TRANSCEIVE = 0x0C
PCD_RESETPHASE = 0x0F


# ============================================================
# PICC COMMANDS
# ============================================================

PICC_REQIDL = 0x26
PICC_REQALL = 0x52

PICC_ANTICOLL_CL1 = 0x93
PICC_ANTICOLL_CL2 = 0x95
PICC_ANTICOLL_CL3 = 0x97

PICC_SELECTTAG = 0x70


# ============================================================
# RESULT
# ============================================================

MI_OK = 0
MI_NOTAGERR = 1
MI_ERR = 2


running = True


# ============================================================
# SIGNAL
# ============================================================

def handle_signal(signum, frame):

    global running

    running = False


signal.signal(
    signal.SIGINT,
    handle_signal
)

signal.signal(
    signal.SIGTERM,
    handle_signal
)


# ============================================================
# RC522 DRIVER
# ============================================================

class RC522:

    def __init__(
        self,
        bus=SPI_BUS,
        device=SPI_DEVICE
    ):

        self.spi = spidev.SpiDev()

        self.spi.open(
            bus,
            device
        )

        self.spi.max_speed_hz = (
            SPI_SPEED
        )

        self.spi.mode = 0

        self.reset()

        self.init_reader()


    # --------------------------------------------------------
    # REGISTER
    # --------------------------------------------------------

    def write_reg(
        self,
        reg,
        value
    ):

        address = (
            (reg << 1)
            &
            0x7E
        )

        self.spi.xfer2(
            [
                address,
                value & 0xFF
            ]
        )


    def read_reg(
        self,
        reg
    ):

        address = (
            ((reg << 1) & 0x7E)
            |
            0x80
        )

        result = self.spi.xfer2(
            [
                address,
                0x00
            ]
        )

        return result[1]


    def set_bit_mask(
        self,
        reg,
        mask
    ):

        value = self.read_reg(
            reg
        )

        self.write_reg(
            reg,
            value | mask
        )


    def clear_bit_mask(
        self,
        reg,
        mask
    ):

        value = self.read_reg(
            reg
        )

        self.write_reg(
            reg,
            value & (~mask)
        )


    # --------------------------------------------------------
    # RESET
    # --------------------------------------------------------

    def reset(self):

        self.write_reg(
            CommandReg,
            PCD_RESETPHASE
        )

        time.sleep(
            0.05
        )


    # --------------------------------------------------------
    # INITIALIZATION
    # --------------------------------------------------------

    def init_reader(self):

        self.write_reg(
            TModeReg,
            0x8D
        )

        self.write_reg(
            TPrescalerReg,
            0x3E
        )

        self.write_reg(
            TReloadRegL,
            30
        )

        self.write_reg(
            TReloadRegH,
            0
        )

        self.write_reg(
            TxASKReg,
            0x40
        )

        self.write_reg(
            ModeReg,
            0x3D
        )

        self.antenna_on()


    # --------------------------------------------------------
    # ANTENNA
    # --------------------------------------------------------

    def antenna_on(self):

        value = self.read_reg(
            TxControlReg
        )

        if (
            value & 0x03
        ) != 0x03:

            self.set_bit_mask(
                TxControlReg,
                0x03
            )


    def antenna_off(self):

        self.clear_bit_mask(
            TxControlReg,
            0x03
        )


    # --------------------------------------------------------
    # COMMUNICATION
    # --------------------------------------------------------

    def card_write(
        self,
        command,
        send_data
    ):

        back_data = []

        back_len = 0

        status = MI_ERR

        irq_enable = 0x00

        wait_irq = 0x00


        if (
            command ==
            PCD_TRANSCEIVE
        ):

            irq_enable = 0x77
            wait_irq = 0x30


        self.write_reg(
            ComIEnReg,
            irq_enable | 0x80
        )

        self.clear_bit_mask(
            ComIrqReg,
            0x80
        )

        self.set_bit_mask(
            FIFOLevelReg,
            0x80
        )

        self.write_reg(
            CommandReg,
            PCD_IDLE
        )


        for value in send_data:

            self.write_reg(
                FIFODataReg,
                value
            )


        self.write_reg(
            CommandReg,
            command
        )


        if (
            command ==
            PCD_TRANSCEIVE
        ):

            self.set_bit_mask(
                BitFramingReg,
                0x80
            )


        counter = 2000

        while True:

            irq_value = self.read_reg(
                ComIrqReg
            )

            counter -= 1

            if (
                counter == 0
                or
                (
                    irq_value
                    &
                    0x01
                )
                or
                (
                    irq_value
                    &
                    wait_irq
                )
            ):

                break


        self.clear_bit_mask(
            BitFramingReg,
            0x80
        )


        if counter == 0:

            return (
                MI_ERR,
                [],
                0
            )


        error = self.read_reg(
            ErrorReg
        )


        if (
            error
            &
            0x1B
        ):

            return (
                MI_ERR,
                [],
                0
            )


        status = MI_OK


        if (
            irq_value
            &
            0x01
        ):

            status = MI_NOTAGERR


        if (
            command ==
            PCD_TRANSCEIVE
        ):

            fifo_level = (
                self.read_reg(
                    FIFOLevelReg
                )
            )

            last_bits = (
                self.read_reg(
                    ControlReg
                )
                &
                0x07
            )


            if last_bits:

                back_len = (
                    (fifo_level - 1)
                    *
                    8
                    +
                    last_bits
                )

            else:

                back_len = (
                    fifo_level
                    *
                    8
                )


            if fifo_level == 0:

                fifo_level = 1


            if fifo_level > 64:

                fifo_level = 64


            for _ in range(
                fifo_level
            ):

                back_data.append(
                    self.read_reg(
                        FIFODataReg
                    )
                )


        return (
            status,
            back_data,
            back_len
        )


    # --------------------------------------------------------
    # REQUEST
    # --------------------------------------------------------

    def request(
        self,
        request_mode=PICC_REQIDL
    ):

        self.write_reg(
            BitFramingReg,
            0x07
        )

        status, back_data, back_bits = (
            self.card_write(
                PCD_TRANSCEIVE,
                [
                    request_mode
                ]
            )
        )


        if (
            status != MI_OK
            or
            back_bits != 0x10
        ):

            status = MI_ERR


        return (
            status,
            back_data
        )


    # --------------------------------------------------------
    # ANTICOLLISION
    # --------------------------------------------------------

    def anticoll(
        self,
        cascade_command
    ):

        self.write_reg(
            BitFramingReg,
            0x00
        )

        send_data = [
            cascade_command,
            0x20
        ]


        status, back_data, back_bits = (
            self.card_write(
                PCD_TRANSCEIVE,
                send_data
            )
        )


        if status != MI_OK:

            return (
                status,
                []
            )


        if len(back_data) < 5:

            return (
                MI_ERR,
                []
            )


        check = 0

        for index in range(4):

            check ^= (
                back_data[index]
            )


        if check != back_data[4]:

            return (
                MI_ERR,
                []
            )


        return (
            MI_OK,
            back_data[:5]
        )


    # --------------------------------------------------------
    # CRC
    # --------------------------------------------------------

    def calculate_crc(
        self,
        data
    ):

        self.clear_bit_mask(
            DivIrqReg,
            0x04
        )

        self.set_bit_mask(
            FIFOLevelReg,
            0x80
        )


        for value in data:

            self.write_reg(
                FIFODataReg,
                value
            )


        self.write_reg(
            CommandReg,
            PCD_CALCCRC
        )


        counter = 255

        while counter > 0:

            value = self.read_reg(
                DivIrqReg
            )

            counter -= 1

            if (
                value
                &
                0x04
            ):

                break


        return [
            self.read_reg(
                CRCResultRegL
            ),
            self.read_reg(
                CRCResultRegH
            )
        ]


    # --------------------------------------------------------
    # SELECT TAG
    # --------------------------------------------------------

    def select_tag(
        self,
        cascade_command,
        uid_part
    ):

        buffer = [
            cascade_command,
            PICC_SELECTTAG
        ]

        buffer.extend(
            uid_part[:5]
        )


        crc = self.calculate_crc(
            buffer
        )

        buffer.extend(
            crc
        )


        status, back_data, back_bits = (
            self.card_write(
                PCD_TRANSCEIVE,
                buffer
            )
        )


        if (
            status == MI_OK
            and
            back_bits == 0x18
            and
            len(back_data) >= 1
        ):

            return (
                MI_OK,
                back_data[0]
            )


        return (
            MI_ERR,
            0
        )


    # --------------------------------------------------------
    # READ UID
    # --------------------------------------------------------

    def read_uid(self):

        status, _ = self.request(
            PICC_REQIDL
        )


        if status != MI_OK:

            return None


        # ====================================================
        # CASCADE LEVEL 1
        # ====================================================

        status, cl1 = self.anticoll(
            PICC_ANTICOLL_CL1
        )


        if status != MI_OK:

            return None


        status, sak = self.select_tag(
            PICC_ANTICOLL_CL1,
            cl1
        )


        if status != MI_OK:

            return None


        # ----------------------------------------------------
        # 4-byte UID
        # ----------------------------------------------------

        if cl1[0] != 0x88:

            return cl1[:4]


        uid = cl1[1:4]


        # ====================================================
        # CASCADE LEVEL 2
        # ====================================================

        status, cl2 = self.anticoll(
            PICC_ANTICOLL_CL2
        )


        if status != MI_OK:

            return None


        status, sak = self.select_tag(
            PICC_ANTICOLL_CL2,
            cl2
        )


        if status != MI_OK:

            return None


        # ----------------------------------------------------
        # 7-byte UID
        # ----------------------------------------------------

        if cl2[0] != 0x88:

            uid.extend(
                cl2[:4]
            )

            return uid


        uid.extend(
            cl2[1:4]
        )


        # ====================================================
        # CASCADE LEVEL 3
        # ====================================================

        status, cl3 = self.anticoll(
            PICC_ANTICOLL_CL3
        )


        if status != MI_OK:

            return None


        uid.extend(
            cl3[:4]
        )


        return uid


    # --------------------------------------------------------
    # VERSION
    # --------------------------------------------------------

    def get_version(self):

        return self.read_reg(
            VersionReg
        )


    # --------------------------------------------------------
    # CLOSE
    # --------------------------------------------------------

    def close(self):

        try:

            self.antenna_off()

        except Exception:

            pass


        try:

            self.spi.close()

        except Exception:

            pass


# ============================================================
# UID
# ============================================================

def uid_to_string(
    uid
):

    return ":".join(
        f"{byte:02X}"
        for byte in uid
    )


def uid_to_compact(
    uid
):

    return "".join(
        f"{byte:02X}"
        for byte in uid
    )


def normalize_uid(
    value
):

    text = str(
        value or ""
    ).upper()


    if text.startswith(
        "0X"
    ):

        text = text[2:]


    return re.sub(
        r"[^0-9A-F]",
        "",
        text
    )


# ============================================================
# USERS
# ============================================================

def load_users():

    try:

        if not os.path.exists(
            USERS_FILE
        ):

            return []


        with open(
            USERS_FILE,
            "r",
            encoding="utf-8"
        ) as file:

            data = json.load(
                file
            )


        if isinstance(
            data,
            list
        ):

            return data


        return []


    except Exception as error:

        print(
            f"USERS_CACHE_ERROR:{error}",
            flush=True
        )

        return []


def is_user_active(
    user
):

    # --------------------------------------------------------
    # ACTIVE column
    # --------------------------------------------------------

    if "ACTIVE" in user:

        value = str(
            user.get(
                "ACTIVE",
                ""
            )
        ).strip().upper()

        return value in [
            "TRUE",
            "1",
            "YES",
            "Y",
            "ACTIVE",
            "ENABLED"
        ]


    # --------------------------------------------------------
    # STATUS column
    # --------------------------------------------------------

    if "STATUS" in user:

        value = str(
            user.get(
                "STATUS",
                ""
            )
        ).strip().upper()


        if value:

            return value in [
                "ACTIVE",
                "ENABLED",
                "TRUE",
                "1",
                "YES"
            ]


    # --------------------------------------------------------
    # No ACTIVE/STATUS column
    # --------------------------------------------------------

    return True


def find_user_by_uid(
    uid
):

    target = normalize_uid(
        uid
    )


    users = load_users()


    for user in users:

        if not isinstance(
            user,
            dict
        ):

            continue


        card_uid = normalize_uid(
            user.get(
                "CARD_UID",
                ""
            )
        )


        if not card_uid:

            continue


        if (
            card_uid ==
            target
            and
            is_user_active(
                user
            )
        ):

            return user


    return None


# ============================================================
# BANNER
# ============================================================

def print_banner(
    version
):

    print(
        "",
        flush=True
    )

    print(
        "======================================",
        flush=True
    )

    print(
        "       LS_Inventory NFC Reader",
        flush=True
    )

    print(
        "======================================",
        flush=True
    )

    print(
        "Interface : RC522 / SPI1",
        flush=True
    )

    print(
        "SPI       : /dev/spidev1.0",
        flush=True
    )

    print(
        f"RC522 Ver : 0x{version:02X}",
        flush=True
    )

    print(
        "",
        flush=True
    )

    print(
        "Waiting for NFC card...",
        flush=True
    )

    print(
        "",
        flush=True
    )


# ============================================================
# MAIN
# ============================================================

def main():

    reader = None


    try:

        reader = RC522(
            bus=SPI_BUS,
            device=SPI_DEVICE
        )


        version = (
            reader.get_version()
        )


        if version not in [
            0x88,
            0x90,
            0x91,
            0x92
        ]:

            raise RuntimeError(
                "RC522 tidak terdeteksi. "
                f"Version register: 0x{version:02X}"
            )


        print_banner(
            version
        )


        last_uid = None
        last_seen = 0


        while running:

            uid_bytes = (
                reader.read_uid()
            )


            if not uid_bytes:

                time.sleep(
                    SCAN_DELAY
                )

                continue


            uid_colon = (
                uid_to_string(
                    uid_bytes
                )
            )


            uid_compact = (
                uid_to_compact(
                    uid_bytes
                )
            )


            now = time.time()


            if (
                uid_compact ==
                last_uid
                and
                (
                    now -
                    last_seen
                )
                <
                CARD_COOLDOWN
            ):

                time.sleep(
                    SCAN_DELAY
                )

                continue


            last_uid = (
                uid_compact
            )

            last_seen = (
                now
            )


            print(
                f"CARD_UID:{uid_colon}",
                flush=True
            )


            user = (
                find_user_by_uid(
                    uid_colon
                )
            )


            if user:

                print(
                    "USER_JSON:"
                    +
                    json.dumps(
                        user,
                        ensure_ascii=False,
                        separators=(
                            ",",
                            ":"
                        )
                    ),
                    flush=True
                )

            else:

                print(
                    f"UNKNOWN_CARD:{uid_colon}",
                    flush=True
                )


            time.sleep(
                CARD_COOLDOWN
            )


    except KeyboardInterrupt:

        pass


    except Exception as error:

        print(
            "",
            flush=True
        )

        print(
            "NFC Reader Error:",
            flush=True
        )

        print(
            str(error),
            flush=True
        )


        sys.exit(
            1
        )


    finally:

        if reader:

            reader.close()


if __name__ == "__main__":

    main()
