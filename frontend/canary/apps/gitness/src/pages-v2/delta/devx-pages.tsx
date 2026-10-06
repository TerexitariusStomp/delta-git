import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button, SandboxLayout, StatusBadge, Table, Text, TextInput } from "@harnessio/ui/components";

import { deltaApi, SpacePicker, useSpacePicker } from "./module-pages";

/**
 * Wave-4 devx pages — portal catalog (also serves "discovery"), dev
 * environments, dev insights, databases + migration ledger, security tests,
 * supply chain, and dashboards.
 */

function PageShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content className="px-cn-lg py-cn-xl">
        <Text variant="heading-section" className="mb-cn-md">
          {title}
        </Text>
        {children}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <Text className="mt-cn-md text-cn-foreground-3">{text}</Text>;
}

// --- developer portal (catalog) -------------------------------------------------

interface CatalogItem {
  id: string;
  identifier: string;
  kind: string;
  owner: string | null;
  description: string | null;
  repository_id: string | null;
  created: number;
}

export function DevPortalPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [kind, setKind] = useState("service");
  const [repo, setRepo] = useState("");

  const { data } = useQuery(
    ["catalog", space],
    () => deltaApi<CatalogItem[]>(`/api/v1/spaces/${space}/catalog`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/catalog`, {
        method: "POST",
        body: JSON.stringify({ identifier, kind, repo: repo || undefined }),
      }),
    {
      onSuccess: () => {
        setIdentifier("");
        setRepo("");
        queryClient.invalidateQueries(["catalog", space]);
      },
    }
  );

  return (
    <PageShell title="Developer portal">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <Text className="mb-cn-md text-cn-foreground-3">
        The software catalog — services, sites, libraries, and APIs in this space.
      </Text>
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput label="Identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="api-svc" />
        <select
          className="rounded-cn-md border border-cn-borders-2 bg-cn-background-1 px-cn-md py-cn-sm text-cn-foreground-1"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="service">service</option>
          <option value="website">website</option>
          <option value="library">library</option>
          <option value="api">api</option>
        </select>
        <TextInput label="Repo (optional)" value={repo} onChange={(e) => setRepo(e.target.value)} />
        <Button disabled={!identifier.trim() || create.isLoading} onClick={() => create.mutate()}>
          Register
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identifier</Table.Head>
            <Table.Head>Kind</Table.Head>
            <Table.Head>Owner</Table.Head>
            <Table.Head>Linked repo</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((e) => (
            <Table.Row key={e.id}>
              <Table.Cell>{e.identifier}</Table.Cell>
              <Table.Cell>
                <StatusBadge variant="outline">{e.kind}</StatusBadge>
              </Table.Cell>
              <Table.Cell>{e.owner ?? "—"}</Table.Cell>
              <Table.Cell>{e.repository_id ? "linked" : "—"}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="Catalog is empty." />}
    </PageShell>
  );
}

// --- dev environments --------------------------------------------------------------

interface DevEnvItem {
  id: string;
  identifier: string;
  status: string;
  machine_type: string;
  created_by: string;
  last_used: number | null;
}

export function DevEnvironmentsPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [repo, setRepo] = useState("");

  const { data } = useQuery(
    ["devenvs", space],
    () => deltaApi<DevEnvItem[]>(`/api/v1/spaces/${space}/dev-environments`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/dev-environments`, {
        method: "POST",
        body: JSON.stringify({ identifier, repo: repo || undefined }),
      }),
    {
      onSuccess: () => {
        setIdentifier("");
        setRepo("");
        queryClient.invalidateQueries(["devenvs", space]);
      },
    }
  );
  const act = useMutation(
    (vars: { id: string; action: "start" | "stop" }) =>
      deltaApi(`/api/v1/spaces/${space}/dev-environments/${vars.id}/${vars.action}`, {
        method: "POST",
        body: "{}",
      }),
    { onSuccess: () => queryClient.invalidateQueries(["devenvs", space]) }
  );

  return (
    <PageShell title="Dev environments">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput label="Identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="ws-1" />
        <TextInput label="Repo (optional)" value={repo} onChange={(e) => setRepo(e.target.value)} />
        <Button disabled={!identifier.trim() || create.isLoading} onClick={() => create.mutate()}>
          Create
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identifier</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Machine</Table.Head>
            <Table.Head>Last used</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((e) => (
            <Table.Row key={e.id}>
              <Table.Cell>{e.identifier}</Table.Cell>
              <Table.Cell>
                <StatusBadge variant="status" theme={e.status === "running" ? "success" : "muted"}>
                  {e.status}
                </StatusBadge>
              </Table.Cell>
              <Table.Cell>{e.machine_type}</Table.Cell>
              <Table.Cell>{e.last_used ? new Date(e.last_used).toLocaleString() : "never"}</Table.Cell>
              <Table.Cell>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    act.mutate({ id: e.identifier, action: e.status === "running" ? "stop" : "start" })
                  }
                >
                  {e.status === "running" ? "Stop" : "Start"}
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No dev environments." />}
    </PageShell>
  );
}

// --- dev insights ----------------------------------------------------------------------

interface InsightsData {
  repositories: number;
  members: number;
  artifacts: number;
  monitors_up: number;
  monitors_down: number;
  open_incidents: number;
  security_tests_week: number;
  security_findings_week: number;
  pushes_week: number;
  merges_week: number;
  merge_lead_time_ms: number | null;
}

export function DevInsightsPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const { data } = useQuery(
    ["insights", space],
    () => deltaApi<InsightsData>(`/api/v1/spaces/${space}/insights`),
    { enabled: !!space }
  );

  const cards: { label: string; value: number | undefined; suffix?: string }[] = [
    { label: "Repositories", value: data?.repositories },
    { label: "Members", value: data?.members },
    { label: "Artifacts", value: data?.artifacts },
    { label: "Monitors up", value: data?.monitors_up },
    { label: "Monitors down", value: data?.monitors_down },
    { label: "Open incidents", value: data?.open_incidents },
    { label: "Security tests (7d)", value: data?.security_tests_week },
    { label: "Security findings (7d)", value: data?.security_findings_week },
    { label: "Pushes (7d)", value: data?.pushes_week },
    { label: "Merges (7d)", value: data?.merges_week },
    {
      label: "Merge lead time",
      value:
        data?.merge_lead_time_ms != null
          ? Math.round(data.merge_lead_time_ms / 60000)
          : undefined,
      suffix: data?.merge_lead_time_ms != null ? "min" : undefined,
    },
  ];

  return (
    <PageShell title="Developer insights">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <div className="grid grid-cols-2 gap-cn-md md:grid-cols-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="rounded-cn-md border border-cn-borders-2 bg-cn-background-2 p-cn-lg"
          >
            <div className="text-2xl font-semibold text-cn-foreground-1">
              {card.value ?? "—"}
              {card.suffix && <span className="text-sm text-cn-foreground-3"> {card.suffix}</span>}
            </div>
            <div className="text-sm text-cn-foreground-3">{card.label}</div>
          </div>
        ))}
      </div>
    </PageShell>
  );
}

// --- databases -----------------------------------------------------------------------------

interface DbItem {
  id: string;
  identifier: string;
  engine: string;
  host: string | null;
  status: string;
  migrations: { version: string; appliedAt: number }[];
}

export function DatabasesPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [engine, setEngine] = useState("postgres");
  const [version, setVersion] = useState("");

  const { data } = useQuery(
    ["databases", space],
    () => deltaApi<DbItem[]>(`/api/v1/spaces/${space}/databases`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/databases`, {
        method: "POST",
        body: JSON.stringify({ identifier, engine }),
      }),
    {
      onSuccess: () => {
        setIdentifier("");
        queryClient.invalidateQueries(["databases", space]);
      },
    }
  );
  const applyMigration = useMutation(
    (vars: { id: string; version: string }) =>
      deltaApi(`/api/v1/spaces/${space}/databases/${vars.id}/migrations`, {
        method: "POST",
        body: JSON.stringify({ version: vars.version }),
      }),
    {
      onSuccess: () => {
        setVersion("");
        queryClient.invalidateQueries(["databases", space]);
      },
    }
  );

  return (
    <PageShell title="Databases">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput label="Identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="main-db" />
        <select
          className="rounded-cn-md border border-cn-borders-2 bg-cn-background-1 px-cn-md py-cn-sm text-cn-foreground-1"
          value={engine}
          onChange={(e) => setEngine(e.target.value)}
        >
          <option value="postgres">postgres</option>
          <option value="mysql">mysql</option>
          <option value="sqlite">sqlite</option>
          <option value="d1">d1</option>
        </select>
        <Button disabled={!identifier.trim() || create.isLoading} onClick={() => create.mutate()}>
          Register
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identifier</Table.Head>
            <Table.Head>Engine</Table.Head>
            <Table.Head>Host</Table.Head>
            <Table.Head>Migrations</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((d) => (
            <Table.Row key={d.id}>
              <Table.Cell>{d.identifier}</Table.Cell>
              <Table.Cell>
                <StatusBadge variant="outline">{d.engine}</StatusBadge>
              </Table.Cell>
              <Table.Cell>{d.host ?? "—"}</Table.Cell>
              <Table.Cell>{d.migrations.length}</Table.Cell>
              <Table.Cell>
                <div className="flex items-center gap-cn-sm">
                  <TextInput
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    placeholder="0002_add_idx"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!version.trim()}
                    onClick={() => applyMigration.mutate({ id: d.identifier, version })}
                  >
                    Apply
                  </Button>
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No databases registered." />}
    </PageShell>
  );
}

// --- security tests ------------------------------------------------------------------------------

interface SecurityTestItem {
  id: string;
  kind: string;
  target: string;
  status: string;
  findings: number;
  created: number;
  finished: number | null;
}

export function SecurityTestsPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const { data } = useQuery(
    ["security-tests", space],
    () => deltaApi<SecurityTestItem[]>(`/api/v1/spaces/${space}/security-tests`),
    { enabled: !!space }
  );

  return (
    <PageShell title="Security tests">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <Text className="mb-cn-md text-cn-foreground-3">
        SAST/DAST/secrets/deps jobs — queued here, executed by delegates or the dgit CLI on
        client machines, results posted back.
      </Text>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Kind</Table.Head>
            <Table.Head>Target</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Findings</Table.Head>
            <Table.Head>Finished</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((t) => (
            <Table.Row key={t.id}>
              <Table.Cell>
                <StatusBadge variant="outline">{t.kind}</StatusBadge>
              </Table.Cell>
              <Table.Cell>
                <code className="text-xs">{t.target}</code>
              </Table.Cell>
              <Table.Cell>
                <StatusBadge
                  variant="status"
                  theme={t.status === "pass" ? "success" : t.status === "fail" ? "danger" : "muted"}
                >
                  {t.status}
                </StatusBadge>
              </Table.Cell>
              <Table.Cell>{t.findings}</Table.Cell>
              <Table.Cell>{t.finished ? new Date(t.finished).toLocaleString() : "—"}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No security tests." />}
    </PageShell>
  );
}

// --- supply chain ----------------------------------------------------------------------------------

interface SupplyChainItem {
  id: string;
  kind: string;
  repository_id: string;
  commit_oid: string | null;
  created_by: string;
  created: number;
}

export function SupplyChainPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const { data } = useQuery(
    ["supply-chain", space],
    () => deltaApi<SupplyChainItem[]>(`/api/v1/spaces/${space}/supply-chain`),
    { enabled: !!space }
  );

  return (
    <PageShell title="Supply chain">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <Text className="mb-cn-md text-cn-foreground-3">
        SBOMs, provenance statements, and attestations bound to repos and commits.
      </Text>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Kind</Table.Head>
            <Table.Head>Commit</Table.Head>
            <Table.Head>Created by</Table.Head>
            <Table.Head>Created</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((d) => (
            <Table.Row key={d.id}>
              <Table.Cell>
                <StatusBadge variant="outline">{d.kind}</StatusBadge>
              </Table.Cell>
              <Table.Cell>
                <code className="text-xs">{d.commit_oid?.slice(0, 12) ?? "—"}</code>
              </Table.Cell>
              <Table.Cell>{d.created_by.slice(0, 16)}</Table.Cell>
              <Table.Cell>{new Date(d.created).toLocaleString()}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No supply-chain documents." />}
    </PageShell>
  );
}

// --- dashboards ----------------------------------------------------------------------------------------

interface DashboardItem {
  id: string;
  identifier: string;
  layout: { widget?: string }[];
  updated: number;
}

export function DashboardsPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");

  const { data } = useQuery(
    ["dashboards", space],
    () => deltaApi<DashboardItem[]>(`/api/v1/spaces/${space}/dashboards`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/dashboards`, {
        method: "POST",
        body: JSON.stringify({ identifier, layout: [] }),
      }),
    {
      onSuccess: () => {
        setIdentifier("");
        queryClient.invalidateQueries(["dashboards", space]);
      },
    }
  );

  return (
    <PageShell title="Dashboards">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput label="Identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="main" />
        <Button disabled={!identifier.trim() || create.isLoading} onClick={() => create.mutate()}>
          Create
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identifier</Table.Head>
            <Table.Head>Widgets</Table.Head>
            <Table.Head>Updated</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((d) => (
            <Table.Row key={d.id}>
              <Table.Cell>{d.identifier}</Table.Cell>
              <Table.Cell>{d.layout.length}</Table.Cell>
              <Table.Cell>{new Date(d.updated).toLocaleString()}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No dashboards." />}
    </PageShell>
  );
}
