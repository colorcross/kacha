#!/usr/bin/env python3
"""Derive honest task completion from scope, changes, evidence and review."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


CLAIMS = ("structure", "honest-status", "code-done", "candidate-ready")
STATUSES = ("not_started", "in_progress", "partial", "blocked", "completed")


def load_json(path: Path, errors: list[str], label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"invalid {label}: {exc}")
        return {}
    if not isinstance(value, dict):
        errors.append(f"invalid {label}: root must be an object")
        return {}
    return value


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def safe_path(root: Path, relative: Any, label: str, errors: list[str]) -> Path | None:
    if not isinstance(relative, str) or not relative.strip():
        errors.append(f"{label} has no path")
        return None
    candidate = (root / relative).resolve()
    if candidate != root and root not in candidate.parents:
        errors.append(f"{label} path escapes project root: {relative}")
        return None
    return candidate


def parse_time(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed


def embedded_evidence_result(path: Path, kind: Any, errors: list[str], label: str) -> str | None:
    """Read the result asserted by the evidence body, not just its registry entry."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        errors.append(f"{label} body is not valid JSON: {exc}")
        return None
    if not isinstance(payload, dict):
        errors.append(f"{label} body root must be an object")
        return None
    fields = ("result", "status")
    if kind == "review":
        fields = ("decision", "status", "result")
    for field in fields:
        value = payload.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    errors.append(f"{label} body has no semantic result field")
    return None


def unique_records(records: Any, label: str, errors: list[str]) -> dict[str, dict[str, Any]]:
    if not isinstance(records, list):
        errors.append(f"{label} must be a list")
        return {}
    result: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(records):
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"].strip():
            errors.append(f"{label} {index} has no valid id")
            continue
        if item["id"] in result:
            errors.append(f"duplicate {label} id {item['id']}")
            continue
        result[item["id"]] = item
    return result


def check_plan_coverage(root: Path, contract: dict, policy: dict, tasks: dict[str, dict], errors: list[str]) -> None:
    scope = contract.get("scope", {})
    source = scope.get("planSource")
    if source is None:
        return
    plan_path = safe_path(root, source, "plan source", errors)
    if plan_path is None or not plan_path.is_file():
        errors.append(f"plan source does not exist: {source}")
        return
    plan = load_json(plan_path, errors, "implementation plan")
    slices = unique_records(plan.get("verticalSlices", []), "vertical slice", errors)
    prefix = policy.get("planCoverage", {}).get("requiredPrefix", "vertical-slice:")
    owners: dict[str, list[str]] = {slice_id: [] for slice_id in slices}
    for task_id, task in tasks.items():
        refs = task.get("planRefs", [])
        if not isinstance(refs, list):
            errors.append(f"task {task_id} planRefs must be a list")
            continue
        for ref in refs:
            if isinstance(ref, str) and ref.startswith(prefix):
                slice_id = ref[len(prefix):]
                if slice_id not in slices:
                    errors.append(f"task {task_id} references missing vertical slice {slice_id}")
                else:
                    owners[slice_id].append(task_id)
    if policy.get("planCoverage", {}).get("requireExactOneTaskPerSlice", True):
        for slice_id, task_ids in owners.items():
            if len(task_ids) != 1:
                errors.append(f"vertical slice {slice_id} must map to exactly one task; found {len(task_ids)}")
            elif task_ids:
                planned_acceptance = slices[slice_id].get("acceptance", [])
                task_acceptance = {
                    item.get("description") for item in tasks[task_ids[0]].get("acceptanceCriteria", [])
                    if isinstance(item, dict)
                }
                missing_acceptance = [item for item in planned_acceptance if item not in task_acceptance]
                if missing_acceptance:
                    errors.append(
                        f"task {task_ids[0]} omits planned acceptance for vertical slice {slice_id}: "
                        f"{', '.join(missing_acceptance)}"
                    )


def check_scope(contract: dict, tasks: dict[str, dict], claim: str, errors: list[str]) -> None:
    scope = contract.get("scope")
    if not isinstance(scope, dict):
        errors.append("scope must be an object")
        return
    for field in ("id", "revision", "status", "inScopeTaskIds", "outOfScope", "planSource"):
        if field not in scope:
            errors.append(f"scope missing {field}")
    if scope.get("status") not in {"draft", "frozen", "changed"}:
        errors.append(f"scope has invalid status {scope.get('status')}")
    declared = scope.get("inScopeTaskIds", [])
    if not isinstance(declared, list) or len(declared) != len(set(declared)):
        errors.append("scope inScopeTaskIds must be a unique list")
        declared = []
    if set(declared) != set(tasks):
        errors.append("scope inScopeTaskIds must exactly match task ids")
    if claim in {"code-done", "candidate-ready"}:
        if scope.get("status") not in {"frozen", "changed"} or not scope.get("frozenAt") or not scope.get("approvedBy"):
            errors.append(f"{claim} requires frozen scope with frozenAt and approvedBy")
    if scope.get("status") == "changed":
        revision = scope.get("revision")
        history = contract.get("changeHistory", [])
        matches = [item for item in history if isinstance(item, dict) and item.get("toRevision") == revision]
        if not matches:
            errors.append("changed scope requires changeHistory for current revision")
        for item in matches:
            for field in ("fromRevision", "toRevision", "reason", "impact", "approvedBy", "observedAt"):
                if not item.get(field):
                    errors.append(f"scope change to {revision} missing {field}")


def check_evidence(root: Path, contract: dict, policy: dict, errors: list[str]) -> tuple[dict[str, dict], dict[str, bool]]:
    records = unique_records(contract.get("evidence", []), "evidence", errors)
    valid: dict[str, bool] = {}
    scope_revision = contract.get("scope", {}).get("revision")
    evidence_policy = policy.get("evidence", {})
    for evidence_id, item in records.items():
        label = f"evidence {evidence_id}"
        for field in ("kind", "path", "sha256", "subjectRefs", "scopeRevision", "result", "observedAt", "producer", "limitations"):
            if field not in item:
                errors.append(f"{label} missing {field}")
        before = len(errors)
        path = safe_path(root, item.get("path"), label, errors)
        if path is not None:
            if not path.is_file():
                errors.append(f"{label} file does not exist: {item.get('path')}")
            elif digest_file(path) != item.get("sha256"):
                errors.append(f"{label} sha256 does not match file")
            else:
                embedded = embedded_evidence_result(path, item.get("kind"), errors, label)
                accepted = {"passed", "approved"}
                if embedded is not None and embedded not in accepted:
                    errors.append(f"{label} body result is not passed: {embedded}")
                if embedded is not None and item.get("result") not in accepted:
                    errors.append(f"{label} registry result contradicts its body")
        if item.get("result") != evidence_policy.get("requiredResult", "passed"):
            errors.append(f"{label} result is not passed")
        if evidence_policy.get("requireScopeRevisionMatch", True) and item.get("scopeRevision") != scope_revision:
            errors.append(f"{label} scopeRevision does not match current scope")
        if parse_time(item.get("observedAt")) is None:
            errors.append(f"{label} has invalid observedAt")
        if not item.get("producer"):
            errors.append(f"{label} has no producer")
        if not isinstance(item.get("subjectRefs"), list) or not item.get("subjectRefs"):
            errors.append(f"{label} has no subjectRefs")
        valid[evidence_id] = len(errors) == before
    return records, valid


def placeholder_exempt(contract: dict, relative: str, pattern_id: str, task_id: str) -> bool:
    now = dt.datetime.now(dt.timezone.utc)
    for item in contract.get("placeholderScan", {}).get("exceptions", []):
        if not isinstance(item, dict):
            continue
        expires = parse_time(item.get("expiresAt"))
        if (
            item.get("path") == relative
            and item.get("patternId") == pattern_id
            and task_id in item.get("taskRefs", [])
            and item.get("reason")
            and item.get("approvedBy")
            and expires is not None
            and expires > now
        ):
            return True
    return False


def check_changes(root: Path, contract: dict, policy: dict, tasks: dict[str, dict], errors: list[str]) -> tuple[dict[str, list[dict]], dict[str, bool]]:
    records = contract.get("changeSet", [])
    if not isinstance(records, list):
        errors.append("changeSet must be a list")
        return {}, {}
    by_task: dict[str, list[dict]] = {task_id: [] for task_id in tasks}
    valid_by_task = {task_id: True for task_id in tasks}
    seen_paths: set[str] = set()
    patterns = []
    for item in policy.get("placeholderScan", {}).get("patterns", []):
        try:
            patterns.append((item["id"], re.compile(item["regex"])))
        except (KeyError, re.error) as exc:
            errors.append(f"invalid placeholder pattern: {exc}")
    maximum = int(policy.get("placeholderScan", {}).get("maximumFileBytes", 2000000))
    for index, item in enumerate(records):
        label = f"changeSet {index}"
        if not isinstance(item, dict):
            errors.append(f"{label} must be an object")
            continue
        relative = item.get("path")
        if not isinstance(relative, str) or not relative:
            errors.append(f"{label} has no path")
            continue
        if relative in seen_paths:
            errors.append(f"duplicate changeSet path {relative}")
        seen_paths.add(relative)
        task_refs = item.get("taskRefs", [])
        if not isinstance(task_refs, list) or not task_refs:
            errors.append(f"{label} has no taskRefs")
            task_refs = []
        for task_id in task_refs:
            if task_id not in tasks:
                errors.append(f"{label} references missing task {task_id}")
            else:
                by_task[task_id].append(item)
        path = safe_path(root, relative, label, errors)
        change_type = item.get("changeType")
        record_valid = True
        if change_type not in {"created", "modified", "deleted"}:
            errors.append(f"{label} has invalid changeType {change_type}")
            record_valid = False
        elif change_type == "deleted":
            if path is not None and path.exists():
                errors.append(f"{label} declares deleted path that still exists")
                record_valid = False
            if not item.get("beforeDigest") or item.get("afterDigest") is not None:
                errors.append(f"{label} deleted change requires beforeDigest and null afterDigest")
                record_valid = False
        else:
            if path is None or not path.is_file():
                errors.append(f"{label} file does not exist")
                record_valid = False
            else:
                actual = digest_file(path)
                if item.get("afterDigest") != actual:
                    errors.append(f"{label} afterDigest does not match file")
                    record_valid = False
                if change_type == "created" and item.get("beforeDigest") is not None:
                    errors.append(f"{label} created change requires null beforeDigest")
                    record_valid = False
                if change_type == "modified" and (
                    not item.get("beforeDigest") or item.get("beforeDigest") == item.get("afterDigest")
                ):
                    errors.append(f"{label} modified change has no substantive digest difference")
                    record_valid = False
                scan_enabled = item.get("scanForPlaceholders", True)
                if not scan_enabled and not any(
                    relative.startswith(prefix)
                    for prefix in policy.get("placeholderScan", {}).get("scanDisableAllowedPrefixes", [])
                ):
                    errors.append(f"{label} disables placeholder scan outside an allowed control path")
                    record_valid = False
                if scan_enabled and path.stat().st_size <= maximum:
                    try:
                        content = path.read_text(encoding="utf-8")
                    except UnicodeDecodeError:
                        content = ""
                    for pattern_id, pattern in patterns:
                        if pattern.search(content):
                            for task_id in task_refs:
                                if not placeholder_exempt(contract, relative, pattern_id, task_id):
                                    errors.append(f"{label} contains unapproved placeholder {pattern_id} for task {task_id}")
                                    record_valid = False
        if not record_valid:
            for task_id in task_refs:
                if task_id in valid_by_task:
                    valid_by_task[task_id] = False
    return by_task, valid_by_task


def check_git_change_coverage(
    root: Path,
    contract_path: Path,
    contract: dict,
    policy: dict,
    claim: str,
    errors: list[str],
) -> None:
    if claim not in {"code-done", "candidate-ready"}:
        return
    change_policy = policy.get("changeSet", {})
    if not change_policy.get("requireGitBaselineForCompletionClaims", True):
        return
    baseline = contract.get("scope", {}).get("baselineRef")
    if not baseline:
        errors.append(f"{claim} requires scope baselineRef")
        return
    probe = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], cwd=root, text=True, capture_output=True, check=False
    )
    repository_root = Path(probe.stdout.strip()).resolve() if not probe.returncode else None
    if repository_root is None or (root != repository_root and repository_root not in root.parents):
        errors.append(f"{claim} requires project root to be inside a Git worktree")
        return
    verify = subprocess.run(
        ["git", "rev-parse", "--verify", f"{baseline}^{{commit}}"], cwd=root, text=True, capture_output=True, check=False
    )
    if verify.returncode:
        errors.append(f"{claim} baselineRef is not a resolvable Git commit: {baseline}")
        return
    changed = subprocess.run(
        ["git", "diff", "--relative", "--name-only", "--diff-filter=ACDMRTUXB", baseline, "--", "."],
        cwd=root, text=True, capture_output=True, check=False,
    )
    untracked = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", "--", "."],
        cwd=root, text=True, capture_output=True, check=False,
    )
    if changed.returncode or untracked.returncode:
        errors.append("cannot enumerate actual Git changes from baseline")
        return
    actual = {line.strip() for line in (changed.stdout + "\n" + untracked.stdout).splitlines() if line.strip()}
    declared = {
        item.get("path") for item in contract.get("changeSet", [])
        if isinstance(item, dict) and isinstance(item.get("path"), str)
    }
    exempt = {str(contract_path.relative_to(root))}
    exempt.update(
        item.get("path") for item in contract.get("evidence", [])
        if isinstance(item, dict) and isinstance(item.get("path"), str)
    )
    missing = sorted(actual - declared - exempt)
    extra = sorted(declared - actual)
    if missing:
        errors.append(f"actual Git changes are missing from changeSet: {', '.join(missing)}")
    if extra:
        errors.append(f"changeSet paths are not changed from baseline: {', '.join(extra)}")


def check_deliverable(root: Path, task_id: str, item: dict, policy: dict, errors: list[str]) -> bool:
    label = f"task {task_id} deliverable {item.get('path') or '<missing>'}"
    path = safe_path(root, item.get("path"), label, errors)
    if path is None:
        return False
    status = item.get("status")
    if status == "removed":
        if path.exists():
            errors.append(f"{label} is declared removed but still exists")
            return False
        if not isinstance(item.get("sha256"), str) or not item["sha256"].startswith("sha256:"):
            errors.append(f"{label} removed deliverable requires its prior sha256")
            return False
        return True
    if status != "present":
        errors.append(f"{label} has invalid status {status}")
        return False
    if not path.is_file():
        errors.append(f"{label} does not exist")
        return False
    valid = True
    minimum = item.get("minBytes", policy.get("deliverables", {}).get("defaultMinimumBytes", 1))
    if not isinstance(minimum, int) or minimum < 1 or path.stat().st_size < minimum:
        errors.append(f"{label} is smaller than required minBytes")
        valid = False
    if digest_file(path) != item.get("sha256"):
        errors.append(f"{label} sha256 does not match file")
        valid = False
    return valid


def derive_task_status(
    root: Path,
    task_id: str,
    task: dict,
    contract: dict,
    policy: dict,
    evidence: dict[str, dict],
    evidence_valid: dict[str, bool],
    changes: list[dict],
    changes_valid: bool,
    errors: list[str],
) -> str:
    if task.get("blocker"):
        blocker = task["blocker"]
        if not isinstance(blocker, dict) or not all(blocker.get(field) for field in ("reason", "owner", "nextAction")):
            errors.append(f"task {task_id} blocker is incomplete")
        return "blocked"
    acceptance = task.get("acceptanceCriteria", [])
    deliverables = task.get("deliverables", [])
    evidence_refs = task.get("evidenceRefs", [])
    review = task.get("completionReview", {})
    completion_errors: list[str] = []
    if contract.get("scope", {}).get("status") not in {"frozen", "changed"}:
        completion_errors.append("scope is not frozen")
    if not isinstance(acceptance, list) or not acceptance:
        completion_errors.append("has no acceptance criteria")
    else:
        criterion_ids: set[str] = set()
        for index, criterion in enumerate(acceptance):
            label = f"acceptance {index}"
            if not isinstance(criterion, dict) or not criterion.get("id") or not criterion.get("description"):
                completion_errors.append(f"{label} is invalid")
                continue
            if criterion["id"] in criterion_ids:
                completion_errors.append(f"duplicate acceptance id {criterion['id']}")
            criterion_ids.add(criterion["id"])
            if criterion.get("status") != "passed":
                completion_errors.append(f"acceptance {criterion['id']} is not passed")
            refs = criterion.get("evidenceRefs", [])
            if not isinstance(refs, list) or not refs:
                completion_errors.append(f"acceptance {criterion['id']} has no evidence")
            for ref in refs if isinstance(refs, list) else []:
                if ref not in evidence or not evidence_valid.get(ref):
                    completion_errors.append(f"acceptance {criterion['id']} has invalid evidence {ref}")
                elif f"acceptance:{task_id}:{criterion['id']}" not in evidence[ref].get("subjectRefs", []):
                    completion_errors.append(f"evidence {ref} is not bound to acceptance {criterion['id']}")
    if not isinstance(evidence_refs, list) or not evidence_refs:
        completion_errors.append("has no task evidence")
    for ref in evidence_refs if isinstance(evidence_refs, list) else []:
        if ref not in evidence or not evidence_valid.get(ref):
            completion_errors.append(f"has invalid evidence {ref}")
        else:
            subjects = evidence[ref].get("subjectRefs", [])
            if f"task:{task_id}" not in subjects:
                completion_errors.append(f"evidence {ref} is not bound to task")
            observed = parse_time(evidence[ref].get("observedAt"))
            started = parse_time(task.get("startedAt"))
            if policy.get("evidence", {}).get("requireObservedAtNotBeforeTaskStart", True) and started and observed and observed < started:
                completion_errors.append(f"evidence {ref} predates task start")
    if not isinstance(deliverables, list) or not deliverables:
        completion_errors.append("has no deliverables")
    else:
        for item in deliverables:
            if not isinstance(item, dict) or not check_deliverable(root, task_id, item, policy, errors):
                completion_errors.append("has invalid deliverable")
    if task.get("workType") in set(policy.get("implementationWorkTypes", [])):
        if not task.get("implementationRefs"):
            completion_errors.append("has no implementationRefs")
        else:
            changed_paths = {item.get("path") for item in changes}
            deliverable_paths = {item.get("path") for item in deliverables if isinstance(item, dict)}
            unresolved_implementation = [
                ref for ref in task.get("implementationRefs", []) if ref not in changed_paths | deliverable_paths
            ]
            if unresolved_implementation:
                completion_errors.append(f"has unresolved implementationRefs {', '.join(unresolved_implementation)}")
        if not task.get("testRefs"):
            completion_errors.append("has no testRefs")
        else:
            for ref in task.get("testRefs", []):
                if ref not in evidence or not evidence_valid.get(ref):
                    completion_errors.append(f"has invalid testRef {ref}")
                elif f"task:{task_id}" not in evidence[ref].get("subjectRefs", []):
                    completion_errors.append(f"testRef {ref} is not bound to task")
        if not changes:
            completion_errors.append("has no changeSet entries")
        documentation = tuple(policy.get("changeSet", {}).get("documentationSuffixes", []))
        if changes and all(str(item.get("path", "")).lower().endswith(documentation) for item in changes):
            completion_errors.append("has documentation-only changes for implementation work")
        if not changes_valid:
            completion_errors.append("has invalid or placeholder changes")
    elif task.get("workType") in set(policy.get("changeSetRequiredWorkTypes", [])):
        if not changes:
            completion_errors.append("has no changeSet entries")
        if not changes_valid:
            completion_errors.append("has invalid or placeholder changes")
    implementation_actor = task.get("implementationActor")
    if not isinstance(implementation_actor, str) or not implementation_actor.strip():
        completion_errors.append("has no implementationActor")
    if not isinstance(review, dict) or review.get("decision") != "passed" or not review.get("reviewer") or not review.get("reviewedAt") or not review.get("evidenceRefs"):
        completion_errors.append("completion review is not passed with evidence")
    else:
        review_producers: set[Any] = set()
        for ref in review.get("evidenceRefs", []):
            if ref not in evidence or not evidence_valid.get(ref):
                completion_errors.append(f"completion review has invalid evidence {ref}")
            elif f"review:task:{task_id}" not in evidence[ref].get("subjectRefs", []):
                completion_errors.append(f"completion review evidence {ref} is not bound to task review")
            else:
                review_producers.add(evidence[ref].get("producer"))
        if review_producers and review_producers != {review.get("reviewer")}:
            completion_errors.append("completion reviewer does not match review evidence producer")
        if task.get("risk") in set(policy.get("independentReviewRiskLevels", [])):
            producer_refs = set(evidence_refs) | set(task.get("testRefs", []))
            producers = {evidence[ref].get("producer") for ref in producer_refs if ref in evidence}
            if review.get("reviewer") == implementation_actor or review.get("reviewer") in producers:
                completion_errors.append("high-risk completion reviewer is not independent")
    if not completion_errors:
        return "completed"
    has_work = bool(task.get("startedAt") or task.get("implementationRefs") or task.get("testRefs") or evidence_refs or deliverables or changes)
    declared = task.get("status")
    derived = "not_started"
    if has_work:
        derived = "partial" if declared == "partial" or any(
            isinstance(item, dict) and item.get("status") == "passed" for item in acceptance
        ) else "in_progress"
    if declared == "completed":
        errors.extend(f"task {task_id} falsely claims completed: {reason}" for reason in completion_errors)
    return derived


def derive_overall(tasks: dict[str, dict], derived: dict[str, str]) -> str:
    required = [task_id for task_id, task in tasks.items() if task.get("required") is True]
    selected = required or list(tasks)
    statuses = [derived[task_id] for task_id in selected]
    if selected and all(status == "completed" for status in statuses):
        return "completed"
    if "blocked" in statuses:
        return "blocked"
    if not statuses or all(status == "not_started" for status in statuses):
        return "not_started"
    if "partial" in statuses or ("completed" in statuses and any(status != "completed" for status in statuses)):
        return "partial"
    return "in_progress"


def check(root: Path, contract_path: Path, policy_path: Path, claim: str) -> tuple[list[str], dict[str, Any]]:
    errors: list[str] = []
    contract = load_json(contract_path, errors, "completion contract")
    policy = load_json(policy_path, errors, "completion policy")
    if errors:
        return errors, {"derivedStatus": "unknown", "tasks": {}}
    if contract.get("schemaVersion") != 1:
        errors.append("completion contract schemaVersion must be 1")
    tasks = unique_records(contract.get("tasks", []), "task", errors)
    for task_id, task in tasks.items():
        for field in ("title", "workType", "risk", "required", "planRefs", "status", "implementationActor", "implementationRefs", "testRefs", "evidenceRefs", "acceptanceCriteria", "deliverables", "blocker", "completionReview"):
            if field not in task:
                errors.append(f"task {task_id} missing {field}")
        if task.get("status") not in STATUSES:
            errors.append(f"task {task_id} has invalid status {task.get('status')}")
    check_scope(contract, tasks, claim, errors)
    check_plan_coverage(root, contract, policy, tasks, errors)
    evidence, evidence_valid = check_evidence(root, contract, policy, errors)
    changes_by_task, change_valid = check_changes(root, contract, policy, tasks, errors)
    check_git_change_coverage(root, contract_path, contract, policy, claim, errors)
    derived: dict[str, str] = {}
    for task_id, task in tasks.items():
        derived[task_id] = derive_task_status(
            root, task_id, task, contract, policy, evidence, evidence_valid,
            changes_by_task.get(task_id, []), change_valid.get(task_id, True), errors,
        )
        if task.get("status") != derived[task_id]:
            errors.append(f"task {task_id} declared {task.get('status')} but derived {derived[task_id]}")
    overall = derive_overall(tasks, derived)
    if contract.get("claimedStatus") != overall:
        errors.append(f"contract claimedStatus {contract.get('claimedStatus')} but derived {overall}")
    if claim in {"code-done", "candidate-ready"} and overall != "completed":
        errors.append(f"{claim} requires derived completed status; found {overall}")
    if claim == "candidate-ready":
        candidate = contract.get("scope", {}).get("candidateRef")
        if not candidate:
            errors.append("candidate-ready requires candidateRef")
        required_subject = policy.get("candidate", {}).get("requireEvidenceSubject", "candidate")
        if candidate and not any(
            f"{required_subject}:{candidate}" in item.get("subjectRefs", []) and valid
            for evidence_id, item in evidence.items()
            for valid in [evidence_valid.get(evidence_id, False)]
        ):
            errors.append("candidate-ready has no valid evidence bound to candidateRef")
    return errors, {"derivedStatus": overall, "tasks": derived}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--contract", default="quality/completion-contract.json")
    parser.add_argument("--policy", default="quality/completion-integrity-policy.json")
    parser.add_argument("--claim", choices=CLAIMS, default="honest-status")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    root = args.root.expanduser().resolve()
    contract = safe_path(root, args.contract, "contract", [])
    policy = safe_path(root, args.policy, "policy", [])
    if contract is None or policy is None:
        print("completion_integrity_check=failed invalid paths")
        return 2
    errors, result = check(root, contract, policy, args.claim)
    if args.json:
        print(json.dumps({"claim": args.claim, **result, "errors": errors}, ensure_ascii=False, indent=2))
    elif errors:
        for error in errors:
            print(f"ERROR {error}")
        print(f"completion_integrity_check=failed claim={args.claim} derived={result['derivedStatus']} errors={len(errors)}")
    else:
        print(f"completion_integrity_check=passed claim={args.claim} derived={result['derivedStatus']}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
