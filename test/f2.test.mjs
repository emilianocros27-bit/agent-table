// Prueba F2: misiones, roles y worktrees git reales. claude falso, sin tokens.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-f2-')))
const repo = path.join(tmp, 'repo')
const dataDir = path.join(tmp, 'data')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
let srv, base, token, port

before(async () => {
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), 'hola\n')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  srv = spawn('node_modules/.bin/tsx', ['server/index.ts', '--project', repo], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, CLAUDE_BIN: path.join(root, 'scripts/fake-claude.mjs'), CLAUDE_ARGS: '--permission-mode default' },
  })
  const url = await new Promise((res, rej) => {
    let buf = ''
    srv.stdout.on('data', d => { buf += d; const m = buf.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/); if (m) res(m[0]) })
    srv.stderr.on('data', d => process.stderr.write(d))
    setTimeout(() => rej(new Error('servidor no arrancó')), 15000)
  })
  const u = new URL(url); port = u.port; token = u.searchParams.get('token'); base = `http://127.0.0.1:${port}`
})
after(() => { srv?.kill(); fs.rmSync(tmp, { recursive: true, force: true }) })

const api = (p, method = 'GET', body) => fetch(base + p, { method, headers: { 'x-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
const json = async r => r.json()

function readTerm(id) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${id}?token=${token}`, { origin: base })
  const c = { ws, raw: '' }
  ws.on('message', d => (c.raw += d.toString()))
  ws.on('open', () => ws.send(JSON.stringify({ t: 'attach', cols: 200, rows: 30 })))
  c.waitFor = (re, ms = 5000) => new Promise((res, rej) => {
    const t0 = Date.now()
    const i = setInterval(() => { if (re.test(c.raw)) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error(`timeout ${re}: ${JSON.stringify(c.raw.slice(-300))}`)) } }, 30)
  })
  return c
}

let mission

test('validación: meta vacía, roles > máximo, nombres repetidos, máximo fuera de rango', async () => {
  const bad = [
    { goal: '', roles: [{ name: 'A' }] },
    { goal: 'x', roles: [] },
    { goal: 'x', maxAgents: 1, roles: [{ name: 'A' }, { name: 'B' }] },
    { goal: 'x', roles: [{ name: 'A' }, { name: 'a' }] },
    { goal: 'x', maxAgents: 99, roles: [{ name: 'A' }] },
  ]
  for (const b of bad) assert.equal((await api('/api/missions', 'POST', b)).status, 400, JSON.stringify(b))
})

test('crear y lanzar: un worktree + rama por agente, rol y variables llegan al proceso', async () => {
  mission = await json(await api('/api/missions', 'POST', {
    goal: 'Construir X',
    maxAgents: 3,
    roles: [{ name: 'Backend', instructions: 'Haz la API' }, { name: '../../etc Frontend', instructions: 'Haz la UI' }],
  }))
  assert.equal(mission.status, 'borrador')
  const l = await api(`/api/missions/${mission.id}/launch`, 'POST')
  assert.equal(l.status, 200)
  mission = await json(l)
  assert.equal(mission.status, 'activa')
  assert.equal(mission.agents.length, 2)

  const wts = git(repo, 'worktree', 'list', '--porcelain')
  for (const a of mission.agents) {
    assert.ok(wts.includes(a.worktree), `falta worktree ${a.worktree}`)
    assert.ok(a.worktree.startsWith(path.join(repo, '.mesa', 'worktrees', mission.id) + path.sep), 'worktree fuera de .mesa (¿slug malo?)')
    assert.match(a.branch, /^mesa\/[\w]+\/[a-z0-9-]+$/)
    assert.ok(git(repo, 'branch', '--list', a.branch).includes(a.branch))
  }
  assert.notEqual(mission.agents[0].worktree, mission.agents[1].worktree)

  for (const a of mission.agents) {
    const c = readTerm(a.id)
    await c.waitFor(/FAKE-ARGS/)
    const line = c.raw.split('\n').find(x => x.includes('FAKE-ARGS'))
    assert.ok(line.includes('--append-system-prompt'), 'falta --append-system-prompt')
    assert.ok(line.includes(a.role) && line.includes('Construir X'), 'el prompt no trae rol y meta')
    assert.ok(line.includes(`cwd=${a.worktree}`), `cwd incorrecto: ${line}`)
    assert.ok(line.includes(`mission=${mission.id}`), 'falta MISSION_ID')
    assert.ok(!/dangerously|bypassPermissions/.test(line), 'flag prohibido presente')
    c.ws.close()
  }
  assert.ok(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8').includes('.mesa/'))
  assert.equal(git(repo, 'status', '--porcelain'), '', 'el repo principal quedó ensuciado')
  assert.equal((await api(`/api/missions/${mission.id}/launch`, 'POST')).status, 409, 'relanzar debe fallar')
  // persistido en disco
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'missions.json'), 'utf8'))[0].id, mission.id)
})

test('aislamiento: un agente escribe en su worktree y el otro no lo ve', async () => {
  const [a, b] = mission.agents
  fs.writeFileSync(path.join(a.worktree, 'solo-a.txt'), 'a')
  assert.ok(!fs.existsSync(path.join(b.worktree, 'solo-a.txt')))
  assert.ok(!fs.existsSync(path.join(repo, 'solo-a.txt')))
})

test('detener un agente y luego la misión', async () => {
  const [a, b] = mission.agents
  assert.equal((await api(`/api/agents/${a.id}/stop`, 'POST')).status, 200)
  await new Promise(r => setTimeout(r, 600))
  let list = await json(await api('/api/agents'))
  assert.equal(list.find(x => x.id === a.id).state, 'terminado')
  assert.equal(list.find(x => x.id === b.id).state, 'activo')
  assert.equal((await api(`/api/missions/${mission.id}/cleanup`, 'POST', {})).status, 409, 'no limpia con la misión activa')
  mission = await json(await api(`/api/missions/${mission.id}/stop`, 'POST'))
  assert.equal(mission.status, 'detenida')
  await new Promise(r => setTimeout(r, 600))
  list = await json(await api('/api/agents'))
  assert.ok(list.every(x => x.state === 'terminado'))
})

test('limpieza: conserva trabajo sin commitear y ramas con commits; force solo con permiso', async () => {
  const [a, b] = mission.agents
  // a: cambios sin commitear (solo-a.txt). b: un commit propio.
  fs.writeFileSync(path.join(b.worktree, 'b.txt'), 'b')
  git(b.worktree, 'add', '.')
  git(b.worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'trabajo de b')

  const st = await json(await api(`/api/missions/${mission.id}/worktrees`))
  assert.deepEqual(st.map(x => [x.name, x.dirty, x.ahead]), [['Backend', true, 0], ['../../etc Frontend', false, 1]])

  let res = await json(await api(`/api/missions/${mission.id}/cleanup`, 'POST', {}))
  const ra = res.find(x => x.agentId === a.id), rb = res.find(x => x.agentId === b.id)
  assert.equal(ra.worktree, 'conservado'); assert.match(ra.motivo, /sin commitear/)
  assert.equal(rb.worktree, 'eliminado'); assert.equal(rb.branch, 'conservada'); assert.match(rb.motivo, /1 commit/)
  assert.ok(fs.existsSync(path.join(a.worktree, 'solo-a.txt')), 'se perdió trabajo sin commitear')
  assert.ok(!fs.existsSync(b.worktree))
  assert.ok(git(repo, 'branch', '--list', b.branch).includes(b.branch), 'se borró una rama con commits')

  res = await json(await api(`/api/missions/${mission.id}/cleanup`, 'POST', { force: true }))
  assert.equal(res[0].worktree, 'eliminado'); assert.equal(res[0].branch, 'eliminada')
  assert.ok(!fs.existsSync(a.worktree))
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1, 'quedan worktrees')
  assert.ok(!fs.existsSync(path.join(repo, '.mesa', 'worktrees', mission.id)), 'quedó el directorio de la misión')
})

test('lanzar falla limpio si el proyecto no tiene commits o no es repo', async () => {
  // Segundo servidor sobre carpeta no-git
  const plain = path.join(tmp, 'plain'); fs.mkdirSync(plain)
  const s2 = spawn('node_modules/.bin/tsx', ['server/index.ts', '--project', plain], { cwd: root, env: { ...process.env, DATA_DIR: path.join(tmp, 'data2'), CLAUDE_BIN: path.join(root, 'scripts/fake-claude.mjs') } })
  try {
    const u = new URL(await new Promise(res => { let b = ''; s2.stdout.on('data', d => { b += d; const m = b.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/); if (m) res(m[0]) }) }))
    const h = { 'x-token': u.searchParams.get('token'), 'content-type': 'application/json' }
    const m = await (await fetch(u.origin + '/api/missions', { method: 'POST', headers: h, body: JSON.stringify({ goal: 'x', roles: [{ name: 'A' }] }) })).json()
    const r = await fetch(`${u.origin}/api/missions/${m.id}/launch`, { method: 'POST', headers: { 'x-token': h['x-token'] } })
    assert.equal(r.status, 400)
    assert.match((await r.json()).error, /repositorio git/)
  } finally { s2.kill() }
})
