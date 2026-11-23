"""
case.py — OLED 3개를 세로로 쌓은 "서브모니터" 케이스 (3D 프린터용)
============================================================
만드는 것 (case/ 폴더에 STL)
  1-body.stl     몸통: 앞판(화면 창 3개) + OLED 끼우는 칸 + 아래 턱(받침대 꽂는 구멍)
  2-cover.stl    뒤뚜껑: 끼워 닫음. 안쪽 기둥이 OLED 를 앞으로 눌러 고정, 아래쪽에 선 나가는 구멍
  3-stand.stl    받침대: 바닥판 + 목 (몸통 아래 구멍에 꽂음, 8도 뒤로 기울어짐)
  0-test-fit.stl 칸 하나짜리 시험 조각 — 먼저 이걸 뽑아서 OLED 가 맞는지 확인 (10분 정도)

뽑는 방향 (STL 이 이미 이 방향으로 놓여 있어요)
  몸통: 앞면이 바닥 / 뚜껑: 바깥면이 바닥 / 받침대: 바닥판이 바닥 → 서포트 없이 뽑혀요
  PLA, 레이어 0.2mm, 벽 3줄, 채움 20% 면 충분

OLED 모듈마다 크기가 조금씩 달라요. 캘리퍼스로 재서 아래 "치수"를 고치고 다시 실행하세요:
  python case.py          → STL 4개 + viewer.html (브라우저로 열어서 돌려 보기)
필요한 것: pip install manifold3d trimesh numpy
"""

import math
import sys
from pathlib import Path

import numpy as np
from manifold3d import CrossSection, JoinType, Manifold, set_circular_segments

set_circular_segments(72)
OUT = Path(__file__).parent

# ---------------- 치수 (mm) ----------------
# 0.96" SSD1306 I2C 4핀 모듈 도면 기준 (판 27.3±0.5 정사각, 유리 26.7 x 19.26, 빛나는 곳 21.74 x 10.86)
PCB_W, PCB_H = 27.3, 27.3  # OLED 모듈 판 (가로, 세로). 핀이 위쪽
PCB_T = 1.0  # 판 두께
GLASS = 1.4  # 판 앞면 ~ 유리 앞면 높이 (도면: 유리+테이프 1.37, 판 포함 2.37)
CLEAR = 0.4  # 판 둘레 여유 (한쪽) → 칸 28.1: 27.8 짜리 판까지 들어감
VIEW_W, VIEW_H = 24.0, 13.0  # 화면 창 (보이는 곳 23.94 x 12.06 와 같음, 빛나는 곳보다 한쪽 1mm 넓음)
VIEW_FROM_BOTTOM = 15.4  # 판 아래 모서리 ~ 빛나는 곳 가운데 (27.3 - 4.02 - 2.44 - 10.86/2). 세워 두면 판이 칸 바닥에 얹힘
HOLE_X, HOLE_Y = 3.3, 2.05  # 판 모서리 ~ 나사 구멍 가운데 (구멍 간격 20.7 x 23.2) — 뚜껑 기둥이 여길 누름
CHAMFER = 0.8  # 화면 창 앞쪽 모서리 비스듬히

FRONT = 1.6  # 앞판 두께
WALL = 2.0  # 옆벽 두께
SIDE = 4.2  # 좌우 베젤 (판 칸 바깥 ~ 몸통 바깥)
TOP = 5.0  # 위 베젤
RIB = 3.4  # 화면 사이 칸막이
CHIN = 16.0  # 아래 턱 (받침대 구멍이 들어감)
DEPTH = 28.0  # 몸통 깊이 (뚜껑 빼고). 판 뒤 핀(2.5+6) + 듀폰 소켓(14) + 선 꺾이는 곳 ≈ 24mm 가 들어가게
RADIUS = 4.0  # 앞에서 본 모서리 둥글기

COVER_T = 2.0  # 뚜껑 두께
LIP = 3.0  # 뚜껑 턱(몸통 안으로 들어가는 부분) 깊이
LIP_T = 1.6  # 뚜껑 턱 두께
FIT = 0.2  # 끼우는 곳 여유 (한쪽). 너무 빡빡하면 0.25, 헐거우면 0.15
PRESS_GAP = 0.1  # 뚜껑 기둥 끝 ~ OLED 판 뒷면
PILLAR = 3.4  # 뚜껑 기둥 끝 (판을 누르는 곳) 굵기
RIB_T = 2.0  # 기둥을 잇는 세로 벽 두께 (가는 기둥만 있으면 뽑다가 흔들려서)
RIB_GAP = 2.0  # 세로 벽 ~ OLED 판 뒷면 (뒤 부품 1.5mm 를 피함)
CRUSH = 0.25  # 뚜껑 턱의 작은 돌기 높이 (살짝 눌리면서 꽉 물림)
EDGE = 0.6  # 바깥 모서리 깎기 (첫 층이 퍼지는 '코끼리 발'을 가림)
SAG = 0.2  # 다리(브리지) 처짐 여유
SLOT_W, SLOT_H = 15.0, 8.0  # 선 나가는 구멍: 화면마다 핀 바로 뒤에 하나씩 (듀폰 4가닥 = 10.2mm)
HEAD = 1.4  # 칸 위쪽 여유: OLED 를 위로 밀어 넣었다가 아래로 내려 거는 만큼
CATCH_LOW, CATCH_HIGH = 0.7, 2.2  # 걸림턱이 판 뒤를 덮는 깊이 (아래, 위). 위는 HEAD 만큼 내려가도 0.8 이 남음
CATCH_W = 7.0  # 걸림턱 가로 (칸 양쪽 귀퉁이. 가운데는 핀·부품 자리)
CATCH_GAP = 0.2  # 판 뒷면 ~ 걸림턱
PCB_MAX = 0.5  # 판 세로가 이만큼 더 커도 (27.8) 들어가게

NECK_W, NECK_T = 16.0, 6.0  # 받침대 목 단면
NECK_IN = 11.0  # 목이 몸통에 들어가는 깊이
NECK_FIT = 0.25  # 목 구멍 여유 (한쪽)
TILT = 8.0  # 뒤로 기울기 (도)
LIFT = 14.0  # 바닥판 위 ~ 몸통 아래 틈
BASE_W, BASE_T = 64.0, 4.0  # 바닥판 가로, 두께
BASE_R = 8.0

# 파생 치수
PW, PH = PCB_W + 2 * CLEAR, PCB_H + HEAD  # 판 칸 (판은 칸 바닥에 얹힘, 위로 HEAD 만큼 남음)
W = 2 * SIDE + PW
H = TOP + 3 * PH + 2 * RIB + CHIN
FRAME_Z = FRONT + GLASS + PCB_T + 1.0  # 판 칸 벽 끝 (판이 칸 안에 다 들어가게)
PCB_BACK = FRONT + GLASS + PCB_T  # OLED 판 뒷면 위치


def rrect(w, h, r, x=0.0, y=0.0):
    """모서리가 둥근 사각형 (왼쪽 아래가 x, y)"""
    r = min(r, w / 2 - 0.01, h / 2 - 0.01)
    if r <= 0.01:
        return CrossSection.square([w, h]).translate([x, y])
    dots = [CrossSection.circle(r).translate([x + cx, y + cy])
            for cx in (r, w - r) for cy in (r, h - r)]
    return CrossSection.batch_hull(dots)


def box(x0, y0, z0, x1, y1, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])


def slab(section, z0, z1):
    return section.extrude(z1 - z0).translate([0, 0, z0])


def plate(section, z0, z1, low=0.0, high=0.0):
    """볼록한 단면을 z0~z1 로 세우되, 아래(low)·위(high) 모서리를 그만큼 비스듬히 깎음"""
    layers = []
    if low:
        layers.append(slab(section.offset(-low, JoinType.Round), z0, z0 + 0.01))
    layers.append(slab(section, z0 + low, z1 - high))
    if high:
        layers.append(slab(section.offset(-high, JoinType.Round), z1 - 0.01, z1))
    return Manifold.batch_hull(layers)


def pocket_top(i):
    """i 번째 칸(0 = 맨 위)의 위쪽 끝 y"""
    return H - TOP - i * (PH + RIB)


# ---------------- 걸림턱: 뚜껑 없이도 OLED 가 칸에서 안 빠지게 ----------------
def catch_spots(px, py):
    """칸(왼쪽 아래가 px, py)의 걸림턱 4개: (x0, x1, 벽 y, 튀어나오는 방향, 깊이)"""
    spots = []
    for x0 in (px, px + PW - CATCH_W):
        spots.append((x0, x0 + CATCH_W, py, 1, CATCH_LOW))  # 아래: 칸 바닥(선반)에서 위로
        spots.append((x0, x0 + CATCH_W, py + PH, -1, CATCH_HIGH))  # 위: 칸 천장에서 아래로
    return spots


def catches(px, py):
    """밑면이 45도로 비스듬한 턱 (앞면을 바닥에 놓고 뽑을 때 서포트 없이 나옴)"""
    part = Manifold()
    for x0, x1, yw, d, depth in catch_spots(px, py):
        z0 = PCB_BACK + CATCH_GAP
        if d < 0:  # 위 턱: 벽 쪽은 판보다 앞에서 시작 (거긴 판이 없는 빈 자리) → 판 위 끝에서 딱 판 뒷면 높이가 됨
            z0 -= HEAD - PCB_MAX
        z1 = z0 + depth + 0.8
        at_wall = box(x0, min(yw, yw + d * 0.01), z0, x1, max(yw, yw + d * 0.01), z1)
        tip = yw + d * depth
        at_tip = box(x0, min(tip, tip - d * 0.01), z0 + depth, x1, max(tip, tip - d * 0.01), z1)
        root = box(x0, min(yw, yw - d * 1.5), FRAME_Z - 0.01, x1, max(yw, yw - d * 1.5), z1)  # 칸막이 위로 이어지는 뿌리
        part += Manifold.batch_hull([at_wall, at_tip]) + root
    return part


def catch_room(px, py, margin=0.4):
    """걸림턱이 차지하는 자리 (뚜껑 벽·발이 여길 피함)"""
    part = Manifold()
    for x0, x1, yw, d, depth in catch_spots(px, py):
        y_in, y_out = yw + d * (depth + margin), yw - d * 1.5
        part += box(x0 - margin, min(y_in, y_out), PCB_BACK, x1 + margin, max(y_in, y_out), PCB_BACK + CATCH_GAP + depth + 0.8 + margin)
    return part


# ---------------- 몸통 ----------------
def body():
    shell = plate(rrect(W, H, RADIUS), 0, DEPTH, low=EDGE)  # 앞면(바닥에 닿는 면) 모서리를 깎음
    cavity = slab(rrect(W - 2 * WALL, H - WALL - CHIN, RADIUS - WALL, WALL, CHIN), FRONT, DEPTH + 1)
    part = shell - cavity
    # OLED 칸: 앞판 뒤에 판(PCB) 크기 칸 3개가 뚫린 칸막이
    frame = slab(CrossSection.square([W - 2 * WALL, H - WALL - CHIN]).translate([WALL, CHIN]), FRONT - 0.01, FRAME_Z)
    for i in range(3):
        frame -= box(SIDE, pocket_top(i) - PH, FRONT - 1, SIDE + PW, pocket_top(i), FRAME_Z + 1)
    part += frame
    for i in range(3):
        part += catches(SIDE, pocket_top(i) - PH)
    # 화면 창: 앞쪽이 조금 넓게 (비스듬한 모서리)
    for i in range(3):
        cx, cy = W / 2, pocket_top(i) - PH + VIEW_FROM_BOTTOM
        inner = box(cx - VIEW_W / 2, cy - VIEW_H / 2, FRONT - 0.3, cx + VIEW_W / 2, cy + VIEW_H / 2, FRONT + 0.5)
        outer = box(cx - VIEW_W / 2 - CHAMFER, cy - VIEW_H / 2 - CHAMFER, -0.5,
                    cx + VIEW_W / 2 + CHAMFER, cy + VIEW_H / 2 + CHAMFER, -0.49)
        part -= Manifold.batch_hull([inner, outer])
    # 아래 턱: 받침대 목이 들어가는 구멍
    nx, nz = NECK_W / 2 + NECK_FIT, NECK_T / 2 + NECK_FIT
    part -= box(W / 2 - nx, -1, DEPTH / 2 - nz, W / 2 + nx, NECK_IN, DEPTH / 2 + nz + SAG)  # 천장은 다리로 뽑혀서 조금 처짐
    return part


# ---------------- 뒤뚜껑 (몸통과 같은 좌표: 바깥면이 z = DEPTH + COVER_T) ----------------
def cover():
    part = plate(rrect(W, H, RADIUS), DEPTH, DEPTH + COVER_T, high=EDGE)
    # 턱: 몸통 안으로 들어감. 끝을 비스듬히 깎아 잘 들어가게
    cw, ch = W - 2 * WALL - 2 * FIT, H - WALL - CHIN - 2 * FIT
    outer = rrect(cw, ch, RADIUS - WALL, WALL + FIT, CHIN + FIT)
    inner = rrect(cw - 2 * LIP_T, ch - 2 * LIP_T, RADIUS - WALL - LIP_T, WALL + FIT + LIP_T, CHIN + FIT + LIP_T)
    part += plate(outer, DEPTH - LIP, DEPTH + 0.01, low=0.5) - slab(inner, DEPTH - LIP - 1, DEPTH)
    # 작은 돌기: 턱 옆에 세로로 6줄. 몸통 벽에 살짝 눌리면서 뚜껑이 안 빠짐
    for y in (CHIN + ch * 0.2, CHIN + ch * 0.5, CHIN + ch * 0.8):
        for x0, x1 in ((WALL + FIT - CRUSH, WALL + FIT + 0.1), (W - WALL - FIT - 0.1, W - WALL - FIT + CRUSH)):
            part += box(x0, y - 0.6, DEPTH - LIP + 0.8, x1, y + 0.6, DEPTH + 0.01)
    # 세로 벽 2줄 + 그 끝의 누름 발: OLED 판의 나사 구멍 자리를 앞으로 누름. 벽 사이는 선이 지나가는 길
    y_lo = CHIN + HOLE_Y - PILLAR / 2  # 3번 칸 바닥의 아래 발
    y_hi = pocket_top(0) - PH + PCB_H - HOLE_Y + PILLAR / 2
    for x in (SIDE + CLEAR + HOLE_X, SIDE + CLEAR + PCB_W - HOLE_X):
        part += box(x - RIB_T / 2, y_lo, PCB_BACK + RIB_GAP, x + RIB_T / 2, y_hi, DEPTH + 0.01)
        for i in range(3):
            bottom = pocket_top(i) - PH  # 판이 칸 바닥에 얹힘
            for y in (bottom + HOLE_Y, bottom + PCB_H - HOLE_Y):
                foot = box(x - PILLAR / 2, y - PILLAR / 2, PCB_BACK + PRESS_GAP, x + PILLAR / 2, y + PILLAR / 2, PCB_BACK + PRESS_GAP + 0.8)
                neck = box(x - RIB_T / 2, y - PILLAR / 2, PCB_BACK + RIB_GAP, x + RIB_T / 2, y + PILLAR / 2, PCB_BACK + RIB_GAP + 0.01)
                part += Manifold.batch_hull([foot, neck])  # 벽에서 발로 비스듬히 넓어짐 (서포트 없이)
    for i in range(3):
        part -= catch_room(SIDE, pocket_top(i) - PH)  # 몸통 걸림턱 자리는 비움
        # 선 나가는 구멍: 화면마다 핀 바로 뒤 (조금 아래로, 선이 처지는 쪽)
        pin_y = pocket_top(i) - PH + PCB_H - HOLE_Y
        part -= box(W / 2 - SLOT_W / 2, pin_y - SLOT_H / 2 - 2.0, DEPTH - 1, W / 2 + SLOT_W / 2, pin_y + SLOT_H / 2 - 2.0, DEPTH + COVER_T + 1)
    # 손톱 홈 (위쪽 가장자리, 뚜껑 열 때)
    part -= box(W / 2 - 6, H - 1.2, DEPTH + COVER_T - 1.0, W / 2 + 6, H + 1, DEPTH + COVER_T + 1)
    return part


# ---------------- 몸통 → 책상 위 자리 (받침대 좌표: z 위, y 뒤) ----------------
def placed(m):
    """몸통 좌표(X 오른쪽, Y 위, Z 뒤)의 모양을 받침대 위에 세운 자리로"""
    t = math.radians(TILT)
    # (X, Y, Z) → x = X - W/2, y = Z - DEPTH/2, z = Y   → x 축으로 TILT 만큼 뒤로 눕힘 → 들어 올림
    to_world = [[1, 0, 0, -W / 2], [0, 0, 1, -DEPTH / 2], [0, 1, 0, 0]]
    tilt = [[1, 0, 0, 0], [0, math.cos(t), math.sin(t), 0], [0, -math.sin(t), math.cos(t), 0]]
    return m.transform(to_world).transform(tilt).translate([0, 0, BASE_T + LIFT / math.cos(t)])


def stand():
    tip = NECK_IN - 0.3
    neck_local = Manifold.batch_hull([  # 끝을 조금 깎아서 구멍에 잘 들어가게
        box(W / 2 - NECK_W / 2, -80, DEPTH / 2 - NECK_T / 2, W / 2 + NECK_W / 2, tip - 1.0, DEPTH / 2 + NECK_T / 2),
        box(W / 2 - NECK_W / 2 + 0.6, tip - 0.01, DEPTH / 2 - NECK_T / 2 + 0.6, W / 2 + NECK_W / 2 - 0.6, tip, DEPTH / 2 + NECK_T / 2 - 0.6)])
    neck = placed(neck_local).trim_by_plane([0, 0, 1], 0.0)
    # 목 밑동을 두툼하게 (부러지지 않게)
    foot = neck.slice(BASE_T + 10)
    root = Manifold.batch_hull([slab(foot, BASE_T + 10, BASE_T + 10.01),
                                slab(foot.offset(4.0, JoinType.Round), 0, BASE_T + 0.01)])
    # 바닥판: 몸통 무게중심이 가운데쯤 오게
    (bx0, by0, _), (bx1, by1, _) = placed(body()).bounding_box()[:3], placed(body()).bounding_box()[3:]
    front, back = by0 - 8, by1 + 16
    base = plate(rrect(BASE_W, back - front, BASE_R, -BASE_W / 2, front), 0, BASE_T, low=0.4, high=1.0)
    return base + root + neck


# ---------------- 시험 조각 (칸 하나) ----------------
def test_fit():
    w, h = PW + 2 * 3.0, PH + 2 * 3.0
    part = slab(rrect(w, h, 2.0), 0, FRAME_Z)
    part -= box(3.0, 3.0, FRONT, 3.0 + PW, 3.0 + PH, FRAME_Z + 1)
    part += catches(3.0, 3.0)
    cx, cy = w / 2, 3.0 + VIEW_FROM_BOTTOM
    part -= box(cx - VIEW_W / 2, cy - VIEW_H / 2, -1, cx + VIEW_W / 2, cy + VIEW_H / 2, FRONT + 1)
    part -= box(w / 2 - 2, h - 1.0, FRAME_Z - 0.6, w / 2 + 2, h + 1, FRAME_Z + 1)  # 위쪽(핀 쪽) 표시 홈
    return part


def to_trimesh(m):
    import trimesh

    mesh = m.to_mesh()
    return trimesh.Trimesh(vertices=np.asarray(mesh.vert_properties)[:, :3], faces=np.asarray(mesh.tri_verts), process=True)


def for_print_cover(m):
    """뚜껑은 바깥면이 바닥에 오게 뒤집기"""
    return m.mirror([0, 0, 1]).translate([0, 0, DEPTH + COVER_T])


def main():
    parts = {
        "0-test-fit": test_fit(),
        "1-body": body(),
        "2-cover": for_print_cover(cover()),
        "3-stand": stand(),
    }
    for name, m in parts.items():
        tm = to_trimesh(m)
        tm.export(OUT / f"{name}.stl")
        size = tm.bounds[1] - tm.bounds[0]
        print(f"{name:11s} {size[0]:5.1f} x {size[1]:5.1f} x {size[2]:5.1f} mm  {tm.volume / 1000:5.1f} cm³  "
              f"{'닫힘 OK' if tm.is_watertight else '구멍 있음!'}  {m.genus()=}")
    check_print(parts)
    # 겹침 검사: 조립했을 때 받침대가 몸통·뚜껑을 파고들면 안 됨
    b, c, s = placed(body()), placed(cover()), parts["3-stand"]
    print(f"겹침: 몸통∩받침대 {(b ^ s).volume():.2f}  뚜껑∩받침대 {(c ^ s).volume():.2f}  몸통∩뚜껑 {(b ^ c).volume():.2f} mm³ (뚜껑 돌기가 눌리는 만큼만)")
    print(f"모니터 크기: 가로 {W:.1f} · 세로 {H:.1f} · 두께 {DEPTH + COVER_T:.1f} mm")
    check_fit(parts["1-body"], cover())
    if "--no-preview" not in sys.argv:
        preview(b, c, s)


# ---------------- 뽑기 검사: 서포트가 필요한 면이 있는지 ----------------
def check_print(parts):
    """뽑는 방향(z 위)에서 아래를 보는 면: 45도보다 누운 경사면(서포트 필요)과 평평한 천장(다리)을 나눠서 셈"""
    for name, m in parts.items():
        tm = to_trimesh(m)
        nz, area = tm.face_normals[:, 2], tm.area_faces
        up = tm.triangles_center[:, 2] > 0.05  # 바닥에 닿는 면은 빼고
        steep = area[up & (nz < -0.72) & (nz > -0.99)].sum()
        flat = up & (nz <= -0.99)
        spans, where = [], []
        for group in trimesh_groups(tm, flat):
            pts = tm.triangles[group].reshape(-1, 3)
            size = pts.max(axis=0) - pts.min(axis=0)
            if min(size[0], size[1]) > 0.5:  # 0.5mm 도 안 되는 턱은 다리로 안 침
                spans.append(min(size[0], size[1]))  # 다리는 짧은 쪽으로 걸침
                where.append(np.round(np.r_[pts.min(axis=0), pts.max(axis=0)], 1))
        text = f"다리 {len(spans)}곳 (가장 긴 것 {max(spans):.1f} mm)" if spans else "다리 없음"
        if "--debug" in sys.argv:
            print(*where, sep="\n")
        print(f"  {name:11s} 서포트 필요한 경사면 {steep:5.1f} mm² · {text} {'✓' if steep < 1 and max(spans, default=0) <= 20 else '❌'}")


def trimesh_groups(tm, mask):
    """mask 인 면들을 이어진 덩어리끼리 묶음"""
    ids = np.flatnonzero(mask)
    root = {int(i): int(i) for i in ids}

    def find(i):
        while root[i] != i:
            root[i] = root[root[i]]
            i = root[i]
        return i

    for a, b in tm.face_adjacency:
        if a in root and b in root:
            root[find(int(a))] = find(int(b))
    groups = {}
    for i in root:
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


# ---------------- 규격 검사: 도면대로 만든 OLED 를 넣어 보기 ----------------
def oled(i, pcb_h=PCB_H, shift_x=0.0):
    """i 번째 칸에 얹힌 OLED (판 + 유리 + 뒤 핀/듀폰 소켓 + 뒤 부품) — 판 세로가 pcb_h 일 때"""
    x0, y0 = SIDE + CLEAR + shift_x - (0 if pcb_h == PCB_H else 0), pocket_top(i) - PH
    xc = x0 + PCB_W / 2
    top = y0 + pcb_h
    solid = box(x0, y0, FRONT + GLASS, x0 + PCB_W, top, PCB_BACK)  # 판
    solid += box(xc - 13.35, top - 4.02 - 19.26, FRONT, xc + 13.35, top - 4.02, FRONT + GLASS)  # 유리
    pin_y = top - 2.05
    solid += box(xc - 5.08, pin_y - 1.27, PCB_BACK, xc + 5.08, pin_y + 1.27, PCB_BACK + 2.5 + 14.0)  # 핀 받침 + 듀폰 소켓
    solid += box(xc - 7.0, y0 + 1.0, PCB_BACK, xc + 7.0, y0 + 9.0, PCB_BACK + 1.5)  # 뒤 부품·FPC (1.5 MAX)
    aa_y = top - 4.02 - 2.44 - 10.86 / 2
    light = box(xc - 10.87, aa_y - 5.43, -1, xc + 10.87, aa_y + 5.43, FRONT)  # 빛나는 곳 → 앞으로 나가는 빛
    return solid, light, aa_y


def check_fit(b, c):
    ok = True
    for i in range(3):
        cases = [("도면 27.3", PCB_H, 0.0), ("큰 판 27.8", 27.8, 0.0), ("왼쪽에 붙음", PCB_H, -CLEAR), ("오른쪽에 붙음", PCB_H, CLEAR)]
        for label, ph, sx in cases:
            solid, light, aa_y = oled(i, ph, sx)
            hit_b, hit_c, blocked = (solid ^ b).volume(), (solid ^ c).volume(), (light ^ b).volume()
            win = pocket_top(i) - PH + VIEW_FROM_BOTTOM
            margin_v = VIEW_H / 2 - 10.86 / 2 - abs(aa_y - win)
            margin_h = VIEW_W / 2 - 10.87 - abs(sx)
            bad = hit_b > 0.01 or hit_c > 0.01 or blocked > 0.01 or margin_v < 0.3 or margin_h < 0.3
            ok &= not bad
            if bad or label == "도면 27.3":
                print(f"  {i + 1}번 칸 {label:8s} 몸통 겹침 {hit_b:5.2f} · 뚜껑 겹침 {hit_c:5.2f} · 화면 가림 {blocked:5.2f} mm³ · "
                      f"창 여유 위아래 {margin_v:.2f} 좌우 {margin_h:.2f} mm {'❌' if bad else '✓'}")
    # 걸림: 뚜껑 없이 판을 뒤로 1.5mm 밀면 걸림턱 4개에 걸려야 하고, 위로 HEAD 만큼 올리면 아래 턱에서 빠져야(넣을 수 있어야) 함
    for i in range(3):
        x0, y0 = SIDE + CLEAR, pocket_top(i) - PH
        pushed = box(x0, y0, PCB_BACK + 1.5 - PCB_T, x0 + PCB_W, y0 + PCB_H, PCB_BACK + 1.5)
        low = (box(x0, y0, PCB_BACK, x0 + PCB_W, y0 + 3, PCB_BACK + 3) ^ b ^ pushed).volume()
        high = (box(x0, y0 + PCB_H - 3, PCB_BACK, x0 + PCB_W, y0 + PCB_H, PCB_BACK + 3) ^ b ^ pushed).volume()
        lifted = box(x0, y0 + HEAD, PCB_BACK, x0 + PCB_W, y0 + HEAD + 3, PCB_BACK + 3)  # 위로 올린 판의 아래쪽이 지나는 길
        free = (lifted ^ b).volume()
        good = low > 0.5 and high > 0.5 and free < 0.01
        ok &= good
        print(f"  {i + 1}번 칸 걸림턱: 아래 {'걸림' if low > 0.5 else '안 걸림'} · 위 {'걸림' if high > 0.5 else '안 걸림'} · 넣는 길 {'열림' if free < 0.01 else '막힘'} {'✓' if good else '❌'}")
    # 넣기: 판을 비스듬히 위 턱 밑으로 밀어 올렸다가(HEAD) 눕히면서 내리는 길을 20단계로 따라가며 몸통에 걸리는지
    worst = 0.0
    for i in range(3):
        y0 = pocket_top(i) - PH
        board, _, _ = oled(i)
        board = board ^ box(0, y0 - 1, 0, W, y0 + PCB_H + 1, PCB_BACK + 9)  # 선은 나중에 꽂음 (핀까지만)
        for step in range(21):
            up = HEAD * (1 - step / 20)
            back = CATCH_GAP - (HEAD - PCB_MAX) + (HEAD - up) - 0.05 if up > PCB_MAX else 0.0  # 위 턱 밑면을 따라
            back = min(back, 0.0)
            tilt = math.degrees(math.atan2(-back + 0.15, 4.02)) if back < 0 else 0.0  # 유리가 앞판에 안 닿을 만큼만 기울임
            pivot = [0, y0 + PCB_H, PCB_BACK]
            pose = board.translate([-p for p in pivot]).rotate([-tilt, 0, 0]).translate(pivot).translate([0, up, back])
            worst = max(worst, (pose ^ b).volume())
    ok &= worst < 0.05
    print(f"  넣는 길(비스듬히 밀어 올렸다 내리기) 걸리는 곳: {worst:.2f} mm³ {'✓' if worst < 0.05 else '❌'}")
    # 뚜껑 기둥이 판 뒷면에 닿는지 (판 뒷면 ~ 기둥 끝)
    print(f"  판 뒤 ~ 뚜껑 기둥: {PRESS_GAP:.2f} mm · 듀폰 소켓 끝 ~ 뚜껑: {DEPTH - (PCB_BACK + 16.5):.1f} mm (선 꺾을 자리)")
    print("규격 검사:", "통과" if ok else "문제 있음")


# ---------------- 3D 보기 (viewer.html) ----------------
def preview(b, c, s):
    """viewer.html: 브라우저로 열면 마우스로 돌려 볼 수 있는 조립 모습 (STL 을 안에 넣어 둠, three.js 는 인터넷에서)"""
    import base64
    import io

    # 보기용 OLED (파란 판 + 빛나는 화면) — 뽑는 부품은 아님
    pcb, glow = Manifold(), Manifold()
    for i in range(3):
        y0 = pocket_top(i) - PH  # 판이 칸 바닥에 얹힌 자리
        pcb += box(SIDE + CLEAR, y0, FRONT + GLASS, SIDE + CLEAR + PCB_W, y0 + PCB_H, PCB_BACK)
        pcb += box(W / 2 - 13.35, y0 + PCB_H - 4.02 - 19.26, FRONT + 0.05, W / 2 + 13.35, y0 + PCB_H - 4.02, FRONT + GLASS)  # 유리
        cy = y0 + VIEW_FROM_BOTTOM
        glow += box(W / 2 - 10.87, cy - 5.43, FRONT, W / 2 + 10.87, cy + 5.43, FRONT + 0.2)
    parts = {"body": b, "cover": c, "stand": s, "pcb": placed(pcb), "glow": placed(glow)}
    data = {}
    for name, m in parts.items():
        buf = io.BytesIO()
        to_trimesh(m).export(buf, file_type="stl")
        data[name] = base64.b64encode(buf.getvalue()).decode()
    html = VIEWER.replace("__DATA__", __import__("json").dumps(data)).replace("__SIZE__", f"{W:.1f} × {H:.1f} × {DEPTH + COVER_T:.1f} mm")
    (OUT / "viewer.html").write_text(html, encoding="utf-8")
    print("viewer.html 저장 (브라우저로 열기)")


VIEWER = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>OLED 서브모니터 케이스</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; background: #191919; color: #eee; font: 14px -apple-system, "Pretendard", sans-serif; overflow: hidden; }
  #ui { position: absolute; left: 16px; top: 14px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button { background: #2a2a2a; color: #eee; border: 0; border-radius: 8px; height: 32px; padding: 0 12px; font: inherit; cursor: pointer; }
  button.on { background: #1ed760; color: #000; font-weight: 700; }
  #info { color: #9b9b98; margin-left: 6px; }
</style>
<script type="importmap">{"imports": {"three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
</head><body>
<div id="ui"><b>OLED 서브모니터</b><button data-v="front" class="on">앞</button><button data-v="back">뒤</button><button data-v="open">뚜껑 열기</button><span id="info">__SIZE__ · 마우스로 돌려 보기</span></div>
<script type="module">
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const DATA = __DATA__;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#191919');
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 1, 2000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 60);
scene.add(new THREE.HemisphereLight('#ffffff', '#202020', 1.6));
const sun = new THREE.DirectionalLight('#ffffff', 2.2); sun.position.set(-80, -140, 220); scene.add(sun);
const rim = new THREE.DirectionalLight('#9fd8ff', 0.8); rim.position.set(120, 160, 80); scene.add(rim);
const look = {
  body: { color: '#3b3f45', roughness: .55 }, cover: { color: '#33363b', roughness: .6 }, stand: { color: '#3b3f45', roughness: .55 },
  pcb: { color: '#1d4f9c', roughness: .5 }, glow: { color: '#0a1a22', emissive: '#58c8ff', emissiveIntensity: 1.1 },
};
const loader = new STLLoader(), meshes = {};
for (const [name, b64] of Object.entries(DATA)) {
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const geo = loader.parse(bytes.buffer);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ ...look[name], flatShading: true }));
  scene.add(mesh); meshes[name] = mesh;
}
const views = {
  front: { pos: [-150, -260, 150], open: 0 }, back: { pos: [170, 230, 140], open: 0 }, open: { pos: [150, 330, 170], open: 60 },
};
function setView(v) {
  const { pos, open } = views[v];
  camera.position.set(...pos);
  meshes.cover.position.set(0, open, 0);
  document.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
}
document.querySelectorAll('button').forEach((b) => (b.onclick = () => setView(b.dataset.v)));
setView(new URLSearchParams(location.search).get('view') || 'front');
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
document.title += ' ✓';
</script></body></html>
"""


if __name__ == "__main__":
    main()
