#!/usr/bin/env python3
"""Synchronize actual Git changes into a completion contract without advancing status."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import subprocess
from pathlib import Path


def sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def run_git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=root, text=True, capture_output=True, check=False)
    if result.returncode:
        raise ValueError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout


def parse_maps(values: list[str]) -> list[tuple[str, str]]:
    result = []
    for value in values:
        if "=" not in value:
            raise ValueError(f"task map must be PATTERN=TASK_ID: {value}")
        pattern, task_id = value.rsplit("=", 1)
        if not pattern or not task_id:
            raise ValueError(f"task map must be PATTERN=TASK_ID: {value}")
        result.append((pattern, task_id))
    return result


def git_changes(root: Path, baseline: str) -> list[str]:
    run_git(root, "rev-parse", "--verify", f"{baseline}^{{commit}}")
    changed = run_git(root, "diff", "--relative", "--name-only", "--diff-filter=ACDMRTUXB", baseline, "--", ".")
    untracked = run_git(root, "ls-files", "--others", "--exclude-standard", "--", ".")
    return sorted({line.strip() for line in (changed + "\n" + untracked).splitlines() if line.strip()})


def baseline_bytes(root: Path, baseline: str, relative: str) -> bytes | None:
    prefix = run_git(root, "rev-parse", "--show-prefix").strip()
    repository_path = f"{prefix}{relative}"
    result = subprocess.run(
        ["git", "show", f"{baseline}:{repository_path}"], cwd=root, capture_output=True, check=False
    )
    return result.stdout if result.returncode == 0 else None


def assign(path: str, mappings: list[tuple[str, str]], default_task: str | None) -> list[str]:
    matches = [task_id for pattern, task_id in mappings if fnmatch.fnmatch(path, pattern)]
    if not matches and default_task:
        matches = [default_task]
    return list(dict.fromkeys(matches))


def synchronize(
    root: Path,
    contract_path: Path,
    baseline: str,
    mappings: list[tuple[str, str]],
    default_task: str | None,
    scan_disabled: list[str],
) -> tuple[dict, list[str]]:
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    task_ids = {item.get("id") for item in contract.get("tasks", []) if isinstance(item, dict)}
    unknown = sorted({task_id for _, task_id in mappings if task_id not in task_ids})
    if default_task and default_task not in task_ids:
        unknown.append(default_task)
    if unknown:
        raise ValueError(f"task maps reference missing tasks: {', '.join(sorted(set(unknown)))}")
    evidence_paths = {
        item.get("path") for item in contract.get("evidence", [])
        if isinstance(item, dict) and isinstance(item.get("path"), str)
    }
    contract_relative = str(contract_path.relative_to(root))
    records = []
    unassigned = []
    for relative in git_changes(root, baseline):
        if relative == contract_relative or relative in evidence_paths:
            continue
        task_refs = assign(relative, mappings, default_task)
        if not task_refs:
            unassigned.append(relative)
            continue
        path = root / relative
        before = baseline_bytes(root, baseline, relative)
        after = path.read_bytes() if path.is_file() else None
        if before is None and after is not None:
            change_type = "created"
        elif before is not None and after is None:
            change_type = "deleted"
        else:
            change_type = "modified"
        records.append(
            {
                "path": relative,
                "changeType": change_type,
                "beforeDigest": sha256_bytes(before) if before is not None else None,
                "afterDigest": sha256_bytes(after) if after is not None else None,
                "taskRefs": task_refs,
                "scanForPlaceholders": not any(fnmatch.fnmatch(relative, pattern) for pattern in scan_disabled),
            }
        )
    contract.setdefault("scope", {})["baselineRef"] = baseline
    contract["changeSet"] = records
    return contract, unassigned


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--contract", default="quality/completion-contract.json")
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--task-map", action="append", default=[], metavar="PATTERN=TASK_ID")
    parser.add_argument("--default-task")
    parser.add_argument("--disable-placeholder-scan", action="append", default=[], metavar="PATTERN")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    root = args.root.expanduser().resolve()
    contract_path = (root / args.contract).resolve()
    if root != contract_path and root not in contract_path.parents:
        parser.error("contract escapes project root")
    try:
        contract, unassigned = synchronize(
            root,
            contract_path,
            args.baseline,
            parse_maps(args.task_map),
            args.default_task,
            args.disable_placeholder_scan,
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    if unassigned:
        for path in unassigned:
            print(f"UNASSIGNED {path}")
        print(f"completion_change_sync=failed unassigned={len(unassigned)}")
        return 1
    if args.write:
        contract_path.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"completion_change_sync={'written' if args.write else 'planned'} changes={len(contract['changeSet'])} status_unchanged={contract.get('claimedStatus')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
