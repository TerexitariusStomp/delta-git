import { HistoryIcon, PersonIcon } from "@primer/octicons-react";

import type { FileIconName } from "@/shared/web";
import { formatRelativeTime } from "@/shared/web";
import { FileIcon } from "@/client/components/FileIcon";

export type FileRowLastChange = {
  oid: string;
  subject: string;
  when: number;
  author?: string;
};

export type FileRow = {
  name: string;
  href: string;
  isDir: boolean;
  isSymlink: boolean;
  iconName: FileIconName;
  lastChange?: FileRowLastChange;
};

export type CommitBarData = {
  oid: string;
  subject: string;
  when: number;
  author?: string;
  /** Exact first-parent commit count when known (walk reached root). */
  commitCount?: number;
  commitsHref: string;
  commitHref: string;
};

type FileTableProps = {
  owner: string;
  repo: string;
  rows: FileRow[];
  parentHref?: string | null;
  commitBar?: CommitBarData;
};

function rowIconClass(row: FileRow): string {
  if (row.isDir) {
    // GitHub renders directory icons in accent blue
    return "inline-flex shrink-0 text-[#54aeff]";
  }
  return "inline-flex shrink-0";
}

function rowIconColor(row: FileRow): string {
  if (row.isDir) return "#54aeff";
  return "var(--fgColor-muted)";
}

export function FileTable({ owner, repo, rows, parentHref, commitBar }: FileTableProps) {
  return (
    <div
      className="w-full overflow-hidden rounded-md"
      style={{ border: "1px solid var(--borderColor-default)" }}
    >
      {commitBar ? (
        <div
          className="flex items-center justify-between gap-3 px-4 py-2"
          style={{
            backgroundColor: "var(--bgColor-muted)",
            borderBottom: "1px solid var(--borderColor-default)",
          }}
        >
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span style={{ color: "var(--fgColor-muted)" }} aria-hidden="true">
              <PersonIcon size={16} />
            </span>
            {commitBar.author ? (
              <span className="font-semibold" style={{ color: "var(--fgColor-default)" }}>
                {commitBar.author}
              </span>
            ) : null}
            <a
              href={commitBar.commitHref}
              className="truncate no-underline hover:underline"
              style={{ color: "var(--fgColor-default)" }}
              title={commitBar.subject}
            >
              {commitBar.subject}
            </a>
          </div>
          <div
            className="flex shrink-0 items-center gap-2 text-sm whitespace-nowrap"
            style={{ color: "var(--fgColor-muted)" }}
          >
            <a
              href={commitBar.commitHref}
              className="font-mono text-xs no-underline hover:underline"
              style={{ color: "var(--fgColor-muted)" }}
            >
              {commitBar.oid.slice(0, 7)}
            </a>
            <span className="hidden sm:inline">{formatRelativeTime(commitBar.when)}</span>
            <a
              href={commitBar.commitsHref}
              className="inline-flex items-center gap-1 font-semibold no-underline hover:underline"
              style={{ color: "var(--fgColor-muted)" }}
            >
              <HistoryIcon size={16} aria-hidden="true" />
              {commitBar.commitCount !== undefined ? `${commitBar.commitCount} Commits` : "Commits"}
            </a>
          </div>
        </div>
      ) : null}
      <table className="!bg-transparent">
        <tbody>
          {parentHref ? (
            <tr>
              <td colSpan={3} className="!py-1.5">
                <a
                  href={parentHref}
                  className="font-mono no-underline hover:underline"
                  style={{ color: "var(--fgColor-default)" }}
                >
                  ..
                </a>
              </td>
            </tr>
          ) : null}
          {rows.length ? (
            rows.map((row) => (
              <tr key={row.name}>
                <td className="!py-1.5 w-full max-w-0">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={rowIconClass(row)} style={{ color: rowIconColor(row) }}>
                      <FileIcon name={row.iconName} />
                    </span>
                    <a
                      href={row.href}
                      className="truncate no-underline hover:underline"
                      style={{ color: "var(--fgColor-default)" }}
                    >
                      {row.name}
                    </a>
                  </span>
                </td>
                <td className="!py-1.5 hidden md:table-cell max-w-[40%]">
                  {row.lastChange ? (
                    <a
                      href={`/${owner}/${repo}/commit/${row.lastChange.oid}`}
                      className="block truncate text-xs no-underline hover:underline"
                      style={{ color: "var(--fgColor-muted)" }}
                      title={row.lastChange.subject}
                    >
                      {row.lastChange.subject}
                    </a>
                  ) : (
                    <span className="text-xs" style={{ color: "var(--fgColor-muted)" }}>
                      —
                    </span>
                  )}
                </td>
                <td className="!py-1.5 text-right whitespace-nowrap">
                  <span className="text-xs" style={{ color: "var(--fgColor-muted)" }}>
                    {row.lastChange ? formatRelativeTime(row.lastChange.when) : ""}
                  </span>
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td
                colSpan={3}
                className="py-6 text-center text-sm"
                style={{ color: "var(--fgColor-muted)" }}
              >
                This directory is empty
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
