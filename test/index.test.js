import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyServer, projectServers, snapshot } from '../index.js'

const mcp = (id, config, state = 2, disabled = false) => ({
  id,
  disabled,
  options: { id, name: '@deepseek-ai/dsh-mcp-client', config },
  fiber: state == null ? undefined : { state },
})

test('classifyServer prioritizes lifecycle and real probe results', () => {
  assert.equal(classifyServer({ enabled: false, fiberPhase: 'active' }, { ok: true }), 'disabled')
  assert.equal(classifyServer({ enabled: true, fiberPhase: 'failed' }, { ok: true }), 'error')
  assert.equal(classifyServer({ enabled: true, fiberPhase: 'loading' }, null), 'transitioning')
  assert.equal(classifyServer({ enabled: true, fiberPhase: 'active' }, { ok: true }), 'connected')
  assert.equal(classifyServer({ enabled: true, fiberPhase: 'active' }, { ok: false }), 'disconnected')
  assert.equal(classifyServer({ enabled: true, fiberPhase: 'active' }, null), 'unknown')
})

test('projectServers filters MCP rows and safely summarizes configuration', () => {
  const rows = projectServers([
    mcp('http-mcp', { serverName: 'api__v2', transport: 'streamable-http', url: 'https://user:secret@example.test/mcp?token=hidden#x', headers: { authorization: 'secret' } }),
    mcp('stdio-mcp', { serverName: 'local', transport: 'stdio', command: 'node.exe', args: ['server.js', '--token', 'secret'], env: { TOKEN: 'secret' } }),
    { id: 'other', disabled: false, options: { name: 'other-plugin', config: {} }, fiber: { state: 2 } },
  ], [
    { name: 'mcp__api__v2__first' },
    { name: 'mcp__api__v2__second' },
    { name: 'mcp__local__one' },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].toolCount, 2)
  assert.equal(rows[0].endpoint, 'https://example.test/mcp')
  assert.equal(rows[1].toolCount, 1)
  assert.equal(rows[1].endpoint, 'node.exe (+3 args)')
  const json = JSON.stringify(rows)
  assert.doesNotMatch(json, /secret|hidden|authorization|TOKEN|server\.js/)
})

test('snapshot probes the existing MCP connection and preserves tool count', async () => {
  const ctx = {
    loader: { entries: () => [mcp('rea-mcp', { serverName: 'rea', transport: 'stdio', command: 'node' })] },
    tools: { schemas: () => [{ name: 'mcp__rea__one' }] },
    mcpResources: { request: async (server, request, exec) => {
      assert.equal(server, 'rea')
      assert.deepEqual(request, { method: 'resources/list' })
      assert.equal(exec.signal.aborted, false)
      return { resources: [] }
    } },
  }
  const result = await snapshot(ctx)
  assert.equal(result.servers[0].state, 'connected')
  assert.equal(result.servers[0].toolCount, 1)
})

test('snapshot exposes a real connection probe failure', async () => {
  const ctx = {
    loader: { entries: () => [mcp('burp-mcp', { serverName: 'burp', transport: 'streamable-http', url: 'http://127.0.0.1:9876/mcp' })] },
    tools: { schemas: () => [] },
    mcpResources: { request: async () => { throw new Error('mcp-client(burp): server is disconnected') } },
  }
  const result = await snapshot(ctx)
  assert.equal(result.servers[0].state, 'disconnected')
  assert.match(result.servers[0].error, /server is disconnected/)
})
