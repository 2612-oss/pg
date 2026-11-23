"""
classifier.py — scikit-learn 동작 분류 (기획서: "scikit-learn — 동작 분류 모델 학습")
============================================================
흐름
  1) 녹화: 대시보드(http://파이:8090/)에서 이름(예: rock)을 적고 녹화 → 그 동작의 좌표를 data/samples.jsonl 에 모음
  2) 학습: [학습] 버튼 → RandomForest 학습 → models/actions.pkl
  3) 인식: 매 프레임 좌표 → features() → 모델 → 'rock' (확신이 낮으면 None)
  맥 노치 설정에서 장르의 "제스처 이름"을 같은 이름(rock)으로 해두면 락 플리가 틀어져요.

'_none' 은 특별한 이름: "아무 동작도 안 하는 평소 모습". 꼭 녹화해야 해요.
  이게 없으면 모델이 가만히 있을 때도 아는 동작 중 하나라고 우겨요.

특징(feature) = 숫자 61개 (샘플 파일에 저장되는 것)
  손 42개 : 손 관절 21개의 x, y 를 손목 기준으로 옮기고 손 크기로 나눔 (손 위치·카메라 거리 무시) + 손 보임 여부 1개
  몸 18개 : 코·어깨·팔꿈치·손목·손끝(0,11~16,19,20) 9곳의 x, y 를 어깨 가운데 기준으로 옮기고 어깨 너비로 나눔
  안 보이는 쪽은 0 으로 채움

정확도를 올리려고 하는 일 4가지 (샘플 파일은 그대로, 학습·판별할 때만)
  1) expand()  : 61개에서 "손 모양" 숫자를 더 계산해 붙임 — 손가락이 펴졌나, 손끝끼리 거리, 손 방향,
                 손을 똑바로 세웠을 때의 모양. 좌표만 줄 때보다 모델이 손 모양을 훨씬 잘 구분해요.
  2) augment() : 샘플을 조금씩 돌리고 흔든 복사본을 만들어 같이 학습 — 녹화할 때와 손 각도·자리가
                 조금 달라도 알아보게. 몸이 안 잡힌 경우(몸 숫자가 전부 0)도 섞어서, 손만 보여도 되게.
  3) 문지기(gate) : 모델이 "rock 90%" 라고 해도, 녹화해 둔 rock 샘플들과 실제로 닮았는지 거리를 재서
                 너무 멀면 "모르는 자세"로 버림. 손으로 하는 동작인데 손이 안 보이면 그것도 버림.
                 (모델은 처음 보는 자세도 아는 것 중 하나로 우기는 버릇이 있어서)
  4) 정직한 점수 : 녹화 한 번의 앞 60% 로 배우고 뒤 40% 로 시험 (거꾸로도 한 번).
                 이어진 프레임은 거의 똑같아서 마구 섞어 시험하면 늘 99% 가 나와요 — 그건 믿을 수 없는 숫자.
"""

import json
import math
import os
import pickle
import threading
from collections import Counter
from pathlib import Path

import numpy as np

# 샘플·모델을 두는 곳. 보통은 이 폴더, 맥 노치 앱이 켤 땐 GESTURE_HOME 으로 다른 폴더를 알려줘요
HERE = Path(os.environ.get("GESTURE_HOME") or Path(__file__).parent)
DATA = HERE / "data" / "samples.jsonl"
MODEL = HERE / "models" / "actions.pkl"
NONE = "_none"

MIN_PROB = 0.7  # 이보다 확신이 낮으면 "모르겠음"
POSE_POINTS = [0, 11, 12, 13, 14, 15, 16, 19, 20]

TREES = 60  # 나무 수. 150 개와 정확도는 같은데 파이에서 판별이 2.5배 빨라요
COPIES = 3  # augment: 샘플 하나당 흔든 복사본 수
GATE_K = 3  # 문지기: 3번째로 가까운 샘플까지의 거리를 봄 (하나만 보면 튀는 샘플에 속음)
GATE_SLACK = 4.0  # 문지기: 녹화할 때 샘플끼리 떨어진 거리의 몇 배까지 봐줄지. 줄이면 깐깐, 늘리면 너그러움
GATE_FLOOR = 1.0  # 문지기: 아주 가만히 녹화했어도 이만큼은 봐줌
GATE_TILT = 12  # 문지기: 손을 이 각도(도)만큼 기울인 것도 견본에 넣음
TILT = 10  # augment: 손을 돌리는 정도 (도, 대부분 이 안쪽). 너무 키우면 방향만 다른 동작끼리 섞여요
VERSION = 2  # 저장한 모델 형식. 옛 모델(1)을 만나면 샘플로 다시 학습해요

TIPS, MCPS = [4, 8, 12, 16, 20], [2, 5, 9, 13, 17]  # 손가락 끝 / 손가락 뿌리 (엄지~새끼)


def features(lm):
    """Landmarks → 숫자 61개"""
    out = []
    # 손
    if lm.hand:
        wx, wy, _ = lm.hand[0]
        mx, my, _ = lm.hand[9]
        size = math.hypot(mx - wx, my - wy) or 1e-6
        for x, y, _ in lm.hand:
            out += [(x - wx) / size, (y - wy) / size]
        out.append(1.0)
    else:
        out += [0.0] * 43
    # 몸 (어깨가 잘 보일 때만)
    if lm.pose and min(lm.pose[11][3], lm.pose[12][3]) > 0.5:
        lx, ly = lm.pose[11][:2]
        rx, ry = lm.pose[12][:2]
        cx, cy = (lx + rx) / 2, (ly + ry) / 2
        width = math.hypot(lx - rx, ly - ry) or 1e-6
        for i in POSE_POINTS:
            x, y = lm.pose[i][:2]
            out += [(x - cx) / width, (y - cy) / width]
    else:
        out += [0.0] * (len(POSE_POINTS) * 2)
    return out



def expand(rows):
    """61개짜리 줄들 → 손 모양 숫자를 덧붙인 줄들 (모델에는 이걸 넣어요)"""
    X = np.asarray(rows, dtype=float).reshape(-1, 61)
    H = X[:, :42].reshape(-1, 21, 2)
    has = X[:, 42:43]  # 손이 보였나 (1 또는 0) — 안 보였으면 덧붙이는 숫자도 전부 0

    def dist(a, b):
        return np.linalg.norm(H[:, a] - H[:, b], axis=1)

    cols = []
    for tip, mcp in zip(TIPS, MCPS):  # 손가락이 펴졌나: 끝이 손목·뿌리에서 얼마나 먼가
        cols += [dist(tip, 0), dist(tip, mcp), dist(tip, 0) / (dist(mcp, 0) + 1e-6)]
    for a in range(5):  # 손끝끼리 거리 (예: 엄지와 검지를 붙였나)
        for b in range(a + 1, 5):
            cols.append(dist(TIPS[a], TIPS[b]))
    angle = np.arctan2(H[:, 9, 1], H[:, 9, 0])  # 손 방향 (손목 → 중지 뿌리)
    cols += [np.sin(angle), np.cos(angle)]
    # 손을 위로 똑바로 세운 것처럼 돌린 좌표 — 손이 어느 쪽을 향하든 같은 모양이면 같은 숫자
    c, s = np.cos(-angle - np.pi / 2)[:, None], np.sin(-angle - np.pi / 2)[:, None]
    upright = np.stack([H[..., 0] * c - H[..., 1] * s, H[..., 0] * s + H[..., 1] * c], -1)
    return np.hstack([X, np.stack(cols, 1) * has, upright.reshape(len(X), -1) * has])


def turn(hands, degrees):
    """손 좌표 42개짜리 줄들을 손목 중심으로 돌림 (degrees: 숫자 하나 또는 줄마다 하나)"""
    H = np.asarray(hands, dtype=float).reshape(-1, 21, 2)
    t = np.radians(np.broadcast_to(degrees, (len(H),)))[:, None]
    return np.stack([H[..., 0] * np.cos(t) - H[..., 1] * np.sin(t), H[..., 0] * np.sin(t) + H[..., 1] * np.cos(t)], -1).reshape(len(H), -1)


def augment(X, y, rng):
    """샘플을 조금씩 돌리고 흔든 복사본을 붙여서 돌려줌 (원본 + COPIES 배)"""
    Xs, ys = [X], [y]
    for _ in range(COPIES):
        A = X.copy()
        hand = A[:, 42] > 0.5
        body = np.abs(A[:, 43:]).sum(1) > 0
        # 손을 손목 중심으로 살짝 돌림 + 관절마다 조금 흔듦
        A[:, :42] = (turn(A[:, :42], rng.normal(0, TILT, len(A))) + rng.normal(0, 0.03, (len(A), 42))) * hand[:, None]
        # 몸도 조금 흔들고, 손이 보인 샘플의 1/3 은 "몸이 안 잡힌 경우"로 만듦
        A[:, 43:] += rng.normal(0, 0.06, (len(A), 18)) * body[:, None]
        A[hand & (rng.random(len(A)) < 0.35), 43:] = 0
        Xs.append(A)
        ys.append(y)
    return np.vstack(Xs), np.concatenate(ys)


def fit_model(X, y):
    from sklearn.ensemble import RandomForestClassifier

    Xa, ya = augment(X, y, np.random.default_rng(0))
    # n_jobs=1: 한 프레임씩 판별할 땐 나눠 맡기는 준비가 더 오래 걸려요 (파이에서 162ms → 25ms)
    return RandomForestClassifier(n_estimators=TREES, min_samples_leaf=2, n_jobs=1, random_state=0).fit(expand(Xa), ya)


def fit_gates(X, y):
    """동작마다 문지기: { 'rock': ('hand', 녹화한 손 좌표들, 봐주는 거리) }
    손이 거의 늘 보인 동작은 손 모양으로, 아니면 몸 자세로 재요. 둘 다 들쭉날쭉하면 문지기 없음"""
    gates = {}
    for name in set(y) - {NONE}:
        rows = X[y == name]
        hand, body = rows[:, 42] > 0.5, np.abs(rows[:, 43:]).sum(1) > 0
        if hand.mean() >= 0.9:
            kind, ref = "hand", rows[hand][:, :42]
        elif body.mean() >= 0.9:
            kind, ref = "body", rows[body][:, 43:]
        else:
            continue
        if len(ref) <= GATE_K:
            continue
        if len(ref) > 300:  # 너무 많으면 고르게 300개만 (빠르게)
            ref = ref[np.linspace(0, len(ref) - 1, 300).astype(int)]
        d = np.sort(np.linalg.norm(ref[:, None] - ref[None], axis=2), axis=1)[:, GATE_K]  # 0번은 자기 자신
        limit = max(GATE_FLOOR, float(np.percentile(d, 95)) * GATE_SLACK)
        if kind == "hand":  # 손을 좌우로 조금 기울인 것도 같은 동작으로 보게, 기울인 복사본도 견본에 넣음
            ref = np.vstack([ref] + [turn(ref, deg) for deg in (-GATE_TILT, GATE_TILT)])
        gates[name] = (kind, ref, limit)
    return gates


def passes_gate(gates, name, x):
    """x(61개)가 녹화해 둔 name 샘플들과 닮았나"""
    gate = gates.get(name)
    if not gate:
        return True
    kind, ref, limit = gate
    x = np.asarray(x, dtype=float)
    if kind == "hand":
        if x[42] < 0.5:
            return False  # 손으로 하는 동작인데 손이 안 보임
        q = x[:42]
    else:
        q = x[43:]
        if not np.any(q):
            return False
    return np.partition(np.linalg.norm(ref - q, axis=1), GATE_K - 1)[GATE_K - 1] <= limit


def decide(model, gates, X):
    """여러 줄을 한 번에 판별 → 이름들 (모르면 None). 시험용"""
    probs = model.predict_proba(expand(X))
    best = probs.argmax(1)
    out = []
    for x, i, p in zip(X, best, probs.max(1)):
        name = model.classes_[i]
        out.append(name if name != NONE and p >= MIN_PROB and passes_gate(gates, name, x) else None)
    return out, [model.classes_[i] for i in best]


def recordings(y):
    """녹화 묶음 번호: 파일에서 같은 이름이 이어진 구간 = 녹화 한 번"""
    return np.cumsum(np.r_[0, y[1:] != y[:-1]])


def honest_score(X, y):
    """(인식률, 헷갈리는 쌍들). 녹화마다 앞 60% 로 배우고 뒤 40% 로 시험, 거꾸로도 한 번"""
    blocks = recordings(y)
    hit = total = 0
    mixed = Counter()
    for reverse in (False, True):
        train = np.zeros(len(y), bool)
        for b in np.unique(blocks):
            idx = np.where(blocks == b)[0]
            n = len(idx) if len(idx) < 5 else int(len(idx) * 0.6)  # 너무 짧은 녹화는 전부 배우는 쪽
            train[idx[-n:] if reverse else idx[:n]] = True
        test = ~train
        if not test.any() or len(set(y[train])) < 2:
            continue
        got, raw = decide(fit_model(X[train], y[train]), fit_gates(X[train], y[train]), X[test])
        for truth, name, guess in zip(y[test], got, raw):
            total += 1
            hit += (name == truth) or (truth == NONE and name is None)
            if guess != truth:
                mixed[tuple(sorted((truth, guess)))] += 1
    return (hit / total if total else float("nan")), [pair for pair, n in mixed.most_common(3) if n >= 5]


class ActionClassifier:
    def __init__(self):
        self.model = None
        self.gates = {}
        self.lock = threading.Lock()
        self.last_train = None  # 마지막 학습 결과 (대시보드 표시용)
        self.load()

    def load(self):
        if not MODEL.exists():
            return
        with open(MODEL, "rb") as f:
            saved = pickle.load(f)
        if isinstance(saved, dict) and saved.get("version") == VERSION:
            self.model, self.gates = saved["model"], saved["gates"]
            print(f"[분류] 아는 동작: {', '.join(self.model.classes_)}", flush=True)
        else:  # 옛 방식으로 학습한 모델 → 녹화해 둔 샘플로 새 방식으로 다시 학습
            print("[분류] 옛 모델이에요. 샘플로 다시 학습해요…", flush=True)
            self.train()

    @property
    def classes(self):
        return list(self.model.classes_) if self.model is not None else []

    def predict(self, lm):
        """동작 이름 또는 None"""
        if self.model is None or (not lm.hand and not lm.pose):
            return None, 0.0
        x = features(lm)
        with self.lock:
            probs = self.model.predict_proba(expand([x]))[0]
            gates = self.gates
        i = int(probs.argmax())
        name, prob = self.model.classes_[i], float(probs[i])
        if name == NONE or prob < MIN_PROB or not passes_gate(gates, name, x):
            return None, prob
        return name, prob

    # ---------- 녹화한 샘플 ----------
    @staticmethod
    def add_sample(name, lm):
        DATA.parent.mkdir(parents=True, exist_ok=True)
        with open(DATA, "a", encoding="utf-8") as f:
            f.write(json.dumps({"name": name, "x": features(lm)}) + "\n")

    @staticmethod
    def samples():
        if not DATA.exists():
            return []
        return [json.loads(line) for line in open(DATA, encoding="utf-8") if line.strip()]

    @classmethod
    def counts(cls):
        return dict(Counter(r["name"] for r in cls.samples()))

    @classmethod
    def delete(cls, name):
        rows = [r for r in cls.samples() if r["name"] != name]
        DATA.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")

    # ---------- 대표 자세 (설정 화면의 "동작 모형"이 따라 하는 자세) ----------
    @classmethod
    def poses(cls):
        """동작마다 대표 자세 하나: 녹화한 샘플 중 "평균에 가장 가까운" 실제 샘플을 골라요.
        (그냥 평균을 내면 손가락이 뭉개질 수 있어서, 진짜로 찍힌 자세 중 가장 가운데 것을 씀)
          { 'rock': { 'count': 130, 'hand': [[x, y] × 21] 또는 None, 'pose': [[x, y] × 9] 또는 None } }
          hand : 손목이 (0, 0), 손목~중지 뿌리 길이가 1
          pose : 어깨 가운데가 (0, 0), 어깨 너비가 1. 순서는 POSE_POINTS (코, 어깨, 팔꿈치, 손목, 손끝) """
        stamp = DATA.stat().st_mtime if DATA.exists() else 0
        if cls._poses_cache[0] == stamp:
            return cls._poses_cache[1]

        def middle(rows):  # 평균에 가장 가까운 줄
            mean = [sum(col) / len(rows) for col in zip(*rows)]
            return min(rows, key=lambda r: sum((a - b) ** 2 for a, b in zip(r, mean)))

        def pairs(flat):
            return [[round(flat[i], 3), round(flat[i + 1], 3)] for i in range(0, len(flat), 2)]

        by_name = {}
        for r in cls.samples():
            by_name.setdefault(r["name"], []).append(r["x"])
        out = {}
        for name, rows in by_name.items():
            hands = [x[:42] for x in rows if x[42] > 0.5]  # 손이 보인 샘플만
            bodies = [x[43:] for x in rows if any(x[43:])]  # 몸이 보인 샘플만
            need = max(3, len(rows) * 0.3)  # 샘플의 30% 이상에서 보여야 "이 동작에 쓰인다"고 봄
            out[name] = {
                "count": len(rows),
                "hand": pairs(middle(hands)) if len(hands) >= need else None,
                "pose": pairs(middle(bodies)) if len(bodies) >= need else None,
            }
        cls._poses_cache = (stamp, out)
        return out

    _poses_cache = (None, None)

    # ---------- 학습 ----------
    def train(self):
        """RandomForest 학습 → 저장 → 바로 적용. 결과 문구를 돌려줌"""
        rows = self.samples()
        counts = Counter(r["name"] for r in rows)
        if len(counts) < 2:
            return "동작이 2개 이상 있어야 해요 (_none 포함)"
        X = np.array([r["x"] for r in rows], dtype=float)
        y = np.array([r["name"] for r in rows])
        score, mixed = honest_score(X, y)
        model, gates = fit_model(X, y), fit_gates(X, y)
        MODEL.parent.mkdir(exist_ok=True)
        with open(MODEL, "wb") as f:
            pickle.dump({"version": VERSION, "model": model, "gates": gates}, f)
        with self.lock:
            self.model, self.gates = model, gates

        # 더 정확해지려면 뭘 하면 되는지 같이 알려줌
        tips = []
        if NONE not in counts:
            tips.append("_none(평소 모습)을 녹화하세요 — 가만히 있을 때 잘못 인식되는 걸 막아요")
        if mixed:
            tips.append("서로 닮은 동작: " + ", ".join(f"{a}↔{b}" for a, b in mixed) + " — 더 다르게 다시 녹화하세요")
        once = [n for n in counts if n != NONE and len(set(recordings(y)[y == n])) < 2]
        if once:
            tips.append(f"한 번만 녹화한 동작({', '.join(sorted(once))})은 자리·거리를 바꿔 한 번 더 녹화하면 더 잘 알아봐요")
        score_text = "?" if math.isnan(score) else f"{score:.0%}"
        self.last_train = f"학습 완료 · 인식률 {score_text} · 동작 {len(counts)}개" + "".join(f"\n· {t}" for t in tips)
        print(f"[분류] {self.last_train}", flush=True)
        return self.last_train
