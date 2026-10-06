import { Navigate, redirect } from "react-router-dom";

import { Breadcrumb, Layout, Sidebar } from "@harnessio/ui/components";
import { ComponentProvider } from "@harnessio/ui/context";
import { getTrimmedSha } from "@harnessio/ui/utils";
import { ProfileSettingsLayout, RepoSettingsLayout, WebhookSettingsLayout } from "@harnessio/views";

import { FeatureGuard } from "./components-v2/feature-guard";
import { AppShellMFE } from "./components-v2/mfe/app-shell";
import { ProjectDropdown } from "./components-v2/project-dropdown";
import { AppShell } from "./components-v2/standalone/app-shell";
import { AppProvider } from "./framework/context/AppContext";
import { AppRouterProvider } from "./framework/context/AppRouterProvider";
import { ExplorerPathsProvider } from "./framework/context/ExplorerPathsContext";
import { FeatureFlag } from "./framework/context/MFEContext.tsx";
import { PageTitleProvider } from "./framework/context/PageTitleContext";
import { RbacButton } from "./framework/rbac/rbac-button";
import { RbacMoreActionsTooltip } from "./framework/rbac/rbac-more-actions-tooltip.tsx";
import { RbacSplitButton } from "./framework/rbac/rbac-split-button";
import { CustomRouteObject, RouteConstants } from "./framework/routing/types";
import { MFERouteRenderer } from "./MFERouteRenderer";
import { CreateProject } from "./pages-v2/create-project";
import { DeltaArenaFeedPage, DeltaLeaderboardPage } from "./pages-v2/delta/global-pages";
import {
  AdminResourceGroupsPage,
  AdminRolesPage,
  AdminServiceAccountsPage,
  AdminUserGroupsPage,
} from "./pages-v2/delta/admin-rbac-pages";
import { RepoDeltaKnowledgePage } from "./pages-v2/delta/knowledge-page";
import { ArtifactsPage, EnvironmentsPage, NotificationsPage } from "./pages-v2/delta/module-pages";
import { ExplorePage } from "./pages-v2/explore-page";
import {
  ConnectorsPage,
  DelegatesPage,
  ExternalTicketsPage,
  FeatureFlagsPage,
  FileStorePage,
  FreezeWindowsPage,
  GitOpsPage,
  IaCPage,
  PoliciesPage,
  SpaceTemplatesPage,
  VariablesPage,
} from "./pages-v2/delta/delivery-pages";
import {
  CertificatesPage,
  ChaosPage,
  CloudCostsPage,
  IncidentsPage,
  MonitorsPage,
  ServiceReliabilityPage,
  SloDowntimePage,
} from "./pages-v2/delta/reliability-pages";
import {
  DashboardsPage,
  DatabasesPage,
  DevEnvironmentsPage,
  DevInsightsPage,
  DevPortalPage,
  SecurityTestsPage,
  SupplyChainPage,
} from "./pages-v2/delta/devx-pages";
import { SecretsVaultPage } from "./pages-v2/delta/secrets-vault-page";
import {
  RepoDeltaAgentsPage,
  RepoDeltaArenaMatchPage,
  RepoDeltaArenaPage,
  RepoDeltaIdeasPage,
  RepoDeltaIntentsPage,
} from "./pages-v2/delta/repo-pages";
import RepoStubPage from "./pages-v2/repo/repo-stub-page";
import {
  RepoIssueDetailPage,
  RepoIssueNewPage,
  RepoIssuesPage,
} from "./pages-v2/repo/repo-issues-page";
import {
  RepoDiscussionDetailPage,
  RepoDiscussionNewPage,
  RepoDiscussionsPage,
} from "./pages-v2/repo/repo-discussions-page";
import { RepoWikiEditPage, RepoWikiPage } from "./pages-v2/repo/repo-wiki-page";
import { RepoInsightsPage } from "./pages-v2/repo/repo-insights-page";
import { RepoProjectBoardPage, RepoProjectsPage } from "./pages-v2/repo/repo-projects-page";
import {
  RepoReleaseDetailPage,
  RepoReleaseNewPage,
  RepoReleasesPage,
} from "./pages-v2/repo/repo-releases-page";
import { LandingPage } from "./pages-v2/landing-page-container";
import { Logout } from "./pages-v2/logout";
import { SettingsProfileGeneralPage } from "./pages-v2/profile-settings/profile-settings-general-container";
import { SettingsProfileKeysPage } from "./pages-v2/profile-settings/profile-settings-keys-container";
import { ProjectLabelFormContainer } from "./pages-v2/project/labels/project-label-form-container";
import { ProjectLabelsList } from "./pages-v2/project/labels/project-labels-list-container";
import { ProjectGeneralSettingsPageContainer } from "./pages-v2/project/project-general-settings-container";
import { ImportProjectContainer } from "./pages-v2/project/project-import-container";
import { ProjectMemberListPage } from "./pages-v2/project/project-member-list";
import { ProjectRulesListContainer } from "./pages-v2/project/project-rules-list-container";
import { ProjectSettingsLayout } from "./pages-v2/project/project-settings-layout";
import ProjectPullRequestListPage from "./pages-v2/project/pull-request/pull-request-list";
import { ProjectBranchRulesContainer } from "./pages-v2/project/rules/project-branch-rules-container";
import { ProjectPushRulesContainer } from "./pages-v2/project/rules/project-push-rules-container.tsx";
import { ProjectRulesContainer } from "./pages-v2/project/rules/project-rules-container";
import { ProjectTagRulesContainer } from "./pages-v2/project/rules/project-tag-rules-container";
import PullRequestChanges from "./pages-v2/pull-request/pull-request-changes";
import { PullRequestCommitPage } from "./pages-v2/pull-request/pull-request-commits";
import { CreatePullRequest } from "./pages-v2/pull-request/pull-request-compare";
import PullRequestConversationPage from "./pages-v2/pull-request/pull-request-conversation";
import PullRequestDataProvider from "./pages-v2/pull-request/pull-request-data-provider";
import PullRequestLayout from "./pages-v2/pull-request/pull-request-layout";
import RepoPullRequestListPage from "./pages-v2/pull-request/pull-request-list";
import { RepoLabelFormContainer } from "./pages-v2/repo/labels/label-form-container";
import { RepoLabelsList } from "./pages-v2/repo/labels/labels-list-container";
import { RepoBranchesListPage } from "./pages-v2/repo/repo-branch-list";
import { RepoCode } from "./pages-v2/repo/repo-code";
import RepoCommitDetailsPage from "./pages-v2/repo/repo-commit-details";
import { CommitDiffContainer } from "./pages-v2/repo/repo-commit-details-diff";
import RepoCommitsPage from "./pages-v2/repo/repo-commits";
import { CreateRepo } from "./pages-v2/repo/repo-create-page";
import RepoExecutionListPage from "./pages-v2/repo/repo-execution-list";
import RepoExecutionDetailsPage from "./pages-v2/repo/repo-execution-details";
import RepoPipelineEditPage from "./pages-v2/repo/repo-pipeline-edit";
import RepoPipelineListPage from "./pages-v2/repo/repo-pipeline-list";
import RepoForkPage from "./pages-v2/repo/repo-fork.tsx";
import { ImportMultipleRepos } from "./pages-v2/repo/repo-import-multiple-container";
import { ImportRepo } from "./pages-v2/repo/repo-import-page";
import RepoLayout from "./pages-v2/repo/repo-layout";
import { LinkRepo } from "./pages-v2/repo/repo-link-page";
import ReposListPage from "./pages-v2/repo/repo-list";
import { RepoSettingsGeneralPageContainer } from "./pages-v2/repo/repo-settings-general-container";
import { RepoSettingsRulesListContainer } from "./pages-v2/repo/repo-settings-rules-list-container";
import { RepoSidebar } from "./pages-v2/repo/repo-sidebar";
import RepoSummaryPage from "./pages-v2/repo/repo-summary";
import { RepoTagsListContainer } from "./pages-v2/repo/repo-tags-list-container";
import { RepoBranchRulesContainer } from "./pages-v2/repo/rules/repo-branch-rules-container";
import { RepoPushRulesContainer } from "./pages-v2/repo/rules/repo-push-rules-container.tsx";
import { RepoRulesContainer } from "./pages-v2/repo/rules/repo-rules-container";
import { RepoTagRulesContainer } from "./pages-v2/repo/rules/repo-tag-rules-container";
import SearchPage from "./pages-v2/search-page";
import { OAuthAuthorize } from "./delta/oauth-authorize";
import { OAuthCallback } from "./delta/oauth-callback";
import { SignIn } from "./pages-v2/signin";
import { SignUp } from "./pages-v2/signup";
import { UserManagementPageContainer } from "./pages-v2/user-management/user-management-container";
import { CreateWebhookContainer } from "./pages-v2/webhooks/create-webhook-container";
import { WebhookExecutionDetailsContainer } from "./pages-v2/webhooks/webhook-execution-details-container";
import { WebhookExecutionsContainer } from "./pages-v2/webhooks/webhook-executions";
import WebhookListPage from "./pages-v2/webhooks/webhook-list";

enum Page {
  Repositories = "Repositories",
  Summary = "Summary",
  Fork = "Fork",
  Commits = "Commits",
  Pull_Requests = "Pull requests",
  Branches = "Branches",
  Files = "Files",
  Conversation = "Conversation",
  Changes = "Changes",
  Checks = "Checks",
  Pipelines = "Pipelines",
  Executions = "Executions",
  Settings = "Settings",
  Branch_Rules = "Branch rules",
  Labels = "Labels",
  Members = "Members",
  General = "General",
  Keys = "Keys",
  Home = "Home",
  Theme = "Theme",
  Search = "Search",
  Tags = "Tags",
}

const labelsRoute = {
  path: "labels",
  handle: {
    breadcrumb: () => <span>{Page.Labels}</span>,
    pageTitle: Page.Labels,
    routeName: RouteConstants.toProjectLabels,
  },
  children: [
    {
      index: true,
      element: <ProjectLabelsList />,
    },
    {
      path: "create",
      element: <ProjectLabelFormContainer />,
      handle: {
        breadcrumb: () => <span>Create a label</span>,
      },
    },
    {
      path: ":labelId",
      element: <ProjectLabelFormContainer />,
      handle: {
        breadcrumb: ({ labelId }: { labelId: string }) => <span>{labelId}</span>,
      },
    },
  ],
};

const rulesRoute = {
  path: "rules",
  handle: {
    breadcrumb: () => <span>{Page.Branch_Rules}</span>,
    pageTitle: Page.Branch_Rules,
    routeName: RouteConstants.toProjectRules,
  },

  children: [
    {
      index: true,
      element: <ProjectRulesListContainer />,
    },
    {
      path: "create/branch",
      element: <ProjectBranchRulesContainer />,
      handle: {
        breadcrumb: () => <span>Create a branch rule</span>,
        routeName: RouteConstants.toProjectBranchRuleCreate,
      },
    },
    {
      path: "create/tag",
      element: <ProjectTagRulesContainer />,
      handle: {
        breadcrumb: () => <span>Create a tag rule</span>,
        routeName: RouteConstants.toProjectTagRuleCreate,
      },
    },
    {
      path: "create/push",
      element: <ProjectPushRulesContainer />,
      handle: {
        breadcrumb: () => <span>Create a push rule</span>,
        routeName: RouteConstants.toProjectPushRuleCreate,
      },
    },
    {
      path: ":ruleId/edit",
      element: <ProjectRulesContainer />,
      handle: {
        breadcrumb: ({ ruleId }: { ruleId: string }) => <span>{ruleId}</span>,
        routeName: RouteConstants.toProjectRuleDetails,
      },
    },
  ],
};

export const repoRoutes: CustomRouteObject[] = [
  {
    path: "repos",
    handle: {
      breadcrumb: () => <span>{Page.Repositories}</span>,
      routeName: RouteConstants.toRepositories,
    },
    children: [
      {
        index: true,
        element: <ReposListPage />,
        handle: {
          pageTitle: Page.Repositories,
        },
      },
      {
        path: "create",
        element: <CreateRepo />,
        handle: {
          routeName: RouteConstants.toCreateRepo,
          pageTitle: "Create a Repository",
        },
      },
      {
        path: "import",
        element: <ImportRepo />,
        handle: {
          routeName: RouteConstants.toImportRepo,
          pageTitle: "Import a Repository",
        },
      },
      {
        path: "import-multiple",
        element: <ImportMultipleRepos />,
        handle: {
          routeName: RouteConstants.toImportMultipleRepos,
          pageTitle: "Import Repositories",
        },
      },
      {
        path: "link",
        element: (
          <FeatureGuard featureFlag={FeatureFlag.CODE_LINK_REPOS_ENABLED}>
            <LinkRepo />
          </FeatureGuard>
        ),
        handle: {
          routeName: RouteConstants.toLinkRepo,
          pageTitle: "Link Repository",
        },
      },
      {
        path: ":repoId",
        element: <RepoLayout />,
        handle: {
          breadcrumb: ({ repoId }: { repoId: string }) => <span>{repoId}</span>,
          pageTitle: ({ repoId }: { repoId: string }) => repoId,
        },
        children: [
          {
            index: true,
            element: <Navigate to="summary" replace />,
          },
          {
            path: "fork",
            element: (
              <FeatureGuard featureFlag={FeatureFlag.CODE_FORK_ENABLED}>
                <RepoForkPage />
              </FeatureGuard>
            ),
            handle: {
              breadcrumb: () => <span>{Page.Fork}</span>,
              routeName: RouteConstants.toRepoFork,
              pageTitle: Page.Fork,
              hideLayout: true,
            },
          },
          {
            path: "summary",
            loader: ({ params }) => {
              const wildcard = params["*"] || "";
              if (wildcard.startsWith("edit/")) {
                const cleanPath = wildcard.substring(5);
                return redirect(`./${cleanPath}`);
              } else if (wildcard.startsWith("new/")) {
                const cleanPath = wildcard.substring(4);
                return redirect(`./${cleanPath}`);
              }
              return null;
            },
            element: <RepoSummaryPage />,
            handle: {
              breadcrumb: () => <span>{Page.Summary}</span>,
              routeName: RouteConstants.toRepoSummary,
              pageTitle: Page.Summary,
              publicAccess: true,
            },
            children: [
              {
                path: "*",
                element: <RepoSummaryPage />,
                handle: {
                  publicAccess: true,
                },
              },
            ],
          },
          {
            path: "commits",
            handle: {
              breadcrumb: () => <span>{Page.Commits}</span>,
              routeName: RouteConstants.toRepoCommits,
            },
            children: [
              {
                index: true,
                element: <RepoCommitsPage />,
                handle: {
                  pageTitle: Page.Commits,
                  publicAccess: true,
                },
              },
              {
                path: "*",
                element: <RepoCommitsPage />,
                handle: {
                  pageTitle: Page.Commits,
                  routeName: RouteConstants.toRepoBranchCommits,
                  publicAccess: true,
                },
              },
            ],
          },
          {
            path: "commit/:commitSHA",
            element: <RepoCommitDetailsPage />,
            handle: {
              breadcrumb: ({ commitSHA }: { commitSHA: string }) => (
                <span>{getTrimmedSha(commitSHA)}</span>
              ),
              routeName: RouteConstants.toRepoCommitDetails,
              publicAccess: true,
            },
            children: [
              {
                index: true,
                element: (
                  <ExplorerPathsProvider>
                    <CommitDiffContainer showSidebar={false} />
                  </ExplorerPathsProvider>
                ),
              },
            ],
          },
          {
            path: "branches",
            element: <RepoBranchesListPage />,
            handle: {
              breadcrumb: () => <span>{Page.Branches}</span>,
              routeName: RouteConstants.toRepoBranches,
              pageTitle: Page.Branches,
              publicAccess: true,
            },
          },
          {
            path: "edit/*",
            loader: ({ params }) => {
              const wildcard = params["*"] || "";
              return redirect(`../files/edit/${wildcard}`);
            },
            element: (
              <ExplorerPathsProvider>
                <RepoSidebar />
              </ExplorerPathsProvider>
            ),
            handle: {
              breadcrumb: () => <span>{Page.Files}</span>,
              routeName: RouteConstants.toRepoFiles,
            },
          },
          {
            path: "files",
            element: (
              <ExplorerPathsProvider>
                <RepoSidebar />
              </ExplorerPathsProvider>
            ),
            handle: {
              breadcrumb: () => <span>{Page.Files}</span>,
              routeName: RouteConstants.toRepoFiles,
            },
            children: [
              {
                index: true,
                element: <RepoCode />,
                handle: {
                  pageTitle: Page.Files,
                  publicAccess: true,
                },
              },
              {
                path: "*",
                element: <RepoCode />,
                handle: {
                  routeName: RouteConstants.toRepoFileDetails,
                  publicAccess: true,
                },
              },
            ],
          },
          {
            path: "tags",
            element: <RepoTagsListContainer />,
            handle: {
              breadcrumb: () => <span>{Page.Tags}</span>,
              routeName: RouteConstants.toRepoTags,
              publicAccess: true,
            },
          },
          {
            path: "search",
            element: <SearchPage />,
            handle: {
              breadcrumb: () => <span>{Page.Search}</span>,
              routeName: RouteConstants.toRepoSearch,
              pageTitle: Page.Search,
              publicAccess: true,
            },
          },
          {
            path: "pulls",
            handle: {
              breadcrumb: () => <span>{Page.Pull_Requests}</span>,
              routeName: RouteConstants.toRepoPullRequests,
            },
            children: [
              {
                index: true,
                element: <RepoPullRequestListPage />,
                handle: {
                  pageTitle: Page.Pull_Requests,
                  publicAccess: true,
                },
              },
              {
                path: "compare",
                handle: {
                  breadcrumb: () => <span>Compare</span>,
                  asLink: false,
                },
                children: [
                  { index: true, element: <CreatePullRequest /> },
                  {
                    path: ":diffRefs",
                    element: <CreatePullRequest />,
                    handle: { routeName: RouteConstants.toPullRequestCompare },
                  },
                  { path: "*", element: <CreatePullRequest /> },
                ],
              },
              {
                path: ":pullRequestId",
                element: <PullRequestLayout />,
                handle: {
                  breadcrumb: ({ pullRequestId }: { pullRequestId: string }) => (
                    <span>{pullRequestId}</span>
                  ),
                  routeName: RouteConstants.toPullRequest,
                  pageTitle: ({ pullRequestId }: { pullRequestId: string }) =>
                    `PR #${pullRequestId}`,
                },
                children: [
                  {
                    index: true,
                    element: <Navigate to="conversation" replace />,
                  },
                  {
                    path: "conversation",
                    element: (
                      <PullRequestDataProvider>
                        <PullRequestConversationPage />
                      </PullRequestDataProvider>
                    ),
                    handle: {
                      routeName: RouteConstants.toPullRequestConversation,
                      pageTitle: Page.Conversation,
                      publicAccess: true,
                    },
                  },
                  {
                    path: "commits",
                    element: <PullRequestCommitPage />,
                    handle: {
                      breadcrumb: () => <span>{Page.Commits}</span>,
                      routeName: RouteConstants.toPullRequestCommits,
                      pageTitle: Page.Commits,
                      publicAccess: true,
                    },
                  },
                  {
                    path: "changes",
                    element: (
                      <PullRequestDataProvider>
                        <PullRequestChanges />
                      </PullRequestDataProvider>
                    ),
                    handle: {
                      breadcrumb: () => <span>{Page.Changes}</span>,
                      routeName: RouteConstants.toPullRequestChanges,
                      pageTitle: Page.Changes,
                      publicAccess: true,
                    },
                  },
                  {
                    path: "changes/:commitSHA",
                    element: (
                      <PullRequestDataProvider>
                        <PullRequestChanges />
                      </PullRequestDataProvider>
                    ),
                    handle: {
                      breadcrumb: () => <span>{Page.Changes}</span>,
                      routeName: RouteConstants.toPullRequestChange,
                      pageTitle: Page.Changes,
                      publicAccess: true,
                    },
                  },
                ],
              },
            ],
          },
          {
            path: "pipelines",
            handle: {
              breadcrumb: () => <span>{Page.Pipelines}</span>,
              routeName: RouteConstants.toRepoPipelines,
            },
            children: [
              {
                index: true,
                element: <RepoPipelineListPage />,
                handle: {
                  pageTitle: Page.Pipelines,
                },
              },
              {
                path: ":pipelineId",
                handle: {
                  breadcrumb: ({ pipelineId }: { pipelineId: string }) => <span>{pipelineId}</span>,
                },
                children: [
                  {
                    index: true,
                    element: <RepoExecutionListPage />,
                    handle: {
                      breadcrumb: () => <span>{Page.Executions}</span>,
                      pageTitle: Page.Executions,
                    },
                  },
                  {
                    path: "edit",
                    element: <RepoPipelineEditPage />,
                    handle: {
                      breadcrumb: () => <span>Edit</span>,
                      routeName: RouteConstants.toPipelineEdit,
                    },
                  },
                  {
                    path: "executions",
                    handle: {
                      routeName: RouteConstants.toExecutions,
                    },
                    children: [
                      {
                        index: true,
                        element: <RepoExecutionListPage />,
                        handle: { pageTitle: Page.Executions },
                      },
                      {
                        path: ":executionId",
                        element: <RepoExecutionDetailsPage />,
                        handle: {
                          breadcrumb: ({ executionId }: { executionId: string }) => (
                            <span>{executionId}</span>
                          ),
                          routeName: RouteConstants.toExecution,
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            path: "webhooks",
            element: <Navigate to="../settings/webhooks" replace />,
          },
          {
            path: "intents",
            element: <RepoDeltaIntentsPage />,
            handle: {
              breadcrumb: () => <span>Merge intents</span>,
              routeName: RouteConstants.toRepoIntents,
              pageTitle: "Merge intents",
            },
          },
          {
            path: "ideas",
            element: <RepoDeltaIdeasPage />,
            handle: {
              breadcrumb: () => <span>Ideas</span>,
              routeName: RouteConstants.toRepoIdeas,
              pageTitle: "Ideas",
            },
          },
          {
            path: "arena",
            handle: {
              breadcrumb: () => <span>Arena</span>,
              routeName: RouteConstants.toRepoArena,
              pageTitle: "Arena",
            },
            children: [
              {
                index: true,
                element: <RepoDeltaArenaPage />,
              },
              {
                path: ":matchId",
                element: <RepoDeltaArenaMatchPage />,
                handle: {
                  breadcrumb: ({ matchId }: { matchId: string }) => <span>{matchId}</span>,
                  routeName: RouteConstants.toRepoArenaMatch,
                },
              },
            ],
          },
          {
            path: "agents",
            element: <RepoDeltaAgentsPage />,
            handle: {
              breadcrumb: () => <span>Agents</span>,
              routeName: RouteConstants.toRepoAgents,
              pageTitle: "Agents",
            },
          },
          {
            path: "knowledge",
            element: <RepoDeltaKnowledgePage />,
            handle: {
              breadcrumb: () => <span>Knowledge</span>,
              routeName: RouteConstants.toRepoKnowledge,
              pageTitle: "Knowledge",
            },
          },
          // GitHub-parity stub surfaces — keep the tab IA legible while the
          // real implementations land phase by phase.
          {
            path: "issues",
            element: <RepoIssuesPage />,
            handle: {
              breadcrumb: () => <span>Issues</span>,
              pageTitle: "Issues",
              publicAccess: true,
            },
          },
          {
            path: "issues/new",
            element: <RepoIssueNewPage />,
            handle: {
              breadcrumb: () => <span>New issue</span>,
              pageTitle: "New issue",
            },
          },
          {
            path: "issues/:issueNumber",
            element: <RepoIssueDetailPage />,
            handle: {
              breadcrumb: () => <span>Issue</span>,
              pageTitle: "Issue",
              publicAccess: true,
            },
          },
          {
            path: "discussions",
            element: <RepoDiscussionsPage />,
            handle: {
              breadcrumb: () => <span>Discussions</span>,
              pageTitle: "Discussions",
              publicAccess: true,
            },
          },
          {
            path: "discussions/new",
            element: <RepoDiscussionNewPage />,
            handle: {
              breadcrumb: () => <span>New discussion</span>,
              pageTitle: "New discussion",
            },
          },
          {
            path: "discussions/:discussionNumber",
            element: <RepoDiscussionDetailPage />,
            handle: {
              breadcrumb: () => <span>Discussion</span>,
              pageTitle: "Discussion",
              publicAccess: true,
            },
          },
          {
            path: "projects",
            element: <RepoProjectsPage />,
            handle: {
              breadcrumb: () => <span>Projects</span>,
              pageTitle: "Projects",
              publicAccess: true,
            },
          },
          {
            path: "projects/:projectId",
            element: <RepoProjectBoardPage />,
            handle: {
              breadcrumb: () => <span>Project</span>,
              pageTitle: "Project",
              publicAccess: true,
            },
          },
          {
            path: "wiki",
            element: <RepoWikiPage />,
            handle: {
              breadcrumb: () => <span>Wiki</span>,
              pageTitle: "Wiki",
              publicAccess: true,
            },
          },
          {
            path: "wiki/new",
            element: <RepoWikiEditPage />,
            handle: {
              breadcrumb: () => <span>New wiki page</span>,
              pageTitle: "New wiki page",
            },
          },
          {
            path: "wiki/:page",
            element: <RepoWikiPage />,
            handle: {
              breadcrumb: () => <span>Wiki</span>,
              pageTitle: "Wiki",
              publicAccess: true,
            },
          },
          {
            path: "wiki/:page/edit",
            element: <RepoWikiEditPage />,
            handle: {
              breadcrumb: () => <span>Edit wiki page</span>,
              pageTitle: "Edit wiki page",
            },
          },
          {
            path: "releases",
            element: <RepoReleasesPage />,
            handle: {
              breadcrumb: () => <span>Releases</span>,
              pageTitle: "Releases",
              publicAccess: true,
            },
          },
          {
            path: "releases/new",
            element: <RepoReleaseNewPage />,
            handle: {
              breadcrumb: () => <span>New release</span>,
              pageTitle: "New release",
            },
          },
          {
            path: "releases/:releaseId",
            element: <RepoReleaseDetailPage />,
            handle: {
              breadcrumb: () => <span>Release</span>,
              pageTitle: "Release",
              publicAccess: true,
            },
          },
          {
            path: "security",
            element: <RepoStubPage surface="security" />,
            handle: {
              breadcrumb: () => <span>Security</span>,
              pageTitle: "Security",
              publicAccess: true,
            },
          },
          {
            path: "insights",
            element: <RepoInsightsPage />,
            handle: {
              breadcrumb: () => <span>Insights</span>,
              pageTitle: "Insights",
              publicAccess: true,
            },
          },
          {
            path: "settings",
            element: <RepoSettingsLayout />,
            handle: {
              breadcrumb: () => <span>{Page.Settings}</span>,
              pageTitle: Page.Settings,
            },
            children: [
              {
                index: true,
                element: <Navigate to="general" replace />,
              },
              {
                path: "general",
                element: <RepoSettingsGeneralPageContainer />,
                handle: {
                  breadcrumb: () => <span>{Page.General}</span>,
                  routeName: RouteConstants.toRepoGeneralSettings,
                  pageTitle: Page.General,
                },
              },
              {
                path: "rules",
                handle: {
                  breadcrumb: () => <span>{Page.Branch_Rules}</span>,
                  routeName: RouteConstants.toRepoBranchRules,
                },
                children: [
                  {
                    index: true,
                    element: <RepoSettingsRulesListContainer />,
                    handle: {
                      pageTitle: Page.Branch_Rules,
                    },
                  },
                  {
                    path: "create/branch",
                    element: <RepoBranchRulesContainer />,
                    handle: {
                      breadcrumb: () => <span>Create a branch rule</span>,
                      routeName: RouteConstants.toRepoBranchRuleCreate,
                    },
                  },
                  {
                    path: "create/tag",
                    element: <RepoTagRulesContainer />,
                    handle: {
                      breadcrumb: () => <span>Create a tag rule</span>,
                      routeName: RouteConstants.toRepoTagRuleCreate,
                    },
                  },
                  {
                    path: "create/push",
                    element: <RepoPushRulesContainer />,
                    handle: {
                      breadcrumb: () => <span>Create a push rule</span>,
                      routeName: RouteConstants.toRepoPushRuleCreate,
                    },
                  },
                  {
                    path: ":identifier/edit",
                    element: <RepoRulesContainer />,
                    handle: {
                      breadcrumb: ({ identifier }: { identifier: string }) => (
                        <span>{identifier}</span>
                      ),
                      routeName: RouteConstants.toRepoBranchRule,
                    },
                  },
                ],
              },
              {
                path: "webhooks",
                handle: {
                  breadcrumb: () => <span>Webhooks</span>,
                  routeName: RouteConstants.toRepoWebhooks,
                },
                children: [
                  {
                    index: true,
                    element: <WebhookListPage />,
                    handle: {
                      pageTitle: "Webhooks",
                    },
                  },
                  {
                    path: "create",
                    element: <CreateWebhookContainer />,
                    handle: {
                      breadcrumb: () => <span>Create a webhook</span>,
                      routeName: RouteConstants.toRepoWebhookCreate,
                    },
                  },
                ],
              },
              {
                path: "labels",
                handle: {
                  breadcrumb: () => <span>{Page.Labels}</span>,
                  pageTitle: Page.Labels,
                  routeName: RouteConstants.toRepoLabels,
                },
                children: [
                  {
                    index: true,
                    element: <RepoLabelsList />,
                  },
                  {
                    path: "create",
                    element: <RepoLabelFormContainer />,
                    handle: {
                      breadcrumb: () => <span>Create a label</span>,
                    },
                  },
                  {
                    path: ":labelId",
                    element: <RepoLabelFormContainer />,
                    handle: {
                      breadcrumb: ({ labelId }: { labelId: string }) => <span>{labelId}</span>,
                      routeName: RouteConstants.toRepoLabelDetails,
                    },
                  },
                ],
              },
            ],
          },

          {
            path: "settings/webhooks/:webhookId",
            element: <WebhookSettingsLayout />,
            children: [
              {
                index: true,
                element: <Navigate to="details" replace />,
              },
              {
                path: "details",
                element: <CreateWebhookContainer />,
                handle: {
                  breadcrumb: ({ webhookId }: { webhookId: string }) => (
                    <Breadcrumb.Item>
                      <span>{webhookId}</span> <Breadcrumb.Separator />
                      <span className="ml-cn-2xs">Details</span>
                    </Breadcrumb.Item>
                  ),
                  routeName: RouteConstants.toRepoWebhookDetails,
                },
              },
              {
                path: "executions",
                element: <WebhookExecutionsContainer />,
                handle: {
                  breadcrumb: ({ webhookId }: { webhookId: string }) => (
                    <Breadcrumb.Item>
                      <span>{webhookId}</span> <Breadcrumb.Separator />
                      <span className="ml-cn-2xs">Executions</span>
                    </Breadcrumb.Item>
                  ),
                  routeName: RouteConstants.toRepoWebhookExecutions,
                },
              },
              {
                path: "executions/:executionId",
                element: <WebhookExecutionDetailsContainer />,
                handle: {
                  breadcrumb: ({
                    webhookId,
                    executionId,
                  }: {
                    webhookId: string;
                    executionId: string;
                  }) => (
                    <Breadcrumb.Item>
                      <span>{webhookId}</span> <Breadcrumb.Separator />
                      <span className="ml-cn-2xs">Executions</span>
                      <Breadcrumb.Separator className="mx-cn-2xs" />
                      <span>{executionId}</span>
                    </Breadcrumb.Item>
                  ),
                  routeName: RouteConstants.toRepoWebhookExecutionDetails,
                },
              },
            ],
          },
        ],
      },
    ],
  },
  {
    path: "settings",
    element: <ProjectSettingsLayout />,
    handle: {
      breadcrumb: () => <span>{Page.Settings}</span>,
      pageTitle: Page.Settings,
    },
    children: [
      {
        index: true,
        element: <Navigate to="general" replace />,
      },
      {
        path: "general",
        element: <ProjectGeneralSettingsPageContainer />,
        handle: {
          breadcrumb: () => <span>{Page.General}</span>,
          routeName: RouteConstants.toProjectGeneral,
          pageTitle: Page.General,
        },
      },
      {
        path: "members",
        element: <ProjectMemberListPage />,
        handle: {
          breadcrumb: () => <span>{Page.Members}</span>,
          routeName: RouteConstants.toProjectMembers,
          pageTitle: Page.Members,
        },
      },
      labelsRoute,
      rulesRoute,
    ],
  },
  {
    path: "search",
    element: <SearchPage />,
    handle: {
      breadcrumb: () => <span>{Page.Search}</span>,
      pageTitle: Page.Search,
      publicAccess: true,
    },
  },
  {
    path: "manage-repositories",
    element: <ProjectSettingsLayout />,
    handle: {
      breadcrumb: () => <span>{Page.Settings}</span>,
      pageTitle: Page.Settings,
    },
    children: [
      {
        index: true,
        element: <Navigate to="labels" replace />,
      },
      labelsRoute,
      rulesRoute,
    ],
  },
  {
    path: "pulls",
    handle: {
      breadcrumb: () => <span>{Page.Pull_Requests}</span>,
      routeName: RouteConstants.toProjectPullRequests,
    },
    children: [
      {
        index: true,
        element: <ProjectPullRequestListPage />,
        handle: {
          pageTitle: Page.Pull_Requests,
        },
      },
    ],
  },
];

export const routes: CustomRouteObject[] = [
  {
    path: "/",
    element: (
      <AppRouterProvider>
        <PageTitleProvider>
          <AppProvider>
            <Sidebar.Provider className="min-h-svh">
              <ComponentProvider
                components={{ RbacButton, RbacSplitButton, RbacMoreActionsTooltip }}
              >
                <AppShell />
              </ComponentProvider>
            </Sidebar.Provider>
          </AppProvider>
        </PageTitleProvider>
      </AppRouterProvider>
    ),
    handle: { routeName: "toHome" },
    children: [
      {
        index: true,
        element: <LandingPage />,
        handle: {
          pageTitle: Page.Home,
        },
      },
      {
        path: "import",
        element: <ImportProjectContainer />,
        handle: {
          breadcrumb: () => <span>Import project</span>,
          routeName: RouteConstants.toImportProject,
        },
      },
      {
        path: "explore",
        element: <ExplorePage />,
        handle: {
          breadcrumb: () => <span>Explore</span>,
          pageTitle: "Explore",
          publicAccess: true,
        },
      },
      {
        path: "secrets",
        element: <SecretsVaultPage />,
        handle: {
          routeName: RouteConstants.toSecrets,
          pageTitle: "Secrets",
        },
      },
      {
        path: "notifications",
        element: <NotificationsPage />,
        handle: {
          breadcrumb: () => <span>Notifications</span>,
          routeName: RouteConstants.toNotifications,
          pageTitle: "Notifications",
        },
      },
      {
        path: "environments",
        element: <EnvironmentsPage />,
        handle: {
          breadcrumb: () => <span>Environments</span>,
          routeName: RouteConstants.toEnvironments,
          pageTitle: "Environments",
        },
      },
      {
        path: "artifacts",
        element: <ArtifactsPage />,
        handle: {
          breadcrumb: () => <span>Artifacts</span>,
          routeName: RouteConstants.toArtifacts,
          pageTitle: "Artifacts",
        },
      },
      {
        path: "feature-flags",
        element: <FeatureFlagsPage />,
        handle: { routeName: RouteConstants.toFeatureFlags, pageTitle: "Feature Flags" },
      },
      {
        path: "connectors",
        element: <ConnectorsPage />,
        handle: { routeName: RouteConstants.toConnectors, pageTitle: "Connectors" },
      },
      {
        path: "delegates",
        element: <DelegatesPage />,
        handle: { routeName: RouteConstants.toDelegates, pageTitle: "Delegates" },
      },
      {
        path: "file-store",
        element: <FileStorePage />,
        handle: { routeName: RouteConstants.toFileStore, pageTitle: "File store" },
      },
      {
        path: "templates",
        element: <SpaceTemplatesPage />,
        handle: { routeName: RouteConstants.toTemplates, pageTitle: "Templates" },
      },
      {
        path: "variables",
        element: <VariablesPage />,
        handle: { routeName: RouteConstants.toVariables, pageTitle: "Variables" },
      },
      {
        path: "freeze-windows",
        element: <FreezeWindowsPage />,
        handle: { routeName: RouteConstants.toFreezeWindows, pageTitle: "Freeze windows" },
      },
      {
        path: "external-tickets",
        element: <ExternalTicketsPage />,
        handle: { routeName: RouteConstants.toExternalTickets, pageTitle: "External tickets" },
      },
      {
        path: "policies",
        element: <PoliciesPage />,
        handle: { routeName: RouteConstants.toPolicies, pageTitle: "Policies" },
      },
      {
        path: "gitops",
        element: <GitOpsPage />,
        handle: { routeName: RouteConstants.toGitOps, pageTitle: "GitOps" },
      },
      {
        path: "iac",
        element: <IaCPage />,
        handle: {
          routeName: RouteConstants.toInfrastructureAsCode,
          pageTitle: "Infrastructure as Code",
        },
      },
      {
        path: "monitored-services",
        element: <MonitorsPage />,
        handle: { routeName: RouteConstants.toMonitoredServices, pageTitle: "Monitors" },
      },
      {
        path: "slo-downtime",
        element: <SloDowntimePage />,
        handle: { routeName: RouteConstants.toSloDowntime, pageTitle: "SLOs & downtime" },
      },
      {
        path: "incidents",
        element: <IncidentsPage />,
        handle: { routeName: RouteConstants.toIncidents, pageTitle: "Incidents" },
      },
      {
        path: "certificates",
        element: <CertificatesPage />,
        handle: { routeName: RouteConstants.toCertificates, pageTitle: "Certificates" },
      },
      {
        path: "cloud-costs",
        element: <CloudCostsPage />,
        handle: { routeName: RouteConstants.toCloudCosts, pageTitle: "Cloud costs" },
      },
      {
        path: "chaos",
        element: <ChaosPage />,
        handle: { routeName: RouteConstants.toChaos, pageTitle: "Chaos engineering" },
      },
      {
        path: "service-reliability",
        element: <ServiceReliabilityPage />,
        handle: {
          routeName: RouteConstants.toServiceReliability,
          pageTitle: "Service reliability",
        },
      },
      {
        path: "dev-portal",
        element: <DevPortalPage />,
        handle: { routeName: RouteConstants.toDevPortal, pageTitle: "Developer portal" },
      },
      {
        path: "discovery",
        element: <DevPortalPage />,
        handle: { routeName: RouteConstants.toDiscovery, pageTitle: "Discovery" },
      },
      {
        path: "dev-environments",
        element: <DevEnvironmentsPage />,
        handle: { routeName: RouteConstants.toDevEnvironments, pageTitle: "Dev environments" },
      },
      {
        path: "dev-insights",
        element: <DevInsightsPage />,
        handle: { routeName: RouteConstants.toDevInsights, pageTitle: "Developer insights" },
      },
      {
        path: "databases",
        element: <DatabasesPage />,
        handle: { routeName: RouteConstants.toDatabases, pageTitle: "Databases" },
      },
      {
        path: "security-tests",
        element: <SecurityTestsPage />,
        handle: { routeName: RouteConstants.toSecurityTests, pageTitle: "Security tests" },
      },
      {
        path: "supply-chain",
        element: <SupplyChainPage />,
        handle: { routeName: RouteConstants.toSupplyChain, pageTitle: "Supply chain" },
      },
      {
        path: "dashboards",
        element: <DashboardsPage />,
        handle: { routeName: RouteConstants.toDashboards, pageTitle: "Dashboards" },
      },
      {
        path: "overrides",
        element: <SloDowntimePage />,
        handle: { routeName: RouteConstants.toOverrides, pageTitle: "Overrides" },
      },
      {
        path: "arena",
        element: <DeltaArenaFeedPage />,
        handle: {
          breadcrumb: () => <span>Arena</span>,
          routeName: RouteConstants.toArena,
          pageTitle: "Arena",
        },
      },
      {
        path: "agents",
        element: <DeltaLeaderboardPage />,
        handle: {
          breadcrumb: () => <span>Reputation</span>,
          routeName: RouteConstants.toReputation,
          pageTitle: "Reputation",
        },
      },
      {
        path: ":spaceId",
        handle: {
          breadcrumb: () => <ProjectDropdown />,
          asLink: false,
        },
        children: repoRoutes,
      },
      {
        path: "admin",
        handle: {
          breadcrumb: () => <span>Account</span>,
        },
        children: [
          {
            index: true,
            element: <Navigate to="default-settings" replace />,
          },
          {
            index: true,
            path: "default-settings",
            element: <UserManagementPageContainer />,
            handle: {
              breadcrumb: () => <span>Users</span>,
              routeName: RouteConstants.toAdminUsers,
              pageTitle: "Users",
            },
          },
          {
            path: "user-groups",
            element: <AdminUserGroupsPage />,
            handle: {
              breadcrumb: () => <span>User Groups</span>,
              routeName: RouteConstants.toUserGroups,
              pageTitle: "User Groups",
            },
          },
          {
            path: "service-accounts",
            element: <AdminServiceAccountsPage />,
            handle: {
              breadcrumb: () => <span>Service Accounts</span>,
              routeName: RouteConstants.toServiceAccounts,
            },
          },
          {
            path: "resource-groups",
            element: <AdminResourceGroupsPage />,
            handle: {
              breadcrumb: () => <span>Resource Groups</span>,
              routeName: RouteConstants.toResourceGroups,
            },
          },
          {
            path: "roles",
            element: <AdminRolesPage />,
            handle: {
              breadcrumb: () => <span>Roles</span>,
              routeName: RouteConstants.toRoles,
            },
          },
        ],
      },
      {
        path: "profile-settings",
        element: <ProfileSettingsLayout />,
        handle: {
          breadcrumb: () => (
            <Layout.Flex direction="row" align="center" gap="xs">
              <span>User</span>
              <Breadcrumb.Separator />
              <span>{Page.Settings}</span>
            </Layout.Flex>
          ),
          pageTitle: Page.Settings,
        },
        children: [
          {
            index: true,
            element: <Navigate to="general" replace />,
            handle: {
              breadcrumb: () => <span>{Page.General}</span>,
            },
          },
          {
            path: "general",
            element: <SettingsProfileGeneralPage />,
            handle: {
              breadcrumb: () => <span>{Page.General}</span>,
              routeName: RouteConstants.toProfileGeneral,
              pageTitle: Page.General,
            },
          },
          {
            path: "keys",
            element: <SettingsProfileKeysPage />,
            handle: {
              breadcrumb: () => <span>{Page.Keys}</span>,
              routeName: RouteConstants.toProfileKeys,
              pageTitle: Page.Keys,
            },
          },
        ],
      },
    ],
  },
  {
    path: "create",
    element: (
      <AppProvider>
        <CreateProject />
      </AppProvider>
    ),
    handle: { routeName: RouteConstants.toProjectCreate },
  },
  {
    path: "signin",
    element: <SignIn />,
    handle: { routeName: RouteConstants.toSignIn },
  },
  {
    // Client-side atproto OAuth redirect target — the same-tab Bluesky flow
    // lands back here to finish the token exchange (see delta/bsky-oauth.ts).
    path: "oauth/callback",
    element: <OAuthCallback />,
  },
  {
    // delta-git OAuth 2.1 consent screen — client-rendered; calls
    // /oauth/authorize/info + /oauth/authorize/decision (see
    // delta/oauth-authorize.tsx and src/worker/routes/oauthProvider.ts).
    path: "oauth/authorize",
    element: <OAuthAuthorize />,
  },
  {
    path: "signup",
    element: <SignUp />,
  },
  {
    path: "logout",
    element: <Logout />,
    handle: { routeName: RouteConstants.toLogout },
  },
];

export const getMFERoutes = (mfeProjectId?: string): CustomRouteObject[] => [
  {
    path: "/",
    element: (
      <AppRouterProvider>
        <PageTitleProvider>
          <AppProvider>
            <ComponentProvider components={{ RbacButton, RbacSplitButton, RbacMoreActionsTooltip }}>
              <MFERouteRenderer />
              <AppShellMFE />
            </ComponentProvider>
          </AppProvider>
        </PageTitleProvider>
      </AppRouterProvider>
    ),
    handle: { routeName: RouteConstants.toHome },
    children: [
      {
        path: "",
        handle: {
          ...(mfeProjectId && {
            breadcrumb: () => <span>{mfeProjectId}</span>,
          }),
        },
        children: repoRoutes,
      },
      {
        path: "profile-settings",
        element: <ProfileSettingsLayout />,
        handle: {
          breadcrumb: () => (
            <>
              <span>User</span>
              <Breadcrumb.Separator className="mx-cn-2xs" />
              <span>{Page.Settings}</span>
            </>
          ),
          pageTitle: Page.Settings,
        },
        children: [
          {
            index: true,
            element: <Navigate to="general" replace />,
            handle: {
              breadcrumb: () => <span>{Page.General}</span>,
            },
          },
          {
            path: "general",
            element: <SettingsProfileGeneralPage />,
            handle: {
              breadcrumb: () => <span>{Page.General}</span>,
              routeName: RouteConstants.toProfileGeneral,
              pageTitle: Page.General,
            },
          },
          {
            path: "keys",
            element: <SettingsProfileKeysPage />,
            handle: {
              breadcrumb: () => <span>{Page.Keys}</span>,
              routeName: RouteConstants.toProfileKeys,
              pageTitle: Page.Keys,
            },
          },
        ],
      },
    ],
  },
];
