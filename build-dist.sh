#!/usr/bin/env bash
# ============================================================
# build-dist.sh — 다른 사람에게 줄 설치 파일(.dmg) 만들기
#   npm run dist   →  dist/Snaptune.dmg
# ============================================================
#  build-app.sh 와 같은 앱이지만
#   - 내 라즈베리파이 주소 · 내 맥 IP 는 빼요 (config.json 의 pi, piStream / pi/config.json 의 mac)
#   - /Applications 에 설치하거나 켜지 않고, 응용 프로그램 폴더 바로가기 + 설치 안내가 든 .dmg 만 만들어요
#  내가 쓰는 앱은 그대로 npm run app 으로.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1) 깨끗한 복사본 (개인 설정 빼기)
SRC="$WORK/src"
rsync -a --exclude '.DS_Store' --exclude 'pi/.venv' --exclude 'pi/models' --exclude 'pi/data' --exclude 'pi/__pycache__' \
  --exclude 'banner' --exclude 'case' --exclude 'dist' --exclude 'brand/make_icon.py' --exclude 'pi/config.local.json' --exclude 'README*' --exclude 'build-*.sh' --exclude '설치 안내.txt' ./ "$SRC/"
# 주석 속 예시 주소도 내 것 대신 가짜 주소로
perl -pi -e 's/10\.150\.\d+\.\d+/192.168.0.10/g' "$SRC/main.js"
node -e '
  const fs = require("fs"), [a, b] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(a)); delete c.pi; delete c.piStream; fs.writeFileSync(a, JSON.stringify(c, null, 2) + "\n");
  const p = JSON.parse(fs.readFileSync(b)); p.mac = "http://맥북IP:8899"; fs.writeFileSync(b, JSON.stringify(p, null, 2) + "\n");
' "$SRC/config.json" "$SRC/pi/config.json"

# 2) .app 만들기 + 서명(ad-hoc)
cat > "$WORK/extra.plist" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>LSUIElement</key><true/>
  <key>NSCameraUsageDescription</key><string>노치에서 웹캠으로 손짓을 인식하려고 카메라를 써요.</string>
  <key>NSAppleEventsUsageDescription</key><string>Apple Music(음악 앱)을 조작하고 지금 곡 정보를 읽으려고 써요.</string>
</dict></plist>
PL
VERSION="$(node -p 'require("./package.json").version')"
(cd "$SRC" && npx --yes @electron/packager@18 . "Snaptune" --platform=darwin --arch=arm64 --out="$WORK/out" --overwrite \
  --app-bundle-id=com.snaptune.app --icon="$ROOT/brand/icon.icns" --app-version="$VERSION" --extend-info="$WORK/extra.plist" >/dev/null)
APP="$WORK/out/Snaptune-darwin-arm64/Snaptune.app"
codesign --force --deep -s - "$APP"

# 3) .dmg (앱 + 응용 프로그램 바로가기 + 설치 안내)
STAGE="$WORK/dmg"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Snaptune.app"
ln -s /Applications "$STAGE/Applications"
cp "$ROOT/설치 안내.txt" "$STAGE/설치 안내.txt"
mkdir -p "$ROOT/dist"
rm -f "$ROOT/dist/Snaptune.dmg"
hdiutil create -volname "Snaptune" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$ROOT/dist/Snaptune.dmg" >/dev/null
echo "완료: $ROOT/dist/Snaptune.dmg ($(du -h "$ROOT/dist/Snaptune.dmg" | cut -f1))"
