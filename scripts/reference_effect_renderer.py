#!/usr/bin/env python3
"""Render Kacha reference frames with exact local font files.

The renderer deliberately avoids system font-family resolution. Every glyph is
drawn by Pillow from an explicit, hashed font file so a successful font lookup
cannot be mistaken for successful final-pixel rendering.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


PAPER = (243, 239, 231, 255)
SURFACE = (255, 253, 249, 184)
INK = (36, 39, 46, 255)
MUTED = (86, 93, 101, 220)
THIN_MUTED = (54, 58, 64, 175)
ORANGE = (255, 116, 56, 255)
CORAL = (240, 70, 90, 255)
MAGENTA = (216, 63, 118, 255)
BLUE = (77, 111, 210, 255)
BLUE_SOFT = (118, 144, 232, 255)
GREEN = (74, 135, 108, 255)
WARM_WHITE = (255, 253, 248, 255)
DEEP_GLASS = (31, 38, 49, 126)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stable_seed(*parts: str) -> int:
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big")


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def gradient(size: tuple[int, int], colors: list[tuple[int, int, int, int]], horizontal=True) -> Image.Image:
    width, height = size
    image = Image.new("RGBA", size)
    draw = ImageDraw.Draw(image)
    span = max(1, width - 1 if horizontal else height - 1)
    segments = max(1, len(colors) - 1)
    for position in range(width if horizontal else height):
        u = position / span
        segment = min(segments - 1, int(u * segments))
        local = u * segments - segment
        first, second = colors[segment], colors[segment + 1]
        color = tuple(lerp(first[index], second[index], local) for index in range(4))
        if horizontal:
            draw.line((position, 0, position, height), fill=color)
        else:
            draw.line((0, position, width, position), fill=color)
    return image


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius, fill=255)
    return mask


def alpha_composite_at(base: Image.Image, overlay: Image.Image, xy: tuple[int, int]) -> None:
    base.alpha_composite(overlay, xy)


class FrameRenderer:
    def __init__(self, project_root: Path, source_dir: Path, output: Path, style: str):
        self.project_root = project_root
        self.source_dir = source_dir
        self.output = output
        self.style = style
        self.font_paths = {
            "subtitle": project_root / "kacha/assets/private/fonts/FZCuJinLJW.ttf",
            "display": project_root / "Fonts/华光标题黑.TTF",
            "thin": project_root / "Fonts/细体-思源黑体7号.otf",
            "cover": project_root / "Fonts/封神榜书.ttf",
        }
        for role, path in self.font_paths.items():
            if not path.exists():
                raise FileNotFoundError(f"缺少 {role} 字体文件：{path}")
        self.font_hashes = {role: sha256_file(path) for role, path in self.font_paths.items()}
        self.font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}
        self.font_evidence: list[dict] = []
        self.layout_evidence: list[dict] = []

    def font(self, role: str, size: int) -> ImageFont.FreeTypeFont:
        key = (role, size)
        if key not in self.font_cache:
            self.font_cache[key] = ImageFont.truetype(str(self.font_paths[role]), size=size)
        return self.font_cache[key]

    def base(self, aspect: str, size: tuple[int, int]) -> Image.Image:
        source = Image.open(self.source_dir / f"master_{aspect}.png").convert("RGB")
        return source.resize(size, Image.Resampling.LANCZOS).convert("RGBA")

    @staticmethod
    def context(aspect: str, size: tuple[int, int]) -> dict:
        width, height = size
        if aspect == "horizontal":
            return {
                "head": (round(width * .48), round(height * .13), round(width * .64), round(height * .47)),
                "subject": (round(width * .37), round(height * .12), round(width * .72), round(height * .84)),
                "negative": (round(width * .035), round(height * .12), round(width * .44), round(height * .76)),
                "subtitle": (round(width * .16), round(height * .70), round(width * .84), round(height * .88)),
                "brand": (round(width * .035), round(height * .035), round(width * .34), round(height * .105)),
            }
        return {
            "head": (round(width * .28), round(height * .43), round(width * .70), round(height * .66)),
            "subject": (round(width * .10), round(height * .42), round(width * .88), round(height * .86)),
            "negative": (round(width * .055), round(height * .10), round(width * .945), round(height * .40)),
            "subtitle": (round(width * .07), round(height * .71), round(width * .93), round(height * .84)),
            "brand": (round(width * .055), round(height * .028), round(width * .88), round(height * .072)),
        }

    @staticmethod
    def intersection_ratio(first: tuple[int, int, int, int], second: tuple[int, int, int, int]) -> float:
        x1, y1 = max(first[0], second[0]), max(first[1], second[1])
        x2, y2 = min(first[2], second[2]), min(first[3], second[3])
        if x2 <= x1 or y2 <= y1:
            return 0.0
        area = (x2 - x1) * (y2 - y1)
        return area / max(1, (first[2] - first[0]) * (first[3] - first[1]))

    def fit_text(self, text: str, role: str, maximum: int, minimum: int, max_width: int, max_height: int, spacing=4) -> tuple[ImageFont.FreeTypeFont, tuple[int, int, int, int]]:
        for size in range(maximum, minimum - 1, -2):
            font = self.font(role, size)
            box = ImageDraw.Draw(Image.new("L", (4, 4))).multiline_textbbox((0, 0), text, font=font, spacing=spacing)
            if box[2] - box[0] <= max_width and box[3] - box[1] <= max_height:
                return font, box
        font = self.font(role, minimum)
        return font, ImageDraw.Draw(Image.new("L", (4, 4))).multiline_textbbox((0, 0), text, font=font, spacing=spacing)

    def draw_text(self, base: Image.Image, text: str, role: str, box: tuple[int, int, int, int], *, maximum: int, minimum: int, fill=INK, align="left", anchor="lt", shadow=False, gradient_fill=False, spacing=5, entry_id="") -> tuple[int, int, int, int]:
        x1, y1, x2, y2 = box
        font, measured = self.fit_text(text, role, maximum, minimum, x2 - x1, y2 - y1, spacing)
        width, height = measured[2] - measured[0], measured[3] - measured[1]
        if anchor in {"mt", "mm"}:
            x = x1 + (x2 - x1 - width) // 2
        elif anchor in {"rt", "rm"}:
            x = x2 - width
        else:
            x = x1
        if anchor in {"lm", "mm", "rm"}:
            y = y1 + (y2 - y1 - height) // 2 - measured[1]
        else:
            y = y1 - measured[1]
        mask = Image.new("L", base.size, 0)
        md = ImageDraw.Draw(mask)
        md.multiline_text((x, y), text, font=font, fill=255, spacing=spacing, align=align)
        bbox = mask.getbbox() or (x, y, x + width, y + height)
        sample = base.convert("RGB").crop(bbox).resize((16, 16), Image.Resampling.BILINEAR)
        pixels = list(sample.get_flattened_data()) if hasattr(sample, "get_flattened_data") else list(sample.getdata())
        background_rgb = tuple(round(sum(pixel[channel] for pixel in pixels) / max(1, len(pixels))) for channel in range(3))

        def luminance(color):
            channels = []
            for value in color[:3]:
                value /= 255
                channels.append(value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4)
            return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2]

        def contrast(first, second):
            a, b = luminance(first), luminance(second)
            return (max(a, b) + .05) / (min(a, b) + .05)

        gradient_colors = [ORANGE, CORAL, MAGENTA]
        if gradient_fill:
            gradient_candidates = [
                [(15, 19, 25, 255), (19, 28, 46, 246), (23, 37, 68, 232)],
                [(255, 253, 248, 255), (249, 248, 245, 248), (238, 242, 250, 236)],
            ]
            gradient_colors = max(
                gradient_candidates,
                key=lambda candidate: min(contrast(color, background_rgb) for color in candidate),
            )
        if role == "subtitle" and not gradient_fill:
            bright_fraction = sum(1 for pixel in pixels if luminance(pixel) > .52) / max(1, len(pixels))
            fill = INK if bright_fraction > .72 else WARM_WHITE
        elif not gradient_fill:
            target = 3.0 if role in {"display", "cover"} or font.size >= 40 else 4.5
            current_ratio = contrast(fill, background_rgb)
            if current_ratio < target:
                candidates = [INK, WARM_WHITE]
                selected = max(candidates, key=lambda color: contrast(color, background_rgb))
                fill = selected[:3] + (fill[3] if len(fill) > 3 else 255,)
        contrast_estimate = min(contrast(color, background_rgb) for color in (gradient_colors if gradient_fill else [fill]))
        if shadow:
            shadow_mask = mask.filter(ImageFilter.GaussianBlur(max(4, round(font.size * .12))))
            shifted = Image.new("L", base.size, 0)
            shifted.paste(shadow_mask, (0, max(2, round(font.size * .07))))
            shadow_layer = Image.new("RGBA", base.size, (8, 10, 14, 0))
            shadow_layer.putalpha(shifted.point(lambda p: round(p * .60)))
            base.alpha_composite(shadow_layer)
        if gradient_fill:
            layer = gradient(base.size, gradient_colors, horizontal=True)
            layer.putalpha(mask)
        else:
            layer = Image.new("RGBA", base.size, fill)
            layer.putalpha(mask)
        base.alpha_composite(layer)
        glyph_hash = hashlib.sha256(mask.crop(bbox).tobytes()).hexdigest()
        self.font_evidence.append({
            "entryId": entry_id,
            "role": role,
            "fontFile": str(self.font_paths[role].relative_to(self.project_root)),
            "fontSha256": self.font_hashes[role],
            "glyphMaskSha256": glyph_hash,
            "fontSize": font.size,
            "bbox": list(bbox),
            "text": text,
            "shadowOpacity": 0.6 if shadow else 0,
            "localBackgroundRgb": list(background_rgb),
            "contrastRatioEstimate": round(contrast_estimate, 3),
            "contrastAdapted": role == "subtitle" and not gradient_fill,
            "gradientColors": [list(color) for color in gradient_colors] if gradient_fill else [],
        })
        return bbox

    def glow_line(self, base: Image.Image, points: list[tuple[int, int]], color, width: int, glow: int = 14) -> None:
        glow_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow_layer)
        gd.line(points, fill=color[:3] + (180,), width=width, joint="curve")
        base.alpha_composite(glow_layer.filter(ImageFilter.GaussianBlur(glow)))
        line = Image.new("RGBA", base.size, (0, 0, 0, 0))
        ImageDraw.Draw(line).line(points, fill=color, width=max(2, width // 2), joint="curve")
        base.alpha_composite(line)

    def spatial_atmosphere(self, base: Image.Image, area: tuple[int, int, int, int], rng: random.Random, strength: int = 82) -> None:
        """Add a feathered local depth field; never a rectangular dark wash."""
        x1, y1, x2, y2 = area
        pad_x, pad_y = round((x2 - x1) * .12), round((y2 - y1) * .16)
        layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        ld.ellipse((x1 - pad_x, y1 - pad_y, x2 + pad_x, y2 + pad_y), fill=(19, 27, 42, strength))
        layer = layer.filter(ImageFilter.GaussianBlur(max(70, round((x2 - x1) * .14))))
        base.alpha_composite(layer)
        particles = Image.new("RGBA", base.size, (0, 0, 0, 0))
        pd = ImageDraw.Draw(particles)
        for index in range(14):
            px = rng.randint(x1, x2)
            py = rng.randint(y1, y2)
            radius = 1 + index % 3
            color = ORANGE if index % 5 == 0 else BLUE_SOFT
            pd.ellipse((px - radius, py - radius, px + radius, py + radius), fill=color[:3] + (90 + index % 4 * 20,))
        base.alpha_composite(particles.filter(ImageFilter.GaussianBlur(1.2)))

    def glass_card(self, base: Image.Image, box: tuple[int, int, int, int], active=False, light=False, radius=28) -> None:
        x1, y1, x2, y2 = box
        size = (x2 - x1, y2 - y1)
        shadow = Image.new("RGBA", (size[0] + 80, size[1] + 80), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        sd.rounded_rectangle((40, 34, 40 + size[0], 34 + size[1]), radius, fill=(15, 18, 25, 90 if not light else 38))
        shadow = shadow.filter(ImageFilter.GaussianBlur(18))
        alpha_composite_at(base, shadow, (x1 - 40, y1 - 24))
        card = Image.new("RGBA", size, (0, 0, 0, 0))
        cd = ImageDraw.Draw(card)
        if light:
            cd.rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius, fill=(255, 252, 246, 154), outline=(255, 255, 255, 146), width=2)
        else:
            cd.rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius, fill=DEEP_GLASS, outline=(255, 255, 255, 68), width=2)
            accent = gradient(size, [BLUE_SOFT, ORANGE if active else BLUE], horizontal=True)
            edge = Image.new("L", size, 0)
            ed = ImageDraw.Draw(edge)
            ed.rounded_rectangle((1, 1, size[0] - 2, size[1] - 2), radius, outline=210, width=4)
            accent.putalpha(edge)
            card.alpha_composite(accent)
        alpha_composite_at(base, card, (x1, y1))

    def brand(self, base: Image.Image, aspect: str, entry_id: str) -> None:
        width, height = base.size
        x = round(width * (.035 if aspect == "horizontal" else .055))
        y = round(height * (.035 if aspect == "horizontal" else .028))
        bar_w, bar_h = (400, 50) if aspect == "horizontal" else (690, 68)
        layer = Image.new("RGBA", (bar_w, bar_h), (255, 252, 246, 105 if self.style == "light" else 76))
        ImageDraw.Draw(layer).rounded_rectangle((0, 0, bar_w - 1, bar_h - 1), bar_h // 2, outline=(255, 255, 255, 95), width=1)
        alpha_composite_at(base, layer.filter(ImageFilter.GaussianBlur(.25)), (x, y))
        self.draw_text(base, "行者大灰", "thin", (x + 18, y + 4, x + 135, y + bar_h - 4), maximum=22 if aspect == "horizontal" else 27, minimum=16, fill=(42, 45, 50, 182), anchor="lm", entry_id=entry_id)
        ImageDraw.Draw(base).rounded_rectangle((x + 145, y + bar_h // 2 - 2, x + 204, y + bar_h // 2 + 2), 2, fill=CORAL[:3] + (180,))
        self.draw_text(base, "工具分享 · 第1期", "thin", (x + 220, y + 4, x + bar_w - 16, y + bar_h - 4), maximum=17 if aspect == "horizontal" else 22, minimum=13, fill=(57, 60, 66, 145), anchor="lm", entry_id=entry_id)

    @staticmethod
    def archetype(entry: dict) -> str:
        kind, category, entry_id = entry["kind"], entry.get("category") or "", entry["id"]
        target = f"{category} {entry_id}"
        if category == "subtitle" or "subtitle" in entry_id:
            return "subtitle"
        if category == "brand" or any(word in entry_id for word in ["brand", "label", "badge", "marker", "tag"]):
            return "brand_frame"
        if category == "cover":
            return "cover"
        if category == "ending":
            return "endcard"
        if any(word in target for word in ["quote", "statement", "definition", "chapter", "title", "keyword"]):
            return "headline"
        if category == "comparison" or any(word in target for word in ["compare", "before", "after", "split", "versus", "xstack"]):
            return "comparison"
        if any(word in target for word in ["process", "flow", "workflow", "timeline", "branch", "step", "progress", "stagger", "sequence"]):
            return "process"
        if any(word in target for word in ["pip", "picture", "overlay", "window", "frame", "mask_composite"]):
            return "pip"
        if any(word in target for word in ["highlight", "focus", "callout", "annotation", "mark", "pointer", "sticker"]):
            return "annotation"
        if kind == "motion" and category in {"reveal", "fade", "cut", "timed_entry", "timed_exit"}:
            return "transition"
        if kind == "motion" and category in {"scale", "hold", "none"}:
            return "camera"
        if kind == "renderer":
            return "renderer"
        if category in {"data", "card", "explainer"}:
            return "information"
        if category in {"opening", "bridge", "tool_ai", "netstyle"}:
            return "transition" if category == "bridge" else "information"
        if kind == "layout":
            return "camera"
        return "information"

    def subtitle(self, base, entry, aspect, ctx, rng, variant):
        x1, y1, x2, y2 = ctx["subtitle"]
        text = "字幕跟着语义和节奏出现"
        if "bilingual" in entry["id"]:
            text = "Captions follow meaning and rhythm\n字幕跟着语义和节奏出现"
        elif "emphasis" in entry["id"]:
            text = "重要的不是效果多，是判断准"
        elif "quote" in entry["id"]:
            text = "工具降低门槛，品味决定上限"
        if aspect == "vertical":
            y1 -= 70
            y2 -= 70
        bbox = self.draw_text(base, text, "subtitle", (x1, y1, x2, y2), maximum=54 if aspect == "horizontal" else 52, minimum=30, fill=WARM_WHITE, anchor="mm", align="center", shadow=True, spacing=8, entry_id=entry["id"])
        if "emphasis" in entry["id"]:
            d = ImageDraw.Draw(base)
            d.rounded_rectangle((bbox[0], bbox[3] + 8, min(bbox[2], bbox[0] + (bbox[2] - bbox[0]) * .48), bbox[3] + 14), 3, fill=CORAL)
        if self.style == "spatial":
            cy = bbox[3] + 22
            self.glow_line(base, [(bbox[0] + 20, cy), (bbox[2] - 20, cy)], BLUE_SOFT, 7, 12)
            ImageDraw.Draw(base).ellipse((bbox[2] - 18, cy - 7, bbox[2] - 4, cy + 7), fill=ORANGE)
        return [bbox]

    def headline(self, base, entry, aspect, ctx, rng, variant):
        area = ctx["negative"]
        x1, y1, x2, y2 = area
        title = entry["label"]
        if len(title) > (10 if aspect == "horizontal" else 8):
            split = math.ceil(len(title) / 2)
            title = title[:split] + "\n" + title[split:]
        if self.style == "spatial":
            slab = (x1 + 10, y1 + 80, x2 - 25, min(y2, y1 + (360 if aspect == "horizontal" else 440)))
            self.glass_card(base, slab, active=variant % 3 == 0, light=False, radius=32)
            self.glow_line(base, [(slab[0] + 10, slab[3] - 22), (slab[2] - 25, slab[3] - 22)], ORANGE, 8, 18)
            box = (slab[0] + 40, slab[1] + 38, slab[2] - 35, slab[3] - 40)
            fill = WARM_WHITE
        else:
            box = (x1 + 20, y1 + 80, x2, min(y2, y1 + (390 if aspect == "horizontal" else 470)))
            fill = INK
        bbox = self.draw_text(base, title, "display", box, maximum=104 if aspect == "horizontal" else 94, minimum=42, fill=fill, gradient_fill=self.style == "light" or variant % 2 == 0, spacing=12, entry_id=entry["id"])
        return [bbox]

    def process(self, base, entry, aspect, ctx, rng, variant):
        area = ctx["negative"]
        x1, y1, x2, y2 = area
        labels = ["原片", "精剪", "声音", "画面", "发布"]
        boxes = []
        if self.style == "light":
            if aspect == "horizontal":
                card_w, card_h = 132, 92
                start_x, cy = x1 + 10, y1 + 350
                centers = [(start_x + i * 145 + card_w // 2, cy + (12 if (variant + i) % 2 else -12)) for i in range(5)]
            else:
                card_w, card_h = 190, 104
                centers = [(x1 + 120 + (i % 2) * 250, y1 + 170 + (i // 2) * 130) for i in range(5)]
            d = ImageDraw.Draw(base)
            for i in range(len(centers) - 1):
                d.line((centers[i], centers[i + 1]), fill=(240, 70, 90, 110), width=4)
            for i, (cx, cy) in enumerate(centers):
                box = (cx - card_w // 2, cy - card_h // 2, cx + card_w // 2, cy + card_h // 2)
                self.glass_card(base, box, active=i == (variant % 5), light=True, radius=22)
                if i == variant % 5:
                    d.rounded_rectangle(box, 22, outline=CORAL, width=3)
                boxes.append(self.draw_text(base, labels[i], "thin", (box[0] + 12, box[1] + 8, box[2] - 12, box[3] - 8), maximum=24, minimum=16, fill=INK, anchor="mm", align="center", entry_id=entry["id"]))
        else:
            if aspect == "horizontal":
                centers = [(x1 + 100, y1 + 410), (x1 + 260, y1 + 285), (x1 + 430, y1 + 145), (x1 + 610, y1 + 300)]
                card_w, card_h = 150, 92
            else:
                centers = [(x1 + 130, y1 + 420), (x1 + 340, y1 + 295), (x1 + 570, y1 + 150), (x1 + 760, y1 + 320)]
                card_w, card_h = 180, 105
            centers = centers[variant % 2:] + centers[:variant % 2]
            for i in range(len(centers) - 1):
                self.glow_line(base, [centers[i], ((centers[i][0] + centers[i + 1][0]) // 2, min(centers[i][1], centers[i + 1][1]) - 35), centers[i + 1]], ORANGE if i == 2 else BLUE_SOFT, 8 if i == 2 else 6, 16)
            for i, (cx, cy) in enumerate(centers):
                box = (cx - card_w // 2, cy - card_h // 2, cx + card_w // 2, cy + card_h // 2)
                self.glass_card(base, box, active=i == len(centers) - 1, light=False, radius=25)
                boxes.append(self.draw_text(base, labels[i], "thin", (box[0] + 12, box[1] + 8, box[2] - 12, box[3] - 8), maximum=24, minimum=16, fill=WARM_WHITE, anchor="mm", align="center", entry_id=entry["id"]))
        return boxes

    def comparison(self, base, entry, aspect, ctx, rng, variant):
        x1, y1, x2, y2 = ctx["negative"]
        gap = 22
        width = (x2 - x1 - gap) // 2
        height = 270 if aspect == "horizontal" else 380
        y = y1 + 150
        boxes = [(x1, y, x1 + width, y + height), (x1 + width + gap, y + (18 if variant % 2 else -8), x2, y + height + (18 if variant % 2 else -8))]
        labels = ["之前", "之后"]
        for i, box in enumerate(boxes):
            self.glass_card(base, box, active=i == 1, light=self.style == "light", radius=28)
            if self.style == "spatial":
                self.glow_line(base, [(box[0] + 20, box[3] - 28), (box[2] - 20, box[3] - 28)], ORANGE if i else BLUE_SOFT, 7, 14)
            self.draw_text(base, labels[i], "display", (box[0] + 24, box[1] + 25, box[2] - 24, box[3] - 22), maximum=54, minimum=28, fill=INK if self.style == "light" else WARM_WHITE, anchor="mm", align="center", gradient_fill=i == 1, entry_id=entry["id"])
        return boxes

    def information(self, base, entry, aspect, ctx, rng, variant):
        x1, y1, x2, y2 = ctx["negative"]
        title = entry["label"]
        if self.style == "light":
            pattern = variant % 4
            card = (
                x1 + (pattern * 22 if pattern < 3 else 8),
                y1 + (105 + pattern * 32),
                x2 - (28 + (3 - pattern) * 12),
                y1 + ((400 + pattern * 42) if aspect == "horizontal" else (455 + pattern * 55)),
            )
            self.glass_card(base, card, light=True, radius=30)
            self.draw_text(base, title, "display", (card[0] + 34, card[1] + 28, card[2] - 30, card[1] + 130), maximum=54, minimum=30, fill=INK, gradient_fill=variant % 3 == 0, entry_id=entry["id"])
            d = ImageDraw.Draw(base)
            if pattern in {0, 3}:
                for index, label in enumerate(["信息", "关系", "结论"]):
                    yy = card[1] + 155 + index * 72
                    d.ellipse((card[0] + 38, yy + 9, card[0] + 52, yy + 23), fill=ORANGE if index == 2 else BLUE)
                    self.draw_text(base, label, "thin", (card[0] + 72, yy, card[2] - 28, yy + 46), maximum=24, minimum=17, fill=INK, anchor="lm", entry_id=entry["id"])
            elif pattern == 1:
                chip_w = (card[2] - card[0] - 92) // 3
                for index, label in enumerate(["输入", "判断", "结果"]):
                    bx = card[0] + 28 + index * (chip_w + 18)
                    by = card[1] + 190 + (index % 2) * 24
                    chip = (bx, by, bx + chip_w, by + 86)
                    self.glass_card(base, chip, light=True, radius=20)
                    self.draw_text(base, label, "thin", (bx + 10, by + 8, bx + chip_w - 10, by + 78), maximum=21, minimum=15, fill=INK, anchor="mm", entry_id=entry["id"])
            else:
                bar_y = card[1] + 205
                d.line((card[0] + 42, bar_y, card[2] - 42, bar_y), fill=(77, 111, 210, 120), width=5)
                for index, label in enumerate(["事实", "解释", "结论"]):
                    cx = card[0] + 70 + index * (card[2] - card[0] - 140) // 2
                    d.ellipse((cx - 10, bar_y - 10, cx + 10, bar_y + 10), fill=ORANGE if index == 2 else BLUE)
                    self.draw_text(base, label, "thin", (cx - 50, bar_y + 24, cx + 50, bar_y + 66), maximum=19, minimum=14, fill=INK, anchor="mt", entry_id=entry["id"])
            return [card]
        fragments = []
        patterns_h = [
            [(155, 330), (385, 190), (630, 370)],
            [(120, 190), (360, 350), (650, 190)],
            [(140, 410), (390, 270), (650, 130)],
            [(170, 165), (430, 165), (610, 390)],
        ]
        patterns_v = [
            [(180, 370), (465, 190), (750, 390)],
            [(160, 190), (445, 380), (760, 190)],
            [(150, 450), (460, 300), (760, 150)],
            [(190, 175), (510, 175), (760, 440)],
        ]
        offsets = (patterns_h if aspect == "horizontal" else patterns_v)[variant % 4]
        centers = [(x1 + dx, y1 + dy) for dx, dy in offsets]
        labels = ["信息", "关系", title]
        for i, (cx, cy) in enumerate(centers):
            w, h = (220, 130) if aspect == "horizontal" else (250, 145)
            box = (cx - w // 2, cy - h // 2, cx + w // 2, cy + h // 2)
            self.glass_card(base, box, active=i == 2, light=False, radius=28)
            self.draw_text(base, labels[i], "thin" if i < 2 else "display", (box[0] + 18, box[1] + 12, box[2] - 18, box[3] - 12), maximum=34 if i == 2 else 24, minimum=16, fill=WARM_WHITE, anchor="mm", align="center", entry_id=entry["id"])
            fragments.append(box)
        self.glow_line(base, [centers[0], (centers[1][0] - 40, centers[1][1] + 40), centers[1]], BLUE_SOFT, 6, 13)
        self.glow_line(base, [centers[1], (centers[2][0] - 60, centers[2][1] - 30), centers[2]], ORANGE, 8, 16)
        return fragments

    def pip(self, base, entry, aspect, ctx, rng, variant):
        x1, y1, x2, y2 = ctx["negative"]
        box = (x1 + 40, y1 + 130, x2 - 35, y1 + (470 if aspect == "horizontal" else 560))
        self.glass_card(base, box, active=True, light=self.style == "light", radius=32)
        inset = self.base(aspect, (box[2] - box[0] - 44, box[3] - box[1] - 90))
        inset = inset.filter(ImageFilter.GaussianBlur(.35))
        mask = rounded_mask(inset.size, 22)
        inset.putalpha(mask)
        alpha_composite_at(base, inset, (box[0] + 22, box[1] + 22))
        if self.style == "spatial":
            self.glow_line(base, [(box[0] + 30, box[3] - 28), (box[2] - 30, box[3] - 28)], ORANGE, 8, 18)
        self.draw_text(base, entry["label"], "thin", (box[0] + 30, box[3] - 64, box[2] - 24, box[3] - 12), maximum=22, minimum=14, fill=INK if self.style == "light" else WARM_WHITE, anchor="lm", entry_id=entry["id"])
        return [box]

    def annotation(self, base, entry, aspect, ctx, rng, variant):
        x1, y1, x2, y2 = ctx["negative"]
        target = (x2 - 50, y1 + 220 + (variant % 3) * 60)
        d = ImageDraw.Draw(base)
        radius = 46 if aspect == "horizontal" else 58
        for index in range(3):
            alpha = 170 - index * 45
            d.ellipse((target[0] - radius - index * 12, target[1] - radius - index * 12, target[0] + radius + index * 12, target[1] + radius + index * 12), outline=(240, 70, 90, alpha), width=3)
        start = (x1 + 120, y1 + 420)
        if self.style == "spatial":
            self.glow_line(base, [start, (target[0] - 130, start[1] - 90), target], ORANGE, 8, 17)
        else:
            d.line((start, target), fill=(77, 111, 210, 180), width=4)
        label_box = (x1, y1 + 370, x1 + 330, y1 + 490)
        self.glass_card(base, label_box, active=True, light=self.style == "light", radius=24)
        self.draw_text(base, entry["label"], "display", (label_box[0] + 22, label_box[1] + 12, label_box[2] - 20, label_box[3] - 12), maximum=35, minimum=22, fill=INK if self.style == "light" else WARM_WHITE, anchor="mm", align="center", gradient_fill=self.style == "light", entry_id=entry["id"])
        return [label_box]

    def transition(self, base, entry, aspect, ctx, rng, variant):
        width, height = base.size
        if self.style == "light":
            overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
            od = ImageDraw.Draw(overlay)
            if variant % 3 == 0:
                od.polygon([(0, height * .12), (width * .54, 0), (width * .34, height), (0, height)], fill=(255, 250, 242, 130))
            elif variant % 3 == 1:
                od.rounded_rectangle((width * .04, height * .34, width * .46, height * .62), 48, fill=(255, 252, 247, 142), outline=(255, 255, 255, 120), width=2)
            else:
                od.arc((width * -.15, height * -.1, width * .72, height * .82), 295, 75, fill=CORAL, width=18)
            base.alpha_composite(overlay)
        else:
            points = []
            for i in range(8):
                x = round(width * (-.05 + i * .085))
                y = round(height * (.72 - .5 * math.sin(i / 7 * math.pi)))
                points.append((x, y))
            self.glow_line(base, points, ORANGE if variant % 2 else BLUE_SOFT, 18, 28)
            self.glow_line(base, [(x, y + 38) for x, y in points], BLUE_SOFT if variant % 2 else ORANGE, 7, 18)
        box = ctx["negative"]
        return [self.draw_text(base, entry["label"], "display", (box[0] + 20, box[1] + 170, box[2] - 10, box[1] + 380), maximum=76, minimum=34, fill=INK if self.style == "light" else WARM_WHITE, anchor="mm", align="center", gradient_fill=True, entry_id=entry["id"])]

    def camera(self, base, entry, aspect, ctx, rng, variant):
        x1, y1, x2, y2 = ctx["negative"]
        d = ImageDraw.Draw(base)
        frames = []
        count = 3 + variant % 3
        for i in range(count):
            inset = i * (26 if aspect == "horizontal" else 38)
            box = (x1 + inset, y1 + 120 + inset, x2 - inset, y2 - 20 - inset)
            color = ORANGE if i == count - 1 else BLUE_SOFT
            d.rounded_rectangle(box, 26, outline=color[:3] + (170 - i * 20,), width=max(2, 6 - i))
            frames.append(box)
        self.draw_text(base, entry["label"], "display", (x1 + 70, y1 + 220, x2 - 70, y2 - 80), maximum=62, minimum=30, fill=INK if self.style == "light" else WARM_WHITE, anchor="mm", align="center", gradient_fill=variant % 2 == 0, entry_id=entry["id"])
        if self.style == "spatial":
            self.glow_line(base, [(x1 + 30, y2 - 10), (x2 - 30, y1 + 80)], BLUE_SOFT, 6, 16)
        return frames

    def brand_frame(self, base, entry, aspect, ctx, rng, variant):
        x1, y1, x2, y2 = ctx["negative"]
        w = min(x2 - x1, 610 if aspect == "horizontal" else 850)
        bar = (x1 + 20, y1 + 230, x1 + w, y1 + (330 if aspect == "horizontal" else 360))
        self.glass_card(base, bar, active=variant % 2 == 0, light=self.style == "light", radius=bar[3] - bar[1] >> 1)
        self.draw_text(base, "行者大灰", "thin", (bar[0] + 30, bar[1] + 10, bar[0] + w // 2, bar[3] - 10), maximum=34, minimum=20, fill=INK if self.style == "light" else WARM_WHITE, anchor="lm", entry_id=entry["id"])
        self.draw_text(base, entry["label"], "thin", (bar[0] + w // 2, bar[1] + 10, bar[2] - 28, bar[3] - 10), maximum=25, minimum=16, fill=THIN_MUTED if self.style == "light" else (255, 253, 248, 165), anchor="rm", entry_id=entry["id"])
        return [bar]

    def cover(self, base, entry, aspect, ctx, rng, variant):
        x1, y1, x2, y2 = ctx["negative"]
        if self.style == "spatial":
            self.glow_line(base, [(x1, y1 + 410), (x1 + 210, y1 + 260), (x2 - 20, y1 + 330)], BLUE_SOFT, 10, 22)
            self.glow_line(base, [(x1 + 40, y1 + 470), (x1 + 310, y1 + 390), (x2 - 50, y1 + 460)], ORANGE, 7, 20)
        title = "工具降低门槛\n品味决定上限"
        bbox = self.draw_text(base, title, "cover", (x1 + 10, y1 + 100, x2 - 10, y1 + 430), maximum=96 if aspect == "horizontal" else 88, minimum=42, fill=INK if self.style == "light" else WARM_WHITE, spacing=14, entry_id=entry["id"])
        self.draw_text(base, "工具分享 · 第1期", "thin", (x1 + 18, bbox[3] + 25, x2 - 18, bbox[3] + 90), maximum=24, minimum=16, fill=MUTED if self.style == "light" else (255, 253, 248, 175), anchor="lm", entry_id=entry["id"])
        return [bbox]

    def renderer(self, base, entry, aspect, ctx, rng, variant):
        x1, y1, x2, y2 = ctx["negative"]
        stack = []
        for i in range(3):
            offset = i * 28
            box = (x1 + 40 + offset, y1 + 120 + offset, x2 - 50 + offset // 2, y1 + 470 + offset)
            self.glass_card(base, box, active=i == 2, light=self.style == "light", radius=30)
            stack.append(box)
        current = stack[-1]
        self.draw_text(base, entry["label"], "display", (current[0] + 38, current[1] + 55, current[2] - 32, current[3] - 80), maximum=70, minimum=32, fill=INK if self.style == "light" else WARM_WHITE, anchor="mm", align="center", gradient_fill=True, entry_id=entry["id"])
        self.draw_text(base, "PRODUCTION READY", "thin", (current[0] + 34, current[3] - 70, current[2] - 30, current[3] - 18), maximum=21, minimum=14, fill=GREEN if self.style == "light" else (145, 225, 189, 230), anchor="rm", entry_id=entry["id"])
        return stack

    def endcard(self, base, entry, aspect, ctx, rng, variant):
        return self.headline(base, {**entry, "label": "可以发布"}, aspect, ctx, rng, variant)

    def render(self, entry: dict, aspect: str) -> dict:
        size = (1920, 1080) if aspect == "horizontal" else (1080, 1920)
        base = self.base(aspect, size)
        ctx = self.context(aspect, size)
        seed = stable_seed(self.style, entry["kind"], entry["id"], aspect)
        rng = random.Random(seed)
        variant = seed % 17
        archetype = self.archetype(entry)
        if self.style == "spatial" and archetype not in {"subtitle", "brand_frame"}:
            self.spatial_atmosphere(base, ctx["negative"], rng, 76 if archetype in {"headline", "cover"} else 92)
        method = getattr(self, archetype)
        elements = method(base, entry, aspect, ctx, rng, variant)
        self.brand(base, aspect, entry["id"])
        # A tiny reference-only marker, deliberately subordinate to the content.
        marker = f"{entry['label']} · {entry['id']}"
        self.draw_text(base, marker, "thin", (size[0] - (320 if aspect == "horizontal" else 410), size[1] - 68, size[0] - 35, size[1] - 25), maximum=14 if aspect == "horizontal" else 17, minimum=10, fill=(50, 54, 61, 150), anchor="rm", entry_id=entry["id"])
        relative = Path(f"{entry['kind']}s") / f"{entry['id']}_{aspect}.png"
        destination = self.output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        base.convert("RGB").save(destination, format="PNG", compress_level=6)
        head_collision = max((self.intersection_ratio(tuple(box), ctx["head"]) for box in elements if box), default=0)
        evidence = {
            "entryId": entry["id"],
            "kind": entry["kind"],
            "aspect": aspect,
            "style": self.style,
            "archetype": archetype,
            "compositionVariant": int(variant),
            "asset": relative.as_posix(),
            "headCollisionRatio": round(head_collision, 5),
            "elements": [list(box) for box in elements if box],
            "headBounds": list(ctx["head"]),
            "subtitleSafeZone": list(ctx["subtitle"]),
        }
        self.layout_evidence.append(evidence)
        return evidence


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--source-manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--style", choices=["light", "spatial"], required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--limit", type=int, default=0, help="Render only the first N entries for smoke testing")
    parser.add_argument("--entry-id", default="", help="Render a single effect ID for focused review")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    source_dir = Path(args.source_dir).resolve()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(Path(args.source_manifest).read_text(encoding="utf-8"))
    renderer = FrameRenderer(project_root, source_dir, output, args.style)
    entries = [entry for entry in manifest["entries"] if entry["id"] == args.entry_id] if args.entry_id else manifest["entries"]
    entries = entries[:args.limit] if args.limit > 0 else entries
    if not entries:
        raise ValueError(f"没有找到要渲染的效果：{args.entry_id or 'empty manifest'}")
    for index, entry in enumerate(entries, start=1):
        for aspect in ("horizontal", "vertical"):
            renderer.render(entry, aspect)
        if index % 20 == 0:
            print(f"{args.style}: {index}/{len(entries)}", flush=True)

    evidence = {
        "schemaVersion": "1.0",
        "renderer": "pillow-explicit-font-files",
        "style": args.style,
        "fontBindings": {
            role: {"path": str(path.relative_to(project_root)), "sha256": renderer.font_hashes[role]}
            for role, path in renderer.font_paths.items()
        },
        "fontEvidence": renderer.font_evidence,
        "layoutEvidence": renderer.layout_evidence,
    }
    evidence["digest"] = hashlib.sha256(json.dumps(evidence, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    Path(args.evidence).write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "pass", "images": len(renderer.layout_evidence), "evidence": args.evidence, "digest": evidence["digest"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
