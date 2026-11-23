#!/usr/bin/env bash
# ============================================================
# pi-install.sh — 라즈베리파이에 Snaptune 인식 프로그램 설치 · 업데이트 (한 줄)
#   curl -fsSL https://github.com/2612-oss/pg/releases/latest/download/pi-install.sh | bash
#
# 처음이면: ~/gesture-pi 에 코드를 풀고 setup.sh (라이브러리 · 모델 · 자동 실행 서비스)
# 이미 있으면: 코드 파일만 새 걸로 (config.json · 녹화 · 학습은 그대로) → 다시 켜기
# 이번 버전부터는 파이가 스스로 업데이트해요 (updater.py) → 이 줄은 다시 칠 일이 거의 없어요.
# ============================================================
set -euo pipefail
# 이 줄은 라즈베리파이(리눅스)용이에요. 맥에서 치면 멈춤
if [ "$(uname -s)" != Linux ]; then
  echo "이건 라즈베리파이에서 치는 줄이에요."
  echo "맥은 앱만 설치하면 돼요 (맥북 카메라 인식은 앱이 알아서 설치):"
  echo "  curl -fsSL https://github.com/2612-oss/pg/releases/latest/download/install.sh | bash"
  echo "라즈베리파이에 접속해서(ssh 사용자@파이IP) 그 안에서 이 줄을 다시 쳐 주세요."
  exit 1
fi
BASE=https://github.com/2612-oss/pg/releases/latest/download
DIR=$(systemctl show -p WorkingDirectory --value gesture-pi 2>/dev/null || true)
case "$DIR" in ""|/) DIR="$HOME/gesture-pi" ;; esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "== 받는 중"
curl -fsSL -o "$TMP/pi-version.txt" "$BASE/pi-version.txt"
curl -fsSL -o "$TMP/pi-code.tar.gz" "$BASE/pi-code.tar.gz"
read -r VERSION DIGEST < "$TMP/pi-version.txt"
echo "$DIGEST  $TMP/pi-code.tar.gz" | sha256sum -c --quiet - || { echo "받은 파일이 맞지 않아요. 다시 시도해 주세요."; exit 1; }
mkdir -p "$TMP/code" && tar -xzf "$TMP/pi-code.tar.gz" -C "$TMP/code"

mkdir -p "$DIR"
FRESH=0
[ -d "$DIR/.venv" ] || FRESH=1
OLD_REQ=$(md5sum "$DIR/requirements.txt" 2>/dev/null | cut -d' ' -f1 || true)
for f in "$TMP"/code/*; do
  name=$(basename "$f")
  # 이 파이만의 설정은 없을 때만 넣음
  if [ "$name" = config.json ] || [ "$name" = config.local.json ]; then
    [ -e "$DIR/$name" ] || cp "$f" "$DIR/$name"
    continue
  fi
  cp "$f" "$DIR/$name"
done
chmod +x "$DIR"/*.sh
echo "$VERSION" > "$DIR/.snaptune-code"

if [ "$FRESH" = 1 ]; then
  echo "== 처음 설치 (5~15분, 라이브러리를 받아요)"
  (cd "$DIR" && ./setup.sh)
  sudo systemctl start gesture-pi
else
  if [ "$(md5sum "$DIR/requirements.txt" | cut -d' ' -f1)" != "$OLD_REQ" ]; then
    echo "== 라이브러리 업데이트"
    "$DIR/.venv/bin/pip" install -q -r "$DIR/requirements.txt"
  fi
  sudo systemctl restart gesture-pi
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "완료 ($VERSION)  ·  맥 앱: 설정 → 카메라 → 라즈베리파이 웹캠 → 주소에 $(whoami)@${IP:-파이IP} → 연결"
echo "대시보드: http://${IP:-파이IP}:8090/   로그: journalctl -u gesture-pi -f"
