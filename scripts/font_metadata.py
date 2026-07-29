#!/usr/bin/env python3

import argparse
import json
from pathlib import Path

from fontTools.ttLib import TTFont


def decode_names(font, name_id):
    values = []
    for record in font["name"].names:
        if record.nameID != name_id:
            continue
        try:
            value = record.toUnicode().strip()
        except Exception:
            continue
        if value and value not in values:
            values.append(value)
    return values


def license_record(font):
    copyright_values = decode_names(font, 0)
    license_values = decode_names(font, 13)
    license_urls = decode_names(font, 14)
    combined = "\n".join(copyright_values + license_values + license_urls)
    lowered = combined.lower()
    if "sil open font license" in lowered:
        status = "open"
        identifier = "OFL-1.1"
    elif "apache license" in lowered:
        status = "open"
        identifier = "Apache-2.0"
    elif any(token in lowered for token in [
        "must be authorized",
        "commercial use",
        "商业使用",
        "购买许可",
        "正式书面许可",
        "all rights reserved",
        "保留所有权利",
    ]):
        status = "authorization_required"
        identifier = None
    elif combined:
        status = "unverified"
        identifier = None
    else:
        status = "unknown"
        identifier = None
    return {
        "status": status,
        "identifier": identifier,
        "copyright": copyright_values,
        "licenseText": license_values,
        "licenseUrls": license_urls,
    }


def coverage(font):
    cmap = {}
    for table in font["cmap"].tables:
        cmap.update(table.cmap)
    samples = {
        "latin": "AaZz",
        "digits": "0123456789",
        "simplifiedChinese": "字幕设计信息情绪视角",
        "traditionalChinese": "字幕設計資訊情緒視角",
        "punctuation": "，。！？：；“”",
    }
    result = {}
    for key, sample in samples.items():
        supported = sum(ord(character) in cmap for character in sample)
        result[key] = {
            "supported": supported,
            "total": len(sample),
            "ratio": supported / len(sample),
        }
    return result


def inspect(path):
    font = TTFont(path, lazy=True)
    os2 = font.get("OS/2")
    postscript = decode_names(font, 6)
    full_names = decode_names(font, 4)
    families = decode_names(font, 1)
    subfamilies = decode_names(font, 2)
    record = {
        "file": str(path.resolve()),
        "fileName": path.name,
        "families": families,
        "fullNames": full_names,
        "postscriptNames": postscript,
        "subfamilies": subfamilies,
        "weightClass": getattr(os2, "usWeightClass", None),
        "widthClass": getattr(os2, "usWidthClass", None),
        "italic": bool(getattr(os2, "fsSelection", 0) & 1),
        "coverage": coverage(font),
        "license": license_record(font),
    }
    font.close()
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()
    records = []
    errors = []
    for item in args.files:
        path = Path(item)
        try:
            records.append(inspect(path))
        except Exception as error:
            errors.append({"file": str(path), "error": str(error)})
    print(json.dumps({
        "schemaVersion": "1.0",
        "records": records,
        "errors": errors,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
