import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button, SandboxLayout, StatusBadge, Table, Text, TextInput } from "@harnessio/ui/components";

import { deltaApi, SpacePicker, useSpacePicker } from "./module-pages";

/**
 * Wave-2 delivery-plane pages — connectors, delegates, file store, space
 * templates/variables, freeze windows, external tickets, gitops targets,
 * policies, and the IaC state browser. Every table is backed by the
 * `/api/v1/spaces/{space}/...` endpoints in `delivery.ts`.
 */

function PageShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
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

// --- connectors --------------------------------------------------------------

interface ConnectorItem {
  id: number;
  identifier: string;
  type: string;
  endpoint: string | null;
  description: string;
  has_secret: boolean;
  created: number;
}

export function ConnectorsPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [type, setType] = useState("github");

  const { data } = useQuery(
    ["connectors", space],
    () => deltaApi<ConnectorItem[]>(`/api/v1/spaces/${space}/connectors`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/connectors`, {
        method: "POST",
        body: JSON.stringify({ identifier, type }),
      }),
    {
      onSuccess: () => {
        setIdentifier("");
        queryClient.invalidateQueries(["connectors", space]);
      },
    }
  );
  const remove = useMutation(
    (id: string) => deltaApi(`/api/v1/spaces/${space}/connectors/${id}`, { method: "DELETE" }),
    { onSuccess: () => queryClient.invalidateQueries(["connectors", space]) }
  );

  return (
    <PageShell title="Connectors">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <Text className="mb-cn-md text-cn-foreground-3">
        Connector credentials stay in your custody — records here hold only sealed broker handles.
      </Text>
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput
          label="Identifier"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="gh-mirror"
        />
        <select
          className="rounded-cn-md border border-cn-borders-2 bg-cn-background-1 px-cn-md py-cn-sm text-cn-foreground-1"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="github">github</option>
          <option value="gitlab">gitlab</option>
          <option value="generic-http">generic-http</option>
          <option value="k8s">k8s</option>
        </select>
        <Button disabled={!identifier.trim() || create.isLoading} onClick={() => create.mutate()}>
          Create
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identifier</Table.Head>
            <Table.Head>Type</Table.Head>
            <Table.Head>Credential</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((row) => (
            <Table.Row key={row.identifier}>
              <Table.Cell>{row.identifier}</Table.Cell>
              <Table.Cell>
                <StatusBadge variant="outline">{row.type}</StatusBadge>
              </Table.Cell>
              <Table.Cell>
                {row.has_secret ? <StatusBadge variant="status" theme="success">sealed</StatusBadge> : "—"}
              </Table.Cell>
              <Table.Cell>
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(row.identifier)}>
                  Delete
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No connectors in this space." />}
    </PageShell>
  );
}

// --- delegates -----------------------------------------------------------------

interface DelegateItem {
  id: number;
  identifier: string;
  tags: string[];
  status: string;
  last_seen: number | null;
  created: number;
}

export function DelegatesPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [tags, setTags] = useState("");

  const { data } = useQuery(
    ["delegates", space],
    () => deltaApi<DelegateItem[]>(`/api/v1/spaces/${space}/delegates`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/delegates`, {
        method: "POST",
        body: JSON.stringify({
          identifier,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      }),
    {
      onSuccess: () => {
        setIdentifier("");
        setTags("");
        queryClient.invalidateQueries(["delegates", space]);
      },
    }
  );

  return (
    <PageShell title="Delegates">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <Text className="mb-cn-md text-cn-foreground-3">
        Pipeline runners on your own infrastructure. Runners claim work over the signed agent
        protocol (`dg/runner/*`).
      </Text>
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput
          label="Identifier"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="runner-1"
        />
        <TextInput
          label="Tags (comma-separated)"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="linux,x64"
        />
        <Button disabled={!identifier.trim() || create.isLoading} onClick={() => create.mutate()}>
          Register
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identifier</Table.Head>
            <Table.Head>Tags</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Last seen</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((row) => (
            <Table.Row key={row.identifier}>
              <Table.Cell>{row.identifier}</Table.Cell>
              <Table.Cell>{row.tags.join(", ") || "—"}</Table.Cell>
              <Table.Cell>
                <StatusBadge variant="status" theme={row.status === "online" ? "success" : "muted"}>
                  {row.status}
                </StatusBadge>
              </Table.Cell>
              <Table.Cell>
                {row.last_seen ? new Date(row.last_seen).toLocaleString() : "never"}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No delegates registered." />}
    </PageShell>
  );
}

// --- file store -----------------------------------------------------------------

interface FileItem {
  name: string;
  size: number;
  content_type: string | null;
  created_by: string;
  created: number;
}

export function FileStorePage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  const { data } = useQuery(
    ["filestore", space],
    () => deltaApi<FileItem[]>(`/api/v1/spaces/${space}/files`),
    { enabled: !!space }
  );
  const remove = useMutation(
    (fileName: string) =>
      deltaApi(`/api/v1/spaces/${space}/files/${encodeURIComponent(fileName)}`, {
        method: "DELETE",
      }),
    { onSuccess: () => queryClient.invalidateQueries(["filestore", space]) }
  );

  return (
    <PageShell title="File store">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <Text className="mb-cn-md text-cn-foreground-3">
        Arbitrary blobs for this space — PUT /api/v1/spaces/{space ?? "{space}"}/files/{"{name}"}{" "}
        to upload.
      </Text>
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput
          label="Jump to file"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="path/to/blob"
        />
        <Button
          variant="secondary"
          disabled={!name.trim()}
          onClick={() => {
            window.open(`/api/v1/spaces/${space}/files/${encodeURIComponent(name.trim())}`);
          }}
        >
          Open
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Name</Table.Head>
            <Table.Head>Size</Table.Head>
            <Table.Head>Uploaded</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((f) => (
            <Table.Row key={f.name}>
              <Table.Cell>
                <a className="hover:underline" href={`/api/v1/spaces/${space}/files/${f.name}`}>
                  {f.name}
                </a>
              </Table.Cell>
              <Table.Cell>{(f.size / 1024).toFixed(1)} KiB</Table.Cell>
              <Table.Cell>{new Date(f.created).toLocaleString()}</Table.Cell>
              <Table.Cell>
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(f.name)}>
                  Delete
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No files stored in this space." />}
    </PageShell>
  );
}

// --- space templates --------------------------------------------------------------

interface TemplateItem {
  id: number;
  identifier: string;
  data: string;
  created: number;
}

export function SpaceTemplatesPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [templateData, setTemplateData] = useState("");

  const { data } = useQuery(
    ["space-templates", space],
    () => deltaApi<TemplateItem[]>(`/api/v1/spaces/${space}/templates`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/templates`, {
        method: "POST",
        body: JSON.stringify({ identifier, data: templateData }),
      }),
    {
      onSuccess: () => {
        setIdentifier("");
        setTemplateData("");
        queryClient.invalidateQueries(["space-templates", space]);
      },
    }
  );
  const remove = useMutation(
    (id: number) => deltaApi(`/api/v1/spaces/${space}/templates/${id}`, { method: "DELETE" }),
    { onSuccess: () => queryClient.invalidateQueries(["space-templates", space]) }
  );

  return (
    <PageShell title="Templates">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput
          label="Identifier"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="ci-node"
        />
        <TextInput
          label="Template body"
          value={templateData}
          onChange={(e) => setTemplateData(e.target.value)}
          placeholder="pipeline yaml…"
        />
        <Button disabled={!identifier.trim() || create.isLoading} onClick={() => create.mutate()}>
          Create
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identifier</Table.Head>
            <Table.Head>Preview</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((t) => (
            <Table.Row key={t.id}>
              <Table.Cell>{t.identifier}</Table.Cell>
              <Table.Cell>
                <code className="text-xs">{t.data.slice(0, 80)}</code>
              </Table.Cell>
              <Table.Cell>
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(t.id)}>
                  Delete
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No space templates yet." />}
    </PageShell>
  );
}

// --- space variables ---------------------------------------------------------------

interface VariableItem {
  identifier: string;
  description: string;
  created: number;
  updated: number;
}

export function VariablesPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [value, setValue] = useState("");

  const { data } = useQuery(
    ["variables", space],
    () => deltaApi<VariableItem[]>(`/api/v1/spaces/${space}/variables`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/variables`, {
        method: "POST",
        body: JSON.stringify({ identifier, ciphertext: value }),
      }),
    {
      onSuccess: () => {
        setIdentifier("");
        setValue("");
        queryClient.invalidateQueries(["variables", space]);
      },
    }
  );
  const remove = useMutation(
    (name: string) =>
      deltaApi(`/api/v1/spaces/${space}/variables/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
    { onSuccess: () => queryClient.invalidateQueries(["variables", space]) }
  );

  return (
    <PageShell title="Variables">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput
          label="Name"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value.toUpperCase())}
          placeholder="DEPLOY_TARGET"
        />
        <TextInput
          label="Value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          type="password"
        />
        <Button disabled={!identifier.trim() || create.isLoading} onClick={() => create.mutate()}>
          Add
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Name</Table.Head>
            <Table.Head>Updated</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((v) => (
            <Table.Row key={v.identifier}>
              <Table.Cell>
                <code>{v.identifier}</code>
              </Table.Cell>
              <Table.Cell>{new Date(v.updated).toLocaleString()}</Table.Cell>
              <Table.Cell>
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(v.identifier)}>
                  Delete
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No variables in this space." />}
    </PageShell>
  );
}

// --- freeze windows ------------------------------------------------------------------

interface FreezeWindowItem {
  id: number;
  identifier: string;
  schedule: string;
  applies_to: string;
  enabled: boolean;
  active: boolean;
  created: number;
}

export function FreezeWindowsPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [schedule, setSchedule] = useState("sa,su");
  const [appliesTo, setAppliesTo] = useState("all");

  const { data } = useQuery(
    ["freeze", space],
    () => deltaApi<FreezeWindowItem[]>(`/api/v1/spaces/${space}/freezewindows`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/freezewindows`, {
        method: "POST",
        body: JSON.stringify({ identifier, schedule, applies_to: appliesTo }),
      }),
    {
      onSuccess: () => {
        setIdentifier("");
        queryClient.invalidateQueries(["freeze", space]);
      },
    }
  );

  return (
    <PageShell title="Freeze windows">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <Text className="mb-cn-md text-cn-foreground-3">
        Schedule format: day letters + optional UTC hour range — e.g. <code>sa,su</code>,{" "}
        <code>mo-fr 17-09</code>. Active windows gate pushes and merges.
      </Text>
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput
          label="Identifier"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="weekend-freeze"
        />
        <TextInput
          label="Schedule"
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
        />
        <select
          className="rounded-cn-md border border-cn-borders-2 bg-cn-background-1 px-cn-md py-cn-sm text-cn-foreground-1"
          value={appliesTo}
          onChange={(e) => setAppliesTo(e.target.value)}
        >
          <option value="all">all</option>
          <option value="push">push</option>
          <option value="merge">merge</option>
          <option value="deploy">deploy</option>
        </select>
        <Button disabled={!identifier.trim() || create.isLoading} onClick={() => create.mutate()}>
          Create
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identifier</Table.Head>
            <Table.Head>Schedule</Table.Head>
            <Table.Head>Applies to</Table.Head>
            <Table.Head>State</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((w) => (
            <Table.Row key={w.identifier}>
              <Table.Cell>{w.identifier}</Table.Cell>
              <Table.Cell>
                <code>{w.schedule}</code>
              </Table.Cell>
              <Table.Cell>{w.applies_to}</Table.Cell>
              <Table.Cell>
                <StatusBadge variant="status" theme={w.active ? "danger" : w.enabled ? "muted" : "muted"}>
                  {w.active ? "active" : w.enabled ? "scheduled" : "disabled"}
                </StatusBadge>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No freeze windows." />}
    </PageShell>
  );
}

// --- external tickets ------------------------------------------------------------------

interface TicketItem {
  id: string;
  external_id: string;
  title: string;
  url: string | null;
  status: string;
  created: number;
}

export function ExternalTicketsPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [externalId, setExternalId] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");

  const { data } = useQuery(
    ["tickets", space],
    () => deltaApi<TicketItem[]>(`/api/v1/spaces/${space}/tickets`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/tickets`, {
        method: "POST",
        body: JSON.stringify({ external_id: externalId, title, url: url || undefined }),
      }),
    {
      onSuccess: () => {
        setExternalId("");
        setTitle("");
        setUrl("");
        queryClient.invalidateQueries(["tickets", space]);
      },
    }
  );

  return (
    <PageShell title="External tickets">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput
          label="Ticket ID"
          value={externalId}
          onChange={(e) => setExternalId(e.target.value)}
          placeholder="JIRA-42"
        />
        <TextInput
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <TextInput
          label="URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
        />
        <Button
          disabled={!externalId.trim() || !title.trim() || create.isLoading}
          onClick={() => create.mutate()}
        >
          Link
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Ticket</Table.Head>
            <Table.Head>Title</Table.Head>
            <Table.Head>Status</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((t) => (
            <Table.Row key={t.id}>
              <Table.Cell>
                {t.url ? (
                  <a className="hover:underline" href={t.url} target="_blank" rel="noreferrer">
                    {t.external_id}
                  </a>
                ) : (
                  t.external_id
                )}
              </Table.Cell>
              <Table.Cell>{t.title}</Table.Cell>
              <Table.Cell>
                <StatusBadge variant="outline">{t.status}</StatusBadge>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No linked tickets." />}
    </PageShell>
  );
}

// --- gitops targets ----------------------------------------------------------------------

interface GitopsItem {
  id: string;
  identifier: string;
  repository_id: string;
  branch: string;
  target_environment: string;
  enabled: boolean;
  last_sync: number | null;
}

export function GitOpsPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const { data } = useQuery(
    ["gitops", space],
    () => deltaApi<GitopsItem[]>(`/api/v1/spaces/${space}/gitops`),
    { enabled: !!space }
  );

  return (
    <PageShell title="GitOps">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <Text className="mb-cn-md text-cn-foreground-3">
        Declarative sync targets — a repo+branch reconciled into an environment.
      </Text>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identifier</Table.Head>
            <Table.Head>Branch</Table.Head>
            <Table.Head>Environment</Table.Head>
            <Table.Head>Last sync</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((g) => (
            <Table.Row key={g.id}>
              <Table.Cell>{g.identifier}</Table.Cell>
              <Table.Cell>
                <code>{g.branch}</code>
              </Table.Cell>
              <Table.Cell>
                <StatusBadge variant="outline">{g.target_environment}</StatusBadge>
              </Table.Cell>
              <Table.Cell>
                {g.last_sync ? new Date(g.last_sync).toLocaleString() : "pending"}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No GitOps targets." />}
    </PageShell>
  );
}

// --- policies ------------------------------------------------------------------------------

interface PolicyItem {
  id: string;
  identifier: string;
  document: { when: { field: string; op: string; value: string }; action: string; message?: string }[];
  applies_to: string;
  enforcement: string;
  enabled: boolean;
}

export function PoliciesPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [branch, setBranch] = useState("main");
  const [appliesTo, setAppliesTo] = useState("push");

  const { data } = useQuery(
    ["policies", space],
    () => deltaApi<PolicyItem[]>(`/api/v1/spaces/${space}/policies`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/policies`, {
        method: "POST",
        body: JSON.stringify({
          identifier,
          applies_to: appliesTo,
          enforcement: "enforce",
          document: [
            {
              when: { field: "branch", op: "eq", value: branch },
              action: "deny",
              message: `policy "${identifier}" denies ${appliesTo} on ${branch}`,
            },
          ],
        }),
      }),
    {
      onSuccess: () => {
        setIdentifier("");
        queryClient.invalidateQueries(["policies", space]);
      },
    }
  );

  return (
    <PageShell title="Policies">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <Text className="mb-cn-md text-cn-foreground-3">
        JSON rule documents evaluated on push and merge. Quick-create below adds a
        branch-protection deny rule.
      </Text>
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput
          label="Identifier"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="protect-main"
        />
        <TextInput
          label="Protected branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
        <select
          className="rounded-cn-md border border-cn-borders-2 bg-cn-background-1 px-cn-md py-cn-sm text-cn-foreground-1"
          value={appliesTo}
          onChange={(e) => setAppliesTo(e.target.value)}
        >
          <option value="push">push</option>
          <option value="merge">merge</option>
          <option value="all">all</option>
        </select>
        <Button disabled={!identifier.trim() || create.isLoading} onClick={() => create.mutate()}>
          Create
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identifier</Table.Head>
            <Table.Head>Applies to</Table.Head>
            <Table.Head>Enforcement</Table.Head>
            <Table.Head>Rules</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((p) => (
            <Table.Row key={p.id}>
              <Table.Cell>{p.identifier}</Table.Cell>
              <Table.Cell>{p.applies_to}</Table.Cell>
              <Table.Cell>
                <StatusBadge variant="status" theme={p.enforcement === "enforce" ? "danger" : "muted"}>
                  {p.enforcement}
                </StatusBadge>
              </Table.Cell>
              <Table.Cell>{p.document.length}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No policies." />}
    </PageShell>
  );
}

// --- IaC state browser ----------------------------------------------------------------------

interface IacInfo {
  name: string;
  version: number;
  locked: boolean;
}

export function IaCPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const [name, setName] = useState("");
  const [state, setState] = useState<IacInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inspect = async () => {
    setError(null);
    setState(null);
    const res = await fetch(`/api/v1/spaces/${space}/iac/${encodeURIComponent(name.trim())}/state`, {
      credentials: "same-origin",
    });
    if (!res.ok) {
      setError(res.status === 404 ? "no state stored under that name" : `error ${res.status}`);
      return;
    }
    setState({
      name: name.trim(),
      version: parseInt(res.headers.get("x-iac-version") ?? "0", 10),
      locked: false,
    });
  };

  return (
    <PageShell title="Infrastructure as Code">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <Text className="mb-cn-md text-cn-foreground-3">
        Terraform-compatible HTTP state backend. Point your backend config at{" "}
        <code>/api/v1/spaces/{space ?? "{space}"}/iac/{"{name}"}/state</code> — supports
        lock/unlock semantics.
      </Text>
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput
          label="State name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="prod"
        />
        <Button variant="secondary" disabled={!name.trim()} onClick={() => void inspect()}>
          Inspect
        </Button>
      </div>
      {error && <Text className="text-cn-foreground-danger">{error}</Text>}
      {state && (
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Name</Table.Head>
              <Table.Head>Version</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            <Table.Row>
              <Table.Cell>
                <code>{state.name}</code>
              </Table.Cell>
              <Table.Cell>{state.version}</Table.Cell>
            </Table.Row>
          </Table.Body>
        </Table.Root>
      )}
    </PageShell>
  );
}
