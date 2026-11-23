"""
sender.py — 맥 노치 앱과 이야기하기 (HTTP)
============================================================
  send('rock')  → POST http://맥:8899/gesture  {"name": "rock"}
                         맥이 설정을 보고 "락 플레이리스트 틀기" 같은 일을 해요.
  lyrics()             → GET  http://맥:8899/lyrics   지금 곡 가사 (OLED 가사 화면)
  now(present)         → GET  http://맥:8899/now?present=1   (present: 지금 카메라에 사람이 보이는지)
                         {"title", "artist", "isPlaying", "genre", "progress", "duration"} — OLED 에 보여줄 정보

맥 주소는 config.json 의 "mac". 몰라도 괜찮아요: 맥 노치 앱이 파이에 POST /api/mac 으로
"나 여기 있어" 하고 20초마다 알려주면 그 주소(learn)를 써요 → 남의 파이도 설정 없이 연결돼요.
보내기는 따로 스레드에서 해서, 네트워크가 느려도 카메라 인식이 멈추지 않아요.
"""

import json
import threading
import time
import urllib.request

FRESH = 60  # 이 시간 안에 "나 여기 있어" 한 맥만 받는 쪽으로 침 (맥 앱은 20초마다 알려줌)


class MacClient:
    def __init__(self, base):
        self.configured = (base or "").rstrip("/")
        self.learned = {}  # 맥 앱이 알려준 주소 → 마지막으로 들은 시각 (설정보다 먼저 씀 — 맥 IP 가 바뀌어도 따라감)
        self.last_result = None  # 마지막으로 보낸 결과 (OLED/로그용)

    def targets(self):
        """제스처를 보낼 맥들. 파이 하나를 맥 여러 대가 같이 쓰면 전부에게 (각자 자기 음악을 조작)"""
        now = time.time()
        alive = [u for u, t in self.learned.items() if now - t < FRESH]
        return alive or [self.base]

    @property
    def base(self):
        """곡 정보·가사를 물어볼 맥 = 가장 최근에 알려준 맥"""
        now = time.time()
        alive = sorted(((t, u) for u, t in self.learned.items() if now - t < FRESH), reverse=True)
        if alive:
            return alive[0][1]
        # "http://맥북IP:8899" 같은 자리표시는 못 씀 → 맥 앱이 알려줄 때까지 기다림
        if not self.configured or not all(c.isascii() for c in self.configured):
            return "http://127.0.0.1:8899"
        return self.configured

    def learn(self, ip, port=8899):
        url = f"http://{ip}:{int(port)}"
        if url not in self.learned or time.time() - self.learned[url] >= FRESH:
            print(f"[맥 주소] {url} 연결 (맥 앱이 알려줌)", flush=True)
        self.learned[url] = time.time()

    def send(self, name):
        for base in self.targets():
            threading.Thread(target=self._send, args=(name, base), daemon=True).start()

    def _send(self, name, base):
        body = json.dumps({"name": name}).encode()
        req = urllib.request.Request(
            f"{base}/gesture", data=body, headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=2) as res:
                self.last_result = json.loads(res.read() or b"null")
        except Exception as e:  # 맥이 꺼져 있거나 주소가 틀림
            self.last_result = {"ok": False, "reason": str(e)}
        print(f"[보냄] {name} → {base} {self.last_result}", flush=True)

    @staticmethod
    def _ping(url):
        try:
            urllib.request.urlopen(url, timeout=1.5).read()
        except Exception:
            pass

    def lyrics(self):
        """지금 곡의 가사 { id, ready, lines: [{t, text}] 또는 None } 또는 None (맥에 연결 안 됨)"""
        try:
            with urllib.request.urlopen(f"{self.base}/lyrics", timeout=2) as res:
                return json.loads(res.read() or b"null")
        except Exception:
            return None

    def now(self, present=None, people=None):
        """지금 곡 정보를 물어봄. present(True/False)를 주면 "지금 사람이 보이는지"도 같이 알려줘요
        → 맥이 자리 비움 감지(오래 안 보이면 멈춤)에 써요. people = 화면의 사람 수 (상황 엔진: 혼자/여럿)
        맥이 여러 대면 곡 정보는 가장 최근 맥에게 묻고, 사람 정보는 다른 맥들에도 같이 알려줘요."""
        q = {}
        if present is not None:
            q["present"] = 1 if present else 0
        if people is not None:
            q["people"] = int(people)
        ask = ("?" + "&".join(f"{k}={v}" for k, v in q.items())) if q else ""
        main = self.base
        for other in self.targets():
            if other != main and ask:
                threading.Thread(target=self._ping, args=(f"{other}/now{ask}",), daemon=True).start()
        try:
            with urllib.request.urlopen(f"{main}/now{ask}", timeout=1.5) as res:
                return json.loads(res.read() or b"null")
        except Exception:
            return None
