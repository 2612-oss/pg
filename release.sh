#!/usr/bin/env bash
# ============================================================
# release.sh — 설치 파일(dist/Snaptune.dmg)을 깃허브 Releases 에 올리기
#   ./release.sh            (버전은 package.json 의 version)
# 처음 한 번:  brew install gh   →   gh auth login   (브라우저로 깃허브 로그인)
# 올리고 나면 누구나 이 주소로 최신 버전을 받아요:
#   https://github.com/2612-oss/pg/releases/latest/download/Snaptune.dmg
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"
REPO=2612-oss/pg
VERSION="v$(node -p 'require("./package.json").version')"
command -v gh >/dev/null || { echo "gh 가 없어요: brew install gh 후 gh auth login"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "깃허브 로그인이 필요해요: gh auth login"; exit 1; }
[ -f dist/Snaptune.dmg ] || npm run dist

# 라즈베리파이 코드 묶음 — 파이의 updater.py 가 6시간마다 pi-version.txt 를 보고 새 버전이면 받아요
PI_FILES=$(cd pi && ls *.py *.html *.txt *.sh *.service *.md config.json 2>/dev/null | grep -v -e '^setup-mac.sh$' | sort)
PI_VERSION=$(cd pi && cat $PI_FILES | shasum -a 1 | cut -c1-12)
(cd pi && COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf ../dist/pi-code.tar.gz $PI_FILES)
echo "$PI_VERSION $(shasum -a 256 dist/pi-code.tar.gz | cut -d' ' -f1)" > dist/pi-version.txt
echo "파이 코드 $PI_VERSION"
ASSETS=(dist/Snaptune.dmg install.sh pi-install.sh dist/pi-code.tar.gz dist/pi-version.txt)
[ -f dist/Snaptune-notion-assets.zip ] && ASSETS+=(dist/Snaptune-notion-assets.zip)
NOTES="맥북 노치에 붙어서, 손짓 · 상황으로 음악을 틀어 주는 앱.

### 설치
터미널에 이 한 줄을 붙여 넣고 Enter (경고창 없이 설치 · 업데이트):

\`\`\`bash
curl -fsSL https://github.com/2612-oss/pg/releases/latest/download/install.sh | bash
\`\`\`

애플 실리콘(M1 이상) · macOS 13 이상.
<details><summary>터미널 없이 dmg 로</summary>

아래 Snaptune.dmg → Applications 로 끌어다 놓기 → \"열리지 않음\"이 뜨면 완료 → 시스템 설정 → 개인정보 보호 및 보안 → 맨 아래 **그래도 열기**
</details>

### 라즈베리파이 (웹캠 인식을 파이로 할 때)
파이 터미널에 한 줄. 처음 설치도, 예전 버전에서 넘어오는 것도 같은 줄이에요:

\`\`\`bash
curl -fsSL https://github.com/2612-oss/pg/releases/latest/download/pi-install.sh | bash
\`\`\`

이번 버전부터는 파이가 6시간마다 스스로 새 버전으로 바꿔요 (다시 칠 필요 없음)."
if gh release view "$VERSION" -R "$REPO" >/dev/null 2>&1; then
  gh release upload "$VERSION" "${ASSETS[@]}" -R "$REPO" --clobber   # 같은 버전이면 파일만 바꿔치기
  gh release edit "$VERSION" -R "$REPO" --notes "$NOTES"
else
  gh release create "$VERSION" "${ASSETS[@]}" -R "$REPO" --title "Snaptune ${VERSION#v}" --notes "$NOTES" --target main
fi
echo "완료: https://github.com/$REPO/releases/latest/download/Snaptune.dmg"
