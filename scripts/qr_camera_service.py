#!/usr/bin/env python3

import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np


HOST = "0.0.0.0"
PORT = 3001

# Optimized untuk Raspberry Pi 3B
WIDTH = 640
HEIGHT = 480
FPS = 20

latest_frame = None
frame_lock = threading.Lock()
running = True


class CameraHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        # Matikan log HTTP supaya terminal tidak penuh.
        return

    def do_GET(self):
        global latest_frame
        global running

        # Halaman test camera.
        if self.path == "/":
            self.send_response(200)
            self.send_header(
                "Content-Type",
                "text/html"
            )
            self.end_headers()

            html = """
            <!DOCTYPE html>
            <html>
            <head>
                <title>LS Inventory Camera</title>
            </head>
            <body style="
                margin:0;
                background:#000;
                display:flex;
                align-items:center;
                justify-content:center;
                min-height:100vh;
            ">
                <img
                    src="/stream.mjpg"
                    style="
                        width:100%;
                        max-width:800px;
                        height:auto;
                    "
                >
            </body>
            </html>
            """

            self.wfile.write(
                html.encode("utf-8")
            )

            return

        # MJPEG endpoint.
        if not self.path.startswith(
            "/stream.mjpg"
        ):
            self.send_response(404)
            self.end_headers()
            return

        self.send_response(200)

        self.send_header(
            "Cache-Control",
            "no-cache, no-store, must-revalidate"
        )

        self.send_header(
            "Pragma",
            "no-cache"
        )

        self.send_header(
            "Expires",
            "0"
        )

        self.send_header(
            "Content-Type",
            "multipart/x-mixed-replace; boundary=frame"
        )

        self.end_headers()

        try:
            while running:
                with frame_lock:
                    frame = latest_frame

                if frame is None:
                    time.sleep(0.02)
                    continue

                self.wfile.write(
                    b"--frame\r\n"
                )

                self.wfile.write(
                    b"Content-Type: image/jpeg\r\n"
                )

                self.wfile.write(
                    b"Content-Length: "
                    + str(len(frame)).encode()
                    + b"\r\n\r\n"
                )

                self.wfile.write(
                    frame
                )

                self.wfile.write(
                    b"\r\n"
                )

                time.sleep(
                    1 / FPS
                )

        except (
            BrokenPipeError,
            ConnectionResetError
        ):
            pass


def start_http_server():
    try:
        server = ThreadingHTTPServer(
            (HOST, PORT),
            CameraHandler
        )

        print(
            f"CAMERA_STREAM_READY:http://0.0.0.0:{PORT}/stream.mjpg",
            flush=True
        )

        server.serve_forever()

    except Exception as error:
        print(
            f"CAMERA_SERVER_ERROR:{error}",
            flush=True
        )


def decode_qr(
    detector,
    jpeg
):
    try:
        frame_array = np.frombuffer(
            jpeg,
            dtype=np.uint8
        )

        # Grayscale lebih ringan daripada BGR.
        frame = cv2.imdecode(
            frame_array,
            cv2.IMREAD_GRAYSCALE
        )

        if frame is None:
            return None

        # Sedikit peningkatan kontras.
        frame = cv2.equalizeHist(
            frame
        )

        data, points, _ = (
            detector.detectAndDecode(
                frame
            )
        )

        if not data:
            return None

        data = data.strip()

        if not data:
            return None

        return data

    except Exception as error:
        print(
            f"QR_DECODE_ERROR:{error}",
            flush=True
        )

        return None


def main():
    global latest_frame
    global running

    print(
        "Starting Raspberry Pi camera...",
        flush=True
    )

    detector = cv2.QRCodeDetector()

    command = [
        "rpicam-vid",

        "-t",
        "0",

        "--width",
        str(WIDTH),

        "--height",
        str(HEIGHT),

        "--framerate",
        str(FPS),

        "--codec",
        "mjpeg",

        "--nopreview",

        "--flush",

        "--output",
        "-"
    ]

    camera = None

    try:
        camera = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0
        )

        if camera.stdout is None:
            raise RuntimeError(
                "Camera stdout tidak tersedia."
            )

        server_thread = threading.Thread(
            target=start_http_server,
            daemon=True
        )

        server_thread.start()

        buffer = b""

        last_qr = None
        last_qr_time = 0.0

        frame_count = 0

        while running:
            chunk = camera.stdout.read(
                8192
            )

            if not chunk:
                if camera.poll() is not None:
                    print(
                        "Camera process stopped unexpectedly.",
                        flush=True
                    )
                    break

                continue

            buffer += chunk

            # Cegah buffer membesar tanpa batas.
            if len(buffer) > 10_000_000:
                start_marker = buffer.rfind(
                    b"\xff\xd8"
                )

                if start_marker >= 0:
                    buffer = buffer[
                        start_marker:
                    ]
                else:
                    buffer = b""

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
                    start:
                    end + 2
                ]

                buffer = buffer[
                    end + 2:
                ]

                # Kirim JPEG asli ke live preview.
                with frame_lock:
                    latest_frame = jpeg

                frame_count += 1

                # Scan setiap frame.
                qr_data = decode_qr(
                    detector,
                    jpeg
                )

                if qr_data is None:
                    continue

                now = time.time()

                # Debounce QR yang sama.
                if (
                    qr_data == last_qr
                    and
                    now - last_qr_time < 2
                ):
                    continue

                last_qr = qr_data
                last_qr_time = now

                print(
                    f"QR_DETECTED:{qr_data}",
                    flush=True
                )

    except KeyboardInterrupt:
        print(
            "QR Camera interrupted.",
            flush=True
        )

    except Exception as error:
        print(
            f"QR_CAMERA_ERROR:{error}",
            flush=True
        )

    finally:
        running = False

        if camera is not None:
            if camera.poll() is None:
                camera.terminate()

                try:
                    camera.wait(
                        timeout=2
                    )

                except subprocess.TimeoutExpired:
                    camera.kill()

                    try:
                        camera.wait(
                            timeout=1
                        )

                    except subprocess.TimeoutExpired:
                        pass

        print(
            "Camera service stopped.",
            flush=True
        )


if __name__ == "__main__":
    main()
