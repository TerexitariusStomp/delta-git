import { handleAdminPage } from "./ui/adminPage";
import { handleAgentsPage, handleIdeasPage, handleIdeasSiteBuild } from "./ui/agents";
import { handleOwnerOverview, handleRepoOverview } from "./ui/overview";
import { handleTree } from "./ui/tree";
import { handleBlob } from "./ui/blob";
import { handleCommits, handleCommitFragments, handleCommitDiff, handleCommit } from "./ui/commits";
import { handleRaw, handleRawPath } from "./ui/raw";
import { handleRefsApi } from "./ui/refsApi";
import { handleLeaderboard } from "./ui/leaderboard";
import { handleArenaFeed, handleArenaMatch, handleArenaVote, handleRepoArena } from "./ui/arena";
import type { AppRouter } from "./hono";

export function registerUiRoutes(router: AppRouter) {
  // Global agent leaderboard — registered before /:owner so the literal
  // "agents" segment isn't parsed as a repo owner slug.
  router.get(`/agents`, handleLeaderboard);
  // Global arena feed — same shadowing reason as /agents.
  router.get(`/arena`, handleArenaFeed);
  // Owner repos list
  router.get(`/:owner`, handleOwnerOverview);
  // Repo overview page
  router.get(`/:owner/:repo`, handleRepoOverview);

  // Tree/Blob browser using query params: ?ref=<branch|tag|oid>&path=<path>
  router.get(`/:owner/:repo/tree`, handleTree);

  // Blob preview endpoint - renders file content with syntax highlighting and media previews
  router.get(`/:owner/:repo/blob`, handleBlob);

  // Commit list
  router.get(`/:owner/:repo/commits`, handleCommits);

  // Merge expansion fragment endpoint: returns JSON for side-branch commits of a merge
  // Example: /:owner/:repo/commits/fragments/:oid?limit=20
  router.get(`/:owner/:repo/commits/fragments/:oid`, handleCommitFragments);

  // Commit details
  router.get(`/:owner/:repo/commit/:oid/diff`, handleCommitDiff);

  router.get(`/:owner/:repo/commit/:oid`, handleCommit);

  // Raw blob endpoint - streams file content without buffering
  router.get(`/:owner/:repo/raw`, handleRaw);

  // Raw blob by ref+path (used for images in Markdown)
  router.get(`/:owner/:repo/rawpath`, handleRawPath);

  // Async refs API for repo_nav dropdown
  router.get(`/:owner/:repo/api/refs`, handleRefsApi);

  // Agent coordination page: merge intents, adjudication votes, op-log
  router.get(`/:owner/:repo/agents`, handleAgentsPage);

  // Idea-first UX board — registered after /agents for the same shadowing reasons
  router.get(`/:owner/:repo/ideas`, handleIdeasPage);
  router.post(`/:owner/:repo/ideas/site`, handleIdeasSiteBuild);

  // Arena — repo-scoped match list + blind-judging match detail + vote POST
  router.get(`/:owner/:repo/arena`, handleRepoArena);
  router.get(`/:owner/:repo/arena/:id`, handleArenaMatch);
  router.post(`/:owner/:repo/arena/:id/vote`, handleArenaVote);

  // Admin dashboard for repository management
  router.get(`/:owner/:repo/admin`, handleAdminPage);
}
