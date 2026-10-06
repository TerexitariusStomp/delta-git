import type { CacheContext } from "@/worker/cache";
import { asBodyInit, hexToBytes, isValidOid } from "@/worker/common";
import { createLogger } from "@/worker/common/logger";
import { concatChunks, decodePktLines, flushPkt, pktLine } from "@/worker/git/core";
import {
  findOidIndexFromBytes,
  getNextOffsetByIndex,
  type IdxView,
} from "@/worker/git/object-store";
import { readPackHeaderExFromBuf, readPackRange } from "@/worker/git/pack/packMeta";
import { InflateCursor } from "@/worker/git/pack/indexer";
import { getLimiter, countSubrequest } from "@/worker/git/operations/limits";
import { loadUploadPackSnapshot } from "./fetch/plan";

/**
 * Protocol v2 `object-info` — gitprotocol-v2(5). Clients (notably partial
 * clones with `cat-file --batch-command` promisor fetches) request object
 * attributes without downloading them. Only the `size` attribute exists in
 * the wild; it reports the object's *inflated* size, which for deltified
 * entries requires decoding the delta header — the stored pack-entry size
 * is the delta's size, not the result's.
 */

const OBJECT_INFO_MAX_OIDS = 512;
/** Head bytes fetched per entry — covers any pack header plus zlib magic. */
const ENTRY_HEAD_BYTES = 128;
/** Compressed bytes fetched for delta entries; the result-size varint is at
 * the very start of the inflated stream, so a small head always suffices. */
const DELTA_HEAD_BYTES = 64 * 1024;
/** Inflated prefix retained while scanning for the two delta header varints. */
const DELTA_HEADER_CAPTURE = 64;

type ObjectInfoRequest = {
  /** Requested attributes; only `size` is understood and echoed back. */
  attrs: string[];
  oids: string[];
};

function parseObjectInfoRequest(body: Uint8Array): ObjectInfoRequest | undefined {
  const attrs: string[] = [];
  const oids: string[] = [];
  let beforeDelim = true;
  for (const item of decodePktLines(body)) {
    if (item.type === "delim") {
      beforeDelim = false;
      continue;
    }
    if (item.type !== "line") continue;
    const text = item.text.replace(/\r?\n$/, "");
    if (beforeDelim) {
      // `command=object-info` was already consumed by the dispatcher; the
      // remaining pre-delimiter lines are attribute requests.
      if (!text.startsWith("command=")) attrs.push(text);
      continue;
    }
    if (!text.startsWith("oid ")) return undefined;
    const oid = text.slice(4).trim();
    if (!isValidOid(oid)) return undefined;
    oids.push(oid);
  }
  return { attrs, oids };
}

/** Decode a pack entry's type+size varint (first byte: 3-bit type, 4-bit size). */
function decodePackEntrySize(sizeVarBytes: Uint8Array): number {
  let size = sizeVarBytes[0]! & 0x0f;
  let factor = 16;
  for (let i = 1; i < sizeVarBytes.length; i++) {
    size += (sizeVarBytes[i]! & 0x7f) * factor;
    factor *= 128;
  }
  return size;
}

/** Read a Git delta header varint (LEB128) at `pos`; returns [value, nextPos]. */
function readDeltaVarint(buf: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = buf[pos++]!;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80 && pos < buf.length && shift < 64);
  return [value, pos];
}

/**
 * Resolve the inflated object size for a located pack entry. Non-delta
 * entries carry it in the entry header; deltas require inflating the head
 * of the zlib payload to read the delta's result-size varint.
 */
async function resolveEntrySize(
  env: Env,
  cacheCtx: CacheContext | undefined,
  packKey: string,
  offset: number,
  nextOffset: number
): Promise<number | undefined> {
  const limiter = getLimiter(cacheCtx);
  const head = await readPackRange(env, packKey, offset, ENTRY_HEAD_BYTES, {
    limiter,
    countSubrequest: (n = 1) => countSubrequest(cacheCtx, n),
  });
  if (!head) return undefined;
  const header = readPackHeaderExFromBuf(head, 0);
  if (!header) return undefined;
  if (header.type !== 6 && header.type !== 7) {
    return decodePackEntrySize(header.sizeVarBytes);
  }

  // Delta entry: the stored size is the delta's own size. The result size is
  // the second varint of the inflated delta payload, so inflate only the
  // head of the zlib stream.
  const deltaBytes = await readPackRange(
    env,
    packKey,
    offset + header.headerLen,
    Math.min(nextOffset - offset - header.headerLen, DELTA_HEAD_BYTES),
    { limiter, countSubrequest: (n = 1) => countSubrequest(cacheCtx, n) }
  );
  if (!deltaBytes) return undefined;

  const cursor = new InflateCursor();
  cursor.reset({ captureLimit: DELTA_HEADER_CAPTURE });
  try {
    cursor.push(deltaBytes);
  } catch {
    return undefined;
  }
  const inflated = cursor.capturedOutput;
  if (inflated.byteLength < 2) return undefined;
  // Delta payload layout: base-size varint, result-size varint, instructions.
  const [, resultPos] = readDeltaVarint(inflated, 0);
  const [resultSize] = readDeltaVarint(inflated, resultPos);
  return resultSize;
}

export async function handleObjectInfoCommand(
  env: Env,
  repoId: string,
  body: Uint8Array,
  cacheCtx: CacheContext | undefined
): Promise<Response> {
  const log = createLogger(env.LOG_LEVEL, { service: "ObjectInfo", repoId });
  const parsed = parseObjectInfoRequest(body);
  if (!parsed || parsed.oids.length === 0) {
    return new Response("Malformed object-info request\n", { status: 400 });
  }
  if (parsed.oids.length > OBJECT_INFO_MAX_OIDS) {
    const chunks = [pktLine(`ERR object-info: too many oids\n`), flushPkt()];
    return new Response(asBodyInit(concatChunks(chunks)), {
      status: 200,
      headers: { "Content-Type": "application/x-git-upload-pack-result" },
    });
  }

  const snapshotLoad = await loadUploadPackSnapshot(env, repoId, cacheCtx);
  if (snapshotLoad.type === "RepositoryNotReady") {
    return new Response("Repository not ready\n", {
      status: 503,
      headers: { "Retry-After": "10" },
    });
  }
  const snapshot = snapshotLoad.snapshot;

  // Echo back the supported attributes as the header line, per spec order.
  const supported = parsed.attrs.filter((attr) => attr === "size");
  const chunks: Uint8Array[] = [pktLine(supported.join(" ") + "\n")];

  for (const oid of parsed.oids) {
    const raw = hexToBytes(oid);
    let located: { packKey: string; idx: IdxView; index: number } | undefined;
    for (const pack of snapshot.packs) {
      const index = findOidIndexFromBytes(pack.idx, raw);
      if (index >= 0) {
        located = { packKey: pack.packKey, idx: pack.idx, index };
        break;
      }
    }

    if (!located) {
      log.info("object-info:not-found", { oid });
      chunks.push(pktLine(`ERR object-info: object ${oid} not found\n`), flushPkt());
      return new Response(asBodyInit(concatChunks(chunks)), {
        status: 200,
        headers: { "Content-Type": "application/x-git-upload-pack-result" },
      });
    }

    const offset = located.idx.offsets[located.index]!;
    const nextOffset = getNextOffsetByIndex(located.idx, located.index) ?? offset;
    const size = await resolveEntrySize(env, cacheCtx, located.packKey, offset, nextOffset);
    if (size === undefined) {
      log.warn("object-info:size-unresolved", { oid, packKey: located.packKey });
      chunks.push(pktLine(`ERR object-info: object ${oid} unreadable\n`), flushPkt());
      return new Response(asBodyInit(concatChunks(chunks)), {
        status: 200,
        headers: { "Content-Type": "application/x-git-upload-pack-result" },
      });
    }

    chunks.push(pktLine(`${oid} ${size}\n`));
  }

  chunks.push(flushPkt());
  log.debug("object-info:served", { oids: parsed.oids.length });
  return new Response(asBodyInit(concatChunks(chunks)), {
    status: 200,
    headers: {
      "Content-Type": "application/x-git-upload-pack-result",
      "Cache-Control": "no-cache",
    },
  });
}
