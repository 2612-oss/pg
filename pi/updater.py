"""
updater.py — 라즈베리파이가 스스로 새 버전으로 바꾸기
============================================================
맥 앱을 업데이트할 때마다 파이 코드도 손으로 바꾸지 않아도 되게,
파이가 켜질 때와 6시간마다 깃허브 최신 릴리스를 확인해요.

  pi-version.txt   "버전 sha256"   (release.sh 가 만듦)
  pi-code.tar.gz   파이 코드 묶음

새 버전이면:
  1) 묶음을 받아서 sha256 이 맞는지 확인 (중간에 깨졌거나 바뀌었으면 안 씀)
  2) 코드 파일만 덮어씀 — config.json · config.local.json(이 파이의 설정), data/ models/ .venv 는 그대로
  3) requirements.txt 가 바뀌었으면 pip install
  4) 프로그램을 끝냄 → 서비스(Restart=always)가 3초 뒤 새 코드로 다시 켬

받는 곳은 아래 REPO 의 HTTPS 주소 하나뿐이에요 (같은 와이파이의 누가 코드를 밀어 넣을 수 없음).
끄고 싶으면 config.json 에 "auto_update": false
"""

import hashlib
import io
import os
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
from pathlib import Path

REPO = "2612-oss/pg"
BASE = f"https://github.com/{REPO}/releases/latest/download"
HERE = Path(__file__).parent
VERSION_FILE = HERE / ".snaptune-code"
KEEP = {"config.json", "config.local.json"}  # 이 파이만의 설정 — 절대 안 덮어씀
EVERY = 6 * 3600


def local_version():
    try:
        return VERSION_FILE.read_text().strip()
    except OSError:
        return ""


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "snaptune-pi-updater"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def check_once():
    """새 버전이 있으면 바꾸고 True (그러면 다시 켜야 함)"""
    remote = fetch(f"{BASE}/pi-version.txt").decode().split()
    if len(remote) != 2:
        return False
    version, digest = remote
    if version == local_version():
        return False
    blob = fetch(f"{BASE}/pi-code.tar.gz", timeout=60)
    if hashlib.sha256(blob).hexdigest() != digest:
        print("[업데이트] 받은 파일이 맞지 않아서 건너뜀", flush=True)
        return False
    old_req = (HERE / "requirements.txt").read_bytes() if (HERE / "requirements.txt").exists() else b""
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        for m in tar.getmembers():
            name = Path(m.name).name
            # 폴더 없이 파일만, 이상한 경로(../ 등) 막기, 설정 파일은 그대로
            if not m.isfile() or "/" in m.name.strip("./") or name in KEEP or name.startswith("."):
                continue
            data = tar.extractfile(m).read()
            tmp = HERE / f".{name}.new"
            tmp.write_bytes(data)
            os.chmod(tmp, 0o755 if name.endswith(".sh") else 0o644)
            tmp.replace(HERE / name)
    new_req = (HERE / "requirements.txt").read_bytes()
    pip = HERE / ".venv" / "bin" / "pip"
    if new_req != old_req and pip.exists():
        print("[업데이트] 라이브러리 설치 중…", flush=True)
        subprocess.run([str(pip), "install", "-q", "-r", str(HERE / "requirements.txt")], check=False)
    VERSION_FILE.write_text(version + "\n")
    print(f"[업데이트] {version} 으로 바꿨어요 → 다시 켜요", flush=True)
    return True


def start(cfg):
    """백그라운드에서 확인. 맥북 카메라 모드(맥 앱이 켬)는 앱이 코드를 들고 있어서 안 함"""
    if os.environ.get("GESTURE_HOME") or not sys.platform.startswith("linux") or cfg.get("auto_update") is False:
        return
    if not (HERE / ".venv").exists():  # 서비스로 설치된 파이에서만
        return

    def loop():
        time.sleep(20)  # 켜자마자는 카메라·네트워크 준비 시간
        while True:
            try:
                if check_once():
                    sys.stdout.flush()
                    os._exit(0)  # 서비스가 새 코드로 다시 켬
            except Exception as e:  # 인터넷이 없거나 깃허브가 안 됨 → 다음에
                print(f"[업데이트] 확인 못 함: {e}", flush=True)
            time.sleep(EVERY)

    threading.Thread(target=loop, daemon=True).start()


if __name__ == "__main__":  # 손으로: .venv/bin/python updater.py
    print("바꿨어요" if check_once() else "최신이에요")
