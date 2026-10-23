#!/usr/bin/env python3
"""Keep Ubuntu runner updates off the intermittently unavailable Azure mirror."""
import argparse
from pathlib import Path
import re


def configure(root: Path) -> list[str]:
    changed = []
    for relative in ("apt-mirrors.txt", "apt-mirrors-security.txt", "sources.list", "sources.list.d/ubuntu.sources"):
        file = root / relative
        if not file.is_file():
            continue
        before = file.read_text()
        host = "security.ubuntu.com" if relative == "apt-mirrors-security.txt" else "archive.ubuntu.com"
        after = re.sub(r"https?://azure\.archive\.ubuntu\.com/ubuntu(?=/|\s|$)", f"https://{host}/ubuntu", before)
        after = re.sub(r"http://(archive|security)\.ubuntu\.com/ubuntu(?=/|\s|$)", r"https://\1.ubuntu.com/ubuntu", after)
        if relative.startswith("apt-mirrors"):
            seen = set()
            lines = []
            for line in after.splitlines():
                key = line.strip()
                if key and not key.startswith("#"):
                    if key in seen:
                        continue
                    seen.add(key)
                lines.append(line)
            after = "\n".join(lines) + ("\n" if after.endswith("\n") else "")
        if after != before:
            file.write_text(after)
            changed.append(relative)
    config = root / "apt.conf.d/80kacha-network-timeouts"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text('Acquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAcquire::Retries "2";\n')
    return changed


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("/etc/apt"))
    args = parser.parse_args()
    for name in configure(args.root):
        print(f"Configured official Ubuntu HTTPS mirror: {name}")
