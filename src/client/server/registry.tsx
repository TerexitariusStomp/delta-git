import type { ReactElement } from "react";

import { clientEntrypoints, type ClientEntrypoint } from "@/client/entrypoints";
import { AuthSignInPage, type AuthSignInPageProps } from "@/client/pages/AuthSignInPage";
import { ErrorPage, type ErrorPageProps } from "@/client/pages/ErrorPage";
import { NotFoundPage } from "@/client/pages/NotFoundPage";

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

// Only the auth + chrome views remain SSR — all repo/space/delta pages moved
// to the Gitness SPA served at the site root.
const views: Record<string, ViewDefinition> = {
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
  "auth-signin": {
    kind: "document",
    title: "Sign in · git-on-cloudflare",
    clientEntrypoints: [clientEntrypoints.shell, clientEntrypoints.didSignin],
    render: renderWithProps((props: AuthSignInPageProps) => <AuthSignInPage {...props} />),
  },
};

export type UiViewName = keyof typeof views;

export function getViewDefinition(name: string): ViewDefinition | undefined {
  return views[name];
}
