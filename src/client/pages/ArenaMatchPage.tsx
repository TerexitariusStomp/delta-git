import { RepoNav } from "@/client/components/RepoNav";
import { IslandHost } from "@/client/server/IslandHost";

export type ArenaMatchEntryView = {
  id: string;
  slot: number;
  // null while blind judging is in effect.
  entrantDid: string | null;
  workspace: string;
  headOid: string | null;
  pushCount: number;
  firstPushAt: number | null;
  lastPushAt: number | null;
  autoScore: number;
  voteCount: number;
  won: boolean;
};

export type ArenaMatchPageProps = {
  owner: string;
  repo: string;
  visibility?: "public" | "private";
  description?: string | null;
  match: {
    id: string;
    title: string;
    spec: string;
    status: string;
    endsAt: number | null;
    judgeEndsAt: number | null;
    maxEntrants: number;
    prizeRep: number;
    createdBy: string;
    winnerEntryId: string | null;
  };
  blind: boolean;
  voted: boolean;
  viewerSignedIn: boolean;
  /** Viewer rep balance (0 when signed out or no rep row). */
  viewerRep?: number;
  /** Whether the viewer passes the earned-rep + stake gate. */
  voteEligible?: boolean;
  minStake?: number;
  maxStake?: number;
  minVoteRep?: number;
  entries: ArenaMatchEntryView[];
};

function shortOid(oid: string | null): string {
  return oid ? oid.slice(0, 7) : "—";
}

function deadlineUtc(at: number | null): string {
  if (!at) return "—";
  return new Date(at).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

const thClass = "px-4 py-2 text-left text-xs font-semibold";
const tdClass = "px-4 py-2 text-sm";

export function ArenaMatchPage({
  owner,
  repo,
  visibility,
  description,
  match,
  blind,
  voted,
  viewerSignedIn,
  viewerRep = 0,
  voteEligible = false,
  minStake = 1,
  maxStake = 25,
  minVoteRep = 10,
  entries,
}: ArenaMatchPageProps) {
  const base = `/${owner}/${repo}`;
  // Render the vote column while judging so ineligible viewers see why the
  // button is absent; the server enforces the same gate.
  const showVoteColumn = match.status === "judging" && viewerSignedIn && !voted;
  const canVote = showVoteColumn && voteEligible;
  const deadline = match.status === "judging" ? match.judgeEndsAt : match.endsAt;

  return (
    <div>
      <RepoNav
        owner={owner}
        repo={repo}
        currentTab="arena"
        visibility={visibility}
        description={description}
        arena
      />
      <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="m-0 text-xl font-semibold" style={{ color: "var(--fgColor-default)" }}>
              {match.title}
            </h2>
            <p className="mb-0 mt-1 text-sm" style={{ color: "var(--fgColor-muted)" }}>
              <span className="font-mono">{match.id}</span> · status <strong>{match.status}</strong>{" "}
              · {entries.length}/{match.maxEntrants} entrants · prize {match.prizeRep} rep
              {deadline ? ` · deadline ${deadlineUtc(deadline)}` : ""}
            </p>
          </div>
          <IslandHost
            name="arena-poll"
            props={{ owner, repo, matchId: match.id, status: match.status, deadline }}
          >
            <span className="text-xs" style={{ color: "var(--fgColor-muted)" }} />
          </IslandHost>
        </div>

        {blind ? (
          <p
            className="mt-3 rounded-md px-3 py-2 text-sm"
            style={{
              backgroundColor: "var(--bgColor-attention-muted)",
              color: "var(--fgColor-attention)",
              border: "1px solid var(--borderColor-attention-muted, var(--borderColor-default))",
            }}
          >
            Blind judging is in effect — entrant identities are masked until the match resolves or
            you commit a vote.
          </p>
        ) : null}

        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium">Match spec</summary>
          <pre
            className="mt-2 overflow-x-auto rounded-md p-3 text-xs"
            style={{
              backgroundColor: "var(--bgColor-muted)",
              border: "1px solid var(--borderColor-default)",
            }}
          >
            {match.spec}
          </pre>
        </details>

        <div
          className="mt-4 overflow-x-auto rounded-md"
          style={{ border: "1px solid var(--borderColor-default)" }}
        >
          <table>
            <thead>
              <tr>
                <th className={thClass}>entry</th>
                <th className={thClass}>entrant</th>
                <th className={thClass}>head</th>
                <th className={`${thClass} text-right`}>pushes</th>
                <th className={`${thClass} text-right`}>auto score</th>
                <th className={`${thClass} text-right`}>votes</th>
                {showVoteColumn ? <th className={thClass}>stake + vote</th> : null}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="gh-list">
                  <td className={`${tdClass} font-mono text-xs`}>
                    #{entry.slot}
                    {entry.won ? (
                      <span
                        className="ml-2 rounded-full px-2 py-px text-xs font-semibold"
                        style={{
                          backgroundColor: "var(--bgColor-success-muted)",
                          color: "var(--fgColor-success)",
                        }}
                      >
                        winner
                      </span>
                    ) : null}
                  </td>
                  <td className={`${tdClass} font-mono text-xs`}>{entry.entrantDid ?? "masked"}</td>
                  <td className={`${tdClass} font-mono text-xs`}>
                    {entry.headOid ? (
                      <a href={`${base}/commit/${entry.headOid}`}>{shortOid(entry.headOid)}</a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={`${tdClass} text-right font-mono`}>{entry.pushCount}</td>
                  <td className={`${tdClass} text-right font-mono`}>
                    {match.status === "resolved" ? entry.autoScore : "—"}
                  </td>
                  <td className={`${tdClass} text-right font-mono`}>{entry.voteCount}</td>
                  {showVoteColumn ? (
                    <td className={tdClass}>
                      {canVote ? (
                        <form
                          method="post"
                          action={`${base}/arena/${match.id}/vote`}
                          className="flex items-center gap-1.5"
                        >
                          <input type="hidden" name="entry_id" value={entry.id} />
                          <input
                            name="stake"
                            type="number"
                            min={minStake}
                            max={maxStake}
                            defaultValue={minStake}
                            className="w-16 rounded-md px-1.5 py-0.5 text-xs"
                            style={{
                              backgroundColor: "var(--bgColor-default)",
                              border: "1px solid var(--borderColor-default)",
                              color: "var(--fgColor-default)",
                            }}
                            title={`Rep to stake (${minStake}–${maxStake})`}
                          />
                          <button
                            type="submit"
                            className="rounded-md px-3 py-1 text-xs font-medium"
                            style={{
                              backgroundColor: "var(--button-primary-bgColor-rest)",
                              color: "var(--button-primary-fgColor-rest)",
                              border: "1px solid var(--button-primary-borderColor-rest)",
                            }}
                          >
                            Vote
                          </button>
                        </form>
                      ) : (
                        <span className="text-xs" style={{ color: "var(--fgColor-muted)" }}>
                          needs {minVoteRep}+ rep to stake
                        </span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
              {entries.length === 0 ? (
                <tr>
                  <td
                    className={`${tdClass} text-center`}
                    colSpan={showVoteColumn ? 7 : 6}
                    style={{ color: "var(--fgColor-muted)" }}
                  >
                    No entries yet — entrants join via{" "}
                    <code>
                      POST /api/{owner}/{repo}/dg/matches/{match.id}/enter
                    </code>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs" style={{ color: "var(--fgColor-muted)" }}>
          {match.status === "resolved" ? (
            <>
              Winner merged to canonical.{" "}
              <a href={`/api/${owner}/${repo}/dg/matches/${match.id}/bundle`}>
                Download provenance bundle
              </a>{" "}
              (spec · entries · votes · scores · op-log slice · signature).
            </>
          ) : viewerSignedIn ? (
            match.status === "judging" ? (
              voted ? (
                "Vote recorded — results revealed."
              ) : voteEligible ? (
                `Stake ${minStake}–${maxStake} rep per vote — earlier votes weigh more; winning-side voters split the loser forfeit pool. Voting reveals entrant identities.`
              ) : (
                `Voting requires ${minVoteRep}+ earned rep plus a stake (your balance: ${viewerRep}). Earn rep through merges, adjudication, vouches, or epoch allocations.`
              )
            ) : (
              "Match is building — judging opens when the window closes."
            )
          ) : (
            <>
              <a href={`/auth?next=${encodeURIComponent(`${base}/arena/${match.id}`)}`}>Sign in</a>{" "}
              to vote during judging.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
