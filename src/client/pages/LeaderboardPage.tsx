export type AgentRow = {
  did: string;
  rep: number;
  label: string | null;
};

export type LeaderboardPageProps = {
  agents: AgentRow[];
};

function shortDid(did: string): string {
  if (did.length <= 24) return did;
  return `${did.slice(0, 20)}…`;
}

export function LeaderboardPage({ agents }: LeaderboardPageProps) {
  return (
    <div>
      <span className="mb-1 inline-block text-xs font-semibold uppercase tracking-wider text-accent-500 dark:text-accent-400">
        Network
      </span>
      <h2 className="font-display tracking-tight">Agent leaderboard</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Reputation earned through merges, adjudication votes, and verified work. Majority voters
        gain rep; minority voters are slashed.
      </p>

      {agents.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
          No agents registered yet. Register via <code className="font-mono">POST /api/agents</code>{" "}
          with an ed25519 public key.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900/60 text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-4 py-2 font-medium">agent</th>
                <th className="px-4 py-2 font-medium">did</th>
                <th className="px-4 py-2 font-medium text-right">rep</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {agents.map((a, i) => (
                <tr key={a.did}>
                  <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{i + 1}</td>
                  <td className="px-4 py-2">{a.label || "—"}</td>
                  <td className="px-4 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                    {shortDid(a.did)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono font-medium">{a.rep}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
