import type { GitObjectType } from "@/worker/git/core";

import { typeCodeToObjectType } from "@/worker/git/object-store/support";

/**
 * Partial-clone filter rules (protocol v2 `filter` capability). A fetch request
 * carries one `filter <spec>` line; `combine:` specs flatten into independent
 * rules. Git combine semantics: an object is omitted only when EVERY rule
 * omits it, so inclusion ORs the rules.
 */
export type FilterRule =
  | { kind: "blob-none" }
  | { kind: "tree-depth"; depth: number }
  | { kind: "blob-limit"; bytes: number }
  | { kind: "object-type"; type: GitObjectType };

export type ParsedFilter = {
  rules: FilterRule[];
  /** Specs we could not honor — they degrade to an unfiltered (superset) pack. */
  unsupported: string[];
  /** Any rule needs tree-depth bookkeeping during the closure walk. */
  trackDepth: boolean;
  /**
   * When any `object:type` rule is present, an omitted node may still have
   * children of the wanted type — traversal must never prune early.
   */
  traverseExcluded: boolean;
};

const SIZE_SUFFIX: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

function parseLeaf(spec: string): FilterRule | undefined {
  if (spec === "blob:none") return { kind: "blob-none" };
  if (spec.startsWith("tree:")) {
    const depth = Number(spec.slice(5));
    if (Number.isSafeInteger(depth) && depth >= 0) return { kind: "tree-depth", depth };
    return undefined;
  }
  if (spec.startsWith("blob:limit=")) {
    const raw = spec.slice("blob:limit=".length);
    const suffix = raw.slice(-1).toLowerCase();
    const multiplier = SIZE_SUFFIX[suffix] ?? 1;
    const digits = multiplier === 1 ? raw : raw.slice(0, -1);
    const bytes = Number(digits) * multiplier;
    if (Number.isSafeInteger(bytes) && bytes >= 0) return { kind: "blob-limit", bytes };
    return undefined;
  }
  if (spec.startsWith("object:type=")) {
    const type = spec.slice("object:type=".length);
    if (type === "commit" || type === "tree" || type === "blob" || type === "tag") {
      return { kind: "object-type", type };
    }
    return undefined;
  }
  return undefined;
}

/**
 * Parses a `filter <spec>` argument. Returns undefined when the whole spec is
 * unusable — the caller then serves an unfiltered pack (a superset the client
 * can still consume). `sparse:oid` is recognized-but-unsupported: resolving
 * sparse checkout paths needs blob reads the ref index does not carry.
 */
export function parseFilterSpec(raw: string): ParsedFilter | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const specs: string[] = [trimmed];
  const unsupported: string[] = [];
  // combine:<f>+<f>+... flattens into leaf specs; bound the expansion so a
  // pathological spec cannot loop forever.
  let visited = 0;
  for (let i = 0; i < specs.length && visited < 32; i++) {
    visited++;
    const spec = specs[i]!;
    if (!spec.startsWith("combine:")) continue;
    specs.splice(i, 1, ...spec.slice("combine:".length).split("+"));
    i--;
  }
  if (specs.some((s) => s.startsWith("combine:"))) return undefined;

  const rules: FilterRule[] = [];
  for (const spec of specs) {
    const rule = parseLeaf(spec);
    if (rule) rules.push(rule);
    else unsupported.push(spec);
  }
  if (rules.length === 0) return undefined;

  return {
    rules,
    unsupported,
    trackDepth: rules.some((r) => r.kind === "tree-depth"),
    traverseExcluded: rules.some((r) => r.kind === "object-type"),
  };
}

/**
 * Whether a single rule keeps an object. `depth` is the tree-depth from the
 * nearest commit root (0 for commit-direct trees, +1 per tree/blob hop);
 * `storedSize` is the pack entry byte span used as the `blob:limit` proxy —
 * it under-estimates inflated size for deltified blobs, so under-exclusion
 * stays on the superset (safe) side.
 */
export function ruleIncludes(
  rule: FilterRule,
  objectType: GitObjectType,
  storedSize: number,
  depth: number
): boolean {
  switch (rule.kind) {
    case "blob-none":
      return objectType !== "blob";
    case "blob-limit":
      return objectType !== "blob" || storedSize <= rule.bytes;
    case "tree-depth":
      return objectType === "commit" || objectType === "tag" || depth <= rule.depth;
    case "object-type":
      return objectType === rule.type;
  }
}

/** Combine semantics: an object survives iff at least one rule keeps it. */
export function filterIncludes(
  filter: ParsedFilter,
  typeCode: number | undefined,
  storedSize: number,
  depth: number
): boolean {
  const objectType = typeCode === undefined ? undefined : typeCodeToObjectType(typeCode);
  if (!objectType) return true;
  return filter.rules.some((rule) => ruleIncludes(rule, objectType, storedSize, depth));
}
