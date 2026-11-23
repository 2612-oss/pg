"""make_icon.py — Snaptune 아이콘 만들기 (icon.png 1024px → icon.icns)
   검은 둥근 사각형 + 보라→분홍 소리 막대 5개 + 위에 '탁' 튀는 점 (손가락 스냅)
   python3 brand/make_icon.py"""
from PIL import Image, ImageDraw, ImageFilter
import os, subprocess, shutil
S = 1024
HERE = os.path.dirname(os.path.abspath(__file__))
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# macOS 아이콘 격자: 824px 둥근 사각형, 가운데
m = (S - 824) // 2
bg = Image.new("RGBA", (S, S))
g = ImageDraw.Draw(bg)
for y in range(S):  # 위는 조금 밝은 검정 → 아래는 더 어둡게
    c = int(34 - 18 * y / S)
    g.line([(0, y), (S, y)], fill=(c, c, c + 2, 255))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([m, m, S - m, S - m], radius=185, fill=255)
img.paste(bg, (0, 0), mask)
# 소리 막대
TOP, BOTTOM = (255, 94, 168), (124, 92, 255)  # 브랜드 색: 분홍(위) → 보라(아래)
heights = [150, 250, 340, 230, 130]
w, gap = 64, 40
x0 = S // 2 - (5 * w + 4 * gap) // 2
base = S // 2 + 200
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for i, h in enumerate(heights):
    x = x0 + i * (w + gap)
    box = [x, base - h, x + w, base]
    gd.rounded_rectangle(box, radius=w // 2, fill=BOTTOM + (170,))
img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(28)))
grad = Image.new("RGBA", (S, S))
gg = ImageDraw.Draw(grad)
top_y = base - max(heights)
for y in range(S):
    t = min(1, max(0, (y - top_y) / max(heights)))
    gg.line([(0, y), (S, y)], fill=tuple(int(TOP[k] + (BOTTOM[k] - TOP[k]) * t) for k in range(3)) + (255,))
bars = Image.new("L", (S, S), 0)
bd = ImageDraw.Draw(bars)
for i, h in enumerate(heights):
    x = x0 + i * (w + gap)
    bd.rounded_rectangle([x, base - h, x + w, base], radius=w // 2, fill=255)
img.paste(grad, (0, 0), bars)
# 스냅: 가운데 막대 위 점 + 짧은 빛살 3개
cx, cy = S // 2, base - heights[2] - 100
d.ellipse([cx - 34, cy - 34, cx + 34, cy + 34], fill=(255, 255, 255, 255))
for dx, dy in [(-1, -0.55), (0, -1), (1, -0.55)]:
    sx, sy = cx + dx * 62, cy + dy * 62
    ex, ey = cx + dx * 108, cy + dy * 108
    d.line([(sx, sy), (ex, ey)], fill=(255, 255, 255, 230), width=22)
    d.ellipse([ex - 11, ey - 11, ex + 11, ey + 11], fill=(255, 255, 255, 230))
    d.ellipse([sx - 11, sy - 11, sx + 11, sy + 11], fill=(255, 255, 255, 230))
img.save(os.path.join(HERE, "icon.png"))
# .icns
iconset = os.path.join(HERE, "icon.iconset")
shutil.rmtree(iconset, ignore_errors=True)
os.makedirs(iconset)
for n in [16, 32, 128, 256, 512]:
    img.resize((n, n), Image.LANCZOS).save(f"{iconset}/icon_{n}x{n}.png")
    img.resize((n * 2, n * 2), Image.LANCZOS).save(f"{iconset}/icon_{n}x{n}@2x.png")
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(HERE, "icon.icns")], check=True)
shutil.rmtree(iconset)
print("icon.png, icon.icns")
