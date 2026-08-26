"""Portable evidence verification used by generated AppCreate control planes."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from pathlib import Path
from typing import Any

PASSED_RESULTS = {"passed", "approved"}


def canonical_digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def verify_declared_evidence(item: dict[str, Any], *, root: Path, embedded: dict[str, Any] | None = None) -> list[str]:
    evidence_id = item.get("id", "<missing>")
    label = f"evidence {evidence_id}"
    errors: list[str] = []
    try:
        parsed = dt.datetime.fromisoformat(str(item.get("observedAt")).replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError
    except ValueError:
        errors.append(f"{label} observedAt must include an ISO 8601 timezone")
    if str(item.get("result", "")).lower() not in PASSED_RESULTS:
        errors.append(f"{label} registry result is not passed")
    if not item.get("producer"):
        errors.append(f"{label} requires a producer")
    if item.get("level") in {"E3-integrated-target-environment", "E4-production-observation", "E5-user-or-business-outcome"}:
        if not item.get("attestedBy") or item.get("attestedBy") == item.get("producer"):
            errors.append(f"{label} requires an independent attestedBy for {item.get('level')}")
    if not isinstance(item.get("subjectRefs"), list) or not item.get("subjectRefs"):
        errors.append(f"{label} requires subjectRefs")
    source_ref = item.get("sourceRef")
    payload: Any = None
    if isinstance(source_ref, str) and source_ref.startswith("embedded:"):
        key = source_ref.removeprefix("embedded:")
        payload = (embedded or {}).get(key)
        if payload is None:
            errors.append(f"{label} embedded source does not exist: {key}")
        elif canonical_digest(payload) != item.get("sha256"):
            errors.append(f"{label} sha256 does not match embedded source")
    elif isinstance(source_ref, str) and source_ref:
        resolved_root = root.resolve()
        candidate = (root / source_ref).resolve()
        if candidate != resolved_root and resolved_root not in candidate.parents:
            errors.append(f"{label} sourceRef escapes evidence root")
        elif not candidate.is_file():
            errors.append(f"{label} source file does not exist: {source_ref}")
        elif file_digest(candidate) != item.get("sha256"):
            errors.append(f"{label} sha256 does not match source file")
        else:
            try:
                payload = json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                errors.append(f"{label} source is not valid JSON: {exc}")
    else:
        errors.append(f"{label} requires sourceRef")
    if payload is not None:
        if not isinstance(payload, dict):
            errors.append(f"{label} source root must be an object")
        else:
            result = payload.get("result", payload.get("status", payload.get("decision")))
            if str(result).lower() not in PASSED_RESULTS:
                errors.append(f"{label} source result is not passed")
    if item.get("level") in {"E3-integrated-target-environment", "E4-production-observation", "E5-user-or-business-outcome"}:
        attestation_ref = item.get("attestationRef")
        if not isinstance(attestation_ref, str) or not attestation_ref:
            errors.append(f"{label} requires attestationRef")
        else:
            resolved_root = root.resolve()
            attestation_path = (root / attestation_ref).resolve()
            if attestation_path != resolved_root and resolved_root not in attestation_path.parents:
                errors.append(f"{label} attestationRef escapes evidence root")
            elif not attestation_path.is_file():
                errors.append(f"{label} attestation file does not exist: {attestation_ref}")
            elif file_digest(attestation_path) != item.get("attestationSha256"):
                errors.append(f"{label} attestation sha256 does not match")
            else:
                try:
                    attestation = json.loads(attestation_path.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                    errors.append(f"{label} attestation is not valid JSON: {exc}")
                else:
                    if not isinstance(attestation, dict):
                        errors.append(f"{label} attestation root must be an object")
                    else:
                        if str(attestation.get("result", "")).lower() not in PASSED_RESULTS:
                            errors.append(f"{label} attestation result is not passed")
                        if attestation.get("attestedBy") != item.get("attestedBy"):
                            errors.append(f"{label} attestation actor does not match attestedBy")
                        if attestation.get("evidenceSha256") != item.get("sha256"):
                            errors.append(f"{label} attestation does not bind the evidence sha256")
    return errors
