#!/usr/bin/env python3

import argparse
import json
import math
import subprocess
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


def hex_color(value, alpha=255):
    value = str(value or "#FFFFFF").lstrip("#")
    if len(value) != 6:
        value = "FFFFFF"
    return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4)) + (alpha,)


@lru_cache(maxsize=64)
def resolve_font_path(candidate, family):
    if candidate and Path(candidate).exists():
        return candidate
    try:
        result = subprocess.run(
            ["fc-match", "-f", "%{file}", family],
            capture_output=True,
            text=True,
            check=False,
        )
        matched = result.stdout.strip()
        if matched and Path(matched).exists():
            return matched
    except FileNotFoundError:
        pass
    for fallback in [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/arial.ttf",
    ]:
        if Path(fallback).exists():
            return fallback
    raise RuntimeError(f"cannot resolve font file for {family}")


def font_path(event):
    candidate = event.get("font", {}).get("file")
    family = event.get("font", {}).get("family", "sans-serif")
    return resolve_font_path(candidate, family)


def fit_font(file, text, desired, maximum_width):
    size = max(12, int(desired))
    while size > 12:
        font = ImageFont.truetype(file, size)
        bounds = font.getbbox(text or " ")
        if bounds[2] - bounds[0] <= maximum_width:
            return font
        size -= 2
    return ImageFont.truetype(file, 12)


def ease(progress):
    progress = max(0.0, min(1.0, progress))
    return (1 - math.cos(math.pi * progress)) / 2


def event_alpha(frame, event, fps):
    entry = max(1, round(0.12 * fps))
    exit_frames = max(1, round(0.1 * fps))
    if frame < event["startFrame"] + entry:
        return int(255 * ease((frame - event["startFrame"]) / entry))
    if frame > event["endFrame"] - exit_frames:
        return int(255 * (1 - ease((frame - (event["endFrame"] - exit_frames)) / exit_frames)))
    return 255


def draw_shadowed_text(
    canvas,
    position,
    text,
    font,
    fill,
    alpha=255,
    anchor="mm",
    shadow_offset=3,
    shadow_blur=5,
    shadow_opacity=150,
):
    if not text:
        return
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.text(
        (position[0], position[1] + shadow_offset),
        text,
        font=font,
        fill=(18, 10, 7, min(alpha, shadow_opacity)),
        anchor=anchor,
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(shadow_blur))
    canvas.alpha_composite(shadow)
    draw = ImageDraw.Draw(canvas)
    draw.text(position, text, font=font, fill=fill[:3] + (alpha,), anchor=anchor)


def draw_inline_emphasis(canvas, event, position, maximum_width, desired, colors, alpha):
    text = event["display"]["full"]
    emphasis = event["display"].get("emphasis", "")
    file = font_path(event)
    font = fit_font(file, text, desired, maximum_width)
    if not emphasis or emphasis not in text:
        draw_shadowed_text(canvas, position, text, font, colors["primary"], alpha)
        return
    before, after = text.split(emphasis, 1)
    emphasis_font = ImageFont.truetype(file, max(12, round(font.size * 1.08)))
    draw = ImageDraw.Draw(canvas)
    parts = [
        (before, font, colors["primary"]),
        (emphasis, emphasis_font, colors["accent"]),
        (after, font, colors["primary"]),
    ]
    widths = [draw.textlength(part, font=part_font) for part, part_font, _ in parts]
    x = position[0] - sum(widths) / 2
    for (part, part_font, color), width in zip(parts, widths):
        draw_shadowed_text(
            canvas,
            (x, position[1]),
            part,
            part_font,
            color,
            alpha,
            anchor="lm",
        )
        x += width


def vertical_text_image(text, font, fill, alpha):
    bounds = font.getbbox(text)
    width = max(8, bounds[2] - bounds[0] + 24)
    height = max(8, bounds[3] - bounds[1] + 24)
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw_shadowed_text(
        image,
        (width / 2, height / 2),
        text,
        font,
        fill,
        alpha,
        shadow_offset=2,
        shadow_blur=3,
    )
    return image.rotate(90, expand=True, resample=Image.Resampling.BICUBIC)


def render_event(canvas, event, frame, layer, colors, width, height, fps):
    layout = event["layoutId"]
    depth = layout in {"oversize_background_word", "front_back_phrase"}
    if layer == "background" and not depth:
        return
    if layer == "foreground" and depth:
        pass
    elif layer == "foreground":
        pass
    elif layer != "background":
        return
    alpha = event_alpha(frame, event, fps)
    local = max(0, frame - event["startFrame"])
    progress = ease(min(1, local / max(1, round(0.18 * fps))))
    file = font_path(event)
    baseline = height * 0.69
    safe_width = width * 0.84
    if layer == "background":
        if layout == "oversize_background_word":
            text = event["display"]["background"][:2]
            size = height * (0.19 + 0.04 * progress)
            font = fit_font(file, text, size, width * 0.86)
            draw_shadowed_text(
                canvas,
                (width * 0.5, height * 0.35),
                text,
                font,
                colors["accent"],
                min(alpha, 220),
                shadow_offset=4,
                shadow_blur=8,
                shadow_opacity=90,
            )
        else:
            text = event["display"]["background"][:4]
            size = height * (0.11 + 0.02 * progress)
            font = fit_font(file, text, size, width * 0.82)
            draw_shadowed_text(
                canvas,
                (width * 0.5, height * 0.34),
                text,
                font,
                colors["primary"],
                min(alpha, 224),
                shadow_offset=4,
                shadow_blur=8,
                shadow_opacity=90,
            )
        return
    if layout == "plain_single":
        text = event["display"]["full"]
        font = fit_font(file, text, height * 0.048, safe_width)
        draw_shadowed_text(canvas, (width * 0.5, baseline), text, font, colors["primary"], alpha)
    elif layout == "logic_emphasis_inline":
        scale = 0.92 + 0.08 * progress
        draw_inline_emphasis(
            canvas,
            event,
            (width * 0.5, baseline),
            safe_width,
            height * 0.048 * scale,
            colors,
            alpha,
        )
    elif layout == "left_right_contrast":
        size = height * 0.052
        left_text = event["display"]["left"][:10]
        right_text = event["display"]["right"][:10]
        left_font = fit_font(file, left_text, size, width * 0.38)
        right_font = fit_font(file, right_text, size, width * 0.38)
        left_x = width * (0.12 + 0.13 * progress)
        right_progress = ease(max(0, min(1, (local - round(0.08 * fps)) / max(1, round(0.18 * fps)))))
        right_x = width * (0.88 - 0.13 * right_progress)
        draw_shadowed_text(
            canvas,
            (left_x, height * 0.61),
            left_text,
            left_font,
            colors["primary"],
            alpha,
        )
        draw_shadowed_text(
            canvas,
            (right_x, height * 0.61),
            right_text,
            right_font,
            colors["accent"],
            int(alpha * right_progress),
        )
    elif layout == "side_vertical_labels":
        size = height * 0.046
        left_font = fit_font(file, event["display"]["left"][:6], size, height * 0.42)
        right_font = fit_font(file, event["display"]["right"][:6], size, height * 0.42)
        left = vertical_text_image(
            event["display"]["left"][:6], left_font, colors["primary"], alpha
        )
        right = vertical_text_image(
            event["display"]["right"][:6], right_font, colors["accent"], alpha
        )
        canvas.alpha_composite(left, (round(width * 0.08 - left.width / 2), round(height * 0.49 - left.height / 2)))
        canvas.alpha_composite(right, (round(width * 0.92 - right.width / 2), round(height * 0.49 - right.height / 2)))
    elif layout == "top_bottom_hierarchy":
        top = event["display"]["top"][:10]
        bottom = event["display"]["bottom"][:14]
        top_font = fit_font(file, top, height * 0.067, width * 0.82)
        bottom_font = fit_font(file, bottom, height * 0.048, width * 0.82)
        draw_shadowed_text(
            canvas,
            (width * 0.5, height * 0.12),
            top,
            top_font,
            colors["primary"],
            alpha,
        )
        bottom_progress = ease(max(0, min(1, (local - round(0.1 * fps)) / max(1, round(0.18 * fps)))))
        draw_shadowed_text(
            canvas,
            (width * 0.5, height * 0.64),
            bottom,
            bottom_font,
            colors["accent"],
            int(alpha * bottom_progress),
        )
    elif layout == "oversize_background_word":
        text = event["display"]["foreground"]
        font = fit_font(file, text, height * 0.048, safe_width)
        draw_shadowed_text(
            canvas,
            (width * 0.5, baseline),
            text,
            font,
            colors["primary"],
            alpha,
        )
    elif layout == "front_back_phrase":
        text = event["display"]["foreground"][:8]
        font = fit_font(file, text, height * 0.058, width * 0.82)
        draw_shadowed_text(
            canvas,
            (width * 0.5, height * 0.63),
            text,
            font,
            colors["accent"],
            alpha,
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True)
    parser.add_argument("--layer", choices=["background", "foreground"], required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    plan = json.loads(Path(args.plan).read_text())
    width = int(plan["source"]["input"]["width"])
    height = int(plan["source"]["input"]["height"])
    fps = float(plan["source"]["input"]["fps"])
    duration = float(plan["source"]["input"]["duration"])
    total_frames = max(1, round(duration * fps))
    palette = plan["design"]["palette"]
    colors = {
        "primary": hex_color(palette.get("textOnDark", "#FFF8EE")),
        "accent": hex_color(palette.get("accent", "#E9A92F")),
        "dark": hex_color(palette.get("textOnLight", "#1A100B")),
    }
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{width}x{height}",
        "-r", str(fps), "-i", "-", "-an", "-c:v", "qtrle", "-pix_fmt", "argb",
        "-frames:v", str(total_frames), args.output,
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    try:
        for frame in range(total_frames):
            canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
            for event in plan["events"]:
                if event["startFrame"] <= frame < event["endFrame"]:
                    render_event(canvas, event, frame, args.layer, colors, width, height, fps)
            process.stdin.write(canvas.tobytes())
        process.stdin.close()
        return_code = process.wait()
        if return_code != 0:
            raise RuntimeError(f"ffmpeg overlay encoder exited with {return_code}")
    finally:
        if process.poll() is None:
            process.kill()


if __name__ == "__main__":
    main()
