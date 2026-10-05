import {
  RepoIcon,
  RepoLockedIcon,
  HistoryIcon,
  CopilotIcon,
  LightBulbIcon,
  GearIcon,
  TrophyIcon,
} from "@primer/octicons-react";

export type RepoTab = "browse" | "commits" | "agents" | "ideas" | "arena" | "admin";

export type RepoNavCounts = {
  commits?: number;
  agents?: number;
  ideas?: number;
};

type RepoNavProps = {
  owner: string;
  repo: string;
  currentTab?: RepoTab;
  visibility?: "public" | "private";
  description?: string | null;
  counts?: RepoNavCounts;
  // Show the Arena tab (Artifacts-backed repos only — matches need forks).
  arena?: boolean;
};

/** GitHub's CounterLabel — muted pill for tab counters. */
function Counter({ value }: { value: number }) {
  return (
    <span
      className="inline-block min-w-5 rounded-full px-1.5 text-center text-xs font-medium"
      style={{
        backgroundColor: "var(--counter-bgColor-muted)",
        border: "1px solid var(--counter-borderColor)",
      }}
    >
      {value}
    </span>
  );
}

/** GitHub's visibility pill next to the repo name. */
function VisibilityBadge({ visibility }: { visibility: "public" | "private" }) {
  return (
    <span
      className="ml-1.5 inline-block rounded-full border px-[7px] py-px text-xs leading-[18px] font-medium"
      style={{
        borderColor: "var(--borderColor-default)",
        color: "var(--fgColor-muted)",
      }}
    >
      {visibility === "private" ? "Private" : "Public"}
    </span>
  );
}

function UnderlineTab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      className={[
        "inline-flex items-center gap-2 rounded-t-md border-b-2 px-2 py-2 text-sm no-underline hover:no-underline",
        "-mb-px whitespace-nowrap transition-colors",
        active ? "font-semibold" : "font-normal",
      ].join(" ")}
      style={{
        color: "var(--fgColor-default)",
        borderColor: active ? "var(--underlineNav-borderColor-active)" : "transparent",
      }}
    >
      {children}
    </a>
  );
}

export function RepoNav({
  owner,
  repo,
  currentTab,
  visibility,
  description,
  counts,
  arena,
}: RepoNavProps) {
  const base = `/${owner}/${repo}`;
  return (
    <div className="w-full border-b" style={{ borderColor: "var(--borderColor-muted)" }}>
      <div className="mx-auto w-full max-w-[1280px] px-4 pt-4 sm:px-6">
        <h1 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xl font-normal">
          <span style={{ color: "var(--fgColor-muted)" }} aria-hidden="true">
            {visibility === "private" ? <RepoLockedIcon size={16} /> : <RepoIcon size={16} />}
          </span>
          <span className="flex items-baseline gap-0.5">
            <a href={`/${owner}`}>{owner}</a>
            <span className="mx-0.5" style={{ color: "var(--fgColor-muted)" }}>
              /
            </span>
            <a href={base} className="font-semibold">
              {repo}
            </a>
          </span>
          {visibility ? <VisibilityBadge visibility={visibility} /> : null}
        </h1>
        {description ? (
          <p className="mb-0 mt-1 text-sm" style={{ color: "var(--fgColor-muted)" }}>
            {description}
          </p>
        ) : null}
      </div>
      <nav
        className="mx-auto mt-4 flex w-full max-w-[1280px] overflow-x-auto px-2 sm:px-4"
        aria-label="Repository navigation"
      >
        <UnderlineTab href={base} active={currentTab === "browse"}>
          <RepoIcon size={16} aria-hidden="true" />
          Browse
        </UnderlineTab>
        <UnderlineTab href={`${base}/commits`} active={currentTab === "commits"}>
          <HistoryIcon size={16} aria-hidden="true" />
          Commits
          {counts?.commits !== undefined ? <Counter value={counts.commits} /> : null}
        </UnderlineTab>
        <UnderlineTab href={`${base}/agents`} active={currentTab === "agents"}>
          <CopilotIcon size={16} aria-hidden="true" />
          Agents
          {counts?.agents !== undefined ? <Counter value={counts.agents} /> : null}
        </UnderlineTab>
        <UnderlineTab href={`${base}/ideas`} active={currentTab === "ideas"}>
          <LightBulbIcon size={16} aria-hidden="true" />
          Ideas
          {counts?.ideas !== undefined ? <Counter value={counts.ideas} /> : null}
        </UnderlineTab>
        {arena ? (
          <UnderlineTab href={`${base}/arena`} active={currentTab === "arena"}>
            <TrophyIcon size={16} aria-hidden="true" />
            Arena
          </UnderlineTab>
        ) : null}
        <UnderlineTab href={`${base}/admin`} active={currentTab === "admin"}>
          <GearIcon size={16} aria-hidden="true" />
          Admin
        </UnderlineTab>
      </nav>
    </div>
  );
}
