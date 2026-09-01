import path from "node:path";

export function portableRelativePath(ownerFile, destinationFile, candidate) {
  if (typeof candidate !== "string" || !candidate || path.isAbsolute(candidate) || /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    return candidate;
  }
  const absolute = path.resolve(path.dirname(ownerFile), candidate);
  const relative = path.relative(path.dirname(destinationFile), absolute).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

export function rebaseTimelineInputs(value, ownerFile, destinationFile, ancestry = []) {
  if (Array.isArray(value)) return value.map((entry) => rebaseTimelineInputs(entry, ownerFile, destinationFile, ancestry));
  if (!value || typeof value !== "object") return value;
  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    if (ancestry.length === 0 && key === "output") {
      copy[key] = structuredClone(child);
      continue;
    }
    const pathLikeKey = key === "path" || key === "fontsDirectory" || /Path$/.test(key)
      || (key === "evidence" && typeof child === "string" && (child.startsWith(".") || path.isAbsolute(child)));
    copy[key] = pathLikeKey && typeof child === "string"
      ? portableRelativePath(ownerFile, destinationFile, child)
      : rebaseTimelineInputs(child, ownerFile, destinationFile, [...ancestry, key]);
  }
  if (ancestry.length === 0 && typeof copy.source === "string") {
    copy.source = portableRelativePath(ownerFile, destinationFile, copy.source);
  }
  return copy;
}
