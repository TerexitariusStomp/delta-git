import type { AppContext, AppRouter } from "./hono";

import { getRepoStub } from "@/worker/common";
import { resolveRepositoryRoute } from "@/worker/repositories/route";
import { isValidOwnerRepo } from "@/shared/web";
import { authenticateGitRequest } from "@/worker/auth/gitAuth";
import { mergeDryRun } from "@/worker/merge/engine";

// MCP-over-HTTP endpoint. Agents that speak JSON-RPC can drive delta-git's
// tool surface directly — the same operations the REST API exposes, framed
// as MCP tools/call so MCP-native runtimes (Claude, Hermes, Symbient) can
// mount delta-git as a tool server.

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
};

const TOOLS = [
  {
    name: "dgit_refs",
    description: "List git refs for a repo",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" } },
      required: ["owner", "repo"],
    },
  },
  {
    name: "dgit_intents",
    description: "List merge intents (agent-era pull requests)",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        status: { type: "string" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "dgit_merge_run",
    description: "Attempt the automatic merge for an intent",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        intent_id: { type: "string" },
      },
      required: ["owner", "repo", "intent_id"],
    },
  },
  {
    name: "dgit_dryrun",
    description: "Predict merge conflicts for a delta oid against a ref",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        ref: { type: "string" },
        delta_oid: { type: "string" },
      },
      required: ["owner", "repo", "delta_oid"],
    },
  },
  {
    name: "dgit_oplog",
    description: "Read the hash-chained operation log",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        since: { type: "number" },
      },
      required: ["owner", "repo"],
    },
  },
] as const;

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function resolveDoName(c: AppContext, owner: string, repo: string): Promise<string | null> {
  if (!isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) return null;
  const route = await resolveRepositoryRoute(c.env, owner, repo, {
    mode: "route-cache-only",
    db: c.var.db,
    log: c.var.logFor({ service: "Mcp" }),
  });
  return route?.doName ?? null;
}

export function registerMcpRoutes(router: AppRouter): void {
  router.post("/mcp", async (c) => {
    const req = await c.req.json<JsonRpcRequest>().catch(() => null);
    if (!req || req.jsonrpc !== "2.0") {
      return c.json(rpcError(req?.id, -32600, "invalid JSON-RPC"), 400);
    }

    if (req.method === "tools/list") {
      return c.json(rpcResult(req.id, { tools: TOOLS }));
    }
    if (req.method !== "tools/call") {
      return c.json(rpcError(req.id, -32601, "method not found"));
    }

    const { name, arguments: args } = (req.params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    if (!name || !args) return c.json(rpcError(req.id, -32602, "tool name + arguments required"));
    const owner = String(args.owner ?? "");
    const repo = String(args.repo ?? "");
    const doName = await resolveDoName(c, owner, repo);
    if (!doName) return c.json(rpcError(req.id, -32004, "repo not found"));
    const stub = getRepoStub(c.env, doName);

    // Mutating tools need a principal: Basic PAT auth on the MCP request.
    const route = await resolveRepositoryRoute(c.env, owner, repo, {
      mode: "route-cache-only",
      db: c.var.db,
      log: c.var.logFor({ service: "Mcp" }),
    });
    const auth = route
      ? await authenticateGitRequest(c.env, c.req.raw, route, { db: c.var.db })
      : null;
    const actor = auth?.kind === "pat" ? auth.verified.userId : "mcp-anon";

    switch (name) {
      case "dgit_refs": {
        const { refs } = await stub.getHeadAndRefs();
        return c.json(
          rpcResult(req.id, { content: [{ type: "text", text: JSON.stringify(refs) }] })
        );
      }
      case "dgit_intents": {
        const statuses = String(args.status ?? "open,merging,adjudicating,conflict").split(",");
        const intents = await stub.listMergeIntents(statuses);
        return c.json(
          rpcResult(req.id, { content: [{ type: "text", text: JSON.stringify(intents) }] })
        );
      }
      case "dgit_merge_run": {
        if (actor === "mcp-anon") return c.json(rpcError(req.id, -32001, "auth required"));
        const { attemptMerge } = await import("@/worker/merge/engine");
        const result = await attemptMerge({
          env: c.env,
          repoId: doName,
          stub,
          intentId: String(args.intent_id),
          actor,
          cacheCtx: c.var.cacheCtx,
        });
        return c.json(
          rpcResult(req.id, { content: [{ type: "text", text: JSON.stringify(result) }] })
        );
      }
      case "dgit_dryrun": {
        const { refs } = await stub.getHeadAndRefs();
        const ref = String(args.ref ?? "refs/heads/main");
        const base = refs.find((r) => r.name === ref) ?? refs[0];
        if (!base) return c.json(rpcError(req.id, -32004, "no refs"));
        const result = await mergeDryRun({
          env: c.env,
          repoId: doName,
          targetRef: base.name,
          baseOid: base.oid,
          deltaOid: String(args.delta_oid),
          cacheCtx: c.var.cacheCtx,
        });
        return c.json(
          rpcResult(req.id, { content: [{ type: "text", text: JSON.stringify(result) }] })
        );
      }
      case "dgit_oplog": {
        const rows = await stub.listOpLog(Number(args.since ?? -1));
        return c.json(
          rpcResult(req.id, { content: [{ type: "text", text: JSON.stringify(rows) }] })
        );
      }
      default:
        return c.json(rpcError(req.id, -32601, `unknown tool ${name}`));
    }
  });
}
