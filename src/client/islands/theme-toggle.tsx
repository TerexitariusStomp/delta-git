/// <reference lib="dom" />

import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "@primer/octicons-react";

import { highlightThemeHref } from "@/client/highlight-theme";
import { hydrateIsland } from "@/client/hydrate";

export type ThemeToggleProps = Record<string, never>;

function applyHighlightTheme(theme: "light" | "dark") {
  const stylesheet = document.getElementById("hljs-theme");
  if (!(stylesheet instanceof HTMLLinkElement)) {
    return;
  }

  stylesheet.href = theme === "dark" ? highlightThemeHref.dark : highlightThemeHref.light;
}

function applyTheme(theme: "light" | "dark") {
  const root = document.documentElement;
  root.dataset.theme = theme;
  // Primer themes key off these attributes (see @primer/primitives CSS)
  root.dataset.colorMode = theme;
  root.dataset.lightTheme = "light";
  root.dataset.darkTheme = "dark";
  root.classList.toggle("dark", theme === "dark");
  applyHighlightTheme(theme);
}

export function ThemeToggleIsland(_props: ThemeToggleProps) {
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const initial = document.documentElement.classList.contains("dark") ? "dark" : "light";
    setTheme(initial);
    applyTheme(initial);
  }, []);

  return (
    <button
      type="button"
      data-theme-toggle
      className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--control-bgColor-hover)]"
      style={{ color: "var(--header-fgColor-default)" }}
      aria-label={`Toggle theme (current: ${theme === "dark" ? "Dark" : "Light"})`}
      onClick={() => {
        const nextTheme = theme === "dark" ? "light" : "dark";
        setTheme(nextTheme);
        applyTheme(nextTheme);
        try {
          localStorage.setItem("theme", nextTheme);
        } catch {}
      }}
    >
      <SunIcon className="icon-light" size={16} aria-hidden="true" />
      <MoonIcon className="icon-dark" size={16} aria-hidden="true" />
    </button>
  );
}

export function initThemeToggle() {
  hydrateIsland<ThemeToggleProps>("theme-toggle", ThemeToggleIsland);
}
