"""
tent.py — OLED 3개를 가로로 넣는 "예약석 삼각 팻말" 모양 케이스 (3D 프린터용)
============================================================
식당 예약석에 올려두는 삼각기둥 팻말처럼 책상에 눕혀 세워요.
  앞면(평평함): 뒤로 20도 기울어진 판에 OLED 3개가 가로로 (왼쪽부터 노래 · 시계 · 가사)
  뒷면: 끼워 닫는 뚜껑. 아래쪽 구멍으로 듀폰 선이 나감
  바닥: 책상에 닿는 면

만드는 것 (case/tent/ 폴더)
  0-test-fit.stl  칸 하나짜리 시험 조각 (서브모니터 케이스와 같음)
  1-body.stl      몸통: 앞면 + 바닥 + 양옆. 앞면이 바닥에 오게 놓여 있음
  2-cover.stl     뒷뚜껑: 바깥면이 바닥에 오게 놓여 있음
  viewer.html     브라우저로 열어서 돌려 보기
둘 다 서포트 없이 뽑혀요. PLA · 0.2mm · 벽 3줄 · 채움 15~20%

OLED 칸·걸림턱·화면 창은 case.py 와 똑같아요 (0.96" SSD1306 도면 기준). 치수를 고치려면 case.py 맨 위를,
팻말 모양(기울기, 크기)을 고치려면 아래 "팻말 모양"을 고치고  python tent.py
"""

import math
import sys
from pathlib import Path

import numpy as np
from manifold3d import CrossSection, JoinType, Manifold

import case
from case import (CATCH_GAP, CHAMFER, CLEAR, CRUSH, FIT, FRAME_Z, FRONT, GLASS, HEAD, LIP, LIP_T, PCB_BACK, PCB_H, PCB_MAX,
                  PCB_T, PCB_W, PH, PW, VIEW_FROM_BOTTOM, VIEW_H, VIEW_W, box, catch_room, catches, check_print, slab,
                  to_trimesh)

OUT = Path(__file__).parent / "tent"

# ---------------- 팻말 모양 (mm, 도) ----------------
FACE_TILT = 70.0  # 앞면과 책상 사이 각도 (90 이면 똑바로 섬). 70 = 뒤로 20도 기울어짐
APEX = 62.0  # 꼭대기 각 (앞면과 뒷면 사이). 클수록 뒤로 뚱뚱해지고 안이 넓어짐
WALL = 2.0  # 바닥·뒷면 두께
END = 2.4  # 양옆(삼각형 벽) 두께
SIDE = 6.0  # 앞면 좌우 여백 (칸 바깥 ~ 몸통 바깥)
GAP = 4.0  # 화면 사이 칸막이
BOTTOM = 7.0  # 앞면 아래 여백 (책상 ~ 칸 아래)
TOP_MIN = 6.0  # 앞면 위 여백 (칸 위 ~ 꼭대기) 최소
ROUND = 2.0  # 삼각형 모서리 비스듬히 깎기 (둥글게 하면 바닥 쪽이 공중에 떠서 깎은 면으로)
KEEP_OUT = 9.0  # 뒷뚜껑 턱이 앞면 안쪽에서 이만큼은 비켜 감 (칸막이·걸림턱 자리)
WIRE = 16.5 + 6.0  # 판 뒤로 필요한 깊이: 핀 받침 2.5 + 듀폰 소켓 14 + 선 꺾일 자리 6
SLOT_W, SLOT_H = 54.0, 8.0  # 뒷뚜껑 아래쪽 선 구멍
SLOT_FROM = 7.0  # 뒷뚜껑 아래 모서리 ~ 선 구멍 아래

A, B = math.radians(FACE_TILT), math.radians(180 - FACE_TILT - APEX)  # 앞면 각, 뒷면 각 (책상 기준)
CA, SA = math.cos(A), math.sin(A)
W = 2 * SIDE + 3 * PW + 2 * GAP  # 가로 (앞에서 본 너비)


def pocket(i):
    """i 번째 칸(0 = 앞에서 봤을 때 왼쪽)의 왼쪽 아래 (앞면 좌표 x, y)"""
    return SIDE + (2 - i) * (PW + GAP), BOTTOM  # 앞면 좌표 x 는 앞에서 보면 오른쪽 → 왼쪽이라 거꾸로 셈


# ---------------- 좌표 ----------------
# 앞면 좌표 (x, y, z): x 가로, y 앞면을 따라 위로(책상 모서리 = 0), z 앞면 안쪽으로(앞면 바깥 = 0)
#   → case.py 의 몸통 좌표와 같아서 칸·걸림턱·창을 그대로 씀. 뽑을 때도 이 좌표 그대로 (앞면이 바닥)
# 책상 좌표 (X, Y, Z): X 가로, Y 뒤로, Z 위로. 앞면 아래 모서리가 Y = Z = 0
TO_WORLD = [[-1, 0, 0, W], [0, CA, SA, 0], [0, SA, -CA, 0]]  # (회전만, 뒤집기 없음)
TO_FACE = TO_WORLD  # 자기 자신이 역행렬 (x → W - X 도 두 번 하면 제자리)


def world(m):
    return m.transform(TO_WORLD)


def face_len():
    """앞면 길이: 칸 위 여백과, 맨 위 칸의 핀 뒤로 듀폰 선이 들어갈 깊이를 둘 다 만족하는 가장 짧은 길이"""
    pin_y = BOTTOM + PCB_H + PCB_MAX - case.HOLE_Y + 1.27  # 듀폰 소켓 위 끝 (큰 판 27.8 기준)
    need = PCB_BACK + WIRE + WALL / math.cos(math.radians(90 - APEX)) + 2.0  # 앞면 바깥에서 뒷면 바깥까지 (뒷판은 비스듬히 지나가서 더 두껍게 침)
    for tenth in range(300, 1200):
        L = tenth / 10
        if L < BOTTOM + PH + TOP_MIN:
            continue
        # 앞면 위 한 점에서 안쪽으로 똑바로 들어가면 꼭대기에서 (L - y) 떨어진 곳 → 뒷면까지 (L - y)·tan(꼭대기 각)
        if (L - pin_y) * math.tan(math.radians(APEX)) >= need:
            return L
    raise ValueError("팻말이 너무 커져요: APEX 를 키우세요")


L = face_len()
APEX_PT = np.array([L * CA, L * SA])  # 꼭대기 (Y, Z)
BACK_PT = np.array([APEX_PT[0] + APEX_PT[1] / math.tan(B), 0.0])  # 뒤 아래 모서리
N_FRONT = np.array([-SA, CA])  # 앞면 바깥쪽 방향
N_BACK = np.array([math.sin(B), math.cos(B)])  # 뒷면 바깥쪽 방향
N_BASE = np.array([0.0, -1.0])  # 바닥 바깥쪽 방향
DEPTH = BACK_PT[0]  # 앞뒤 길이
HEIGHT = APEX_PT[1]  # 높이


def tri(d_front=0.0, d_base=0.0, d_back=0.0):
    """삼각형 단면 (Y, Z). 각 면을 안쪽으로 그만큼 밀어 넣은 것"""
    lines = [(N_FRONT, 0.0 - d_front), (N_BASE, 0.0 - d_base), (N_BACK, float(N_BACK @ BACK_PT) - d_back)]

    def meet(a, b):
        (n1, c1), (n2, c2) = a, b
        return np.linalg.solve(np.array([n1, n2]), np.array([c1, c2]))

    pts = [meet(lines[0], lines[1]), meet(lines[1], lines[2]), meet(lines[2], lines[0])]
    return CrossSection([[tuple(p) for p in pts]])


def prism(section, x0, x1):
    """단면 (Y, Z) 를 X 방향으로 x0~x1 만큼 (책상 좌표)"""
    return section.extrude(x1 - x0).transform([[0, 0, 1, x0], [1, 0, 0, 0], [0, 1, 0, 0]])


def outer():
    sec = tri().offset(-ROUND, JoinType.Miter).offset(ROUND, JoinType.Square)  # 모서리마다 평평하게 한 번 깎음
    return prism(sec, 0, W)


def cavity(extra=0.0):
    """안쪽 빈 곳 (extra 만큼 더 작게)"""
    return prism(tri(FRONT + extra, WALL + extra, WALL + extra), END + extra, W - END - extra)


def behind_cut(gap=0.0):
    """뒷면 안쪽 면(몸통과 뚜껑이 갈리는 면)보다 뒤쪽 반 공간"""
    c = float(N_BACK @ BACK_PT) - WALL + gap
    return Manifold.cube([4000, 4000, 4000]).translate([-2000, -2000, -2000]).trim_by_plane([0, N_BACK[0], N_BACK[1]], c)


# ---------------- 몸통 ----------------
def front_features():
    """앞면 좌표로 만든 OLED 칸막이 판(칸 3개 뚫림) + 걸림턱"""
    frame = box(END, 0, FRONT - 0.01, W - END, BOTTOM + PH + 4.0, FRAME_Z)  # 칸 위 4mm 까지만 (꼭대기 쪽 뚜껑 이음매와 안 닿게)
    for i in range(3):
        px, py = pocket(i)
        frame -= box(px, py, FRONT - 1, px + PW, py + PH, FRAME_Z + 1)
    for i in range(3):
        frame += catches(*pocket(i))
    return frame


def windows():
    cut = Manifold()
    for i in range(3):
        px, py = pocket(i)
        cx, cy = px + PW / 2, py + VIEW_FROM_BOTTOM
        inner = box(cx - VIEW_W / 2, cy - VIEW_H / 2, FRONT - 0.3, cx + VIEW_W / 2, cy + VIEW_H / 2, FRONT + 0.5)
        outer_ = box(cx - VIEW_W / 2 - CHAMFER, cy - VIEW_H / 2 - CHAMFER, -0.5,
                     cx + VIEW_W / 2 + CHAMFER, cy + VIEW_H / 2 + CHAMFER, -0.49)
        cut += Manifold.batch_hull([inner, outer_])
    return cut


def body():
    shell = outer() - cavity() - behind_cut()
    shell += world(front_features()) ^ cavity(-0.4)  # 칸막이는 안쪽 빈 곳 안에서만 (벽에 0.4 묻혀서 이음매가 깔끔하게)
    return shell - world(windows())


# ---------------- 뒷뚜껑 ----------------
def cover():
    plate = outer() ^ behind_cut()
    # 턱: 몸통 안쪽 빈 곳에 FIT 만큼 작게 들어가는 테두리 (LIP 깊이, 두께 LIP_T). 뚜껑 판에 바로 붙어 있음
    def hollow(d):  # 앞·바닥·양옆은 d 만큼 안쪽, 뒤는 뚜껑 판 안쪽 면 너머까지
        return prism(tri(FRONT + d, WALL + d, WALL - 1.0), END + d, W - END - d)
    band = behind_cut(-LIP) - behind_cut(0.01)  # 뒷면 안쪽 면에서 LIP 만큼 앞쪽 띠
    lip = (hollow(FIT) ^ band) - hollow(FIT + LIP_T)
    # 앞면 안쪽(칸막이·걸림턱이 있는 곳)은 비켜 감
    lip = lip.trim_by_plane([0, -N_FRONT[0], -N_FRONT[1]], KEEP_OUT)
    plate += lip
    # 작은 돌기: 양옆 턱에 3줄씩, 몸통 옆벽에 살짝 눌리며 물림
    d = np.array([-math.cos(B), math.sin(B)])  # 뒷면을 따라 위로
    start, length = BACK_PT + d * (WALL / math.sin(B) + 3), (np.linalg.norm(APEX_PT - BACK_PT) - 10)
    for t in (0.2, 0.5, 0.8):
        p = start + d * (length * t) - N_BACK * (WALL + LIP / 2)  # 띠 가운데
        for x0, x1 in ((END + FIT - CRUSH, END + FIT + 0.1), (W - END - FIT - 0.1, W - END - FIT + CRUSH)):
            nub = Manifold.cube([x1 - x0, 1.2, LIP - 0.8], center=True)
            ang = math.degrees(math.atan2(N_BACK[1], N_BACK[0]))  # 띠 두께 방향 = 뒷면 방향
            nub = nub.rotate([90 - ang, 0, 0]).translate([(x0 + x1) / 2, p[0], p[1]])
            plate += nub
    # 선 나가는 구멍 (아래쪽 가운데)
    plate -= cover_box(W / 2 - SLOT_W / 2, SLOT_FROM, -1, W / 2 + SLOT_W / 2, SLOT_FROM + SLOT_H, WALL + LIP + 1)
    # 손톱 홈 (꼭대기 쪽 가장자리)
    top = float(np.linalg.norm(APEX_PT - BACK_PT))
    plate -= cover_box(W / 2 - 8, top - 2.2, 1.0, W / 2 + 8, top + 1, WALL + 1)  # 안쪽 면에서 파서 (뽑을 때 천장이 안 생김)
    return plate


# 뒷면 좌표 (x, v, d): x 가로(책상 X 그대로), v 뒷면을 따라 위로(뒤 아래 모서리 = 0), d 안쪽으로(뒷면 바깥 = 0)
D_UP = np.array([-math.cos(B), math.sin(B)])
TO_BACK = [[1, 0, 0, 0],
           [0, D_UP[0], D_UP[1], -float(D_UP @ BACK_PT)],
           [0, -N_BACK[0], -N_BACK[1], float(N_BACK @ BACK_PT)]]


def cover_box(x0, v0, d0, x1, v1, d1):
    """뒷면 좌표의 상자 → 책상 좌표"""
    rot = np.array(TO_BACK)[:, :3]
    shift = np.array(TO_BACK)[:, 3]
    inv = np.c_[rot.T, -rot.T @ shift]
    return box(x0, v0, d0, x1, v1, d1).transform(inv.tolist())


# ---------------- 검사 ----------------
def oled_at(px, py, pcb_h=PCB_H, wire=True):
    """칸(왼쪽 아래 px, py)에 얹힌 OLED (앞면 좌표). wire: 핀·듀폰·선 꺾일 자리까지"""
    x0 = px + CLEAR
    xc, top = x0 + PCB_W / 2, py + pcb_h
    solid = box(x0, py, FRONT + GLASS, x0 + PCB_W, top, PCB_BACK)
    solid += box(xc - 13.35, top - 4.02 - 19.26, FRONT, xc + 13.35, top - 4.02, FRONT + GLASS)
    solid += box(xc - 7.0, py + 1.0, PCB_BACK, xc + 7.0, py + 9.0, PCB_BACK + 1.5)
    if wire:
        pin_y = top - case.HOLE_Y
        solid += box(xc - 5.08, pin_y - 1.27, PCB_BACK, xc + 5.08, pin_y + 1.27, PCB_BACK + WIRE)
    aa_y = top - 4.02 - 2.44 - 10.86 / 2
    light = box(xc - 10.87, aa_y - 5.43, -1, xc + 10.87, aa_y + 5.43, FRONT)
    return solid, light, aa_y


def check(b, c):
    ok = True
    bf, cf = b.transform(TO_FACE), c.transform(TO_FACE)  # 앞면 좌표로 옮겨서 검사
    for i in range(3):
        px, py = pocket(i)
        for label, ph in (("도면 27.3", PCB_H), ("큰 판 27.8", PCB_H + PCB_MAX)):
            solid, light, aa_y = oled_at(px, py, ph)
            hit_b, hit_c, blocked = (solid ^ bf).volume(), (solid ^ cf).volume(), (light ^ bf).volume()
            margin_v = VIEW_H / 2 - 10.86 / 2 - abs(aa_y - (py + VIEW_FROM_BOTTOM))
            bad = hit_b > 0.01 or hit_c > 0.01 or blocked > 0.01 or margin_v < 0.3
            ok &= not bad
            if bad or label == "도면 27.3":
                print(f"  {i + 1}번 칸 {label}: 몸통 겹침 {hit_b:.2f} · 뚜껑 겹침(선 포함) {hit_c:.2f} · 화면 가림 {blocked:.2f} mm³ · "
                      f"창 위아래 여유 {margin_v:.2f} mm {'❌' if bad else '✓'}")
        # 걸림턱: 뒤로 밀면 걸리고, 위로 올리면(넣는 길) 막히지 않아야
        x0 = px + CLEAR
        pushed = box(x0, py, PCB_BACK + 1.5 - PCB_T, x0 + PCB_W, py + PCB_H, PCB_BACK + 1.5)
        low = (box(x0, py, PCB_BACK, x0 + PCB_W, py + 3, PCB_BACK + 3) ^ bf ^ pushed).volume()
        high = (box(x0, py + PCB_H - 3, PCB_BACK, x0 + PCB_W, py + PCB_H, PCB_BACK + 3) ^ bf ^ pushed).volume()
        free = (box(x0, py + HEAD, PCB_BACK, x0 + PCB_W, py + HEAD + 3, PCB_BACK + 3) ^ bf).volume()
        good = low > 0.5 and high > 0.5 and free < 0.01
        ok &= good
        print(f"  {i + 1}번 칸 걸림턱: 아래 {'걸림' if low > 0.5 else '안 걸림'} · 위 {'걸림' if high > 0.5 else '안 걸림'} · "
              f"넣는 길 {'열림' if free < 0.01 else '막힘'} {'✓' if good else '❌'}")
    # 넣는 길: 위로 밀어 올렸다가 비스듬히 눕혀 내리는 길 (case.py 와 같은 방법)
    worst = 0.0
    for i in range(3):
        px, py = pocket(i)
        board, _, _ = oled_at(px, py, wire=False)
        for step in range(21):
            up = HEAD * (1 - step / 20)
            back = min(CATCH_GAP - (HEAD - PCB_MAX) + (HEAD - up) - 0.05, 0.0) if up > PCB_MAX else 0.0
            tilt = math.degrees(math.atan2(-back + 0.15, 4.02)) if back < 0 else 0.0
            pivot = [0, py + PCB_H, PCB_BACK]
            pose = board.translate([-p for p in pivot]).rotate([-tilt, 0, 0]).translate(pivot).translate([0, up, back])
            worst = max(worst, (pose ^ bf).volume())
    ok &= worst < 0.05
    print(f"  넣는 길 걸리는 곳: {worst:.2f} mm³ {'✓' if worst < 0.05 else '❌'}")
    # 화면이 다 앞면 평평한 곳 안에 있는지 (둥근 모서리에 안 걸리게)
    flat_top = L - ROUND / math.tan(math.radians(APEX) / 2) - 0.5
    top_win = max(pocket(i)[1] + VIEW_FROM_BOTTOM + VIEW_H / 2 + CHAMFER for i in range(3))
    ok &= top_win < flat_top
    print(f"  화면 창은 앞면 평평한 곳 안: 창 위 끝 {top_win:.1f} < 평평한 곳 끝 {flat_top:.1f} mm {'✓' if top_win < flat_top else '❌'}")
    print("규격 검사:", "통과" if ok else "문제 있음")
    return ok


# ---------------- 내보내기 ----------------
def for_print_body(b):
    return b.transform(TO_FACE)  # 앞면 바깥이 z = 0 (바닥)


def for_print_cover(c):
    return c.transform(TO_BACK)  # 뒷면 바깥이 z = 0 (바닥)


def main():
    OUT.mkdir(exist_ok=True)
    b, c = body(), cover()
    parts = {"0-test-fit": case.test_fit(), "1-body": for_print_body(b), "2-cover": for_print_cover(c)}
    for name, m in parts.items():
        tm = to_trimesh(m)
        tm.export(OUT / f"{name}.stl")
        size = tm.bounds[1] - tm.bounds[0]
        print(f"{name:11s} {size[0]:5.1f} x {size[1]:5.1f} x {size[2]:5.1f} mm  {tm.volume / 1000:5.1f} cm³  "
              f"{'닫힘 OK' if tm.is_watertight else '구멍 있음!'}  바닥 z={tm.bounds[0][2]:.2f}")
    check_print(parts)
    print(f"겹침: 몸통∩뚜껑 {(b ^ c).volume():.2f} mm³ (뚜껑 돌기가 눌리는 만큼만)")
    print(f"팻말 크기: 가로 {W:.1f} · 앞뒤 {DEPTH:.1f} · 높이 {HEIGHT:.1f} mm · 앞면 {L:.1f} mm (기울기 {FACE_TILT:.0f}°)")
    check(b, c)
    if "--no-preview" not in sys.argv:
        preview(b, c)


def preview(b, c):
    import base64
    import io
    import json

    pcb, glow = Manifold(), Manifold()
    for i in range(3):
        px, py = pocket(i)
        solid, light, aa_y = oled_at(px, py, wire=False)
        pcb += solid
        xc = px + CLEAR + PCB_W / 2
        glow += box(xc - 10.87, aa_y - 5.43, FRONT - 0.15, xc + 10.87, aa_y + 5.43, FRONT - 0.05)  # 유리 바로 앞 (겹치면 화면이 깜빡여 보임)
    center = [-W / 2, -DEPTH / 2, 0]
    parts = {"body": b, "cover": c, "pcb": world(pcb), "glow": world(glow)}
    data = {}
    for name, m in parts.items():
        buf = io.BytesIO()
        to_trimesh(m.translate(center)).export(buf, file_type="stl")
        data[name] = base64.b64encode(buf.getvalue()).decode()
    html = case.VIEWER.replace("__DATA__", json.dumps(data)).replace("__SIZE__", f"{W:.1f} × {DEPTH:.1f} × {HEIGHT:.1f} mm")
    html = html.replace("OLED 서브모니터", "OLED 예약석 팻말").replace("controls.target.set(0, 0, 60);", "controls.target.set(0, 0, 18);")
    a = html.index("const views = {")
    z = html.index("};", a) + 2
    html = html[:a] + """const views = {
  front: { pos: [-90, -230, 110], open: 0 }, back: { pos: [110, 220, 120], open: 0 }, open: { pos: [150, 230, 140], open: 45 },
};""" + html[z:]
    (OUT / "viewer.html").write_text(html, encoding="utf-8")
    print("viewer.html 저장")


if __name__ == "__main__":
    main()
