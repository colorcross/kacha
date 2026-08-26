#!/usr/bin/env python3
"""Validate Figma Make Prompt Pack, frozen prototype and implementation alignment claims."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from figma_make_contract import (
    build_manifest,
    implementation_identity,
    parse_datetime,
    project_path,
    prototype_identity,
    sha256_file,
    tree_digest,
    validate_prompt_semantics,
    validate_run_contract,
)
from render_figma_make_prompt_pack import render

SCHEMA_CANDIDATES = (ROOT / "schemas/figma-make-prototype.schema.json", ROOT / "quality/schemas/figma-make-prototype.schema.json")
POLICY_CANDIDATES = (ROOT / "config/figma-make-prototype-policy.json", ROOT / "quality/figma-make-prototype-policy.json")
CLAIMS = ("structure", "prompt-pack-ready", "prototype-frozen", "prototype-validated", "implementation-aligned")
CLAIM_RANK = {claim: index for index, claim in enumerate(CLAIMS)}
PASSED = {"passed", "pass", "success", "succeeded", "ok", "completed"}


def _schema_validate(value: dict, schema: dict) -> list[str]:
    helper = ROOT / "tools/appcreate_schema.py"
    if helper.is_file():
        spec = importlib.util.spec_from_file_location("appcreate_schema", helper)
        if spec is None or spec.loader is None:
            return ["cannot load tools/appcreate_schema.py"]
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.validate(value, schema, "figma-make-prototype")
    from appcreate.schema import validate
    return validate(value, schema, "figma-make-prototype")


def load(path: Path, errors: list[str], label: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        errors.append(f"invalid {label}: {exc}")
        return {}
    if not isinstance(value, dict):
        errors.append(f"{label} must be a JSON object")
        return {}
    return value


def require_nonempty(record: dict, fields: tuple[str, ...], label: str, errors: list[str]) -> None:
    missing = [field for field in fields if record.get(field) in (None, "", [], {})]
    if missing:
        errors.append(f"{label} missing: {', '.join(missing)}")


def check_unique(items: object, label: str, errors: list[str]) -> dict[str, dict]:
    if not isinstance(items, list):
        errors.append(f"{label} must be a list")
        return {}
    by_id: dict[str, dict] = {}
    for index, item in enumerate(items):
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item.get("id"):
            errors.append(f"{label} {index} requires a non-empty id")
            continue
        if item["id"] in by_id:
            errors.append(f"duplicate {label} id: {item['id']}")
        by_id[item["id"]] = item
    return by_id


def semantic_pass(
    path: Path,
    subject: str,
    item: dict,
    contract: dict,
    expected_prototype_identity: str,
    expected_implementation_identity: str,
    errors: list[str],
) -> bool:
    if path.suffix.lower() != ".json":
        return False
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    if not isinstance(body, dict):
        return False
    result = str(body.get("result", body.get("status", ""))).lower()
    if result not in PASSED:
        return False
    body_subjects = body.get("subjectRefs", body.get("subjects", []))
    if not isinstance(body_subjects, list) or subject not in body_subjects:
        errors.append(f"structured evidence body is not bound to {subject}")
        return False
    if body.get("prototypeIdentity") != expected_prototype_identity:
        errors.append(f"structured evidence body has stale prototype identity for {subject}")
        return False
    if subject.startswith("implementation:") and body.get("implementationIdentity") != expected_implementation_identity:
        errors.append(f"structured evidence body has stale implementation identity for {subject}")
        return False
    observed_at = parse_datetime(item.get("observedAt"))
    prototype_frozen_at = parse_datetime(contract.get("prototype", {}).get("frozenAt"))
    if observed_at is None or prototype_frozen_at is None or observed_at < prototype_frozen_at:
        errors.append(f"evidence for {subject} predates the frozen prototype")
        return False
    if subject.startswith("implementation:"):
        implementation_frozen_at = parse_datetime(contract.get("implementation", {}).get("frozenAt"))
        if implementation_frozen_at is None or observed_at < implementation_frozen_at:
            errors.append(f"evidence for {subject} predates the frozen implementation")
            return False
    if subject == "runtime" and body.get("executed") is not True:
        errors.append("runtime evidence must record executed=true")
        return False
    if subject == "runtime":
        if body.get("run") != contract.get("prototype", {}).get("run"):
            errors.append("runtime evidence run contract does not match prototype.run")
            return False
        if body.get("exitCode") != 0:
            errors.append("runtime evidence must record exitCode=0")
            return False
        http_status = body.get("httpStatus")
        if not isinstance(http_status, int) or not 200 <= http_status < 400:
            errors.append("runtime evidence must record a successful HTTP status")
            return False
    if subject == "human-review":
        reviewer = body.get("reviewer")
        producer = item.get("producer")
        prototype_producer = contract.get("prototype", {}).get("producer")
        if not reviewer or reviewer != producer:
            errors.append("human-review evidence producer must equal its reviewer")
            return False
        if reviewer == prototype_producer:
            errors.append("human-review reviewer must differ from prototype producer")
            return False
    return True


def evidence_index(root: Path, contract: dict, errors: list[str]) -> tuple[dict[str, dict], dict[str, list[str]]]:
    by_id = check_unique(contract.get("evidence"), "evidence", errors)
    passed_by_subject: dict[str, list[str]] = {}
    expected_prototype_identity = prototype_identity(contract)
    expected_implementation_identity = implementation_identity(contract)
    for identifier, item in by_id.items():
        path = project_path(root, item.get("path"))
        if path is None:
            errors.append(f"evidence {identifier} path must stay inside project")
            continue
        if not path.is_file():
            errors.append(f"evidence {identifier} file does not exist")
            continue
        if item.get("sha256") != sha256_file(path):
            errors.append(f"evidence {identifier} sha256 does not match")
            continue
        subjects = item.get("subjectRefs", [])
        if not isinstance(subjects, list) or not subjects:
            errors.append(f"evidence {identifier} requires subjectRefs")
            continue
        if item.get("result") == "passed":
            for subject in subjects:
                if semantic_pass(
                    path,
                    str(subject),
                    item,
                    contract,
                    expected_prototype_identity,
                    expected_implementation_identity,
                    errors,
                ):
                    passed_by_subject.setdefault(str(subject), []).append(identifier)
    return by_id, passed_by_subject


def check_structure(contract: dict, policy: dict, errors: list[str]) -> tuple[dict[str, dict], dict[str, dict]]:
    schema_path = next((path for path in SCHEMA_CANDIDATES if path.is_file()), None)
    if schema_path is None:
        errors.append("Figma Make schema is missing")
        return {}, {}
    schema = load(schema_path, errors, "Figma Make schema")
    if schema:
        errors.extend(_schema_validate(contract, schema))
    errors.extend(validate_prompt_semantics(contract) if contract.get("applicability", {}).get("status") == "applicable" else [])
    pages = check_unique(contract.get("pages"), "page", errors)
    journeys = check_unique(contract.get("journeys"), "journey", errors)
    for page_id, page in pages.items():
        states = check_unique(page.get("states"), f"page {page_id} state", errors)
        interactions = check_unique(page.get("interactions"), f"page {page_id} interaction", errors)
        for interaction in interactions.values():
            target = interaction.get("targetPageId")
            if target is not None and target not in pages:
                errors.append(f"page {page_id} interaction {interaction['id']} references unknown page {target}")
        if len(states) != len(page.get("states", [])) or len(interactions) != len(page.get("interactions", [])):
            continue
    for journey_id, journey in journeys.items():
        steps = journey.get("steps", [])
        if not isinstance(steps, list):
            errors.append(f"journey {journey_id} steps must be a list")
            continue
        for index, step in enumerate(steps):
            if not isinstance(step, dict) or step.get("pageId") not in pages:
                errors.append(f"journey {journey_id} step {index} references unknown page")
    route = contract.get("route", {})
    matching = [item for item in policy["routing"]["rules"] if item["loginState"] == route.get("loginState") and item["promptPackStatus"] == route.get("promptPackStatus")]
    if not matching or route.get("action") != matching[0]["action"]:
        errors.append("route action does not match loginState and promptPackStatus policy")
    applicability = contract.get("applicability", {})
    if applicability.get("status") == "not_applicable":
        require_nonempty(applicability, ("reason", "approvedBy"), "not_applicable", errors)
    return pages, journeys


def check_prompt(root: Path, contract: dict, pages: dict[str, dict], journeys: dict[str, dict], errors: list[str]) -> None:
    require_nonempty(contract.get("product", {}), ("name", "summary", "targetUsers", "platforms"), "product", errors)
    require_nonempty(
        contract.get("productContracts", {}),
        ("businessRules", "dataAndApi", "rolesAndPermissions", "failureBoundaries"),
        "productContracts",
        errors,
    )
    design = contract.get("design", {})
    require_nonempty(design, ("direction", "tokens", "responsiveModes", "accessibilityRequirements", "contentConstraints", "nonGoals"), "design", errors)
    if not pages:
        errors.append("prompt-pack-ready requires at least one page")
    if not journeys:
        errors.append("prompt-pack-ready requires at least one journey")
    for page_id, page in pages.items():
        require_nonempty(page, ("name", "route", "purpose", "states", "interactions", "acceptance"), f"page {page_id}", errors)
    for journey_id, journey in journeys.items():
        require_nonempty(journey, ("name", "steps", "acceptance"), f"journey {journey_id}", errors)
    prompt = contract.get("promptPack", {})
    require_nonempty(prompt, ("sourceRefs", "sourceDocuments", "outputPath", "digest", "generatedAt"), "promptPack", errors)
    source_refs = prompt.get("sourceRefs", [])
    source_documents = prompt.get("sourceDocuments", [])
    if isinstance(source_refs, list) and isinstance(source_documents, list):
        if [item.get("path") for item in source_documents if isinstance(item, dict)] != source_refs:
            errors.append("promptPack.sourceDocuments must exactly cover sourceRefs in order")
        for item in source_documents:
            if not isinstance(item, dict):
                errors.append("promptPack source document must be an object")
                continue
            source = project_path(root, item.get("path"))
            if source is None or not source.is_file():
                errors.append(f"Prompt source is missing or outside project: {item.get('path')}")
            elif item.get("sha256") != sha256_file(source):
                errors.append(f"Prompt source digest does not match: {item.get('path')}")
    path = project_path(root, prompt.get("outputPath"))
    if path is None or not path.is_file():
        errors.append("Prompt Pack output file is missing or outside project")
    elif prompt.get("digest") != sha256_file(path):
        errors.append("Prompt Pack digest does not match output file")
    else:
        try:
            expected = render(contract)
        except ValueError as exc:
            errors.append(f"Prompt Pack contract cannot be rendered: {exc}")
        else:
            if path.read_text(encoding="utf-8") != expected:
                errors.append("Prompt Pack output does not match the current contract")
    if contract.get("route", {}).get("promptPackStatus") != "ready":
        errors.append("prompt-pack-ready requires route.promptPackStatus=ready")


def check_frozen(root: Path, contract: dict, policy: dict, errors: list[str]) -> None:
    prototype = contract.get("prototype", {})
    require_nonempty(prototype, ("makeRef", "producer", "codeRoot", "packageManifest", "lockfiles", "fileManifest", "treeDigest", "frozenAt"), "prototype", errors)
    make_ref = prototype.get("makeRef", "")
    if not isinstance(make_ref, str) or not make_ref.startswith("https://www.figma.com/make/"):
        errors.append("prototype.makeRef must be a Figma Make URL")
    source = project_path(root, prototype.get("codeRoot"))
    if source is None or not source.is_dir():
        errors.append("prototype.codeRoot is missing or outside project")
        return
    try:
        actual = build_manifest(source, policy)
    except ValueError as exc:
        errors.append(f"prototype {exc}")
        return
    if actual != prototype.get("fileManifest"):
        errors.append("prototype file manifest does not match current code tree")
    if prototype.get("treeDigest") != tree_digest(actual):
        errors.append("prototype treeDigest does not match current code tree")
    paths = {item["path"] for item in actual}
    if prototype.get("packageManifest") not in paths:
        errors.append("prototype package manifest is not frozen")
    if prototype.get("packageManifest") not in policy.get("packageManifests", []):
        errors.append("prototype package manifest is not supported by policy")
    declared_lockfiles = set(prototype.get("lockfiles", []))
    if not declared_lockfiles.intersection(paths):
        errors.append("prototype requires at least one frozen lockfile")
    if not declared_lockfiles.issubset(set(policy.get("lockfiles", []))):
        errors.append("prototype declares an unsupported lockfile")
    errors.extend(validate_run_contract(prototype.get("run"), root, source))


def check_validated(contract: dict, pages: dict[str, dict], journeys: dict[str, dict], passed: dict[str, list[str]], errors: list[str]) -> None:
    required = ["runtime", "accessibility", "human-review"]
    required += [f"responsive:{mode}" for mode in contract.get("design", {}).get("responsiveModes", [])]
    for page_id, page in pages.items():
        required.append(f"page:{page_id}")
        required += [f"page:{page_id}:state:{state['id']}" for state in page.get("states", []) if isinstance(state, dict) and state.get("id")]
        required += [f"page:{page_id}:interaction:{item['id']}" for item in page.get("interactions", []) if isinstance(item, dict) and item.get("id")]
    required += [f"journey:{journey_id}" for journey_id in journeys]
    for subject in required:
        if not passed.get(subject):
            errors.append(f"prototype-validated requires passed structured evidence for {subject}")
    run_ref = contract.get("prototype", {}).get("run", {}).get("evidenceRef")
    if run_ref not in passed.get("runtime", []):
        errors.append("prototype run evidenceRef is not passed runtime evidence")


def check_alignment(root: Path, contract: dict, policy: dict, pages: dict[str, dict], journeys: dict[str, dict], evidence: dict[str, dict], passed: dict[str, list[str]], errors: list[str]) -> None:
    implementation = contract.get("implementation", {})
    require_nonempty(
        implementation,
        ("root", "sourceRevision", "fileManifest", "treeDigest", "frozenAt", "pageMappings", "journeyMappings", "verifiedAt"),
        "implementation",
        errors,
    )
    implementation_root = project_path(root, implementation.get("root"))
    if implementation_root is None or not implementation_root.exists():
        errors.append("implementation.root is missing or outside project")
        return
    prototype_root = project_path(root, contract.get("prototype", {}).get("codeRoot"))
    if prototype_root is None:
        errors.append("prototype.codeRoot is missing or outside project")
        return
    if implementation_root.is_relative_to(prototype_root) or prototype_root.is_relative_to(implementation_root):
        errors.append("implementation.root and prototype.codeRoot must be independent trees")
    try:
        actual_manifest = build_manifest(implementation_root, policy)
    except (OSError, ValueError) as exc:
        errors.append(f"implementation source cannot be frozen: {exc}")
        actual_manifest = []
    if actual_manifest != implementation.get("fileManifest"):
        errors.append("implementation file manifest does not match current code tree")
    if implementation.get("treeDigest") != tree_digest(actual_manifest):
        errors.append("implementation treeDigest does not match current code tree")
    verified_at = parse_datetime(implementation.get("verifiedAt"))
    frozen_at = parse_datetime(implementation.get("frozenAt"))
    if verified_at is None or frozen_at is None or verified_at < frozen_at:
        errors.append("implementation.verifiedAt must be at or after implementation.frozenAt")
    page_mappings = check_unique(implementation.get("pageMappings"), "implementation page mapping", errors)
    journey_mappings = check_unique(implementation.get("journeyMappings"), "implementation journey mapping", errors)
    if set(page_mappings) != set(pages):
        errors.append("implementation page mappings must exactly cover prototype pages")
    if set(journey_mappings) != set(journeys):
        errors.append("implementation journey mappings must exactly cover prototype journeys")
    for kind, mappings in (("page", page_mappings), ("journey", journey_mappings)):
        for identifier, mapping in mappings.items():
            if mapping.get("status") != "passed":
                errors.append(f"implementation {kind} {identifier} is not passed")
            refs = mapping.get("evidenceRefs", [])
            if not isinstance(refs, list) or not refs:
                errors.append(f"implementation {kind} {identifier} requires evidenceRefs")
                continue
            unknown = [ref for ref in refs if ref not in evidence]
            if unknown:
                errors.append(f"implementation {kind} {identifier} references unknown evidence: {', '.join(unknown)}")
            subject = f"implementation:{kind}:{identifier}"
            if not set(refs).intersection(passed.get(subject, [])):
                errors.append(f"implementation {kind} {identifier} lacks passed structured alignment evidence")
            source_refs = mapping.get("sourceRefs", [])
            if not isinstance(source_refs, list) or not source_refs:
                errors.append(f"implementation {kind} {identifier} requires sourceRefs")
            else:
                for source_ref in source_refs:
                    source_path = project_path(root, source_ref)
                    if source_path is None or not source_path.is_file() or not source_path.is_relative_to(implementation_root):
                        errors.append(
                            f"implementation {kind} {identifier} sourceRef must be a file inside implementation.root: {source_ref}"
                        )


def check(contract_path: Path, claim: str, root: Path | None = None) -> list[str]:
    errors: list[str] = []
    project_root = (root or (contract_path.parent.parent if contract_path.parent.name == "quality" else contract_path.parent)).resolve()
    contract = load(contract_path, errors, "Figma Make contract")
    policy_path = next((path for path in POLICY_CANDIDATES if path.is_file()), None)
    if policy_path is None:
        errors.append("Figma Make policy is missing")
        return errors
    policy = load(policy_path, errors, "Figma Make policy")
    if errors:
        return errors
    pages, journeys = check_structure(contract, policy, errors)
    evidence, passed = evidence_index(project_root, contract, errors)
    applicability = contract.get("applicability", {})
    status = applicability.get("status")
    if claim == "structure" or status == "not_applicable":
        return sorted(set(errors))
    if status != "applicable":
        errors.append(f"{claim} requires applicability.status=applicable or approved not_applicable")
        return sorted(set(errors))
    if CLAIM_RANK[claim] >= CLAIM_RANK["prompt-pack-ready"]:
        check_prompt(project_root, contract, pages, journeys, errors)
    if CLAIM_RANK[claim] >= CLAIM_RANK["prototype-frozen"]:
        check_frozen(project_root, contract, policy, errors)
    if CLAIM_RANK[claim] >= CLAIM_RANK["prototype-validated"]:
        check_validated(contract, pages, journeys, passed, errors)
    if CLAIM_RANK[claim] >= CLAIM_RANK["implementation-aligned"]:
        check_alignment(project_root, contract, policy, pages, journeys, evidence, passed, errors)
    return sorted(set(errors))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("contract", nargs="?", type=Path, default=Path("quality/figma-make-prototype.json"))
    parser.add_argument("--claim", choices=CLAIMS, default="structure")
    parser.add_argument("--root", type=Path)
    args = parser.parse_args()
    errors = check(args.contract.resolve(), args.claim, args.root)
    if errors:
        for error in errors:
            print(f"ERROR {error}")
        print(f"figma_make_prototype_check=failed claim={args.claim} errors={len(errors)}")
        return 1
    print(f"figma_make_prototype_check=passed claim={args.claim}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
