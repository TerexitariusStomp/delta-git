type BreadcrumbItem = {
  name: string;
  href?: string | null;
};

type BreadcrumbsProps = {
  items?: BreadcrumbItem[];
  parentHref?: string | null;
};

/** GitHub-style inline path crumbs (e.g. `src / components / file.tsx`). */
export function Breadcrumbs({ items, parentHref }: BreadcrumbsProps) {
  if (!items?.length) {
    return null;
  }

  return (
    <nav
      className="flex min-w-0 items-center gap-1.5 overflow-x-auto text-sm whitespace-nowrap"
      aria-label="Breadcrumbs"
    >
      {parentHref ? (
        <>
          <a
            href={parentHref}
            className="no-underline hover:underline"
            style={{ color: "var(--fgColor-muted)" }}
            aria-label="Parent directory"
          >
            ..
          </a>
          <span style={{ color: "var(--fgColor-muted)" }}>/</span>
        </>
      ) : null}
      {items.map((item, index) => (
        <span key={`${item.name}-${index}`} className="flex items-center gap-1.5">
          {item.href ? (
            <a href={item.href} className="no-underline hover:underline">
              {item.name}
            </a>
          ) : (
            <strong className="font-semibold" style={{ color: "var(--fgColor-default)" }}>
              {item.name}
            </strong>
          )}
          {index < items.length - 1 ? (
            <span style={{ color: "var(--fgColor-muted)" }}>/</span>
          ) : null}
        </span>
      ))}
    </nav>
  );
}
