import { useParams } from 'react-router-dom'

import { Layout, Link, MarkdownViewer, SandboxLayout, StatusBadge, Text } from '@harnessio/ui/components'

import { PathParams } from '../../RouteDefinitions'
import { useGitRef } from '../../hooks/useGitRef'
import { useSecurityPolicy, useSecurityScan, useSecuritySettings } from '../delta/delta-api'

const KIND_LABEL: Record<string, string> = {
  'pem-private-key': 'Private key',
  'aws-access-key': 'AWS access key',
  'generic-token': 'Token / API key'
}

/** Security overview — push-scan policy state + HEAD secret-scan findings. */
export function RepoSecurityPage() {
  const { spaceId = '', repoId = '' } = useParams<PathParams>()
  const { fullGitRef } = useGitRef()
  const base = `/${spaceId}/repos/${repoId}`
  const { data: scan, isLoading } = useSecurityScan(spaceId, repoId)
  const { data: settings } = useSecuritySettings(spaceId, repoId)
  const { data: policy } = useSecurityPolicy(spaceId, repoId)

  const findings = scan?.findings ?? []
  const grouped = new Map<string, typeof findings>()
  for (const f of findings) {
    const list = grouped.get(f.kind) ?? []
    list.push(f)
    grouped.set(f.kind, list)
  }

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          Security
        </Text>

        {settings && (
          <Layout.Vertical gap="xs" className="border border-cn-2 rounded-cn-3 p-cn-md mb-cn-md">
            <Text variant="body-strong">Push protection</Text>
            <Layout.Flex gap="sm" align="center">
              <StatusBadge
                variant="status"
                theme={settings.vulnerability_scanning_mode === 'block' ? 'success' : settings.vulnerability_scanning_mode === 'detect' ? 'warning' : 'muted'}>
                {settings.vulnerability_scanning_mode === 'block'
                  ? 'Required — pushes must carry a scan attestation'
                  : settings.vulnerability_scanning_mode === 'detect'
                    ? 'Detect — scans recorded, not gated'
                    : 'Disabled'}
              </StatusBadge>
            </Layout.Flex>
            <Text color="foreground-3">
              Secret scanning {settings.secret_scanning_enabled ? 'enabled' : 'disabled'}
              {settings.principal_committer_match ? ' · committer-match enforced' : ''}
              {settings.force_push?.blocked ? ' · force-push blocked' : ''}
            </Text>
            <Text color="foreground-3">
              Scans run on the pusher&rsquo;s machine (dgit CLI / pre-push hook) — the server only sees
              the attestation. Manage in{' '}
              <Link to={`${base}/settings`} variant="secondary">
                repository settings
              </Link>
              .
            </Text>
          </Layout.Vertical>
        )}

        {policy?.content && (
          <Layout.Vertical gap="sm" className="border border-cn-2 rounded-cn-3 p-cn-md mb-cn-md">
            <Text variant="body-strong">Security policy</Text>
            <Text color="foreground-3" variant="body-normal">
              From <Link to={`${base}/files/~/blob/${policy.path}`} variant="secondary">{policy.path}</Link>
            </Text>
            <MarkdownViewer source={policy.content} />
          </Layout.Vertical>
        )}

        <Layout.Vertical gap="sm" className="border border-cn-2 rounded-cn-3 p-cn-md">
          <Layout.Flex justify="between" align="center">
            <Text variant="body-strong">HEAD scan</Text>
            {scan && (
              <Text color="foreground-3">
                {scan.scanned_files} files scanned · {findings.length} finding
                {findings.length === 1 ? '' : 's'}
              </Text>
            )}
          </Layout.Flex>
          {isLoading ? (
            <Text color="foreground-3">Scanning…</Text>
          ) : findings.length === 0 ? (
            <Text color="foreground-3">No secret-signature findings on the current HEAD.</Text>
          ) : (
            [...grouped.entries()].map(([kind, rows]) => (
              <Layout.Vertical key={kind} gap="2xs">
                <StatusBadge variant="status" theme="danger">
                  {KIND_LABEL[kind] ?? kind} ({rows.length})
                </StatusBadge>
                {rows.map((f, i) => (
                  <Text key={i} variant="body-normal">
                    <Link to={`${base}/files/${fullGitRef}/~/${f.path}`} variant="secondary">
                      {f.path}
                    </Link>
                    :{f.line}
                  </Text>
                ))}
              </Layout.Vertical>
            ))
          )}
        </Layout.Vertical>
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}
