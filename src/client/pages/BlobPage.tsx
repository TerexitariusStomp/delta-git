import { Breadcrumbs } from "@/client/components/Breadcrumbs";
import { CodeViewer } from "@/client/components/CodeViewer";
import { MarkdownContent } from "@/client/components/MarkdownContent";
import { RepoNav } from "@/client/components/RepoNav";
import { BlobActionsIsland } from "@/client/islands/blob-actions";
import { IslandHost } from "@/client/server/IslandHost";

type BreadcrumbItem = {
  name: string;
  href: string | null;
};

export type BlobPageProps = {
  owner: string;
  repo: string;
  /** Show the Arena tab (artifacts repos). */
  arena?: boolean;
  refEnc: string;
  /** Raw ref name for the branch-picker label. */
  refShort?: string;
  fileName: string;
  codeLang?: string | null;
  lineCount?: number;
  sizeStr?: string;
  viewRawHref: string;
  rawHref: string;
  tooLarge?: boolean;
  isImage?: boolean;
  isPdf?: boolean;
  mediaSrc?: string;
  isMarkdown?: boolean;
  markdownRaw?: string;
  mdOwner?: string;
  mdRepo?: string;
  mdRef?: string;
  mdBase?: string;
  isBinary?: boolean;
  codeText?: string;
  breadcrumbs?: BreadcrumbItem[];
  parentHref?: string | null;
  visibility?: "public" | "private";
  description?: string;
};

export function BlobPage(props: BlobPageProps) {
  const {
    owner,
    repo,
    refEnc,
    refShort,
    fileName,
    codeLang,
    lineCount,
    sizeStr,
    viewRawHref,
    rawHref,
    tooLarge,
    isImage,
    isPdf,
    mediaSrc,
    isMarkdown,
    markdownRaw,
    mdOwner,
    mdRepo,
    mdRef,
    mdBase,
    isBinary,
    codeText,
    breadcrumbs,
    parentHref,
    visibility,
    description,
    arena,
  } = props;

  const showCopy = !isMarkdown && !isImage && !isPdf && !isBinary && !tooLarge;

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
        {/* GitHub-style toolbar: branch picker + path crumbs + actions */}
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
        </div>

        <div
          className="blob-container overflow-hidden rounded-md"
          style={{ border: "1px solid var(--borderColor-default)" }}
        >
          <div
            className="flex items-center justify-between gap-3 px-3 py-2"
            style={{
              backgroundColor: "var(--bgColor-muted)",
              borderBottom: "1px solid var(--borderColor-muted)",
            }}
          >
            <div
              className="flex min-w-0 items-center gap-2 text-xs"
              style={{ color: "var(--fgColor-muted)" }}
            >
              <span className="truncate font-semibold" style={{ color: "var(--fgColor-default)" }}>
                {fileName}
              </span>
              {lineCount ? (
                <span className="shrink-0">
                  {lineCount} line{lineCount === 1 ? "" : "s"}
                </span>
              ) : null}
              {sizeStr ? <span className="shrink-0">{sizeStr}</span> : null}
              {codeLang ? (
                <span
                  className="hidden shrink-0 rounded-md px-1.5 py-0.5 text-[11px] sm:inline"
                  style={{
                    backgroundColor: "var(--bgColor-default)",
                    border: "1px solid var(--borderColor-default)",
                  }}
                >
                  {codeLang}
                </span>
              ) : null}
            </div>
            <IslandHost
              name="blob-actions"
              props={{ viewRawHref, rawHref, showCopy, isImage, isPdf }}
              className="flex items-center gap-2"
            >
              <BlobActionsIsland
                viewRawHref={viewRawHref}
                rawHref={rawHref}
                showCopy={showCopy}
                isImage={isImage}
                isPdf={isPdf}
              />
            </IslandHost>
          </div>
          <div className={`${isMarkdown ? "p-5 sm:p-8" : isBinary || tooLarge ? "p-4" : "p-1"}`}>
            {tooLarge ? (
              <div style={{ color: "var(--fgColor-muted)" }}>File too large to preview.</div>
            ) : null}
            {!tooLarge && isImage && mediaSrc ? (
              <div className="flex items-center justify-center">
                <img
                  src={mediaSrc}
                  alt={fileName}
                  className="max-w-full rounded-md"
                  loading="lazy"
                />
              </div>
            ) : null}
            {!tooLarge && isPdf && mediaSrc ? (
              <div className="w-full" style={{ height: "75vh" }}>
                <iframe
                  src={mediaSrc}
                  className="h-full w-full rounded-md"
                  title={fileName}
                  loading="lazy"
                ></iframe>
              </div>
            ) : null}
            {!tooLarge && isMarkdown && markdownRaw && mdOwner && mdRepo && mdRef ? (
              <MarkdownContent
                markdown={markdownRaw}
                context={{ owner: mdOwner, repo: mdRepo, ref: mdRef, baseDir: mdBase || "" }}
              />
            ) : null}
            {!tooLarge && isBinary && !isImage && !isPdf ? (
              <div style={{ color: "var(--fgColor-muted)" }}>Binary file.</div>
            ) : null}
            {!tooLarge && !isBinary && !isMarkdown && codeText !== undefined ? (
              <CodeViewer code={codeText} language={codeLang || null} />
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
