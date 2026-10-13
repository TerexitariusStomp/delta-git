import type { MergeIntentRow } from "../db/schema";
import type { ReceiveCommand, ReceiveStatus } from "@/worker/git/operations/validation";

// Divergent-push acceptance ("never reject").
//
// A push that fails CAS validation purely because the client based its work
// on an older head ("stale old-oid" / "expected zero old-oid") is not
// rejected: the ref update is rewritten to `refs/delta/<branch>-<oid8>` and
// a merge intent is minted. The pushed objects are already staged in R2 by
// the worker pipeline, so the whole operation completes inside this same
// receive lease — atomically, without a second upload.

const ZERO_OID = "0".repeat(40);

/** Ref namespaces that may be rewritten to a delta ref when they diverge. */
const DIVERGEABLE_PREFIX = "refs/heads/";
/** Refs under this prefix are machine-managed; never re-diverge them. */
const DELTA_PREFIX = "refs/delta/";

export const MERGE_INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_OPEN_INTENTS_PER_REF = 64;

export type DivergencePlan = {
  kind: "plan";
  /** Commands rewritten to delta refs, plus the ones that validated as-is. */
  commands: ReceiveCommand[];
  /** Statuses the client should see for its original ref names. */
  statuses: ReceiveStatus[];
  intents: MergeIntentRow[];
};

/** No divergence plan possible — report the original conflict. */
export type DivergenceRejected = { kind: "rejected" };

export type DivergenceOutcome = DivergencePlan | DivergenceRejected;

function isZeroOid(oid: string): boolean {
  return /^0{40}$/i.test(oid);
}

function slugForRef(ref: string): string {
  return ref
    .slice(DIVERGEABLE_PREFIX.length)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 48);
}

export function deltaRefFor(targetRef: string, newOid: string): string {
  return `${DELTA_PREFIX}${slugForRef(targetRef)}-${newOid.slice(0, 12)}`;
}

export function mergeIntentIdFor(targetRef: string, deltaOid: string): string {
  return `mi-${slugForRef(targetRef)}-${deltaOid.slice(0, 12)}`;
}

/**
 * Preflight predicate shared by the worker's receive entrypoint: true when
 * every failed validation is a CAS-style base mismatch on a divergeable
 * heads ref. Such pushes proceed into the pipeline so the pack stages and
 * `finalizeReceive` performs the atomic delta rewrite; pushes containing
 * any other failure still short-circuit as conflicts.
 */
export function canDivergeStatuses(commands: ReceiveCommand[], statuses: ReceiveStatus[]): boolean {
  let sawFailure = false;
  for (let i = 0; i < commands.length; i++) {
    const status = statuses[i];
    if (status.ok) continue;
    sawFailure = true;
    const command = commands[i];
    const divergeable =
      (status.msg === "stale old-oid" || status.msg === "expected zero old-oid") &&
      !isZeroOid(command.newOid) &&
      command.ref.startsWith(DIVERGEABLE_PREFIX) &&
      !command.ref.startsWith(DELTA_PREFIX);
    if (!divergeable) return false;
  }
  return sawFailure;
}

/**
 * Decide whether a set of failed ref validations can be salvaged as a
 * divergent push. Returns a rewrite plan when every failure is a CAS-style
 * base mismatch on a non-delete heads ref; `rejected` when any failure has a
 * different cause (mixed pushes still commit their valid refs normally).
 */
export function planDivergence(args: {
  currentRefs: Array<{ name: string; oid: string }>;
  commands: ReceiveCommand[];
  statuses: ReceiveStatus[];
  actor: string;
  now: number;
  /** Open intent counts keyed by target ref — flood guard per ref. */
  openIntentCounts: Map<string, number>;
}): DivergenceOutcome {
  const currentByName = new Map(args.currentRefs.map((r) => [r.name, r.oid] as const));
  const rewritten: ReceiveCommand[] = [];
  const outStatuses: ReceiveStatus[] = [];
  const intents: MergeIntentRow[] = [];
  let diverged = 0;

  for (let i = 0; i < args.commands.length; i++) {
    const command = args.commands[i];
    const status = args.statuses[i];

    if (status.ok) {
      rewritten.push(command);
      outStatuses.push(status);
      continue;
    }

    const divergeable =
      (status.msg === "stale old-oid" || status.msg === "expected zero old-oid") &&
      !isZeroOid(command.newOid) &&
      command.ref.startsWith(DIVERGEABLE_PREFIX) &&
      !command.ref.startsWith(DELTA_PREFIX);

    if (!divergeable) return { kind: "rejected" };
    const openForRef = args.openIntentCounts.get(command.ref) ?? 0;
    if (openForRef >= MAX_OPEN_INTENTS_PER_REF) {
      return { kind: "rejected" };
    }
    args.openIntentCounts.set(command.ref, openForRef + 1);

    const deltaRef = deltaRefFor(command.ref, command.newOid);
    const existing = currentByName.get(deltaRef);
    const intentId = mergeIntentIdFor(command.ref, command.newOid);

    if (existing !== undefined) {
      if (existing.toLowerCase() === command.newOid.toLowerCase()) {
        // Idempotent replay of an already-accepted delta push.
        outStatuses.push({ ref: command.ref, ok: true, msg: `delta ${intentId}` });
        continue;
      }
      return { kind: "rejected" };
    }

    rewritten.push({ ref: deltaRef, oldOid: ZERO_OID, newOid: command.newOid });
    outStatuses.push({ ref: command.ref, ok: true, msg: `delta ${intentId}` });
    intents.push({
      id: intentId,
      targetRef: command.ref,
      baseOid: currentByName.get(command.ref) ?? ZERO_OID,
      deltaRef,
      deltaOid: command.newOid,
      actor: args.actor,
      status: "open",
      conflicts: null,
      resultOid: null,
      createdAt: args.now,
      expiresAt: args.now + MERGE_INTENT_TTL_MS,
      resolvedAt: null,
    });
    diverged += 1;
  }

  if (diverged === 0) return { kind: "rejected" };
  return { kind: "plan", commands: rewritten, statuses: outStatuses, intents };
}

// ---------------------------------------------------------------------------
// Quarantine — delivery-gate (freeze window / enforce policy) denials.
//
// A gated push must not be rejected: the "never reject a push" contract means
// the objects land and a merge intent holds them until the gate closes. Every
// non-delete `refs/heads/` command rewrites to a delta ref exactly like a
// divergent push; deletes and non-heads refs can't be held, so they get a
// truthful deny status — the push is only *fully* refused when nothing was
// quarantinable.
// ---------------------------------------------------------------------------

export type QuarantinePlan = {
  kind: "quarantined";
  /** Rewritten delta-ref commands to apply. */
  commands: ReceiveCommand[];
  /** Per-original-command statuses the client sees. */
  statuses: ReceiveStatus[];
  intents: MergeIntentRow[];
};

/** Nothing quarantinable — every command was a delete or non-heads ref. */
export type QuarantineRejected = { kind: "rejected"; statuses: ReceiveStatus[] };

export type QuarantineOutcome = QuarantinePlan | QuarantineRejected;

export function planQuarantine(args: {
  currentRefs: Array<{ name: string; oid: string }>;
  commands: ReceiveCommand[];
  actor: string;
  now: number;
  /** Open intent counts keyed by target ref — flood guard per ref. */
  openIntentCounts: Map<string, number>;
  /** The gate's deny message, surfaced to the client per held ref. */
  reason: string;
}): QuarantineOutcome {
  const currentByName = new Map(args.currentRefs.map((r) => [r.name, r.oid] as const));
  const rewritten: ReceiveCommand[] = [];
  const outStatuses: ReceiveStatus[] = [];
  const intents: MergeIntentRow[] = [];
  let held = 0;

  for (const command of args.commands) {
    const holdable =
      !isZeroOid(command.newOid) &&
      command.ref.startsWith(DIVERGEABLE_PREFIX) &&
      !command.ref.startsWith(DELTA_PREFIX);
    if (!holdable) {
      outStatuses.push({ ref: command.ref, ok: false, msg: args.reason });
      continue;
    }
    const openForRef = args.openIntentCounts.get(command.ref) ?? 0;
    if (openForRef >= MAX_OPEN_INTENTS_PER_REF) {
      outStatuses.push({ ref: command.ref, ok: false, msg: "too many open merge intents" });
      continue;
    }
    args.openIntentCounts.set(command.ref, openForRef + 1);

    const deltaRef = deltaRefFor(command.ref, command.newOid);
    const intentId = mergeIntentIdFor(command.ref, command.newOid);
    const existing = currentByName.get(deltaRef);
    if (existing !== undefined) {
      if (existing.toLowerCase() === command.newOid.toLowerCase()) {
        // Idempotent replay of an already-quarantined push.
        outStatuses.push({ ref: command.ref, ok: true, msg: `quarantined ${intentId}` });
        continue;
      }
      outStatuses.push({ ref: command.ref, ok: false, msg: "delta ref collision" });
      continue;
    }

    rewritten.push({ ref: deltaRef, oldOid: ZERO_OID, newOid: command.newOid });
    outStatuses.push({ ref: command.ref, ok: true, msg: `quarantined ${intentId}` });
    intents.push({
      id: intentId,
      targetRef: command.ref,
      baseOid: currentByName.get(command.ref) ?? ZERO_OID,
      deltaRef,
      deltaOid: command.newOid,
      actor: args.actor,
      status: "open",
      conflicts: null,
      resultOid: null,
      createdAt: args.now,
      expiresAt: args.now + MERGE_INTENT_TTL_MS,
      resolvedAt: null,
    });
    held += 1;
  }

  if (held === 0) return { kind: "rejected", statuses: outStatuses };
  return { kind: "quarantined", commands: rewritten, statuses: outStatuses, intents };
}
