# 라즈베리파이 동작 인식

웹캠을 꽂은 라즈베리파이가 동작을 알아채서 맥의 노치 앱으로 보내요.
맥은 설정에 따라 장르 플레이리스트를 틀거나 곡을 넘겨요.

**사용 기술 (기획서 그대로)**: OpenCV(웹캠) · MediaPipe(몸 33점 + 손 21점 관절 좌표) · scikit-learn(동작 분류 학습)

```
웹캠 ─▶ OpenCV ─▶ MediaPipe 관절 좌표 ─▶ scikit-learn 분류 ─▶ 오작동 방지 ─POST /gesture {"name":"rock"}─▶ 맥 노치 앱 ─▶ Spotify
                        │                                                          ◀── GET /now {"genre":"락",...} ──┘
                        └─▶ 스와이프 (손바닥 이동 거리, 학습 없음)
대시보드 http://파이:8090/  ← 카메라 화면, 녹화·학습 버튼 (맥 노치 카메라 칸에도 같은 영상)
OLED ← 장르, 곡 제목, 진행 바
```

## 파일

| 파일 | 하는 일 |
|---|---|
| `gesture_pi.py` | 메인. 매 프레임: 웹캠 → 관절 → 스와이프/동작 판별 → 오작동 방지 → 맥으로 전송. 녹화도 여기서 |
| `landmarks.py` | MediaPipe 몸 33점 + 손 21점 좌표 뽑기 |
| `classifier.py` | scikit-learn 분류: 좌표 → 숫자 61개(특징) → RandomForest → 동작 이름. 학습/샘플 관리 |
| `swipe.py` | 손바닥이 빠르게 움직이면 swipe_left/right/up/down |
| `stabilize.py` | 다수결 + 1초 유지 + 쿨다운 (기획서의 오작동 방지) |
| `web.py` + `dashboard.html` | 웹 대시보드 (영상, 녹화, 학습, 삭제) |
| `sender.py` | 맥으로 보내기 / 맥에서 지금 곡·장르 받기 |
| `oled.py` | SSD1306 OLED 표시 (없으면 건너뜀) |
| `config.json` | 맥 주소, 카메라 번호, 유지 시간, 쿨다운, 몸 인식 켜기(`use_pose`) |
| `data/samples.jsonl` | 녹화한 샘플 (자동 생성) |
| `models/actions.pkl` | 학습한 모델 (자동 생성) |

## 처음 설치 (파이에서)

```bash
cd ~/gesture-pi
./setup.sh                       # 라이브러리, MediaPipe 모델, 자동 실행 서비스
sudo systemctl start gesture-pi  # 켜기 (다음부터는 부팅하면 자동)
journalctl -u gesture-pi -f      # 로그 보기
```

직접 켜서 보고 싶으면 `./run.sh --debug` (1초마다 fps, 판별 결과 출력).

## 동작 학습시키기 (대시보드)

브라우저에서 `http://192.168.0.10:8090/` 을 열고:

1. 이름 칸에 `_none` → **녹화** → 3초 뒤 5초 동안 **아무것도 안 하는 평소 모습** (꼭 필요!)
2. `rock` → 녹화 → 락으로 쓸 동작 (예: 두 팔 들기, 🤘)
3. `pop`, `hiphop`, `jazz`, `play_pause`, `like` 도 같은 식으로
4. **학습하기** → 정확도가 나오고 바로 적용돼요

녹화할 때 조금씩 움직이고 각도를 바꿔 주면 더 잘 알아봐요. 잘 안 되는 동작은 한 번 더 녹화(샘플이 쌓임)하고 다시 학습.

이 이름들은 맥 노치 설정의 기본 제스처 이름과 같아서 학습만 하면 바로 연결돼요.

| 이름 | 맥 기본 설정 |
|---|---|
| `rock` / `pop` / `hiphop` / `jazz` | 락 / 팝 / 힙합 / 재즈 플레이리스트 |
| `play_pause` | 재생 / 일시정지 |
| `like` | 좋아요 |
| `swipe_right` / `swipe_left` (학습 없음) | 다음 / 이전 곡 |
| `swipe_up` / `swipe_down` (학습 없음) | 볼륨 + / − |

새 이름(예: `ballad`)을 녹화했다면 맥 노치 우클릭 → **설정…** 에서 장르를 추가하고 제스처 이름을 `ballad` 로.

동작은 **1초 유지**해야 보내지고, 보낸 뒤 1.5초는 쉬어요. 같은 동작을 계속 하고 있어도 한 번만 보내요.

## 고쳐보기 좋은 곳

| 바꾸고 싶은 것 | 위치 |
|---|---|
| 맥 주소 (맥 IP 가 바뀌면) | `config.json` 의 `mac` |
| 동작 유지 시간 / 쿨다운 | `config.json` 의 `hold_seconds`, `cooldown_seconds` |
| 몸 인식 끄기 (손만 써서 더 빠르게) | `config.json` 의 `use_pose: false` → 다시 녹화·학습 필요 |
| 확신도 기준 | `classifier.py` 의 `MIN_PROB` |
| 특징 만드는 법 | `classifier.py` 의 `features()` (바꾸면 다시 녹화) |
| 스와이프 예민함 | `swipe.py` 맨 위 `WINDOW`, `DIST` |
| 다수결 기준 | `stabilize.py` 의 `MAJORITY` |

## 안 될 때

- `[보냄] ... Connection refused / timed out`: 맥 노치 앱이 꺼져 있거나 `config.json` 의 맥 IP 가 틀림. 맥 VPN 을 켜면 서로 안 보여요.
- `웹캠을 열지 못했어요`: `ls /dev/video*` 로 번호 확인 후 `config.json` 의 `camera` 를 바꾸기. 계정이 `video` 그룹에 있어야 해요.
- MediaPipe 는 `0.10.18` 로 고정이에요. 1.x 는 라즈베리파이 4 CPU 에 없는 기능(AES)이 필요해서 바로 꺼져요.
