#!/usr/bin/env python3
"""Fail-closed scan for common secrets and private local paths."""

from __future__ import annotations

import math
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SENSITIVE_NAMES = {
    ".env",
    "media.env",
    "credentials.json",
    "secrets.json",
    "auth.json",
    "id_rsa",
    "id_ed25519",
}
TEXT_SUFFIXES = {
    "",
    ".c",
    ".cc",
    ".css",
    ".go",
    ".h",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mjs",
    ".py",
    ".rb",
    ".rs",
    ".sh",
    ".swift",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}
PATTERNS = {
    "private key": re.compile(
        r"-{5}BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-{5}"
    ),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    "OpenAI-style key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "Slack token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    "Bearer token": re.compile(
        r"(?i)\bauthorization\s*[:=]\s*[\"']?bearer\s+[A-Za-z0-9._~+/=-]{16,}"
    ),
    "credential assignment": re.compile(
        r"(?i)\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*"
        r"[\"'][^\"'\s]{12,}[\"']"
    ),
    "macOS user path": re.compile(r"/Users/[^/\s\"']+/"),
}
ALLOW_LINE_MARKERS = (
    "scan_secrets.py",
    "在本机设置，不要写进仓库",
)


def git_candidates() -> list[Path]:
    result = subprocess.run(
        [
            "git",
            "-C",
            str(ROOT),
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        check=True,
        capture_output=True,
    )
    return [
        ROOT / item.decode("utf-8")
        for item in result.stdout.split(b"\0")
        if item
    ]


def entropy(value: str) -> float:
    if not value:
        return 0.0
    return -sum(
        (value.count(char) / len(value)) * math.log2(value.count(char) / len(value))
        for char in set(value)
    )


def main() -> int:
    findings: list[str] = []
    for path in git_candidates():
        relative = path.relative_to(ROOT)
        if path.name in SENSITIVE_NAMES or path.suffix.lower() in {
            ".key",
            ".p12",
            ".pfx",
            ".pem",
        }:
            findings.append(f"{relative}: sensitive filename")
            continue
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for line_number, line in enumerate(text.splitlines(), start=1):
            if any(marker in line for marker in ALLOW_LINE_MARKERS):
                continue
            for label, pattern in PATTERNS.items():
                if (
                    relative == Path("scripts/scan_secrets.py")
                    and label == "macOS user path"
                ):
                    continue
                if pattern.search(line):
                    findings.append(f"{relative}:{line_number}: {label}")
            for candidate in re.findall(r"[A-Za-z0-9+/=_-]{40,}", line):
                if (
                    entropy(candidate) >= 4.5
                    and not candidate.startswith(("http", "sha256"))
                    and relative.name not in {
                        "package-lock.json",
                        "pnpm-lock.yaml",
                        "yarn.lock",
                    }
                ):
                    findings.append(
                        f"{relative}:{line_number}: high-entropy string; review manually"
                    )

    if findings:
        print(f"Secret scan failed: {len(findings)} finding(s)", file=sys.stderr)
        for finding in sorted(set(findings)):
            print(f"- {finding}", file=sys.stderr)
        return 1
    print("Secret scan passed: no common credentials or private user paths found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
