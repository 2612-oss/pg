#!/usr/bin/env bash
# ============================================================
# setup-mac.sh — 맥북 카메라로 인식할 때 처음 한 번 설치 (노치 앱이 알아서 실행해요)
# ============================================================
#   bash setup-mac.sh "설치할 폴더"
#   1) 그 폴더에 파이썬 가상환경(.venv) + 라이브러리 (MediaPipe, scikit-learn)
#   2) MediaPipe 관절 모델 내려받기
#   3) config.json (맥 주소 = 내 컴퓨터, 영상 포트 8091, OLED 없음)
# 파이용 setup.sh 와 하는 일은 같고, 서비스 등록만 없어요 (앱이 직접 켜고 끄니까).
# ============================================================
set -euo pipefail
CODE="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${1:?설치할 폴더를 적어 주세요}"
mkdir -p "$HOME_DIR/models" "$HOME_DIR/data"
cd "$HOME_DIR"

echo "== 1) 가상환경 + 라이브러리"
[ -x .venv/bin/python ] || /usr/bin/python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install "mediapipe==0.10.18" numpy scikit-learn

echo "== 2) MediaPipe 모델"
BASE=https://storage.googleapis.com/mediapipe-models
[ -s models/hand_landmarker.task ] || curl -fL -o models/hand_landmarker.task \
  $BASE/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
[ -s models/pose_landmarker_lite.task ] || curl -fL -o models/pose_landmarker_lite.task \
  $BASE/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task

echo "== 3) 설정"
[ -s config.json ] || cat > config.json <<JSON
{
  "mac": "http://127.0.0.1:${GESTURE_PORT:-8899}",
  "camera": 0,
  "width": 640,
  "height": 480,
  "hold_seconds": 1.0,
  "cooldown_seconds": 1.5,
  "stream_port": ${STREAM_PORT:-8091},
  "oled": false,
  "use_pose": true
}
JSON
.venv/bin/python -c "import mediapipe, sklearn, cv2; print('라이브러리 확인 완료')"
echo "완료"
