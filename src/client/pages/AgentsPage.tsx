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
  refEnc: string;
  intents: IntentView[];
  opLog: OpEntryView[];
  workIntents: WorkIntentView[];
};

const ACTIVE_STATUSES = ["open", "merging", "adjudicating", "conflict"];

const badge: Record<string, string> = {
  open: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  merging: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  adjudicating: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  conflict: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  merged: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  claimed: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  closed: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400",
  rejected: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400",
  expired: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400",
};

function Badge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${badge[status] || badge.rejected}`}
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

function IntentCard({ intent, owner, repo }: { intent: IntentView; owner: string; repo: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
          {shortId(intent.id)}
        </span>
        <Badge status={intent.status} />
        <span className="font-mono text-xs">
          {intent.deltaRef.replace("refs/", "")} → {intent.targetRef.replace("refs/", "")}
        </span>
        <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
          {fmtTs(intent.createdAt)}
        </span>
      </div>
      <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
        actor <span className="font-mono">{shortDid(intent.actor)}</span>
        {" · "}delta <span className="font-mono">{intent.deltaOid.slice(0, 7)}</span>
        {" · "}base <span className="font-mono">{intent.baseOid.slice(0, 7)}</span>
      </div>
      {intent.conflicts.length > 0 ? (
        <div className="mt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-red-600 dark:text-red-400">
            Conflicts ({intent.conflicts.length})
          </span>
          <ul className="mt-1 space-y-0.5">
            {intent.conflicts.slice(0, 8).map((p) => (
              <li key={p} className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
                {p}
              </li>
            ))}
            {intent.conflicts.length > 8 ? (
              <li className="text-xs text-zinc-500">+{intent.conflicts.length - 8} more</li>
            ) : null}
          </ul>
        </div>
      ) : null}
      {intent.votes.length > 0 ? (
        <div className="mt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-purple-600 dark:text-purple-400">
            Votes ({intent.votes.length})
          </span>
          <ul className="mt-1 space-y-0.5">
            {intent.votes.map((v) => (
              <li
                key={`${v.voterDid}-${v.seat}`}
                className="font-mono text-xs text-zinc-600 dark:text-zinc-400"
              >
                seat {v.seat} · {shortDid(v.voterDid)} → {v.resolutionDigest.slice(0, 12)}…
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {intent.resultOid ? (
        <div className="mt-2 text-xs">
          <a
            href={`/${owner}/${repo}/commit/${intent.resultOid}`}
            className="font-mono text-accent-600 hover:underline dark:text-accent-400"
          >
            merge commit {intent.resultOid.slice(0, 12)}
          </a>
        </div>
      ) : null}
    </div>
  );
}

export function AgentsPage({ owner, repo, refEnc, intents, opLog, workIntents }: AgentsPageProps) {
  const active = intents.filter((i) => ACTIVE_STATUSES.includes(i.status));
  const resolved = intents.filter((i) => !ACTIVE_STATUSES.includes(i.status));

  return (
    <div>
      <RepoNav owner={owner} repo={repo} refEnc={refEnc} currentTab="agents" />
      <span className="mb-1 inline-block text-xs font-semibold uppercase tracking-wider text-accent-500 dark:text-accent-400">
        Agent coordination
      </span>
      <h2 className="font-display tracking-tight">Merge intents &amp; adjudication</h2>

      {intents.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
          No merge intents yet. Push to a branch without pulling first and the divergent push will
          land under <code className="font-mono">refs/delta/*</code> and appear here for
          adjudication.
        </p>
      ) : null}

      {active.length > 0 ? (
        <section className="mt-4">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Active ({active.length})
          </h3>
          <div className="mt-2 space-y-3">
            {active.map((i) => (
              <IntentCard key={i.id} intent={i} owner={owner} repo={repo} />
            ))}
          </div>
        </section>
      ) : null}

      {resolved.length > 0 ? (
        <section className="mt-6">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Resolved ({resolved.length})
          </h3>
          <div className="mt-2 space-y-3">
            {resolved.slice(0, 20).map((i) => (
              <IntentCard key={i.id} intent={i} owner={owner} repo={repo} />
            ))}
          </div>
        </section>
      ) : null}

      {workIntents.length > 0 ? (
        <section className="mt-8">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Work intents ({workIntents.length})
          </h3>
          <div className="mt-2 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-50 dark:bg-zinc-900/60 text-zinc-500 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2 font-medium">id</th>
                  <th className="px-3 py-2 font-medium">title</th>
                  <th className="px-3 py-2 font-medium">status</th>
                  <th className="px-3 py-2 font-medium">claimed by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {workIntents.map((w) => (
                  <tr key={w.id}>
                    <td className="px-3 py-2 font-mono">{shortId(w.id)}</td>
                    <td className="px-3 py-2">{w.title}</td>
                    <td className="px-3 py-2">
                      <Badge status={w.status} />
                    </td>
                    <td className="px-3 py-2 font-mono">
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
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Operation log ({opLog.length})
          </h3>
          <div className="mt-2 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-50 dark:bg-zinc-900/60 text-zinc-500 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2 font-medium">seq</th>
                  <th className="px-3 py-2 font-medium">kind</th>
                  <th className="px-3 py-2 font-medium">actor</th>
                  <th className="px-3 py-2 font-medium">hash</th>
                  <th className="px-3 py-2 font-medium">time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {[...opLog].reverse().map((e) => (
                  <tr key={e.seq}>
                    <td className="px-3 py-2 font-mono">{e.seq}</td>
                    <td className="px-3 py-2">{e.kind}</td>
                    <td className="px-3 py-2 font-mono">{e.actor ? shortDid(e.actor) : "—"}</td>
                    <td className="px-3 py-2 font-mono text-zinc-500 dark:text-zinc-400">
                      {e.hash.slice(0, 12)}…
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmtTs(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
