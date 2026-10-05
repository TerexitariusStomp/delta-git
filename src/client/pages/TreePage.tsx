import { Breadcrumbs } from "@/client/components/Breadcrumbs";
import { type Progress, ProgressBanner } from "@/client/components/ProgressBanner";
import { RepoNav } from "@/client/components/RepoNav";
import { FileTable, type FileRow, type FileRowLastChange } from "@/client/components/file-table";
import { CloneMenu } from "@/client/components/clone-menu";
import { IslandHost } from "@/client/server/IslandHost";

type Breadcrumb = {
  name: string;
  href: string | null;
};

export type TreePageProps = {
  owner: string;
  repo: string;
  /** Show the Arena tab (artifacts repos). */
  arena?: boolean;
  refEnc: string;
  /** Raw (unencoded) ref name, for the branch-picker trigger label. */
  refShort?: string;
  fileRows?: FileRow[];
  headCommit?: FileRowLastChange;
  /** Exact first-parent commit count when the bounded walk reached the root. */
  commitCount?: number;
  currentPath?: string;
  breadcrumbs?: Breadcrumb[];
  parentHref?: string | null;
  progress?: Progress;
  visibility?: "public" | "private";
  description?: string;
  cloneUrl?: string;
};

export function TreePage({
  owner,
  repo,
  refEnc,
  refShort,
  fileRows = [],
  headCommit,
  commitCount,
  currentPath = "",
  breadcrumbs,
  parentHref,
  progress,
  visibility,
  description,
  arena,
  cloneUrl,
}: TreePageProps) {
  const base = `/${owner}/${repo}`;
  return (
    <>
      <RepoNav
        owner={owner}
        repo={repo}
        currentTab="browse"
        visibility={visibility}
        description={description}
        arena={arena}
      />
      <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
        <ProgressBanner progress={progress} />
        <div className="min-w-0">
          {/* Branch picker + breadcrumbs + clone menu row */}
          <div className="mb-3 flex items-center gap-3">
            <IslandHost name="ref-picker" props={{ owner, repo, currentRef: refShort ?? refEnc }}>
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold"
                style={{
                  backgroundColor: "var(--bgColor-default)",
                  border: "1px solid var(--borderColor-default)",
                  color: "var(--fgColor-default)",
                }}
              >
                {refShort ?? refEnc}
              </button>
            </IslandHost>
            <div className="min-w-0 flex-1">
              <Breadcrumbs items={breadcrumbs} parentHref={parentHref} />
            </div>
            {cloneUrl ? <CloneMenu cloneUrl={cloneUrl} /> : null}
          </div>
          <FileTable
            owner={owner}
            repo={repo}
            rows={fileRows}
            parentHref={currentPath ? parentHref : undefined}
            commitBar={
              headCommit
                ? {
                    ...headCommit,
                    commitCount,
                    commitsHref: `${base}/commits?ref=${refEnc}`,
                    commitHref: `${base}/commit/${headCommit.oid}`,
                  }
                : undefined
            }
          />
        </div>
      </div>
    </>
  );
}
