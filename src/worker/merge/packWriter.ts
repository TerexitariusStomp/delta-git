import type { GitObjectType } from "@/worker/git/core";

import { deflate } from "@/worker/common";
import { asBufferSource } from "@/worker/common";
import { hexToBytes } from "@/worker/common/hex";
import { encodeObjHeader, objTypeCode } from "@/worker/git/core";
import { concatChunks } from "@/worker/git/core/pktline";
import { crc32Update, crc32Finish } from "@/worker/git/pack/indexer/inflateCursor";
import { allocateEntryTable } from "@/worker/git/pack/indexer/types";
import { writeIdxV2 } from "@/worker/git/pack/indexer/writeIdx";

// Server-side pack writer.
//
// The merge engine creates new objects (trees, merge commits) that never
// arrive via receive-pack. `buildPackV2` exists for upload-pack assembly but
// doesn't produce the entry table the idx writer needs, so server-committed
// packs build the pack + index together here.

export type NewObject = {
  type: GitObjectType;
  payload: Uint8Array;
  oid: string;
};

export type ServerPack = {
  packBytes: Uint8Array;
  idxBytes: Uint8Array;
  objectCount: number;
};

export async function writeServerPack(objs: NewObject[]): Promise<ServerPack> {
  const table = allocateEntryTable(objs.length);
  let offset = 12; // PACK + version + count

  const entries: Uint8Array[] = [];
  for (let i = 0; i < objs.length; i++) {
    const obj = objs[i];
    const head = encodeObjHeader(objTypeCode(obj.type), obj.payload.byteLength);
    const comp = await deflate(obj.payload);
    const entry = concatChunks([head, comp]);

    table.offsets[i] = offset;
    table.types[i] = objTypeCode(obj.type);
    table.objectTypes[i] = objTypeCode(obj.type);
    table.headerLens[i] = head.length;
    table.spanEnds[i] = offset + entry.length;
    table.crc32s[i] = crc32Finish(crc32Update(0, entry, 0, entry.length));
    table.oids.set(hexToBytes(obj.oid), i * 20);
    table.decompressedSizes[i] = obj.payload.byteLength;
    table.resolved[i] = 1;

    entries.push(entry);
    offset += entry.length;
  }

  const hdr = new Uint8Array(12);
  hdr.set(new TextEncoder().encode("PACK"), 0);
  const dv = new DataView(hdr.buffer);
  dv.setUint32(4, 2);
  dv.setUint32(8, objs.length);

  const body = concatChunks([hdr, ...entries]);
  const packChecksum = new Uint8Array(
    await crypto.subtle.digest("SHA-1", asBufferSource(body))
  );
  const packBytes = new Uint8Array(body.length + 20);
  packBytes.set(body, 0);
  packBytes.set(packChecksum, body.length);

  table.count = objs.length;
  const idxBytes = await writeIdxV2(table, objs.length, packChecksum);
  return { packBytes, idxBytes, objectCount: objs.length };
}
