import type { RepoQueueMessageHandle, DeployQueueMessage } from "./types";

import { createLogger, getRepoStubByDoId } from "@/worker/common";
import { readObject } from "@/worker/git/object-store/store";
import { readPayload, resolvePathEntry } from "@/worker/agent/patch";
import { isTreeMode } from "@/worker/git/core/tree";
import { parseCommitText } from "@/worker/git/core";
import { decryptRepoSecret } from "@/worker/agent/secrets";

// Deploy-on-commit.
//
// Every ref advance enqueues a deploy job. This consumer decides the tier:
//   static  — a /site dir or index.html exists → already live at /pages/*,
//             we just stamp the commit status.
//   dynamic — wrangler.toml or worker entry exists → upload via the Workers
//             Scripts API as `dg-<repo>-<branch>` with repo secrets injected
//             as secret_text bindings (the wrangler-secret contract).
// Outcomes write back as commit statuses + op-log entries.

const td = new TextDecoder();

async function treeHasEntry(
  env: Env,
  doId: string,
  treeOid: string,
  path: string
): Promise<boolean> {
  const entry = await resolvePathEntry(env, doId, treeOid, path, undefined);
  return entry !== undefined;
}

async function deployWorkerScript(args: {
  env: Env;
  doId: string;
  treeOid: string;
  scriptName: string;
  ref: string;
  sha: string;
}): Promise<{ ok: boolean; detail: string }> {
  const { env, doId, treeOid, scriptName } = args;
  const entry = await resolvePathEntry(env, doId, treeOid, "worker.js", undefined);
  const srcEntry = entry ?? (await resolvePathEntry(env, doId, treeOid, "src/index.js", undefined));
  if (!srcEntry || isTreeMode(srcEntry.mode)) {
    return { ok: false, detail: "no-worker-entry" };
  }
  const blob = await readObject(env, doId, srcEntry.oid, undefined);
  if (!blob || blob.type !== "blob") return { ok: false, detail: "entry-not-blob" };

  const accountId = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!accountId || !token) return { ok: false, detail: "cf-credentials-missing" };

  const stub = getRepoStubByDoId(env, doId);
  const secretRows = await stub.listRepoSecretCiphertexts();
  const bindings: { type: string; name: string; text: string }[] = [];
  for (const row of secretRows) {
    try {
      bindings.push({
        type: "secret_text",
        name: row.name,
        text: await decryptRepoSecret(env, row.ciphertext),
      });
    } catch {
      return { ok: false, detail: `secret-decrypt-failed:${row.name}` };
    }
  }

  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2026-01-01",
    bindings,
    tags: [`repo:${doId.slice(0, 8)}`, `ref:${args.ref}`],
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(
    "worker.js",
    new Blob([blob.payload as BlobPart], { type: "application/javascript+module" }),
    "worker.js"
  );

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }
  );
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: { message?: string }[];
  };
  if (!res.ok || json.success === false) {
    return { ok: false, detail: `cf-api:${res.status}:${json.errors?.[0]?.message ?? "unknown"}` };
  }
  return { ok: true, detail: `https://${scriptName}.workers.dev` };
}

export async function handleDeployMessage(
  message: Omit<RepoQueueMessageHandle<DeployQueueMessage>, "body">,
  body: DeployQueueMessage,
  env: Env
): Promise<void> {
  const log = createLogger(env.LOG_LEVEL, { service: "DeployOnCommit" });
  const stub = getRepoStubByDoId(env, body.doId);
  const actor = body.actor ?? "deploy-lane";

  const commit = await readPayload(env, body.doId, body.sha, undefined);
  if (!commit || commit.type !== "commit") {
    log.warn("deploy:missing-commit", { sha: body.sha, doId: body.doId });
    message.ack();
    return;
  }
  const treeOid = parseCommitText(td.decode(commit.payload)).tree;
  if (!treeOid) {
    message.ack();
    return;
  }

  const branch = body.ref
    .replace(/^refs\/heads\//, "")
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase();
  const repoSlug = (body.repoId ?? body.doId)
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .slice(0, 32);
  const scriptName = `dg-${repoSlug}-${branch}`.slice(0, 60);

  const hasStatic =
    (await treeHasEntry(env, body.doId, treeOid, "site")) ||
    (await treeHasEntry(env, body.doId, treeOid, "index.html")) ||
    (await treeHasEntry(env, body.doId, treeOid, "public"));
  const hasWorker =
    (await treeHasEntry(env, body.doId, treeOid, "wrangler.toml")) ||
    (await treeHasEntry(env, body.doId, treeOid, "worker.js")) ||
    (await treeHasEntry(env, body.doId, treeOid, "src/index.js"));

  if (hasWorker) {
    const result = await deployWorkerScript({
      env,
      doId: body.doId,
      treeOid,
      scriptName,
      ref: body.ref,
      sha: body.sha,
    });
    await stub.setCommitStatus({
      row: {
        sha: body.sha,
        context: "delta-git/deploy",
        state: result.ok ? "success" : "failure",
        description: result.detail.slice(0, 140),
        targetUrl: result.ok ? result.detail : null,
        createdBy: actor,
        createdAt: Date.now(),
      },
      actor,
    });
    if (!result.ok) {
      log.warn("deploy:worker-failed", { scriptName, detail: result.detail });
      message.retry();
      return;
    }
    log.info("deploy:worker-live", { scriptName, sha: body.sha });
  }

  if (hasStatic) {
    await stub.setCommitStatus({
      row: {
        sha: body.sha,
        context: "delta-git/pages",
        state: "success",
        description: "static site live",
        targetUrl: `/pages/${body.sha.slice(0, 12)}/`,
        createdBy: actor,
        createdAt: Date.now(),
      },
      actor,
    });
    log.info("deploy:pages-live", { sha: body.sha, doId: body.doId });
  }

  message.ack();
}
