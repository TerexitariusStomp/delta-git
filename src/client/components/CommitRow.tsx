import type { KeyboardEventHandler, MouseEventHandler } from "react";
import { GitMergeIcon } from "@primer/octicons-react";

type CommitView = {
  oid: string;
  shortOid: string;
  firstLine: string;
  authorName: string;
  when: string;
  whenEpoch?: number;
};

type CommitRowProps = {
  owner: string;
  repo: string;
  commit: CommitView;
  compact?: boolean;
  isMerge?: boolean;
  rowClass?: string;
  mergeOf?: string;
  toggleOid?: string;
  mergeExpanded?: boolean;
  onToggle?: MouseEventHandler<HTMLTableRowElement>;
};

export function CommitRow({
  owner,
  repo,
  commit,
  compact,
  isMerge,
  rowClass,
  mergeOf,
  toggleOid,
  mergeExpanded,
  onToggle,
}: CommitRowProps) {
  const classes = [compact ? "text-sm" : "", onToggle ? "cursor-pointer" : "", rowClass || ""]
    .filter(Boolean)
    .join(" ");

  const onKeyDown: KeyboardEventHandler<HTMLTableRowElement> | undefined = onToggle
    ? (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        onToggle(event as unknown as Parameters<NonNullable<typeof onToggle>>[0]);
      }
    : undefined;

  return (
    <tr
      className={classes || undefined}
      data-merge-of={mergeOf || undefined}
      data-merge-oid={toggleOid || undefined}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      role={onToggle ? "button" : undefined}
      tabIndex={onToggle ? 0 : undefined}
      aria-expanded={onToggle ? mergeExpanded : undefined}
    >
      <td className={compact ? "py-2 pl-8" : "py-2"}>
        <div className="flex min-w-0 items-center gap-2">
          {isMerge ? (
            <span
              className="merge-badge inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs"
              style={{
                backgroundColor: mergeExpanded
                  ? "var(--bgColor-attention-muted)"
                  : "var(--bgColor-accent-muted)",
                color: mergeExpanded ? "var(--fgColor-attention)" : "var(--fgColor-accent)",
                border: "1px solid var(--borderColor-muted)",
              }}
              title={mergeExpanded ? "Collapse merge commits" : "Expand merge commits"}
            >
              <GitMergeIcon size={12} aria-hidden="true" />
              Merge
            </span>
          ) : null}
          <a
            href={`/${owner}/${repo}/commit/${commit.oid}`}
            className="truncate font-semibold no-underline hover:underline"
            style={{ color: "var(--fgColor-default)" }}
            title={commit.firstLine}
          >
            {commit.firstLine}
          </a>
        </div>
        {commit.authorName ? (
          <div className="mt-0.5 truncate text-xs" style={{ color: "var(--fgColor-muted)" }}>
            {commit.authorName}
          </div>
        ) : null}
      </td>
      <td className="py-2 text-right whitespace-nowrap">
        <a
          href={`/${owner}/${repo}/commit/${commit.oid}`}
          className="font-mono text-xs no-underline hover:underline"
          style={{ color: "var(--fgColor-muted)" }}
        >
          {commit.shortOid}
        </a>
      </td>
      <td
        className="py-2 text-right text-xs whitespace-nowrap"
        style={{ color: "var(--fgColor-muted)" }}
      >
        {commit.when}
      </td>
    </tr>
  );
}
