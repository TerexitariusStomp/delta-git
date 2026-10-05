import { Pager } from "@/client/components/Pager";
import { type Progress, ProgressBanner } from "@/client/components/ProgressBanner";
import { RepoNav } from "@/client/components/RepoNav";
import { MergeExpanderIsland } from "@/client/islands/merge-expander";
import { IslandHost } from "@/client/server/IslandHost";

type CommitView = {
  oid: string;
  shortOid: string;
  firstLine: string;
  authorName: string;
  when: string;
  isMerge?: boolean;
};

type PagerModel = {
  perPageLinks: Array<{ text: string; href: string }>;
  newerHref?: string;
  olderHref?: string;
};

export type CommitsPageProps = {
  owner: string;
  repo: string;
  /** Show the Arena tab (artifacts repos). */
  arena?: boolean;
  ref: string;
  refEnc: string;
  commits: CommitView[];
  pager?: PagerModel;
  progress?: Progress;
};

export function CommitsPage({
  owner,
  repo,
  arena,
  ref,
  commits,
  pager,
  progress,
}: CommitsPageProps) {
  const refLabel =
    ref.length === 40 ? (
      <>
        <span className="font-mono sm:hidden">{ref.slice(0, 12)}…</span>
        <span className="hidden font-mono sm:inline">{ref}</span>
      </>
    ) : (
      <span className="font-mono">{ref}</span>
    );

  return (
    <>
      <RepoNav owner={owner} repo={repo} currentTab="commits" arena={arena} />
      <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
        <ProgressBanner progress={progress} />
        <div className="mb-3 flex items-center gap-3">
          <IslandHost name="ref-picker" props={{ owner, repo, currentRef: ref }}>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold"
              style={{
                backgroundColor: "var(--bgColor-default)",
                border: "1px solid var(--borderColor-default)",
                color: "var(--fgColor-default)",
              }}
            >
              {refLabel}
            </button>
          </IslandHost>
          <h2 className="m-0 text-base font-semibold" style={{ color: "var(--fgColor-default)" }}>
            Commits
          </h2>
        </div>
        <IslandHost name="merge-expander" props={{ owner, repo, commits }}>
          <MergeExpanderIsland owner={owner} repo={repo} commits={commits} />
        </IslandHost>
        <Pager pager={pager} />
      </div>
    </>
  );
}
