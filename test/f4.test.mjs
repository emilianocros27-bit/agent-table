// Prueba F4: servidor MCP (stdio, el mismo que usa Claude Code), buzón, tareas y estado. Sin gastar tokens.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-f4-')))
const repo = path.join(tmp, 'repo')
const dataDir = path.join(tmp, 'data')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
let srv, base, token, port, events, lastState
const children = []

before(async () => {
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), 'hola\n')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  srv = spawn('node_modules/.bin/tsx', ['server/index.ts', '--project', repo], {
    cwd: root, env: { ...process.env, DATA_DIR: dataDir, CLAUDE_BIN: path.join(root, 'scripts/fake-claude.mjs'), CLAUDE_ARGS: '--permission-mode default' },
  })
  const url = await new Promise((res, rej) => {
    let buf = ''
    srv.stdout.on('data', d => { buf += d; const m = buf.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/); if (m) res(m[0]) })
    srv.stderr.on('data', d => process.stderr.write(d))
    setTimeout(() => rej(new Error('servidor no arrancó')), 15000)
  })
  const u = new URL(url); port = u.port; token = u.searchParams.get('token'); base = `http://127.0.0.1:${port}`
  events = new WebSocket(`ws://127.0.0.1:${port}/ws/events?token=${token}`, { origin: base })
  events.on('message', d => { const m = JSON.parse(d); if (m.type === 'state') lastState = m })
  await new Promise(r => events.on('open', r))
})
after(() => { events?.close(); children.forEach(c => c.kill()); srv?.kill(); fs.rmSync(tmp, { recursive: true, force: true }) })

const api = (p, method = 'GET', body, tok = token) => fetch(base + p, { method, headers: { 'x-token': tok, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, what, ms = 6000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(40) } }

function term(id) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${id}?token=${token}`, { origin: base })
  const c = { ws, raw: '', mark: 0 }
  ws.on('message', d => (c.raw += d.toString()))
  ws.on('open', () => ws.send(JSON.stringify({ t: 'attach', cols: 400, rows: 30 })))
  c.since = () => c.raw.slice(c.mark)
  c.waitFor = (re, ms) => until(() => re.test(c.since()), `${re} en ${JSON.stringify(c.since().slice(-250))}`, ms)
  c.say = async line => { await c.waitFor(/❯/); c.mark = c.raw.length; ws.send(JSON.stringify({ t: 'in', d: line + '\r' })) }
  return c
}

/** Cliente MCP: el mismo ejecutable que lanza Claude Code desde .mcp.json, con el entorno que Claude le pasa. */
function mcp(agent) {
  const cfg = JSON.parse(fs.readFileSync(path.join(agent.worktree, '.mcp.json'), 'utf8')).mcpServers.mesa
  const expand = v => v.replace(/\$\{(\w+)\}/g, (_, n) => agent.env[n] ?? '')
  const env = { PATH: process.env.PATH, ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, expand(v)])) }
  const p = spawn(cfg.command, cfg.args, { cwd: agent.worktree, env })
  children.push(p)
  const pending = new Map()
  readline.createInterface({ input: p.stdout }).on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m) })
  let n = 0
  const rpc = (method, params) => new Promise(res => { const id = ++n; pending.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  return {
    rpc,
    async tool(name, args = {}) {
      const r = await rpc('tools/call', { name, arguments: args })
      const text = r.result.content[0].text
      return { error: !!r.result.isError, text, json: r.result.isError ? null : JSON.parse(text) }
    },
  }
}

async function launch(body) {
  const m = await (await api('/api/missions', 'POST', body)).json()
  const l = await api(`/api/missions/${m.id}/launch`, 'POST')
  assert.equal(l.status, 200, await l.clone().text())
  const mm = await l.json()
  const agents = {}
  for (const a of mm.agents) {
    const t = term(a.id)
    await t.waitFor(/FAKE-READY/)
    await t.say('env'); await t.waitFor(/ENVDUMP/)
    const env = JSON.parse(t.since().match(/ENVDUMP (\{.*\})/)[1])
    agents[a.name] = { ...a, t, env }
  }
  return { m: mm, agents }
}

let M1, M2, alice, bob, carol

test('.mcp.json y settings por worktree: servidor mesa registrado, aprobado y permitido, sin secretos en disco', async () => {
  M1 = await launch({ goal: 'M1', mode: 'bandeja', roles: [{ name: 'Alice' }, { name: 'Bob' }], tasks: ['Escribir API', 'Escribir UI'] })
  M2 = await launch({ goal: 'M2', mode: 'nativa', roles: [{ name: 'Carol' }] })
  const A = M1.agents.Alice
  const cfgRaw = fs.readFileSync(path.join(A.worktree, '.mcp.json'), 'utf8')
  const cfg = JSON.parse(cfgRaw).mcpServers.mesa
  assert.equal(cfg.command, 'node')
  assert.equal(cfg.args[0], path.join(root, 'scripts/mesa-mcp.mjs'))
  assert.equal(cfg.env.MESA_URL, base)
  assert.equal(cfg.env.AGENT_ID, '${AGENT_ID}'); assert.equal(cfg.env.MESA_HOOK_TOKEN, '${MESA_HOOK_TOKEN}')
  assert.ok(!cfgRaw.includes(A.env.MESA_HOOK_TOKEN) && !cfgRaw.includes(token), 'secreto escrito en .mcp.json')
  const s = JSON.parse(fs.readFileSync(path.join(A.worktree, '.claude/settings.local.json'), 'utf8'))
  assert.ok(s.enabledMcpjsonServers.includes('mesa')); assert.ok(s.permissions.allow.includes('mcp__mesa__*'))
  assert.equal(git(repo, 'status', '--porcelain'), '', '.mcp.json ensució el repo')
  // cada agente tiene su propio token
  assert.notEqual(A.env.MESA_HOOK_TOKEN, M1.agents.Bob.env.MESA_HOOK_TOKEN)
  assert.ok(!Object.values(A.env).includes(token), 'token de UI en el entorno del agente')
  ;[alice, bob, carol] = [mcp(A), mcp(M1.agents.Bob), mcp(M2.agents.Carol)]
})

test('protocolo MCP: initialize, tools/list con las 6 herramientas, ping, método desconocido', async () => {
  const init = await alice.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.equal(init.result.serverInfo.name, 'mesa')
  const list = await alice.rpc('tools/list')
  assert.deepEqual(list.result.tools.map(t => t.name).sort(), ['claim_task', 'complete_task', 'list_tasks', 'post_status', 'read_inbox', 'send_message'])
  for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object')
  assert.deepEqual((await alice.rpc('ping')).result, {})
  assert.equal((await alice.rpc('no/existe')).error.code, -32601)
  await bob.rpc('initialize', {}); await carol.rpc('initialize', {})
})

test('send_message / read_inbox: entrega por nombre, una sola lectura, difusión y errores claros', async () => {
  const sent = await alice.tool('send_message', { to: 'bob', texto: 'hola Bob, la API está en la rama X' })
  assert.deepEqual([sent.error, sent.json.enviado, sent.json.a], [false, true, 'Bob'])
  assert.deepEqual((await alice.tool('read_inbox')).json, [], 'Alice no debe ver su propio mensaje')
  const inbox = (await bob.tool('read_inbox')).json
  assert.equal(inbox.length, 1); assert.equal(inbox[0].de, 'Alice'); assert.equal(inbox[0].texto, 'hola Bob, la API está en la rama X')
  assert.deepEqual((await bob.tool('read_inbox')).json, [], 'ya leído')

  await bob.tool('send_message', { to: 'todos', texto: 'aviso general' })
  assert.equal((await alice.tool('read_inbox')).json[0].texto, 'aviso general')
  assert.deepEqual((await bob.tool('read_inbox')).json, [], 'la difusión no vuelve al remitente')

  const bad = await alice.tool('send_message', { to: 'Zed', texto: 'x' })
  assert.ok(bad.error); assert.match(bad.text, /Bob/); assert.match(bad.text, /todos/)
  assert.match((await alice.tool('send_message', { to: 'Alice', texto: 'x' })).text, /ti mismo/)
  assert.match((await alice.tool('send_message', { to: 'Bob' })).text, /texto/)
  // el feed de la UI recibe todo
  await until(() => lastState?.hub?.events.some(e => e.kind === 'mensaje' && e.text.includes('Alice → Bob')), 'evento en el feed')
})

test('tareas: la UI las crea; reclamar es exclusivo; solo quien la tomó la completa', async () => {
  const t0 = (await alice.tool('list_tasks')).json
  assert.deepEqual(t0.map(t => [t.id, t.titulo, t.estado]), [[1, 'Escribir API', 'pendiente'], [2, 'Escribir UI', 'pendiente']])
  const add = await api(`/api/missions/${M1.m.id}/tasks`, 'POST', { titles: ['Documentar'] })
  assert.equal((await add.json())[0].id, 3)
  assert.equal((await api(`/api/missions/${M1.m.id}/tasks`, 'POST', { titles: [] })).status, 400)

  assert.equal((await alice.tool('claim_task', { id: 1 })).json.tomada, true)
  const dup = await bob.tool('claim_task', { id: 1 })
  assert.ok(dup.error); assert.match(dup.text, /ya está en curso \(Alice\)/)
  assert.match((await bob.tool('complete_task', { id: 1, resultado: 'robo' })).text, /Solo quien tomó/)
  assert.match((await bob.tool('complete_task', { id: 2, resultado: 'x' })).text, /nadie la ha tomado/)
  assert.match((await alice.tool('claim_task', { id: 99 })).text, /No existe/)
  assert.match((await alice.tool('complete_task', { id: 1 })).text, /resultado/)

  assert.equal((await alice.tool('complete_task', { id: 1, resultado: 'API lista en mesa/x/alice' })).json.completada, true)
  assert.match((await alice.tool('complete_task', { id: 1, resultado: 'otra vez' })).text, /ya estaba completada/)
  const t1 = (await bob.tool('list_tasks')).json.find(t => t.id === 1)
  assert.deepEqual([t1.estado, t1.tomada_por, t1.resultado], ['hecha', 'Alice', 'API lista en mesa/x/alice'])
  await until(() => lastState?.hub?.tasks.find(t => t.missionId === M1.m.id && t.id === 1)?.status === 'hecha', 'UI ve la tarea hecha')
})

test('post_status: visible en el estado de la UI', async () => {
  assert.equal((await bob.tool('post_status', { texto: 'trabajando en la UI' })).json.publicado, true)
  await until(() => lastState?.hub?.statusText[M1.agents.Bob.id]?.text === 'trabajando en la UI', 'estado en la UI')
  assert.ok((await bob.tool('post_status', { texto: 'x'.repeat(501) })).error)
})

test('aislamiento entre misiones e identidad: sin suplantar a otro agente, sin token, sin UI', async () => {
  assert.deepEqual((await carol.tool('list_tasks')).json, [], 'Carol no ve las tareas de otra misión')
  assert.match((await carol.tool('send_message', { to: 'Alice', texto: 'x' })).text, /desconocido/)
  assert.deepEqual((await carol.tool('read_inbox')).json, [])
  const A = M1.agents.Alice, B = M1.agents.Bob
  const call = (agent, tok, tool = 'read_inbox') => fetch(`${base}/agent-api/${tool}?agent=${agent}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: '{}' })
  assert.equal((await call(A.id, A.env.MESA_HOOK_TOKEN)).status, 200)
  assert.equal((await call(B.id, A.env.MESA_HOOK_TOKEN)).status, 401, 'Alice no puede actuar como Bob')
  assert.equal((await call(A.id, token)).status, 401, 'el token de UI no vale en /agent-api')
  assert.equal((await call(A.id, '')).status, 401)
  assert.equal((await api('/api/missions', 'GET', undefined, A.env.MESA_HOOK_TOKEN)).status, 401, 'el token de agente no abre /api')
  assert.equal((await api(`/api/missions/${M1.m.id}/tasks`, 'POST', { titles: ['x'] }, A.env.MESA_HOOK_TOKEN)).status, 401, 'un agente no crea tareas')
  const unk = await call(A.id, A.env.MESA_HOOK_TOKEN, 'borrar_todo')
  assert.equal(unk.status, 400)
})

test('las herramientas de Mesa no pasan por la bandeja de aprobaciones', async () => {
  const t = M1.agents.Alice.t
  await t.say('tool mcp__mesa__send_message default hola')
  await t.waitFor(/TOOL-RUN mcp__mesa__send_message/)
  assert.deepEqual(await (await api('/api/approvals')).json(), [])
})

test('persistencia: el hub queda en data/hub.json', async () => {
  const h = JSON.parse(fs.readFileSync(path.join(dataDir, 'hub.json'), 'utf8'))
  assert.ok(h.messages.length >= 2); assert.ok(h.tasks.some(t => t.status === 'hecha')); assert.ok(Object.keys(h.statusText).length >= 1)
})
