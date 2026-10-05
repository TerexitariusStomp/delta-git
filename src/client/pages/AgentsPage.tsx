import { GitMergeIcon, GitPullRequestIcon, IssueOpenedIcon } from "@primer/octicons-react";
import { RepoNav } from "@/client/components/RepoNav";

export type IntentView = {
  id: string;
  targetRef: string;
  baseOid: string;
  deltaRef: string;
  deltaOid: string;
  status: string;
  actor: string;
  conflicts: string[];
  resultOid: string | null;
  createdAt: number;
  resolvedAt: number | null;
  votes: VoteView[];
};

export type VoteView = {
  seat: number;
  voterDid: string;
  resolutionDigest: string;
  createdAt: number;
};

export type OpEntryView = {
  seq: number;
  kind: string;
  actor: string | null;
  createdAt: number;
  hash: string;
};

export type WorkIntentView = {
  id: string;
  title: string;
  body: string | null;
  status: string;
  createdBy: string;
  claimedBy: string | null;
};

export type AgentsPageProps = {
  owner: string;
  repo: string;
  /** Show the Arena tab (artifacts repos). */
  arena?: boolean;
  refEnc: string;
  intents: IntentView[];
  opLog: OpEntryView[];
  workIntents: WorkIntentView[];
};

const ACTIVE_STATUSES = ["open", "merging", "adjudicating", "conflict"];

/** GitHub label-style status chips on Primer semantic colors. */
const statusStyle: Record<string, { bg: string; fg: string }> = {
  open: { bg: "var(--bgColor-success-muted)", fg: "var(--fgColor-success)" },
  merging: { bg: "var(--bgColor-attention-muted)", fg: "var(--fgColor-attention)" },
  adjudicating: { bg: "var(--bgColor-accent-muted)", fg: "var(--fgColor-accent)" },
  conflict: { bg: "var(--bgColor-danger-muted)", fg: "var(--fgColor-danger)" },
  merged: { bg: "var(--bgColor-done-muted)", fg: "var(--fgColor-done)" },
  claimed: { bg: "var(--bgColor-attention-muted)", fg: "var(--fgColor-attention)" },
  closed: { bg: "var(--bgColor-muted)", fg: "var(--fgColor-muted)" },
  rejected: { bg: "var(--bgColor-muted)", fg: "var(--fgColor-muted)" },
  expired: { bg: "var(--bgColor-muted)", fg: "var(--fgColor-muted)" },
};

function Badge({ status }: { status: string }) {
  const s = statusStyle[status] || statusStyle.closed;
  return (
    <span
      className="inline-block rounded-full border px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: s.bg, color: s.fg, borderColor: "var(--borderColor-muted)" }}
    >
      {status}
    </span>
  );
}

function shortDid(did: string): string {
  if (did.length <= 18) return did;
  return `${did.slice(0, 16)}…`;
}

function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id;
}

function fmtTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

function StatusIcon({ status }: { status: string }) {
  if (status === "merged") {
    return (
      <span style={{ color: "var(--fgColor-done)" }} aria-label="Merged">
        <GitMergeIcon size={16} />
      </span>
    );
  }
  const active = ACTIVE_STATUSES.includes(status);
  return (
    <span
      style={{ color: active ? "var(--fgColor-success)" : "var(--fgColor-muted)" }}
      aria-label={status}
    >
      <GitPullRequestIcon size={16} />
    </span>
  );
}

/** GitHub pull-request-style row: icon + title line + meta line + badge. */
function IntentRow({ intent, owner, repo }: { intent: IntentView; owner: string; repo: string }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 shrink-0">
        <StatusIcon status={intent.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold">
            {intent.deltaRef.replace("refs/", "")} → {intent.targetRef.replace("refs/", "")}
          </span>
          <Badge status={intent.status} />
          {intent.votes.length > 0 ? (
            <span
              className="rounded-full border px-2 py-0.5 text-xs"
              style={{ borderColor: "var(--borderColor-muted)", color: "var(--fgColor-muted)" }}
              title={intent.votes.map((v) => `seat ${v.seat} · ${shortDid(v.voterDid)}`).join("\n")}
            >
              {intent.votes.length} vote{intent.votes.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {intent.conflicts.length > 0 ? (
            <span
              className="rounded-full border px-2 py-0.5 text-xs"
              style={{
                borderColor: "var(--borderColor-muted)",
                color: "var(--fgColor-danger)",
              }}
              title={intent.conflicts.join("\n")}
            >
              {intent.conflicts.length} conflict{intent.conflicts.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        <div className="mt-1 text-xs" style={{ color: "var(--fgColor-muted)" }}>
          #{shortId(intent.id)} opened {fmtTs(intent.createdAt)} by{" "}
          <span className="font-mono">{shortDid(intent.actor)}</span>
          {" · "}delta <span className="font-mono">{intent.deltaOid.slice(0, 7)}</span>
          {" · "}base <span className="font-mono">{intent.baseOid.slice(0, 7)}</span>
          {intent.resultOid ? (
            <>
              {" · "}
              <a
                href={`/${owner}/${repo}/commit/${intent.resultOid}`}
                className="font-mono no-underline hover:underline"
              >
                merge commit {intent.resultOid.slice(0, 12)}
              </a>
            </>
          ) : null}
        </div>
        {intent.conflicts.length > 0 ? (
          <ul className="m-0 mt-1 list-none space-y-0.5 p-0">
            {intent.conflicts.slice(0, 8).map((p) => (
              <li key={p} className="font-mono text-xs" style={{ color: "var(--fgColor-muted)" }}>
                {p}
              </li>
            ))}
            {intent.conflicts.length > 8 ? (
              <li className="text-xs" style={{ color: "var(--fgColor-muted)" }}>
                +{intent.conflicts.length - 8} more
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

function IntentList({
  title,
  intents,
  owner,
  repo,
}: {
  title: string;
  intents: IntentView[];
  owner: string;
  repo: string;
}) {
  return (
    <section className="mt-6">
      <h2 className="m-0 mb-2 text-sm font-semibold" style={{ color: "var(--fgColor-default)" }}>
        {title} ({intents.length})
      </h2>
      <ul
        className="gh-list m-0 list-none overflow-hidden rounded-md p-0"
        style={{ border: "1px solid var(--borderColor-default)" }}
      >
        {intents.map((i) => (
          <IntentRow key={i.id} intent={i} owner={owner} repo={repo} />
        ))}
      </ul>
    </section>
  );
}

const thClass = "px-3 py-2 text-left text-xs font-semibold";
const tdClass = "px-3 py-2 text-xs";

export function AgentsPage({ owner, repo, arena, intents, opLog, workIntents }: AgentsPageProps) {
  const active = intents.filter((i) => ACTIVE_STATUSES.includes(i.status));
  const resolved = intents.filter((i) => !ACTIVE_STATUSES.includes(i.status));

  return (
    <>
      <RepoNav owner={owner} repo={repo} currentTab="agents" arena={arena} />
      <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
        <h1 className="m-0 text-xl font-semibold" style={{ color: "var(--fgColor-default)" }}>
          Merge intents &amp; adjudication
        </h1>
        <p className="mb-0 mt-1 text-sm" style={{ color: "var(--fgColor-muted)" }}>
          Divergent pushes land under <code>refs/delta/*</code> and resolve here through merge
          intents, quorum votes, and the operation log.
        </p>

        {intents.length === 0 ? (
          <div
            className="mt-6 rounded-md p-10 text-center"
            style={{ border: "1px solid var(--borderColor-default)" }}
          >
            <IssueOpenedIcon size={32} aria-hidden="true" />
            <p className="m-0 mt-2 font-semibold" style={{ color: "var(--fgColor-default)" }}>
              No merge intents yet
            </p>
            <p className="m-0 mt-1 text-sm" style={{ color: "var(--fgColor-muted)" }}>
              Push to a branch without pulling first and the divergent push will land under{" "}
              <code>refs/delta/*</code> and appear here for adjudication.
            </p>
          </div>
        ) : null}

        {active.length > 0 ? (
          <IntentList title="Active" intents={active} owner={owner} repo={repo} />
        ) : null}
        {resolved.length > 0 ? (
          <IntentList title="Resolved" intents={resolved.slice(0, 20)} owner={owner} repo={repo} />
        ) : null}

        {workIntents.length > 0 ? (
          <section className="mt-8">
            <h2
              className="m-0 mb-2 text-sm font-semibold"
              style={{ color: "var(--fgColor-default)" }}
            >
              Work intents ({workIntents.length})
            </h2>
            <div
              className="overflow-x-auto rounded-md"
              style={{ border: "1px solid var(--borderColor-default)" }}
            >
              <table>
                <thead>
                  <tr>
                    <th className={thClass}>id</th>
                    <th className={thClass}>title</th>
                    <th className={thClass}>status</th>
                    <th className={thClass}>claimed by</th>
                  </tr>
                </thead>
                <tbody>
                  {workIntents.map((w) => (
                    <tr key={w.id}>
                      <td className={`${tdClass} font-mono`}>{shortId(w.id)}</td>
                      <td className={tdClass}>{w.title}</td>
                      <td className={tdClass}>
                        <Badge status={w.status} />
                      </td>
                      <td className={`${tdClass} font-mono`}>
                        {w.claimedBy ? shortDid(w.claimedBy) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {opLog.length > 0 ? (
          <section className="mt-8">
            <h2
              className="m-0 mb-2 text-sm font-semibold"
              style={{ color: "var(--fgColor-default)" }}
            >
              Operation log ({opLog.length})
            </h2>
            <div
              className="overflow-x-auto rounded-md"
              style={{ border: "1px solid var(--borderColor-default)" }}
            >
              <table>
                <thead>
                  <tr>
                    <th className={thClass}>seq</th>
                    <th className={thClass}>kind</th>
                    <th className={thClass}>actor</th>
                    <th className={thClass}>hash</th>
                    <th className={thClass}>time</th>
                  </tr>
                </thead>
                <tbody>
                  {[...opLog].reverse().map((e) => (
                    <tr key={e.seq}>
                      <td className={`${tdClass} font-mono`}>{e.seq}</td>
                      <td className={tdClass}>{e.kind}</td>
                      <td className={`${tdClass} font-mono`}>
                        {e.actor ? shortDid(e.actor) : "—"}
                      </td>
                      <td
                        className={`${tdClass} font-mono`}
                        style={{ color: "var(--fgColor-muted)" }}
                      >
                        {e.hash.slice(0, 12)}…
                      </td>
                      <td className={`${tdClass} whitespace-nowrap`}>{fmtTs(e.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
