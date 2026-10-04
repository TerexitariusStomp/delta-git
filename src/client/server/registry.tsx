import type { ReactElement } from "react";

import { clientEntrypoints, type ClientEntrypoint } from "@/client/entrypoints";
import { AccountPage, type AccountPageProps } from "@/client/pages/AccountPage";
import { AdminPage, type AdminPageProps } from "@/client/pages/AdminPage";
import { AgentsPage, type AgentsPageProps } from "@/client/pages/AgentsPage";
import { AuthSignInPage, type AuthSignInPageProps } from "@/client/pages/AuthSignInPage";
import { BlobPage, type BlobPageProps } from "@/client/pages/BlobPage";
import { CommitPage, type CommitPageProps } from "@/client/pages/CommitPage";
import { CommitsPage, type CommitsPageProps } from "@/client/pages/CommitsPage";
import { ErrorPage, type ErrorPageProps } from "@/client/pages/ErrorPage";
import { HomePage, type HomePageProps } from "@/client/pages/HomePage";
import { IdeasPage, type IdeasPageProps } from "@/client/pages/IdeasPage";
import { LeaderboardPage, type LeaderboardPageProps } from "@/client/pages/LeaderboardPage";
import { NotFoundPage } from "@/client/pages/NotFoundPage";
import { OverviewPage, type OverviewPageProps } from "@/client/pages/OverviewPage";
import { OwnerPage, type OwnerPageProps } from "@/client/pages/OwnerPage";
import { TreePage, type TreePageProps } from "@/client/pages/TreePage";

type ViewDefinition = {
  kind: "document" | "fragment";
  title?: string;
  clientEntrypoints?: ClientEntrypoint[];
  render: (data: Record<string, unknown>) => ReactElement;
};

function renderWithProps<Props extends object>(
  renderPage: (props: Props) => ReactElement
): (data: Record<string, unknown>) => ReactElement {
  return (data) => renderPage(data as Props);
}

const views: Record<string, ViewDefinition> = {
  home: {
    kind: "document",
    title: "git-on-cloudflare",
    clientEntrypoints: [clientEntrypoints.shell],
    render: renderWithProps((props: HomePageProps) => <HomePage {...props} />),
  },
  "404": {
    kind: "document",
    title: "404 · git-on-cloudflare",
    clientEntrypoints: [clientEntrypoints.shell],
    render: () => <NotFoundPage />,
  },
  error: {
    kind: "document",
    title: "Error · git-on-cloudflare",
    clientEntrypoints: [clientEntrypoints.shell],
    render: renderWithProps((props: ErrorPageProps) => <ErrorPage {...props} />),
  },
  owner: {
    kind: "document",
    clientEntrypoints: [clientEntrypoints.shell],
    render: renderWithProps((props: OwnerPageProps) => <OwnerPage {...props} />),
  },
  overview: {
    kind: "document",
    clientEntrypoints: [clientEntrypoints.shell],
    render: renderWithProps((props: OverviewPageProps) => <OverviewPage {...props} />),
  },
  tree: {
    kind: "document",
    clientEntrypoints: [clientEntrypoints.shell, clientEntrypoints.treePage],
    render: renderWithProps((props: TreePageProps) => <TreePage {...props} />),
  },
  blob: {
    kind: "document",
    clientEntrypoints: [clientEntrypoints.shell, clientEntrypoints.blobPage],
    render: renderWithProps((props: BlobPageProps) => <BlobPage {...props} />),
  },
  commit: {
    kind: "document",
    clientEntrypoints: [clientEntrypoints.shell, clientEntrypoints.commitPage],
    render: renderWithProps((props: CommitPageProps) => <CommitPage {...props} />),
  },
  commits: {
    kind: "document",
    clientEntrypoints: [clientEntrypoints.shell, clientEntrypoints.commitsPage],
    render: renderWithProps((props: CommitsPageProps) => <CommitsPage {...props} />),
  },
  agents: {
    kind: "document",
    clientEntrypoints: [clientEntrypoints.shell],
    render: renderWithProps((props: AgentsPageProps) => <AgentsPage {...props} />),
  },
  ideas: {
    kind: "document",
    clientEntrypoints: [clientEntrypoints.shell],
    render: renderWithProps((props: IdeasPageProps) => <IdeasPage {...props} />),
  },
  leaderboard: {
    kind: "document",
    title: "Agent leaderboard · delta-git",
    clientEntrypoints: [clientEntrypoints.shell],
    render: renderWithProps((props: LeaderboardPageProps) => <LeaderboardPage {...props} />),
  },
  "auth-signin": {
    kind: "document",
    title: "Sign in · git-on-cloudflare",
    clientEntrypoints: [clientEntrypoints.shell, clientEntrypoints.didSignin],
    render: renderWithProps((props: AuthSignInPageProps) => <AuthSignInPage {...props} />),
  },
  account: {
    kind: "document",
    title: "Account · git-on-cloudflare",
    clientEntrypoints: [clientEntrypoints.shell, clientEntrypoints.accountPage],
    render: renderWithProps((props: AccountPageProps) => <AccountPage {...props} />),
  },
  admin: {
    kind: "document",
    clientEntrypoints: [clientEntrypoints.shell, clientEntrypoints.adminPage],
    render: renderWithProps((props: AdminPageProps) => <AdminPage {...props} />),
  },
};

export function getViewDefinition(name: string): ViewDefinition | undefined {
  return views[name];
}
