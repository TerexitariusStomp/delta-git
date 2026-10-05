import { FormEvent, useCallback, useEffect, useState } from 'react'

import { Button, SandboxLayout, StatusBadge, Table, Tabs, Text } from '@harnessio/ui/components'

import {
  createGrant,
  listGrants,
  listSecrets,
  revokeGrant,
  sealSecret,
  secretsAudit,
  secretsKillswitch,
  unsealSecret,
  type SecretAuditEntry,
  type SecretGrantInfo,
  type SecretHandleMeta,
} from '../../delta/custody'

const ts = (n: number | null | undefined) => (n ? new Date(n).toLocaleString() : '—')

/**
 * Secrets vault — client-sovereign custody.
 *
 * Secret values are sealed inside the browser's key-custody worker
 * (non-extractable, worker-scoped IndexedDB) — this page renders only handle
 * metadata, durable agent grants, and the hash-chained audit log. No op here
 * returns secret material; injection happens inside the worker on invoke.
 */
export function SecretsVaultPage() {
  const [tab, setTab] = useState('secrets')
  const [secrets, setSecrets] = useState<SecretHandleMeta[]>([])
  const [grants, setGrants] = useState<SecretGrantInfo[]>([])
  const [audit, setAudit] = useState<SecretAuditEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [s, g, a] = await Promise.all([listSecrets(), listGrants(), secretsAudit(100)])
      setSecrets(s)
      setGrants(g)
      setAudit(a)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onSeal = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    try {
      await sealSecret(
        String(data.get('label') ?? ''),
        String(data.get('secret') ?? ''),
        String(data.get('hosts') ?? '')
          .split(',')
          .map(h => h.trim())
          .filter(Boolean),
        data.get('canary') === 'on'
      )
      form.reset()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onGrant = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    try {
      await createGrant(
        String(data.get('label') ?? ''),
        String(data.get('handles') ?? '')
          .split(',')
          .map(h => h.trim())
          .filter(Boolean),
        String(data.get('hosts') ?? '')
          .split(',')
          .map(h => h.trim())
          .filter(Boolean)
      )
      form.reset()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onDelete = async (handle: string) => {
    try {
      await unsealSecret(handle)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onRevoke = async (grantId: string) => {
    try {
      await revokeGrant(grantId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onWipe = async () => {
    try {
      await secretsKillswitch(true)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          Secrets Vault
        </Text>
        <Text color="foreground-3" className="mb-cn-lg">
          Sealed in this browser's key-custody worker — the server never sees values.
        </Text>
        {error && (
          <Text color="danger" className="mb-cn-md">
            {error}
          </Text>
        )}
        <Tabs.Root value={tab} onValueChange={setTab}>
          <Tabs.List>
            <Tabs.Trigger value="secrets">Secrets</Tabs.Trigger>
            <Tabs.Trigger value="grants">Agent Grants</Tabs.Trigger>
            <Tabs.Trigger value="audit">Audit</Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="secrets">
            <form onSubmit={onSeal} className="mb-cn-md grid grid-cols-4 gap-2">
              <input name="label" required placeholder="Name" className="rounded border p-2 text-sm" />
              <input
                name="secret"
                required
                type="password"
                placeholder="Secret value"
                className="rounded border p-2 text-sm"
              />
              <input
                name="hosts"
                required
                placeholder="Allowed hosts (csv)"
                className="rounded border p-2 text-sm"
              />
              <div className="flex items-center gap-2">
                <label className="text-xs">
                  <input type="checkbox" name="canary" /> canary
                </label>
                <Button type="submit" size="sm">
                  Seal
                </Button>
              </div>
            </form>
            {!secrets.length ? (
              <Text color="foreground-3">No secrets sealed in this browser.</Text>
            ) : (
              <Table.Root variant="default">
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Name</Table.Head>
                    <Table.Head>Allowed hosts</Table.Head>
                    <Table.Head>Kind</Table.Head>
                    <Table.Head>Created</Table.Head>
                    <Table.Head />
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {secrets.map(s => (
                    <Table.Row key={s.handle}>
                      <Table.Cell>
                        {s.label}
                        {s.canary && (
                          <StatusBadge variant="status" theme="warning" className="ml-2">
                            canary
                          </StatusBadge>
                        )}
                      </Table.Cell>
                      <Table.Cell>{s.allowedHosts.join(', ')}</Table.Cell>
                      <Table.Cell>{s.kind}</Table.Cell>
                      <Table.Cell>{ts(s.createdAt)}</Table.Cell>
                      <Table.Cell>
                        <Button size="sm" variant="ghost" onClick={() => void onDelete(s.handle)}>
                          Delete
                        </Button>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            )}
          </Tabs.Content>

          <Tabs.Content value="grants">
            <form onSubmit={onGrant} className="mb-cn-md grid grid-cols-4 gap-2">
              <input
                name="label"
                required
                placeholder="Agent label"
                className="rounded border p-2 text-sm"
              />
              <input
                name="handles"
                required
                placeholder="Handle ids (csv)"
                className="rounded border p-2 text-sm"
              />
              <input
                name="hosts"
                required
                placeholder="Hosts (csv)"
                className="rounded border p-2 text-sm"
              />
              <Button type="submit" size="sm">
                Grant
              </Button>
            </form>
            {!grants.length ? (
              <Text color="foreground-3">No agent grants — agents cannot use any secrets.</Text>
            ) : (
              <Table.Root variant="default">
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Agent</Table.Head>
                    <Table.Head>Handles</Table.Head>
                    <Table.Head>Hosts</Table.Head>
                    <Table.Head>Invokes</Table.Head>
                    <Table.Head>Status</Table.Head>
                    <Table.Head />
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {grants.map(g => (
                    <Table.Row key={g.id}>
                      <Table.Cell>{g.label}</Table.Cell>
                      <Table.Cell>{g.handles === '*' ? '*' : g.handles.length}</Table.Cell>
                      <Table.Cell>{g.hosts === '*' ? '*' : g.hosts.join(', ')}</Table.Cell>
                      <Table.Cell>
                        {g.invokeCount}
                        {g.maxInvokes ? `/${g.maxInvokes}` : ''}
                      </Table.Cell>
                      <Table.Cell>
                        <StatusBadge variant="status" theme={g.revokedAt ? 'danger' : 'success'}>
                          {g.revokedAt ? 'revoked' : 'active'}
                        </StatusBadge>
                      </Table.Cell>
                      <Table.Cell>
                        {!g.revokedAt && (
                          <Button size="sm" variant="ghost" onClick={() => void onRevoke(g.id)}>
                            Revoke
                          </Button>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            )}
          </Tabs.Content>

          <Tabs.Content value="audit">
            <div className="mb-cn-md flex items-center gap-3">
              <Text color="foreground-3">
                Hash-chained custody audit — ops only, never values.
              </Text>
              <Button size="sm" variant="ghost" onClick={() => void onWipe()}>
                Killswitch (wipe)
              </Button>
            </div>
            {!audit.length ? (
              <Text color="foreground-3">No audit entries yet.</Text>
            ) : (
              <Table.Root variant="default">
                <Table.Header>
                  <Table.Row>
                    <Table.Head>#</Table.Head>
                    <Table.Head>Op</Table.Head>
                    <Table.Head>Outcome</Table.Head>
                    <Table.Head>Detail</Table.Head>
                    <Table.Head>Time</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {audit.map(e => (
                    <Table.Row key={e.seq}>
                      <Table.Cell>{e.seq}</Table.Cell>
                      <Table.Cell>{e.op}</Table.Cell>
                      <Table.Cell>
                        <StatusBadge
                          variant="status"
                          theme={
                            e.outcome === 'ok' ? 'success' : e.outcome === 'trip' ? 'danger' : 'warning'
                          }>
                          {e.outcome}
                        </StatusBadge>
                      </Table.Cell>
                      <Table.Cell>{e.detail ?? ''}</Table.Cell>
                      <Table.Cell>{ts(e.ts)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            )}
          </Tabs.Content>
        </Tabs.Root>
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}
