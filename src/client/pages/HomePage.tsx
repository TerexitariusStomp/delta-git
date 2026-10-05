import { ArrowRightIcon, MarkGithubIcon, RepoIcon, KeyIcon } from "@primer/octicons-react";

export type HomePageProps = {
  /** Deployment origin — used to render the git clone URL for this host. */
  origin?: string;
};

/** GitHub-dashboard-style landing: hero, clone box, apps rail, quick links. */
export function HomePage({ origin = "" }: HomePageProps) {
  const cardStyle = {
    border: "1px solid var(--borderColor-default)",
    backgroundColor: "var(--bgColor-default)",
  } as const;
  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-10 sm:px-6">
      <section className="mb-10">
        <div className="flex items-center gap-3">
          <span style={{ color: "var(--fgColor-default)" }} aria-hidden="true">
            <MarkGithubIcon size={40} />
          </span>
          <h1
            className="m-0 text-3xl font-semibold tracking-tight sm:text-4xl"
            style={{ color: "var(--fgColor-default)" }}
          >
            git-on-cloudflare
          </h1>
        </div>
        <p className="mb-0 mt-3 max-w-xl text-base" style={{ color: "var(--fgColor-muted)" }}>
          A full Git Smart HTTP v2 server running entirely on Cloudflare Workers. Clone, push, and
          browse repositories — at the edge.
        </p>
      </section>

      <section className="mb-10">
        <div
          className="overflow-hidden rounded-md font-mono text-sm"
          style={{ ...cardStyle, backgroundColor: "var(--bgColor-muted)" }}
        >
          <div
            className="flex items-center gap-2 px-4 py-2"
            style={{ borderBottom: "1px solid var(--borderColor-muted)" }}
          >
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: "#ff5f57" }} />
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: "#febc2e" }} />
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: "#28c840" }} />
            <span className="ml-2 text-xs" style={{ color: "var(--fgColor-muted)" }}>
              terminal
            </span>
          </div>
          <div className="px-4 py-3">
            <span className="select-none" style={{ color: "var(--fgColor-muted)" }}>
              ${" "}
            </span>
            <span style={{ color: "var(--fgColor-default)" }}>
              git clone {origin}/rooted-finance/git-on-cloudflare
            </span>
          </div>
        </div>
      </section>

      <section className="mb-10" aria-label="Apps built on delta-git">
        <h2
          className="m-0 mb-3 text-base font-semibold"
          style={{ color: "var(--fgColor-default)" }}
        >
          Apps built on delta-git
        </h2>
        <div className="rounded-md p-4" style={cardStyle}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold" style={{ color: "var(--fgColor-default)" }}>
              wp-cloud
            </span>
            <span className="flex items-center gap-4 text-sm">
              <a
                href="https://wpcloud.delta-git.workers.dev"
                className="inline-flex items-center gap-1 font-semibold no-underline hover:underline"
              >
                Launch app
                <ArrowRightIcon size={12} aria-hidden="true" />
              </a>
              <a
                href="/rooted-finance/wp-cloud"
                className="inline-flex items-center gap-1 font-semibold no-underline hover:underline"
              >
                Source
                <ArrowRightIcon size={12} aria-hidden="true" />
              </a>
            </span>
          </div>
          <p className="mb-0 mt-1 text-sm" style={{ color: "var(--fgColor-muted)" }}>
            WordPress hosting on the edge — deploy a site straight from any repo on this forge.
            Static and dynamic lanes, USDC credits, push-to-redeploy via signed webhooks.
          </p>
        </div>
      </section>

      <section aria-label="Quick links">
        <div className="grid gap-4 sm:grid-cols-2">
          <a
            href="/rooted-finance/git-on-cloudflare"
            className="group block rounded-md p-4 no-underline"
            style={cardStyle}
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <RepoIcon size={16} aria-hidden="true" />
              Browse source
            </span>
            <span
              className="mt-1 flex items-center justify-between text-sm"
              style={{ color: "var(--fgColor-muted)" }}
            >
              <span>
                Explore the{" "}
                <span className="font-semibold" style={{ color: "var(--fgColor-link)" }}>
                  git-on-cloudflare
                </span>{" "}
                repository — code, commits, and trees.
              </span>
              <ArrowRightIcon size={14} aria-hidden="true" className="ml-2 shrink-0" />
            </span>
          </a>
          <a href="/auth" className="group block rounded-md p-4 no-underline" style={cardStyle}>
            <span className="flex items-center gap-2 text-sm font-semibold">
              <KeyIcon size={16} aria-hidden="true" />
              Manage auth
            </span>
            <span
              className="mt-1 flex items-center justify-between text-sm"
              style={{ color: "var(--fgColor-muted)" }}
            >
              <span>
                Configure <span className="font-semibold">owners</span> and{" "}
                <span className="font-semibold">access tokens</span> for push access.
              </span>
              <ArrowRightIcon size={14} aria-hidden="true" className="ml-2 shrink-0" />
            </span>
          </a>
        </div>
      </section>
    </div>
  );
}
