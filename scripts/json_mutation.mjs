import {
  getAtPointer,
  mergeAtPointer,
  pointerParts,
  removeAtPointer,
  setAtPointer,
} from "./agent_workspace_utils.mjs";

export const SUPPORTED_MUTATION_OPERATIONS = Object.freeze([
  "add",
  "replace",
  "remove",
  "merge",
]);

function assertOperation(operation, index) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new Error(`operations[${index}] 必须是 object`);
  }
  if (!SUPPORTED_MUTATION_OPERATIONS.includes(operation.op)) {
    throw new Error(`operations[${index}].op 不支持：${operation.op}`);
  }
  if (typeof operation.path !== "string") {
    throw new Error(`operations[${index}].path 缺失`);
  }
  if (!operation.path.startsWith("/") && operation.path !== "") {
    throw new Error(`operations[${index}].path 必须是 JSON Pointer`);
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function pointerState(root, pointer) {
  const parts = pointerParts(pointer);
  if (parts.length === 0) return { exists: true, parent: null, leaf: null };
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, part)) {
      return { exists: false, parent: null, leaf: parts.at(-1) };
    }
    parent = parent[part];
  }
  const leaf = parts.at(-1);
  if (Array.isArray(parent)) {
    if (leaf === "-") return { exists: false, parent, leaf };
    const index = Number(leaf);
    return {
      exists: Number.isInteger(index) && index >= 0 && index < parent.length,
      parent,
      leaf,
    };
  }
  return {
    exists: parent !== null && typeof parent === "object" && Object.hasOwn(parent, leaf),
    parent,
    leaf,
  };
}

function arrayAppendPointer(pointer, length) {
  return `${pointer.slice(0, pointer.lastIndexOf("/") + 1)}${length}`;
}

export function applyJsonOperations(root, operations, { captureInverse = false } = {}) {
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 200) {
    throw new Error("operations 必须包含 1–200 个操作");
  }
  let next = structuredClone(root);
  const inverse = [];
  for (const [index, operation] of operations.entries()) {
    assertOperation(operation, index);
    const state = pointerState(next, operation.path);
    const previous = clone(getAtPointer(next, operation.path));
    if (operation.op === "add") {
      const inversePath = Array.isArray(state.parent) && state.leaf === "-"
        ? arrayAppendPointer(operation.path, state.parent.length)
        : operation.path;
      next = setAtPointer(next, operation.path, operation.value, { add: true });
      inverse.unshift(
        Array.isArray(state.parent) || !state.exists
          ? { op: "remove", path: inversePath }
          : { op: "replace", path: operation.path, value: previous },
      );
    } else if (operation.op === "replace") {
      next = setAtPointer(next, operation.path, operation.value);
      inverse.unshift({ op: "replace", path: operation.path, value: previous });
    } else if (operation.op === "remove") {
      next = removeAtPointer(next, operation.path);
      inverse.unshift({ op: "add", path: operation.path, value: previous });
    } else {
      next = mergeAtPointer(next, operation.path, operation.value);
      inverse.unshift({ op: "replace", path: operation.path, value: previous });
    }
  }
  return captureInverse ? { value: next, inverseOperations: inverse } : next;
}

export function collectJsonDiff(before, after, pointer = "", changes = []) {
  if (Object.is(before, after)) return changes;
  const beforeObject = before !== null && typeof before === "object";
  const afterObject = after !== null && typeof after === "object";
  if (!beforeObject || !afterObject || Array.isArray(before) !== Array.isArray(after)) {
    changes.push({ op: "replace", pointer, before, after });
    return changes;
  }
  if (Array.isArray(before)) {
    const beforeIds = before.map((item) => item?.id);
    const afterIds = after.map((item) => item?.id);
    const idAware = [...beforeIds, ...afterIds].every(
      (id) => typeof id === "string" && id.trim() !== "",
    ) && new Set(beforeIds).size === beforeIds.length
      && new Set(afterIds).size === afterIds.length;
    if (idAware) {
      const beforeById = new Map(beforeIds.map((id, index) => [id, index]));
      const afterById = new Map(afterIds.map((id, index) => [id, index]));
      for (const [id, index] of [...beforeById.entries()].reverse()) {
        if (!afterById.has(id)) changes.push({ op: "remove", pointer: `${pointer}/${index}`, before: before[index] });
      }
      for (const [id, index] of afterById.entries()) {
        if (!beforeById.has(id)) {
          changes.push({ op: "add", pointer: `${pointer}/${index}`, after: after[index] });
          continue;
        }
        const beforeIndex = beforeById.get(id);
        if (beforeIndex !== index) {
          changes.push({
            op: "move",
            pointer: `${pointer}/${index}`,
            fromPointer: `${pointer}/${beforeIndex}`,
            before: before[beforeIndex],
            after: after[index],
          });
        }
        collectJsonDiff(before[beforeIndex], after[index], `${pointer}/${index}`, changes);
      }
      return changes;
    }
    const maximum = Math.max(before.length, after.length);
    for (let index = 0; index < maximum; index += 1) {
      const child = `${pointer}/${index}`;
      if (index >= before.length) changes.push({ op: "add", pointer: child, after: after[index] });
      else if (index >= after.length) changes.push({ op: "remove", pointer: child, before: before[index] });
      else collectJsonDiff(before[index], after[index], child, changes);
    }
    return changes;
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    const escaped = key.replace(/~/g, "~0").replace(/\//g, "~1");
    const child = `${pointer}/${escaped}`;
    if (!Object.hasOwn(before, key)) changes.push({ op: "add", pointer: child, after: after[key] });
    else if (!Object.hasOwn(after, key)) changes.push({ op: "remove", pointer: child, before: before[key] });
    else collectJsonDiff(before[key], after[key], child, changes);
  }
  return changes;
}
