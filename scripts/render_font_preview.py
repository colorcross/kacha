#!/usr/bin/env python3

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def fit_font(font_file, text, maximum_width, maximum_height):
    size = 112
    while size >= 32:
        font = ImageFont.truetype(str(font_file), size=size)
        box = font.getbbox(text)
        width = box[2] - box[0]
        height = box[3] - box[1]
        if width <= maximum_width and height <= maximum_height:
            return font, box
        size -= 2
    font = ImageFont.truetype(str(font_file), size=32)
    return font, font.getbbox(text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--font", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--text", required=True)
    args = parser.parse_args()

    font_file = Path(args.font).resolve()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    image = Image.new("RGB", (1280, 720), "#F7E8C9")
    draw = ImageDraw.Draw(image)
    font, box = fit_font(font_file, args.text, 1100, 260)
    width = box[2] - box[0]
    height = box[3] - box[1]
    x = (image.width - width) / 2 - box[0]
    y = (image.height - height) / 2 - box[1]
    draw.text(
        (x + 4, y + 8),
        args.text,
        font=font,
        fill="#A28F76",
    )
    draw.text((x, y), args.text, font=font, fill="#24150F")
    image.save(output)


if __name__ == "__main__":
    main()
