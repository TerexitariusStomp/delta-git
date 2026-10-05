/// <reference lib="dom" />

import { useEffect, useState } from "react";

import { hydrateIsland } from "@/client/hydrate";

export type ArenaPollProps = {
  owner: string;
  repo: string;
  matchId: string;
  /** SSR-rendered match status — a change triggers a page reload. */
  status: string;
  /** Current-phase deadline (epoch ms) for the countdown readout. */
  deadline: number | null;
};

const POLL_MS = 5000;

type MatchJson = {
  match?: { status?: string };
};

/**
 * Live match status chip: polls the match JSON while the match is live and
 * reloads the page when the phase flips (building → judging → resolved).
 * Polling keeps the architecture WebSocket-free.
 */
export function ArenaPollIsland({ owner, repo, matchId, status, deadline }: ArenaPollProps) {
  const [now, setNow] = useState(() => Date.now());
  const live = status === "building" || status === "judging" || status === "open";

  useEffect(() => {
    if (!live) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => {
      fetch(`/api/${owner}/${repo}/dg/matches/${matchId}`, {
        headers: { Accept: "application/json" },
      })
        .then((res) => (res.ok ? (res.json() as Promise<MatchJson>) : null))
        .then((data) => {
          const next = data?.match?.status;
          if (next && next !== status) window.location.reload();
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [live, owner, repo, matchId, status]);

  if (!live) {
    return (
      <span className="text-xs" style={{ color: "var(--fgColor-muted)" }}>
        match closed
      </span>
    );
  }

  const remaining = deadline ? Math.max(0, deadline - now) : null;
  const mm = remaining === null ? null : Math.floor(remaining / 60000);
  const ss = remaining === null ? null : Math.floor((remaining % 60000) / 1000);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{
        backgroundColor: "var(--bgColor-success-muted)",
        color: "var(--fgColor-success)",
      }}
    >
      <span aria-hidden="true">●</span> live
      {mm !== null ? ` · ${mm}:${String(ss).padStart(2, "0")}` : ""}
    </span>
  );
}

export function initArenaPoll() {
  hydrateIsland<ArenaPollProps>("arena-poll", ArenaPollIsland);
}
