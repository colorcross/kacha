#!/usr/bin/env python3

import argparse
import json
import math
import os
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


def font_path(event, slot="display"):
    selected = event.get("typography", {}).get(slot) or event.get("font", {})
    candidate = selected.get("file")
    family = selected.get("family", "sans-serif")
    return resolve_font_path(candidate, family)


def fit_font(file, text, desired, maximum_width):
    minimum_size = max(8, int(desired * 0.75))
    size = max(minimum_size, int(desired))
    while size >= minimum_size:
        font = ImageFont.truetype(file, size)
        bounds = font.getbbox(text or " ")
        if bounds[2] - bounds[0] <= maximum_width:
            return font
        size -= 1
    raise RuntimeError(
        f"text cannot fit the safe width without violating minimum type scale: {text}"
    )


def ease(progress):
    progress = max(0.0, min(1.0, progress))
    return (1 - math.cos(math.pi * progress)) / 2


def event_alpha(frame, event, fps):
    motion = event.get("textScene", {}).get("motion", {})
    entry = max(1, int(motion.get("entryFrames", round(0.12 * fps))))
    exit_frames = max(1, round(0.1 * fps))
    if motion.get("id") != "cut" and frame < event["startFrame"] + entry:
        return int(255 * ease((frame - event["startFrame"]) / entry))
    if motion.get("exit") == "short_fade" and frame > event["endFrame"] - exit_frames:
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


def event_colors(event, colors):
    graphics = event.get("textScene", {}).get("graphics", {})
    resolved = {
        **colors,
        "accent": hex_color(graphics.get("accent", "#E9A92F")),
        "secondary": hex_color(graphics.get("secondaryAccent", "#FFF1D0")),
    }
    if event.get("textScene", {}).get("surface") == "light":
        resolved["primary"] = colors["dark"]
    return resolved


def scene_display_alpha(event, alpha):
    opacity = float(event.get("textScene", {}).get("material", {}).get("displayOpacity", 1.0))
    return max(0, min(255, round(alpha * opacity)))


def scene_echo_alpha(event, alpha):
    opacity = float(event.get("textScene", {}).get("material", {}).get("echoOpacity", 0.11))
    return max(0, min(alpha, round(255 * opacity)))


def scene_shadow_opacity(event, factor=1.0):
    opacity = float(event.get("textScene", {}).get("material", {}).get("shadowOpacity", 0.38))
    return max(0, min(255, round(255 * opacity * factor)))


def draw_scene_text(canvas, position, text, font, fill, alpha, event, **kwargs):
    angle = float(event.get("textScene", {}).get("spatial", {}).get("rotationDegrees", 0))
    if abs(angle) < 0.01:
        draw_shadowed_text(canvas, position, text, font, fill, alpha, **kwargs)
        return
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw_shadowed_text(layer, position, text, font, fill, alpha, **kwargs)
    rotated = layer.rotate(
        angle,
        resample=Image.Resampling.BICUBIC,
        center=(round(position[0]), round(position[1])),
    )
    canvas.alpha_composite(rotated)


def draw_profile_motif(canvas, event, x, y, span, alpha):
    scene = event.get("textScene", {})
    graphics = scene.get("graphics", {})
    motif = graphics.get("motif", "single_rule")
    accent = hex_color(graphics.get("accent", "#E9A92F"))
    draw = ImageDraw.Draw(canvas)
    ink = accent[:3] + (min(alpha, 220),)
    light_ink = accent[:3] + (min(alpha, 105),)
    if motif == "precision_ticks":
        draw.line((x, y, x + span, y), fill=light_ink, width=2)
        for ratio in (0.0, 0.5, 1.0):
            tx = x + span * ratio
            draw.line((tx, y - 6, tx, y + 6), fill=ink, width=2)
    elif motif == "editorial_quote":
        draw.line((x, y, x + span * 0.42, y), fill=ink, width=3)
        draw.arc((x - 5, y - 18, x + 17, y + 4), 205, 340, fill=ink, width=3)
    elif motif == "open_horizon":
        draw.line((x, y, x + span * 0.76, y), fill=light_ink, width=2)
        draw.ellipse((x + span * 0.76 - 4, y - 4, x + span * 0.76 + 4, y + 4), fill=ink)
    elif motif == "data_brackets":
        depth = 12
        draw.line((x, y - depth, x, y, x + depth, y), fill=ink, width=2)
        draw.line((x + span - depth, y, x + span, y, x + span, y - depth), fill=ink, width=2)
    elif motif == "loose_corner":
        draw.line((x, y - 10, x, y, x + min(span, 36), y), fill=ink, width=3)
        draw.ellipse((x + min(span, 48), y - 3, x + min(span, 54), y + 3), fill=light_ink)
    else:
        draw.line((x, y, x + span * 0.45, y), fill=ink, width=3)


def draw_micro_progress_rail(canvas, event, colors, width, height, alpha, frame):
    lyric_progress = event.get("textScene", {}).get("lyricProgress", {})
    words = event.get("wordTiming", [])
    if lyric_progress.get("mode") == "micro_rail" and words:
        progress = 0.0
        for index, word in enumerate(words):
            if frame >= word["endFrame"]:
                progress = (index + 1) / len(words)
                continue
            if frame >= word["startFrame"]:
                local = (frame - word["startFrame"]) / max(1, word["endFrame"] - word["startFrame"])
                progress = (index + local) / len(words)
            break
        rail_width = width * min(0.46, float(lyric_progress.get("maximumWidthRatio", 0.46)))
        rail_x = width * 0.5 - rail_width * 0.5
        rail_y = height * 0.754
        thickness = max(2, round(height * float(lyric_progress.get("thicknessRatio", 0.0025))))
        draw = ImageDraw.Draw(canvas)
        draw.line(
            (rail_x, rail_y, rail_x + rail_width, rail_y),
            fill=colors["primary"][:3] + (min(alpha, 55),),
            width=thickness,
        )
        draw.line(
            (rail_x, rail_y, rail_x + rail_width * progress, rail_y),
            fill=colors["accent"][:3] + (min(alpha, 205),),
            width=thickness,
        )


def draw_reading_baseline(canvas, event, colors, width, height, alpha, frame):
    text = event.get("display", {}).get("full", "")
    if not text:
        return
    file = font_path(event, "reading")
    reading_ratio = 0.052 if width >= height else 0.042
    font = fit_font(file, text, height * reading_ratio, width * 0.84)
    draw_shadowed_text(
        canvas,
        (width * 0.5, height * 0.72),
        text,
        font,
        colors["primary"],
        alpha,
        shadow_opacity=150,
    )
    draw_micro_progress_rail(canvas, event, colors, width, height, alpha, frame)


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
    colors = event_colors(event, colors)
    alpha = event_alpha(frame, event, fps)
    display_alpha = scene_display_alpha(event, alpha)
    local = max(0, frame - event["startFrame"])
    configured_entry = event.get("textScene", {}).get("motion", {}).get("entryFrames")
    entry_frames = max(1, round(configured_entry)) if configured_entry is not None else max(1, round(0.18 * fps))
    progress = ease(min(1, local / entry_frames))
    file = font_path(event)
    baseline = height * 0.69
    safe_width = width * 0.84
    reading_ratio = 0.052 if width >= height else 0.042
    support_ratio = 0.042 if width >= height else 0.029
    if layer == "background":
        if layout == "oversize_background_word":
            text = event["display"]["background"]
            size = height * (0.27 + 0.05 * progress)
            font = fit_font(file, text, size, width * 0.86)
            anchor = event.get("textScene", {}).get("anchor", "left")
            x_ratio = 0.35 if anchor == "left" else 0.65 if anchor == "right" else 0.5
            draw_shadowed_text(
                canvas,
                (width * x_ratio, height * 0.35),
                text,
                font,
                colors["accent"],
                min(display_alpha, 220),
                shadow_offset=4,
                shadow_blur=8,
                shadow_opacity=scene_shadow_opacity(event),
            )
        else:
            text = event["display"]["background"]
            size = height * (0.11 + 0.02 * progress)
            font = fit_font(file, text, size, width * 0.82)
            draw_shadowed_text(
                canvas,
                (width * 0.5, height * 0.34),
                text,
                font,
                colors["primary"],
                min(display_alpha, 224),
                shadow_offset=4,
                shadow_blur=8,
                shadow_opacity=scene_shadow_opacity(event),
            )
        return
    if layout == "plain_single":
        text = event["display"]["full"]
        font = fit_font(file, text, height * reading_ratio, safe_width)
        draw_shadowed_text(canvas, (width * 0.5, baseline), text, font, colors["primary"], alpha)
        draw_micro_progress_rail(canvas, event, colors, width, height, alpha, frame)
    elif layout == "logic_emphasis_inline":
        scale = 0.92 + 0.08 * progress
        draw_inline_emphasis(
            canvas,
            event,
            (width * 0.5, baseline),
            safe_width,
            height * reading_ratio * scale,
            colors,
            alpha,
        )
        draw_micro_progress_rail(canvas, event, colors, width, height, alpha, frame)
    elif layout == "left_right_contrast":
        size = height * 0.052
        left_text = event["display"]["left"]
        right_text = event["display"]["right"]
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
        left_font = fit_font(file, event["display"]["left"], size, height * 0.42)
        right_font = fit_font(file, event["display"]["right"], size, height * 0.42)
        left = vertical_text_image(
            event["display"]["left"], left_font, colors["primary"], alpha
        )
        right = vertical_text_image(
            event["display"]["right"], right_font, colors["accent"], alpha
        )
        canvas.alpha_composite(left, (round(width * 0.08 - left.width / 2), round(height * 0.49 - left.height / 2)))
        canvas.alpha_composite(right, (round(width * 0.92 - right.width / 2), round(height * 0.49 - right.height / 2)))
    elif layout == "top_bottom_hierarchy":
        top = event["display"]["top"]
        bottom = event["display"]["bottom"]
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
    elif layout == "editorial_stack":
        display = event["display"]
        primary = display["primary"]
        secondary = display["secondary"]
        echo = display.get("echo", "")
        anchor = event.get("textScene", {}).get("anchor", "left")
        align_right = anchor == "right"
        x = width * (0.76 if align_right else 0.12)
        text_anchor = "ra" if align_right else "la"
        parallax = float(event.get("textScene", {}).get("spatial", {}).get("parallaxPixels", 3))
        entry_offset = (1 - progress) * (width * (0.035 if align_right else -0.035) + (-parallax if align_right else parallax))
        if echo:
            echo_font = fit_font(file, echo, height * 0.18, width * 0.58)
            draw_shadowed_text(
                canvas,
                (width * (0.72 if align_right else 0.28), height * 0.34),
                echo,
                echo_font,
                colors["secondary"],
                scene_echo_alpha(event, alpha),
                shadow_opacity=20,
            )
        settle_scale = float(event.get("textScene", {}).get("motion", {}).get("settleScale", 1.04))
        primary_scale = 1 + (settle_scale - 1) * (1 - progress)
        primary_font = fit_font(file, primary, height * 0.084 * primary_scale, width * 0.62)
        support_file = font_path(event, "support")
        secondary_font = fit_font(support_file, secondary, height * support_ratio, width * 0.58)
        px = x + entry_offset
        draw_profile_motif(canvas, event, px, height * 0.39, width * 0.22 * progress, display_alpha)
        draw_scene_text(
            canvas, (px, height * 0.47), primary, primary_font,
            colors["primary"], display_alpha, event, anchor=text_anchor,
            shadow_opacity=scene_shadow_opacity(event),
        )
        draw_shadowed_text(
            canvas, (px, height * 0.55), secondary, secondary_font,
            colors["accent"], display_alpha, anchor=text_anchor,
            shadow_opacity=scene_shadow_opacity(event, 0.75),
        )
        draw_reading_baseline(canvas, event, colors, width, height, alpha, frame)
    elif layout == "edge_annotation":
        display = event["display"]
        primary = display["primary"]
        annotation = display["annotation"]
        anchor = event.get("textScene", {}).get("anchor", "right")
        align_right = anchor == "right"
        x = width * (0.91 if align_right else 0.09)
        line_end = width * (0.69 if align_right else 0.31)
        text_x = width * (0.87 if align_right else 0.13)
        text_anchor = "ra" if align_right else "la"
        y = height * 0.37
        draw = ImageDraw.Draw(canvas)
        rule_progress = min(1, progress * 1.35)
        active_end = x + (line_end - x) * rule_progress
        draw.line((x, y, active_end, y), fill=colors["accent"][:3] + (display_alpha,), width=2)
        draw.ellipse((active_end - 4, y - 4, active_end + 4, y + 4), fill=colors["accent"][:3] + (display_alpha,))
        primary_font = fit_font(file, primary, height * 0.062, width * 0.38)
        support_font = fit_font(
            font_path(event, "support"), annotation, height * support_ratio, width * 0.4
        )
        draw_scene_text(
            canvas, (text_x, y + height * 0.07), primary, primary_font,
            colors["primary"], int(display_alpha * progress), event, anchor=text_anchor,
            shadow_opacity=scene_shadow_opacity(event),
        )
        draw_shadowed_text(
            canvas, (text_x, y + height * 0.12), annotation, support_font,
            colors["accent"], int(display_alpha * progress), anchor=text_anchor,
            shadow_opacity=scene_shadow_opacity(event, 0.7),
        )
        draw_reading_baseline(canvas, event, colors, width, height, alpha, frame)
    elif layout == "quote_field":
        display = event["display"]
        quote = display["primary"]
        source = display["source"]
        echo = display.get("echo", "")
        quote_font = fit_font(file, quote, height * 0.062, width * 0.72)
        support_font = fit_font(
            font_path(event, "support"), source, height * support_ratio, width * 0.38
        )
        if echo:
            echo_font = fit_font(file, echo, height * 0.17, width * 0.64)
            draw_shadowed_text(
                canvas, (width * 0.73, height * 0.31), echo, echo_font,
                colors["secondary"], scene_echo_alpha(event, alpha), shadow_opacity=16,
            )
        draw_profile_motif(canvas, event, width * 0.18, height * 0.37, width * 0.23 * progress, display_alpha)
        draw_scene_text(
            canvas, (width * 0.18 - (1 - progress) * 18, height * 0.47), quote,
            quote_font, colors["primary"], display_alpha, event, anchor="la",
            shadow_opacity=scene_shadow_opacity(event),
        )
        draw_shadowed_text(
            canvas, (width * 0.82, height * 0.56), f"— {source}",
            support_font, colors["accent"], int(display_alpha * progress), anchor="ra",
            shadow_opacity=scene_shadow_opacity(event, 0.6),
        )
    elif layout == "oversize_background_word":
        text = event["display"]["foreground"]
        font = fit_font(file, text, height * reading_ratio, safe_width)
        draw_shadowed_text(
            canvas,
            (width * 0.5, baseline),
            text,
            font,
            colors["primary"],
            display_alpha,
        )
        draw_micro_progress_rail(canvas, event, colors, width, height, alpha, frame)
    elif layout == "front_back_phrase":
        text = event["display"]["foreground"]
        font = fit_font(file, text, height * 0.058, width * 0.82)
        draw_shadowed_text(
            canvas,
            (width * 0.5, height * 0.63),
            text,
            font,
            colors["accent"],
            display_alpha,
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
        os.environ.get("KACHA_FFMPEG_BIN", "ffmpeg"),
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
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
