import { RepoNav } from "@/client/components/RepoNav";
import { type Progress, ProgressBanner } from "@/client/components/ProgressBanner";
import { FileTable, type FileRow, type FileRowLastChange } from "@/client/components/file-table";
import { CloneMenu } from "@/client/components/clone-menu";
import { AboutSidebar } from "@/client/components/about-sidebar";
import { MarkdownContent } from "@/client/components/MarkdownContent";
import { CommentDiscussionIcon, ArrowRightIcon, BookIcon } from "@primer/octicons-react";
import { IslandHost } from "@/client/server/IslandHost";

export type OverviewPageProps = {
  owner: string;
  repo: string;
  /** Show the Arena tab (artifacts repos). */
  arena?: boolean;
  refShort: string;
  refEnc: string;
  branches?: { name: string; href: string }[];
  tags?: { name: string; href: string }[];
  readmeMd?: string;
  progress?: Progress;
  repoDid?: string;
  radicleUrl?: string;
  ideas?: { id: string; title: string; status: string }[];
  visibility?: "public" | "private";
  description?: string;
  headCommit?: FileRowLastChange;
  /** Exact first-parent commit count when the bounded walk reached the root. */
  commitCount?: number;
  fileRows?: FileRow[];
  cloneUrl?: string;
  licenseFile?: string;
  counts?: { branches?: number; tags?: number; ideas?: number };
};

export function OverviewPage({
  owner,
  repo,
  refShort,
  refEnc,
  branches = [],
  tags = [],
  readmeMd,
  progress,
  repoDid,
  radicleUrl,
  ideas = [],
  visibility,
  description,
  arena,
  headCommit,
  commitCount,
  fileRows = [],
  cloneUrl,
  licenseFile,
  counts,
}: OverviewPageProps) {
  const base = `/${owner}/${repo}`;
  const wpCloudUrl = `https://wpcloud.delta-git.workers.dev/?repo=${encodeURIComponent(
    `${owner}/${repo}`
  )}`;
  return (
    <>
      <RepoNav
        owner={owner}
        repo={repo}
        currentTab="browse"
        visibility={visibility}
        description={description}
        arena={arena}
        counts={counts}
      />
      <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
        <ProgressBanner progress={progress} />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_296px]">
          <div className="min-w-0">
            {/* Branch picker + clone menu row */}
            <div className="mb-3 flex items-center justify-between gap-3">
              <IslandHost name="ref-picker" props={{ owner, repo, currentRef: refShort }}>
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold"
                  style={{
                    backgroundColor: "var(--bgColor-default)",
                    border: "1px solid var(--borderColor-default)",
                    color: "var(--fgColor-default)",
                  }}
                >
                  <span style={{ color: "var(--fgColor-muted)" }}>
                    <GitBranchGlyph />
                  </span>
                  {refShort}
                </button>
              </IslandHost>
              <div className="hidden text-sm sm:block" style={{ color: "var(--fgColor-muted)" }}>
                <a
                  href={`${base}/tree?ref=${refEnc}`}
                  className="font-semibold hover:underline"
                  style={{ color: "var(--fgColor-default)" }}
                >
                  {counts?.branches ?? branches.length}
                </a>{" "}
                branches{" "}
                <a
                  href={`${base}/tree?ref=${refEnc}`}
                  className="font-semibold hover:underline"
                  style={{ color: "var(--fgColor-default)" }}
                >
                  {counts?.tags ?? tags.length}
                </a>{" "}
                tags
              </div>
              {cloneUrl ? <CloneMenu cloneUrl={cloneUrl} /> : null}
            </div>

            <FileTable
              owner={owner}
              repo={repo}
              rows={fileRows}
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

            {/* README card */}
            {readmeMd ? (
              <section
                className="mt-4 rounded-md"
                style={{ border: "1px solid var(--borderColor-default)" }}
                aria-labelledby="readme-heading"
              >
                <h2
                  id="readme-heading"
                  className="m-0 flex items-center gap-2 rounded-t-md px-4 py-2.5 text-sm font-semibold"
                  style={{
                    borderBottom: "1px solid var(--borderColor-muted)",
                    color: "var(--fgColor-default)",
                  }}
                >
                  <BookIcon size={16} />
                  README.md
                </h2>
                <article className="p-4 sm:p-8">
                  <MarkdownContent
                    markdown={readmeMd}
                    context={{ owner, repo, ref: refShort, baseDir: "" }}
                  />
                </article>
              </section>
            ) : null}
          </div>

          <aside className="min-w-0">
            <AboutSidebar
              owner={owner}
              repo={repo}
              description={description}
              repoDid={repoDid}
              radicleUrl={radicleUrl}
              licenseFile={
                licenseFile
                  ? {
                      name: licenseFile,
                      href: `${base}/blob?ref=${refEnc}&path=${encodeURIComponent(licenseFile)}`,
                    }
                  : null
              }
              branchCount={counts?.branches ?? branches.length}
              tagCount={counts?.tags ?? tags.length}
              openIdeaCount={counts?.ideas}
              branchesHref={`${base}/tree?ref=${refEnc}`}
              tagsHref={`${base}/tree?ref=${refEnc}`}
              ideasHref={`${base}/ideas`}
            />
            <a
              href={wpCloudUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block text-sm no-underline hover:underline"
              style={{ color: "var(--fgColor-muted)" }}
            >
              Deploy with wp-cloud ↗
            </a>
            {/* Ideas preview — delta-git's native concept surfaced like a
                "recent issues" rail */}
            {ideas.length > 0 ? (
              <section className="mt-6" aria-labelledby="overview-ideas">
                <h3
                  id="overview-ideas"
                  className="mb-2 flex items-center gap-2 text-sm font-semibold"
                  style={{ color: "var(--fgColor-default)" }}
                >
                  <CommentDiscussionIcon size={16} />
                  Open ideas
                </h3>
                <ul className="m-0 list-none p-0">
                  {ideas.map((idea) => (
                    <li
                      key={idea.id}
                      className="py-1.5 text-sm"
                      style={{ borderBottom: "1px solid var(--borderColor-muted)" }}
                    >
                      <a
                        href={`${base}/ideas`}
                        className="font-medium hover:underline"
                        style={{ color: "var(--fgColor-default)" }}
                      >
                        {idea.title}
                      </a>
                    </li>
                  ))}
                </ul>
                <a
                  href={`${base}/ideas`}
                  className="mt-2 inline-flex items-center gap-1 text-sm font-semibold"
                >
                  View all ideas <ArrowRightIcon size={12} />
                </a>
              </section>
            ) : null}
          </aside>
        </div>
      </div>
    </>
  );
}

function GitBranchGlyph() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" />
    </svg>
  );
}
