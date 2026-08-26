#!/usr/bin/env python3
"""Validate deep whole-product review after an audit-led upgrade iteration."""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

helper = ROOT / "tools/appcreate_schema.py"
if helper.is_file():
    spec = importlib.util.spec_from_file_location("appcreate_schema", helper)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load schema helper: {helper}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    validate_schema = module.validate
else:
    from appcreate.schema import validate as validate_schema

evidence_helper = ROOT / "tools/appcreate_evidence.py"
if evidence_helper.is_file():
    evidence_spec = importlib.util.spec_from_file_location("appcreate_evidence", evidence_helper)
    if evidence_spec is None or evidence_spec.loader is None:
        raise ImportError(f"cannot load evidence helper: {evidence_helper}")
    evidence_module = importlib.util.module_from_spec(evidence_spec)
    evidence_spec.loader.exec_module(evidence_module)
    verify_declared_evidence = evidence_module.verify_declared_evidence
else:
    from appcreate.evidence import verify_declared_evidence

POLICY_PATHS = (
    ROOT / "config/post-iteration-review-policy.json",
    ROOT / "quality/post-iteration-review-policy.json",
)
SCHEMA_PATHS = (
    ROOT / "schemas/post-iteration-review.schema.json",
    ROOT / "quality/schemas/post-iteration-review.schema.json",
)
CLAIMS = ("review-structured", "deep-review-complete", "release-review-ready", "outcome-reviewed")
CLAIM_RANK = {"draft": 0, **{claim: index + 1 for index, claim in enumerate(CLAIMS)}}


def load(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("review must be a JSON object")
    return payload


def policy() -> dict:
    return load(next(path for path in POLICY_PATHS if path.is_file()))


def schema() -> dict:
    return load(next(path for path in SCHEMA_PATHS if path.is_file()))


def _parse_time(value: str, owner: str, errors: list[str]) -> dt.datetime | None:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        errors.append(f"{owner} must be an ISO 8601 timestamp")
        return None
    if parsed.tzinfo is None:
        errors.append(f"{owner} must include a timezone")
        return None
    return parsed.astimezone(dt.timezone.utc)


def _duplicates(items: list[dict]) -> set[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for item in items:
        identifier = str(item.get("id"))
        if identifier in seen:
            duplicates.add(identifier)
        seen.add(identifier)
    return duplicates


def _unknown_refs(owner: str, refs: list[str], known: set[str], kind: str) -> list[str]:
    return [f"{owner} references unknown {kind}: {ref}" for ref in refs if ref not in known]


def _closed_cell(cell: dict, owner: str, evidence_levels: dict[str, str], mandatory: bool) -> list[str]:
    errors: list[str] = []
    status = cell.get("status")
    if status == "passed":
        if not cell.get("scope") or not cell.get("reviewer") or not cell.get("reviewedAt"):
            errors.append(f"{owner} passed requires scope, reviewer and reviewedAt")
        refs = cell.get("evidenceRefs", [])
        if not refs or not any(evidence_levels.get(ref) != "E0-unverified" for ref in refs):
            errors.append(f"{owner} passed requires evidence above E0")
    elif status == "not_applicable":
        na = cell.get("notApplicable", {})
        if not na.get("reason") or not na.get("approvedBy"):
            errors.append(f"{owner} not_applicable requires reason and approvedBy")
        if mandatory:
            errors.append(f"{owner} is mandatory")
    else:
        errors.append(f"{owner} must be passed or approved not_applicable")
    return errors


def validate_review(payload: dict, requested_claim: str = "review-structured") -> list[str]:
    if requested_claim not in CLAIMS:
        return [f"unsupported claim: {requested_claim}"]
    declared = payload.get("claim", "draft")
    effective = declared if CLAIM_RANK.get(declared, -1) > CLAIM_RANK[requested_claim] else requested_claim
    p = policy()
    errors = validate_schema(payload, schema(), "review")
    if errors:
        return sorted(set(errors))

    evidence = payload.get("evidence", [])
    findings = payload.get("findings", [])
    domains = payload.get("domains", [])
    perspectives = payload.get("perspectives", [])
    levels = payload.get("levels", [])
    evidence_ids = {item.get("id") for item in evidence}
    evidence_levels = {item.get("id"): item.get("level") for item in evidence}
    evidence_by_id = {item.get("id"): item for item in evidence}
    finding_ids = {item.get("id") for item in findings}
    domain_ids = set(p["domains"])
    perspective_ids = set(p["perspectives"])
    level_ids = set(p["levels"])

    for label, items in (("evidence", evidence), ("finding", findings)):
        for identifier in sorted(_duplicates(items)):
            errors.append(f"duplicate {label} id: {identifier}")
    if [item.get("id") for item in domains] != p["domains"]:
        errors.append("domains must be complete and ordered")
    if [item.get("id") for item in perspectives] != p["perspectives"]:
        errors.append("perspectives must be complete and ordered")
    if [item.get("id") for item in levels] != p["levels"]:
        errors.append("levels must be complete and ordered")
    valid_evidence_levels = set(p["evidenceLevels"])
    for item in evidence:
        if item.get("level") not in valid_evidence_levels:
            errors.append(f"evidence {item.get('id')} has unsupported level")
        if item.get("level") != "E0-unverified":
            evidence_root = Path(payload.get("product", {}).get("ref", ".")).expanduser()
            errors.extend(verify_declared_evidence(item, root=evidence_root))

    def require_binding(owner: str, refs: list[str], subject: str) -> None:
        for ref in refs:
            if subject not in evidence_by_id.get(ref, {}).get("subjectRefs", []):
                errors.append(f"{owner} evidence {ref} is not bound to {subject}")

    for cell in domains:
        owner = f"domain {cell.get('id')}"
        errors.extend(_unknown_refs(owner, cell.get("evidenceRefs", []), evidence_ids, "evidence"))
        errors.extend(_unknown_refs(owner, cell.get("findingIds", []), finding_ids, "finding"))
        require_binding(owner, cell.get("evidenceRefs", []), f"domain:{cell.get('id')}")
    for cell in perspectives:
        owner = f"perspective {cell.get('id')}"
        errors.extend(_unknown_refs(owner, cell.get("evidenceRefs", []), evidence_ids, "evidence"))
        errors.extend(_unknown_refs(owner, cell.get("findingIds", []), finding_ids, "finding"))
        require_binding(owner, cell.get("evidenceRefs", []), f"perspective:{cell.get('id')}")
    for cell in levels:
        owner = f"level {cell.get('id')}"
        errors.extend(_unknown_refs(owner, cell.get("evidenceRefs", []), evidence_ids, "evidence"))
        errors.extend(_unknown_refs(owner, cell.get("findingIds", []), finding_ids, "finding"))
        require_binding(owner, cell.get("evidenceRefs", []), f"level:{cell.get('id')}")
    for finding in findings:
        owner = f"finding {finding.get('id')}"
        require_binding(owner, finding.get("regressionEvidenceRefs", []), f"finding:{finding.get('id')}")
        for identifier in finding.get("domains", []):
            if identifier not in domain_ids:
                errors.append(f"{owner} references unknown domain: {identifier}")
            elif finding.get("id") not in next(item for item in domains if item.get("id") == identifier).get("findingIds", []):
                errors.append(f"{owner} is not back-referenced by domain {identifier}")
        for identifier in finding.get("perspectives", []):
            if identifier not in perspective_ids:
                errors.append(f"{owner} references unknown perspective: {identifier}")
            elif finding.get("id") not in next(item for item in perspectives if item.get("id") == identifier).get("findingIds", []):
                errors.append(f"{owner} is not back-referenced by perspective {identifier}")
        for identifier in finding.get("levels", []):
            if identifier not in level_ids:
                errors.append(f"{owner} references unknown level: {identifier}")
            elif finding.get("id") not in next(item for item in levels if item.get("id") == identifier).get("findingIds", []):
                errors.append(f"{owner} is not back-referenced by level {identifier}")
        if not any(finding.get("id") in item.get("findingIds", []) for item in domains):
            errors.append(f"{owner} is not back-referenced by a domain")
        if not any(finding.get("id") in item.get("findingIds", []) for item in perspectives):
            errors.append(f"{owner} is not back-referenced by a perspective")
        if not any(finding.get("id") in item.get("findingIds", []) for item in levels):
            errors.append(f"{owner} is not back-referenced by a level")

    scope = payload.get("scope", {})
    for key in ("selectedRecommendationIds", "changedPages", "changedModules", "changedJourneys", "changedServices"):
        values = scope.get(key, [])
        if len(values) != len(set(values)):
            errors.append(f"scope.{key} must be unique")
    selected = scope.get("selectedRecommendationIds", [])
    traceability = payload.get("traceability", [])
    trace_ids = [item.get("recommendationId") for item in traceability]
    if len(trace_ids) != len(set(trace_ids)):
        errors.append("traceability recommendationId values must be unique")
    if set(trace_ids) != set(selected):
        errors.append("traceability must cover every selected audit recommendation exactly once")
    for item in traceability:
        errors.extend(_unknown_refs(f"trace {item.get('recommendationId')}", item.get("reviewFindingIds", []), finding_ids, "review finding"))
        errors.extend(_unknown_refs(f"trace {item.get('recommendationId')}", item.get("verificationRefs", []), evidence_ids, "verification evidence"))
        require_binding(
            f"trace {item.get('recommendationId')}",
            item.get("verificationRefs", []),
            f"recommendation:{item.get('recommendationId')}",
        )

    applicability = payload.get("applicability", {})
    applicability_status = applicability.get("status")
    errors.extend(_unknown_refs("applicability", applicability.get("evidenceRefs", []), evidence_ids, "evidence"))
    if applicability_status == "not_applicable" and (not applicability.get("reason") or not applicability.get("approvedBy")):
        errors.append("post-iteration review not_applicable requires reason and approvedBy")

    coverage_map = p["scopeCoverage"]
    by_level = {item.get("id"): item for item in levels}
    for level_id, scope_key in coverage_map.items():
        level = by_level.get(level_id, {})
        expected = sorted(set(scope.get(scope_key, [])))
        declared_expected = sorted(set(level.get("itemsExpected", [])))
        reviewed = sorted(set(level.get("itemsReviewed", [])))
        if declared_expected != expected:
            errors.append(f"level {level_id} itemsExpected must match scope.{scope_key}")
        if level.get("status") == "passed" and reviewed != expected:
            errors.append(f"level {level_id} passed must review every expected item")
        if not expected and level.get("status") == "passed":
            errors.append(f"level {level_id} cannot pass with an empty applicable scope; use approved not_applicable")

    if effective == "review-structured":
        return sorted(set(errors))

    if applicability_status != "applicable":
        errors.append("deep-review-complete requires applicability.status applicable")
    if scope.get("status") != "completed":
        errors.append("deep-review-complete requires completed scope freeze")
    mandatory_domains = set(p["mandatoryDomains"])
    for cell in domains:
        errors.extend(_closed_cell(cell, f"domain {cell.get('id')}", evidence_levels, cell.get("id") in mandatory_domains))
    mandatory_perspectives = set(p["mandatoryPerspectives"])
    for cell in perspectives:
        errors.extend(_closed_cell(cell, f"perspective {cell.get('id')}", evidence_levels, cell.get("id") in mandatory_perspectives))
        if cell.get("status") == "passed" and not cell.get("reviewRunRef"):
            errors.append(f"perspective {cell.get('id')} passed requires an attributable reviewRunRef")
    producer = payload.get("finalReview", {}).get("producer")
    run_reviewers: dict[str, set[str]] = {}
    for item in perspectives:
        if item.get("status") != "passed":
            continue
        reviewer = item.get("reviewer")
        run_ref = item.get("reviewRunRef")
        if reviewer and run_ref:
            run_reviewers.setdefault(run_ref, set()).add(reviewer)
            if run_ref not in evidence_ids or evidence_levels.get(run_ref) == "E0-unverified":
                errors.append(f"perspective {item.get('id')} reviewRunRef must resolve to evidence above E0")
    for run_ref, owners in run_reviewers.items():
        if len(owners) > 1:
            errors.append(f"review run {run_ref} cannot be attributed to multiple reviewers")
    final_perspective = next((item for item in perspectives if item.get("id") == "independent-final-review"), {})
    final_reviewer = payload.get("finalReview", {}).get("finalReviewer")
    if not final_perspective.get("independentFromProducer") or final_perspective.get("reviewer") != final_reviewer:
        errors.append("independent final-review perspective must match the final reviewer")
    if not producer or not final_reviewer or producer == final_reviewer:
        errors.append("producer cannot be the final reviewer")
    if payload.get("finalReview", {}).get("reviewRunRef") != final_perspective.get("reviewRunRef"):
        errors.append("finalReview reviewRunRef must match the independent final-review perspective")
    if payload.get("finalReview", {}).get("decision") == "not_reviewed":
        errors.append("deep-review-complete requires a final review decision")
    errors.extend(_unknown_refs("finalReview", payload.get("finalReview", {}).get("evidenceRefs", []), evidence_ids, "evidence"))

    mandatory_levels = set(p["mandatoryLevels"])
    for cell in levels:
        owner = f"level {cell.get('id')}"
        status = cell.get("status")
        if status == "deferred":
            if cell.get("id") not in {"candidate-release", "production-outcome"} or not cell.get("deferredUntil"):
                errors.append(f"{owner} deferred requires an allowed level and deferredUntil trigger")
            continue
        pseudo = {**cell, "reviewer": final_reviewer, "reviewedAt": payload.get("finalReview", {}).get("observedAt"), "scope": cell.get("itemsExpected") or [cell.get("id")]}
        errors.extend(_closed_cell(pseudo, owner, evidence_levels, cell.get("id") in mandatory_levels))

    for finding in findings:
        owner = f"finding {finding.get('id')}"
        if not finding.get("owner"):
            errors.append(f"{owner} requires an owner")
        severity = finding.get("severity")
        status = finding.get("status")
        if severity in {"critical", "high"} and (not finding.get("independentReviewer") or finding.get("independentReviewer") == producer):
            errors.append(f"{owner} critical/high requires an independent reviewer")
        if status == "verified_closed" and (not finding.get("remediationRefs") or not finding.get("regressionEvidenceRefs")):
            errors.append(f"{owner} verified_closed requires remediation and regression evidence")
        errors.extend(_unknown_refs(owner, finding.get("regressionEvidenceRefs", []), evidence_ids, "regression evidence"))
        if status == "accepted_risk":
            if severity == "critical":
                errors.append(f"{owner} critical risk cannot be accepted")
            if severity == "high":
                acceptance = finding.get("riskAcceptance", {})
                for field in p["riskRules"]["highAcceptanceRequires"]:
                    if not acceptance.get(field):
                        errors.append(f"{owner} high risk acceptance requires {field}")
                expires = _parse_time(acceptance.get("expiresAt"), f"{owner} riskAcceptance.expiresAt", errors)
                if expires and expires <= dt.datetime.now(dt.timezone.utc):
                    errors.append(f"{owner} high risk acceptance has expired")
                if acceptance.get("independentReviewer") != finding.get("independentReviewer"):
                    errors.append(f"{owner} risk acceptance independentReviewer must match the finding")
    unresolved_blockers = [
        item for item in findings
        if item.get("severity") in {"critical", "high"}
        and item.get("status") not in {"verified_closed", "accepted_risk"}
    ]
    accepted_risks = [item for item in findings if item.get("status") == "accepted_risk"]
    final_decision = payload.get("finalReview", {}).get("decision")
    if unresolved_blockers and final_decision in {"approved", "approved_with_residual_risk"}:
        errors.append("final review cannot approve while critical/high findings remain unresolved")
    if accepted_risks and final_decision != "approved_with_residual_risk":
        errors.append("accepted risks require final decision approved_with_residual_risk")
    require_binding("finalReview", payload.get("finalReview", {}).get("evidenceRefs", []), "final-review")
    if effective == "deep-review-complete":
        return sorted(set(errors))

    release = payload.get("releaseReadiness", {})
    candidate_revision = payload.get("product", {}).get("candidateRevision")
    baseline_revision = payload.get("product", {}).get("baselineRevision")
    if baseline_revision == candidate_revision:
        errors.append("candidateRevision must differ from baselineRevision")
    if release.get("status") != "passed" or not release.get("candidateRef"):
        errors.append("release-review-ready requires a passed identified candidate")
    elif release.get("candidateRef") != candidate_revision:
        errors.append("releaseReadiness candidateRef must match product.candidateRevision")
    if not release.get("decision"):
        errors.append("release-review-ready requires a release readiness decision")
    for key in ("targetEnvironmentEvidenceRefs", "rollbackEvidenceRefs"):
        refs = release.get(key, [])
        if not refs:
            errors.append(f"release-review-ready requires {key}")
        errors.extend(_unknown_refs("releaseReadiness", refs, evidence_ids, "evidence"))
    if release.get("targetEnvironmentEvidenceRefs") and not any(
        evidence_levels.get(ref) in {"E3-integrated-target-environment", "E4-production-observation", "E5-user-or-business-outcome"}
        for ref in release.get("targetEnvironmentEvidenceRefs", [])
    ):
        errors.append("release-review-ready target environment evidence must be E3 or higher")
    if release.get("rollbackEvidenceRefs") and not any(
        evidence_levels.get(ref) in {"E3-integrated-target-environment", "E4-production-observation"}
        for ref in release.get("rollbackEvidenceRefs", [])
    ):
        errors.append("release-review-ready rollback evidence must include an E3 rehearsal or E4 observation")
    for level_id in ("target-environment-device", "candidate-release"):
        if by_level.get(level_id, {}).get("status") != "passed":
            errors.append(f"release-review-ready requires level {level_id} passed")
    candidate_level = by_level.get("candidate-release", {})
    if candidate_level.get("itemsExpected") != [candidate_revision] or candidate_level.get("itemsReviewed") != [candidate_revision]:
        errors.append("candidate-release level must review exactly product.candidateRevision")
    release_evidence = set(release.get("targetEnvironmentEvidenceRefs", [])) | set(release.get("rollbackEvidenceRefs", []))
    if not release_evidence.issubset(set(candidate_level.get("evidenceRefs", [])) | set(by_level.get("target-environment-device", {}).get("evidenceRefs", []))):
        errors.append("release evidence must be bound to candidate-release or target-environment-device levels")
    if payload.get("finalReview", {}).get("decision") not in {"approved", "approved_with_residual_risk"}:
        errors.append("release-review-ready requires an approved final decision")
    for finding in findings:
        if finding.get("severity") == "critical" and finding.get("status") != "verified_closed":
            errors.append(f"critical finding {finding.get('id')} blocks release-review-ready")
        if finding.get("severity") == "high" and finding.get("status") not in {"verified_closed", "accepted_risk"}:
            errors.append(f"high finding {finding.get('id')} blocks release-review-ready")
    if effective == "release-review-ready":
        return sorted(set(errors))

    production = payload.get("productionObservation", {})
    if production.get("status") != "completed" or not production.get("window"):
        errors.append("outcome-reviewed requires a completed production observation window")
    production_refs = production.get("evidenceRefs", [])
    errors.extend(_unknown_refs("productionObservation", production_refs, evidence_ids, "evidence"))
    observed_levels = {evidence_levels.get(ref) for ref in production_refs}
    if "E4-production-observation" not in observed_levels:
        errors.append("outcome-reviewed requires E4 production evidence")
    if "E5-user-or-business-outcome" not in observed_levels:
        errors.append("outcome-reviewed requires E5 user or business evidence")
    metrics = production.get("metrics", [])
    if not metrics or any(item.get("status") != "passed" or not item.get("evidenceRefs") for item in metrics):
        errors.append("outcome-reviewed requires every declared product and market metric to pass with evidence")
    for metric in metrics:
        errors.extend(_unknown_refs(f"production metric {metric.get('id')}", metric.get("evidenceRefs", []), evidence_ids, "evidence"))
    categories = {item.get("category") for item in metrics if item.get("status") == "passed"}
    for required in p["outcomeMetricCategories"]:
        if required not in categories:
            errors.append(f"outcome-reviewed requires a passed {required} metric")
    market_refs = {
        ref
        for item in metrics if item.get("category") == "market-business"
        for ref in item.get("evidenceRefs", [])
    }
    if not any(evidence_levels.get(ref) == "E5-user-or-business-outcome" for ref in market_refs):
        errors.append("outcome-reviewed market-business metrics require E5 evidence")
    product_refs = {
        ref
        for item in metrics if item.get("category") == "product"
        for ref in item.get("evidenceRefs", [])
    }
    if not any(evidence_levels.get(ref) in {"E4-production-observation", "E5-user-or-business-outcome"} for ref in product_refs):
        errors.append("outcome-reviewed product metrics require E4 or E5 evidence")
    if by_level.get("production-outcome", {}).get("status") != "passed":
        errors.append("outcome-reviewed requires production-outcome level passed")
    elif not set(production_refs).issubset(set(by_level.get("production-outcome", {}).get("evidenceRefs", []))):
        errors.append("production-outcome level must include all production observation evidence")
    return sorted(set(errors))


def summary(payload: dict) -> dict:
    return {
        "product": payload.get("product", {}).get("ref"),
        "iterationId": payload.get("product", {}).get("iterationId"),
        "claim": payload.get("claim"),
        "domainStatus": {item.get("id"): item.get("status") for item in payload.get("domains", [])},
        "perspectiveStatus": {item.get("id"): item.get("status") for item in payload.get("perspectives", [])},
        "levelStatus": {item.get("id"): item.get("status") for item in payload.get("levels", [])},
        "findings": {status: sum(1 for item in payload.get("findings", []) if item.get("status") == status) for status in policy()["findingStatuses"]},
        "finalDecision": payload.get("finalReview", {}).get("decision"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("review", type=Path)
    parser.add_argument("--claim", choices=CLAIMS, default="review-structured")
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()
    try:
        payload = load(args.review)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    try:
        errors = validate_review(payload, "review-structured" if args.summary else args.claim)
    except (OSError, ValueError, json.JSONDecodeError, StopIteration) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if errors:
        print("\n".join(errors))
        return 2
    if args.summary:
        print(json.dumps(summary(payload), ensure_ascii=False, indent=2))
        return 0
    print(f"post-iteration deep review claim passed: {args.claim}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
