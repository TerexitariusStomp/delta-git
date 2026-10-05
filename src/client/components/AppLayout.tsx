import type { ReactNode } from "react";

import { Header } from "@/client/components/header";
import { Footer } from "@/client/components/footer";
import type { Viewer } from "@/client/server/viewer";

type AppLayoutProps = {
  children: ReactNode;
  currentView?: string;
  viewer?: Viewer | null;
};

export function AppLayout({ children, currentView, viewer }: AppLayoutProps) {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[200] focus:rounded-md focus:px-4 focus:py-2"
        style={{
          backgroundColor: "var(--bgColor-accent-emphasis)",
          color: "var(--fgColor-onEmphasis)",
        }}
      >
        Skip to content
      </a>
      <div className="flex min-h-screen flex-col">
        <Header currentView={currentView} viewer={viewer ?? null} />
        <main id="main-content" className="w-full flex-1 min-w-0">
          {children}
        </main>
        <Footer />
      </div>
    </>
  );
}
