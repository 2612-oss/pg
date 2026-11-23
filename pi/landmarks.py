"""
landmarks.py — MediaPipe 로 관절 좌표 뽑기 (몸 33점 + 손 21점)
============================================================
기획서: "MediaPipe — 몸 33점, 손 21점 관절 좌표 추출"

  PoseLandmarker : 몸 33점  (0 코, 11·12 어깨, 13·14 팔꿈치, 15·16 손목, 23·24 골반 …)
  HandLandmarker : 손 21점  (0 손목, 4 엄지 끝, 8 검지 끝, 9 중지 뿌리, 12 중지 끝 …)

여기선 "좌표만" 뽑아요. 이게 무슨 동작인지는 classifier.py(scikit-learn)가 판단해요.

좌우는 "거울 기준"으로 바꿔서 돌려줘요 (x → 1 - x).
내가 오른쪽으로 움직이면 x 가 커져요 → 맥 노치 화면과 같은 방향.
"""

import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

MODELS = Path(os.environ.get("GESTURE_HOME") or Path(__file__).parent) / "models"
HAND_MODEL = MODELS / "hand_landmarker.task"
POSE_MODEL = MODELS / "pose_landmarker_lite.task"  # lite = 파이에서도 빠른 가벼운 모델


@dataclass
class Landmarks:
    hand: list = None  # [(x, y, z)] 21개 또는 None (손이 안 보임)
    pose: list = None  # [(x, y, z, 보이는정도)] 33개 또는 None (사람이 안 보임)

    @property
    def hand_center(self):
        """손바닥 가운데 (손목과 중지 뿌리의 중간) — 스와이프 추적용"""
        if not self.hand:
            return None
        (x0, y0, _), (x9, y9, _) = self.hand[0], self.hand[9]
        return ((x0 + x9) / 2, (y0 + y9) / 2)


class Landmarker:
    def __init__(self, use_pose=True, min_conf=0.5):
        for m in (HAND_MODEL, POSE_MODEL):
            if not m.exists():
                raise SystemExit(f"모델 파일이 없어요: {m}\n  ./setup.sh 를 먼저 실행하세요.")
        video = vision.RunningMode.VIDEO  # 연속 영상 모드: 앞 프레임을 참고해서 빠름
        self.hands = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(HAND_MODEL)),
            running_mode=video, num_hands=1,  # 한 손만 (여러 손이 보이면 헷갈리니까)
            min_hand_detection_confidence=min_conf, min_hand_presence_confidence=min_conf,
            min_tracking_confidence=0.5,
        ))
        self.pose = None
        if use_pose:
            self.pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
                base_options=mp_python.BaseOptions(model_asset_path=str(POSE_MODEL)),
                running_mode=video, num_poses=1,
                min_pose_detection_confidence=min_conf, min_pose_presence_confidence=min_conf,
            ))
        self.pool = ThreadPoolExecutor(1)  # 몸 찾기를 옆 스레드에서
        self.pose_job = None  # 지금 돌고 있는 몸 찾기
        self.last_pose, self.last_pose_at = None, 0.0  # 가장 최근에 끝난 몸 결과
        self.last_ts = 0

    def detect(self, rgb):
        """RGB 프레임 → Landmarks

        손과 몸을 따로 돌려요. 파이 4 에서 몸 찾기는 사람이 보이면 한 번에 0.3초쯤 걸려서,
        매번 끝나길 기다리면 손 인식까지 1초에 2~3번으로 느려져요.
        그래서 몸은 옆 스레드에서 "끝나는 대로 다음 프레임"을 계속 돌리고, 여기선 가장 최근 몸 결과를 써요.
        몸은 손보다 천천히 움직여서 0.3초쯤 늦어도 괜찮아요. (맥은 빨라서 거의 같은 프레임 결과가 나옴)"""
        ts = max(int(time.monotonic() * 1000), self.last_ts + 1)  # VIDEO 모드는 시각이 계속 커져야 함
        self.last_ts = ts
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        out = Landmarks()

        if self.pose:
            self._collect_pose()
            if self.pose_job is None:  # 앞의 것이 끝났으면 이번 프레임으로 새로 시작
                self.pose_job = self.pool.submit(self.pose.detect_for_video, image, ts)

        r = self.hands.detect_for_video(image, ts)
        if r.hand_landmarks:
            out.hand = [(1.0 - p.x, p.y, p.z) for p in r.hand_landmarks[0]]

        if self.pose:
            self._collect_pose()  # 손 찾는 사이에 끝났으면 그 결과를 바로 씀
            if time.monotonic() - self.last_pose_at < 1.0:  # 너무 오래된 몸 결과는 안 씀
                out.pose = self.last_pose
        return out

    def _collect_pose(self):
        """몸 찾기가 끝났으면 결과를 챙겨 둠"""
        if self.pose_job is None or not self.pose_job.done():
            return
        r, self.pose_job = self.pose_job.result(), None
        self.last_pose_at = time.monotonic()
        self.last_pose = [(1.0 - p.x, p.y, p.z, p.visibility) for p in r.pose_landmarks[0]] if r.pose_landmarks else None

    def close(self):
        self.hands.close()
        if self.pose:
            self.pose.close()
