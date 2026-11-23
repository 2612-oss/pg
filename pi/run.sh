#!/usr/bin/env bash
# 직접 켜서 로그 보기 (서비스로 켜져 있으면 카메라가 겹치니 먼저 끔)
cd "$(dirname "$0")"
sudo systemctl stop gesture-pi 2>/dev/null || true
exec .venv/bin/python -u gesture_pi.py "$@"
