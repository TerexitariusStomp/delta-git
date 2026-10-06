import type { PackRefSnapshotEntry } from "@/worker/git/pack/refIndex";

import { bytesToHex, hexToBytes, isValidOid } from "@/worker/common";
import { findOidIndexFromBytes } from "@/worker/git/object-store";
import {
  getPackRefRawRefAt,
  getPackRefTypeCode,
  visitPackRefRawRefsAt,
} from "@/worker/git/pack/refIndex";

const OID_BYTES = 20;
const COMMIT_TYPE_CODE = 1;
const TAG_TYPE_CODE = 4;
/** Commit-graph edges the shallow pre-pass may walk before degrading to an unshallowed (superset) fetch. */
const SHALLOW_WALK_EDGE_BUDGET = 200_000;

export type ShallowRequest = {
  /** `deepen <n>` — include commits within n edges of a want tip. */
  deepen?: number;
  /** Resolved `deepen-not` tips (hex oids — name resolution happens in plan.ts). */
  deepenNotBaseOids: string[];
};

export type ShallowCut = {
  /** Commits sent in the pack whose parent edges are severed client-side. */
  severedCommits: Set<string>;
  /** Commits excluded entirely (`deepen-not` unreachable region). */
  excludedOids: Set<string>;
  /**
   * Pre-pass blew its walk budget — the caller should drop the cut and serve
   * an unshallowed fetch rather than emit a partial boundary.
   */
  overflow: boolean;
};

type Located = { packSlot: number; oidIndex: number };

function locate(packs: PackRefSnapshotEntry[], oid: string): Located | undefined {
  const raw = hexToBytes(oid);
  for (let packSlot = 0; packSlot < packs.length; packSlot++) {
    const oidIndex = findOidIndexFromBytes(packs[packSlot]!.idx, raw, 0);
    if (oidIndex >= 0) return { packSlot, oidIndex };
  }
  return undefined;
}

function typeCodeAt(packs: PackRefSnapshotEntry[], at: Located): number | undefined {
  return getPackRefTypeCode(packs[at.packSlot]!.refs, at.oidIndex);
}

/** refs[0] is the tree; parents follow for commits. */
function forEachParent(
  packs: PackRefSnapshotEntry[],
  at: Located,
  visit: (rawOid: Uint8Array, start: number) => void
): void {
  let index = 0;
  visitPackRefRawRefsAt(packs[at.packSlot]!.refs, at.oidIndex, (rawRefs, start) => {
    if (index++ === 0) return;
    visit(rawRefs, start);
  });
}

/** Follows tag->object edges until a commit (bounded hop count). */
function peelToCommit(
  packs: PackRefSnapshotEntry[],
  oid: string
): { oid: string; at: Located } | undefined {
  let current = oid;
  for (let hops = 0; hops < 8; hops++) {
    const at = locate(packs, current);
    if (!at) return undefined;
    const code = typeCodeAt(packs, at);
    if (code === COMMIT_TYPE_CODE) return { oid: current, at };
    if (code !== TAG_TYPE_CODE) return undefined;
    const target = getPackRefRawRefAt(packs[at.packSlot]!.refs, at.oidIndex, 0);
    if (!target) return undefined;
    current = bytesToHex(target);
  }
  return undefined;
}

/**
 * Computes the shallow boundary over the pack ref index — purely in-memory,
 * no object reads. Commits exactly `deepen` edges from a want tip, or included
 * commits whose parents fall in the `deepen-not` unreachable region, are
 * returned in `severedCommits`: the closure sends them but must not traverse
 * their parent edges, and they become `shallow` lines in shallow-info.
 */
export function computeShallowCut(
  packs: PackRefSnapshotEntry[],
  wants: string[],
  request: ShallowRequest
): ShallowCut {
  const severedCommits = new Set<string>();
  const excludedOids = new Set<string>();
  let edgeBudget = SHALLOW_WALK_EDGE_BUDGET;

  // deepen-not: mark every commit ancestor of each base tip as unreachable.
  if (request.deepenNotBaseOids.length > 0) {
    const queue: Located[] = [];
    for (const base of request.deepenNotBaseOids) {
      const peeled = peelToCommit(packs, base);
      if (peeled) queue.push(peeled.at);
    }
    const seen = new Set<string>();
    while (queue.length > 0) {
      if (edgeBudget <= 0) return { severedCommits, excludedOids, overflow: true };
      const at = queue.shift()!;
      const oid = bytesToHex(
        packs[at.packSlot]!.idx.rawNames.subarray(
          at.oidIndex * OID_BYTES,
          (at.oidIndex + 1) * OID_BYTES
        )
      );
      if (seen.has(oid)) continue;
      seen.add(oid);
      excludedOids.add(oid);
      forEachParent(packs, at, (rawRefs, start) => {
        edgeBudget--;
        const parentOid = bytesToHex(rawRefs.subarray(start, start + OID_BYTES));
        if (seen.has(parentOid)) return;
        const parentAt = locate(packs, parentOid);
        if (parentAt) queue.push(parentAt);
      });
    }
  }

  // Walk the commit graph outward from the wants. FIFO keeps depths
  // nondecreasing, so first reach is the minimum depth for `deepen`.
  const seeds: { oid: string; at: Located }[] = [];
  for (const want of wants) {
    const normalized = want.toLowerCase();
    if (!isValidOid(normalized)) continue;
    const peeled = peelToCommit(packs, normalized);
    if (peeled) seeds.push(peeled);
  }

  const visited = new Set<string>();
  const queue: { oid: string; at: Located; depth: number }[] = seeds.map((s) => ({
    ...s,
    depth: 0,
  }));
  let cursor = 0;
  while (cursor < queue.length) {
    if (edgeBudget <= 0) return { severedCommits, excludedOids, overflow: true };
    const { oid, at, depth } = queue[cursor++];
    if (visited.has(oid)) continue;
    visited.add(oid);
    if (excludedOids.has(oid)) continue;

    const severedByDepth = request.deepen !== undefined && depth === request.deepen - 1;
    if (!severedByDepth) {
      let touchesExcluded = false;
      const parents: { oid: string; at: Located }[] = [];
      forEachParent(packs, at, (rawRefs, start) => {
        edgeBudget--;
        const parentOid = bytesToHex(rawRefs.subarray(start, start + OID_BYTES));
        if (excludedOids.has(parentOid)) {
          touchesExcluded = true;
          return;
        }
        if (visited.has(parentOid)) return;
        const parentAt = locate(packs, parentOid);
        if (parentAt) parents.push({ oid: parentOid, at: parentAt });
      });
      if (touchesExcluded) {
        // Boundary commit against the excluded region: git severs ALL its
        // parent edges, so even the reachable parents stay unenqueued.
        severedCommits.add(oid);
        continue;
      }
      for (const parent of parents) queue.push({ ...parent, depth: depth + 1 });
      continue;
    }

    // Boundary commit: it is sent, but its parent edges are severed — do not
    // enqueue parents (they belong to the excluded-by-depth region).
    severedCommits.add(oid);
  }

  return { severedCommits, excludedOids, overflow: false };
}
