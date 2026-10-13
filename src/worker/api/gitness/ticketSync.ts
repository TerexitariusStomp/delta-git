// atproto ticket sync — pulls external ticket records from a member's PDS
// into the space's ticket ledger. Tickets are published as records in an
// atproto collection (default `fyi.widespread.ticket`); sync resolves the
// actor's DID → #atproto_pds endpoint → `com.atproto.repo.listRecords` and
// upserts each record keyed by its at:// uri. Public records need no
// credentials — consistent with the platform's client-side token custody.

import type { Db } from "@/worker/db/d1";
import { insertTicket, listTickets, updateTicket } from "@/worker/db/d1/dal/modules";
import { resolvePdsEndpoint } from "@/worker/agent/atpauth/pds";
import { newPrefixedId } from "@/worker/common";

const LIST_LIMIT = 100;
const FETCH_TIMEOUT_MS = 10_000;

export interface TicketSyncResult {
  ok: boolean;
  synced: number;
  created: number;
  updated: number;
  source: string;
  error?: string;
}

interface PdsRecord {
  uri: string;
  value?: {
    title?: string;
    name?: string;
    status?: string;
    state?: string;
    url?: string;
    [k: string]: unknown;
  };
}

/**
 * Sync tickets from `at://did/collection` (or `did` + `collection` arg).
 * Upserts on the record uri so re-syncs are idempotent.
 */
export async function syncTicketsFromAtproto(
  env: Env,
  db: Db,
  namespaceId: string,
  did: string,
  collection: string
): Promise<TicketSyncResult> {
  const pds = await resolvePdsEndpoint(env, did);
  if (!pds) {
    return { ok: false, synced: 0, created: 0, updated: 0, source: did, error: "pds-unresolvable" };
  }

  const records: PdsRecord[] = [];
  let cursor: string | undefined;
  // Page the collection — bounded at 10 pages so a hostile PDS can't pin
  // the request open.
  for (let page = 0; page < 10; page++) {
    const url =
      `${pds}/xrpc/com.atproto.repo.listRecords` +
      `?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}` +
      `&limit=${LIST_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch(() => null);
    if (!res) {
      return { ok: false, synced: 0, created: 0, updated: 0, source: did, error: "pds-unreachable" };
    }
    if (!res.ok) {
      return {
        ok: false,
        synced: records.length,
        created: 0,
        updated: 0,
        source: did,
        error: `pds-http-${res.status}`,
      };
    }
    const body = (await res.json().catch(() => null)) as {
      records?: PdsRecord[];
      cursor?: string;
    } | null;
    records.push(...(body?.records ?? []));
    cursor = body?.cursor;
    if (!cursor || (body?.records?.length ?? 0) === 0) break;
  }

  const existing = await listTickets(db, namespaceId);
  const byExternalId = new Map(existing.map((t) => [t.externalId, t]));
  const now = Date.now();
  let created = 0;
  let updated = 0;
  for (const rec of records) {
    const title = rec.value?.title ?? rec.value?.name;
    if (!title || typeof title !== "string") continue;
    const status = rec.value?.status ?? rec.value?.state ?? "open";
    const url = rec.value?.url ?? rec.uri;
    const row = byExternalId.get(rec.uri);
    if (row) {
      if (row.title !== title || row.status !== status || row.url !== url) {
        await updateTicket(db, row.id, { title, status, url, updatedAt: now });
        updated++;
      }
      continue;
    }
    await insertTicket(db, {
      id: newPrefixedId("tkt"),
      namespaceId,
      repositoryId: null,
      externalId: rec.uri,
      title,
      url,
      status,
      createdAt: now,
      updatedAt: now,
    });
    created++;
  }
  return { ok: true, synced: created + updated, created, updated, source: did };
}
