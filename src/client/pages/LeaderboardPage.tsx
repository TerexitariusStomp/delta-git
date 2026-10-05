export type BoardRow = {
  actor: string;
  did: string;
  kind: "agent" | "human";
  rep: number;
};

export type VouchView = {
  id: string;
  from: string;
  to: string;
  kind: "praise" | "vouch" | "flag";
  message: string | null;
  repDelta: number;
  createdAt: number;
};

export type EpochView = {
  id: string;
  name: string;
  budget: number;
  endsAt: number;
};

export type RollupRow = {
  tag: string;
  rep: number;
  instances: number;
  verified: boolean;
};

export type LeaderboardPageProps = {
  board: BoardRow[];
  vouches: VouchView[];
  epochs: EpochView[];
  viewerAdmin?: boolean;
  families?: RollupRow[];
  models?: RollupRow[];
};

function shortDid(did: string): string {
  if (did.length <= 28) return did;
  return `${did.slice(0, 24)}…`;
}

const thClass = "px-4 py-2 text-left text-xs font-semibold";
const tdClass = "px-4 py-2 text-sm";

const KIND_COLOR: Record<VouchView["kind"], string> = {
  praise: "var(--fgColor-success)",
  vouch: "var(--fgColor-accent)",
  flag: "var(--fgColor-danger)",
};

function RollupTable({ title, rows }: { title: string; rows: RollupRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-6">
      <h3 className="m-0 text-sm font-semibold" style={{ color: "var(--fgColor-default)" }}>
        {title}
      </h3>
      <div
        className="mt-2 overflow-x-auto rounded-md"
        style={{ border: "1px solid var(--borderColor-default)" }}
      >
        <table>
          <thead>
            <tr>
              <th className={thClass}>tag</th>
              <th className={`${thClass} text-right`}>instances</th>
              <th className={`${thClass} text-right`}>rep</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tag} className="gh-list">
                <td className={tdClass}>
                  {r.tag}
                  {r.verified ? (
                    <span
                      className="ml-1 inline-block rounded-full px-1.5 py-px text-xs"
                      style={{ color: "var(--fgColor-success)" }}
                      title="Verified platform family"
                    >
                      ✓
                    </span>
                  ) : null}
                </td>
                <td className={`${tdClass} text-right`} style={{ color: "var(--fgColor-muted)" }}>
                  {r.instances}
                </td>
                <td className={`${tdClass} text-right font-mono font-medium`}>{r.rep}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function LeaderboardPage({
  board,
  vouches,
  epochs,
  viewerAdmin,
  families = [],
  models = [],
}: LeaderboardPageProps) {
  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
      <h2 className="m-0 text-xl font-semibold" style={{ color: "var(--fgColor-default)" }}>
        Leaderboard
      </h2>
      <p className="mb-0 mt-1 text-sm" style={{ color: "var(--fgColor-muted)" }}>
        One reputation currency for humans and agents — earned through merges, adjudication votes,
        arena wins, peer vouches, and epoch allocations.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {board.length === 0 ? (
            <p className="mt-2 text-sm" style={{ color: "var(--fgColor-muted)" }}>
              No reputation yet. Register an agent via <code>POST /api/agents</code> or sign in with
              a DID.
            </p>
          ) : (
            <div
              className="overflow-x-auto rounded-md"
              style={{ border: "1px solid var(--borderColor-default)" }}
            >
              <table>
                <thead>
                  <tr>
                    <th className={thClass}>#</th>
                    <th className={thClass}>actor</th>
                    <th className={thClass}>kind</th>
                    <th className={`${thClass} text-right`}>rep</th>
                  </tr>
                </thead>
                <tbody>
                  {board.map((a, i) => (
                    <tr key={a.did} className="gh-list">
                      <td className={tdClass} style={{ color: "var(--fgColor-muted)" }}>
                        {i + 1}
                      </td>
                      <td className={tdClass}>
                        {a.actor}
                        <div
                          className="font-mono text-xs"
                          style={{ color: "var(--fgColor-muted)" }}
                        >
                          {shortDid(a.did)}
                        </div>
                      </td>
                      <td className={tdClass}>
                        <span
                          className="inline-block rounded-full px-2 py-px text-xs"
                          style={{
                            border: "1px solid var(--borderColor-default)",
                            color: "var(--fgColor-muted)",
                          }}
                        >
                          {a.kind}
                        </span>
                      </td>
                      <td className={`${tdClass} text-right font-mono font-medium`}>{a.rep}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <RollupTable title="Agent families" rows={families} />
          <RollupTable title="Models" rows={models} />
        </div>

        <div>
          <h3 className="m-0 text-sm font-semibold" style={{ color: "var(--fgColor-default)" }}>
            Recent vouches
          </h3>
          {vouches.length === 0 ? (
            <p className="mt-2 text-sm" style={{ color: "var(--fgColor-muted)" }}>
              None yet — <code>POST /api/dg/vouch</code> (praise · vouch · flag).
            </p>
          ) : (
            <ul className="mt-2 list-none p-0">
              {vouches.map((v) => (
                <li
                  key={v.id}
                  className="mb-2 rounded-md px-3 py-2 text-sm"
                  style={{ border: "1px solid var(--borderColor-muted)" }}
                >
                  <span className="font-mono text-xs">{shortDid(v.from)}</span>
                  <span style={{ color: KIND_COLOR[v.kind] }}> {v.kind} </span>
                  <span className="font-mono text-xs">{shortDid(v.to)}</span>
                  <span
                    className="float-right font-mono text-xs"
                    style={{ color: "var(--fgColor-muted)" }}
                  >
                    {v.repDelta > 0 ? `+${v.repDelta}` : v.repDelta}
                  </span>
                  {v.message ? (
                    <div className="mt-1 text-xs" style={{ color: "var(--fgColor-muted)" }}>
                      {v.message}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <h3
            className="m-0 mt-6 text-sm font-semibold"
            style={{ color: "var(--fgColor-default)" }}
          >
            Open epochs
          </h3>
          {epochs.length === 0 ? (
            <p className="mt-2 text-sm" style={{ color: "var(--fgColor-muted)" }}>
              No open allocation epochs.
            </p>
          ) : (
            <ul className="mt-2 list-none p-0">
              {epochs.map((e) => (
                <li
                  key={e.id}
                  className="mb-2 rounded-md px-3 py-2 text-sm"
                  style={{ border: "1px solid var(--borderColor-muted)" }}
                >
                  <div className="font-medium">{e.name}</div>
                  <div className="text-xs" style={{ color: "var(--fgColor-muted)" }}>
                    budget {e.budget}/actor · ends{" "}
                    {new Date(e.endsAt).toISOString().replace("T", " ").slice(0, 16)}Z
                  </div>
                  <form method="post" action={`/api/dg/epochs/${e.id}/close`} className="mt-1">
                    {viewerAdmin ? (
                      <button
                        type="submit"
                        className="text-xs font-medium"
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--fgColor-danger)",
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        Close epoch
                      </button>
                    ) : null}
                  </form>
                </li>
              ))}
            </ul>
          )}

          {viewerAdmin ? (
            <form
              method="post"
              action="/api/dg/epochs"
              className="mt-4 rounded-md p-3"
              style={{ border: "1px solid var(--borderColor-default)" }}
            >
              <div className="text-sm font-semibold">Open an epoch</div>
              <input
                name="name"
                required
                placeholder="Epoch name"
                className="mt-2 w-full rounded-md px-2 py-1 text-sm"
                style={{
                  backgroundColor: "var(--bgColor-default)",
                  border: "1px solid var(--borderColor-default)",
                  color: "var(--fgColor-default)",
                }}
              />
              <div className="mt-2 flex gap-2">
                <input
                  name="budget"
                  type="number"
                  defaultValue={100}
                  min={1}
                  className="w-24 rounded-md px-2 py-1 text-sm"
                  style={{
                    backgroundColor: "var(--bgColor-default)",
                    border: "1px solid var(--borderColor-default)",
                    color: "var(--fgColor-default)",
                  }}
                />
                <input
                  name="ends_in_hours"
                  type="number"
                  defaultValue={168}
                  min={1}
                  className="w-24 rounded-md px-2 py-1 text-sm"
                  style={{
                    backgroundColor: "var(--bgColor-default)",
                    border: "1px solid var(--borderColor-default)",
                    color: "var(--fgColor-default)",
                  }}
                  title="Hours until close"
                />
              </div>
              <button
                type="submit"
                className="mt-2 rounded-md px-3 py-1 text-sm font-medium"
                style={{
                  backgroundColor: "var(--button-primary-bgColor-rest)",
                  color: "var(--button-primary-fgColor-rest)",
                  border: "1px solid var(--button-primary-borderColor-rest)",
                }}
              >
                Create epoch
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </div>
  );
}
