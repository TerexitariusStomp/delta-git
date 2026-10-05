import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import {
  Button,
  SandboxLayout,
  StatusBadge,
  Table,
  Text,
  TextInput,
} from "@harnessio/ui/components";

/**
 * Wave-1g module surfaces — the notifications inbox, space environments, and
 * the space-level artifact browser. All backed by real D1/R2 endpoints.
 */

export async function deltaApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  const body = (await res.json().catch(() => null)) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(body?.error ?? body?.message ?? `request failed: ${res.status}`);
  return body;
}

interface Membership {
  space: { identifier: string; path: string };
}

const useSpaces = () =>
  useQuery(["modules", "spaces"], () => deltaApi<Membership[]>("/api/v1/user/memberships"), {
    select: (rows) => rows.map((r) => r.space.identifier),
  });

export function useSpacePicker() {
  const { data: spaces } = useSpaces();
  const [space, setSpace] = useState<string | null>(null);
  const active = space ?? spaces?.[0] ?? null;
  return { spaces: spaces ?? [], space: active, setSpace };
}

export function SpacePicker({
  spaces,
  space,
  setSpace,
}: {
  spaces: string[];
  space: string | null;
  setSpace: (s: string) => void;
}) {
  return (
    <div className="mb-cn-lg flex items-center gap-cn-md">
      <Text variant="heading-subsection">Space</Text>
      <select
        className="rounded-cn-md border border-cn-borders-2 bg-cn-background-1 px-cn-md py-cn-sm text-cn-foreground-1"
        value={space ?? ""}
        onChange={(e) => setSpace(e.target.value)}
      >
        {spaces.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </div>
  );
}

// --- notifications ---------------------------------------------------------

interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  created: number;
  read: boolean;
}

export function NotificationsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useQuery(["notifications"], () =>
    deltaApi<{ notifications: NotificationItem[]; unread: number }>("/api/v1/notifications")
  );
  const mark = useMutation(
    (vars: { id: string; read: boolean }) =>
      deltaApi(`/api/v1/notifications/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({ read: vars.read }),
      }),
    { onSuccess: () => queryClient.invalidateQueries(["notifications"]) }
  );
  const markAll = useMutation(
    () => deltaApi("/api/v1/notifications/read-all", { method: "PATCH", body: "{}" }),
    { onSuccess: () => queryClient.invalidateQueries(["notifications"]) }
  );

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content className="px-cn-lg py-cn-xl">
        <div className="mb-cn-lg flex items-center justify-between">
          <Text variant="heading-section">Notifications</Text>
          <Button variant="secondary" onClick={() => markAll.mutate()}>
            Mark all read ({data?.unread ?? 0})
          </Button>
        </div>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Event</Table.Head>
              <Table.Head>Title</Table.Head>
              <Table.Head>When</Table.Head>
              <Table.Head></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {(data?.notifications ?? []).map((n) => (
              <Table.Row key={n.id} className={n.read ? "opacity-60" : ""}>
                <Table.Cell>
                  <StatusBadge variant="outline" theme={n.read ? "muted" : "info"}>
                    {n.kind}
                  </StatusBadge>
                </Table.Cell>
                <Table.Cell>
                  <button
                    className="text-left hover:underline"
                    onClick={() => {
                      if (!n.read) mark.mutate({ id: n.id, read: true });
                      if (n.link) navigate(n.link);
                    }}
                  >
                    {n.title}
                    {n.body && <div className="text-cn-foreground-3 text-sm">{n.body}</div>}
                  </button>
                </Table.Cell>
                <Table.Cell>{new Date(n.created).toLocaleString()}</Table.Cell>
                <Table.Cell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => mark.mutate({ id: n.id, read: !n.read })}
                  >
                    {n.read ? "Unread" : "Read"}
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
        {(data?.notifications ?? []).length === 0 && (
          <Text className="mt-cn-md text-cn-foreground-3">No notifications yet.</Text>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  );
}

// --- environments -----------------------------------------------------------

interface EnvironmentItem {
  id: number;
  identifier: string;
  description: string;
  type: string;
  created: number;
}

export function EnvironmentsPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [type, setType] = useState("pre_production");

  const { data: envs } = useQuery(
    ["environments", space],
    () => deltaApi<EnvironmentItem[]>(`/api/v1/spaces/${space}/environments`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/environments`, {
        method: "POST",
        body: JSON.stringify({ identifier, type }),
      }),
    {
      onSuccess: () => {
        setIdentifier("");
        queryClient.invalidateQueries(["environments", space]);
      },
    }
  );
  const remove = useMutation(
    (id: string) => deltaApi(`/api/v1/spaces/${space}/environments/${id}`, { method: "DELETE" }),
    { onSuccess: () => queryClient.invalidateQueries(["environments", space]) }
  );

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content className="px-cn-lg py-cn-xl">
        <Text variant="heading-section" className="mb-cn-md">
          Environments
        </Text>
        <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
        <div className="mb-cn-lg flex items-end gap-cn-md">
          <TextInput
            label="Identifier"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="production"
          />
          <select
            className="rounded-cn-md border border-cn-borders-2 bg-cn-background-1 px-cn-md py-cn-sm text-cn-foreground-1"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="dev">dev</option>
            <option value="pre_production">staging</option>
            <option value="production">prod</option>
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
              <Table.Head>Created</Table.Head>
              <Table.Head></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {(envs ?? []).map((env) => (
              <Table.Row key={env.identifier}>
                <Table.Cell>{env.identifier}</Table.Cell>
                <Table.Cell>
                  <StatusBadge variant="outline">{env.type}</StatusBadge>
                </Table.Cell>
                <Table.Cell>{new Date(env.created).toLocaleDateString()}</Table.Cell>
                <Table.Cell>
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(env.identifier)}>
                    Delete
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
        {(envs ?? []).length === 0 && (
          <Text className="mt-cn-md text-cn-foreground-3">No environments in this space.</Text>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  );
}

// --- artifacts ----------------------------------------------------------------

interface ArtifactItem {
  name: string;
  version: string;
  path: string;
  repo: string;
  size: number;
  sha256: string;
  content_type: string | null;
  created_by: string;
  created: number;
}

export function ArtifactsPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const { data: artifacts } = useQuery(
    ["artifacts", space],
    () => deltaApi<ArtifactItem[]>(`/api/v1/spaces/${space}/artifacts`),
    { enabled: !!space }
  );

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content className="px-cn-lg py-cn-xl">
        <Text variant="heading-section" className="mb-cn-md">
          Artifacts
        </Text>
        <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
        <Text className="mb-cn-md text-cn-foreground-3">
          Pipeline outputs and published packages. Upload with a push PAT: PUT /api/
          {"{owner}/{repo}"}/dg/artifacts/{"{name}/{version}/{path}"}
        </Text>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Name</Table.Head>
              <Table.Head>Version</Table.Head>
              <Table.Head>Repo</Table.Head>
              <Table.Head>Size</Table.Head>
              <Table.Head>Published</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {(artifacts ?? []).map((a) => (
              <Table.Row key={`${a.repo}/${a.name}/${a.version}/${a.path}`}>
                <Table.Cell>
                  <a
                    className="hover:underline"
                    href={`/api/${space}/${a.repo}/dg/artifacts/${a.name}/${a.version}/${a.path}`}
                  >
                    {a.name}/{a.path}
                  </a>
                </Table.Cell>
                <Table.Cell>{a.version}</Table.Cell>
                <Table.Cell>{a.repo}</Table.Cell>
                <Table.Cell>{(a.size / 1024).toFixed(1)} KiB</Table.Cell>
                <Table.Cell>{new Date(a.created).toLocaleString()}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
        {(artifacts ?? []).length === 0 && (
          <Text className="mt-cn-md text-cn-foreground-3">No artifacts published yet.</Text>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  );
}
