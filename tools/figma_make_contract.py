#!/usr/bin/env python3
"""Shared Figma Make contract semantics, identity and safe-tree helpers."""

from __future__ import annotations

import fnmatch
import hashlib
import json
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse


def digest_json(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def sha256_file(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def tree_digest(manifest: list[dict]) -> str:
    return digest_json(manifest)


def project_path(root: Path, relative: object) -> Path | None:
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        return None
    candidate = (root / relative).resolve()
    return candidate if candidate.is_relative_to(root.resolve()) else None


def parse_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def normalize_run(run: object) -> dict:
    value = run if isinstance(run, dict) else {}
    return {
        "argv": value.get("argv", []),
        "cwd": value.get("cwd"),
        "baseUrl": value.get("baseUrl"),
    }


def validate_run_contract(run: object, root: Path, prototype_root: Path | None) -> list[str]:
    errors: list[str] = []
    value = normalize_run(run)
    argv = value["argv"]
    if not isinstance(argv, list) or not argv or not all(isinstance(item, str) and item.strip() for item in argv):
        errors.append("prototype.run.argv must be a non-empty argv list")
    cwd = project_path(root, value["cwd"])
    if cwd is None or not cwd.is_dir():
        errors.append("prototype.run.cwd must be an existing project directory")
    elif prototype_root is not None and not cwd.is_relative_to(prototype_root):
        errors.append("prototype.run.cwd must stay inside prototype.codeRoot")
    parsed = urlparse(value["baseUrl"] if isinstance(value["baseUrl"], str) else "")
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        errors.append("prototype.run.baseUrl must be an HTTP(S) URL")
    return errors


def prototype_identity(contract: dict) -> str:
    prompt = contract.get("promptPack", {})
    prototype = contract.get("prototype", {})
    return digest_json(
        {
            "promptDigest": prompt.get("digest"),
            "makeRef": prototype.get("makeRef"),
            "producer": prototype.get("producer"),
            "treeDigest": prototype.get("treeDigest"),
            "run": normalize_run(prototype.get("run")),
        }
    )


def implementation_identity(contract: dict) -> str:
    implementation = contract.get("implementation", {})
    return digest_json(
        {
            "root": implementation.get("root"),
            "sourceRevision": implementation.get("sourceRevision"),
            "treeDigest": implementation.get("treeDigest"),
        }
    )


def sensitive_file_reason(path: Path, policy: dict) -> str | None:
    name = path.name.casefold()
    forbidden_names = {str(item).casefold() for item in policy.get("forbiddenFileNames", [])}
    if name in forbidden_names or name.startswith(".env."):
        return "forbidden file name"
    forbidden_extensions = {str(item).casefold() for item in policy.get("forbiddenFileExtensions", [])}
    if path.suffix.casefold() in forbidden_extensions:
        return "forbidden credential/key extension"
    patterns = [str(item).casefold() for item in policy.get("forbiddenFilePatterns", [])]
    if any(fnmatch.fnmatch(name, pattern) for pattern in patterns):
        return "forbidden credential file pattern"
    limit = int(policy.get("sensitiveContentScanBytes", 131072))
    try:
        content = path.read_bytes()[:limit]
    except OSError:
        return "unreadable file"
    markers = [str(item).encode("utf-8").lower() for item in policy.get("forbiddenContentMarkers", [])]
    lowered = content.lower()
    if any(marker in lowered for marker in markers):
        return "forbidden credential/private-key content"
    return None


def build_manifest(code_root: Path, policy: dict) -> list[dict]:
    excluded = {str(item) for item in policy.get("excludedDirectories", [])}
    manifest: list[dict] = []
    for path in sorted(code_root.rglob("*")):
        relative = path.relative_to(code_root)
        if any(part in excluded for part in relative.parts):
            continue
        if path.is_symlink():
            raise ValueError(f"source may not contain symlinks: {relative.as_posix()}")
        if not path.is_file():
            continue
        reason = sensitive_file_reason(path, policy)
        if reason:
            raise ValueError(f"source contains sensitive file ({reason}): {relative.as_posix()}")
        manifest.append({"path": relative.as_posix(), "sha256": sha256_file(path), "sizeBytes": path.stat().st_size})
    if not manifest:
        raise ValueError("source has no managed files")
    return manifest


def validate_prompt_semantics(contract: dict) -> list[str]:
    errors: list[str] = []
    pages = contract.get("pages")
    journeys = contract.get("journeys")
    if not isinstance(pages, list) or not pages:
        return ["pages must be a non-empty list"]
    if not isinstance(journeys, list) or not journeys:
        return ["journeys must be a non-empty list"]

    page_index: dict[str, dict] = {}
    routes: set[str] = set()
    interactions: dict[tuple[str, str], dict] = {}
    for index, page in enumerate(pages):
        if not isinstance(page, dict):
            errors.append(f"page {index} must be an object")
            continue
        page_id = page.get("id")
        route = page.get("route")
        if not isinstance(page_id, str) or not page_id:
            errors.append(f"page {index} requires a non-empty id")
            continue
        if page_id in page_index:
            errors.append(f"duplicate page id: {page_id}")
        page_index[page_id] = page
        if not isinstance(route, str) or not route:
            errors.append(f"page {page_id} requires a non-empty route")
        elif route in routes:
            errors.append(f"duplicate page route: {route}")
        routes.add(route)
        for field in ("name", "purpose"):
            if not page.get(field):
                errors.append(f"page {page_id} requires {field}")
        for collection_name in ("states", "interactions", "acceptance"):
            value = page.get(collection_name)
            if not isinstance(value, list) or not value:
                errors.append(f"page {page_id} {collection_name} must be a non-empty list")
        state_ids: set[str] = set()
        for state in page.get("states", []) if isinstance(page.get("states"), list) else []:
            if not isinstance(state, dict) or not state.get("id") or not state.get("description"):
                errors.append(f"page {page_id} state requires id and description")
                continue
            if state["id"] in state_ids:
                errors.append(f"duplicate page {page_id} state id: {state['id']}")
            state_ids.add(state["id"])
        interaction_ids: set[str] = set()
        for interaction in page.get("interactions", []) if isinstance(page.get("interactions"), list) else []:
            if not isinstance(interaction, dict) or not interaction.get("id") or not interaction.get("trigger") or not interaction.get("result"):
                errors.append(f"page {page_id} interaction requires id, trigger and result")
                continue
            interaction_id = interaction["id"]
            if interaction_id in interaction_ids:
                errors.append(f"duplicate page {page_id} interaction id: {interaction_id}")
            interaction_ids.add(interaction_id)
            interactions[(page_id, interaction_id)] = interaction

    for (page_id, interaction_id), interaction in interactions.items():
        target = interaction.get("targetPageId")
        if target is not None and target not in page_index:
            errors.append(f"page {page_id} interaction {interaction_id} references unknown page {target}")

    journey_ids: set[str] = set()
    covered_pages: set[str] = set()
    covered_interactions: set[tuple[str, str]] = set()
    for index, journey in enumerate(journeys):
        if not isinstance(journey, dict) or not journey.get("id") or not journey.get("name"):
            errors.append(f"journey {index} requires id and name")
            continue
        journey_id = journey["id"]
        if journey_id in journey_ids:
            errors.append(f"duplicate journey id: {journey_id}")
        journey_ids.add(journey_id)
        steps = journey.get("steps")
        if not isinstance(steps, list) or not steps:
            errors.append(f"journey {journey_id} steps must be a non-empty list")
            continue
        if not isinstance(journey.get("acceptance"), list) or not journey.get("acceptance"):
            errors.append(f"journey {journey_id} acceptance must be a non-empty list")
        for step_index, step in enumerate(steps):
            if not isinstance(step, dict):
                errors.append(f"journey {journey_id} step {step_index} must be an object")
                continue
            page_id = step.get("pageId")
            interaction_id = step.get("interactionId")
            if page_id not in page_index:
                errors.append(f"journey {journey_id} step {step_index} references unknown page {page_id}")
                continue
            covered_pages.add(page_id)
            if not step.get("action") or not step.get("expected"):
                errors.append(f"journey {journey_id} step {step_index} requires action and expected")
            key = (page_id, interaction_id)
            interaction = interactions.get(key)
            if interaction is None:
                errors.append(f"journey {journey_id} step {step_index} references unknown interaction {interaction_id} on {page_id}")
                continue
            covered_interactions.add(key)
            target = interaction.get("targetPageId")
            if step_index + 1 < len(steps):
                next_page = steps[step_index + 1].get("pageId") if isinstance(steps[step_index + 1], dict) else None
                if target != next_page:
                    errors.append(
                        f"journey {journey_id} step {step_index} interaction {interaction_id} targets {target}, expected {next_page}"
                    )
            elif target not in (None, page_id):
                errors.append(f"journey {journey_id} ends before interaction {interaction_id} target {target}")

    for page_id in sorted(set(page_index) - covered_pages):
        errors.append(f"page {page_id} is not covered by any journey")
    for page_id, interaction_id in sorted(set(interactions) - covered_interactions):
        errors.append(f"page {page_id} interaction {interaction_id} is not covered by any journey")
    return sorted(set(errors))
