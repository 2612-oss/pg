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
NOTES="맥북 노치에 붙어서, 손짓 · 상황으로 음악을 틀어 주는 앱.

**설치**: Snaptune.dmg 받기 → 열고 Snaptune 을 Applications 로 끌어다 놓기
처음 열 때 \"열리지 않음\"이 뜨면 → 완료 → 시스템 설정 → 개인정보 보호 및 보안 → 맨 아래 **그래도 열기**

**경고 없이 한 줄로 설치**: 터미널에
\`curl -fsSL https://github.com/2612-oss/pg/releases/latest/download/install.sh | bash\`
(애플 실리콘 · macOS 13 이상. 자세한 건 dmg 안의 설치 안내.txt)"
if gh release view "$VERSION" -R "$REPO" >/dev/null 2>&1; then
  gh release upload "$VERSION" dist/Snaptune.dmg install.sh -R "$REPO" --clobber   # 같은 버전이면 파일만 바꿔치기
  gh release edit "$VERSION" -R "$REPO" --notes "$NOTES"
else
  gh release create "$VERSION" dist/Snaptune.dmg install.sh -R "$REPO" --title "Snaptune ${VERSION#v}" --notes "$NOTES" --target main
fi
echo "완료: https://github.com/$REPO/releases/latest/download/Snaptune.dmg"
