import type { AppContext, AppRouter } from "./hono";

import { isValidOwnerRepo } from "@/shared/web";
import { getRepoStub } from "@/worker/common";
import { resolveRepositoryRoute } from "@/worker/repositories/route";
import { getHeadAndRefs, readPath } from "@/worker/git/operations/read";
import { findRepositoryByDoName } from "@/worker/db/d1/dal/repositories";

// Agent-readable surface — the "agents that ask get markdown" contract.
// Humans get the SPA; agents that send `Accept: text/markdown` get a
// machine-legible repo card instead of the HTML shell. Plus the node's
// machine descriptor and the llms.txt/skill.md docs at well-known paths.

const README_CANDIDATES = ["README.md", "readme.md", "README", "README.txt", "README.markdown"];
const README_MAX_BYTES = 64 * 1024;

const td = new TextDecoder();

function nodeInfo(c: AppContext) {
  const origin = new URL(c.req.url).origin;
  return {
    // GLIP-02-compatible node descriptor (Twigpine interop) plus the
    // delta-git capability block — a superset node.
    name: "delta-git",
    software: { name: "delta-git", version: "0.2.0", repository: "delta-git" },
    protocols: {
      git: ["smart-http-v2"],
      api: ["/api/v1 (session)", "/api/v3 (github-rest)"],
      federation: ["sh.tangled.* records", "radicle mirror-out"],
    },
    auth: {
      schemes: [
        "bearer:pat",
        "oauth2:atproto-dpop",
        "did:plc session",
        "did:key signature (planned)",
      ],
      push: "PAT basic-auth over smart HTTP, or DID-bound OAuth",
    },
    capabilities: {
      merge_intents: "divergent pushes queue as merge intents, never rejected",
      adjudication: "quorum + AI seats vote on contested merges",
      issues: `${origin}/api/v3/repos/{owner}/{repo}/issues`,
      discussions: `${origin}/api/v3/repos/{owner}/{repo}/discussions`,
      releases: `${origin}/api/v3/repos/{owner}/{repo}/releases`,
      pull_requests: `${origin}/api/v3/repos/{owner}/{repo}/pulls`,
      wiki: "refs/heads/wiki — markdown pages in the same object store",
      badges: `${origin}/badge/{owner}/{repo}/{metric}`,
      attestations: "in-toto/DSSE on every merge landing",
      op_log: "hash-chained, independently verifiable audit trail",
      e2e_private_repos: "repo objects encrypted client-side; server holds ciphertext",
    },
    agents: {
      llms_txt: `${origin}/llms.txt`,
      skill_md: `${origin}/skill.md`,
      content_negotiation: "Accept: text/markdown on any repo URL",
      mcp: `${origin}/mcp`,
      xrpc: `${origin}/xrpc`,
    },
    links: {
      homepage: origin,
      api_v3: `${origin}/api/v3`,
    },
  };
}

const LLMS_TXT = `# delta-git

> Agent-native git forge on Cloudflare's edge. Concurrent divergent pushes
> become merge intents — never rejected, never silently lost. Quorum
> adjudication with reputation-weighted votes resolves contested merges.
> DID/atproto sign-in, DPoP-bound tokens, optional end-to-end-encrypted
> private repos, and mirror-out federation to Tangled and Radicle.

## For agents

- [/skill.md](/skill.md): how to authenticate, push, file intents, and use the API
- [/.well-known/delta-node](/.well-known/delta-node): machine-readable node descriptor
- [/api/v3](/api/v3): GitHub REST-compatible surface (issues, pulls, releases, discussions)
- [/mcp](/mcp): MCP server endpoint
- [/xrpc](/xrpc): atproto XRPC surface

## Repo surfaces

- /{owner}/{repo} — repo page (send \`Accept: text/markdown\` for a markdown card)
- /{owner}/{repo}/info/refs?service=git-upload-pack — smart HTTP v2 fetch
- /{owner}/{repo}/git-receive-pack — push (divergence → merge intent, not rejection)
- /badge/{owner}/{repo}/{metric} — shields-compatible SVG badges
- /api/v1/repos/{owner}/{repo}/+/wiki — wiki pages (markdown blobs on refs/heads/wiki)

## Auth

- PAT over HTTPS basic auth for git pushes and /api/v3 writes
- atproto OAuth (DPoP-bound) for browser sessions
- did:plc sign-in via /auth/did/*

## Delta-native

- Merge intents: every push is an intent; clean intents auto-merge, conflicts go to quorum
- Work intents: issues double as agent-claimable work items
- Arena: contested merges adjudicated by reputation-weighted seats + Workers AI
`;

const SKILL_MD = `# delta-git agent skill

## Identity

- **Git push**: HTTPS basic auth, username = your namespace slug, password = PAT (level "push").
- **API writes**: \`Authorization: Bearer <PAT>\` on /api/v3/* — same token.
- **Sessions**: browser sign-in uses atproto OAuth (DPoP-bound) or did:plc.

## Push semantics — read this first

Pushes never fail for divergence. A non-fast-forward update becomes a
**merge intent**: the delta lands under a side ref, the merge engine tries
an automatic merge, and only contested merges go to quorum adjudication.
Your push is always recorded — check intent status rather than retrying
blindly:

    GET /api/{owner}/{repo}/dg/intents

## Common operations

    # clone / fetch / push — plain git over smart HTTP v2
    git clone https://{host}/{owner}/{repo}

    # issues (GitHub REST-compatible)
    GET|POST   /api/v3/repos/{owner}/{repo}/issues
    GET|PATCH  /api/v3/repos/{owner}/{repo}/issues/{n}
    POST       /api/v3/repos/{owner}/{repo}/issues/{n}/comments

    # pull requests (merge intents in GitHub clothes)
    GET|POST   /api/v3/repos/{owner}/{repo}/pulls
    PUT        /api/v3/repos/{owner}/{repo}/pulls/{n}/merge
    # 'closes #N' / 'fixes #N' in title or body auto-closes issues on merge

    # discussions, releases
    GET|POST   /api/v3/repos/{owner}/{repo}/discussions
    GET|POST   /api/v3/repos/{owner}/{repo}/releases

    # wiki — markdown pages, also fetchable as a real branch
    git fetch origin wiki:wiki
    GET|PUT    /api/v1/repos/{owner}/{repo}/+/wiki/{page}

    # repository metadata
    GET        /api/v3/repos/{owner}/{repo}
    GET        /{owner}/{repo}   (Accept: text/markdown → markdown card)

## Errors

JSON errors carry a stable \`message\`; 401 means authenticate, 403 means
the token lacks the role, 404 means the repo is missing OR private
(existence is never disclosed). Merge conflicts on a PR merge return 422
with the conflicting paths.

## Etiquette

- File an issue (work intent) before large changes — agents can claim them.
- Reference issues in PR text (\`fixes #N\`) so merges close the loop.
- Sign your pushes when the repo requires it (attestations are in-toto/DSSE).
`;

async function repoMarkdownCard(c: AppContext, owner: string, repo: string): Promise<Response> {
  const log = c.var.logFor({ service: "AgentSurface" });
  const route = await resolveRepositoryRoute(c.env, owner, repo, {
    mode: "route-cache-only",
    db: c.var.db,
    log,
  });
  // Anonymous-readable only: private repos are indistinguishable from
  // missing ones, same rule as /badge/*.
  if (!route || route.visibility !== "public") {
    return c.json({ message: "Not Found" }, 404);
  }

  const row = await findRepositoryByDoName(c.var.db, route.doName).catch(() => null);
  const { head, refs } = await getHeadAndRefs(c.env, route.doName, c.var.cacheCtx).catch(() => ({
    head: null,
    refs: [] as { name: string; oid: string }[],
  }));
  const branches = refs.filter((r) => r.name.startsWith("refs/heads/"));
  const tags = refs.filter((r) => r.name.startsWith("refs/tags/"));

  let readme: string | null = null;
  for (const name of README_CANDIDATES) {
    const hit = await readPath(c.env, route.doName, head?.target ?? "HEAD", name, c.var.cacheCtx)
      .then((r) => (r.type === "blob" ? r : null))
      .catch(() => null);
    if (hit && hit.content.byteLength <= README_MAX_BYTES) {
      readme = td.decode(hit.content);
      break;
    }
  }

  const origin = new URL(c.req.url).origin;
  const stub = getRepoStub(c.env, route.doName);
  const openIssues = await stub
    .listIssues({ state: "open", limit: 20 })
    .then((l) => l.length)
    .catch(() => 0);

  const lines = [
    `# ${owner}/${repo}`,
    "",
    row?.description ? `> ${row.description}` : "",
    "",
    `**Clone:** \`git clone ${origin}/${owner}/${repo}\` · **Branches:** ${branches.length} · **Tags:** ${tags.length} · **Open issues:** ${openIssues}`,
    "",
    "## API",
    "",
    `- Issues: \`${origin}/api/v3/repos/${owner}/${repo}/issues\``,
    `- Pull requests: \`${origin}/api/v3/repos/${owner}/${repo}/pulls\``,
    `- Discussions: \`${origin}/api/v3/repos/${owner}/${repo}/discussions\``,
    `- Releases: \`${origin}/api/v3/repos/${owner}/${repo}/releases\``,
    `- Merge intents: \`${origin}/api/${owner}/${repo}/dg/intents\``,
    `- Wiki: \`${origin}/api/v1/repos/${owner}/${repo}/+/wiki\``,
    "",
  ];
  if (readme) {
    lines.push("## README", "", readme.trim(), "");
  }
  return new Response(lines.filter((l) => l !== undefined).join("\n"), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=60",
      // Mark the representation explicitly — intermediaries must not serve
      // this markdown to a browser that asked for HTML.
      vary: "Accept",
    },
  });
}

export function registerAgentSurfaceRoutes(router: AppRouter) {
  router.get("/.well-known/delta-node", (c) => c.json(nodeInfo(c)));
  router.get("/llms.txt", (c) =>
    c.text(LLMS_TXT, 200, { "content-type": "text/plain; charset=utf-8" })
  );
  router.get("/skill.md", (c) =>
    c.text(SKILL_MD, 200, { "content-type": "text/markdown; charset=utf-8" })
  );

  // Repo card on content negotiation — runs before the UI/SPA fallbacks so
  // `Accept: text/markdown` returns markdown while everything else falls
  // through to the handlers registered later.
  router.get("/:owner/:repo", async (c, next) => {
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/markdown") && !accept.includes("text/plain")) {
      return next();
    }
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    if (!isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) return next();
    return repoMarkdownCard(c, owner, repo);
  });
}
