"""
stabilize.py — 오작동 방지 (기획서: 다수결, 1~2초 유지, 전환 후 쿨다운)
============================================================
손 모양은 프레임마다 조금씩 흔들려서 그대로 보내면 엉뚱한 곡이 틀어져요. 그래서:

  1) 다수결 : 최근 결과 중 70% 이상이 같은 이름이어야 후보
  2) 유지   : 그 후보가 hold 초 동안 계속 이어져야 확정
  3) 한 번만 : 같은 자세를 계속 하고 있어도 한 번만 보냄. 손을 내리거나 다른 자세로 바꿔야 다시 보냄
  4) 쿨다운 : 뭔가 보낸 뒤 cooldown 초 동안은 아무것도 안 보냄

progress (0~1) 는 지금 후보가 얼마나 찼는지 — OLED 진행 바에 써요.
"""

import time
from collections import Counter, deque

MAJORITY = 0.7


class Stabilizer:
    def __init__(self, hold=1.0, cooldown=1.5):
        self.hold = hold
        self.cooldown = cooldown
        self.samples = deque()  # (시각, 이름 또는 None)
        self.latched = None  # 방금 보낸 자세 (손을 바꿀 때까지 다시 안 보냄)
        self.quiet_until = 0.0
        self.candidate = None
        self.progress = 0.0

    def update(self, name, now=None):
        """한 프레임의 판정 결과를 넣으면, 확정된 이름 또는 None"""
        now = now or time.monotonic()
        self.samples.append((now, name))
        while self.samples and now - self.samples[0][0] > self.hold * 1.2:
            self.samples.popleft()

        counts = Counter(n for _, n in self.samples if n)
        self.candidate, self.progress = None, 0.0
        if not counts:
            self.latched = None  # 손을 내렸으면 다시 보낼 수 있게
            return None
        cand, same = counts.most_common(1)[0]
        share = same / len(self.samples)
        if cand != self.latched:
            # 지금 후보가 아닌 다른 자세였다면 래치 풀기
            if self.latched and counts.get(self.latched, 0) / len(self.samples) < 0.3:
                self.latched = None
        if share < MAJORITY or cand == self.latched:
            return None

        span = now - self.samples[0][0]
        self.candidate, self.progress = cand, min(1.0, span / self.hold)
        if span >= self.hold and now >= self.quiet_until:
            self.fired(cand, now)
            return cand
        return None

    def fired(self, name, now=None):
        """뭔가 보냈음 (스와이프 포함) → 쿨다운 시작"""
        now = now or time.monotonic()
        self.latched = name
        self.quiet_until = now + self.cooldown
        self.samples.clear()
        self.progress = 0.0

    def in_cooldown(self, now=None):
        return (now or time.monotonic()) < self.quiet_until
