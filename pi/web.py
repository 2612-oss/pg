"""
web.py — 파이 웹 대시보드 (기획서 5번: 동작 설정, 재학습)
============================================================
브라우저에서  http://파이IP:8090/  을 열면
  - 관절이 그려진 카메라 화면 (맥 노치 카메라 칸에도 같은 /stream 이 나옴)
  - 지금 인식된 동작과 확신도
  - 동작 녹화 / 학습 / 삭제 버튼

주소 목록
  GET  /             대시보드 (dashboard.html)
  GET  /stream       카메라 영상 (MJPEG: JPEG 를 계속 이어 보내는 단순한 영상)
  GET  /api/state    지금 상태 JSON
  GET  /api/poses    동작마다 대표 자세 (맥 설정 화면의 "동작 모형"용)
  POST /api/record   {"name": "rock", "seconds": 5}  → 3초 뒤부터 5초 동안 녹화
  GET  /api/oled     OLED 화면마다 지금 그림(PNG) — 맥 설정 화면의 "OLED 화면 확인"
  POST /api/oled     {"identify": 5} → 각 OLED 에 번호를 5초 띄움 (어느 선이 어느 화면인지)
  POST /api/train    학습
  POST /api/delete   {"name": "rock"}  → 그 동작 샘플 지우기

실제 일(녹화, 학습)은 gesture_pi.py 의 App 이 하고, 여기는 주소와 App 을 이어주기만 해요.
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2

DASHBOARD = Path(__file__).parent / "dashboard.html"


class WebServer:
    def __init__(self, port, app):
        self.port = port
        self.app = app  # get_state(), start_record(name, seconds), train(), delete(name)
        self.jpeg = None
        self.cond = threading.Condition()
        self.viewers = 0  # 지금 /stream 을 보고 있는 수 (대시보드, 맥 노치, 설정 창)

    def watching(self):
        return self.viewers > 0

    def publish(self, bgr):
        """카메라 루프에서 매 프레임 부름 → 스트림으로 나갈 JPEG 갱신"""
        ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 82])
        if ok:
            with self.cond:
                self.jpeg = buf.tobytes()
                self.cond.notify_all()

    def start(self):
        web = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # 접속 로그는 안 찍음
                pass

            def reply(self, code, body, ctype="application/json; charset=utf-8"):
                data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)

            def body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(n) or b"{}") if n else {}

            def do_GET(self):
                path = self.path.split("?")[0]
                if path == "/":
                    return self.reply(200, DASHBOARD.read_bytes(), "text/html; charset=utf-8")
                if path == "/api/state":
                    return self.reply(200, web.app.get_state())
                if path == "/api/oled":
                    return self.reply(200, web.app.oled.preview())
                if path == "/api/poses":
                    return self.reply(200, web.app.classifier.poses())
                if path == "/stream":
                    return self.stream()
                self.reply(404, {"ok": False})

            def do_POST(self):
                try:
                    data = self.body()
                except ValueError:
                    return self.reply(400, {"ok": False, "reason": "JSON 이 아니에요"})
                if self.path == "/api/record":
                    return self.reply(200, web.app.start_record(str(data.get("name", "")).strip(), data.get("seconds", 5)))
                if self.path == "/api/train":
                    return self.reply(200, web.app.train())
                if self.path == "/api/oled":  # {"identify": 5} → 각 OLED 에 번호를 5초 띄움
                    web.app.oled.identify(float(data.get("identify", 5)))
                    return self.reply(200, {"ok": True})
                if self.path == "/api/mac":  # 맥 노치 앱: "제스처는 나한테 보내" → 요청이 온 IP 를 맥 주소로
                    web.app.mac.learn(self.client_address[0], data.get("port", 8899))
                    return self.reply(200, {"ok": True, "mac": web.app.mac.base})
                if self.path == "/api/delete":
                    return self.reply(200, web.app.delete(str(data.get("name", ""))))
                self.reply(404, {"ok": False})

            def stream(self):
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                with web.cond:
                    web.viewers += 1
                last = None
                try:
                    while True:
                        with web.cond:
                            web.cond.wait_for(lambda: web.jpeg is not last, timeout=1.0)  # 새 프레임이 오면 바로
                            jpeg = web.jpeg
                        if jpeg is None or jpeg is last:
                            continue
                        last = jpeg
                        self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n")
                        self.wfile.write(f"Content-Length: {len(jpeg)}\r\n\r\n".encode())
                        self.wfile.write(jpeg + b"\r\n")
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass  # 보던 사람이 창을 닫음
                finally:
                    with web.cond:
                        web.viewers -= 1

        server = ThreadingHTTPServer(("0.0.0.0", self.port), Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"[웹] 대시보드: http://0.0.0.0:{self.port}/", flush=True)
