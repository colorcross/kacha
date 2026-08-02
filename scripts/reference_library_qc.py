#!/usr/bin/env python3
"""Triad gate for Kacha reference semantics, peak frames, and motion contracts."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageOps, ImageStat


FONT_HASHES = {
    "subtitle": "3c15643db0ef339e1faf39b8b0c12ffead661565876e617fd25ca5209eabb1ea",
    "display": "7446486b30fd433fb56ea7b745549f326218ea9161785deaf1a7df0ec8e124a0",
    "ui": "317e53f4b71c757b9c2317354570f03dacae2321cbd6eb3f256c0b71c45610da",
    "cover": "4a2701607972a3b4804019b656800b7778deb6e1767093fc56a110eac48083ed",
}

EXPECTED_RENDERERS = {
    "chrome-svg-explicit-embedded-fonts",
    "rsvg-fontconfig-explicit-project-fonts",
}

# After removing the same-renderer A-roll and normalizing to changed bounds,
# 0.012 captures effectively identical peak geometry while avoiding false
# positives caused by a shared style texture or reusable motion vocabulary.
NEAR_DUPLICATE_FEATURE_THRESHOLD = 0.012

# These effects intentionally replace A-roll. They still need their own layout
# checks, but comparing their pixels against the source portrait is meaningless.
FULL_FRAME_REPLACEMENT_IDS = {
    "full_screen_insert",
    "tool_screen_full",
    "full_bleed_event_photo",
    "full_screen",
    "full_bleed_footage",
}

INTENTIONAL_SUBJECT_RECOMPOSITION_IDS = {
    "split_vertical",
    "split_horizontal",
    "compare_two",
    "compare_before_after",
    "compare_beauty",
    "compare_audio",
    "split_vertical_demo",
    "split_horizontal_demo",
    "split_cover",
    "two_panes",
    "two_panes_subject_aware",
}


def motion_diagram_family(archetype: str | None) -> str:
    """Mirror the renderer's intentional peak-diagram families.

    Motion contracts in the same family may share a peak geometry while their
    timing, trigger, label and exit behavior differ. They should be reported as
    declared family similarities, not unresolved duplicate candidates.
    """
    value = archetype or "generic"
    exact_groups = {
        "type": {"typewriter", "typing-pop", "cursor-release"},
        "split": {"center-split", "split-reveal", "wipe-compare", "split-merge"},
        "progressive": {
            "ab-sequence", "claim-verdict", "label-title", "phrase-groups",
            "progressive", "progressive-local", "quote-source", "stagger",
            "step-up", "strike-replace", "term-body", "term-definition", "pip-focus",
        },
        "cut": {
            "audio-bridge", "match-cut", "phrase-cut", "clean-cut", "cut-push",
            "instant-cut", "speech-start-cut", "time-jump",
        },
        "reveal": {
            "directional-reveal", "mask-reveal", "result-reveal", "target-reveal",
            "local-wipe", "shape-morph",
        },
        "scale": {
            "collapse-center", "converge-result", "numeric-punch", "grow-zero",
            "scale-fade", "soft-pop", "task-card",
        },
        "fade": {"fade", "short-fade", "complete-fade"},
        "line": {"line-draw", "timeline-grow"},
        "hold": {"natural-hold", "static"},
        "return": {"return-dialogue", "return-subject", "return-original"},
    }
    for family, members in exact_groups.items():
        if value in members:
            return family
    if any(token in value for token in ("preclear", "audio-boundary", "speech-end", "audio-end-cut")):
        return "boundary"
    if any(token in value for token in ("highlight", "marker", "result-tag", "word-emphasis", "turning-point", "segment")):
        return "highlight"
    if value in {"arc-progress", "branch-tree"}:
        return value
    return "generic"


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def perceptual_feature(path: Path, reference_path: Path | None = None) -> tuple[int, Image.Image, int]:
    image = Image.open(path).convert("RGB")
    if reference_path and reference_path.exists():
        reference = Image.open(reference_path).convert("RGB").resize(image.size, Image.Resampling.LANCZOS)
        image = ImageChops.difference(image, reference).convert("L")
    else:
        image = image.convert("L")
    width, height = image.size
    image = image.crop((0, int(height * 0.10), width, int(height * 0.92)))
    # Compare the actual overlay, not the mostly unchanged A-roll. Full-frame
    # thumbnails made unrelated cards look identical because the portrait and
    # bookshelf dominated every fingerprint. Normalize to the changed-pixel
    # bounds while retaining a small context margin for shape and placement.
    changed = image.point(lambda value: 255 if value >= 12 else 0)
    bounds = changed.getbbox()
    if bounds:
        x1, y1, x2, y2 = bounds
        pad_x = max(4, round((x2 - x1) * 0.06))
        pad_y = max(4, round((y2 - y1) * 0.06))
        image = image.crop((
            max(0, x1 - pad_x),
            max(0, y1 - pad_y),
            min(image.width, x2 + pad_x),
            min(image.height, y2 + pad_y),
        ))
    # Keep the thumbnail as a Pillow image. Pairwise differences then run in C
    # through ImageChops instead of executing hundreds of millions of Python
    # abs() calls for the four 240-effect libraries.
    raw_feature = image.resize((32, 32), Image.Resampling.LANCZOS)
    feature_sum = int(ImageStat.Stat(raw_feature).sum[0])
    resized = ImageOps.autocontrast(image).resize((17, 16), Image.Resampling.LANCZOS)
    flattened = resized.get_flattened_data() if hasattr(resized, "get_flattened_data") else resized.getdata()
    pixels = list(flattened)
    bits = 0
    for row in range(16):
        for column in range(16):
            bits = (bits << 1) | int(pixels[row * 17 + column] > pixels[row * 17 + column + 1])
    return bits, raw_feature, feature_sum


def head_mask(mask_path: Path, size: tuple[int, int]) -> Image.Image | None:
    if not mask_path.exists():
        return None
    mask = Image.open(mask_path).convert("L").resize(size, Image.Resampling.NEAREST)
    mask = mask.point(lambda value: 255 if value >= 32 else 0)
    bounds = mask.getbbox()
    if not bounds:
        return None
    x1, y1, x2, y2 = bounds
    head_bottom = min(y2, y1 + round((y2 - y1) * 0.34))
    head = Image.new("L", size, 0)
    head.paste(mask.crop((x1, y1, x2, head_bottom)), (x1, y1))
    return head


def changed_ratio_in_mask(image: Image.Image, reference: Image.Image, mask: Image.Image) -> float:
    difference = ImageChops.difference(image.convert("RGB"), reference.convert("RGB")).convert("L")
    changed = difference.point(lambda value: 255 if value >= 20 else 0)
    protected = ImageChops.multiply(changed, mask)
    changed_pixels = protected.histogram()[255]
    protected_pixels = mask.histogram()[255]
    return changed_pixels / max(1, protected_pixels)


def added_near_black_ratio(image: Image.Image, reference: Image.Image) -> float:
    current = image.convert("L").point(lambda value: 255 if value <= 24 else 0)
    original = reference.convert("L").point(lambda value: 255 if value <= 24 else 0)
    added = ImageChops.subtract(current, original)
    return added.histogram()[255] / max(1, image.width * image.height)


def validate_library(directory: Path, style: str, semantics: dict, contracts: dict) -> dict:
    failures: list[str] = []
    warnings: list[str] = []
    manifest_path = directory / "manifest.json"
    evidence_path = directory / "render-evidence.json"
    if not manifest_path.exists() or not evidence_path.exists():
        raise FileNotFoundError(f"图库缺少 manifest 或 render evidence：{directory}")
    manifest, evidence = load(manifest_path), load(evidence_path)
    effects = manifest.get("effects", [])
    expected_images = len(effects) * 2
    assets = [asset for effect in effects for asset in effect.get("assets", {}).values()]
    semantic_map = {(item["kind"], item["id"]): item for item in semantics["items"]}
    effect_map = {(item["kind"], item["id"]): item for item in effects}
    if len(effects) != semantics["counts"]["total"]:
        failures.append(f"effects={len(effects)}，预期 {semantics['counts']['total']}")
    if len(effect_map) != len(effects):
        failures.append("效果 kind+id 不唯一")
    if len(assets) != expected_images:
        failures.append(f"assets={len(assets)}，预期 {expected_images}")
    if manifest.get("semanticCatalogDigest") != semantics.get("digest"):
        failures.append("manifest.semanticCatalogDigest 与权威语义目录不一致")
    if evidence.get("semanticCatalogDigest") != semantics.get("digest"):
        failures.append("render-evidence.semanticCatalogDigest 与权威语义目录不一致")
    if evidence.get("style") != style:
        failures.append(f"render-evidence.style={evidence.get('style')}，预期 {style}")
    if evidence.get("renderer") not in EXPECTED_RENDERERS:
        failures.append("render-evidence 未声明受支持的显式字体 SVG 渲染器")
    if not evidence.get("semanticRendering", {}).get("effectSpecificDispatch"):
        failures.append("渲染证据没有声明逐效果语义分发")
    if evidence.get("semanticRendering", {}).get("randomArchetypeDispatch"):
        failures.append("渲染仍在使用随机构图分发")
    evidence_fonts = evidence.get("fontBindings", {})
    for role, expected_hash in FONT_HASHES.items():
        evidence_role = "ui" if role == "ui" else role
        if evidence_fonts.get(evidence_role, {}).get("sha256") != expected_hash:
            failures.append(f"render-evidence 字体角色 {role} 未锁定指定文件哈希")
    assurance = evidence.get("qualityAssurance", {})
    if assurance.get("headProtectionFromPersonMask") is not True:
        failures.append("render-evidence 未声明由真实人物蒙版保护头脸")
    if assurance.get("localContrastPreflight") is not True:
        failures.append("render-evidence 未声明局部文字对比度预检")
    if assurance.get("horizontalAndVerticalAreIndependentlyComposed") is not True:
        failures.append("render-evidence 未声明横竖版独立构图")
    if assurance.get("normalSubtitleHasNoBackgroundOrOutline") is not True:
        failures.append("render-evidence 未声明常规字幕无背景和描边")
    if assurance.get("componentIdentityPreservedAcrossStyles") is not True:
        failures.append("render-evidence 未声明四风格均保留组件 ID 的独立形状与信息关系")
    if assurance.get("editingGrammarDiffersAcrossStyles") is not True:
        failures.append("render-evidence 未声明四风格使用不同剪辑语法")
    evidence_grammar = evidence.get("editingGrammar", {})
    manifest_grammar = manifest.get("style", {}).get("grammar", {})
    grammar_id = evidence_grammar.get("grammarSignature", {}).get("id")
    if not grammar_id:
        failures.append("render-evidence 缺少剪辑语法签名")
    if manifest_grammar.get("grammarSignature", {}).get("id") != grammar_id:
        failures.append("manifest 与 render-evidence 的剪辑语法签名不一致")
    if evidence.get("semanticCatalogRole") != "shared-effect-intent-core-not-a-style-grammar":
        failures.append("共享语义目录被误当成风格剪辑语法")
    qc_reference_bindings = evidence.get("qcReferenceBindings", {})
    for aspect in ("horizontal", "vertical"):
        binding = qc_reference_bindings.get(aspect, {})
        reference_file = directory / binding.get("path", "__missing__")
        if (
            binding.get("purpose") != "same-renderer-unpackaged-footage-control"
            or not reference_file.exists()
            or sha256_file(reference_file) != binding.get("sha256")
        ):
            failures.append(f"render-evidence 缺少可信的 {aspect} 同渲染器控制帧")
    material_metrics = evidence.get("materialMetrics", {})
    if material_metrics.get("fullFrameCartoonOrPixelFilter") is not False:
        failures.append("render-evidence 未禁止全屏漫画化或像素化滤镜")
    if style == "comic" and material_metrics.get("maximumHalftoneAreaRatio", 1) > 0.18:
        failures.append("幽默漫画网点覆盖率超过 18%")
    if style == "pixel" and material_metrics.get("maximumPixelGridAreaRatio", 1) > 0.24:
        failures.append("像素风网格覆盖率超过 24%")
    brand_metrics = evidence.get("persistentBrandMetrics", {})
    if brand_metrics.get("minimumPrimaryFontPxAt1080p", 0) < 22:
        failures.append("常驻品牌模块手机端字号基线不足")
    if brand_metrics.get("maximumOpacity", 1) > 0.82:
        failures.append("常驻品牌模块显著度过高")
    if brand_metrics.get("maximumSalienceRatioToPrimaryTitle", 1) > 0.35:
        failures.append("常驻品牌模块相对主标题的视觉显著度过高")

    missing_assets = []
    bad_dimensions = []
    bad_hashes = []
    hashes = []
    perceptual = {"horizontal": [], "vertical": []}
    reference_paths = {
        aspect: (directory / source).resolve()
        for aspect, source in {
            "horizontal": manifest.get("sources", {}).get("renderedHorizontalReference")
                or manifest.get("sources", {}).get("horizontal"),
            "vertical": manifest.get("sources", {}).get("renderedVerticalReference")
                or manifest.get("sources", {}).get("vertical"),
        }.items()
        if source
    }
    mask_paths = {
        aspect: (directory / source).resolve()
        for aspect, source in {
            "horizontal": manifest.get("sources", {}).get("horizontalPersonMask"),
            "vertical": manifest.get("sources", {}).get("verticalPersonMask"),
        }.items()
        if source
    }
    reference_cache: dict[str, Image.Image] = {}
    head_mask_cache: dict[str, Image.Image | None] = {}
    head_collision_assets: list[str] = []
    spatial_black_assets: list[str] = []
    for effect in effects:
        key = (effect["kind"], effect["id"])
        expected_subject_policy = (
            "full-frame-replacement"
            if effect["id"] in FULL_FRAME_REPLACEMENT_IDS
            else "intentional-recomposition"
            if effect["id"] in INTENTIONAL_SUBJECT_RECOMPOSITION_IDS
            else "overlay-in-caption-safe-zone"
            if "subtitle" in f"{effect['kind']}:{effect['id']}"
            else "preserve-via-person-mask-foreground"
        )
        if effect.get("subjectPixelPolicy") != expected_subject_policy:
            failures.append(f"人物像素策略与注册效果类型不一致：{key}")
        semantic = semantic_map.get(key)
        if not semantic:
            failures.append(f"缺少语义：{key}")
            continue
        effect_semantic = effect.get("semantic", {})
        if effect_semantic.get("semanticDigest") != semantic.get("semanticDigest"):
            failures.append(f"峰值帧清单语义摘要漂移：{key}")
        if effect.get("label") != semantic.get("label"):
            failures.append(f"效果标签与语义目录不一致：{key}")
        contract = contracts.get(key)
        if not contract:
            failures.append(f"缺少动效合同：{key}")
        else:
            alignment = contract.get("semanticAlignment", {})
            if alignment.get("semanticDigest") != semantic.get("semanticDigest"):
                failures.append(f"动效合同语义摘要漂移：{key}")
            semantic_core = contract.get("semanticMotionCore", {})
            for field in ("trigger", "entry", "hold", "exit", "sfx"):
                if semantic_core.get(field) != semantic["motion"][field]:
                    failures.append(f"合同 semanticMotionCore.{field} 未使用同源语义：{key}")
        for aspect, asset in effect.get("assets", {}).items():
            image_path = directory / asset["path"]
            if not image_path.exists():
                missing_assets.append(asset["path"])
                continue
            actual_hash = sha256_file(image_path)
            hashes.append((actual_hash, key, aspect))
            if actual_hash != asset.get("sha256"):
                bad_hashes.append(asset["path"])
            with Image.open(image_path) as opened_image:
                image = opened_image.convert("RGB")
                if image.size != (asset["width"], asset["height"]):
                    bad_dimensions.append(asset["path"])
                stat = ImageStat.Stat(image.convert("L").resize((64, 64)))
                if stat.stddev[0] < 8:
                    failures.append(f"疑似空白或异常低信息图：{asset['path']}")
                if aspect in reference_paths:
                    if aspect not in reference_cache:
                        reference_cache[aspect] = Image.open(reference_paths[aspect]).convert("RGB").resize(image.size, Image.Resampling.LANCZOS)
                    reference = reference_cache[aspect]
                    if aspect not in head_mask_cache:
                        head_mask_cache[aspect] = head_mask(mask_paths.get(aspect, Path("/__missing__")), image.size)
                    protected_head = head_mask_cache[aspect]
                    if (
                        protected_head is not None
                        and expected_subject_policy
                        in {"preserve-via-person-mask-foreground", "overlay-in-caption-safe-zone"}
                    ):
                        if changed_ratio_in_mask(image, reference, protected_head) > 0.012:
                            head_collision_assets.append(asset["path"])
                    if (
                        style == "spatial"
                        and effect.get("id") not in FULL_FRAME_REPLACEMENT_IDS
                        and effect.get("id") not in INTENTIONAL_SUBJECT_RECOMPOSITION_IDS
                        and added_near_black_ratio(image, reference) > 0.025
                    ):
                        spatial_black_assets.append(asset["path"])
            perceptual_hash, feature, feature_sum = perceptual_feature(image_path, reference_paths.get(aspect))
            perceptual[aspect].append((perceptual_hash, feature, feature_sum, key))
    if missing_assets:
        failures.append(f"缺少 {len(missing_assets)} 个参考图")
    if bad_dimensions:
        failures.append(f"尺寸错误 {len(bad_dimensions)} 张")
    if bad_hashes:
        failures.append(f"素材哈希漂移 {len(bad_hashes)} 张")
    if head_collision_assets:
        failures.append(f"人物头脸像素被效果覆盖 {len(head_collision_assets)} 张")
    if spatial_black_assets:
        failures.append(f"空间光路新增近黑区域过大 {len(spatial_black_assets)} 张")
    hash_groups: dict[str, list[tuple[tuple[str, str], str]]] = {}
    for asset_hash, key, aspect in hashes:
        hash_groups.setdefault(asset_hash, []).append((key, aspect))
    duplicate_groups = [items for items in hash_groups.values() if len(items) > 1]
    allowed_duplicate_groups = []
    disallowed_duplicate_groups = []
    for items in duplicate_groups:
        equivalence_groups = {
            semantic_map[key].get("relationships", {}).get("visualEquivalenceGroup")
            for key, _aspect in items
        }
        if len(equivalence_groups) == 1 and None not in equivalence_groups:
            allowed_duplicate_groups.append(items)
        else:
            disallowed_duplicate_groups.append(items)
    exact_duplicates = sum(len(items) - 1 for items in disallowed_duplicate_groups)
    allowed_exact_duplicates = sum(len(items) - 1 for items in allowed_duplicate_groups)
    if exact_duplicates:
        failures.append(f"存在 {exact_duplicates} 个未声明等价关系的完全重复参考图")

    near_pairs = []
    family_similarity_pairs = []
    for aspect, items in perceptual.items():
        for index, (left_hash, left_feature, left_sum, left_key) in enumerate(items):
            for right_hash, right_feature, right_sum, right_key in items[index + 1 :]:
                distance = (left_hash ^ right_hash).bit_count()
                left_group = semantic_map[left_key].get("relationships", {}).get("visualEquivalenceGroup")
                right_group = semantic_map[right_key].get("relationships", {}).get("visualEquivalenceGroup")
                declared_equivalent = left_group is not None and left_group == right_group
                left_relationships = semantic_map[left_key].get("relationships", {})
                right_relationships = semantic_map[right_key].get("relationships", {})
                same_motion_family = (
                    left_key[0] == "motion"
                    and left_relationships.get("family") is not None
                    and left_relationships.get("family") == right_relationships.get("family")
                )
                same_motion_diagram = (
                    left_key[0] == "motion"
                    and motion_diagram_family(semantic_map[left_key].get("visualArchetype"))
                    == motion_diagram_family(semantic_map[right_key].get("visualArchetype"))
                )
                same_layout_template = (
                    left_key[0] == "layout"
                    and left_relationships.get("template") is not None
                    and left_relationships.get("template") == right_relationships.get("template")
                )
                direct_fallback_family = (
                    left_relationships.get("fallback") == right_key[1]
                    or right_relationships.get("fallback") == left_key[1]
                )
                same_full_frame_replacement = (
                    left_key[1] in FULL_FRAME_REPLACEMENT_IDS
                    and right_key[1] in FULL_FRAME_REPLACEMENT_IDS
                )
                same_persistent_brand_family = (
                    left_key[0] == "component"
                    and semantic_map[left_key].get("category") == "brand"
                    and semantic_map[right_key].get("category") == "brand"
                )
                declared_family_similarity = (
                    declared_equivalent
                    or same_motion_family
                    or same_motion_diagram
                    or same_layout_template
                    or direct_fallback_family
                    or same_full_frame_replacement
                    or same_persistent_brand_family
                )
                feature_delta = ImageStat.Stat(ImageChops.difference(left_feature, right_feature)).sum[0]
                feature_energy = max(1, (left_sum + right_sum + feature_delta) / 2)
                feature_distance = feature_delta / feature_energy
                if (
                    distance <= 2
                    and feature_distance <= NEAR_DUPLICATE_FEATURE_THRESHOLD
                    and left_key[0] == right_key[0]
                ):
                    pair = {
                        "aspect": aspect,
                        "left": ":".join(left_key),
                        "right": ":".join(right_key),
                        "hashDistance": distance,
                        "featureDistance": round(feature_distance, 3),
                    }
                    if declared_family_similarity:
                        family_similarity_pairs.append(pair)
                    else:
                        near_pairs.append(pair)
    if near_pairs:
        warnings.append(f"发现 {len(near_pairs)} 组未声明家族关系的近似峰值图，已写入报告供复核")

    bindings = manifest.get("fonts", {}).get("bindings", {})
    for role, expected_hash in FONT_HASHES.items():
        binding = bindings.get(role)
        if not binding or binding.get("sha256") != expected_hash:
            failures.append(f"字体角色 {role} 未绑定指定文件哈希")
        if binding and binding.get("fallbackUsed"):
            failures.append(f"字体角色 {role} 发生静默回退")
    subtitle_contracts = [item for item in contracts.values()]
    if any(item.get("typographyContract", {}).get("subtitle", {}).get("shadowOpacity") != 0.6 for item in subtitle_contracts):
        failures.append("存在字幕阴影不为60%的合同")
    if any(item.get("typographyContract", {}).get("subtitle", {}).get("background") != "none" for item in subtitle_contracts):
        failures.append("存在常规字幕背景未关闭的合同")

    return {
        "style": style,
        "editingGrammarId": grammar_id,
        "effects": len(effects),
        "images": len(assets),
        "semanticTriads": len(effects),
        "exactDuplicateAssets": exact_duplicates,
        "allowedExactDuplicateAssets": allowed_exact_duplicates,
        "allowedExactDuplicateGroups": [
            [f"{key[0]}:{key[1]}:{aspect}" for key, aspect in items]
            for items in allowed_duplicate_groups
        ],
        "disallowedExactDuplicateGroups": [
            [f"{key[0]}:{key[1]}:{aspect}" for key, aspect in items]
            for items in disallowed_duplicate_groups
        ],
        "nearDuplicatePairs": near_pairs[:100],
        "nearDuplicatePairCount": len(near_pairs),
        "declaredFamilySimilarityPairs": family_similarity_pairs[:100],
        "declaredFamilySimilarityPairCount": len(family_similarity_pairs),
        "headCollisionAssetCount": len(head_collision_assets),
        "headCollisionAssets": head_collision_assets[:100],
        "spatialBlackAssetCount": len(spatial_black_assets),
        "spatialBlackAssets": spatial_black_assets[:100],
        "fontBindings": {role: bindings.get(role, {}) for role in FONT_HASHES},
        "failures": failures,
        "warnings": warnings,
        "_assetHashes": [
            {"sha256": asset_hash, "kind": key[0], "id": key[1], "aspect": aspect}
            for asset_hash, key, aspect in hashes
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--light", required=True)
    parser.add_argument("--spatial", required=True)
    parser.add_argument("--comic", required=True)
    parser.add_argument("--pixel", required=True)
    parser.add_argument("--contracts", required=True)
    parser.add_argument("--semantics", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()
    semantics = load(Path(args.semantics))
    registry = load(Path(args.contracts))
    style_specs = [
        ("light", Path(args.light), "xingzhe-light-overlay"),
        ("spatial", Path(args.spatial), "xingzhe-spatial-lightpath"),
        ("comic", Path(args.comic), "xingzhe-humor-comic"),
        ("pixel", Path(args.pixel), "xingzhe-pixel-editorial"),
    ]
    report = {
        "schemaVersion": "2.0",
        "kind": "kacha_reference_triad_qc",
        "semanticCatalogDigest": semantics.get("digest"),
        "libraries": [],
    }
    for style, directory, style_id in style_specs:
        style_contracts = {
            (item["effect"]["kind"], item["effect"]["id"]): item
            for item in registry.get("contracts", [])
            if item.get("style", {}).get("id") == style_id
        }
        report["libraries"].append(
            validate_library(directory, style, semantics, style_contracts)
        )
    cross_style_hashes: dict[str, list[dict]] = {}
    for library in report["libraries"]:
        for item in library.pop("_assetHashes", []):
            cross_style_hashes.setdefault(item["sha256"], []).append({
                "style": library["style"],
                **{key: value for key, value in item.items() if key != "sha256"},
            })
    cross_style_duplicates = [
        items
        for items in cross_style_hashes.values()
        if len({item["style"] for item in items}) > 1
    ]
    report["crossStyleExactDuplicateGroupCount"] = len(cross_style_duplicates)
    report["crossStyleExactDuplicateGroups"] = cross_style_duplicates[:100]
    if cross_style_duplicates:
        for library in report["libraries"]:
            library["failures"].append(
                f"存在 {len(cross_style_duplicates)} 组跨风格完全重复参考图，四套视觉语言未真正分离"
            )
    grammar_ids = [library.get("editingGrammarId") for library in report["libraries"]]
    report["distinctEditingGrammarCount"] = len(set(grammar_ids))
    if None in grammar_ids or len(set(grammar_ids)) != len(style_specs):
        for library in report["libraries"]:
            library["failures"].append("四套效果库没有四个互不相同的剪辑语法签名")
    failures = [failure for library in report["libraries"] for failure in library["failures"]]
    report["status"] = "pass" if not failures else "fail"
    report["failures"] = failures
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        Path(args.output).write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
