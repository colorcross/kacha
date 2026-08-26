#!/usr/bin/env python3
"""Freeze an exported Figma Make code prototype into a content-addressed manifest."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from figma_make_contract import build_manifest, tree_digest


ROOT = Path(__file__).resolve().parents[1]
POLICY_CANDIDATES = (ROOT / "config/figma-make-prototype-policy.json", ROOT / "quality/figma-make-prototype-policy.json")


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def load_policy() -> dict:
    policy_path = next((path for path in POLICY_CANDIDATES if path.is_file()), None)
    if policy_path is None:
        raise ValueError("Figma Make prototype policy is missing")
    return load(policy_path)


def freeze(
    contract_path: Path,
    code_root: Path,
    make_ref: str,
    project_root: Path | None = None,
    producer: str = "figma-make",
    run: dict | None = None,
) -> dict:
    if not make_ref.startswith("https://www.figma.com/make/"):
        raise ValueError("make-ref must be an https://www.figma.com/make/ URL")
    if not producer.strip():
        raise ValueError("prototype producer is required")
    contract = load(contract_path)
    if contract.get("route", {}).get("promptPackStatus") != "ready" or not contract.get("promptPack", {}).get("digest"):
        raise ValueError("complete and freeze the Prompt Pack before freezing prototype code")
    policy = load_policy()
    root = (project_root or (contract_path.parent.parent if contract_path.parent.name == "quality" else contract_path.parent)).resolve()
    source = code_root.resolve()
    if not source.is_dir() or not source.is_relative_to(root):
        raise ValueError("code-root must be an existing directory inside the project root")
    manifest = build_manifest(source, policy)
    paths = {item["path"] for item in manifest}
    package_manifest = next((name for name in policy["packageManifests"] if name in paths), None)
    lockfiles = [name for name in policy["lockfiles"] if name in paths]
    if package_manifest is None:
        raise ValueError("prototype source must contain package.json")
    if not lockfiles:
        raise ValueError("prototype source must contain a supported lockfile")
    contract["prototype"].update({
        "makeRef": make_ref,
        "producer": producer,
        "codeRoot": source.relative_to(root).as_posix(),
        "packageManifest": package_manifest,
        "lockfiles": lockfiles,
        "fileManifest": manifest,
        "treeDigest": tree_digest(manifest),
        "frozenAt": datetime.now(timezone.utc).isoformat(),
    })
    if run is not None:
        contract["prototype"]["run"] = run
    return contract


def freeze_implementation(
    contract_path: Path,
    implementation_root: Path,
    source_revision: str,
    project_root: Path | None = None,
) -> dict:
    if not source_revision.strip():
        raise ValueError("implementation source revision is required")
    contract = load(contract_path)
    policy = load_policy()
    root = (project_root or (contract_path.parent.parent if contract_path.parent.name == "quality" else contract_path.parent)).resolve()
    source = implementation_root.resolve()
    prototype_relative = contract.get("prototype", {}).get("codeRoot")
    if not isinstance(prototype_relative, str) or not prototype_relative:
        raise ValueError("freeze prototype code before freezing the production implementation")
    prototype = (root / prototype_relative).resolve()
    if not source.is_dir() or not source.is_relative_to(root):
        raise ValueError("implementation-root must be an existing directory inside the project root")
    if source.is_relative_to(prototype) or prototype.is_relative_to(source):
        raise ValueError("implementation-root and prototype.codeRoot must be independent trees")
    manifest = build_manifest(source, policy)
    contract["implementation"].update(
        {
            "root": source.relative_to(root).as_posix(),
            "sourceRevision": source_revision,
            "fileManifest": manifest,
            "treeDigest": tree_digest(manifest),
            "frozenAt": datetime.now(timezone.utc).isoformat(),
        }
    )
    return contract


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("contract", type=Path)
    parser.add_argument("--code-root", type=Path)
    parser.add_argument("--make-ref")
    parser.add_argument("--producer", default="figma-make")
    parser.add_argument("--run-arg", action="append", default=[])
    parser.add_argument("--run-cwd")
    parser.add_argument("--base-url")
    parser.add_argument("--implementation-root", type=Path)
    parser.add_argument("--source-revision")
    parser.add_argument("--root", type=Path)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    try:
        prototype_mode = args.code_root is not None or args.make_ref is not None
        implementation_mode = args.implementation_root is not None or args.source_revision is not None
        if prototype_mode == implementation_mode:
            raise ValueError("select exactly one mode: --code-root/--make-ref or --implementation-root/--source-revision")
        if prototype_mode:
            if args.code_root is None or args.make_ref is None:
                raise ValueError("prototype freeze requires --code-root and --make-ref")
            if not args.run_arg or not args.run_cwd or not args.base_url:
                raise ValueError("prototype freeze requires --run-arg, --run-cwd and --base-url")
            contract = freeze(
                args.contract.resolve(),
                args.code_root,
                args.make_ref,
                args.root,
                args.producer,
                {"argv": args.run_arg, "cwd": args.run_cwd, "baseUrl": args.base_url, "evidenceRef": None},
            )
            output_key = "prototype"
        else:
            if args.implementation_root is None or args.source_revision is None:
                raise ValueError("implementation freeze requires --implementation-root and --source-revision")
            contract = freeze_implementation(
                args.contract.resolve(), args.implementation_root, args.source_revision, args.root
            )
            output_key = "implementation"
        if args.write:
            args.contract.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        else:
            print(json.dumps(contract[output_key], ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
