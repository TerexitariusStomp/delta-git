import { SignInIcon, PersonIcon, SignOutIcon } from "@primer/octicons-react";

import { IslandHost } from "@/client/server/IslandHost";
import { ThemeToggleIsland } from "@/client/islands/theme-toggle";
import type { Viewer } from "@/client/server/viewer";

type HeaderProps = {
  currentView?: string;
  viewer?: Viewer | null;
};

const navLinkClass = (isActive: boolean): string =>
  [
    "flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold transition-colors hover:bg-[var(--control-bgColor-hover)] no-underline hover:no-underline",
    isActive ? "underline underline-offset-4" : "",
  ].join(" ");

const navLinkStyle = { color: "var(--header-fgColor-default)" };

function AnonymousNav({ currentView }: { currentView?: string }) {
  return (
    <a href="/auth" className={navLinkClass(currentView === "auth-signin")} style={navLinkStyle}>
      <SignInIcon size={16} aria-hidden="true" />
      Sign in
    </a>
  );
}

function SignedInNav({ currentView, viewer }: { currentView?: string; viewer: Viewer }) {
  return (
    <>
      <a
        href="/auth/account"
        className={navLinkClass(currentView === "account")}
        style={navLinkStyle}
      >
        <PersonIcon size={16} aria-hidden="true" />
        {viewer.primaryNamespaceSlug ? `@${viewer.primaryNamespaceSlug}` : "Account"}
      </a>
      {/* Sign-out is a same-origin POST; the form preserves Lax cookies. */}
      <form method="post" action="/auth/sign-out" className="contents">
        <button type="submit" className={navLinkClass(false)} style={navLinkStyle}>
          <SignOutIcon size={16} aria-hidden="true" />
          Sign out
        </button>
      </form>
    </>
  );
}

export function Header({ currentView, viewer }: HeaderProps) {
  return (
    <header
      className="sticky top-0 z-50 w-full border-b"
      style={{
        backgroundColor: "var(--header-bgColor)",
        borderColor: "var(--header-borderColor-divider)",
      }}
    >
      <div className="flex w-full items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <nav className="flex items-center gap-3" aria-label="Primary">
          <a
            href="/"
            className="group flex items-center gap-2.5 transition-opacity hover:opacity-80 no-underline hover:no-underline"
          >
            <span
              className="transition-transform duration-200 group-hover:-rotate-6"
              aria-hidden="true"
            >
              <img src="/gitflare-icon.png" alt="" width="64" height="27" className="block h-8 w-auto" />
            </span>
            <span className="hidden sm:block">
              <strong
                className="block text-sm font-semibold"
                style={{ color: "var(--header-fgColor-logo)" }}
              >
                Gitflare
              </strong>
              <small className="block text-xs" style={{ color: "var(--header-fgColor-default)" }}>
                GitHub on Cloudflare
              </small>
            </span>
          </a>
          {viewer ? (
            <SignedInNav currentView={currentView} viewer={viewer} />
          ) : (
            <AnonymousNav currentView={currentView} />
          )}
        </nav>
        <IslandHost name="theme-toggle" props={{}}>
          <ThemeToggleIsland />
        </IslandHost>
      </div>
    </header>
  );
}
