"""
标注检查图：把 annotation.json 的区域、顺序方向和手部路径画到线稿图上，
供人工核对区域划分、叙事顺序与时序（咔嚓 vendored 版）。

与上游的差异（见 README.md 补丁清单）：
  - 字体可移植：不再硬编码 Windows 字体；按 --font 参数、
    KACHA_WHITEBOARD_PREVIEW_FONT 环境变量、常见平台字体路径、PIL 默认字体的
    顺序解析，任何平台都能出图。
  - 防御式读取：label / reveal.direction / handPath 缺失时跳过对应绘制并
    打印提示，不再 KeyError（这些是创作元数据，validate 允许缺失）。

用法：
  python3 annotation_preview.py <图片路径> <标注路径> <预览图输出路径> [--font 字体文件]
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

_FONT_CANDIDATES = [
    # macOS 中文
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    # Windows 中文
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    # Linux 常见
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def _load_font(size: int, override: str | None):
    candidates = []
    if override:
        candidates.append(override)
    env_font = os.environ.get("KACHA_WHITEBOARD_PREVIEW_FONT")
    if env_font:
        candidates.append(env_font)
    candidates.extend(_FONT_CANDIDATES)
    for path in candidates:
        try:
            if path and Path(path).is_file():
                return ImageFont.truetype(path, size)
        except OSError:
            continue
    print("[warn] 未找到可用的 TTF/OTF 字体，使用 PIL 默认字体（中文标签可能无法显示）")
    return ImageFont.load_default()


def main() -> int:
    parser = argparse.ArgumentParser(description="白板动画标注检查图")
    parser.add_argument("image", help="线稿图路径")
    parser.add_argument("annotation", help="annotation.json 路径")
    parser.add_argument("output", help="预览图输出路径")
    parser.add_argument("--font", default=None, help="字体文件路径")
    args = parser.parse_args()

    image = Image.open(args.image).convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = _load_font(28, args.font)
    small_font = _load_font(18, args.font)
    colors = [(38, 103, 255, 225), (255, 105, 92, 225), (41, 167, 102, 225), (181, 100, 255, 225)]

    data = json.loads(Path(args.annotation).read_text(encoding="utf-8"))
    for index, element in enumerate(data["elements"], start=1):
        region = element["region"]
        x, y = region["x"], region["y"]
        right, bottom = x + region["width"], y + region["height"]
        color = colors[(index - 1) % len(colors)]
        fill = (*color[:3], 24)
        draw.rounded_rectangle((x, y, right, bottom), radius=12, outline=color, width=4, fill=fill)
        draw.ellipse((x + 8, y + 8, x + 44, y + 44), fill=color)
        draw.text((x + 19, y + 8), str(index), anchor="ma", font=small_font, fill="white")
        label = element.get("label") or ""
        direction = (element.get("reveal") or {}).get("direction") or "?"
        text = f"{index}. {label}  {direction}"
        draw.rounded_rectangle((x + 52, y + 8, min(right - 8, x + 52 + len(text) * 19), y + 46), radius=6, fill=(255, 255, 255, 225))
        draw.text((x + 60, y + 12), text, font=small_font, fill=color)
        hand = element.get("handPath")
        if not hand or not hand.get("start") or not hand.get("end"):
            print(f"[warn] 元素 {element.get('id', index)} 缺少 handPath，跳过笔走方向绘制")
            continue
        start = tuple(hand["start"])
        end = tuple(hand["end"])
        draw.line((start, end), fill=color, width=4)
        draw.polygon((end, (end[0] - 13, end[1] - 7), (end[0] - 13, end[1] + 7)), fill=color)

    result = Image.alpha_composite(image, overlay).convert("RGB")
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    result.save(args.output, quality=95)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
