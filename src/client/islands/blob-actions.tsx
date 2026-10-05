/// <reference lib="dom" />

import { useState } from "react";
import { CopyIcon, DownloadIcon, FileIcon, KebabHorizontalIcon } from "@primer/octicons-react";

import { hydrateIsland } from "@/client/hydrate";
import { Button, buttonClasses } from "@/client/components/ui/button";

export type BlobActionsProps = {
  viewRawHref: string;
  rawHref: string;
  showCopy: boolean;
  isImage?: boolean;
  isPdf?: boolean;
};

const segStyle = {
  color: "var(--fgColor-default)",
  backgroundColor: "var(--bgColor-default)",
} as const;

const segDivider = { borderColor: "var(--borderColor-default)" } as const;

export function BlobActionsIsland({
  viewRawHref,
  rawHref,
  showCopy,
  isImage,
  isPdf,
}: BlobActionsProps) {
  const [copyLabel, setCopyLabel] = useState("Copy");

  async function copyRawText() {
    try {
      const response = await fetch(viewRawHref);
      const text = await response.text();
      await navigator.clipboard.writeText(text);
      setCopyLabel("Copied");
      window.setTimeout(() => setCopyLabel("Copy"), 1200);
    } catch (error) {
      console.warn("Copy failed", error);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div className="hidden items-center gap-2 sm:flex">
        <div
          className="inline-flex items-center overflow-hidden rounded-md"
          style={{ border: "1px solid var(--borderColor-default)" }}
        >
          {showCopy ? (
            <button
              className="px-3 py-1 text-sm no-underline"
              style={segStyle}
              type="button"
              onClick={() => void copyRawText()}
            >
              {copyLabel}
            </button>
          ) : null}
          {!isImage && !isPdf ? (
            <a
              className="border-l px-3 py-1 text-sm no-underline"
              style={{ ...segStyle, ...segDivider }}
              href={viewRawHref}
            >
              View
            </a>
          ) : null}
          <a
            className="border-l px-3 py-1 text-sm no-underline"
            style={{ ...segStyle, ...segDivider }}
            href={viewRawHref.replace("&view=1", "")}
          >
            Raw
          </a>
        </div>
        <Button size="sm" variant="secondary" href={rawHref}>
          Download
        </Button>
      </div>
      <div className="sm:hidden">
        <details className="ref-menu relative">
          <summary className={buttonClasses("secondary", "sm")} aria-label="File actions">
            <KebabHorizontalIcon size={16} aria-hidden="true" />
          </summary>
          <div
            className="fixed inset-x-0 z-20 mx-3 mt-2 rounded-md p-2 shadow-lg"
            style={{
              border: "1px solid var(--overlay-borderColor)",
              backgroundColor: "var(--overlay-bgColor)",
            }}
          >
            <div className="flex flex-col">
              {showCopy ? (
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-left"
                  style={{ color: "var(--fgColor-default)" }}
                  onClick={() => void copyRawText()}
                >
                  <CopyIcon size={16} aria-hidden="true" />
                  <span>{copyLabel === "Copy" ? "Copy raw" : "Copied"}</span>
                </button>
              ) : null}
              {!isImage && !isPdf ? (
                <a
                  href={viewRawHref}
                  className="flex items-center gap-2 rounded-md px-3 py-2 no-underline"
                  style={{ color: "var(--fgColor-default)" }}
                >
                  <FileIcon size={16} aria-hidden="true" />
                  <span>View raw</span>
                </a>
              ) : null}
              <a
                href={rawHref}
                className="flex items-center gap-2 rounded-md px-3 py-2 no-underline"
                style={{ color: "var(--fgColor-default)" }}
              >
                <DownloadIcon size={16} aria-hidden="true" />
                <span>Download</span>
              </a>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}

export function initBlobActions() {
  hydrateIsland<BlobActionsProps>("blob-actions", BlobActionsIsland);
}
