import type { CacheContext } from "@/worker/cache";

import { asBodyInit } from "@/worker/common";
import { responseCacheControl } from "@/worker/cache/policy";
import { pktLine, delimPkt, flushPkt, concatChunks } from "@/worker/git/core";

/**
 * Builds acknowledgment section for git protocol v2.
 */
export function buildAckSection(ackOids: string[], done: boolean): Uint8Array[] {
  const chunks: Uint8Array[] = [];

  if (!done) {
    chunks.push(pktLine("acknowledgments\n"));
    if (ackOids && ackOids.length > 0) {
      for (let i = 0; i < ackOids.length; i++) {
        const oid = ackOids[i];
        const suffix = i === ackOids.length - 1 ? "ready" : "common";
        chunks.push(pktLine(`ACK ${oid} ${suffix}\n`));
      }
    } else {
      chunks.push(pktLine("NAK\n"));
    }
    chunks.push(delimPkt());
  }
  chunks.push(pktLine("packfile\n"));

  return chunks;
}

/**
 * Builds the shallow-info section for git protocol v2 fetch responses.
 * Emitted before the packfile section (delimited) so the client can update
 * its .git/shallow boundary before consuming objects.
 */
export function buildShallowInfoSection(info: {
  shallow: string[];
  unshallow: string[];
}): Uint8Array[] {
  const chunks: Uint8Array[] = [pktLine("shallow-info\n")];
  for (const oid of info.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
  for (const oid of info.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  chunks.push(delimPkt());
  return chunks;
}

/**
 * Builds an ACK/NAK-only response when no packfile is needed.
 */
export function buildAckOnlyResponse(ackOids: string[], cacheCtx?: CacheContext): Response {
  const chunks: Uint8Array[] = [pktLine("acknowledgments\n")];

  if (ackOids && ackOids.length > 0) {
    for (let i = 0; i < ackOids.length; i++) {
      const oid = ackOids[i];
      const suffix = i === ackOids.length - 1 ? "ready" : "common";
      chunks.push(pktLine(`ACK ${oid} ${suffix}\n`));
    }
  } else {
    chunks.push(pktLine("NAK\n"));
  }

  chunks.push(flushPkt());

  return new Response(asBodyInit(concatChunks(chunks)), {
    status: 200,
    headers: {
      "Content-Type": "application/x-git-upload-pack-result",
      "Cache-Control": responseCacheControl(cacheCtx),
    },
  });
}
