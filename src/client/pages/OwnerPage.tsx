import { RepoIcon, RepoLockedIcon } from "@primer/octicons-react";

export type OwnerPageRepo = {
  slug: string;
  visibility: "public" | "private";
  description?: string;
};

export type OwnerPageProps = {
  owner: string;
  repos: OwnerPageRepo[];
};

/** GitHub profile-style page: owner name + repository list rows. */
export function OwnerPage({ owner, repos }: OwnerPageProps) {
  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
      <div
        className="mb-6 flex items-center gap-3 border-b pb-4"
        style={{ borderColor: "var(--borderColor-muted)" }}
      >
        <span
          className="inline-grid h-10 w-10 shrink-0 place-items-center rounded-full"
          style={{
            backgroundColor: "var(--bgColor-muted)",
            border: "1px solid var(--borderColor-default)",
            color: "var(--fgColor-muted)",
          }}
          aria-hidden="true"
        >
          <RepoIcon size={20} />
        </span>
        <div className="min-w-0">
          <h1 className="m-0 text-xl font-semibold" style={{ color: "var(--fgColor-default)" }}>
            {owner}
          </h1>
          <p className="m-0 text-sm" style={{ color: "var(--fgColor-muted)" }}>
            {repos.length} {repos.length === 1 ? "repository" : "repositories"}
          </p>
        </div>
      </div>

      <h2 className="m-0 mb-3 text-base font-semibold" style={{ color: "var(--fgColor-default)" }}>
        Repositories
      </h2>
      {repos.length ? (
        <ul
          className="m-0 list-none divide-y rounded-md p-0"
          style={{ border: "1px solid var(--borderColor-default)" }}
        >
          {repos.map((repo) => (
            <li key={repo.slug} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span style={{ color: "var(--fgColor-muted)" }} aria-hidden="true">
                  {repo.visibility === "private" ? (
                    <RepoLockedIcon size={16} />
                  ) : (
                    <RepoIcon size={16} />
                  )}
                </span>
                <a
                  href={`/${owner}/${repo.slug}`}
                  className="font-semibold no-underline hover:underline"
                  style={{ color: "var(--fgColor-link)" }}
                >
                  {owner}/{repo.slug}
                </a>
                <span
                  className="rounded-full border px-[7px] py-px text-xs leading-[18px] font-medium"
                  style={{
                    borderColor: "var(--borderColor-default)",
                    color: "var(--fgColor-muted)",
                  }}
                >
                  {repo.visibility === "private" ? "Private" : "Public"}
                </span>
              </div>
              {repo.description ? (
                <p className="m-0 mt-1 truncate text-sm" style={{ color: "var(--fgColor-muted)" }}>
                  {repo.description}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div
          className="rounded-md p-10 text-center"
          style={{ border: "1px solid var(--borderColor-default)" }}
        >
          <RepoIcon size={32} aria-hidden="true" />
          <p className="m-0 mt-2 font-semibold" style={{ color: "var(--fgColor-default)" }}>
            No repositories yet
          </p>
          <p className="m-0 mt-1 text-sm" style={{ color: "var(--fgColor-muted)" }}>
            Push a repository to get started.
          </p>
        </div>
      )}
    </div>
  );
}
