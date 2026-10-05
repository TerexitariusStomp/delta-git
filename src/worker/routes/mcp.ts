import type { AppContext, AppRouter } from "./hono";

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { getRepoStub } from "@/worker/common";
import { resolveRepositoryRoute } from "@/worker/repositories/route";
import { isValidOwnerRepo } from "@/shared/web";
import { authenticateGitRequest } from "@/worker/auth/gitAuth";
import { mergeDryRun } from "@/worker/merge/engine";

// MCP-over-HTTP endpoint. Agents that speak JSON-RPC can drive delta-git's
// tool surface directly — the same operations the REST API exposes, framed
// as MCP tools/call so MCP-native runtimes (Claude, Hermes, Symbient) can
// mount delta-git as a tool server.
//
// Protocol framing (initialize handshake, tools/list, tools/call, error
// codes) is delegated to @modelcontextprotocol/server's stateless HTTP
// handler; each request gets a fresh McpServer closed over the hono
// context. GET/DELETE session methods answer 405 — our tools are stateless.

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function resolveDoName(
  c: AppContext,
  request: Request | undefined,
  owner: string,
  repo: string
): Promise<{ doName: string; actor: string } | null> {
  if (!isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) return null;
  const route = await resolveRepositoryRoute(c.env, owner, repo, {
    mode: "route-cache-only",
    db: c.var.db,
    log: c.var.logFor({ service: "Mcp" }),
  });
  if (!route) return null;
  // Mutating tools need a principal: Basic PAT auth on the MCP request.
  const auth = request
    ? await authenticateGitRequest(c.env, request, route, { db: c.var.db })
    : null;
  return {
    doName: route.doName,
    actor: auth?.kind === "pat" ? auth.verified.userId : "mcp-anon",
  };
}

export function registerMcpRoutes(router: AppRouter): void {
  router.post("/mcp", async (c) => {
    const handler = createMcpHandler((mcpCtx) => {
      const request = mcpCtx.requestInfo;
      const server = new McpServer({ name: "delta-git", version: "0.1.0" });

      server.registerTool(
        "dgit_refs",
        {
          description: "List git refs for a repo",
          inputSchema: { owner: z.string(), repo: z.string() },
        },
        async ({ owner, repo }) => {
          const resolved = await resolveDoName(c, request, owner, repo);
          if (!resolved)
            return { content: [{ type: "text", text: "repo not found" }], isError: true };
          const stub = getRepoStub(c.env, resolved.doName);
          const { refs } = await stub.getHeadAndRefs();
          return textResult(refs);
        }
      );

      server.registerTool(
        "dgit_intents",
        {
          description: "List merge intents (agent-era pull requests)",
          inputSchema: {
            owner: z.string(),
            repo: z.string(),
            status: z.string().optional(),
          },
        },
        async ({ owner, repo, status }) => {
          const resolved = await resolveDoName(c, request, owner, repo);
          if (!resolved)
            return { content: [{ type: "text", text: "repo not found" }], isError: true };
          const stub = getRepoStub(c.env, resolved.doName);
          const statuses = (status ?? "open,merging,adjudicating,conflict").split(",");
          const intents = await stub.listMergeIntents(statuses);
          return textResult(intents);
        }
      );

      server.registerTool(
        "dgit_merge_run",
        {
          description: "Attempt the automatic merge for an intent",
          inputSchema: {
            owner: z.string(),
            repo: z.string(),
            intent_id: z.string(),
          },
        },
        async ({ owner, repo, intent_id }) => {
          const resolved = await resolveDoName(c, request, owner, repo);
          if (!resolved)
            return { content: [{ type: "text", text: "repo not found" }], isError: true };
          if (resolved.actor === "mcp-anon") {
            return { content: [{ type: "text", text: "auth required" }], isError: true };
          }
          const stub = getRepoStub(c.env, resolved.doName);
          const { attemptMerge } = await import("@/worker/merge/engine");
          const result = await attemptMerge({
            env: c.env,
            repoId: resolved.doName,
            stub,
            intentId: intent_id,
            actor: resolved.actor,
            cacheCtx: c.var.cacheCtx,
          });
          return textResult(result);
        }
      );

      server.registerTool(
        "dgit_dryrun",
        {
          description: "Predict merge conflicts for a delta oid against a ref",
          inputSchema: {
            owner: z.string(),
            repo: z.string(),
            ref: z.string().optional(),
            delta_oid: z.string(),
          },
        },
        async ({ owner, repo, ref, delta_oid }) => {
          const resolved = await resolveDoName(c, request, owner, repo);
          if (!resolved)
            return { content: [{ type: "text", text: "repo not found" }], isError: true };
          const stub = getRepoStub(c.env, resolved.doName);
          const { refs } = await stub.getHeadAndRefs();
          const base = refs.find((r) => r.name === (ref ?? "refs/heads/main")) ?? refs[0];
          if (!base) return { content: [{ type: "text", text: "no refs" }], isError: true };
          const result = await mergeDryRun({
            env: c.env,
            repoId: resolved.doName,
            targetRef: base.name,
            baseOid: base.oid,
            deltaOid: delta_oid,
            cacheCtx: c.var.cacheCtx,
          });
          return textResult(result);
        }
      );

      server.registerTool(
        "dgit_oplog",
        {
          description: "Read the hash-chained operation log",
          inputSchema: {
            owner: z.string(),
            repo: z.string(),
            since: z.number().optional(),
          },
        },
        async ({ owner, repo, since }) => {
          const resolved = await resolveDoName(c, request, owner, repo);
          if (!resolved)
            return { content: [{ type: "text", text: "repo not found" }], isError: true };
          const stub = getRepoStub(c.env, resolved.doName);
          const rows = await stub.listOpLog(since ?? -1);
          return textResult(rows);
        }
      );

      server.registerTool(
        "dgit_kb",
        {
          description:
            "Read the repo knowledge base: summary, module map, symbols, dependency edges, entrypoints, glossary, mermaid diagrams",
          inputSchema: {
            owner: z.string(),
            repo: z.string(),
            section: z
              .enum(["all", "summary", "graph", "diagrams", "glossary", "tours"])
              .optional(),
          },
        },
        async ({ owner, repo, section }) => {
          const resolved = await resolveDoName(c, request, owner, repo);
          if (!resolved)
            return { content: [{ type: "text", text: "repo not found" }], isError: true };
          // Read-only tool — anonymous callers only reach public repos
          // (resolveDoName 404s private routes for unauthenticated reads).
          const stub = getRepoStub(c.env, resolved.doName);
          const { head } = await stub.getHeadAndRefs();
          const { refreshRepoKnowledge, topModule } = await import("@/worker/knowledge");
          const kb = await refreshRepoKnowledge(
            c.env,
            resolved.doName,
            head?.oid ?? null,
            c.var.cacheCtx
          ).catch(() => null);
          if (!kb)
            return { content: [{ type: "text", text: "knowledge unavailable" }], isError: true };
          switch (section ?? "all") {
            case "summary":
              return textResult({
                summary: kb.summary,
                modules: kb.moduleBlurbs,
                entrypoints: kb.entrypoints,
                packages: kb.packages,
              });
            case "graph":
              return textResult({
                nodes: kb.files.map((f) => ({
                  path: f.path,
                  module: topModule(f.path),
                  symbols: f.symbols.length,
                })),
                edges: kb.edges,
              });
            case "diagrams":
              return textResult(kb.diagrams);
            case "glossary":
              return textResult(kb.glossary);
            case "tours":
              return textResult(kb.tours);
            default:
              return textResult(kb);
          }
        }
      );

      server.registerTool(
        "dgit_symbol",
        {
          description: "Symbol cross-reference: where a symbol is defined and which files use it",
          inputSchema: {
            owner: z.string(),
            repo: z.string(),
            name: z.string(),
          },
        },
        async ({ owner, repo, name }) => {
          const resolved = await resolveDoName(c, request, owner, repo);
          if (!resolved)
            return { content: [{ type: "text", text: "repo not found" }], isError: true };
          const { readRepoKnowledge, symbolXref } = await import("@/worker/knowledge");
          const kb = await readRepoKnowledge(c.env, resolved.doName);
          if (!kb)
            return { content: [{ type: "text", text: "knowledge unavailable" }], isError: true };
          return textResult(symbolXref(kb, name));
        }
      );

      return server;
    });
    return await handler.fetch(c.req.raw);
  });
}
