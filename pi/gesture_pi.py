"""
gesture_pi.py — 동작 인식 (메인) — 라즈베리파이에서도, 맥북에서도 같은 코드
============================================================
기획서 동작 흐름:
  웹캠 → 파이에서 동작 인식 → (맥) 장르 결정 → Spotify 검색 → 재생 → OLED 표시

사용 기술 (기획서 그대로)
  OpenCV       웹캠 영상 입력
  MediaPipe    몸 33점, 손 21점 관절 좌표 추출  (landmarks.py)
  scikit-learn 동작 분류 모델 학습/판별         (classifier.py)

영상과 인식을 따로 돌려요 (인식은 파이에서 3~6fps 라, 같이 돌리면 화면도 뚝뚝 끊김)
  CameraThread : 웹캠을 30fps 로 계속 읽고, 마지막 인식 결과(관절)를 덧그려서 대시보드/노치로 보냄
  App.run      : 가장 최근 프레임을 가져와서 인식 (끝나면 다음 최신 프레임)

인식 한 번에 하는 일
  1) 가장 최근 프레임 가져오기
  2) 관절 좌표 뽑기 (몸 33 + 손 21)
  3) 스와이프인가? (swipe.py, 손바닥 이동 거리로 판단) → 맞으면 바로 맥으로
  4) scikit-learn 모델로 동작 이름 판별 (rock, pop, play_pause …)
  5) 오작동 방지 (stabilize.py: 다수결 + 1초 유지 + 쿨다운) 를 통과하면 맥으로 (sender.py)
  6) 녹화 중이면 샘플 저장 / 대시보드 영상(web.py) 갱신
  OLED(oled.py) 와 맥 상태 묻기는 status_loop 스레드에서 따로 (느려서 인식을 막지 않게)

실행:  ./run.sh            (또는 서비스: sudo systemctl start gesture-pi)
       ./run.sh --debug    (1초마다 fps, 지금 판별 결과 출력)
대시보드: http://파이IP:8090/
"""

import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path

import cv2

from classifier import ActionClassifier
from fan import Fan
from landmarks import Landmarker
from oled import Oled
from sender import MacClient
from stabilize import Stabilizer
from swipe import SwipeDetector, palm
from web import WebServer
import updater

# 설정·모델·샘플을 두는 곳. 파이에선 이 폴더.
# 맥 노치 앱이 "맥북 카메라"로 켤 땐 GESTURE_HOME 으로 다른 폴더를 알려줘요 (앱을 다시 만들어도 학습이 안 지워지게)
HERE = Path(os.environ.get("GESTURE_HOME") or Path(__file__).parent)
COUNTDOWN = 3.0  # 녹화 버튼을 누르고 시작까지 (자세 잡을 시간)

# 그리기용 관절 연결선
HAND_LINKS = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12),
              (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (0, 17), (17, 18), (18, 19), (19, 20)]
POSE_LINKS = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24), (15, 19), (16, 20)]


def load_config():
    with open(HERE / "config.json", encoding="utf-8") as f:
        cfg = json.load(f)
    # 내 맥 주소처럼 나만 쓰는 값은 config.local.json 에 (깃허브에 안 올라감) → 있으면 덮어씀
    local = HERE / "config.local.json"
    if local.exists():
        with open(local, encoding="utf-8") as f:
            cfg.update(json.load(f))
    return cfg


def open_camera(cfg):
    # 리눅스(파이)는 USB 웹캠 방식(V4L2)으로 바로 열고, 맥은 알아서 고르게 둠 (맥북 내장 카메라)
    backend = cv2.CAP_V4L2 if sys.platform.startswith("linux") else cv2.CAP_ANY
    cap = cv2.VideoCapture(cfg.get("camera", 0), backend)
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))  # 압축 영상으로 받아야 빠름
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, cfg.get("width", 640))
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, cfg.get("height", 480))
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # 오래된 프레임이 쌓이지 않게 (반응 빠르게)
    if not cap.isOpened():
        raise SystemExit("웹캠을 열지 못했어요. 꽂혀 있는지, config.json 의 camera 번호(0, 1…)를 확인하세요.")
    return cap


def draw(frame, lm, text, progress, rec):
    """대시보드/노치용 그림: 거울로 뒤집고 관절과 지금 판정을 그림"""
    frame = cv2.flip(frame, 1)  # 거울 (landmarks.py 좌표도 거울 기준이라 그대로 맞음)
    h, w = frame.shape[:2]
    px = lambda p: (int(p[0] * w), int(p[1] * h))
    if lm and lm.pose:
        for a, b in POSE_LINKS:
            if lm.pose[a][3] > 0.5 and lm.pose[b][3] > 0.5:
                cv2.line(frame, px(lm.pose[a]), px(lm.pose[b]), (255, 200, 80), 2)
    if lm and lm.hand:
        for a, b in HAND_LINKS:
            cv2.line(frame, px(lm.hand[a]), px(lm.hand[b]), (96, 215, 30), 2)
        for p in lm.hand:
            cv2.circle(frame, px(p), 3, (255, 255, 255), -1)
    if text:
        cv2.putText(frame, text, (12, 34), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (96, 215, 30), 2)
    if rec:
        cv2.circle(frame, (w - 22, 22), 9, (60, 60, 255), -1)
    if progress > 0:
        cv2.rectangle(frame, (0, h - 6), (int(w * progress), h), (96, 215, 30), -1)
    return frame


class CameraThread:
    """웹캠을 계속 읽어서 최신 프레임을 들고 있고, 보는 사람이 있으면 30fps 로 영상을 보냄"""

    def __init__(self, cap, web):
        self.cap, self.web = cap, web
        self.frame, self.seq = None, 0
        self.cond = threading.Condition()
        self.overlay = (None, "", 0.0, False)  # (관절, 글자, 진행, 녹화중) — App 이 인식할 때마다 바꿈
        self.fps = 0.0

    def start(self):
        threading.Thread(target=self._loop, daemon=True).start()

    def latest(self, after_seq):
        """after_seq 보다 새 프레임이 올 때까지 기다렸다가 (프레임, 번호)"""
        with self.cond:
            self.cond.wait_for(lambda: self.seq > after_seq, timeout=1.0)
            return self.frame, self.seq

    def _loop(self):
        n, at = 0, time.monotonic()
        while True:
            ok, frame = self.cap.read()  # 카메라 속도(30fps)에 맞춰 기다림
            if not ok:
                time.sleep(0.05)
                continue
            with self.cond:
                self.frame, self.seq = frame, self.seq + 1
                self.cond.notify_all()
            if self.web.watching():  # 아무도 안 보면 그리기·압축 안 함 (CPU 아끼기)
                lm, text, progress, rec = self.overlay  # 첫 인식 전엔 lm 이 None
                try:
                    self.web.publish(draw(frame, lm, text, progress, rec))
                except Exception as e:  # 그림 하나 실패했다고 카메라 읽기가 멈추면 인식도 멈춤 → 넘어감
                    print(f"[영상] 그리기 실패 ({e.__class__.__name__}: {e})", flush=True)
            n += 1
            now = time.monotonic()
            if now - at >= 1.0:
                self.fps, n, at = n / (now - at), 0, now


class App:
    """카메라 루프 + 대시보드가 부르는 기능(녹화/학습/삭제)"""

    def __init__(self, cfg, debug=False):
        self.cfg = cfg
        self.debug = debug
        self.cap = open_camera(cfg)
        self.landmarker = Landmarker(use_pose=cfg.get("use_pose", True))
        self.classifier = ActionClassifier()
        self.swipes = SwipeDetector()
        self.stable = Stabilizer(hold=cfg.get("hold_seconds", 1.0), cooldown=cfg.get("cooldown_seconds", 1.5))
        self.mac = MacClient(cfg["mac"])
        self.oled = Oled(cfg)  # OLED 1~3개 (oled.py)
        self.fan = Fan(cfg)  # 뜨거우면 팬 켜기 (fan.py)
        self.web = WebServer(cfg.get("stream_port", 8090), self)
        self.camera = CameraThread(self.cap, self.web)

        self.action, self.prob = None, 0.0  # 이번 프레임 판별 결과
        self.last_sent = ""
        self.seen_at = 0.0  # 마지막으로 사람(손이나 몸)이 보인 시각 — 맥의 자리 비움 감지용
        self.people = None  # 화면에 보이는 사람 수 (5초마다, 상황 엔진의 혼자/여럿)
        self.recording = None  # {"name", "start", "end", "got"}
        self.training = False
        self.message = ""
        self.fps = 0.0

    # ---------- 대시보드가 부르는 것 ----------
    def get_state(self):
        rec = None
        if self.recording:
            now = time.monotonic()
            rec = {"name": self.recording["name"], "countdown": max(0.0, self.recording["start"] - now),
                   "got": self.recording["got"]}
        return {
            "action": self.action, "prob": self.prob, "progress": self.stable.progress,
            "classes": self.classifier.classes, "counts": self.classifier.counts(),
            "recording": rec, "training": self.training, "message": self.message,
            "fps": round(self.fps, 1), "camera_fps": round(self.camera.fps, 1), "last_sent": self.last_sent,
            "temp": None if self.fan.temp is None else round(self.fan.temp, 1), "fan": self.fan.state,
        }

    def start_record(self, name, seconds=5):
        if not name or any(c in name for c in ' "\'<>/'):
            return {"ok": False, "reason": "이름은 띄어쓰기 없이 영어/숫자/_ 로 적어 주세요"}
        if self.recording:
            return {"ok": False, "reason": "이미 녹화 중이에요"}
        now = time.monotonic()
        self.recording = {"name": name, "start": now + COUNTDOWN, "end": now + COUNTDOWN + float(seconds), "got": 0}
        self.message = f"'{name}' 녹화: 3초 뒤 시작"
        return {"ok": True}

    def train(self):
        if self.training:
            return {"ok": False, "reason": "이미 학습 중이에요"}

        def run():
            self.training = True
            try:
                self.message = self.classifier.train()
            except Exception as e:
                self.message = f"학습 실패: {e}"
            self.training = False

        threading.Thread(target=run, daemon=True).start()
        return {"ok": True}

    def delete(self, name):
        self.classifier.delete(name)
        self.message = f"'{name}' 샘플을 지웠어요. 다시 학습하세요."
        return {"ok": True}

    # ---------- OLED / 맥 상태 ----------
    def status_loop(self):
        """OLED 그리기와 맥에 "지금 곡" 묻기는 옆 스레드에서.
        둘 다 느려서(OLED 한 화면 ≈ 0.1초, 맥은 네트워크) 인식 루프 안에 두면 그동안 인식이 멈춰요.
        인식이 자주 돌수록 "1초 유지" 판단이 정확해져요."""
        now_info, next_now_at = {}, 0.0
        next_count_at = 0.0
        lyrics = {"id": None, "ready": True, "lines": None}  # 지금 곡 가사 (곡이 바뀌면 맥에서 새로 받음)
        lyrics_at = 0.0
        while True:
            now = time.monotonic()
            if now >= next_count_at:  # 사람 수는 5초에 한 번 (작은 사진으로)
                next_count_at = now + 5.0
                frame, _ = self.camera.latest(-1)
                if frame is not None:
                    try:
                        small = cv2.resize(frame, (320, int(320 * frame.shape[0] / frame.shape[1])))
                        self.people = self.landmarker.count_people(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
                    except Exception as e:
                        print(f"[사람 수] 못 셈: {e}", flush=True)
                        self.people = None
            if now >= next_now_at:  # 맥 상태는 1초에 한 번만
                next_now_at = now + 1.0
                now_info = self.mac.now(present=now - self.seen_at < 3.0, people=self.people) or {}  # 3초 안에 보였으면 "있음"
                now_info["_at"] = time.monotonic()  # 받은 시각 (OLED 가 곡 진행 바를 그 사이에도 움직이게)
                # 가사: 곡이 바뀌었거나, 맥이 아직 가사를 찾는 중이면(ready=False) 3초마다 다시
                tid = now_info.get("id")
                if tid and (tid != lyrics["id"] or (not lyrics["ready"] and now - lyrics_at > 3)):
                    lyrics_at = now
                    got = self.mac.lyrics()
                    if got and got.get("id") == tid:
                        lyrics = got
                now_info["_lyrics"] = lyrics["lines"] if tid and lyrics["id"] == tid else None
            info = {"temp": self.fan.temp, "fan": self.fan.state, "fps": self.fps, "present": now - self.seen_at < 3.0}
            self.oled.show(now_info, self.last_sent, self.stable.candidate, self.stable.progress, info)
            time.sleep(0.1)

    # ---------- 카메라 루프 ----------
    def run(self):
        self.web.start()
        self.camera.start()
        self.fan.start()
        threading.Thread(target=self.status_loop, daemon=True).start()
        print(f"[시작] 맥: {self.cfg['mac']}  (Ctrl+C 로 종료)", flush=True)
        frames, fps_at = 0, time.monotonic()
        seq = 0
        while True:
            frame, new_seq = self.camera.latest(seq)  # 인식하는 동안 쌓인 프레임은 건너뛰고 가장 최신 것
            if frame is None or new_seq == seq:
                continue
            seq = new_seq
            now = time.monotonic()

            # 2) 관절 좌표
            lm = self.landmarker.detect(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            if lm.hand or lm.pose:
                self.seen_at = now
            center, size = palm(lm, frame.shape[1] / frame.shape[0])  # 손바닥 가운데·손 크기 (스와이프용)

            # 녹화 중이면 판별 대신 샘플만 모음
            rec = self.recording
            if rec:
                if now >= rec["end"]:
                    self.message = (f"'{rec['name']}' {rec['got']}개 녹화 완료 → [학습하기]" if rec["got"]
                                    else "손이나 몸이 안 보여서 하나도 못 모았어요. 카메라 앞에 서서 다시 녹화해 주세요.")
                    self.recording = None
                elif now >= rec["start"] and (lm.hand or lm.pose):
                    self.classifier.add_sample(rec["name"], lm)
                    rec["got"] += 1
                self.camera.overlay = (lm, f"REC {rec['name']}", 0.0, now >= rec["start"])
                frames += 1
                continue

            # 3) 스와이프 — 쿨다운 중이 아니면 바로 보냄
            swipe = self.swipes.update(center, now, size)
            if swipe and not self.stable.in_cooldown(now):
                self.mac.send(swipe)
                self.stable.fired(swipe, now)
                self.last_sent = swipe

            # 4) scikit-learn 판별 (손을 크게 움직이는 중이면 쉼)
            self.action, self.prob = (None, 0.0) if self.swipes.moving else self.classifier.predict(lm)

            # 5) 오작동 방지 통과하면 보냄
            confirmed = self.stable.update(self.action, now)
            if confirmed:
                self.mac.send(confirmed)
                self.last_sent = confirmed

            # 6) 화면에 덧그릴 것 (OLED 는 status_loop 가 따로 그려요)
            self.camera.overlay = (lm, self.stable.candidate or self.action, self.stable.progress, False)

            frames += 1
            if now - fps_at >= 1.0:
                self.fps, frames, fps_at = frames / (now - fps_at), 0, now
                if self.debug:
                    print(f"[상태] 인식 {self.fps:4.1f}fps / 영상 {self.camera.fps:4.1f}fps  손={'O' if lm.hand else '-'} 몸={'O' if lm.pose else '-'}"
                          f"  동작={self.action}({self.prob:.0%})  진행={self.stable.progress:.0%}", flush=True)

    def close(self):
        self.fan.close()
        self.cap.release()
        self.landmarker.close()


def exit_with_parent():
    """맥 노치 앱이 켠 경우: 앱이 꺼지면(갑자기 죽어도) 같이 꺼져서 카메라 불이 계속 켜져 있지 않게"""
    parent = os.getppid()

    def watch():
        while os.getppid() == parent:
            time.sleep(1.0)
        os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


def main():
    if os.environ.get("GESTURE_HOME"):
        exit_with_parent()
    ap = argparse.ArgumentParser()
    ap.add_argument("--debug", action="store_true", help="1초마다 상태 출력")
    cfg = load_config()
    updater.start(cfg)  # 깃허브에 새 버전이 있으면 스스로 바꾸고 다시 켬 (파이 서비스일 때만)
    app = App(cfg, debug=ap.parse_args().debug)
    try:
        app.run()
    except KeyboardInterrupt:
        print("\n[종료]")
    finally:
        app.close()


if __name__ == "__main__":
    main()
