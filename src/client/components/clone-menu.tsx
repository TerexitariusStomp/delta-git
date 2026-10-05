import { CodeIcon, TriangleDownIcon } from "@primer/octicons-react";

import { IslandHost } from "@/client/server/IslandHost";
import { CopyButtonIsland } from "@/client/islands/copy-button";

type CloneMenuProps = {
  /** Absolute HTTPS clone URL shown in the dropdown. */
  cloneUrl: string;
};

/**
 * GitHub's green "Code" button + clone dropdown. Pure SSR: the `<details>`
 * element provides open/close without client JS; the copy button hydrates.
 */
export function CloneMenu({ cloneUrl }: CloneMenuProps) {
  return (
    <details className="ref-menu relative">
      <summary
        className="inline-flex select-none list-none items-center gap-2 rounded-md px-3 py-[5px] text-sm font-medium leading-5"
        style={{
          backgroundColor: "var(--button-primary-bgColor-rest)",
          color: "var(--button-primary-fgColor-rest)",
          border: "1px solid var(--button-primary-borderColor-rest)",
        }}
      >
        <CodeIcon size={16} aria-hidden="true" />
        Code
        <TriangleDownIcon size={12} aria-hidden="true" />
      </summary>
      <div
        className="absolute right-0 z-30 mt-2 w-80 rounded-md p-4 shadow-lg"
        style={{
          backgroundColor: "var(--overlay-bgColor)",
          border: "1px solid var(--borderColor-default)",
        }}
      >
        <div className="mb-2 text-sm font-semibold" style={{ color: "var(--fgColor-default)" }}>
          Clone
        </div>
        <div
          className="mb-2 flex items-center gap-1 border-b pb-2 text-sm font-medium"
          style={{ borderColor: "var(--borderColor-muted)", color: "var(--fgColor-default)" }}
        >
          HTTPS
        </div>
        <div className="flex items-stretch gap-1">
          <input
            type="text"
            readOnly
            value={cloneUrl}
            className="min-w-0 flex-1 rounded-md px-2 py-1 font-mono text-xs"
            style={{
              backgroundColor: "var(--bgColor-muted)",
              border: "1px solid var(--borderColor-default)",
              color: "var(--fgColor-default)",
            }}
            onFocus={(e) => e.target.select()}
          />
          <IslandHost name="copy-button" props={{ value: cloneUrl }}>
            <CopyButtonIsland value={cloneUrl} />
          </IslandHost>
        </div>
        <p className="mb-0 mt-3 text-xs" style={{ color: "var(--fgColor-muted)" }}>
          Clone with Git over HTTPS — push with a <a href="/auth/account">personal access token</a>.
        </p>
      </div>
    </details>
  );
}
