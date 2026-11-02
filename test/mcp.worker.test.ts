import { it, expect } from "vitest";
import { exports as workerExports } from "cloudflare:workers";

import { mintNamespacePullPat, setupRepoForTests } from "./util/repoSeed";

import { env } from "cloudflare:workers";

// MCP-over-HTTP smoke: the @modelcontextprotocol/server handler must
// answer initialize, tools/list, and tools/call against a live repo DO.
// Speaks raw JSON-RPC over POST /mcp — no SDK client needed.

function rpc(method: string, params?: unknown, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  return workerExports.default.fetch("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// The handler responds SSE (`event: message\ndata: <json>`) — pull the
// first data frame's JSON-RPC payload.
async function readSseResult(res: Response) {
  const text = await res.text();
  const m = /data: (.+)\n/.exec(text);
  if (!m) throw new Error(`no SSE data frame: ${text.slice(0, 200)}`);
  return JSON.parse(m[1]);
}

it("mcp: initialize + tools/list + tools/call round-trip", async () => {
  const seeded = await setupRepoForTests(env, "mcpns", "mcprepo");

  const init = await post(
    rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    })
  );
  expect(init.status).toBe(200);
  const initMsg = await readSseResult(init);
  expect(initMsg.result.serverInfo.name).toBe("delta-git");

  const list = await post(rpc("tools/list"));
  expect(list.status).toBe(200);
  const listMsg = await readSseResult(list);
  const names = (listMsg.result.tools as { name: string }[]).map((t) => t.name);
  expect(names).toContain("dgit_refs");
  expect(names).toContain("dgit_intents");

  const call = await post(
    rpc("tools/call", {
      name: "dgit_refs",
      arguments: { owner: "mcpns", repo: "mcprepo" },
    }),
    { authorization: seeded.pushAuthHeader }
  );
  expect(call.status).toBe(200);
  const callMsg = await readSseResult(call);
  // Fresh seed has no refs yet — the payload must still be a JSON array.
  const refs = JSON.parse(callMsg.result.content[0].text);
  expect(Array.isArray(refs)).toBe(true);

  const missing = await post(
    rpc("tools/call", {
      name: "dgit_refs",
      arguments: { owner: "mcpns", repo: "nope" },
    })
  );
  const missingMsg = await readSseResult(missing);
  expect(missingMsg.result.isError).toBe(true);
});

it("mcp: dgit_merge_run rejects a pull-level PAT (write gate needs push)", async () => {
  const seeded = await setupRepoForTests(env, "mcppull", "pullrepo");
  const pull = await mintNamespacePullPat(env, seeded.userId, seeded.namespaceId);
  const pullAuthHeader = `Basic ${btoa(`${seeded.namespaceSlug}:${pull.plaintext}`)}`;

  const call = await post(
    rpc("tools/call", {
      name: "dgit_merge_run",
      arguments: {
        owner: seeded.namespaceSlug,
        repo: seeded.repoSlug,
        intent_id: "no-such-intent",
      },
    }),
    { authorization: pullAuthHeader }
  );
  expect(call.status).toBe(200);
  const msg = await readSseResult(call);
  // Read-only (pull-level) PATs must not reach mutating tools — the same
  // push-level contract the git receive-pack and /api/*/dg write gates use.
  expect(msg.result.isError).toBe(true);
  expect(msg.result.content[0].text).toMatch(/insufficient scope/i);
});
