"""
swipe.py — 손바닥이 빠르게 한쪽으로 움직이면 스와이프 (기획서 2번)
============================================================
  오른쪽 → swipe_right (다음 곡)   왼쪽 → swipe_left (이전 곡)
  위    → swipe_up    (볼륨 +)    아래 → swipe_down (볼륨 −)

손바닥 가운데 좌표를 최근 WINDOW 초 동안 모아두고, 그 안에서 "가장 멀리 온 구간"을 봐요.
그 구간이 아래 조건을 다 채우면 스와이프:

  1) 충분히 멀리 : 손 크기의 HANDS 배 이상 (카메라에서 멀면 손도 작고 움직임도 작게 찍히니까, 화면 비율이 아니라 손 크기로 재요)
                   단, 화면 높이의 MIN_DIST ~ MAX_DIST 사이로 맞춤
  2) 곧게        : 처음→끝 직선 거리 ÷ 실제 지나간 길이 ≥ STRAIGHT (구불구불하거나 왔다갔다 한 건 아님)
  3) 한 방향으로 : 주 방향이 다른 방향보다 RATIO 배 이상 (대각선 무시)
  4) 충분히 빠르게 : 손 크기 기준 초당 SPEED 배 이상 (천천히 자리를 옮긴 건 아님)

떨림 줄이기
  · 좌표를 조금 부드럽게 (SMOOTH: 새 좌표를 이 비율만큼만 반영) — 관절 좌표는 장면마다 조금씩 튀어요
  · 한 장면에 말도 안 되게 멀리 뛰면(JUMP) 다른 손을 잡은 것 → 처음부터

좌표는 가로·세로가 같은 단위(화면 높이 = 1)여야 해요. 아래 palm() 이 그렇게 만들어 줘요.

그 밖의 규칙
  REST    한 번 인식하고 이 시간 동안은 쉼 (초)
  BACK    스와이프 뒤 이 시간(초) 동안은 "반대 방향"을 안 받음 — 손을 제자리로 되돌리는 동작이 반대 스와이프로 잡히지 않게
          (같은 방향은 REST 만 지나면 또 돼요: 다음 곡, 다음 곡 …)
  SETTLE  손이 화면에 나타나고 이 시간(초)이 지난 뒤의 움직임만 봄
          — 동작을 하려고 손을 들어 올리는 것이 "위로 스와이프(볼륨 +)"로 잡히지 않게
  GAP     손이 이 시간(초)보다 짧게 안 보인 건 "계속 보인 것"으로 침 (인식이 한두 장 놓쳐도 스와이프가 끊기지 않게)
"""

import math
import time
from collections import deque

WINDOW = 0.7
HANDS = 3.0
MIN_DIST = 0.16
MAX_DIST = 0.32
STRAIGHT = 0.8
RATIO = 1.6
SPEED = 5.0
SMOOTH = 0.7
JUMP = 0.6
REST = 0.9
BACK = 1.8
OPPOSITE = {"swipe_left": "swipe_right", "swipe_right": "swipe_left", "swipe_up": "swipe_down", "swipe_down": "swipe_up"}
SETTLE = 0.5
GAP = 0.35


def palm(lm, aspect):
    """관절 좌표 → (손바닥 가운데 (x, y), 손 크기). 손이 안 보이면 (None, None)
    x 에 화면 비율(가로/세로)을 곱해서 가로·세로를 같은 단위(화면 높이 = 1)로 맞춰요.
    손 크기 = 손목 ~ 중지 뿌리 길이"""
    if not lm.hand:
        return None, None
    (x0, y0, _), (x9, y9, _) = lm.hand[0], lm.hand[9]
    return ((x0 + x9) / 2 * aspect, (y0 + y9) / 2), math.hypot((x9 - x0) * aspect, y9 - y0) or 1e-6


class SwipeDetector:
    def __init__(self):
        self.path = deque()  # (시각, x, y) — 부드럽게 한 좌표
        self.rest_until = 0.0
        self.seen_since = None  # 손이 화면에 나타난 시각
        self.last_seen = 0.0
        self.smooth = None  # 부드럽게 한 지금 위치
        self.need = MAX_DIST  # 지금 손 크기에서 필요한 거리
        self.last = None  # 마지막 스와이프 이름
        self.last_at = 0.0

    def update(self, center, now=None, size=None):
        """한 프레임마다 부름. center = 손바닥 가운데 (x, y) 또는 None, size = 손 크기. 스와이프면 이름, 아니면 None"""
        now = now or time.monotonic()
        if center is None:
            if now - self.last_seen > GAP:  # 손이 정말 사라짐 → 처음부터
                self.clear()
                self.seen_since = None
            return None
        if self.seen_since is None:
            self.seen_since = now
        self.last_seen = now
        x, y = center
        if self.smooth and math.hypot(x - self.smooth[0], y - self.smooth[1]) > JUMP:
            self.clear()  # 다른 손으로 건너뜀
            self.seen_since = now
        if self.smooth is None:
            self.smooth = (x, y)
        else:
            self.smooth = (self.smooth[0] + (x - self.smooth[0]) * SMOOTH, self.smooth[1] + (y - self.smooth[1]) * SMOOTH)
        if now - self.seen_since < SETTLE:  # 방금 들어온 손: 들어 올리는 중일 수 있으니 아직 안 봄
            return None
        x, y = self.smooth
        self.path.append((now, x, y))
        while now - self.path[0][0] > WINDOW:
            self.path.popleft()
        self.need = min(MAX_DIST, max(MIN_DIST, HANDS * size)) if size else MAX_DIST
        if now < self.rest_until or len(self.path) < 3:
            return None

        # 지금 위치에서 가장 멀리 떨어진 "출발점"을 찾음 (그 앞의 가만히 있던 시간은 빼고 보려고)
        pts = list(self.path)
        start = max(range(len(pts) - 2), key=lambda i: math.hypot(x - pts[i][1], y - pts[i][2]))
        seg = pts[start:]
        dx, dy = x - seg[0][1], y - seg[0][2]
        dist = math.hypot(dx, dy)
        length = sum(math.hypot(b[1] - a[1], b[2] - a[2]) for a, b in zip(seg, seg[1:]))
        took = max(now - seg[0][0], 1e-6)
        if dist < self.need or dist < length * STRAIGHT or (size and dist / took < SPEED * size):
            return None
        name = None
        if abs(dx) > abs(dy) * RATIO:
            name = "swipe_right" if dx > 0 else "swipe_left"
        elif abs(dy) > abs(dx) * RATIO:
            name = "swipe_down" if dy > 0 else "swipe_up"  # 화면 y 는 아래로 갈수록 커짐
        if name and self.last and name == OPPOSITE[self.last] and now - self.last_at < BACK:
            self.path.clear()  # 방금 쓸고 손을 되돌리는 중
            return None
        if name:
            self.last, self.last_at = name, now
            self.path.clear()
            self.rest_until = now + REST
        return name

    def clear(self):
        self.path.clear()
        self.smooth = None

    @property
    def moving(self):
        """지금 손이 크게 움직이는 중인지 — 움직이는 동안엔 손 모양 판정을 쉬어요"""
        if len(self.path) < 2:
            return False
        dx = abs(self.path[-1][1] - self.path[0][1])
        dy = abs(self.path[-1][2] - self.path[0][2])
        return max(dx, dy) > self.need * 0.5
