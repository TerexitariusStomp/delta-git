import { IssueOpenedIcon, IssueClosedIcon, LightBulbIcon } from "@primer/octicons-react";
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
  /** Show the Arena tab (artifacts repos). */
  arena?: boolean;
  /** Signed-in viewers get the site-builder form. */
  viewerSignedIn?: boolean;
  refEnc: string;
  ideas: IdeaView[];
};

const statusStyle: Record<string, { bg: string; fg: string }> = {
  open: { bg: "var(--bgColor-success-muted)", fg: "var(--fgColor-success)" },
  claimed: { bg: "var(--bgColor-attention-muted)", fg: "var(--fgColor-attention)" },
  verified: { bg: "var(--bgColor-done-muted)", fg: "var(--fgColor-done)" },
  closed: { bg: "var(--bgColor-muted)", fg: "var(--fgColor-muted)" },
};

function IdeaRow({ idea }: { idea: IdeaView }) {
  const s = statusStyle[idea.status] ?? statusStyle.open;
  const isOpen = idea.status === "open" || idea.status === "claimed";
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span
        className="mt-0.5 shrink-0"
        style={{ color: isOpen ? "var(--fgColor-success)" : "var(--fgColor-done)" }}
        aria-label={idea.status}
      >
        {isOpen ? <IssueOpenedIcon size={16} /> : <IssueClosedIcon size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold" style={{ color: "var(--fgColor-default)" }}>
            {idea.title}
          </span>
          <span
            className="rounded-full border px-2 py-0.5 text-xs font-medium"
            style={{ backgroundColor: s.bg, color: s.fg, borderColor: "var(--borderColor-muted)" }}
          >
            {idea.status}
          </span>
        </div>
        {idea.body ? (
          <p
            className="m-0 mt-1 whitespace-pre-wrap text-sm"
            style={{ color: "var(--fgColor-muted)" }}
          >
            {idea.body.slice(0, 600)}
          </p>
        ) : null}
        <div
          className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
          style={{ color: "var(--fgColor-muted)" }}
        >
          <span>
            opened {new Date(idea.createdAt).toLocaleDateString()} by{" "}
            {idea.createdBy.startsWith("did:") ? idea.createdBy.slice(0, 24) + "…" : idea.createdBy}
          </span>
          {idea.claimedBy ? <span>claimed by {idea.claimedBy.slice(0, 24)}…</span> : null}
          {idea.voteCount > 0 ? (
            <span>
              {idea.voteCount} verify vote{idea.voteCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {idea.sourceUri ? (
            <a
              href={idea.sourceUri.startsWith("http") ? idea.sourceUri : undefined}
              className="no-underline hover:underline"
            >
              source
            </a>
          ) : null}
        </div>
        {idea.result ? (
          <pre
            className="m-0 mt-2 overflow-x-auto rounded-md p-3 text-xs"
            style={{ backgroundColor: "var(--bgColor-muted)", color: "var(--fgColor-default)" }}
          >
            {idea.result.slice(0, 1000)}
          </pre>
        ) : null}
      </div>
    </li>
  );
}

function IdeaList({ title, ideas }: { title: string; ideas: IdeaView[] }) {
  return (
    <section className="mt-6">
      <h2 className="m-0 mb-2 text-sm font-semibold" style={{ color: "var(--fgColor-default)" }}>
        {title} ({ideas.length})
      </h2>
      <ul
        className="gh-list m-0 list-none overflow-hidden rounded-md p-0"
        style={{ border: "1px solid var(--borderColor-default)" }}
      >
        {ideas.map((idea) => (
          <IdeaRow key={idea.id} idea={idea} />
        ))}
      </ul>
    </section>
  );
}

export function IdeasPage({ owner, repo, arena, viewerSignedIn, ideas }: IdeasPageProps) {
  const open = ideas.filter((i) => i.status === "open" || i.status === "claimed");
  const done = ideas.filter((i) => i.status === "verified" || i.status === "closed");
  return (
    <>
      <RepoNav owner={owner} repo={repo} currentTab="ideas" arena={arena} />
      <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
        <div className="flex items-center gap-3">
          <span style={{ color: "var(--fgColor-attention)" }} aria-hidden="true">
            <LightBulbIcon size={24} />
          </span>
          <div>
            <h1 className="m-0 text-xl font-semibold" style={{ color: "var(--fgColor-default)" }}>
              Ideas
            </h1>
            <p className="m-0 text-sm" style={{ color: "var(--fgColor-muted)" }}>
              Describe what you want in plain language. Agents pick up open ideas, turn them into
              specs and patches, and the quorum verifies the result.
            </p>
          </div>
        </div>

        {viewerSignedIn ? (
          <form
            method="post"
            action={`/${owner}/${repo}/ideas/site`}
            className="mt-4 rounded-md p-4"
            style={{ border: "1px solid var(--borderColor-default)" }}
          >
            <div className="text-sm font-semibold" style={{ color: "var(--fgColor-default)" }}>
              Build a site with site-smith
            </div>
            <p className="m-0 mt-1 text-xs" style={{ color: "var(--fgColor-muted)" }}>
              Describe a site and the builder generates a WordPress blueprint, a block theme, and a
              static preview — committed through the normal merge lanes.
            </p>
            <textarea
              name="description"
              required
              rows={3}
              maxLength={8000}
              placeholder="A portfolio site for a landscape photographer — hero image, gallery grid, about page, contact form…"
              className="mt-2 w-full rounded-md px-2 py-1.5 text-sm"
              style={{
                backgroundColor: "var(--bgColor-default)",
                border: "1px solid var(--borderColor-default)",
                color: "var(--fgColor-default)",
                resize: "vertical",
              }}
            />
            <button
              type="submit"
              className="mt-2 rounded-md px-3 py-1 text-sm font-medium"
              style={{
                backgroundColor: "var(--button-primary-bgColor-rest)",
                color: "var(--button-primary-fgColor-rest)",
                border: "1px solid var(--button-primary-borderColor-rest)",
              }}
            >
              Generate site
            </button>
          </form>
        ) : null}

        {open.length === 0 ? (
          <div
            className="mt-6 rounded-md p-10 text-center"
            style={{ border: "1px solid var(--borderColor-default)" }}
          >
            <IssueOpenedIcon size={32} aria-hidden="true" />
            <p className="m-0 mt-2 font-semibold" style={{ color: "var(--fgColor-default)" }}>
              No open ideas yet
            </p>
            <p className="m-0 mt-1 text-sm" style={{ color: "var(--fgColor-muted)" }}>
              Post one via{" "}
              <code>
                POST /api/{owner}/{repo}/dg/ideas
              </code>{" "}
              or import from a post URL.
            </p>
          </div>
        ) : (
          <IdeaList title="Open" ideas={open} />
        )}

        {done.length > 0 ? <IdeaList title="Resolved" ideas={done} /> : null}
      </div>
    </>
  );
}
