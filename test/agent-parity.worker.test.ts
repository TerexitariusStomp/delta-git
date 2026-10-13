import { describe, it, expect, beforeAll } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";
import { uniqueRepoId } from "./util/test-helpers";

// Agent-parity suite: every end state the SPA renders must be reachable
// through the agent-facing API — REST `/api/v1` + `/api/dg` or the `/mcp`
// tool surface. The contract under test is "the route exists and answers",
// not "the fixture row exists": an unmatched API path falls through to the
// SSR 404 HTML page, while a real route answers JSON (including JSON 404s
// for missing resources and JSON 400s for invalid bodies).
//
// Path tables use `{space}`/`{repo}` placeholders substituted inside each
// `it` — describe bodies evaluate before `beforeAll`, so interpolating the
// seeds directly would bake `undefined` into the URLs.

let seeded: SetupRepoForTestsResult;
let owner: string;
let repo: string;
let space: string;
let repoRef: string;

function p(template: string): string {
  return template.replaceAll("{space}", space).replaceAll("{repo}", repoRef);
}

async function req(
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string; auth?: string } = {}
) {
  // Origin mirrors what a browser sends on same-origin writes — the CSRF
  // gate 403s session-cookie writes without it.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: "https://example.com",
  };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.auth) headers.Authorization = opts.auth;
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", res };
}

function isJson(r: { contentType: string }) {
  return r.contentType.includes("json");
}

beforeAll(async () => {
  await ensureD1Migrations(env);
  owner = `par-${Math.random().toString(36).slice(2, 8)}`;
  repo = uniqueRepoId("parrepo");
  space = owner;
  repoRef = `${owner}/${repo}`;
  seeded = await setupRepoForTests(env, owner, repo);
});

// ---------------------------------------------------------------------------
// Space-level list endpoints — every delta page's backing collection. A
// signed-in member must get 200; the body may be an empty list.
// ---------------------------------------------------------------------------
const MEMBER_LIST_GETS = [
  "artifacts",
  "catalog",
  "certificates",
  "chaos",
  "connectors",
  "costs",
  "dashboards",
  "databases",
  "delegates",
  "dev-environments",
  "downtimes",
  "environments",
  "files",
  "flags",
  "freezewindows",
  "gitops",
  "incidents",
  "insights",
  "monitors",
  "overrides",
  "policies",
  "reliability",
  "resourcegroups",
  "roles",
  "security-tests",
  "serviceaccounts",
  "slos",
  "supply-chain",
  "templates",
  "tickets",
  "usergroups",
  "variables",
];

describe("REST parity: space list endpoints", () => {
  for (const seg of MEMBER_LIST_GETS) {
    it(`GET spaces/:space/${seg} routes`, async () => {
      const r = await req(`/api/v1/spaces/${space}/${seg}`, { cookie: seeded.cookieHeader });
      expect([r.status, r.contentType], `${seg} -> ${r.status} ${r.contentType}`).toEqual([
        200,
        expect.stringContaining("json"),
      ]);
    });
  }
});

// ---------------------------------------------------------------------------
// Global + repo endpoints the SPA calls outside a space context.
// ---------------------------------------------------------------------------
describe("REST parity: global + repo endpoints", () => {
  const memberGets: [string, string][] = [
    ["notifications", "/api/v1/notifications"],
    ["user", "/api/v1/user"],
    ["memberships", "/api/v1/user/memberships"],
    ["global idea timeline", "/api/dg/ideas"],
  ];
  for (const [name, path] of memberGets) {
    it(`member GET ${name}`, async () => {
      const r = await req(path, { cookie: seeded.cookieHeader });
      expect(r.status, `${name} -> ${r.status}`).toBe(200);
    });
  }

  const publicGets: [string, string][] = [
    ["leaderboard", "/api/dg/leaderboard"],
    ["vouches", "/api/dg/vouches"],
    ["epochs", "/api/dg/epochs"],
  ];
  for (const [name, path] of publicGets) {
    it(`public GET ${name}`, async () => {
      const r = await req(path);
      expect(r.status, `${name} -> ${r.status}`).toBe(200);
    });
  }

  const repoGets: [string, string][] = [
    ["dg intents", "/api/{repo}/dg/intents"],
    ["dg ideas", "/api/{repo}/dg/ideas"],
    ["dg work", "/api/{repo}/dg/work"],
    ["dg oplog", "/api/{repo}/dg/oplog"],
    ["dg matches", "/api/{repo}/dg/matches"],
    ["dg skill.md", "/api/{repo}/dg/skill.md"],
    ["knowledge", "/api/v1/repos/{repo}/+/knowledge"],
    ["branches", "/api/v1/repos/{repo}/branches"],
    ["commits", "/api/v1/repos/{repo}/commits"],
    ["pullreq", "/api/v1/repos/{repo}/pullreq"],
    ["pipelines", "/api/v1/repos/{repo}/pipelines"],
    ["checks recent", "/api/v1/spaces/{space}/checks/recent"],
  ];
  for (const [name, template] of repoGets) {
    it(`repo GET ${name}`, async () => {
      const r = await req(p(template), { cookie: seeded.cookieHeader });
      // Seeded repo exists; empty collections are 200, and a resource-level
      // JSON 404 (e.g. knowledge not yet built) is still a routed answer.
      // skill.md is text — routed either way, just never the SSR 404.
      expect(r.status, `${name} -> ${r.status}`).not.toBe(500);
      expect(
        isJson(r) || r.contentType.includes("text/markdown") || r.status === 200,
        `${name} -> ${r.status} ${r.contentType}`
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Id-parameterized endpoints — a bogus id must produce a *routed* answer
// (JSON 404/400), not the SSR 404 fallthrough.
// ---------------------------------------------------------------------------
describe("REST parity: id-parameterized endpoints", () => {
  const idGets: [string, string][] = [
    ["file", "/api/v1/spaces/{space}/files/nope.txt"],
    ["iac state", "/api/v1/spaces/{space}/iac/nope/state"],
    ["incident", "/api/v1/spaces/{space}/incidents/nope"],
    ["flag eval", "/api/v1/spaces/{space}/flags/nope/eval"],
    ["flags sdk", "/api/v1/spaces/{space}/flags/sdk"],
    ["dev-env workspace", "/api/v1/spaces/{space}/dev-environments/nope/workspace?path=/"],
    ["dev-env preview", "/api/v1/spaces/{space}/dev-environments/nope/preview?port=8080"],
    ["rg resources", "/api/v1/spaces/{space}/resourcegroups/nope/resources"],
  ];
  for (const [name, template] of idGets) {
    it(`GET ${name}`, async () => {
      const r = await req(p(template), { cookie: seeded.cookieHeader });
      expect(isJson(r), `${name} -> ${r.status} ${r.contentType}`).toBe(true);
      expect(r.status, `${name} -> ${r.status}`).not.toBe(500);
    });
  }
});

// ---------------------------------------------------------------------------
// Write surfaces — POST/PUT with an empty body must reach a real handler
// (JSON validation/auth answer), not fall through to SSR 404.
// ---------------------------------------------------------------------------
describe("REST parity: write endpoints", () => {
  const writes: [string, string][] = [
    ["create artifact", "/api/v1/spaces/{space}/artifacts"],
    ["create catalog entity", "/api/v1/spaces/{space}/catalog"],
    ["create certificate", "/api/v1/spaces/{space}/certificates"],
    ["create chaos experiment", "/api/v1/spaces/{space}/chaos"],
    ["run chaos", "/api/v1/spaces/{space}/chaos/nope/run"],
    ["create connector", "/api/v1/spaces/{space}/connectors"],
    ["create dashboard", "/api/v1/spaces/{space}/dashboards"],
    ["create database", "/api/v1/spaces/{space}/databases"],
    ["db migration", "/api/v1/spaces/{space}/databases/nope/migrations"],
    ["db console", "/api/v1/spaces/{space}/databases/nope/console"],
    ["create delegate", "/api/v1/spaces/{space}/delegates"],
    ["create dev-env", "/api/v1/spaces/{space}/dev-environments"],
    ["dev-env action", "/api/v1/spaces/{space}/dev-environments/nope/start"],
    ["dev-env exec", "/api/v1/spaces/{space}/dev-environments/nope/exec"],
    ["create downtime", "/api/v1/spaces/{space}/downtimes"],
    ["end downtime", "/api/v1/spaces/{space}/downtimes/nope/end"],
    ["create environment", "/api/v1/spaces/{space}/environments"],
    ["upload file", "/api/v1/spaces/{space}/files"],
    ["create flag", "/api/v1/spaces/{space}/flags"],
    ["create freeze window", "/api/v1/spaces/{space}/freezewindows"],
    ["create gitops target", "/api/v1/spaces/{space}/gitops"],
    ["sync gitops", "/api/v1/spaces/{space}/gitops/nope/sync"],
    ["create incident", "/api/v1/spaces/{space}/incidents"],
    ["incident update", "/api/v1/spaces/{space}/incidents/nope/updates"],
    ["create monitor", "/api/v1/spaces/{space}/monitors"],
    ["run monitor", "/api/v1/spaces/{space}/monitors/nope/run"],
    ["read-all notifications", "/api/v1/notifications/read-all"],
    ["create override", "/api/v1/spaces/{space}/overrides"],
    ["create policy", "/api/v1/spaces/{space}/policies"],
    ["create resource group", "/api/v1/spaces/{space}/resourcegroups"],
    ["create security test", "/api/v1/spaces/{space}/security-tests"],
    ["create service account", "/api/v1/spaces/{space}/serviceaccounts"],
    ["sa token", "/api/v1/spaces/{space}/serviceaccounts/nope/token"],
    ["create slo", "/api/v1/spaces/{space}/slos"],
    ["supply chain build", "/api/v1/spaces/{space}/supply-chain"],
    ["create template", "/api/v1/spaces/{space}/templates"],
    ["create ticket", "/api/v1/spaces/{space}/tickets"],
    ["ticket sync", "/api/v1/spaces/{space}/tickets/sync"],
    ["create usergroup", "/api/v1/spaces/{space}/usergroups"],
    ["ug members", "/api/v1/spaces/{space}/usergroups/nope/members"],
    ["create variable", "/api/v1/spaces/{space}/variables"],
    ["post idea", "/api/{repo}/dg/ideas"],
    ["post vouch", "/api/dg/vouch"],
  ];
  for (const [name, template] of writes) {
    it(`POST ${name}`, async () => {
      const r = await req(p(template), { method: "POST", body: {}, cookie: seeded.cookieHeader });
      // Routed = anything but the SSR-404 HTML fallthrough. Validation 400s,
      // auth 401/403s, and no-content 204s are all real answers.
      expect(isJson(r) || r.status !== 404, `${name} -> ${r.status} ${r.contentType}`).toBe(true);
      expect(r.status, `${name} -> ${r.status}`).not.toBe(500);
    });
  }

  const deletes: [string, string][] = [
    ["connector", "/api/v1/spaces/{space}/connectors/nope"],
    ["override", "/api/v1/spaces/{space}/overrides/nope"],
    ["freeze window", "/api/v1/spaces/{space}/freezewindows/nope"],
    ["template", "/api/v1/spaces/{space}/templates/nope"],
    ["variable", "/api/v1/spaces/{space}/variables/nope"],
    ["environment", "/api/v1/spaces/{space}/environments/nope"],
    ["serviceaccount", "/api/v1/spaces/{space}/serviceaccounts/nope"],
  ];
  for (const [name, template] of deletes) {
    it(`DELETE ${name}`, async () => {
      const r = await req(p(template), { method: "DELETE", cookie: seeded.cookieHeader });
      expect(isJson(r) || r.status !== 404, `${name} -> ${r.status} ${r.contentType}`).toBe(true);
      expect(r.status, `${name} -> ${r.status}`).not.toBe(500);
    });
  }
});

// ---------------------------------------------------------------------------
// MCP parity — the tool surface must round-trip for every registered tool
// against a real repo DO.
// ---------------------------------------------------------------------------
async function mcpRpc(method: string, params?: unknown, id = 1) {
  const res = await workerExports.default.fetch("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: seeded.pushAuthHeader,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  const m = /data: (.+)\n/.exec(text);
  if (!m) throw new Error(`no SSE data frame: ${text.slice(0, 200)}`);
  return JSON.parse(m[1]);
}

describe("MCP parity", () => {
  it("tools/list exposes the full dgit tool surface", async () => {
    const list = await mcpRpc("tools/list");
    const names = (list.result.tools as { name: string }[]).map((t) => t.name);
    for (const tool of [
      "dgit_refs",
      "dgit_intents",
      "dgit_merge_run",
      "dgit_dryrun",
      "dgit_oplog",
      "dgit_kb",
      "dgit_symbol",
    ]) {
      expect(names).toContain(tool);
    }
  });

  it("read tools answer against a seeded repo", async () => {
    for (const tool of ["dgit_refs", "dgit_intents", "dgit_oplog"]) {
      const msg = await mcpRpc("tools/call", {
        name: tool,
        arguments: { owner, repo },
      });
      expect(msg.result.isError, `${tool} errored`).not.toBe(true);
      const payload = JSON.parse(msg.result.content[0].text);
      expect(payload, `${tool} payload`).not.toBeNull();
    }
  });
});
