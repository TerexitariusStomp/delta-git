import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

import { Button, SandboxLayout, Table, Text, TextInput } from '@harnessio/ui/components'
import mermaid from 'mermaid'

import { PathParams } from '../../RouteDefinitions'
import { useAskRepo, useRepoKnowledge, type RepoKnowledgeDoc } from './delta-api'

mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' })

/** Render a mermaid definition to inline SVG. */
function MermaidDiagram({ code, title }: { code: string; title: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const idRef = useRef(`kb-${Math.random().toString(36).slice(2, 10)}`)

  useEffect(() => {
    let cancelled = false
    mermaid
      .render(idRef.current, code)
      .then(({ svg }) => {
        if (!cancelled) setSvg(svg)
      })
      .catch(err => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [code])

  if (error) {
    return (
      <details>
        <summary className="cursor-pointer text-cn-3">{title} (render failed — show source)</summary>
        <pre className="mt-cn-sm overflow-auto rounded-cn-2 bg-cn-2 p-cn-md text-cn-1">
          {code}
        </pre>
      </details>
    )
  }
  if (!svg) return <Text color="foreground-3">Rendering diagram…</Text>
  return (
    <div>
      <Text variant="heading-subsection" className="mb-cn-sm">
        {title}
      </Text>
      {/* mermaid.render returns sanitized svg under securityLevel 'strict' */}
      <div className="overflow-auto" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-cn-xl">
      <Text variant="heading-subsection" className="mb-cn-md">
        {title}
      </Text>
      {children}
    </section>
  )
}

function KnowledgeBody({ kb }: { kb: RepoKnowledgeDoc }) {
  const modules = Object.entries(kb.moduleBlurbs)
  const topFiles = useMemo(
    () => [...kb.files].sort((a, b) => b.symbols.length - a.symbols.length).slice(0, 20),
    [kb.files]
  )
  return (
    <>
      {kb.summary && <Text className="mb-cn-xl block max-w-3xl">{kb.summary}</Text>}

      {kb.diagrams.length > 0 && (
        <Section title="Architecture">
          <div className="space-y-cn-xl">
            {kb.diagrams.slice(0, 3).map(d => (
              <MermaidDiagram key={d.id} code={d.mermaid} title={d.title} />
            ))}
          </div>
        </Section>
      )}

      {modules.length > 0 && (
        <Section title="Modules">
          <Table.Root variant="default">
            <Table.Header>
              <Table.Row>
                <Table.Head>Area</Table.Head>
                <Table.Head>Summary</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {modules.map(([mod, blurb]) => (
                <Table.Row key={mod}>
                  <Table.Cell>
                    <code>{mod}</code>
                  </Table.Cell>
                  <Table.Cell>{blurb}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Section>
      )}

      <Section title={`Files (${kb.files.length})`}>
        <Table.Root variant="default">
          <Table.Header>
            <Table.Row>
              <Table.Head>Path</Table.Head>
              <Table.Head>Top symbols</Table.Head>
              <Table.Head>Imports</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {topFiles.map(f => (
              <Table.Row key={f.path}>
                <Table.Cell>
                  <code>{f.path}</code>
                </Table.Cell>
                <Table.Cell>
                  {f.symbols
                    .slice(0, 5)
                    .map(s => s.name)
                    .join(', ')}
                </Table.Cell>
                <Table.Cell>{f.imports.length}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Section>

      {kb.tours.length > 0 && (
        <Section title="Guided tours">
          {kb.tours.map(t => (
            <div key={t.id} className="mb-cn-md">
              <Text variant="heading-subsection" className="mb-cn-sm">
                {t.title}
              </Text>
              <ol className="list-decimal space-y-cn-xs pl-cn-lg">
                {t.steps.map((s, i) => (
                  <li key={i}>
                    <code>
                      {s.path}
                      {s.line ? `:${s.line}` : ''}
                    </code>{' '}
                    — {s.note}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </Section>
      )}

      {kb.glossary.length > 0 && (
        <Section title="Glossary">
          <Table.Root variant="default">
            <Table.Header>
              <Table.Row>
                <Table.Head>Term</Table.Head>
                <Table.Head>Definition</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {kb.glossary.map(g => (
                <Table.Row key={g.term}>
                  <Table.Cell>
                    <code>{g.term}</code>
                  </Table.Cell>
                  <Table.Cell>{g.definition}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Section>
      )}
    </>
  )
}

/** Ask-the-repo Q&A — backed by /+/ask RAG with file citations. */
function AskBox({ spaceId, repoId }: { spaceId: string; repoId: string }) {
  const [q, setQ] = useState('')
  const ask = useAskRepo(spaceId, repoId)
  const [history, setHistory] = useState<{ q: string; answer: string; citations: { path: string }[] }[]>([])

  const submit = () => {
    const query = q.trim()
    if (!query || ask.isLoading) return
    ask.mutate(query, {
      onSuccess: res => {
        setHistory(h => [{ q: query, answer: res.answer, citations: res.citations }, ...h])
        setQ('')
      }
    })
  }

  return (
    <Section title="Ask this repo">
      <div className="mb-cn-md flex max-w-3xl gap-cn-sm">
        <TextInput
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submit()
          }}
          placeholder="Where does authentication happen? What renders the file view?"
        />
        <Button onClick={submit} disabled={ask.isLoading || !q.trim()}>
          {ask.isLoading ? 'Asking…' : 'Ask'}
        </Button>
      </div>
      {ask.isError && <Text color="danger">{String(ask.error)}</Text>}
      <div className="space-y-cn-md">
        {history.map((h, i) => (
          <div key={i} className="max-w-3xl rounded-cn-2 border border-cn-2 p-cn-md">
            <Text variant="heading-subsection" className="mb-cn-sm">
              {h.q}
            </Text>
            <Text className="whitespace-pre-wrap">{h.answer}</Text>
            {h.citations.length > 0 && (
              <Text color="foreground-3" className="mt-cn-sm block">
                Sources: {h.citations.map(cite => cite.path).join(', ')}
              </Text>
            )}
          </div>
        ))}
      </div>
    </Section>
  )
}

/** Knowledge tab — auto-generated repo knowledge base for humans + agents. */
export function RepoDeltaKnowledgePage() {
  const { spaceId = '', repoId = '' } = useParams<PathParams>()
  const { data: kb, isLoading, error } = useRepoKnowledge(spaceId, repoId)

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          Knowledge
        </Text>
        <AskBox spaceId={spaceId} repoId={repoId} />
        {isLoading ? (
          <Text color="foreground-3">Building knowledge base — first load walks the repo…</Text>
        ) : error ? (
          <Text color="danger">{String(error)}</Text>
        ) : kb ? (
          <>
            <Text color="foreground-3" className="mb-cn-lg block">
              HEAD <code>{kb.headOid?.slice(0, 10)}</code> · generated{' '}
              {kb.generated ? new Date(kb.generated).toLocaleString() : '—'}
            </Text>
            <KnowledgeBody kb={kb} />
          </>
        ) : (
          <Text color="foreground-3">No knowledge base yet — push a commit to generate it.</Text>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}
