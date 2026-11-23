"""
fan.py — 라즈베리파이가 뜨거우면 팬 켜기
============================================================
CPU 온도를 5초마다 보고
  FAN_ON(65°C) 이상이면 켜고, FAN_OFF(55°C) 이하로 내려가면 끔.
  켜고 끄는 온도를 10도 벌려 둔 건, 60도 근처에서 팬이 1초마다 켜졌다 꺼졌다 하지 않게 하려고.
  한 번 켜면 적어도 MIN_ON 초는 돌려요.

파이는 80°C 가 넘으면 스스로 느려져요(쓰로틀링) → 인식이 덜 자주 돌아서 제스처를 놓쳐요.

연결 (banner/fan-wiring.png 도면 참고)
  GPIO 핀은 3.3V·아주 약한 전류라서 팬을 바로 돌리지 못해요. 트랜지스터(스위치)를 사이에 둬야 해요.
    파이 5V(4번 핀) ── 팬 + (빨강)
    팬 − (검정)     ── 트랜지스터 C(컬렉터)
    트랜지스터 E    ── 파이 GND(14번 핀)  (6번은 OLED 가 씀)
    트랜지스터 B    ── 1kΩ 저항 ── 파이 GPIO18(12번 핀)
  팬 선을 5V·GND 에 바로 꽂으면 늘 돌아요 (이 코드로 켜고 끌 수 없음, 그래도 식는 데는 충분).

config.json
  "fan": true          켜고 끄기 사용 (맥북에선 자동으로 꺼짐)
  "fan_pin": 18        BCM 번호 (18 = 12번 핀. 14번은 우분투가 시리얼 콘솔로 쓸 수 있어서 피함)
  "fan_on": 65, "fan_off": 55
"""

import sys
import threading
import time
from pathlib import Path

TEMP = Path("/sys/class/thermal/thermal_zone0/temp")
MIN_ON = 30  # 한 번 켜면 적어도 이만큼(초)은 돌림
EVERY = 5  # 온도를 보는 간격 (초)


def cpu_temp():
    """CPU 온도 (°C) 또는 None (맥처럼 읽을 수 없는 곳)"""
    try:
        return int(TEMP.read_text()) / 1000
    except (OSError, ValueError):
        return None


class _Pin:
    """GPIO 핀 하나를 켜고 끄기. 깔려 있는 라이브러리 중 되는 걸로 (gpiod → lgpio → RPi.GPIO)"""

    def __init__(self, bcm):
        self.set = None
        errors = []
        for make in (self._gpiod, self._lgpio, self._rpi):
            try:
                self.set = make(bcm)
                self.set(False)
                self.how = make.__name__.strip("_")
                return
            except Exception as e:  # 그 라이브러리가 없거나 핀을 못 잡음 → 다음 것
                errors.append(f"{make.__name__.strip('_')}: {e.__class__.__name__}")
        raise RuntimeError(", ".join(errors))

    @staticmethod
    def _gpiod(bcm):
        import gpiod
        from gpiod.line import Direction, Value

        req = gpiod.request_lines("/dev/gpiochip0", consumer="gesture-fan",
                                  config={bcm: gpiod.LineSettings(direction=Direction.OUTPUT)})
        return lambda on: req.set_value(bcm, Value.ACTIVE if on else Value.INACTIVE)

    @staticmethod
    def _lgpio(bcm):
        import lgpio

        h = lgpio.gpiochip_open(0)
        lgpio.gpio_claim_output(h, bcm)
        return lambda on: lgpio.gpio_write(h, bcm, 1 if on else 0)

    @staticmethod
    def _rpi(bcm):
        import RPi.GPIO as GPIO

        GPIO.setmode(GPIO.BCM)
        GPIO.setup(bcm, GPIO.OUT)
        return lambda on: GPIO.output(bcm, on)


class Fan:
    def __init__(self, cfg):
        self.on_at = float(cfg.get("fan_on", 65))
        self.off_at = float(cfg.get("fan_off", 55))
        self.pin = None
        self.running = False
        self.since = 0.0
        self.temp = cpu_temp()
        if not cfg.get("fan", sys.platform.startswith("linux")) or self.temp is None:
            return
        bcm = int(cfg.get("fan_pin", 18))
        try:
            self.pin = _Pin(bcm)
            print(f"[팬] GPIO{bcm} 로 켜고 끔 ({self.on_at:.0f}°C 이상 켬, {self.off_at:.0f}°C 이하 끔, {self.pin.how})", flush=True)
        except RuntimeError as e:
            print(f"[팬] 핀을 못 잡았어요 — 온도만 보여줘요 ({e})", flush=True)

    @property
    def state(self):
        """화면 표시용: 'on' / 'off' / None(팬 조절 안 함)"""
        return None if self.pin is None else ("on" if self.running else "off")

    def start(self):
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            self.temp = cpu_temp()
            if self.pin and self.temp is not None:
                now = time.monotonic()
                if not self.running and self.temp >= self.on_at:
                    self._switch(True, now)
                elif self.running and self.temp <= self.off_at and now - self.since >= MIN_ON:
                    self._switch(False, now)
            time.sleep(EVERY)

    def _switch(self, on, now):
        try:
            self.pin.set(on)
        except Exception as e:
            print(f"[팬] 켜고 끄기 실패 ({e.__class__.__name__}) — 그만둘게요", flush=True)
            self.pin = None
            return
        self.running, self.since = on, now
        print(f"[팬] {'켬' if on else '끔'} ({self.temp:.0f}°C)", flush=True)

    def close(self):
        if self.pin:
            try:
                self.pin.set(False)
            except Exception:
                pass
