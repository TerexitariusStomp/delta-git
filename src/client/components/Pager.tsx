import { Button } from "@/client/components/ui/button";

type PagerLink = {
  text: string;
  href: string;
};

type PagerModel = {
  perPageLinks: PagerLink[];
  newerHref?: string;
  olderHref?: string;
};

type PagerProps = {
  pager?: PagerModel | null;
};

export function Pager({ pager }: PagerProps) {
  if (!pager) {
    return null;
  }

  return (
    <div className="my-6 flex items-center justify-between">
      <div className="flex items-center gap-1 text-sm">
        <span className="py-1 pr-1" style={{ color: "var(--fgColor-muted)" }}>
          Per page:
        </span>
        {pager.perPageLinks.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="rounded-md px-2 py-1 no-underline hover:bg-[var(--control-bgColor-hover)]"
            style={{ color: "var(--fgColor-default)" }}
          >
            {link.text}
          </a>
        ))}
      </div>
      <div className="flex gap-2">
        {pager.newerHref ? (
          <Button variant="secondary" size="sm" href={pager.newerHref}>
            ← Newer
          </Button>
        ) : null}
        {pager.olderHref ? (
          <Button variant="secondary" size="sm" href={pager.olderHref}>
            Older →
          </Button>
        ) : null}
      </div>
    </div>
  );
}
