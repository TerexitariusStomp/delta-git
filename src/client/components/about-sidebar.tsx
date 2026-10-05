import {
  BookIcon,
  GitBranchIcon,
  LawIcon,
  LightBulbIcon,
  LinkIcon,
  TagIcon,
} from "@primer/octicons-react";

export type AboutSidebarProps = {
  owner: string;
  repo: string;
  description?: string | null;
  /** Federation repo DID (did:dg:repo:…). */
  repoDid?: string;
  /** Browsable Radicle gateway URL when a rad: mirror target exists. */
  radicleUrl?: string;
  licenseFile?: { name: string; href: string } | null;
  branchCount: number;
  tagCount: number;
  openIdeaCount?: number;
  branchesHref: string;
  tagsHref: string;
  ideasHref: string;
};

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm" style={{ color: "var(--fgColor-muted)" }}>
      {children}
    </div>
  );
}

export function AboutSidebar({
  description,
  repoDid,
  radicleUrl,
  licenseFile,
  branchCount,
  tagCount,
  openIdeaCount,
  branchesHref,
  tagsHref,
  ideasHref,
}: AboutSidebarProps) {
  return (
    <aside className="w-full text-sm lg:w-[296px] lg:shrink-0">
      <h2 className="mb-2 mt-0 text-base font-semibold" style={{ color: "var(--fgColor-default)" }}>
        About
      </h2>
      {description ? (
        <p className="mb-4 text-sm" style={{ color: "var(--fgColor-default)" }}>
          {description}
        </p>
      ) : (
        <p className="mb-4 text-sm italic" style={{ color: "var(--fgColor-muted)" }}>
          No description
        </p>
      )}
      <div className="space-y-3">
        {repoDid ? (
          <Row>
            <LinkIcon size={16} aria-hidden="true" />
            <code className="truncate text-xs" title={repoDid}>
              {repoDid}
            </code>
          </Row>
        ) : null}
        {radicleUrl ? (
          <Row>
            <LinkIcon size={16} aria-hidden="true" />
            <a
              href={radicleUrl}
              target="_blank"
              rel="noreferrer"
              className="truncate no-underline hover:underline"
            >
              Radicle mirror
            </a>
          </Row>
        ) : null}
        {licenseFile ? (
          <Row>
            <LawIcon size={16} aria-hidden="true" />
            <a href={licenseFile.href} className="truncate no-underline hover:underline">
              {licenseFile.name}
            </a>
          </Row>
        ) : null}
        <Row>
          <BookIcon size={16} aria-hidden="true" />
          <span>Readme</span>
        </Row>
      </div>
      <div
        className="mt-4 space-y-3 border-t pt-4"
        style={{ borderColor: "var(--borderColor-muted)" }}
      >
        <Row>
          <GitBranchIcon size={16} aria-hidden="true" />
          <a href={branchesHref} className="no-underline hover:underline">
            <strong className="font-semibold" style={{ color: "var(--fgColor-default)" }}>
              {branchCount}
            </strong>{" "}
            {branchCount === 1 ? "branch" : "branches"}
          </a>
        </Row>
        <Row>
          <TagIcon size={16} aria-hidden="true" />
          <a href={tagsHref} className="no-underline hover:underline">
            <strong className="font-semibold" style={{ color: "var(--fgColor-default)" }}>
              {tagCount}
            </strong>{" "}
            {tagCount === 1 ? "tag" : "tags"}
          </a>
        </Row>
        {openIdeaCount !== undefined ? (
          <Row>
            <LightBulbIcon size={16} aria-hidden="true" />
            <a href={ideasHref} className="no-underline hover:underline">
              <strong className="font-semibold" style={{ color: "var(--fgColor-default)" }}>
                {openIdeaCount}
              </strong>{" "}
              open {openIdeaCount === 1 ? "idea" : "ideas"}
            </a>
          </Row>
        ) : null}
      </div>
    </aside>
  );
}
