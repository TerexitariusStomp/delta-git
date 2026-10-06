import type { CacheContext } from "@/worker/cache";
import type { RepositoryRoute } from "@/worker/repositories/route";

import { pktLine, flushPkt, concatChunks } from "@/worker/git/core/pktline";
import { asBodyInit } from "@/worker/common/webtypes";
import { responseCacheControl } from "@/worker/cache/policy";
import { createLogger } from "@/worker/common";
import { getLimiter, countSubrequest } from "./limits";
import { getHeadAndRefs } from "./read/refs";
import {
  buildServeUploadPackPlan,
  FetchPlanRetryError,
  loadUploadPackSnapshot,
} from "./fetch/plan";
import { resolvePackStreamResult } from "./fetch/execute";
import { repositoryNotReadyResponse } from "./fetch/responses";

// protocol-v2 `bundle-uri` support (GLIP-compatible clone acceleration).
// A clone hits `command=bundle-uri`, receives a bundle list, fetches the
// bundle over plain GET, then only negotiates objects newer than the bundle's
// creationToken. Our bundle is a full-clone pack keyed by HEAD oid — the same
// snapshot path a `haves=∅` fetch takes — so generation cost equals a clone.
//
// Bundle v3 format: "GIT BUNDLE V3\n", optional @capabilities lines,
// prerequisite lines (we emit none — mode=all is complete), `oid SP refname`
// lines, then the raw PACK stream. Readers scan lines until the PACK magic.

const BUNDLE_VERSION = 3;

function bundleUriPath(route: RepositoryRoute, token: string): string {
  return `/${route.routeNamespaceSlug}/${route.routeRepoSlug}.git/bundle/${token}`;
}

export async function handleBundleUriCommand(
  env: Env,
  route: RepositoryRoute,
  request: Request,
  cacheCtx?: CacheContext
): Promise<Response> {
  const log = createLogger(env.LOG_LEVEL, { service: "BundleUri", repoId: route.doName });
  const { head, refs } = await getHeadAndRefs(env, route.doName, cacheCtx);
  if (refs.length === 0) {
    // Empty repository — per spec, an empty list tells the client there are
    // no bundles; it falls back to a normal fetch without erroring.
    return new Response(asBodyInit(concatChunks([flushPkt()])), {
      status: 200,
      headers: { "Content-Type": "application/x-git-upload-pack-result" },
    });
  }

  // creationToken must be comparable across bundle refreshes; the HEAD oid
  // changes whenever the bundle would be stale, which is the semantics we need.
  const token = head?.oid ?? refs[0]!.oid;
  const origin = new URL(request.url).origin;
  const uri = `${origin}${bundleUriPath(route, token)}`;

  const chunks: Uint8Array[] = [];
  chunks.push(pktLine(`bundle.version=${BUNDLE_VERSION}\n`));
  chunks.push(pktLine("bundle.mode=all\n"));
  chunks.push(pktLine(`bundle.baseline.uri=${uri}\n`));
  chunks.push(pktLine(`bundle.baseline.creationToken=${token}\n`));
  chunks.push(pktLine(`bundle.baseline.location=${uri}\n`));
  chunks.push(flushPkt());

  log.info("bundle-uri:advertised", { token });
  return new Response(asBodyInit(concatChunks(chunks)), {
    status: 200,
    headers: {
      "Content-Type": "application/x-git-upload-pack-result",
      "Cache-Control": responseCacheControl(cacheCtx),
    },
  });
}

export async function handleBundleGet(
  env: Env,
  route: RepositoryRoute,
  token: string,
  signal?: AbortSignal,
  cacheCtx?: CacheContext
): Promise<Response> {
  const log = createLogger(env.LOG_LEVEL, { service: "BundleUri", repoId: route.doName });
  if (signal?.aborted) return new Response("client aborted\n", { status: 499 });

  // Stale tokens still serve a *correct* bundle — the client only uses it as
  // a baseline and negotiates the delta afterwards, so we don't 404 on drift;
  // we just serve the current snapshot.
  log.debug("bundle:get:requested", { token });
  const snapshotLoad = await loadUploadPackSnapshot(env, route.doName, cacheCtx);
  if (snapshotLoad.type === "RepositoryNotReady") {
    log.warn("bundle:get:repository-not-ready", { reason: snapshotLoad.reason });
    return repositoryNotReadyResponse();
  }

  const { head, refs } = await getHeadAndRefs(env, route.doName, cacheCtx);
  if (refs.length === 0) return new Response("repository has no refs\n", { status: 404 });

  let plan;
  try {
    plan = await buildServeUploadPackPlan(
      env,
      route.doName,
      snapshotLoad.snapshot,
      [],
      [],
      signal,
      cacheCtx
    );
  } catch (error) {
    if (error instanceof FetchPlanRetryError) {
      return new Response("Bundle is not ready yet, retry shortly.\n", {
        status: 503,
        headers: { "Retry-After": String(error.retryAfterSeconds) },
      });
    }
    throw error;
  }
  if (plan.type !== "Serve") return repositoryNotReadyResponse();

  const encoder = new TextEncoder();
  const headerLines = ["GIT BUNDLE V3"];
  for (const r of refs) headerLines.push(`${r.oid} ${r.name}`);
  if (head?.oid && head.target) headerLines.push(`${head.oid} HEAD`);
  const header = encoder.encode(headerLines.join("\n") + "\n");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(header);
        const limiter = getLimiter(plan.cacheCtx);
        const packResult = await resolvePackStreamResult(env, plan, {
          signal: plan.signal,
          limiter,
          countSubrequest: (n?: number) => countSubrequest(plan.cacheCtx, n),
        });
        if (packResult.status !== "ok") {
          log.warn("bundle:get:assemble-unavailable", {
            reason: packResult.failure.reason,
          });
          controller.error(new Error(packResult.failure.reason));
          return;
        }
        const reader = packResult.stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        log.error("bundle:get:stream-error", { error: String(error) });
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-git-bundle",
      "Cache-Control": "no-store",
    },
  });
}
