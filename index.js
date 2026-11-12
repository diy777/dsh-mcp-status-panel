const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'

export const name = 'dsh-mcp-status-panel'
export const inject = ['loader', 'tools', 'mcpResources']

function safeEndpoint(config) {
  if (config?.transport === 'streamable-http') {
    try {
      const url = new URL(String(config.url))
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      return url.toString()
    } catch {
      return '(invalid URL)'
    }
  }
  if (config?.transport === 'stdio') {
    const command = typeof config.command === 'string' ? config.command : ''
    const args = Array.isArray(config.args) ? config.args.filter(value => typeof value === 'string') : []
    if (!command) return '(command not configured)'
    return args.length ? `${command} (+${args.length} args)` : command
  }
  return '(unknown transport)'
}

export function classifyServer(entry, probe) {
  if (!entry.enabled) return 'disabled'
  if (entry.fiberPhase === 'failed') return 'error'
  if (entry.fiberPhase === 'loading' || entry.fiberPhase === 'pending' || entry.fiberPhase === 'unloading') return 'transitioning'
  if (probe?.ok === true) return 'connected'
  if (probe?.ok === false) return 'disconnected'
  if (entry.fiberPhase === 'active') return 'unknown'
  return 'inactive'
}

export function projectServers(entries, toolSchemas) {
  const mcpEntries = entries.filter(entry => !entry.options?.group && entry.options?.name === MCP_MODULE)
  const serverNames = mcpEntries.map(entry => {
    const configured = entry.options?.config?.serverName
    return typeof configured === 'string' ? configured : String(entry.id)
  }).sort((left, right) => right.length - left.length)
  const names = new Map(serverNames.map(server => [server, 0]))
  for (const schema of toolSchemas) {
    const toolName = schema?.name ?? ''
    const server = serverNames.find(candidate => toolName.startsWith(`mcp__${candidate}__`))
    if (server) names.set(server, (names.get(server) ?? 0) + 1)
  }
  return mcpEntries.map(entry => {
      const config = entry.options?.config ?? {}
      const serverName = typeof config.serverName === 'string' ? config.serverName : entry.id
      const toolCount = names.get(serverName) ?? 0
      const fiberPhase = phaseOf(entry.fiber)
      const enabled = !entry.disabled
      const diagnostic = diagnosticOf(entry.fiber, fiberPhase)
      return {
        entryId: String(entry.id),
        serverName,
        enabled,
        fiberPhase,
        state: classifyServer({ enabled, fiberPhase }),
        transport: typeof config.transport === 'string' ? config.transport : 'unknown',
        endpoint: safeEndpoint(config),
        toolCount,
        ...(diagnostic ? { error: diagnostic } : {}),
      }
    })
}

function phaseOf(fiber) {
  if (!fiber) return null
  return ['pending', 'loading', 'active', 'failed', null, 'unloading'][fiber.state] ?? null
}

function diagnosticOf(fiber, phase) {
  if (phase !== 'failed') return undefined
  const error = fiber?.error ?? fiber?._error ?? fiber?.reason
  return error instanceof Error ? error.message : error == null ? 'Plugin activation failed' : String(error)
}

function allowRequest(request, response) {
  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET' })
    response.end()
    return false
  }
  const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
    response.writeHead(403)
    response.end()
    return false
  }
  const origin = request.headers.origin
  const host = String(request.headers.host ?? '')
  if (origin) {
    try {
      if (!host || new URL(String(origin)).host.toLowerCase() !== host.toLowerCase()) throw new Error('cross origin')
    } catch {
      response.writeHead(403)
      response.end()
      return false
    }
  }
  return true
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

async function probeServer(ctx, server) {
  if (!server.enabled || server.fiberPhase !== 'active') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  timer.unref?.()
  try {
    await ctx.mcpResources.request(server.serverName, { method: 'resources/list' }, { signal: controller.signal })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

export async function snapshot(ctx) {
  const entries = [...ctx.loader.entries()]
  const toolSchemas = ctx.tools.schemas()
  const servers = projectServers(entries, toolSchemas)
  const probes = await Promise.all(servers.map(server => probeServer(ctx, server)))
  return {
    servers: servers.map((server, index) => {
      const probe = probes[index]
      if (!probe) return server
      return {
        ...server,
        state: classifyServer(server, probe),
        ...(probe.ok ? {} : { error: probe.error }),
      }
    }),
    updatedAt: new Date().toISOString(),
  }
}

export function apply(ctx) {
  ctx.inject(['webServer'], host => host.effect(() => host.webServer.register({
    kind: 'exact',
    path: '/mcp-panel/status',
    async handler(request, response) {
      if (!allowRequest(request, response)) return
      try {
        sendJson(response, 200, { ok: true, ...await snapshot(ctx) })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }, 'mcp-status-panel: status')))
}
