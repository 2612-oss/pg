#!/usr/bin/env bash
# ============================================================
# install.sh — Snaptune 한 줄 설치 (경고창 없이)
#   curl -fsSL https://github.com/2612-oss/pg/releases/latest/download/install.sh | bash
# ============================================================
# 브라우저로 받은 앱은 맥이 "확인되지 않은 개발자" 표시를 붙여서 처음에 막혀요 (애플 공증을 안 받은 앱이라).
# 터미널(curl)로 받으면 그 표시가 안 붙어서 바로 열려요. 하는 일은 이게 전부예요:
#   최신 Snaptune.dmg 받기 → 열기 → Snaptune.app 을 /Applications 에 복사 → 닫기 → 앱 켜기
set -euo pipefail
URL="https://github.com/2612-oss/pg/releases/latest/download/Snaptune.dmg"
APP="/Applications/Snaptune.app"

if [ "$(uname -m)" != "arm64" ]; then
  echo "Snaptune 은 애플 실리콘(M1 이상) 맥에서만 돼요. 이 맥은 $(uname -m) 이에요."
  exit 1
fi

TMP="$(mktemp -d)"
MNT="$TMP/mnt"
cleanup() { hdiutil detach "$MNT" -quiet 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "▶ Snaptune 받는 중… (100MB 쯤)"
curl -fL --progress-bar -o "$TMP/Snaptune.dmg" "$URL"

echo "▶ 설치하는 중…"
mkdir -p "$MNT"
hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MNT" "$TMP/Snaptune.dmg"
osascript -e 'quit app "Snaptune"' 2>/dev/null || true
sleep 1
rm -rf "$APP"
ditto "$MNT/Snaptune.app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "✓ 설치했어요: $APP"
open "$APP"
echo "  노치에 마우스를 올리면 [Spotify 로그인] 버튼이 보여요. (독에는 아이콘이 없어요)"
