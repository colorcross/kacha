#!/usr/bin/env python3
"""Validate that product documentation reflects the current product and iteration."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime
from pathlib import Path


CLAIMS = ("structure", "iteration-docs-current", "candidate-docs-current")


def load_json(path: Path, errors: list[str], label: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"invalid {label}: {exc}")
        return {}
    if not isinstance(value, dict):
        errors.append(f"{label} must be an object")
        return {}
    return value


def missing(value: object) -> bool:
    return value is None or value == "" or value == [] or value == {}


def require(record: dict, fields: list[str], label: str, errors: list[str]) -> None:
    absent = [field for field in fields if missing(record.get(field))]
    if absent:
        errors.append(f"{label} missing: {', '.join(absent)}")


def valid_time(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def file_digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def project_file(root: Path, relative: object) -> Path | None:
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        return None
    candidate = (root / relative).resolve()
    return candidate if candidate.is_relative_to(root.resolve()) else None


def check(root: Path, state_path: Path, policy_path: Path, claim: str) -> list[str]:
    errors: list[str] = []
    policy = load_json(policy_path, errors, "product documentation policy")
    state = load_json(state_path, errors, "product documentation state")
    if errors:
        return errors

    require(
        state,
        ["schemaVersion", "productRef", "currentProductRevision", "currentIterationId", "status", "changeImpact", "documents"],
        "product documentation state",
        errors,
    )
    if state.get("schemaVersion") != 1:
        errors.append("product documentation state schemaVersion must be 1")
    if state.get("status") not in policy.get("allowedStatuses", []):
        errors.append(f"invalid product documentation status {state.get('status')}")

    canonical = policy.get("canonicalDocuments", [])
    expected_by_id = {
        item.get("id"): item
        for item in canonical
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    documents = state.get("documents", [])
    if not isinstance(documents, list):
        errors.append("documents must be a list")
        documents = []
    by_id: dict[str, dict] = {}
    for index, document in enumerate(documents):
        label = f"document {index}"
        if not isinstance(document, dict):
            errors.append(f"{label} must be an object")
            continue
        require(document, ["id", "path", "status"], label, errors)
        document_id = document.get("id")
        if not isinstance(document_id, str):
            errors.append(f"{label} id must be a string")
            continue
        if document_id in by_id:
            errors.append(f"duplicate product document id {document_id}")
        if isinstance(document_id, str):
            by_id[document_id] = document
        expected = expected_by_id.get(document_id)
        if expected and document.get("path") != expected.get("path"):
            errors.append(f"{label} path differs from policy")
        path = project_file(root, document.get("path"))
        if path is None:
            errors.append(f"{label} path must stay inside the project")
        elif not path.is_file():
            errors.append(f"missing product document {document.get('path')}")
        if document.get("status") not in policy.get("documentStatuses", []):
            errors.append(f"{label} has invalid status {document.get('status')}")
    missing_ids = [item for item in expected_by_id if item not in by_id]
    if missing_ids:
        errors.append(f"missing canonical product documents: {', '.join(missing_ids)}")

    impact = state.get("changeImpact", {})
    if not isinstance(impact, dict):
        errors.append("changeImpact must be an object")
        impact = {}
    dimensions = impact.get("dimensions", [])
    affected = impact.get("affectedDocumentIds", [])
    change_refs = impact.get("changeRefs", [])
    if not isinstance(dimensions, list) or not dimensions:
        errors.append("changeImpact.dimensions must be a non-empty list")
        dimensions = []
    elif any(not isinstance(item, str) for item in dimensions):
        errors.append("changeImpact.dimensions must contain only strings")
        dimensions = [item for item in dimensions if isinstance(item, str)]
    if len(dimensions) != len(set(map(str, dimensions))):
        errors.append("changeImpact.dimensions contains duplicates")
    mappings = policy.get("changeDimensions", {})
    unknown_dimensions = [item for item in dimensions if item not in mappings]
    if unknown_dimensions:
        errors.append(f"unknown product change dimensions: {', '.join(map(str, unknown_dimensions))}")
    if "no-product-change" in dimensions and len(dimensions) != 1:
        errors.append("no-product-change cannot be combined with other dimensions")
    if not isinstance(affected, list):
        errors.append("changeImpact.affectedDocumentIds must be a list")
        affected = []
    elif any(not isinstance(item, str) for item in affected):
        errors.append("changeImpact.affectedDocumentIds must contain only strings")
        affected = [item for item in affected if isinstance(item, str)]
    if not isinstance(change_refs, list) or any(not isinstance(item, str) for item in change_refs):
        errors.append("changeImpact.changeRefs must be a list of strings")
        change_refs = []
    if len(affected) != len(set(map(str, affected))):
        errors.append("changeImpact.affectedDocumentIds contains duplicates")
    unknown_affected = [item for item in affected if item not in expected_by_id]
    if unknown_affected:
        errors.append(f"unknown affected product documents: {', '.join(map(str, unknown_affected))}")
    minimum_affected = {
        document_id
        for dimension in dimensions
        for document_id in mappings.get(dimension, [])
    }
    omitted = sorted(minimum_affected.difference(affected))
    if omitted:
        errors.append(f"change impact omits required documents: {', '.join(omitted)}")
    if dimensions == ["no-product-change"] and affected:
        errors.append("no-product-change must have no affected documents")

    if claim == "structure":
        return errors

    if state.get("status") != "in_sync":
        errors.append(f"{claim} requires product documentation status in_sync")
    product_revision = state.get("currentProductRevision")
    iteration_id = state.get("currentIterationId")
    if product_revision == "bootstrap:unreconciled":
        errors.append(f"{claim} requires a reconciled currentProductRevision")
    if dimensions != ["no-product-change"]:
        require(impact, ["summary", "changeRefs", "affectedDocumentIds"], "product change impact", errors)

    synchronized_requires = policy.get("synchronizedDocumentRequires", [])
    for document_id, expected in expected_by_id.items():
        if not expected.get("required"):
            continue
        document = by_id.get(document_id, {})
        label = f"product document {document_id}"
        if document.get("status") == "not_applicable":
            require(document, policy.get("notApplicableRequires", []), label, errors)
            errors.append(f"required {label} cannot be not_applicable")
            continue
        if document.get("status") != "current":
            errors.append(f"{label} is not current")
            continue
        require(document, synchronized_requires, label, errors)
        if document.get("reflectsProductRevision") != product_revision:
            errors.append(f"{label} does not reflect currentProductRevision")
        for field in ("lastUpdatedAt", "reviewedAt"):
            if document.get(field) and not valid_time(document.get(field)):
                errors.append(f"{label} has invalid {field}")
        path = project_file(root, document.get("path"))
        if path is not None and path.is_file() and document.get("contentDigest") != file_digest(path):
            errors.append(f"{label} contentDigest does not match file content")
        if document_id in affected:
            previous_digest = document.get("previousContentDigest")
            if not isinstance(previous_digest, str) or not previous_digest.startswith("sha256:") or len(previous_digest) != 71:
                errors.append(f"{label} is affected but has no valid previousContentDigest")
            elif previous_digest == document.get("contentDigest"):
                exception = document.get("materialChangeException", {})
                if not isinstance(exception, dict) or not all(
                    exception.get(field) for field in ("reason", "approvedBy", "evidenceRefs")
                ):
                    errors.append(f"{label} is affected but content did not materially change")
            refs = document.get("changeRefs", [])
            if (
                not isinstance(refs, list)
                or any(not isinstance(item, str) for item in refs)
                or not set(refs).intersection(change_refs)
            ):
                errors.append(f"{label} is affected but has no matching changeRef")

    history = state.get("iterationHistory", [])
    if not isinstance(history, list) or not history:
        errors.append(f"{claim} requires iterationHistory")
    else:
        latest = history[-1]
        if not isinstance(latest, dict):
            errors.append("latest iterationHistory entry must be an object")
        else:
            require(
                latest,
                ["iterationId", "productRevision", "changedDimensions", "reviewedBy", "reviewedAt", "evidenceRefs"],
                "latest iteration history",
                errors,
            )
            history_lists: dict[str, list[str]] = {}
            for field in ("affectedDocumentIds", "updatedDocumentIds"):
                value = latest.get(field)
                if field not in latest or not isinstance(value, list):
                    errors.append(f"latest iteration history missing list {field}")
                    history_lists[field] = []
                elif any(not isinstance(item, str) for item in value):
                    errors.append(f"latest iteration history {field} must contain only strings")
                    history_lists[field] = [item for item in value if isinstance(item, str)]
                else:
                    history_lists[field] = value
            if latest.get("iterationId") != iteration_id:
                errors.append("latest iteration history does not match currentIterationId")
            if latest.get("productRevision") != product_revision:
                errors.append("latest iteration history does not match currentProductRevision")
            if latest.get("changedDimensions") != dimensions:
                errors.append("latest iteration history dimensions differ from changeImpact")
            if set(history_lists["affectedDocumentIds"]) != set(affected):
                errors.append("latest iteration history affected documents differ from changeImpact")
            if not set(affected).issubset(set(history_lists["updatedDocumentIds"])):
                errors.append("latest iteration history omits updated affected documents")
            if latest.get("reviewedAt") and not valid_time(latest.get("reviewedAt")):
                errors.append("latest iteration history has invalid reviewedAt")

    if state.get("breakingProductChange"):
        required_breaking = set(policy.get("breakingChangeRequiredDocuments", []))
        missing_breaking = sorted(required_breaking.difference(affected))
        if missing_breaking:
            errors.append(f"breaking product change omits documents: {', '.join(missing_breaking)}")
        superseded = state.get("supersededProductDefinitions", [])
        if not isinstance(superseded, list) or not superseded:
            errors.append("breaking product change requires supersededProductDefinitions history")
        else:
            require(
                superseded[-1] if isinstance(superseded[-1], dict) else {},
                ["revision", "supersededBy", "reason", "approvedBy", "observedAt"],
                "latest superseded product definition",
                errors,
            )

    if claim == "candidate-docs-current":
        candidate = state.get("candidateRevision")
        if missing(candidate):
            errors.append("candidate-docs-current requires candidateRevision")
        elif candidate != product_revision:
            errors.append("candidateRevision does not match currentProductRevision")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--state", type=Path, default=Path("quality/product-documentation-state.json"))
    parser.add_argument("--policy", type=Path, default=Path("quality/product-documentation-policy.json"))
    parser.add_argument("--claim", choices=CLAIMS, default="structure")
    args = parser.parse_args()
    root = args.root.expanduser().resolve()
    state = args.state if args.state.is_absolute() else root / args.state
    policy = args.policy if args.policy.is_absolute() else root / args.policy
    errors = check(root, state, policy, args.claim)
    if errors:
        for error in errors:
            print(f"ERROR {error}")
        print(f"product_documentation_check=failed claim={args.claim} errors={len(errors)}")
        return 1
    print(f"product_documentation_check=passed claim={args.claim}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
