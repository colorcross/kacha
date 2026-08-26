#!/usr/bin/env python3
"""Choose the Figma Make launch path without reading browser credentials."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
POLICY_CANDIDATES = (
    ROOT / "config/figma-make-prototype-policy.json",
    ROOT / "quality/figma-make-prototype-policy.json",
)


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def policy() -> dict:
    path = next((path for path in POLICY_CANDIDATES if path.is_file()), None)
    if path is None:
        raise ValueError("Figma Make prototype policy is missing")
    return load_json(path)


def decide(login_state: str, prompt_pack_status: str) -> dict:
    rules = policy()["routing"]
    if login_state not in rules["loginStates"]:
        raise ValueError(f"unsupported login state: {login_state}")
    if prompt_pack_status not in rules["promptPackStatuses"]:
        raise ValueError(f"unsupported prompt pack status: {prompt_pack_status}")
    rule = next(
        item for item in rules["rules"]
        if item["loginState"] == login_state and item["promptPackStatus"] == prompt_pack_status
    )
    action = rule["action"]
    reasons = {
        "browser_automation": "Figma Make editor is authenticated and the complete Prompt Pack is ready.",
        "prepare_prompt_pack": "Figma is authenticated, but AppCreate must complete the Prompt Pack before submitting.",
        "prompt_pack_handoff": "Figma authentication is unavailable or unverified; provide the complete Prompt Pack for manual launch.",
    }
    next_steps = {
        "browser_automation": [
            f"Open {rules['makeEntryUrl']} in the current authenticated browser session.",
            "Locate the visible Make prompt composer, insert the complete Prompt Pack and submit once.",
            "Wait for a runnable preview, inspect visible errors, then record the resulting Make URL.",
            "Do not read cookies, tokens, localStorage or use private Figma endpoints.",
        ],
        "prepare_prompt_pack": [
            "Complete product, page, state, interaction, journey and acceptance fields.",
            "Render and verify the Prompt Pack before returning to browser automation.",
        ],
        "prompt_pack_handoff": [
            "Render the complete Make Prompt Pack to a project file.",
            f"Give the user the Prompt Pack and {rules['makeEntryUrl']}.",
            "After the user starts Make, record the Make URL and continue prototype freezing.",
        ],
    }
    return {
        "loginState": login_state,
        "promptPackStatus": prompt_pack_status,
        "action": action,
        "makeEntryUrl": rules["makeEntryUrl"],
        "decisionReason": reasons[action],
        "nextSteps": next_steps[action],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--login-state", required=True, choices=("authenticated", "unauthenticated", "unknown"))
    parser.add_argument("--prompt-pack-status", required=True, choices=("ready", "missing"))
    parser.add_argument("--contract", type=Path)
    parser.add_argument("--write", action="store_true", help="write the route decision back to --contract")
    args = parser.parse_args()
    try:
        result = decide(args.login_state, args.prompt_pack_status)
        if args.write:
            if args.contract is None:
                parser.error("--write requires --contract")
            contract = load_json(args.contract)
            contract["route"] = {
                key: value for key, value in result.items() if key != "nextSteps"
            }
            contract["route"]["observedAt"] = datetime.now(timezone.utc).isoformat()
            args.contract.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
