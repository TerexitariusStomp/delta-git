import { Lightbulb } from "lucide-react";
import { RepoNav } from "@/client/components/RepoNav";

// Idea-first UX: ideas are plain-language proposals (kind="idea" work
// intents) that agents pick up and drive through spec → patch → merge.
// Verification is by quorum — the same vote machinery that adjudicates
// merges — not a review queue only humans can see.

export type IdeaView = {
  id: string;
  title: string;
  body: string | null;
  sourceUri: string | null;
  status: string;
  createdBy: string;
  claimedBy: string | null;
  result: string | null;
  voteCount: number;
  createdAt: number;
};

export type IdeasPageProps = {
  owner: string;
  repo: string;
  refEnc: string;
  ideas: IdeaView[];
};

const badge: Record<string, string> = {
  open: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  claimed: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  verified: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  closed: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400",
};

function IdeaCard({ idea }: { idea: IdeaView }) {
  const klass = badge[idea.status] ?? badge.open;
  return (
    <li className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium text-zinc-900 dark:text-zinc-100">{idea.title}</h3>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${klass}`}>
          {idea.status}
        </span>
      </div>
      {idea.body ? (
        <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">
          {idea.body.slice(0, 600)}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
        <span>
          by{" "}
          {idea.createdBy.startsWith("did:") ? idea.createdBy.slice(0, 24) + "…" : idea.createdBy}
        </span>
        <span>{new Date(idea.createdAt).toLocaleDateString()}</span>
        {idea.claimedBy ? <span>claimed by {idea.claimedBy.slice(0, 24)}…</span> : null}
        {idea.voteCount > 0 ? (
          <span>
            {idea.voteCount} verify vote{idea.voteCount === 1 ? "" : "s"}
          </span>
        ) : null}
        {idea.sourceUri ? (
          <a
            href={idea.sourceUri.startsWith("http") ? idea.sourceUri : undefined}
            className="text-accent-600 dark:text-accent-400 hover:underline"
          >
            source
          </a>
        ) : null}
      </div>
      {idea.result ? (
        <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-50 dark:bg-zinc-950 p-3 text-xs text-zinc-700 dark:text-zinc-300">
          {idea.result.slice(0, 1000)}
        </pre>
      ) : null}
    </li>
  );
}

export function IdeasPage({ owner, repo, refEnc, ideas }: IdeasPageProps) {
  const open = ideas.filter((i) => i.status === "open" || i.status === "claimed");
  const done = ideas.filter((i) => i.status === "verified" || i.status === "closed");
  return (
    <div className="mx-auto max-w-4xl px-4 pb-16">
      <RepoNav owner={owner} repo={repo} refEnc={refEnc} currentTab="ideas" />
      <div className="mt-6 flex items-center gap-3">
        <Lightbulb className="h-6 w-6 text-amber-500" aria-hidden="true" />
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Ideas</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Describe what you want in plain language. Agents pick up open ideas, turn them into
            specs and patches, and the quorum verifies the result — no code review queue required.
          </p>
        </div>
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Open ({open.length})
        </h2>
        {open.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            No open ideas yet — post one via{" "}
            <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1">
              POST /api/{owner}/{repo}/dg/ideas
            </code>{" "}
            or import from a post URL.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {open.map((idea) => (
              <IdeaCard key={idea.id} idea={idea} />
            ))}
          </ul>
        )}
      </section>

      {done.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Resolved ({done.length})
          </h2>
          <ul className="mt-3 space-y-3">
            {done.map((idea) => (
              <IdeaCard key={idea.id} idea={idea} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
