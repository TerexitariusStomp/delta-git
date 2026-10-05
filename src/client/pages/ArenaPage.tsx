export type ArenaFeedMatch = {
  id: string;
  title: string;
  ownerSlug: string;
  repoSlug: string;
  // Derived server-side from status + deadlines.
  phase: "building" | "judging" | "resolved";
  entryCount: number;
  endsAt: number | null;
  judgeEndsAt: number | null;
  createdBy: string;
  createdAt: number;
};

export type ArenaPageProps = {
  matches: ArenaFeedMatch[];
};

function shortId(id: string): string {
  return id.length <= 20 ? id : `${id.slice(0, 16)}…`;
}

function shortActor(actor: string): string {
  if (actor.length <= 24) return actor;
  return `${actor.slice(0, 20)}…`;
}

function deadlineLabel(match: ArenaFeedMatch): string {
  const at = match.phase === "judging" ? match.judgeEndsAt : match.endsAt;
  if (!at) return "—";
  const delta = at - match.createdAt;
  void delta;
  return new Date(at).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function PhaseBadge({ phase }: { phase: ArenaFeedMatch["phase"] }) {
  const colors: Record<ArenaFeedMatch["phase"], { bg: string; fg: string }> = {
    building: { bg: "var(--bgColor-attention-muted)", fg: "var(--fgColor-attention)" },
    judging: { bg: "var(--bgColor-accent-muted)", fg: "var(--fgColor-accent)" },
    resolved: { bg: "var(--bgColor-success-muted)", fg: "var(--fgColor-success)" },
  };
  const c = colors[phase];
  return (
    <span
      className="inline-block rounded-full px-2 py-px text-xs font-medium"
      style={{ backgroundColor: c.bg, color: c.fg, border: `1px solid ${c.fg}` }}
    >
      {phase}
    </span>
  );
}

const thClass = "px-4 py-2 text-left text-xs font-semibold";
const tdClass = "px-4 py-2 text-sm";

export function ArenaPage({ matches }: ArenaPageProps) {
  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
      <h2 className="m-0 text-xl font-semibold" style={{ color: "var(--fgColor-default)" }}>
        Arena
      </h2>
      <p className="mb-0 mt-1 text-sm" style={{ color: "var(--fgColor-muted)" }}>
        Competitive vibe coding on delta-git. Entrants get isolated Artifacts workspace forks on the
        same spec; composite judging (live signals + blind community votes) picks a winner and
        merges it into the canonical repository. Every match is auditable via the op-log and a
        downloadable provenance bundle.
      </p>

      {matches.length === 0 ? (
        <p className="mt-6 text-sm" style={{ color: "var(--fgColor-muted)" }}>
          No matches yet. Create one via <code>POST /api/:owner/:repo/dg/matches</code> on an
          Artifacts-backed repo.
        </p>
      ) : (
        <div
          className="mt-4 overflow-x-auto rounded-md"
          style={{ border: "1px solid var(--borderColor-default)" }}
        >
          <table>
            <thead>
              <tr>
                <th className={thClass}>match</th>
                <th className={thClass}>repository</th>
                <th className={thClass}>phase</th>
                <th className={`${thClass} text-right`}>entrants</th>
                <th className={thClass}>deadline (UTC)</th>
                <th className={thClass}>created by</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((m) => (
                <tr key={m.id} className="gh-list">
                  <td className={tdClass}>
                    <a href={`/${m.ownerSlug}/${m.repoSlug}/arena/${m.id}`} className="font-medium">
                      {m.title}
                    </a>
                    <div className="font-mono text-xs" style={{ color: "var(--fgColor-muted)" }}>
                      {shortId(m.id)}
                    </div>
                  </td>
                  <td className={tdClass}>
                    <a href={`/${m.ownerSlug}/${m.repoSlug}`}>
                      {m.ownerSlug}/{m.repoSlug}
                    </a>
                  </td>
                  <td className={tdClass}>
                    <PhaseBadge phase={m.phase} />
                  </td>
                  <td className={`${tdClass} text-right font-mono`}>{m.entryCount}</td>
                  <td
                    className={`${tdClass} font-mono text-xs`}
                    style={{ color: "var(--fgColor-muted)" }}
                  >
                    {deadlineLabel(m)}
                  </td>
                  <td
                    className={`${tdClass} font-mono text-xs`}
                    style={{ color: "var(--fgColor-muted)" }}
                  >
                    {shortActor(m.createdBy)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
