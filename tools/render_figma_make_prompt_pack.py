#!/usr/bin/env python3
"""Render a deterministic, complete Figma Make Prompt Pack from its contract."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from figma_make_contract import project_path, sha256_file, validate_prompt_semantics


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("contract must be a JSON object")
    return value


def nonempty_list(value: object, label: str) -> list:
    if not isinstance(value, list) or not value:
        raise ValueError(f"{label} must be a non-empty list")
    return value


def bullet(items: list[str]) -> list[str]:
    return [f"- {item}" for item in items]


def render(contract: dict) -> str:
    product = contract.get("product", {})
    product_contracts = contract.get("productContracts", {})
    design = contract.get("design", {})
    pages = nonempty_list(contract.get("pages"), "pages")
    journeys = nonempty_list(contract.get("journeys"), "journeys")
    for field in ("name", "summary"):
        if not product.get(field):
            raise ValueError(f"product.{field} is required")
    target_users = nonempty_list(product.get("targetUsers"), "product.targetUsers")
    platforms = nonempty_list(product.get("platforms"), "product.platforms")
    for field in ("direction",):
        if not design.get(field):
            raise ValueError(f"design.{field} is required")
    for field in ("tokens", "responsiveModes", "accessibilityRequirements", "contentConstraints", "nonGoals"):
        nonempty_list(design.get(field), f"design.{field}")
    for field in ("businessRules", "dataAndApi", "rolesAndPermissions", "failureBoundaries"):
        nonempty_list(product_contracts.get(field), f"productContracts.{field}")
    prompt = contract.get("promptPack", {})
    source_refs = nonempty_list(prompt.get("sourceRefs"), "promptPack.sourceRefs")
    source_documents = nonempty_list(prompt.get("sourceDocuments"), "promptPack.sourceDocuments")
    if [item.get("path") for item in source_documents if isinstance(item, dict)] != source_refs:
        raise ValueError("promptPack.sourceDocuments must exactly cover sourceRefs in order")
    semantic_errors = validate_prompt_semantics(contract)
    if semantic_errors:
        raise ValueError(semantic_errors[0])

    lines = [
        f"# Figma Make Prompt Pack — {product['name']}",
        "",
        "## 任务",
        "",
        "请生成一个完整、可运行、可逐页浏览的产品原型。它将作为产品 UI 设计稿和交互基准，不是静态图片；不要省略页面、状态、跳转、失败反馈或真实内容。",
        "",
        "## 产品与用户",
        "",
        f"产品：{product['name']}",
        f"目标：{product['summary']}",
        "目标用户：",
        *bullet([str(item) for item in target_users]),
        "目标平台：",
        *bullet([str(item) for item in platforms]),
        "",
        "## 产品事实源",
        "",
        *bullet([f"`{item['path']}`（{item['sha256']}）" for item in source_documents]),
        "",
        "## 业务、数据与失败边界",
        "",
        "业务规则：",
        *bullet([str(item) for item in product_contracts["businessRules"]]),
        "数据与 API：",
        *bullet([str(item) for item in product_contracts["dataAndApi"]]),
        "角色与权限：",
        *bullet([str(item) for item in product_contracts["rolesAndPermissions"]]),
        "失败与恢复边界：",
        *bullet([str(item) for item in product_contracts["failureBoundaries"]]),
        "",
        "## 设计方向",
        "",
        str(design["direction"]),
        "",
        "设计 Token / 视觉约束：",
        *bullet([str(item) for item in design["tokens"]]),
        "响应式模式：",
        *bullet([str(item) for item in design["responsiveModes"]]),
        "可访问性要求：",
        *bullet([str(item) for item in design["accessibilityRequirements"]]),
        "内容要求：",
        *bullet([str(item) for item in design["contentConstraints"]]),
        "明确不做：",
        *bullet([str(item) for item in design["nonGoals"]]),
        "",
        "## 页面、状态与交互",
    ]
    page_ids: set[str] = set()
    for page in pages:
        for field in ("id", "name", "route", "purpose"):
            if not page.get(field):
                raise ValueError(f"page.{field} is required")
        if page["id"] in page_ids:
            raise ValueError(f"duplicate page id: {page['id']}")
        page_ids.add(page["id"])
        states = nonempty_list(page.get("states"), f"page {page['id']} states")
        interactions = nonempty_list(page.get("interactions"), f"page {page['id']} interactions")
        acceptance = nonempty_list(page.get("acceptance"), f"page {page['id']} acceptance")
        lines += ["", f"### {page['name']} (`{page['route']}`, id: `{page['id']}`)", "", str(page["purpose"]), "", "状态："]
        for state in states:
            if not state.get("id") or not state.get("description"):
                raise ValueError(f"page {page['id']} state requires id and description")
            lines.append(f"- `{state['id']}`：{state['description']}")
        lines.append("交互：")
        for interaction in interactions:
            if not interaction.get("id") or not interaction.get("trigger") or not interaction.get("result"):
                raise ValueError(f"page {page['id']} interaction requires id, trigger and result")
            target = f"；目标页 `{interaction['targetPageId']}`" if interaction.get("targetPageId") else ""
            lines.append(f"- `{interaction['id']}`：{interaction['trigger']} → {interaction['result']}{target}")
        lines += ["验收：", *bullet([str(item) for item in acceptance])]

    lines += ["", "## 完整用户旅程"]
    journey_ids: set[str] = set()
    for journey in journeys:
        if not journey.get("id") or not journey.get("name"):
            raise ValueError("journey requires id and name")
        if journey["id"] in journey_ids:
            raise ValueError(f"duplicate journey id: {journey['id']}")
        journey_ids.add(journey["id"])
        steps = nonempty_list(journey.get("steps"), f"journey {journey['id']} steps")
        acceptance = nonempty_list(journey.get("acceptance"), f"journey {journey['id']} acceptance")
        lines += ["", f"### {journey['name']} (`{journey['id']}`)"]
        for index, step in enumerate(steps, 1):
            if step.get("pageId") not in page_ids:
                raise ValueError(f"journey {journey['id']} references unknown page {step.get('pageId')}")
            if not step.get("action") or not step.get("expected"):
                raise ValueError(f"journey {journey['id']} step requires action and expected")
            lines.append(
                f"{index}. `{step['pageId']}` 经交互 `{step['interactionId']}`："
                f"{step['action']}；预期：{step['expected']}"
            )
        lines += ["验收：", *bullet([str(item) for item in acceptance])]

    lines += [
        "",
        "## Make 输出要求",
        "",
        "- 交付所有页面和明确列出的状态，不使用占位按钮、空链接、Lorem ipsum 或只做第一屏。",
        "- 页面之间的导航、返回、取消、提交、错误恢复和完整旅程必须可实际操作。",
        "- 使用一致的 Token 和可复用组件，覆盖键盘焦点、语义标签、对比度和减弱动效偏好。",
        "- 使用接近真实长度和边界的数据，呈现 loading、empty、error、success 及业务特有状态。",
        "- 代码必须能本地安装、启动和构建，并保留 package manifest 与 lockfile。",
        "- 完成后提供可运行预览；AppCreate 会另行冻结代码并逐页验证，不能把生成成功当成验收通过。",
        "",
    ]
    return "\n".join(lines)


def digest_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def bind_source_documents(contract: dict, root: Path) -> None:
    prompt = contract.setdefault("promptPack", {})
    source_refs = nonempty_list(prompt.get("sourceRefs"), "promptPack.sourceRefs")
    documents: list[dict] = []
    for reference in source_refs:
        path = project_path(root, reference)
        if path is None or not path.is_file():
            raise ValueError(f"Prompt source must be a project file: {reference}")
        documents.append({"path": reference, "sha256": sha256_file(path)})
    prompt["sourceDocuments"] = documents


def mark_prompt_ready(contract: dict) -> None:
    route = contract.setdefault("route", {})
    login_state = route.get("loginState", "unknown")
    route["promptPackStatus"] = "ready"
    if login_state == "authenticated":
        route["action"] = "browser_automation"
        route["decisionReason"] = "Figma is authenticated and the complete Prompt Pack is ready."
    else:
        route["action"] = "prompt_pack_handoff"
        route["decisionReason"] = "Figma authentication is unavailable or unverified; provide the complete Prompt Pack for manual launch."


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("contract", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--write", action="store_true", help="write output and update contract metadata")
    args = parser.parse_args()
    try:
        contract = load(args.contract)
        root = args.contract.resolve().parent.parent if args.contract.resolve().parent.name == "quality" else args.contract.resolve().parent
        bind_source_documents(contract, root)
        content = render(contract)
        if args.write:
            output = args.output.resolve()
            if not output.is_relative_to(root):
                parser.error("output must stay inside the project root")
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(content, encoding="utf-8")
            contract["promptPack"].update({
                "outputPath": output.relative_to(root).as_posix(),
                "digest": digest_text(content),
                "generatedAt": datetime.now(timezone.utc).isoformat(),
            })
            mark_prompt_ready(contract)
            args.contract.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        else:
            print(content, end="")
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
