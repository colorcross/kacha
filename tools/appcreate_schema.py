"""Dependency-free validator for the JSON Schema subset used by AppCreate."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any


class SchemaError(ValueError):
    pass


TYPE_MAP = {
    "object": dict,
    "array": list,
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "null": type(None),
}


def _validate(value: Any, schema: dict[str, Any], path: str, errors: list[str]) -> None:
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: expected const {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: value is not in enum")
    expected = schema.get("type")
    if expected:
        allowed = expected if isinstance(expected, list) else [expected]
        if not any(isinstance(value, TYPE_MAP[item]) and not (item in {"integer", "number"} and isinstance(value, bool)) for item in allowed):
            errors.append(f"{path}: expected type {'|'.join(allowed)}")
            return
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: value is below minimum {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: value is above maximum {schema['maximum']}")
    if isinstance(value, dict):
        required = schema.get("required", [])
        for key in required:
            if key not in value:
                errors.append(f"{path}.{key}: required property missing")
        properties = schema.get("properties", {})
        for key, child in value.items():
            if key in properties:
                _validate(child, properties[key], f"{path}.{key}", errors)
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}.{key}: additional property not allowed")
    elif isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{path}: expected at least {schema['minItems']} items")
        if schema.get("uniqueItems") and len({json.dumps(item, sort_keys=True) for item in value}) != len(value):
            errors.append(f"{path}: items must be unique")
        item_schema = schema.get("items")
        if item_schema:
            for index, item in enumerate(value):
                _validate(item, item_schema, f"{path}[{index}]", errors)
    elif isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{path}: string is too short")
        pattern = schema.get("pattern")
        if pattern and not re.search(pattern, value):
            errors.append(f"{path}: string does not match pattern")
        if schema.get("format") == "date-time":
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                errors.append(f"{path}: string is not a valid date-time")
            else:
                if parsed.tzinfo is None:
                    errors.append(f"{path}: date-time must include a timezone")


def validate(value: Any, schema: dict[str, Any], label: str = "$") -> list[str]:
    errors: list[str] = []
    _validate(value, schema, label, errors)
    return errors


def validate_file(document: Path, schema_path: Path) -> list[str]:
    return validate(
        json.loads(document.read_text(encoding="utf-8")),
        json.loads(schema_path.read_text(encoding="utf-8")),
        document.as_posix(),
    )


def require_valid(value: Any, schema: dict[str, Any], label: str = "$") -> None:
    errors = validate(value, schema, label)
    if errors:
        raise SchemaError("\n".join(errors))
