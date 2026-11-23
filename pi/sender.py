"""
sender.py — 맥 노치 앱과 이야기하기 (HTTP)
============================================================
  send('rock')  → POST http://맥:8899/gesture  {"name": "rock"}
                         맥이 설정을 보고 "락 플레이리스트 틀기" 같은 일을 해요.
  lyrics()             → GET  http://맥:8899/lyrics   지금 곡 가사 (OLED 가사 화면)
  now(present)         → GET  http://맥:8899/now?present=1   (present: 지금 카메라에 사람이 보이는지)
                         {"title", "artist", "isPlaying", "genre", "progress", "duration"} — OLED 에 보여줄 정보

맥 주소는 config.json 의 "mac". 맥 IP 가 바뀌면 거기만 고치면 돼요.
보내기는 따로 스레드에서 해서, 네트워크가 느려도 카메라 인식이 멈추지 않아요.
"""

import json
import threading
import urllib.request


class MacClient:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.last_result = None  # 마지막으로 보낸 결과 (OLED/로그용)

    def send(self, name):
        threading.Thread(target=self._send, args=(name,), daemon=True).start()

    def _send(self, name):
        body = json.dumps({"name": name}).encode()
        req = urllib.request.Request(
            f"{self.base}/gesture", data=body, headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=2) as res:
                self.last_result = json.loads(res.read() or b"null")
        except Exception as e:  # 맥이 꺼져 있거나 주소가 틀림
            self.last_result = {"ok": False, "reason": str(e)}
        print(f"[보냄] {name} → {self.last_result}", flush=True)

    def lyrics(self):
        """지금 곡의 가사 { id, ready, lines: [{t, text}] 또는 None } 또는 None (맥에 연결 안 됨)"""
        try:
            with urllib.request.urlopen(f"{self.base}/lyrics", timeout=2) as res:
                return json.loads(res.read() or b"null")
        except Exception:
            return None

    def now(self, present=None):
        """지금 곡 정보를 물어봄. present(True/False)를 주면 "지금 사람이 보이는지"도 같이 알려줘요
        → 맥이 자리 비움 감지(오래 안 보이면 멈춤)에 써요"""
        ask = "" if present is None else f"?present={1 if present else 0}"
        try:
            with urllib.request.urlopen(f"{self.base}/now{ask}", timeout=1.5) as res:
                return json.loads(res.read() or b"null")
        except Exception:
            return None
