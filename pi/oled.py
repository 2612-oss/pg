"""
oled.py — OLED(SSD1306, 128x64) 상태 표시 (기획서 4번)
============================================================
화면 종류 4가지 (가사는 가사가 없으면 상태 화면으로 바뀜)

  1) 곡 (song)    2) 시계 (clock)     3) 가사 (lyrics)      가사가 없으면 → 상태 (status)
  ┌──────────┐   ┌──────────┐      ┌──────────┐
  │[락]     ▶│   │  14:32   │      │지금 부르는 │
  │곡 제목    │   │11월 16일 (월)│   │가사 한 줄  │
  │가수       │   │▶ 곡 제목  │      │·········· │
  │> rock    │   │          │      │다음 가사   │
  │▓▓▓░░░░░░ │   │          │      │          │
  └──────────┘   └──────────┘      └──────────┘
  가사는 맥 노치가 찾은 것(LRCLIB)을 /lyrics 로 받아서, 곡 진행 위치에 맞는 줄을 보여줘요.

  상태 (status)
  ┌──────────┐   ┌──────────┐      ┌──────────┐
  │[락]     ▶│   │  14:32   │      │CPU  72°C │
  │곡 제목    │   │11월 16일 (월)│   │팬   켜짐  │
  │가수       │   │▶ 곡 제목  │      │인식 5.4fps│
  │> rock    │   │          │      │사람 보임  │
  │▓▓▓░░░░░░ │   │          │      │          │
  └──────────┘   └──────────┘      └──────────┘

OLED 를 몇 개 꽂았는지에 따라
  · 2개 이상 : 하나에 한 화면씩 고정 (config.json 의 "oled_screens" 순서대로: 곡 / 시계 / 가사)
  · 1개     : 곡 → 시계 → 가사 3장을 PAGE_SECONDS(8초)마다 넘김. 오른쪽 끝 점 3개가 지금 몇 번째 화면인지.
             동작을 유지하는 중이거나 제스처를 방금 보냈으면 곡 화면에 머무름 (게이지가 보이게)

OLED 3개 연결 (banner/oled3-wiring.png 도면)
  SSD1306 은 주소가 거의 다 0x3C 로 같아서, 한 I2C 선에 여러 개를 달 수 없어요.
  그래서 화면마다 다른 I2C 선(버스)에 달아요. 이 파이엔 /boot/firmware/config.txt 에 이미 선 2개가 더 켜져 있어요.
    1번 화면 (곡)   I2C 1 : SDA 3번 핀 (GPIO2),  SCL 5번 핀 (GPIO3)   (원래 쓰던 것)
    2번 화면 (시계) I2C 3 : SDA 11번 핀 (GPIO17), SCL 13번 핀 (GPIO27)  ← dtoverlay=i2c-gpio,bus=3,i2c_gpio_sda=17,i2c_gpio_scl=27
    3번 화면 (가사) I2C 5 : SDA 29번 핀 (GPIO5),  SCL 31번 핀 (GPIO6)   ← dtoverlay=i2c-gpio,bus=5,i2c_gpio_sda=5,i2c_gpio_scl=6
  "oled_screens": [{"bus": 1, "page": "song"}, {"bus": 3, "page": "clock"}, {"bus": 5, "page": "lyrics"}]
  안 꽂힌 화면은 15초마다 옆 스레드에서 다시 찾아봐요 (켜 둔 채로 꽂아도 됨).
  3·5번 선은 소프트웨어 I2C 라서, 화면이 없으면 찾는 데 1초쯤 걸려요 → 그래서 그리기와 따로 찾아요.

화면 출력 확인
  꽂혀 있든 아니든 화면마다 "지금 보여줄 그림"을 만들어 둬요 (screens[i].image).
  web.py 의 /api/oled 가 그 그림을 맥 설정 화면으로 보내서, OLED 를 안 봐도 무엇이 나오는지 확인할 수 있어요.
  identify() : 각 화면에 큰 번호(1, 2, 3)를 몇 초 띄움 → 어느 선이 어느 화면인지 확인

한글 글꼴: 나눔고딕을 써요 (setup.sh 가 sudo apt install fonts-nanum 으로 깔아줌).
  없으면 기본 글꼴로 바뀌는데, 그러면 한글(장르 이름, 한글 제목)이 안 보여요.
I2C 켜기: sudo raspi-config → Interface → I2C  (Ubuntu 는 /boot/firmware/config.txt 에 dtparam=i2c_arm=on)
  /dev/i2c-* 를 쓰려면 계정이 i2c 그룹에 있어야 해요: sudo usermod -aG i2c $USER

화면이 바뀔 때만 다시 그려요 (OLED 로 한 화면 보내는 데 시간이 걸려서).
"""

import threading
import time

FONTS = [  # 앞에서부터 있는 걸 씀
    "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",  # 맥 (화면 출력 확인용 그림)
]
FONT_SIZE = 12
BIG_SIZE = 30  # 시계 숫자
LINE = 14  # 한 줄 높이
PAGES = ["song", "clock", "lyrics", "status"]  # 화면 종류 (lyrics 는 가사가 없으면 status 로 바뀜)
ROTATE = ["song", "clock", "lyrics"]  # OLED 가 1개일 때 넘기는 순서
PAGE_NAMES = {"song": "곡", "clock": "시계", "lyrics": "가사", "status": "상태"}
DEFAULT_SCREENS = [{"bus": 1, "page": "song"}, {"bus": 3, "page": "clock"}, {"bus": 5, "page": "lyrics"}]
LYRIC_LEAD = 250  # 가사를 살짝 먼저 보여줘야 노래와 맞아 보임 (ms, 노치와 같음)
RETRY = 15.0  # 안 꽂힌 화면을 다시 찾는 간격 (초)
PAGE_SECONDS = 8.0
HOLD_SONG = 4.0  # 제스처를 보낸 뒤 이만큼(초)은 곡 화면에 머무름
DOTS_W = 5  # 오른쪽 끝 화면 표시 점 자리
WEEK = "월화수목금토일"


def load_font(size=FONT_SIZE):
    from PIL import ImageFont

    for path in FONTS:
        try:
            return ImageFont.truetype(path, size), True
        except OSError:
            pass
    return ImageFont.load_default(), False


def fit(draw, text, font, width):
    """글자가 width 를 넘으면 뒤를 잘라 .. 을 붙임"""
    text = text or ""
    if draw.textlength(text, font=font) <= width:
        return text
    while text and draw.textlength(text + "..", font=font) > width:
        text = text[:-1]
    return text + ".."


def draw_dots(draw, size, index, count):
    """오른쪽 끝에 세로로 점: 지금 화면은 채운 점, 나머지는 빈 점 (128x32 는 자리가 없어서 안 그림)"""
    w, h = size
    if count < 2 or h < 64:
        return
    top = h // 2 - (count * 6 - 2) // 2
    for i in range(count):
        y = top + i * 6
        box = (w - 4, y, w - 1, y + 3)
        if i == index:
            draw.rectangle(box, fill="white")
        else:
            draw.rectangle(box, outline="white")


def render(draw, font, size, now, last, candidate, hold, song, room=0):
    """곡 화면. draw 는 PIL 의 ImageDraw (OLED 가 없어도 그림 파일로 시험할 수 있게 따로 뺌)
    now: 맥의 /now 응답, last: 마지막 제스처, candidate/hold: 유지 중인 동작과 진행(0~1), song: 곡 진행(0~1)
    room: 오른쪽에 비워 둘 폭 (화면 표시 점 자리)"""
    w, h = size
    tw = w - room  # 글자를 쓸 수 있는 폭
    genre = now.get("genre") or "-"
    playing = bool(now.get("isPlaying"))

    # 1줄: 장르 칸 (흰 바탕에 검은 글씨) + 재생 상태
    gw = int(draw.textlength(genre, font=font)) + 10
    draw.rectangle((0, 0, gw, LINE), fill="white")
    draw.text((5, 0), genre, font=font, fill="black")
    if playing:
        draw.polygon([(w - 9, 2), (w - 9, 12), (w - 1, 7)], fill="white")  # ▶
    else:
        draw.rectangle((w - 9, 2, w - 7, 12), fill="white")  # Ⅱ
        draw.rectangle((w - 4, 2, w - 2, 12), fill="white")

    small = h < 64  # 128x32 짜리: 제목 한 줄만
    y = LINE + (0 if small else 2)
    holding = bool(candidate) and hold > 0

    if not small:
        draw.text((0, y), fit(draw, now.get("title") or "", font, tw), font=font, fill="white")
        draw.text((0, y + LINE), fit(draw, now.get("artist") or "", font, tw), font=font, fill="white")
        y += LINE * 2

    # 제스처 줄: 유지 중이면 게이지, 아니면 마지막 제스처 (작은 화면에선 평소에 제목)
    if holding:
        name = fit(draw, candidate, font, 54)
        draw.text((0, y), name, font=font, fill="white")
        x0 = 60
        draw.rectangle((x0, y + 2, tw - 1, y + 11), outline="white")
        draw.rectangle((x0, y + 2, x0 + int((tw - 1 - x0) * min(1.0, hold)), y + 11), fill="white")
    elif small:
        draw.text((0, y), fit(draw, now.get("title") or "", font, tw), font=font, fill="white")
    else:
        draw.text((0, y), fit(draw, f"> {last}" if last else "> -", font, tw), font=font, fill="white")

    # 맨 아래: 곡 진행 바
    top = h - (2 if small else 5)
    draw.rectangle((0, top, w - 1, h - 1), outline="white")
    if song > 0:
        draw.rectangle((0, top, int((w - 1) * min(1.0, song)), h - 1), fill="white")


def render_clock(draw, font, big, size, now, clock, room=0):
    """시계 화면: 큰 시각, 날짜, (재생 중이면) 곡 제목"""
    w, h = size
    tw = w - room
    hhmm = time.strftime("%H:%M", clock)
    small = h < 64
    if small:  # 128x32: 시각 + 날짜 한 줄
        draw.text((0, 0), hhmm, font=big, fill="white")
        draw.text((int(draw.textlength(hhmm, font=big)) + 6, 9), f"{clock.tm_mon}/{clock.tm_mday}", font=font, fill="white")
        return
    x = (tw - draw.textlength(hhmm, font=big)) / 2
    draw.text((x, 0), hhmm, font=big, fill="white")
    date = f"{clock.tm_mon}월 {clock.tm_mday}일 ({WEEK[clock.tm_wday]})"
    draw.text(((tw - draw.textlength(date, font=font)) / 2, 34), date, font=font, fill="white")
    if now.get("title"):
        mark = "▶ " if now.get("isPlaying") else "Ⅱ "
        line = fit(draw, mark + now["title"], font, tw)
        draw.text(((tw - draw.textlength(line, font=font)) / 2, 50), line, font=font, fill="white")


def render_status(draw, font, size, info, room=0):
    """상태 화면: CPU 온도, 팬, 인식 속도, 사람이 보이는지"""
    w, h = size
    tw = w - room
    temp = info.get("temp")
    fan = info.get("fan")
    rows = [
        ("CPU", "-" if temp is None else f"{temp:.0f}°C" + (" 뜨거움" if temp >= 80 else "")),
        ("팬", {"on": "켜짐", "off": "꺼짐"}.get(fan, "조절 안 함")),
        ("인식", f"{info.get('fps', 0):.1f}fps"),
        ("사람", "보임" if info.get("present") else "안 보임"),
    ]
    if h < 64:
        rows = rows[:2]
    for i, (label, value) in enumerate(rows):
        y = i * (h // len(rows))
        draw.text((0, y), label, font=font, fill="white")
        draw.text((34, y), fit(draw, value, font, tw - 34), font=font, fill="white")


def wrap(draw, text, font, width, rows):
    """긴 가사를 width 에 맞춰 여러 줄로 (띄어쓰기에서 먼저 자름). 줄이 rows 개를 넘으면 마지막 줄 끝을 .."""
    out, line = [], ""
    for word in text.split(" "):
        test = f"{line} {word}" if line else word
        if draw.textlength(test, font=font) <= width:
            line = test
            continue
        if line:
            out.append(line)
        while draw.textlength(word, font=font) > width:  # 한 단어가 한 줄보다 길면 글자 단위로
            cut = len(word)
            while cut > 1 and draw.textlength(word[:cut], font=font) > width:
                cut -= 1
            out.append(word[:cut])
            word = word[cut:]
        line = word
    if line:
        out.append(line)
    if len(out) > rows:
        out = out[:rows - 1] + [fit(draw, " ".join(out[rows - 1:]), font, width)]
    return out


def lyric_lines(now):
    """가사가 있으면 (지금 줄 번호, 지금 줄, 다음 줄). 없으면 None
    줄 번호 -1 = 첫 가사 전 (전주)"""
    lines = now.get("_lyrics")
    if not lines:
        return None
    pos = (now.get("progress") or 0) + LYRIC_LEAD
    if now.get("isPlaying") and now.get("_at"):
        pos += (time.monotonic() - now["_at"]) * 1000
    i = -1
    while i + 1 < len(lines) and lines[i + 1]["t"] <= pos:
        i += 1
    cur = lines[i]["text"] if i >= 0 else ""
    nxt = next((l["text"] for l in lines[i + 1:] if l["text"]), "")
    return i, cur, nxt


def render_lyrics(draw, font, size, lyric, room=0):
    """가사 화면: 지금 줄(최대 3줄로 접음) + 가는 선 + 다음 줄"""
    w, h = size
    tw = w - room
    _, cur, nxt = lyric
    small = h < 64
    rows = wrap(draw, cur, font, tw, 2 if small else 3) if cur else ["♪"]
    top = 0 if small else max(0, (42 - len(rows) * LINE) // 2)  # 위쪽 42px 가운데쯤
    for k, row in enumerate(rows):
        draw.text((0, top + k * LINE), row, font=font, fill="white")
    if not small and nxt:
        for x in range(0, tw, 3):  # 점선
            draw.point((x, 46), fill="white")
        draw.text((0, 50), fit(draw, nxt, font, tw), font=font, fill="white")


def render_identify(draw, big, font, size, number, bus, page):
    """화면 번호 확인: 큰 번호 + 어느 I2C 선인지 + 무슨 화면을 맡았는지"""
    w, h = size
    draw.rectangle((0, 0, w - 1, h - 1), outline="white")
    draw.text((8, (h - 30) // 2 - 4), str(number), font=big, fill="white")
    draw.text((40, 6 if h >= 64 else 2), f"I2C {bus}", font=font, fill="white")
    draw.text((40, 24 if h >= 64 else 16), f"{PAGE_NAMES.get(page, page)} 화면", font=font, fill="white")


def song_ratio(now):
    """곡이 얼마나 지났는지 0~1. 맥에 1초에 한 번만 물어보니까 그 사이는 시계로 더해요"""
    dur = now.get("duration") or 0
    if not dur:
        return 0.0
    pos = now.get("progress") or 0
    if now.get("isPlaying") and now.get("_at"):
        pos += (time.monotonic() - now["_at"]) * 1000
    return max(0.0, min(1.0, pos / dur))


class Screen:
    """OLED 하나 (안 꽂혀 있어도 그림은 만들어 둠 → 화면 출력 확인용)"""

    def __init__(self, number, bus, page, height):
        self.number, self.bus, self.page, self.height = number, bus, page, height
        self.device = None
        self.tried_at = -RETRY
        self.trying = False
        self.key = None  # 마지막으로 그린 내용
        self.image = None  # 마지막으로 그린 그림 (PIL, 128 x height)
        self.shown = page  # 지금 보여주는 화면 (넘기기 중엔 바뀜)

    @property
    def connected(self):
        return self.device is not None

    def connect(self, now, wait=False):
        """15초에 한 번만, 옆 스레드에서 찾아봄 (화면이 없는 선은 찾는 데 1초쯤 걸려서 그리기를 막지 않게).
        wait=True 면 끝날 때까지 기다림 (켤 때 한 번)"""
        if self.device or self.trying or now - self.tried_at < RETRY:
            return
        self.tried_at, self.trying = now, True
        job = threading.Thread(target=self._find, daemon=True)
        job.start()
        if wait:
            job.join(3.0)

    def _find(self):
        try:
            from luma.core.interface.serial import i2c
            from luma.oled.device import ssd1306

            device = ssd1306(i2c(port=self.bus, address=0x3C), height=self.height)
            self.key = None  # 처음부터 다시 그리게
            self.device = device
            print(f"[OLED] {self.number}번 화면 연결됨 (I2C {self.bus}, {PAGE_NAMES.get(self.page)})", flush=True)
        except Exception:
            self.device = None
        finally:
            self.trying = False

    def send(self, image):
        if not self.device:
            return
        try:
            self.device.display(image)
        except Exception as e:  # 선이 빠짐 → 나중에 다시 찾음
            print(f"[OLED] {self.number}번 화면 끊김 (I2C {self.bus}, {e.__class__.__name__})", flush=True)
            self.device = None


class Oled:
    def __init__(self, cfg=None):
        cfg = cfg or {}
        self.enabled = cfg.get("oled", True)
        height = int(cfg.get("oled_height", 64))  # 128x32 짜리면 config.json 에 "oled_height": 32
        self.pages = [p for p in (cfg.get("oled_pages") or ROTATE) if p in PAGES] or ["song"]
        self.page_seconds = max(2.0, float(cfg.get("oled_page_seconds", PAGE_SECONDS)))
        wanted = cfg.get("oled_screens") or DEFAULT_SCREENS
        self.screens = [Screen(i + 1, int(s.get("bus", 1)), s.get("page") if s.get("page") in PAGES else PAGES[i % 3],
                               int(s.get("height", height))) for i, s in enumerate(wanted)]
        self.page, self.page_at = 0, time.monotonic()
        self.last_seen_gesture, self.gesture_at = None, 0.0
        self.identify_until = 0.0
        self.font, korean = load_font()
        self.big, _ = load_font(BIG_SIZE)
        self.big32, _ = load_font(22)
        if self.enabled:
            for s in self.screens:
                s.connect(time.monotonic(), wait=True)
            got = [s for s in self.screens if s.connected]
            print(f"[OLED] {len(got)}개 연결됨 ({', '.join(f'{s.number}번 I2C {s.bus}' for s in got) or '없음'})"
                  f"{'' if korean else ', 한글 글꼴 없음: sudo apt install fonts-nanum'}", flush=True)

    @property
    def rotating(self):
        """꽂힌 화면이 하나뿐이면 그 화면 하나가 3장을 넘겨요"""
        return sum(s.connected for s in self.screens) <= 1

    def identify(self, seconds=5.0):
        """각 화면에 큰 번호를 seconds 초 동안 띄움"""
        self.identify_until = time.monotonic() + seconds
        for s in self.screens:  # 꽂아 둔 화면이 있으면 바로 다시 찾아봄
            s.tried_at = -RETRY

    def rotate_page(self, last, holding):
        """넘기기: 지금 보여줄 화면 이름. 동작을 유지 중이거나 제스처를 방금 보냈으면 곡 화면에 머무름"""
        t = time.monotonic()
        if last != self.last_seen_gesture:
            self.last_seen_gesture, self.gesture_at = last, t
        if "song" in self.pages and (holding or t - self.gesture_at < HOLD_SONG):
            self.page, self.page_at = self.pages.index("song"), t  # 끝나면 곡 화면부터 다시 8초
        elif t - self.page_at >= self.page_seconds:
            self.page, self.page_at = (self.page + 1) % len(self.pages), t
        return self.pages[self.page]

    def show(self, now, last, candidate, hold, info=None):
        """info: 상태 화면용 { 'temp', 'fan', 'fps', 'present' }"""
        from PIL import Image, ImageDraw

        now, info = now or {}, info or {}
        t = time.monotonic()
        if self.enabled:
            for s in self.screens:
                s.connect(t)
        rotating = self.rotating
        page_now = self.rotate_page(last, bool(candidate) and hold > 0) if rotating else None
        identify = t < self.identify_until
        song = song_ratio(now)
        clock = time.localtime()
        main = self._main()
        for s in self.screens:
            # 넘기기 중엔: 꽂힌 그 하나(main)가 넘기고, 나머지(미리보기)는 맡은 화면 그대로
            page = page_now if rotating and s is main else s.page
            lyric = lyric_lines(now) if page == "lyrics" else None
            if page == "lyrics" and lyric is None:
                page = "status"  # 가사가 없으면 상태 화면
            s.shown = page
            dots = rotating and s is main and len(self.pages) > 1 and s.height >= 64
            w, h = 128, s.height
            room = DOTS_W if dots else 0
            # 화면에 보이는 것이 하나라도 바뀌었을 때만 다시 그림
            if identify:
                key = ("identify", s.number)
            elif page == "song":
                key = (page, now.get("genre"), now.get("title"), now.get("artist"), bool(now.get("isPlaying")),
                       last, candidate if hold > 0 else None, round(hold * 16), int(song * w))
            elif page == "clock":
                key = (page, clock.tm_hour, clock.tm_min, clock.tm_mday, now.get("title"), bool(now.get("isPlaying")))
            elif page == "lyrics":
                key = (page, now.get("id"), lyric[0])
            else:
                key = (page, round(info.get("temp") or 0), info.get("fan"), round(info.get("fps", 0)), bool(info.get("present")))
            key = (key, dots and self.page, s.connected)
            if key == s.key:
                continue
            s.key = key
            img = Image.new("1", (w, h), 0)
            d = ImageDraw.Draw(img)
            if identify:
                render_identify(d, self.big if h >= 64 else self.big32, self.font, (w, h), s.number, s.bus, s.page)
            elif page == "song":
                render(d, self.font, (w, h), now, last, candidate, hold, song, room)
            elif page == "clock":
                render_clock(d, self.font, self.big if h >= 64 else self.big32, (w, h), now, clock, room)
            elif page == "lyrics":
                render_lyrics(d, self.font, (w, h), lyric, room)
            else:
                render_status(d, self.font, (w, h), info, room)
            if dots and not identify:
                draw_dots(d, (w, h), self.page, len(self.pages))
            s.image = img
            s.send(img)

    def _main(self):
        """넘기기를 맡는 화면: 꽂힌 것, 없으면 첫 번째"""
        return next((s for s in self.screens if s.connected), self.screens[0])

    def preview(self):
        """화면 출력 확인용: [{ number, bus, page, shown, connected, png(base64) }]"""
        import base64
        import io

        out = []
        for s in self.screens:
            png = None
            if s.image is not None:
                buf = io.BytesIO()
                s.image.save(buf, "PNG")
                png = base64.b64encode(buf.getvalue()).decode()
            out.append({"number": s.number, "bus": s.bus, "page": s.page, "shown": s.shown,
                        "connected": s.connected, "height": s.height, "png": png})
        return {"enabled": bool(self.enabled), "rotating": self.rotating, "screens": out,
                "names": PAGE_NAMES, "identify": time.monotonic() < self.identify_until}


if __name__ == "__main__":
    # 시험: python oled.py  → oled-test.png 로 화면 모양 저장 (OLED 없이도 됨)
    #   윗줄 128x64 (곡 / 곡·게이지 / 시계 / 상태), 아랫줄 128x32
    from PIL import Image, ImageDraw

    font, _ = load_font()
    big, _ = load_font(BIG_SIZE)
    big32, _ = load_font(22)
    now = {"genre": "힙합", "title": "Curious George", "artist": "Nate Rose", "isPlaying": True, "progress": 60000, "duration": 180000}
    long = {"genre": "락", "title": "아주 긴 한글 제목이 들어가면 이렇게 잘려요", "artist": "가수 이름", "isPlaying": False, "progress": 150000, "duration": 180000}
    info = {"temp": 72.4, "fan": "on", "fps": 5.4, "present": True}
    clock = time.strptime("2026-11-16 14:32", "%Y-%m-%d %H:%M")
    shots = [
        ("song", lambda d, s: render(d, font, s, now, "hiphop", None, 0.0, song_ratio(now), DOTS_W), 0),
        ("song", lambda d, s: render(d, font, s, long, "swipe_right", "rock", 0.6, song_ratio(long), DOTS_W), 0),
        ("clock", lambda d, s: render_clock(d, font, big if s[1] >= 64 else big32, s, now, clock, DOTS_W), 1),
        ("status", lambda d, s: render_status(d, font, s, info, DOTS_W), 2),
    ]
    def paint_small(d, s, page):  # 128x32 는 점 자리 없이
        if page == 0:
            render(d, font, s, long if d is None else now, "hiphop", None, 0.0, song_ratio(now))
        elif page == 1:
            render_clock(d, font, big32, s, now, clock)
        else:
            render_status(d, font, s, info)

    sheet = Image.new("1", (132 * len(shots) - 4, 64 + 4 + 32), 0)
    for i, (_, paint, page) in enumerate(shots):
        for h, oy in ((64, 0), (32, 68)):
            img = Image.new("1", (128, h), 0)
            d = ImageDraw.Draw(img)
            paint(d, (128, h)) if h >= 64 else paint_small(d, (128, h), page)
            draw_dots(d, (128, h), page, 3)
            sheet.paste(img, (i * 132, oy))
    sheet.resize((sheet.width * 4, sheet.height * 4), Image.NEAREST).save("oled-test.png")
    print("oled-test.png 저장")
