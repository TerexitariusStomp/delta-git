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
  return <Text className="mt-cn-md text-cn-3">{text}</Text>;
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
      <Text className="mb-cn-md text-cn-3">
        The software catalog — services, sites, libraries, and APIs in this space.
      </Text>
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput label="Identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="api-svc" />
        <select
          className="rounded-cn-2 border border-cn-2 bg-cn-1 px-cn-md py-cn-sm text-cn-1"
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

interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

/** Terminal + file editor + preview for a running workspace. */
function WorkspacePanel({ space, envId }: { space: string; envId: string }) {
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<{ cmd: string; out: string; code: number }[]>([]);
  const [filePath, setFilePath] = useState("/workspace/repo");
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [listing, setListing] = useState<{ name: string; type?: string }[] | null>(null);
  const [previewPort, setPreviewPort] = useState("8080");

  const exec = useMutation(
    (cmd: string) =>
      deltaApi<ExecResult>(`/api/v1/spaces/${space}/dev-environments/${envId}/exec`, {
        method: "POST",
        body: JSON.stringify({ command: cmd }),
      }),
    {
      onSuccess: (res, cmd) => {
        const out = [res.stdout, res.stderr].filter(Boolean).join("\n");
        setHistory((h) => [...h, { cmd, out, code: res.exit_code }]);
      },
    }
  );

  const openPath = useMutation((path: string) =>
    deltaApi<{ entries?: { name: string; type?: string }[]; content?: string }>(
      `/api/v1/spaces/${space}/dev-environments/${envId}/workspace?path=${encodeURIComponent(path)}`
    ).then((res) => {
      setListing(res.entries ?? null);
      setFileContent(res.content ?? null);
      return res;
    })
  );
  const saveFile = useMutation(() =>
    deltaApi(`/api/v1/spaces/${space}/dev-environments/${envId}/workspace?path=${encodeURIComponent(filePath)}`, {
      method: "PUT",
      body: fileContent ?? "",
    })
  );

  return (
    <div className="mt-cn-md rounded-cn-md border border-cn-borders-2 p-cn-md">
      <Text variant="heading-subsection" className="mb-cn-sm">
        Workspace: {envId}
      </Text>

      <Text variant="body-strong" className="mb-cn-xs">Terminal</Text>
      <div className="mb-cn-sm max-h-64 overflow-y-auto rounded bg-cn-background-2 p-cn-sm font-mono text-cn-size-2">
        {history.map((h, i) => (
          <div key={i}>
            <div className="text-cn-3">$ {h.cmd}</div>
            <pre className="whitespace-pre-wrap">{h.out}</pre>
            <div className="text-cn-3">exit {h.code}</div>
          </div>
        ))}
        {history.length === 0 && <Text className="text-cn-3">Run a command in the staged worktree.</Text>}
      </div>
      <div className="mb-cn-md flex gap-cn-sm">
        <TextInput
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="npm test"
          onKeyDown={(e) => {
            if (e.key === "Enter" && command.trim()) {
              exec.mutate(command);
              setCommand("");
            }
          }}
        />
        <Button disabled={!command.trim() || exec.isLoading} onClick={() => { exec.mutate(command); setCommand(""); }}>
          Run
        </Button>
      </div>

      <Text variant="body-strong" className="mb-cn-xs">Files</Text>
      <div className="mb-cn-sm flex gap-cn-sm">
        <TextInput value={filePath} onChange={(e) => setFilePath(e.target.value)} />
        <Button variant="ghost" onClick={() => openPath.mutate(filePath)}>Open</Button>
      </div>
      {listing && (
        <div className="mb-cn-sm font-mono text-cn-size-2">
          {listing.map((f) => (
            <div key={f.name} className="cursor-pointer hover:underline" onClick={() => {
              const next = filePath.endsWith("/") ? filePath + f.name : `${filePath}/${f.name}`;
              setFilePath(next);
              openPath.mutate(next);
            }}>{f.name}</div>
          ))}
        </div>
      )}
      {fileContent !== null && (
        <div className="mb-cn-md">
          <textarea
            className="h-48 w-full rounded border border-cn-borders-2 bg-cn-background-2 p-cn-sm font-mono text-cn-size-2"
            value={fileContent}
            onChange={(e) => setFileContent(e.target.value)}
          />
          <Button className="mt-cn-xs" disabled={saveFile.isLoading} onClick={() => saveFile.mutate()}>
            Save
          </Button>
        </div>
      )}

      <Text variant="body-strong" className="mb-cn-xs">Preview</Text>
      <div className="flex items-end gap-cn-sm">
        <TextInput label="Port" value={previewPort} onChange={(e) => setPreviewPort(e.target.value)} />
        <a
          className="text-cn-1 underline"
          href={`/api/v1/spaces/${space}/dev-environments/${envId}/preview?port=${previewPort}`}
          target="_blank"
          rel="noreferrer"
        >
          Open preview
        </a>
      </div>
    </div>
  );
}

export function DevEnvironmentsPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [repo, setRepo] = useState("");
  const [openEnv, setOpenEnv] = useState<string | null>(null);

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
                <div className="flex gap-cn-xs">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      act.mutate({ id: e.identifier, action: e.status === "running" ? "stop" : "start" })
                    }
                  >
                    {e.status === "running" ? "Stop" : "Start"}
                  </Button>
                  {e.status === "running" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOpenEnv(openEnv === e.identifier ? null : e.identifier)}
                    >
                      {openEnv === e.identifier ? "Close" : "Open"}
                    </Button>
                  )}
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {space && openEnv && <WorkspacePanel space={space} envId={openEnv} />}
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
            className="rounded-cn-2 border border-cn-2 bg-cn-2 p-cn-lg"
          >
            <div className="text-2xl font-semibold text-cn-1">
              {card.value ?? "—"}
              {card.suffix && <span className="text-sm text-cn-3"> {card.suffix}</span>}
            </div>
            <div className="text-sm text-cn-3">{card.label}</div>
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
  const [engine, setEngine] = useState("d1");
  const [openDb, setOpenDb] = useState<string | null>(null);

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

  return (
    <PageShell title="Databases">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput label="Identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="main-db" />
        <select
          className="rounded-cn-2 border border-cn-2 bg-cn-1 px-cn-md py-cn-sm text-cn-1"
          value={engine}
          onChange={(e) => setEngine(e.target.value)}
        >
          <option value="d1">d1 — provisioned on the platform</option>
          <option value="postgres">postgres — external</option>
          <option value="mysql">mysql — external</option>
          <option value="sqlite">sqlite — external</option>
        </select>
        <Button disabled={!identifier.trim() || create.isLoading} onClick={() => create.mutate()}>
          {engine === "d1" ? "Provision" : "Register"}
        </Button>
      </div>
      {create.isError && (
        <StatusBadge variant="status" theme="danger">{(create.error as Error)?.message ?? "create failed"}</StatusBadge>
      )}
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identifier</Table.Head>
            <Table.Head>Engine</Table.Head>
            <Table.Head>Status</Table.Head>
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
              <Table.Cell>
                <StatusBadge variant="status" theme={d.status === "provisioned" ? "success" : "muted"}>
                  {d.status}
                </StatusBadge>
              </Table.Cell>
              <Table.Cell>{d.migrations.length}</Table.Cell>
              <Table.Cell>
                <Button variant="ghost" size="sm" onClick={() => setOpenDb(openDb === d.id ? null : d.id)}>
                  {openDb === d.id ? "Close" : "Console"}
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No databases registered." />}
      {space && openDb && data?.find((d) => d.id === openDb) && (
        <DatabasePanel space={space} db={data.find((d) => d.id === openDb)!} />
      )}
    </PageShell>
  );
}

/** SQL console + migration apply for one database. Platform D1 records run
 * statements for real; external records only track the ledger. */
function DatabasePanel({ space, db }: { space: string; db: DbItem }) {
  const queryClient = useQueryClient();
  const [version, setVersion] = useState("");
  const [migrationSql, setMigrationSql] = useState("");
  const [consoleSql, setConsoleSql] = useState("");
  const [consoleResult, setConsoleResult] = useState<string | null>(null);
  const isD1 = db.engine === "d1" && db.status === "provisioned";

  const applyMigration = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/databases/${db.identifier}/migrations`, {
        method: "POST",
        body: JSON.stringify({ version, statements: migrationSql }),
      }),
    {
      onSuccess: () => {
        setVersion("");
        setMigrationSql("");
        queryClient.invalidateQueries(["databases", space]);
      },
    }
  );
  const runConsole = useMutation(async () => {
    const res = await deltaApi<{ result: unknown }>(
      `/api/v1/spaces/${space}/databases/${db.identifier}/console`,
      { method: "POST", body: JSON.stringify({ sql: consoleSql }) }
    );
    setConsoleResult(JSON.stringify(res.result, null, 2));
  });

  return (
    <div className="mt-cn-lg rounded-cn-3 border border-cn-2 bg-cn-2 p-cn-lg">
      <div className="mb-cn-md font-semibold text-cn-1">
        {db.identifier} — {isD1 ? "platform D1" : "external ledger"}
      </div>
      {isD1 && (
        <div className="mb-cn-lg">
          <div className="mb-cn-sm text-cn-2">Console</div>
          <textarea
            className="mb-cn-sm h-20 w-full rounded-cn-2 border border-cn-2 bg-cn-1 p-cn-sm font-mono text-cn-1"
            value={consoleSql}
            onChange={(e) => setConsoleSql(e.target.value)}
            placeholder="select * from sqlite_master"
          />
          <div className="flex items-center gap-cn-sm">
            <Button size="sm" disabled={!consoleSql.trim() || runConsole.isLoading} onClick={() => runConsole.mutate()}>
              Run
            </Button>
            {runConsole.isError && (
              <StatusBadge variant="status" theme="danger">{(runConsole.error as Error)?.message ?? "query failed"}</StatusBadge>
            )}
          </div>
          {consoleResult && (
            <pre className="mt-cn-sm max-h-64 overflow-auto rounded-cn-2 border border-cn-2 bg-cn-1 p-cn-sm text-cn-1">
              {consoleResult}
            </pre>
          )}
        </div>
      )}
      <div className="mb-cn-sm text-cn-2">Apply migration</div>
      <div className="flex items-end gap-cn-md">
        <TextInput label="Version" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="0001_init" />
        {isD1 && (
          <textarea
            className="h-16 flex-1 rounded-cn-2 border border-cn-2 bg-cn-1 p-cn-sm font-mono text-cn-1"
            value={migrationSql}
            onChange={(e) => setMigrationSql(e.target.value)}
            placeholder="create table ..."
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={!version.trim() || (isD1 && !migrationSql.trim()) || applyMigration.isLoading}
          onClick={() => applyMigration.mutate()}
        >
          Apply
        </Button>
      </div>
      {applyMigration.isError && (
        <StatusBadge variant="status" theme="danger">{(applyMigration.error as Error)?.message ?? "migration failed"}</StatusBadge>
      )}
      {db.migrations.length > 0 && (
        <div className="mt-cn-md text-cn-2">
          {db.migrations.map((m) => (
            <div key={m.version}>
              {m.version} — {new Date(m.appliedAt).toLocaleString()}
            </div>
          ))}
        </div>
      )}
    </div>
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
  const queryClient = useQueryClient();
  const [kind, setKind] = useState("secrets");
  const [repo, setRepo] = useState("");
  const { data } = useQuery(
    ["security-tests", space],
    () => deltaApi<SecurityTestItem[]>(`/api/v1/spaces/${space}/security-tests`),
    {
      enabled: !!space,
      // Queued/running scans update as the platform sandbox finishes.
      refetchInterval: (rows) =>
        Array.isArray(rows) && rows.some((t) => t.status === "queued" || t.status === "running")
          ? 5000
          : false,
    }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/security-tests`, {
        method: "POST",
        body: JSON.stringify({ kind, target: `${space}/${repo}`, repo }),
      }),
    { onSuccess: () => queryClient.invalidateQueries(["security-tests", space]) }
  );

  return (
    <PageShell title="Security tests">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <Text className="mb-cn-md text-cn-3">
        Repo targets run on the platform — pinned gitleaks / trivy / osv-scanner in a sandbox.
        External targets stay queued for delegates and the dgit CLI.
      </Text>
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <select
          className="rounded-cn-2 border border-cn-2 bg-cn-1 px-cn-md py-cn-sm text-cn-1"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="secrets">secrets — gitleaks</option>
          <option value="sast">sast — trivy fs</option>
          <option value="deps">deps — osv-scanner</option>
        </select>
        <TextInput
          label="Repository"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="repo-name"
        />
        <Button disabled={!repo.trim() || create.isLoading} onClick={() => create.mutate()}>
          Run scan
        </Button>
        {create.isError && (
          <StatusBadge variant="status" theme="danger">
            {(create.error as Error)?.message ?? "queue failed"}
          </StatusBadge>
        )}
      </div>
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
  const queryClient = useQueryClient();
  const [kind, setKind] = useState("sbom");
  const [repo, setRepo] = useState("");
  const { data } = useQuery(
    ["supply-chain", space],
    () => deltaApi<SupplyChainItem[]>(`/api/v1/spaces/${space}/supply-chain`),
    { enabled: !!space, refetchInterval: 8000 }
  );
  const generate = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/supply-chain`, {
        method: "POST",
        body: JSON.stringify({ kind, repo }),
      }),
    { onSuccess: () => queryClient.invalidateQueries(["supply-chain", space]) }
  );

  return (
    <PageShell title="Supply chain">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <Text className="mb-cn-md text-cn-3">
        SBOMs (syft), provenance statements and attestations — generated on the platform and
        DSSE-signed with the node key.
      </Text>
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <select
          className="rounded-cn-2 border border-cn-2 bg-cn-1 px-cn-md py-cn-sm text-cn-1"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="sbom">sbom — syft spdx-json</option>
          <option value="provenance">provenance — in-toto DSSE</option>
          <option value="attestation">attestation — in-toto DSSE</option>
        </select>
        <TextInput
          label="Repository"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="repo-name"
        />
        <Button disabled={!repo.trim() || generate.isLoading} onClick={() => generate.mutate()}>
          Generate
        </Button>
        {generate.isError && (
          <StatusBadge variant="status" theme="danger">
            {(generate.error as Error)?.message ?? "generate failed"}
          </StatusBadge>
        )}
      </div>
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
