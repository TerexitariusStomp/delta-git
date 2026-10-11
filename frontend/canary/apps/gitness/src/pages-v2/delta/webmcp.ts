import { install } from 'webmcp-core'

/**
 * WebMCP tool surface — lets agent-capable browsers (Kitesurf, Chrome's
 * built-in agent, Browser Run) drive the forge through typed tool calls
 * instead of simulating clicks. Read-only tools over the same endpoints
 * the API exposes; anything that mutates stays behind real auth.
 *
 * webmcp-core is a <10KB zero-dep polyfill (MIT): it installs
 * navigator.modelContext when the browser lacks a native one, and never
 * overwrites a real implementation — so tools register identically on
 * native WebMCP browsers and via the shim.
 */

interface ToolResult {
  content: { type: 'text'; text: string }[]
}

const text = (body: string): ToolResult => ({ content: [{ type: 'text', text: body }] })

async function fetchText(path: string, accept = 'application/json'): Promise<string> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { Accept: accept } })
  const body = await res.text()
  if (!res.ok) return `error ${res.status}: ${body.slice(0, 500)}`
  return body
}

const repoIdSchema = {
  type: 'object' as const,
  properties: {
    owner: { type: 'string', description: 'Namespace/owner slug' },
    repo: { type: 'string', description: 'Repository slug' }
  },
  required: ['owner', 'repo']
}

let installed = false

export function installDeltaWebMcp(): void {
  if (installed || typeof navigator === 'undefined') return
  installed = true
  try {
    install()
    const ctx = navigator.modelContext
    if (!ctx?.registerTool) return

    ctx.registerTool({
      name: 'dg_node_info',
      description:
        'Fetch the delta-git node descriptor: capabilities, auth schemes, agent surfaces, and links.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => text(await fetchText('/.well-known/delta-node'))
    })

    ctx.registerTool({
      name: 'dg_get_repo',
      description:
        'Fetch a repository card as markdown: description, branches, open issues, and API entry points.',
      inputSchema: repoIdSchema,
      execute: async args =>
        text(await fetchText(`/${args.owner}/${args.repo}`, 'text/markdown'))
    })

    ctx.registerTool({
      name: 'dg_list_merge_intents',
      description:
        'List merge intents for a repository — divergent pushes awaiting merge or quorum adjudication, with status and conflicting paths.',
      inputSchema: repoIdSchema,
      execute: async args =>
        text(await fetchText(`/api/${args.owner}/${args.repo}/dg/intents`))
    })

    ctx.registerTool({
      name: 'dg_list_arena_matches',
      description:
        'List arena matches for a repository — timed build contests whose entries are judged by blind vote and model signals.',
      inputSchema: repoIdSchema,
      execute: async args =>
        text(await fetchText(`/api/${args.owner}/${args.repo}/dg/matches`))
    })
  } catch {
    // WebMCP is an enhancement — a browser without the API or a failed
    // polyfill must never take the app down with it.
  }
}
