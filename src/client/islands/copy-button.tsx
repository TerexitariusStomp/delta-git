/// <reference lib="dom" />

import { useState } from "react";
import { CheckIcon, CopyIcon } from "@primer/octicons-react";

import { hydrateIsland } from "@/client/hydrate";

export type CopyButtonProps = {
  value: string;
};

export function CopyButtonIsland({ value }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      title={copied ? "Copied" : "Copy to clipboard"}
      className="inline-flex items-center rounded-md px-2 py-1 transition-colors"
      style={{
        backgroundColor: "var(--control-bgColor-rest)",
        border: "1px solid var(--control-borderColor-rest)",
        color: copied ? "var(--fgColor-success)" : "var(--fgColor-default)",
      }}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}

export function initCopyButton() {
  hydrateIsland<CopyButtonProps>("copy-button", CopyButtonIsland);
}
