#!/usr/bin/env bash
# ============================================================
# build-app.sh — 코드를 고친 뒤 "Snaptune.app" 을 다시 만들어 응용 프로그램 폴더에 넣기
#   npm run app   (또는 ./build-app.sh)
# ============================================================
#  1) @electron/packager 로 .app 만들기 (README 는 빼고. pi 폴더의 인식 코드는 맥북 카메라용으로 같이 넣음)
#  2) 서명(ad-hoc) — 애플 실리콘 맥은 서명이 없으면 실행이 안 돼요
#  3) 켜져 있는 앱을 끄고 /Applications 에 덮어쓰기 → 다시 켜기
set -euo pipefail
cd "$(dirname "$0")"
OUT="$(mktemp -d)"

cat > "$OUT/extra.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>LSUIElement</key><true/>
  <key>NSCameraUsageDescription</key><string>노치에서 웹캠으로 손짓을 인식하려고 카메라를 써요.</string>
  <key>NSAppleEventsUsageDescription</key><string>Apple Music(음악 앱)을 조작하고 지금 곡 정보를 읽으려고 써요.</string>
</dict></plist>
EOF
# LSUIElement = 독에 아이콘 없이 실행 (노치에만 보이는 앱)

npx --yes @electron/packager@18 . "Snaptune" --platform=darwin --arch=arm64 --out="$OUT" --overwrite \
  --app-bundle-id=com.snaptune.app --icon=brand/icon.icns --extend-info="$OUT/extra.plist" \
  --ignore='^/pi/(\.venv|models|data|__pycache__)($|/)' --ignore='^/banner($|/)' --ignore='^/case($|/)' --ignore='^/brand/make_icon\.py' --ignore='^/pi/config\.local\.json' --ignore='^/README' --ignore='^/build-(app|dist)\.sh' --ignore='^/dist($|/)' --ignore='^/설치 안내\.txt' --ignore='\.DS_Store'

APP="$OUT/Snaptune-darwin-arm64/Snaptune.app"
codesign --force --deep -s - "$APP"

osascript -e 'quit app "Snaptune"' 2>/dev/null || true
osascript -e 'quit app "Spotify Notch"' 2>/dev/null || true   # 예전 이름
rm -rf "/Applications/Spotify Notch.app"
sleep 1
rm -rf "/Applications/Snaptune.app"
ditto "$APP" "/Applications/Snaptune.app"
rm -rf "$OUT"
open "/Applications/Snaptune.app"
echo "완료: /Applications/Snaptune.app"
