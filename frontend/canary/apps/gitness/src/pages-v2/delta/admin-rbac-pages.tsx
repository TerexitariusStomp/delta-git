import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Button, SandboxLayout, StatusBadge, Table, Text, TextInput } from '@harnessio/ui/components'

/**
 * Space-scoped RBAC admin surfaces — user groups, service accounts,
 * resource groups, and roles. delta-git scopes all RBAC objects to a
 * namespace ("space" in gitness terms), so each page opens with a space
 * picker populated from the viewer's memberships.
 */

interface Membership {
  space: { identifier: string; path: string }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init
  })
  const body = (await res.json().catch(() => null)) as T & { error?: string; message?: string }
  if (!res.ok) throw new Error(body?.error ?? body?.message ?? `request failed: ${res.status}`)
  return body
}

const useSpaces = () =>
  useQuery(['rbac', 'spaces'], () => api<Membership[]>('/api/v1/user/memberships'), {
    select: rows => rows.map(r => r.space.identifier)
  })

function useSpacePicker() {
  const { data: spaces } = useSpaces()
  const [space, setSpace] = useState<string | null>(null)
  const active = space ?? spaces?.[0] ?? null
  return { spaces: spaces ?? [], space: active, setSpace }
}

function SpacePicker({
  spaces,
  space,
  setSpace
}: {
  spaces: string[]
  space: string | null
  setSpace: (s: string) => void
}) {
  return (
    <div className="mb-cn-lg flex items-center gap-cn-md">
      <Text variant="heading-subsection">Space</Text>
      <select
        className="rounded-cn-md border border-cn-borders-2 bg-cn-background-1 px-cn-md py-cn-sm text-cn-foreground-1"
        value={space ?? ''}
        onChange={e => setSpace(e.target.value)}>
        {spaces.map(s => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </div>
  )
}

function PageShell({
  title,
  subtitle,
  spaces,
  space,
  setSpace,
  children
}: {
  title: string
  subtitle?: string
  spaces: string[]
  space: string | null
  setSpace: (s: string) => void
  children: React.ReactNode
}) {
  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-sm">
          {title}
        </Text>
        {subtitle && (
          <Text color="foreground-3" className="mb-cn-md block">
            {subtitle}
          </Text>
        )}
        <SpacePicker spaces={spaces} space={space} setSpace={setSpace} />
        {space ? children : <Text color="foreground-3">No spaces — create one first.</Text>}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}

const ROLES = ['owner', 'developer', 'viewer']

// --- user groups -------------------------------------------------------------

interface UserGroup {
  id: number
  identifier: string
  description: string
  role: string
  users: number
}

export function AdminUserGroupsPage() {
  const picker = useSpacePicker()
  const space = picker.space
  const qc = useQueryClient()
  const { data: groups } = useQuery(
    ['rbac', 'usergroups', space],
    () => api<UserGroup[]>(`/api/v1/spaces/${space}/usergroups`),
    { enabled: !!space }
  )
  const [identifier, setIdentifier] = useState('')
  const [role, setRole] = useState('viewer')
  const [memberUid, setMemberUid] = useState('')
  const create = useMutation(
    (body: { identifier: string; role: string }) =>
      api(`/api/v1/spaces/${space}/usergroups`, { method: 'POST', body: JSON.stringify(body) }),
    { onSuccess: () => qc.invalidateQueries({ queryKey: ['rbac', 'usergroups', space] }) }
  )
  const addMember = useMutation(
    (identifier: string) =>
      api(`/api/v1/spaces/${space}/usergroups/${identifier}/members`, {
        method: 'POST',
        body: JSON.stringify({ user_uid: memberUid })
      }),
    { onSuccess: () => setMemberUid('') }
  )
  const remove = useMutation(
    (identifier: string) =>
      api(`/api/v1/spaces/${space}/usergroups/${identifier}`, { method: 'DELETE' }),
    { onSuccess: () => qc.invalidateQueries({ queryKey: ['rbac', 'usergroups', space] }) }
  )

  return (
    <PageShell
      title="User Groups"
      subtitle="Named member groups — a group's role is conferred on all its members."
      spaces={picker.spaces}
      space={space}
      setSpace={picker.setSpace}>
      <div className="mb-cn-lg flex gap-cn-sm">
        <TextInput
          value={identifier}
          onChange={e => setIdentifier(e.target.value)}
          placeholder="group identifier"
        />
        <select
          className="rounded-cn-md border border-cn-borders-2 bg-cn-background-1 px-cn-md text-cn-foreground-1"
          value={role}
          onChange={e => setRole(e.target.value)}>
          {ROLES.map(r => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <Button
          disabled={!identifier.trim() || create.isLoading}
          onClick={() => create.mutate({ identifier: identifier.trim(), role })}>
          Create
        </Button>
      </div>
      {create.isError && <Text color="danger">{String(create.error)}</Text>}
      <Table.Root variant="default">
        <Table.Header>
          <Table.Row>
            <Table.Head>Group</Table.Head>
            <Table.Head>Role</Table.Head>
            <Table.Head>Members</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(groups ?? []).map(g => (
            <Table.Row key={g.identifier}>
              <Table.Cell>
                <code>{g.identifier}</code>
                {g.description && <Text color="foreground-3"> {g.description}</Text>}
              </Table.Cell>
              <Table.Cell>
                <StatusBadge variant="status" theme="info">
                  {g.role}
                </StatusBadge>
              </Table.Cell>
              <Table.Cell>{g.users}</Table.Cell>
              <Table.Cell>
                <div className="flex gap-cn-sm">
                  <TextInput
                    value={memberUid}
                    onChange={e => setMemberUid(e.target.value)}
                    placeholder="add member (uid)"
                  />
                  <Button variant="secondary" onClick={() => addMember.mutate(g.identifier)}>
                    Add
                  </Button>
                  <Button variant="secondary" onClick={() => remove.mutate(g.identifier)}>
                    Delete
                  </Button>
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {groups && groups.length === 0 && <Text color="foreground-3">No user groups yet.</Text>}
    </PageShell>
  )
}

// --- service accounts ----------------------------------------------------------

interface ServiceAccount {
  id: number
  uid: string
  identifier: string
  description: string
  role: string
  active: boolean
}

export function AdminServiceAccountsPage() {
  const picker = useSpacePicker()
  const space = picker.space
  const qc = useQueryClient()
  const { data: accounts } = useQuery(
    ['rbac', 'serviceaccounts', space],
    () => api<ServiceAccount[]>(`/api/v1/spaces/${space}/serviceaccounts`),
    { enabled: !!space }
  )
  const [identifier, setIdentifier] = useState('')
  const [role, setRole] = useState('developer')
  const [minted, setMinted] = useState<{ account: string; token: string } | null>(null)
  const create = useMutation(
    (body: { identifier: string; role: string }) =>
      api(`/api/v1/spaces/${space}/serviceaccounts`, { method: 'POST', body: JSON.stringify(body) }),
    { onSuccess: () => qc.invalidateQueries({ queryKey: ['rbac', 'serviceaccounts', space] }) }
  )
  const mint = useMutation(
    (sa: ServiceAccount) =>
      api<{ token: string }>(`/api/v1/spaces/${space}/serviceaccounts/${sa.uid}/token`, {
        method: 'POST',
        body: '{}'
      }),
    { onSuccess: (res, sa) => setMinted({ account: sa.identifier, token: res.token }) }
  )
  const toggle = useMutation(
    (sa: ServiceAccount) =>
      api(`/api/v1/spaces/${space}/serviceaccounts/${sa.uid}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !sa.active })
      }),
    { onSuccess: () => qc.invalidateQueries({ queryKey: ['rbac', 'serviceaccounts', space] }) }
  )

  return (
    <PageShell
      title="Service Accounts"
      subtitle="Non-user principals for automation — PATs act under the account's role."
      spaces={picker.spaces}
      space={space}
      setSpace={picker.setSpace}>
      <div className="mb-cn-lg flex gap-cn-sm">
        <TextInput
          value={identifier}
          onChange={e => setIdentifier(e.target.value)}
          placeholder="account identifier"
        />
        <select
          className="rounded-cn-md border border-cn-borders-2 bg-cn-background-1 px-cn-md text-cn-foreground-1"
          value={role}
          onChange={e => setRole(e.target.value)}>
          {ROLES.map(r => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <Button
          disabled={!identifier.trim() || create.isLoading}
          onClick={() => create.mutate({ identifier: identifier.trim(), role })}>
          Create
        </Button>
      </div>
      {minted && (
        <div className="mb-cn-md rounded-cn-md border border-cn-borders-2 p-cn-md">
          <Text variant="heading-subsection" className="mb-cn-sm">
            Token for {minted.account} — shown once, store it now
          </Text>
          <code className="break-all text-cn-foreground-1">{minted.token}</code>
        </div>
      )}
      <Table.Root variant="default">
        <Table.Header>
          <Table.Row>
            <Table.Head>Account</Table.Head>
            <Table.Head>Role</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(accounts ?? []).map(sa => (
            <Table.Row key={sa.identifier}>
              <Table.Cell>
                <code>{sa.identifier}</code>
              </Table.Cell>
              <Table.Cell>
                <StatusBadge variant="status" theme="info">
                  {sa.role}
                </StatusBadge>
              </Table.Cell>
              <Table.Cell>{sa.active ? 'active' : 'disabled'}</Table.Cell>
              <Table.Cell>
                <div className="flex gap-cn-sm">
                  <Button variant="secondary" onClick={() => mint.mutate(sa)}>
                    Mint token
                  </Button>
                  <Button variant="secondary" onClick={() => toggle.mutate(sa)}>
                    {sa.active ? 'Disable' : 'Enable'}
                  </Button>
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {accounts && accounts.length === 0 && <Text color="foreground-3">No service accounts yet.</Text>}
    </PageShell>
  )
}

// --- resource groups ------------------------------------------------------------

interface ResourceGroup {
  id: number
  identifier: string
  description: string
  items: { type: string; ref: string }[]
}

export function AdminResourceGroupsPage() {
  const picker = useSpacePicker()
  const space = picker.space
  const qc = useQueryClient()
  const { data: groups } = useQuery(
    ['rbac', 'resourcegroups', space],
    () => api<ResourceGroup[]>(`/api/v1/spaces/${space}/resourcegroups`),
    { enabled: !!space }
  )
  const [identifier, setIdentifier] = useState('')
  const [ref, setRef] = useState('')
  const create = useMutation(
    (body: { identifier: string }) =>
      api(`/api/v1/spaces/${space}/resourcegroups`, { method: 'POST', body: JSON.stringify(body) }),
    { onSuccess: () => qc.invalidateQueries({ queryKey: ['rbac', 'resourcegroups', space] }) }
  )
  const addItem = useMutation(
    (identifier: string) =>
      api(`/api/v1/spaces/${space}/resourcegroups/${identifier}/resources`, {
        method: 'POST',
        body: JSON.stringify({ resource_type: 'repo', resource_ref: ref })
      }),
    { onSuccess: () => setRef('') }
  )

  return (
    <PageShell
      title="Resource Groups"
      subtitle="Named bundles of repos/spaces — targets for policy and freeze rules."
      spaces={picker.spaces}
      space={space}
      setSpace={picker.setSpace}>
      <div className="mb-cn-lg flex gap-cn-sm">
        <TextInput
          value={identifier}
          onChange={e => setIdentifier(e.target.value)}
          placeholder="group identifier"
        />
        <Button
          disabled={!identifier.trim() || create.isLoading}
          onClick={() => create.mutate({ identifier: identifier.trim() })}>
          Create
        </Button>
      </div>
      <Table.Root variant="default">
        <Table.Header>
          <Table.Row>
            <Table.Head>Group</Table.Head>
            <Table.Head>Resources</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(groups ?? []).map(g => (
            <Table.Row key={g.identifier}>
              <Table.Cell>
                <code>{g.identifier}</code>
              </Table.Cell>
              <Table.Cell>
                {g.items.map(i => `${i.type}:${i.ref}`).join(', ') || '—'}
              </Table.Cell>
              <Table.Cell>
                <div className="flex gap-cn-sm">
                  <TextInput
                    value={ref}
                    onChange={e => setRef(e.target.value)}
                    placeholder="add resource ref"
                  />
                  <Button variant="secondary" onClick={() => addItem.mutate(g.identifier)}>
                    Add
                  </Button>
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {groups && groups.length === 0 && <Text color="foreground-3">No resource groups yet.</Text>}
    </PageShell>
  )
}

// --- roles -----------------------------------------------------------------------

interface RoleList {
  roles: { identifier: string; actions: string; builtin: boolean }[]
  custom: { ptype: string; v0: string; v1: string; v2: string; v3: string | null }[]
}

export function AdminRolesPage() {
  const picker = useSpacePicker()
  const space = picker.space
  const { data } = useQuery(
    ['rbac', 'roles', space],
    () => api<RoleList>(`/api/v1/spaces/${space}/roles`),
    { enabled: !!space }
  )
  const builtins = useMemo(() => data?.roles.filter(r => r.builtin) ?? [], [data])

  return (
    <PageShell
      title="Roles"
      subtitle="Built-in role tiers and custom casbin policy rows for this space."
      spaces={picker.spaces}
      space={space}
      setSpace={picker.setSpace}>
      <Table.Root variant="default" className="mb-cn-lg">
        <Table.Header>
          <Table.Row>
            <Table.Head>Role</Table.Head>
            <Table.Head>Allowed actions</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {builtins.map(r => (
            <Table.Row key={r.identifier}>
              <Table.Cell>
                <StatusBadge variant="status" theme="info">
                  {r.identifier}
                </StatusBadge>
              </Table.Cell>
              <Table.Cell>
                <code>{r.actions}</code>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {data && data.custom.length > 0 && (
        <>
          <Text variant="heading-subsection" className="mb-cn-md">
            Custom policy rows
          </Text>
          <Table.Root variant="default">
            <Table.Header>
              <Table.Row>
                <Table.Head>Type</Table.Head>
                <Table.Head>Subject</Table.Head>
                <Table.Head>Domain</Table.Head>
                <Table.Head>Object</Table.Head>
                <Table.Head>Action</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.custom.map((r, i) => (
                <Table.Row key={i}>
                  <Table.Cell>{r.ptype}</Table.Cell>
                  <Table.Cell>
                    <code>{r.v0}</code>
                  </Table.Cell>
                  <Table.Cell>
                    <code>{r.v1}</code>
                  </Table.Cell>
                  <Table.Cell>
                    <code>{r.v2}</code>
                  </Table.Cell>
                  <Table.Cell>
                    <code>{r.v3 ?? ''}</code>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </>
      )}
    </PageShell>
  )
}
