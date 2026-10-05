/// <reference lib="dom" />

import type { MouseEvent } from "react";
import { Fragment, useState } from "react";

import { hydrateIsland } from "@/client/hydrate";
import { CommitRow } from "@/client/components/CommitRow";

type CommitView = {
  oid: string;
  shortOid: string;
  firstLine: string;
  authorName: string;
  when: string;
  whenEpoch?: number;
  isMerge?: boolean;
};

export type MergeExpanderProps = {
  owner: string;
  repo: string;
  commits: CommitView[];
};

function MergeStatusRow({ message }: { message: string }) {
  return (
    <tr>
      <td colSpan={3} style={{ color: "var(--fgColor-muted)" }}>
        {message}
      </td>
    </tr>
  );
}

/** GitHub groups the commit list by author date ("Commits on Oct 5, 2026"). */
function dayGroupLabel(commit: CommitView): string {
  if (!commit.whenEpoch) return "Commits";
  const d = new Date(commit.whenEpoch * 1000);
  return `Commits on ${d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })}`;
}

export function MergeExpanderIsland({ owner, repo, commits }: MergeExpanderProps) {
  const [expandedByOid, setExpandedByOid] = useState<Record<string, boolean>>({});
  const [loadingByOid, setLoadingByOid] = useState<Record<string, boolean>>({});
  const [errorByOid, setErrorByOid] = useState<Record<string, string | null>>({});
  const [mergeRowsByOid, setMergeRowsByOid] = useState<Record<string, CommitView[]>>({});

  async function toggleMerge(oid: string) {
    if (loadingByOid[oid]) {
      return;
    }

    if (expandedByOid[oid]) {
      setExpandedByOid((current) => ({ ...current, [oid]: false }));
      return;
    }

    if (mergeRowsByOid[oid]) {
      setExpandedByOid((current) => ({ ...current, [oid]: true }));
      setErrorByOid((current) => ({ ...current, [oid]: null }));
      return;
    }

    setLoadingByOid((current) => ({ ...current, [oid]: true }));
    setExpandedByOid((current) => ({ ...current, [oid]: true }));
    setErrorByOid((current) => ({ ...current, [oid]: null }));

    try {
      const response = await fetch(`/${owner}/${repo}/commits/fragments/${oid}?limit=20`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as { commits?: CommitView[] };
      setMergeRowsByOid((current) => ({ ...current, [oid]: data.commits || [] }));
    } catch (error) {
      setErrorByOid((current) => ({
        ...current,
        [oid]: error instanceof Error ? error.message : "Failed to load merge commits",
      }));
    } finally {
      setLoadingByOid((current) => ({ ...current, [oid]: false }));
    }
  }

  function onMergeRowClick(oid: string) {
    return (event: MouseEvent<HTMLTableRowElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest("a, button")) {
        return;
      }

      void toggleMerge(oid);
    };
  }

  // Group consecutive commits by author-day, like GitHub's commit list.
  const groups: { label: string; commits: CommitView[] }[] = [];
  for (const commit of commits) {
    const label = dayGroupLabel(commit);
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.commits.push(commit);
    } else {
      groups.push({ label, commits: [commit] });
    }
  }

  return (
    <div id="commits-table" data-owner={owner} data-repo={repo} className="mt-4 space-y-4">
      {groups.length ? (
        groups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h3
              className="mb-2 mt-0 flex items-center gap-2 text-sm font-semibold"
              style={{ color: "var(--fgColor-default)" }}
            >
              {group.label}
            </h3>
            <div
              className="overflow-hidden rounded-md"
              style={{ border: "1px solid var(--borderColor-default)" }}
            >
              <table>
                <tbody>
                  {group.commits.map((commit) => {
                    const isMerge = Boolean(commit.isMerge);
                    const mergeOid = commit.oid;
                    const isExpanded = Boolean(expandedByOid[mergeOid]);
                    const isLoading = Boolean(loadingByOid[mergeOid]);
                    const mergeRows = mergeRowsByOid[mergeOid] || [];
                    const error = errorByOid[mergeOid];

                    return (
                      <Fragment key={commit.oid}>
                        <CommitRow
                          owner={owner}
                          repo={repo}
                          commit={commit}
                          isMerge={isMerge}
                          toggleOid={isMerge ? mergeOid : undefined}
                          mergeExpanded={isExpanded}
                          onToggle={isMerge ? onMergeRowClick(mergeOid) : undefined}
                        />
                        {isMerge && isExpanded && isLoading ? (
                          <MergeStatusRow message="Loading…" />
                        ) : null}
                        {isMerge && isExpanded && !isLoading && error ? (
                          <MergeStatusRow message={`Failed to load merge commits: ${error}`} />
                        ) : null}
                        {isMerge && isExpanded && !isLoading && !error && !mergeRows.length ? (
                          <MergeStatusRow message="(No commits to show for this merge yet)" />
                        ) : null}
                        {isMerge && isExpanded && !isLoading && !error
                          ? mergeRows.map((entry) => (
                              <CommitRow
                                key={entry.oid}
                                owner={owner}
                                repo={repo}
                                commit={entry}
                                compact
                                mergeOf={mergeOid}
                              />
                            ))
                          : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))
      ) : (
        <div
          className="rounded-md p-6 text-center text-sm"
          style={{
            border: "1px solid var(--borderColor-default)",
            color: "var(--fgColor-muted)",
          }}
        >
          No commits yet
        </div>
      )}
    </div>
  );
}

export function initMergeExpander() {
  hydrateIsland<MergeExpanderProps>("merge-expander", MergeExpanderIsland);
}
