/// <reference lib="dom" />

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, GitBranchIcon, TagIcon } from "@primer/octicons-react";

import { hydrateIsland } from "@/client/hydrate";
import { buttonClasses } from "@/client/components/ui/button";

type RefItem = {
  name: string;
  displayName: string;
};

type RefApiResponse = {
  branches?: RefItem[];
  tags?: RefItem[];
};

export type RefPickerProps = {
  owner: string;
  repo: string;
  currentRef: string;
};

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function formatRefLabel(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? `${ref.slice(0, 7)}...` : ref || "...";
}

function buildRefHref(currentUrl: string, nextRef: string): string {
  const url = new URL(currentUrl);
  url.searchParams.set("ref", nextRef);
  return url.toString();
}

function RefPickerSection({
  title,
  kind,
  currentRef,
  currentUrl,
  items,
  query,
}: {
  title: string;
  kind: "branch" | "tag";
  currentRef: string;
  currentUrl: string | null;
  items: RefItem[];
  query: string;
}) {
  const filtered = items.filter((item) => item.displayName.toLowerCase().includes(query));
  if (!filtered.length) {
    return null;
  }

  const Icon = kind === "branch" ? GitBranchIcon : TagIcon;

  return (
    <>
      <div
        className="mt-1 px-2 py-1 text-xs font-semibold uppercase"
        style={{ color: "var(--fgColor-muted)" }}
      >
        {title}
      </div>
      {filtered.map((item) => {
        const raw = decodeSafe(item.name);
        const isCurrent = raw === currentRef;
        const href = currentUrl ? buildRefHref(currentUrl, raw) : null;
        return isCurrent ? (
          <span
            key={`${title}-${item.name}`}
            className="flex items-center gap-2 rounded-md px-2 py-1.5"
            style={{
              border: "1px solid var(--borderColor-accent-muted)",
              backgroundColor: "var(--bgColor-accent-muted)",
              color: "var(--fgColor-accent)",
            }}
          >
            <CheckIcon size={16} aria-hidden="true" />
            <span className="h-4 w-4 shrink-0" style={{ color: "var(--fgColor-muted)" }}>
              <Icon size={16} aria-hidden="true" />
            </span>
            <span className="font-medium">{item.displayName}</span>
          </span>
        ) : href ? (
          <a
            key={`${title}-${item.name}`}
            href={href}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 no-underline"
            style={{ color: "var(--fgColor-default)" }}
          >
            <span className="h-4 w-4 flex-shrink-0"></span>
            <span className="h-4 w-4 shrink-0" style={{ color: "var(--fgColor-muted)" }}>
              <Icon size={16} aria-hidden="true" />
            </span>
            <span>{item.displayName}</span>
          </a>
        ) : (
          <span
            key={`${title}-${item.name}`}
            className="flex items-center gap-2 rounded-md px-2 py-1.5"
            style={{ color: "var(--fgColor-default)" }}
          >
            <span className="h-4 w-4 flex-shrink-0"></span>
            <span className="h-4 w-4 shrink-0" style={{ color: "var(--fgColor-muted)" }}>
              <Icon size={16} aria-hidden="true" />
            </span>
            <span>{item.displayName}</span>
          </span>
        );
      })}
    </>
  );
}

export function RefPickerIsland({ owner, repo, currentRef }: RefPickerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<RefApiResponse>({ branches: [], tags: [] });

  useEffect(() => {
    setCurrentUrl(window.location.href);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadRefs() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/${owner}/${repo}/api/refs`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const nextData = (await response.json()) as RefApiResponse;
        if (!cancelled) {
          setData({
            branches: nextData.branches || [],
            tags: nextData.tags || [],
          });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load refs");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadRefs();
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const timeout = window.setTimeout(() => {
      filterRef.current?.focus();
      filterRef.current?.select();
    }, 0);

    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const branches = data.branches || [];
  const tags = data.tags || [];
  const queryLower = query.trim().toLowerCase();
  const hasCurrentRef = useMemo(
    () => [...branches, ...tags].some((item) => decodeSafe(item.name) === currentRef),
    [branches, currentRef, tags]
  );
  const showCurrentChip =
    !hasCurrentRef && currentRef && formatRefLabel(currentRef).includes(queryLower);

  return (
    <div ref={rootRef} className="relative">
      <details className="ref-menu relative" open={open}>
        <summary
          className={buttonClasses("secondary", "sm")}
          onClick={(event) => {
            event.preventDefault();
            setOpen((value) => !value);
          }}
        >
          <span>{formatRefLabel(currentRef)}</span>
        </summary>
        <div
          className="fixed inset-x-0 z-20 mx-3 mt-2 rounded-md p-2 shadow-lg sm:absolute sm:right-0 sm:left-auto sm:mx-0 sm:w-72"
          style={{
            border: "1px solid var(--overlay-borderColor)",
            backgroundColor: "var(--overlay-bgColor)",
          }}
        >
          <input
            ref={filterRef}
            type="text"
            placeholder="Filter branches/tags"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full rounded-md px-2 py-1.5 text-sm"
            style={{
              border: "1px solid var(--borderColor-default)",
              backgroundColor: "var(--bgColor-default)",
              color: "var(--fgColor-default)",
            }}
            autoComplete="off"
          />
          <div className="mt-2 max-h-48 overflow-y-auto text-sm sm:max-h-64 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            {loading ? (
              <div className="px-2 py-2" style={{ color: "var(--fgColor-muted)" }}>
                Loading...
              </div>
            ) : null}
            {!loading && error ? (
              <div className="px-2 py-2" style={{ color: "var(--fgColor-muted)" }}>
                {error}
              </div>
            ) : null}
            {!loading && !error ? (
              <>
                {showCurrentChip ? (
                  <>
                    <div
                      className="px-2 py-1 text-xs uppercase"
                      style={{ color: "var(--fgColor-muted)" }}
                    >
                      Current
                    </div>
                    <span
                      className="flex items-center gap-2 rounded-md px-2 py-1.5"
                      style={{
                        border: "1px solid var(--borderColor-accent-muted)",
                        backgroundColor: "var(--bgColor-accent-muted)",
                        color: "var(--fgColor-accent)",
                      }}
                    >
                      <CheckIcon size={16} aria-hidden="true" />
                      <span className="font-medium">
                        {/^[0-9a-f]{40}$/i.test(currentRef)
                          ? `Commit: ${formatRefLabel(currentRef)}`
                          : currentRef}
                      </span>
                    </span>
                    <div
                      className="my-1 border-t"
                      style={{ borderColor: "var(--borderColor-muted)" }}
                    ></div>
                  </>
                ) : null}
                <RefPickerSection
                  title="Branches"
                  kind="branch"
                  currentRef={currentRef}
                  currentUrl={currentUrl}
                  items={branches}
                  query={queryLower}
                />
                <RefPickerSection
                  title="Tags"
                  kind="tag"
                  currentRef={currentRef}
                  currentUrl={currentUrl}
                  items={tags}
                  query={queryLower}
                />
                {!showCurrentChip &&
                !branches.some((item) => item.displayName.toLowerCase().includes(queryLower)) &&
                !tags.some((item) => item.displayName.toLowerCase().includes(queryLower)) ? (
                  <div className="px-2 py-2" style={{ color: "var(--fgColor-muted)" }}>
                    No refs
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </details>
    </div>
  );
}

export function initRefPicker() {
  hydrateIsland<RefPickerProps>("ref-picker", RefPickerIsland);
}
