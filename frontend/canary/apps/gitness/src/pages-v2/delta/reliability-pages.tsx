import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button, SandboxLayout, StatusBadge, Table, Text, TextInput } from "@harnessio/ui/components";

import { deltaApi, SpacePicker, useSpacePicker } from "./module-pages";

/**
 * Wave-3 reliability pages — monitors, SLO/downtime, incidents, certificates,
 * cloud costs, chaos experiments, and the service-reliability overview.
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

// --- monitors -------------------------------------------------------------------

interface MonitorItem {
  id: string;
  identifier: string;
  url: string;
  expected_status: number;
  enabled: boolean;
  last_status: string | null;
  last_latency_ms: number | null;
  last_checked: number | null;
}

export function MonitorsPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [url, setUrl] = useState("");

  const { data } = useQuery(
    ["monitors", space],
    () => deltaApi<MonitorItem[]>(`/api/v1/spaces/${space}/monitors`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/monitors`, {
        method: "POST",
        body: JSON.stringify({ identifier, url }),
      }),
    {
      onSuccess: () => {
        setIdentifier("");
        setUrl("");
        queryClient.invalidateQueries(["monitors", space]);
      },
    }
  );
  const run = useMutation(
    (id: string) =>
      deltaApi(`/api/v1/spaces/${space}/monitors/${id}/run`, { method: "POST", body: "{}" }),
    { onSuccess: () => queryClient.invalidateQueries(["monitors", space]) }
  );
  const remove = useMutation(
    (id: string) => deltaApi(`/api/v1/spaces/${space}/monitors/${id}`, { method: "DELETE" }),
    { onSuccess: () => queryClient.invalidateQueries(["monitors", space]) }
  );

  return (
    <PageShell title="Monitors">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput
          label="Identifier"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="edge"
        />
        <TextInput
          label="URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/health"
        />
        <Button disabled={!identifier.trim() || !url.trim() || create.isLoading} onClick={() => create.mutate()}>
          Create
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identifier</Table.Head>
            <Table.Head>URL</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Latency</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((m) => (
            <Table.Row key={m.id}>
              <Table.Cell>{m.identifier}</Table.Cell>
              <Table.Cell>
                <code className="text-xs">{m.url}</code>
              </Table.Cell>
              <Table.Cell>
                <StatusBadge
                  variant="status"
                  theme={m.last_status === "up" ? "success" : m.last_status === "down" ? "danger" : "muted"}
                >
                  {m.last_status ?? "unknown"}
                </StatusBadge>
              </Table.Cell>
              <Table.Cell>{m.last_latency_ms != null ? `${m.last_latency_ms}ms` : "—"}</Table.Cell>
              <Table.Cell>
                <div className="flex gap-cn-sm">
                  <Button variant="ghost" size="sm" onClick={() => run.mutate(m.identifier)}>
                    Run
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(m.identifier)}>
                    Delete
                  </Button>
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No monitors." />}
    </PageShell>
  );
}

// --- SLO + downtime ---------------------------------------------------------------

interface SloItem {
  id: string;
  identifier: string;
  target_pct: number;
  window_days: number;
  observed_pct: number | null;
}

interface DowntimeItem {
  id: string;
  reason: string;
  started: number;
  ended: number | null;
  ongoing: boolean;
}

export function SloDowntimePage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [monitor, setMonitor] = useState("");
  const [target, setTarget] = useState("99.9");
  const [reason, setReason] = useState("");

  const { data: slos } = useQuery(
    ["slos", space],
    () => deltaApi<SloItem[]>(`/api/v1/spaces/${space}/slos`),
    { enabled: !!space }
  );
  const { data: downtimes } = useQuery(
    ["downtimes", space],
    () => deltaApi<DowntimeItem[]>(`/api/v1/spaces/${space}/downtimes`),
    { enabled: !!space }
  );
  const createSlo = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/slos`, {
        method: "POST",
        body: JSON.stringify({
          identifier,
          monitor: monitor || undefined,
          target_pct: parseFloat(target),
        }),
      }),
    {
      onSuccess: () => {
        setIdentifier("");
        queryClient.invalidateQueries(["slos", space]);
      },
    }
  );
  const createDowntime = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/downtimes`, {
        method: "POST",
        body: JSON.stringify({ monitor: monitor || undefined, reason }),
      }),
    {
      onSuccess: () => {
        setReason("");
        queryClient.invalidateQueries(["downtimes", space]);
      },
    }
  );
  const endDowntime = useMutation(
    (id: string) =>
      deltaApi(`/api/v1/spaces/${space}/downtimes/${id}/end`, { method: "POST", body: "{}" }),
    { onSuccess: () => queryClient.invalidateQueries(["downtimes", space]) }
  );

  return (
    <PageShell title="SLOs & downtime">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <Text variant="heading-subsection" className="mb-cn-sm">
        SLOs
      </Text>
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput label="Identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="edge-slo" />
        <TextInput label="Monitor" value={monitor} onChange={(e) => setMonitor(e.target.value)} placeholder="edge" />
        <TextInput label="Target %" value={target} onChange={(e) => setTarget(e.target.value)} />
        <Button disabled={!identifier.trim() || createSlo.isLoading} onClick={() => createSlo.mutate()}>
          Create
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identifier</Table.Head>
            <Table.Head>Target</Table.Head>
            <Table.Head>Observed</Table.Head>
            <Table.Head>Window</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(slos ?? []).map((s) => (
            <Table.Row key={s.id}>
              <Table.Cell>{s.identifier}</Table.Cell>
              <Table.Cell>{s.target_pct}%</Table.Cell>
              <Table.Cell>
                <StatusBadge
                  variant="status"
                  theme={
                    s.observed_pct === null ? "muted" : s.observed_pct >= s.target_pct ? "success" : "danger"
                  }
                >
                  {s.observed_pct === null ? "no data" : `${s.observed_pct.toFixed(2)}%`}
                </StatusBadge>
              </Table.Cell>
              <Table.Cell>{s.window_days}d</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(slos ?? []).length === 0 && <EmptyNote text="No SLOs defined." />}

      <Text variant="heading-subsection" className="mb-cn-sm mt-cn-xl">
        Downtime windows
      </Text>
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput label="Monitor" value={monitor} onChange={(e) => setMonitor(e.target.value)} placeholder="edge (optional)" />
        <TextInput label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="deploy" />
        <Button disabled={!reason.trim() || createDowntime.isLoading} onClick={() => createDowntime.mutate()}>
          Record
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Reason</Table.Head>
            <Table.Head>Started</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(downtimes ?? []).map((d) => (
            <Table.Row key={d.id}>
              <Table.Cell>{d.reason}</Table.Cell>
              <Table.Cell>{new Date(d.started).toLocaleString()}</Table.Cell>
              <Table.Cell>
                <StatusBadge variant="status" theme={d.ongoing ? "warning" : "muted"}>
                  {d.ongoing ? "ongoing" : "ended"}
                </StatusBadge>
              </Table.Cell>
              <Table.Cell>
                {d.ongoing && (
                  <Button variant="ghost" size="sm" onClick={() => endDowntime.mutate(d.id)}>
                    End
                  </Button>
                )}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(downtimes ?? []).length === 0 && <EmptyNote text="No downtime windows." />}
    </PageShell>
  );
}

// --- incidents ------------------------------------------------------------------------

interface IncidentItem {
  id: string;
  title: string;
  severity: string;
  status: string;
  created: number;
  resolved: number | null;
}

export function IncidentsPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState("sev3");

  const { data } = useQuery(
    ["incidents", space],
    () => deltaApi<IncidentItem[]>(`/api/v1/spaces/${space}/incidents`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/incidents`, {
        method: "POST",
        body: JSON.stringify({ title, severity }),
      }),
    {
      onSuccess: () => {
        setTitle("");
        queryClient.invalidateQueries(["incidents", space]);
      },
    }
  );
  const resolve = useMutation(
    (id: string) =>
      deltaApi(`/api/v1/spaces/${space}/incidents/${id}/updates`, {
        method: "POST",
        body: JSON.stringify({ body: "resolved", status: "resolved" }),
      }),
    { onSuccess: () => queryClient.invalidateQueries(["incidents", space]) }
  );

  return (
    <PageShell title="Incidents">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="edge 5xx spike" />
        <select
          className="rounded-cn-md border border-cn-borders-2 bg-cn-background-1 px-cn-md py-cn-sm text-cn-foreground-1"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
        >
          <option value="sev1">sev1</option>
          <option value="sev2">sev2</option>
          <option value="sev3">sev3</option>
          <option value="sev4">sev4</option>
        </select>
        <Button disabled={!title.trim() || create.isLoading} onClick={() => create.mutate()}>
          Declare
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Title</Table.Head>
            <Table.Head>Severity</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Opened</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((i) => (
            <Table.Row key={i.id}>
              <Table.Cell>{i.title}</Table.Cell>
              <Table.Cell>
                <StatusBadge variant="status" theme={i.severity === "sev1" || i.severity === "sev2" ? "danger" : "warning"}>
                  {i.severity}
                </StatusBadge>
              </Table.Cell>
              <Table.Cell>
                <StatusBadge variant="outline">{i.status}</StatusBadge>
              </Table.Cell>
              <Table.Cell>{new Date(i.created).toLocaleString()}</Table.Cell>
              <Table.Cell>
                {i.status !== "resolved" && (
                  <Button variant="ghost" size="sm" onClick={() => resolve.mutate(i.id)}>
                    Resolve
                  </Button>
                )}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No incidents." />}
    </PageShell>
  );
}

// --- certificates ------------------------------------------------------------------------

interface CertItem {
  id: string;
  domain: string;
  issuer: string | null;
  expires_at: number;
  days_left: number;
  auto_renew: boolean;
}

export function CertificatesPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("");
  const [days, setDays] = useState("90");

  const { data } = useQuery(
    ["certs", space],
    () => deltaApi<CertItem[]>(`/api/v1/spaces/${space}/certificates`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/certificates`, {
        method: "POST",
        body: JSON.stringify({
          domain,
          expires_at: Date.now() + parseInt(days, 10) * 86400_000,
        }),
      }),
    {
      onSuccess: () => {
        setDomain("");
        queryClient.invalidateQueries(["certs", space]);
      },
    }
  );

  return (
    <PageShell title="Certificates">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput label="Domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" />
        <TextInput label="Expires in (days)" value={days} onChange={(e) => setDays(e.target.value)} />
        <Button disabled={!domain.trim() || create.isLoading} onClick={() => create.mutate()}>
          Track
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Domain</Table.Head>
            <Table.Head>Issuer</Table.Head>
            <Table.Head>Days left</Table.Head>
            <Table.Head>Expiry</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((cert) => (
            <Table.Row key={cert.id}>
              <Table.Cell>
                <code>{cert.domain}</code>
              </Table.Cell>
              <Table.Cell>{cert.issuer ?? "—"}</Table.Cell>
              <Table.Cell>
                <StatusBadge
                  variant="status"
                  theme={cert.days_left < 7 ? "danger" : cert.days_left < 30 ? "warning" : "success"}
                >
                  {cert.days_left}d
                </StatusBadge>
              </Table.Cell>
              <Table.Cell>{new Date(cert.expires_at).toLocaleDateString()}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No certificates tracked." />}
    </PageShell>
  );
}

// --- cloud costs ------------------------------------------------------------------------------

interface CostsResponse {
  snapshots: { provider: string; service: string; amount_cents: number; period_start: number }[];
  totals_by_service: { service: string; amount_cents: number }[];
}

export function CloudCostsPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [service, setService] = useState("");
  const [amount, setAmount] = useState("");

  const { data } = useQuery(
    ["costs", space],
    () => deltaApi<CostsResponse>(`/api/v1/spaces/${space}/costs`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/costs`, {
        method: "POST",
        body: JSON.stringify({ service, amount_cents: Math.round(parseFloat(amount) * 100) }),
      }),
    {
      onSuccess: () => {
        setService("");
        setAmount("");
        queryClient.invalidateQueries(["costs", space]);
      },
    }
  );

  return (
    <PageShell title="Cloud costs">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput label="Service" value={service} onChange={(e) => setService(e.target.value)} placeholder="workers" />
        <TextInput label="Amount (USD)" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="12.34" />
        <Button disabled={!service.trim() || !amount.trim() || create.isLoading} onClick={() => create.mutate()}>
          Record
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Service</Table.Head>
            <Table.Head>Total</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data?.totals_by_service ?? []).map((t) => (
            <Table.Row key={t.service}>
              <Table.Cell>{t.service}</Table.Cell>
              <Table.Cell>${(t.amount_cents / 100).toFixed(2)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data?.totals_by_service ?? []).length === 0 && <EmptyNote text="No cost data." />}
    </PageShell>
  );
}

// --- chaos experiments -----------------------------------------------------------------------------

interface ChaosItem {
  id: string;
  identifier: string;
  kind: string;
  last_run: number | null;
  last_outcome: string | null;
}

export function ChaosPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [kind, setKind] = useState("latency");

  const { data } = useQuery(
    ["chaos", space],
    () => deltaApi<ChaosItem[]>(`/api/v1/spaces/${space}/chaos`),
    { enabled: !!space }
  );
  const create = useMutation(
    () =>
      deltaApi(`/api/v1/spaces/${space}/chaos`, {
        method: "POST",
        body: JSON.stringify({ identifier, kind }),
      }),
    {
      onSuccess: () => {
        setIdentifier("");
        queryClient.invalidateQueries(["chaos", space]);
      },
    }
  );
  const recordRun = useMutation(
    (vars: { id: string; outcome: string }) =>
      deltaApi(`/api/v1/spaces/${space}/chaos/${vars.id}/runs`, {
        method: "POST",
        body: JSON.stringify({ outcome: vars.outcome }),
      }),
    { onSuccess: () => queryClient.invalidateQueries(["chaos", space]) }
  );

  return (
    <PageShell title="Chaos engineering">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <Text className="mb-cn-md text-cn-foreground-3">
        Experiment definitions + outcome ledger. Experiments run on your own infra; record the
        result here.
      </Text>
      <div className="mb-cn-lg flex items-end gap-cn-md">
        <TextInput label="Identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="latency-poke" />
        <select
          className="rounded-cn-md border border-cn-borders-2 bg-cn-background-1 px-cn-md py-cn-sm text-cn-foreground-1"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="latency">latency</option>
          <option value="failure">failure</option>
          <option value="resource">resource</option>
        </select>
        <Button disabled={!identifier.trim() || create.isLoading} onClick={() => create.mutate()}>
          Create
        </Button>
      </div>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identifier</Table.Head>
            <Table.Head>Kind</Table.Head>
            <Table.Head>Last run</Table.Head>
            <Table.Head>Outcome</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(data ?? []).map((x) => (
            <Table.Row key={x.id}>
              <Table.Cell>{x.identifier}</Table.Cell>
              <Table.Cell>
                <StatusBadge variant="outline">{x.kind}</StatusBadge>
              </Table.Cell>
              <Table.Cell>{x.last_run ? new Date(x.last_run).toLocaleString() : "never"}</Table.Cell>
              <Table.Cell>
                {x.last_outcome ? (
                  <StatusBadge variant="status" theme={x.last_outcome === "pass" ? "success" : "danger"}>
                    {x.last_outcome}
                  </StatusBadge>
                ) : (
                  "—"
                )}
              </Table.Cell>
              <Table.Cell>
                <div className="flex gap-cn-sm">
                  <Button variant="ghost" size="sm" onClick={() => recordRun.mutate({ id: x.identifier, outcome: "pass" })}>
                    Pass
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => recordRun.mutate({ id: x.identifier, outcome: "fail" })}>
                    Fail
                  </Button>
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {(data ?? []).length === 0 && <EmptyNote text="No chaos experiments." />}
    </PageShell>
  );
}

// --- service reliability overview ---------------------------------------------------------------------

interface ReliabilitySummary {
  monitors: { total: number; up: number; down: number };
  slos: number;
  open_incidents: number;
  expiring_certificates: number;
}

export function ServiceReliabilityPage() {
  const { spaces, space, setSpace } = useSpacePicker();
  const { data } = useQuery(
    ["reliability", space],
    () => deltaApi<ReliabilitySummary>(`/api/v1/spaces/${space}/reliability`),
    { enabled: !!space }
  );

  const cards: { label: string; value: string }[] = data
    ? [
        { label: "Monitors up", value: `${data.monitors.up}/${data.monitors.total}` },
        { label: "SLOs tracked", value: String(data.slos) },
        { label: "Open incidents", value: String(data.open_incidents) },
        { label: "Certs expiring <30d", value: String(data.expiring_certificates) },
      ]
    : [];

  return (
    <PageShell title="Service reliability">
      <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
      <div className="grid grid-cols-2 gap-cn-md md:grid-cols-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="rounded-cn-md border border-cn-borders-2 bg-cn-background-2 p-cn-lg"
          >
            <div className="text-2xl font-semibold text-cn-foreground-1">{card.value}</div>
            <div className="text-sm text-cn-foreground-3">{card.label}</div>
          </div>
        ))}
      </div>
    </PageShell>
  );
}
