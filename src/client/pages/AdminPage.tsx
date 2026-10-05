import { type Progress, ProgressBanner } from "@/client/components/ProgressBanner";
import { RepoNav } from "@/client/components/RepoNav";
import { type RepoAdminProps, RepoAdminIsland } from "@/client/islands/repo-admin";
import { IslandHost } from "@/client/server/IslandHost";
import { Button } from "@/client/components/ui/button";

export type AdminPageProps = RepoAdminProps & {
  progress?: Progress;
  visibility?: "public" | "private";
  description?: string;
  /** Show the Arena tab (artifacts repos). */
  arena?: boolean;
};

export function AdminPage({ progress, visibility, description, arena, ...props }: AdminPageProps) {
  return (
    <>
      <RepoNav
        owner={props.owner}
        repo={props.repo}
        currentTab="admin"
        visibility={visibility}
        description={description}
        arena={arena}
      />
      <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
        <ProgressBanner progress={progress} />
        {/* General settings — plain form post like GitHub's settings page */}
        <section
          className="mb-6 rounded-md"
          style={{ border: "1px solid var(--borderColor-default)" }}
          aria-labelledby="admin-general"
        >
          <h2
            id="admin-general"
            className="m-0 rounded-t-md px-4 py-3 text-base font-semibold"
            style={{
              backgroundColor: "var(--bgColor-muted)",
              borderBottom: "1px solid var(--borderColor-muted)",
            }}
          >
            General
          </h2>
          <form
            method="post"
            action={`/${props.owner}/${props.repo}/admin/description`}
            className="p-4"
          >
            <label
              htmlFor="repo-description"
              className="mb-1 block text-sm font-semibold"
              style={{ color: "var(--fgColor-default)" }}
            >
              Description
            </label>
            <p className="mb-2 text-sm" style={{ color: "var(--fgColor-muted)" }}>
              Shown under the repository name and in the About sidebar.
            </p>
            <div className="flex items-start gap-2">
              <input
                id="repo-description"
                name="description"
                type="text"
                defaultValue={description ?? ""}
                maxLength={350}
                placeholder="A short description of this repository"
                className="min-w-0 flex-1 rounded-md px-3 py-1.5 text-sm"
                style={{
                  backgroundColor: "var(--bgColor-default)",
                  border: "1px solid var(--borderColor-default)",
                  color: "var(--fgColor-default)",
                }}
              />
              <Button type="submit" variant="secondary" size="md">
                Save
              </Button>
            </div>
          </form>
        </section>
        <IslandHost name="repo-admin" props={props}>
          <RepoAdminIsland {...props} />
        </IslandHost>
      </div>
    </>
  );
}
