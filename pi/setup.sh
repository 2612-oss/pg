#!/usr/bin/env bash
# ============================================================
# setup.sh — 라즈베리파이에 처음 한 번 설치
# ============================================================
#   1) 파이썬 가상환경(.venv) 만들고 라이브러리 설치 (requirements.txt)
#   2) MediaPipe 관절 모델 내려받기 (손 21점, 몸 33점)
#   3) 부팅하면 자동으로 켜지게 서비스 등록 (gesture-pi)
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

PY=${PYTHON:-python3}

echo "== 1) 가상환경 + 라이브러리"
if ! $PY -m venv --help >/dev/null 2>&1; then
  sudo apt-get update && sudo apt-get install -y python3-venv
fi
[ -d .venv ] || $PY -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

echo "== 2) MediaPipe 모델"
mkdir -p models data
# 손 21점, 몸 33점(lite = 파이용 가벼운 모델)
BASE=https://storage.googleapis.com/mediapipe-models
[ -s models/hand_landmarker.task ] || curl -fL -o models/hand_landmarker.task \
  $BASE/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
[ -s models/pose_landmarker_lite.task ] || curl -fL -o models/pose_landmarker_lite.task \
  $BASE/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task

echo "== 2-1) OLED 한글 글꼴 (나눔고딕)"
fc-list 2>/dev/null | grep -qi nanum || sudo apt-get install -y fonts-nanum

echo "== 3) 자동 실행 서비스"
sed "s|__DIR__|$(pwd)|g; s|__USER__|$(whoami)|g" gesture-pi.service | sudo tee /etc/systemd/system/gesture-pi.service >/dev/null
# 웹캠(video), OLED(i2c, 우분투는 dialout) 를 쓸 수 있게 그룹 추가 (없는 그룹은 건너뜀)
for g in video i2c dialout; do getent group "$g" >/dev/null && sudo usermod -aG "$g" "$(whoami)"; done
sudo systemctl daemon-reload
sudo systemctl enable gesture-pi

echo "완료! 시작: sudo systemctl start gesture-pi   로그: journalctl -u gesture-pi -f"
