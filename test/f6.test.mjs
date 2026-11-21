// Prueba F6: coordinador, arranque automático con prompt inicial, tareas dirigidas y resultado final. Sin gastar tokens.
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
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-f6-')))
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
  const expand = v => v.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, n, d) => agent.env[n] ?? d ?? '')
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


let M, coord, ana, beto
const lastArg = a => { const line = a.t.since().split('\n').find(x => x.includes('FAKE-ARGS')); return JSON.parse(line.slice(line.indexOf('[')).split('] cwd=')[0] + ']') }

test('al lanzar, cada agente recibe su prompt inicial como argumento (arranca solo) y el coordinador va primero', async () => {
  const r = await api('/api/missions', 'POST', { goal: 'Hacer un logo', maxAgents: 3, coordinator: true, autoEdits: true, roles: [{ name: 'Ana', instructions: 'Investiga' }, { name: 'Beto', instructions: 'Diseña' }] })
  M = await r.json()
  assert.deepEqual(M.roles.map(x => [x.name, !!x.coordinator]), [['Coordinador', true], ['Ana', false], ['Beto', false]])
  const l = await api(`/api/missions/${M.id}/launch`, 'POST'); assert.equal(l.status, 200, await l.clone().text())
  const mm = await l.json()
  const agents = {}
  for (const a of mm.agents) { const t = term(a.id); await t.waitFor(/FAKE-ARGS/); agents[a.name] = { ...a, t } }
  const argv = n => { const line = agents[n].t.since().split('\n').find(x => x.includes('FAKE-ARGS')); return JSON.parse(line.slice(line.indexOf('['), line.lastIndexOf('] cwd=') + 1)) }
  for (const n of ['Coordinador', 'Ana', 'Beto']) {
    const a = argv(n), i = a.indexOf('--append-system-prompt')
    assert.ok(i >= 0 && a.length === i + 3, `${n}: el prompt inicial debe ser el último argumento posicional`)
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits')
    assert.ok(!a.some(x => /dangerously|bypass/i.test(x)))
  }
  assert.match(argv('Coordinador').at(-1), /cerebro/); assert.match(argv('Coordinador').at(-1), /create_task/); assert.match(argv('Coordinador').at(-1), /Ana, Beto/)
  assert.match(argv('Ana').at(-1), /claim_task/); assert.match(argv('Ana').at(-1), /«Ana»/); assert.match(argv('Ana').at(-1), /Coordinador/); assert.match(argv('Ana').at(-1), /git commit/)
  for (const n of Object.keys(agents)) { await agents[n].t.say('env'); await agents[n].t.waitFor(/ENVDUMP/); agents[n].env = JSON.parse(agents[n].t.since().match(/ENVDUMP (\{.*\})/)[1]) }
  assert.equal(agents.Coordinador.env.MESA_COORDINATOR, '1'); assert.equal(agents.Ana.env.MESA_COORDINATOR, undefined)
  ;[coord, ana, beto] = [mcp(agents.Coordinador), mcp(agents.Ana), mcp(agents.Beto)]
  M.agents = agents
})

test('el coordinador ve las herramientas extra; los trabajadores no', async () => {
  const names = async c => (await c.rpc('tools/list')).result.tools.map(t => t.name)
  assert.ok((await names(coord)).includes('create_task') && (await names(coord)).includes('publish_result'))
  assert.equal((await names(ana)).length, 6); assert.ok(!(await names(ana)).includes('create_task'))
})

test('solo el coordinador crea tareas y publica; los trabajadores reciben error claro', async () => {
  // El servidor MCP del trabajador ni siquiera expone esas herramientas...
  assert.equal((await ana.rpc('tools/call', { name: 'create_task', arguments: { titulo: 'x' } })).error.code, -32602)
  // ...y aunque se salte el MCP y llame a la API con su propio token, el backend lo rechaza.
  for (const [tool, body] of [['create_task', { titulo: 'x' }], ['publish_result', { texto: 'x' }]]) {
    const r = await fetch(`${base}/agent-api/${tool}?agent=${M.agents.Ana.id}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${M.agents.Ana.env.MESA_HOOK_TOKEN}` }, body: JSON.stringify(body) })
    assert.equal(r.status, 400); assert.match((await r.json()).error, /Solo el coordinador/)
  }
  assert.match((await coord.tool('create_task', { titulo: 'x', para: 'Nadie' })).text, /desconocido/)
  assert.ok((await coord.tool('create_task', { titulo: '' })).error)
  const t1 = await coord.tool('create_task', { titulo: 'Investigar logos', para: 'ana' })
  const t2 = await coord.tool('create_task', { titulo: 'Diseñar el logo', para: 'Beto' })
  const t3 = await coord.tool('create_task', { titulo: 'Tarea libre' })
  assert.deepEqual([t1.json.id, t1.json.para, t2.json.para, t3.json.para], [1, 'Ana', 'Beto', null])
  const list = (await ana.tool('list_tasks')).json
  assert.deepEqual(list.map(t => [t.id, t.para, t.estado]), [[1, 'Ana', 'pendiente'], [2, 'Beto', 'pendiente'], [3, null, 'pendiente']])
})

test('una tarea dirigida solo la puede tomar su destinatario; las libres, cualquiera', async () => {
  assert.match((await beto.tool('claim_task', { id: 1 })).text, /dirigida a Ana/)
  assert.equal((await ana.tool('claim_task', { id: 1 })).json.tomada, true)
  assert.equal((await beto.tool('claim_task', { id: 2 })).json.tomada, true)
  assert.equal((await beto.tool('claim_task', { id: 3 })).json.tomada, true, 'las libres las toma cualquiera')
  assert.equal((await ana.tool('complete_task', { id: 1, resultado: 'Referencias en la rama mesa/x/ana' })).json.completada, true)
  await until(() => lastState?.hub?.tasks.find(t => t.missionId === M.id && t.id === 1)?.para === 'Ana', 'la UI ve el destinatario')
})

test('resultado final: lo publica el coordinador y llega a la UI', async () => {
  assert.equal((await coord.tool('publish_result', { texto: 'Logo final listo: RESULTADO.md en la rama del coordinador' })).json.publicado, true)
  await until(() => lastState?.hub?.results?.[M.id]?.text.includes('Logo final listo'), 'resultado en la UI')
  assert.ok((await coord.tool('publish_result', { texto: 'x'.repeat(8001) })).error)
  const h = JSON.parse(fs.readFileSync(path.join(dataDir, 'hub.json'), 'utf8'))
  assert.ok(h.results[M.id].text.includes('Logo final listo'), 'persistido')
})

test('validación: el coordinador cuenta para el máximo; sin autoEdits el modo sigue siendo default', async () => {
  const over = await api('/api/missions', 'POST', { goal: 'x', maxAgents: 2, coordinator: true, roles: [{ name: 'A' }, { name: 'B' }] })
  assert.equal(over.status, 400); assert.match((await over.json()).error, /contando al coordinador/)
  assert.equal((await api('/api/missions', 'POST', { goal: 'x', coordinator: true, roles: [{ name: 'coordinador' }] })).status, 400)
  const m = await (await api('/api/missions', 'POST', { goal: 'Y', roles: [{ name: 'Solo' }] })).json()
  const l = await (await api(`/api/missions/${m.id}/launch`, 'POST')).json()
  const t = term(l.agents[0].id); await t.waitFor(/FAKE-ARGS/)
  assert.match(t.since(), /"--permission-mode","default"/)
  assert.ok(!m.roles.some(r => r.coordinator))
})

test('despertador: un agente inactivo con trabajo pendiente recibe un aviso; solo en misiones con coordinador y sin repetirse', async () => {
  const W = await launch2({ goal: 'Despertar', coordinator: true, roles: [{ name: 'Uma' }, { name: 'Vera' }] })
  const [cw, uma, vera] = [mcp(W.agents.Coordinador), mcp(W.agents.Uma), mcp(W.agents.Vera)]
  await Promise.all([cw.rpc('initialize', {}), uma.rpc('initialize', {}), vera.rpc('initialize', {})])
  // Uma termina un turno (hook Stop => inactivo) sin tener nada que hacer: no debe recibir avisos.
  await W.agents.Uma.t.say('hola'); await W.agents.Uma.t.waitFor(/eco: hola/)
  await sleep(6000)
  assert.ok(!/Tienes mensajes o tareas nuevas/.test(W.agents.Uma.t.since()), 'sin trabajo pendiente no se despierta a nadie')
  // El coordinador le crea una tarea: ahora sí.
  await cw.tool('create_task', { titulo: 'Hacer algo', para: 'Uma' })
  await W.agents.Uma.t.waitFor(/eco: Tienes mensajes o tareas nuevas.*claim_task/, 15000)
  // Cooldown: no se repite enseguida.
  const n = (W.agents.Uma.t.since().match(/Tienes mensajes o tareas nuevas/g) ?? []).length
  await sleep(6000)
  assert.equal((W.agents.Uma.t.since().match(/Tienes mensajes o tareas nuevas/g) ?? []).length, n)
  // Todas las tareas hechas => se despierta al coordinador para integrar y publicar.
  await W.agents.Coordinador.t.say('hola'); await W.agents.Coordinador.t.waitFor(/eco: hola/)
  await uma.tool('claim_task', { id: 1 }); await uma.tool('complete_task', { id: 1, resultado: 'hecho' })
  await W.agents.Coordinador.t.waitFor(/eco: Todas las tareas de la misión están hechas.*publish_result/, 15000)
  // Un mensaje a Vera (inactiva) también la despierta.
  await W.agents.Vera.t.say('hola'); await W.agents.Vera.t.waitFor(/eco: hola/)
  await uma.tool('send_message', { to: 'Vera', texto: 'ayúdame' })
  await W.agents.Vera.t.waitFor(/eco: Tienes mensajes o tareas nuevas.*read_inbox/, 15000)
})

test('despertador: sin coordinador no se envía nada a nadie', async () => {
  const W = await launch2({ goal: 'Sin coord', roles: [{ name: 'P' }, { name: 'Q' }] })
  const [p, q] = [mcp(W.agents.P), mcp(W.agents.Q)]
  await Promise.all([p.rpc('initialize', {}), q.rpc('initialize', {})])
  await W.agents.Q.t.say('hola'); await W.agents.Q.t.waitFor(/eco: hola/)
  await p.tool('send_message', { to: 'Q', texto: 'mensaje' })
  await sleep(8000)
  assert.ok(!/Tienes mensajes/.test(W.agents.Q.t.since()), 'sin coordinador no hay despertador')
})

async function launch2(body) {
  const m = await (await api('/api/missions', 'POST', body)).json()
  const mm = await (await api(`/api/missions/${m.id}/launch`, 'POST')).json()
  const agents = {}
  for (const a of mm.agents) {
    const t = term(a.id); await t.waitFor(/FAKE-ARGS/)
    await t.say('env'); await t.waitFor(/ENVDUMP/)
    agents[a.name] = { ...a, t, env: JSON.parse(t.since().match(/ENVDUMP (\{.*\})/)[1]) }
  }
  return { m: mm, agents }
}
