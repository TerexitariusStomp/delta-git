export function Footer() {
  return (
    <footer className="shrink-0 border-t" style={{ borderColor: "var(--borderColor-muted)" }}>
      <div className="mx-auto flex max-w-[1280px] flex-col items-center gap-2 px-4 py-4 text-center sm:flex-row sm:items-center sm:gap-6 sm:px-6 sm:text-left">
        <a
          href="/"
          className="m-0 flex items-center gap-1.5 text-xs no-underline hover:no-underline"
          style={{ color: "var(--fgColor-muted)" }}
        >
          <img
            src="/gitflare-icon.png"
            alt=""
            width="48"
            height="20"
            className="block h-5 w-auto"
            aria-hidden="true"
          />
          <span>Gitflare</span>
        </a>
        <nav
          className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-xs"
          aria-label="Footer"
        >
          <a href="/rooted-finance/git-on-cloudflare" className="no-underline hover:underline">
            Source
          </a>
          <a href="https://wpcloud.delta-git.workers.dev" className="no-underline hover:underline">
            Apps
          </a>
          <a
            href="https://limic.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="no-underline hover:underline"
          >
            limic.dev
          </a>
        </nav>
      </div>
    </footer>
  );
}
