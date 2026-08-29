#!/usr/bin/env python3

import subprocess
import sys

import cv2
import numpy as np


WIDTH = 1280
HEIGHT = 720
FRAMERATE = 15


def main():

    print(
        "QR Scanner Ready",
        flush=True
    )

    detector = cv2.QRCodeDetector()

    command = [
        "rpicam-vid",
        "-t", "0",
        "--width", str(WIDTH),
        "--height", str(HEIGHT),
        "--framerate", str(FRAMERATE),
        "--codec", "mjpeg",
        "--nopreview",
        "--output", "-"
    ]

    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=0
    )

    buffer = b""

    try:

        while True:

            chunk = process.stdout.read(4096)

            if not chunk:
                break

            buffer += chunk

            while True:

                start = buffer.find(
                    b"\xff\xd8"
                )

                if start == -1:
                    break

                end = buffer.find(
                    b"\xff\xd9",
                    start + 2
                )

                if end == -1:
                    break

                jpeg = buffer[
                    start:end + 2
                ]

                buffer = buffer[
                    end + 2:
                ]

                frame_array = (
                    np.frombuffer(
                        jpeg,
                        dtype=np.uint8
                    )
                )

                frame = cv2.imdecode(
                    frame_array,
                    cv2.IMREAD_COLOR
                )

                if frame is None:
                    continue

                data, points, _ = (
                    detector.detectAndDecode(
                        frame
                    )
                )

                if not data:
                    continue

                data = data.strip()

                if not data:
                    continue

                print(
                    f"QR_DETECTED:{data}",
                    flush=True
                )

                return 0

    except KeyboardInterrupt:

        return 0

    finally:

        if (
            process
            and
            process.poll() is None
        ):

            process.terminate()

            try:
                process.wait(
                    timeout=2
                )
            except subprocess.TimeoutExpired:
                process.kill()

    return 0


if __name__ == "__main__":
    sys.exit(main())
