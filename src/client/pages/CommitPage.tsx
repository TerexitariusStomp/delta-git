import { RepoNav } from "@/client/components/RepoNav";
import { CommitDiffExpanderIsland } from "@/client/islands/commit-diff-expander";
import { IslandHost } from "@/client/server/IslandHost";

type Parent = {
  oid: string;
  short: string;
};

type DiffEntry = {
  path: string;
  changeType: "A" | "M" | "D";
  oldOid?: string;
  newOid?: string;
  oldMode?: string;
  newMode?: string;
};

type DiffSummary = {
  added: number;
  modified: number;
  deleted: number;
  total: number;
};

export type CommitPageProps = {
  owner: string;
  repo: string;
  /** Show the Arena tab (artifacts repos). */
  arena?: boolean;
  commitOid: string;
  refEnc: string;
  commitShort: string;
  authorName: string;
  authorEmail: string;
  when: string;
  parents: Parent[];
  treeShort: string;
  message: string;
  diffBaseRefEnc: string;
  diffCompareMode: "root" | "first-parent";
  diffEntries: DiffEntry[];
  diffSummary: DiffSummary;
  diffTruncated: boolean;
  diffTruncateReason: "" | "max_files" | "max_tree_pairs" | "time_budget" | "soft_budget";
};

export function CommitPage({
  owner,
  repo,
  commitOid,
  refEnc,
  commitShort,
  authorName,
  authorEmail,
  when,
  parents,
  treeShort,
  message,
  diffBaseRefEnc,
  diffCompareMode,
  diffEntries,
  diffSummary,
  diffTruncated,
  diffTruncateReason,
  arena,
}: CommitPageProps) {
  const [subject, ...rest] = message.split("\n");
  const body = rest.join("\n").trim();

  return (
    <>
      <RepoNav owner={owner} repo={repo} currentTab="commits" arena={arena} />
      <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
        {/* GitHub commit header: subject line, author + meta block */}
        <h2
          className="m-0 text-xl font-semibold leading-snug"
          style={{ color: "var(--fgColor-default)" }}
        >
          {subject}
        </h2>
        {body ? (
          <pre
            className="mt-2 whitespace-pre-wrap rounded-md p-3 text-sm"
            style={{
              backgroundColor: "var(--bgColor-muted)",
              color: "var(--fgColor-default)",
            }}
          >
            {body}
          </pre>
        ) : null}
        <div
          className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-4 py-3 text-sm"
          style={{
            border: "1px solid var(--borderColor-default)",
            backgroundColor: "var(--bgColor-default)",
          }}
        >
          <span className="font-semibold" style={{ color: "var(--fgColor-default)" }}>
            {authorName}
          </span>
          <span style={{ color: "var(--fgColor-muted)" }}>
            &lt;{authorEmail}&gt; authored {when}
          </span>
          <span
            className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs"
            style={{ color: "var(--fgColor-muted)" }}
          >
            <span>
              commit{" "}
              <a
                href={`/${owner}/${repo}/commit/${commitOid}`}
                className="no-underline hover:underline"
                style={{ color: "var(--fgColor-muted)" }}
              >
                {commitShort}
              </a>
            </span>
            {parents.length ? (
              <span>
                {parents.length === 1 ? "parent" : "parents"}{" "}
                {parents.map((parent, index) => (
                  <span key={parent.oid}>
                    {index > 0 ? " " : null}
                    <a
                      href={`/${owner}/${repo}/commit/${parent.oid}`}
                      className="no-underline hover:underline"
                    >
                      {parent.short}
                    </a>
                  </span>
                ))}
              </span>
            ) : (
              <span>(root commit)</span>
            )}
            <span>
              tree{" "}
              <a
                href={`/${owner}/${repo}/tree?ref=${refEnc}`}
                className="no-underline hover:underline"
              >
                {treeShort}
              </a>
            </span>
          </span>
        </div>

        <h3
          className="mb-3 mt-8 text-base font-semibold"
          style={{ color: "var(--fgColor-default)" }}
        >
          Files changed
        </h3>
        <IslandHost
          name="commit-diff-expander"
          props={{
            owner,
            repo,
            commitOid,
            refEnc,
            diffBaseRefEnc,
            diffCompareMode,
            diffEntries,
            diffSummary,
            diffTruncated,
            diffTruncateReason,
            parentsCount: parents.length,
          }}
        >
          <CommitDiffExpanderIsland
            owner={owner}
            repo={repo}
            commitOid={commitOid}
            refEnc={refEnc}
            diffBaseRefEnc={diffBaseRefEnc}
            diffCompareMode={diffCompareMode}
            diffEntries={diffEntries}
            diffSummary={diffSummary}
            diffTruncated={diffTruncated}
            diffTruncateReason={diffTruncateReason}
            parentsCount={parents.length}
          />
        </IslandHost>
      </div>
    </>
  );
}
