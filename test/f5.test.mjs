// Prueba F5: «Proponer plan» (claude -p sin herramientas, solo propuesta editable). claude falso, sin tokens.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizePlan, parsePlanOutput } from '../server/plan.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-f5-')))
const servers = []
after(() => { servers.forEach(s => s.kill()); fs.rmSync(tmp, { recursive: true, force: true }) })

async function start(name, env = {}) {
  const project = path.join(tmp, name); fs.mkdirSync(project)
  const srv = spawn('node_modules/.bin/tsx', ['server/index.ts', '--project', project], {
    cwd: root, env: { ...process.env, DATA_DIR: path.join(tmp, name + '-data'), CLAUDE_BIN: path.join(root, 'scripts/fake-claude.mjs'), ...env },
  })
  servers.push(srv)
  const url = new URL(await new Promise((res, rej) => {
    let buf = ''
    srv.stdout.on('data', d => { buf += d; const m = buf.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/); if (m) res(m[0]) })
    setTimeout(() => rej(new Error('servidor no arrancó')), 15000)
  }))
  const token = url.searchParams.get('token')
  return { project, api: (p, body, tok = token) => fetch(url.origin + p, { method: body ? 'POST' : 'GET', headers: { 'x-token': tok, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }) }
}

test('proponer plan: devuelve roles y tareas editables, respeta el máximo y no crea nada', async () => {
  const argsFile = path.join(tmp, 'args.jsonl')
  const s = await start('ok', { PLAN_ARGS_FILE: argsFile })
  const r = await s.api('/api/plan', { goal: 'Construir un blog', maxAgents: 2 })
  assert.equal(r.status, 200)
  const plan = await r.json()
  assert.deepEqual(plan.roles.map(x => x.name), ['Backend', 'Frontend'], 'recorta al máximo de agentes (el falso devuelve 3)')
  assert.match(plan.roles[0].instructions, /Construir un blog/, 'la meta llegó al prompt por stdin')
  assert.deepEqual(plan.tasks, ['Diseñar modelo', 'Implementar endpoints'], 'tareas vacías descartadas')
  assert.deepEqual(await (await s.api('/api/missions')).json(), [], 'proponer no crea misiones')

  const call = JSON.parse(fs.readFileSync(argsFile, 'utf8').trim().split('\n').pop())
  const a = call.args, i = a.indexOf('--tools')
  assert.ok(a.includes('-p') && a.includes('--no-session-persistence'))
  assert.equal(a[i + 1], '', 'el planificador debe correr sin herramientas')
  assert.ok(a.includes('--max-budget-usd') && a.includes('--json-schema'))
  assert.ok(!a.some(x => /dangerously|bypass/i.test(x)), 'flag de bypass')
  assert.ok(call.cwd.includes('mesa-plan-') && !call.cwd.startsWith(s.project), 'corre en una carpeta vacía, no en el proyecto')
  assert.ok(!fs.existsSync(call.cwd), 'la carpeta temporal se elimina')
})

test('proponer plan: validación, autenticación y fallos de Claude llegan como error claro', async () => {
  const s = await start('val')
  assert.equal((await s.api('/api/plan', { goal: '', maxAgents: 2 })).status, 400)
  assert.equal((await s.api('/api/plan', { goal: 'x', maxAgents: 99 })).status, 400)
  assert.equal((await s.api('/api/plan', { goal: 'x' }, 'mal')).status, 401)

  const f = await start('fail', { FAKE_PLAN_FAIL: '1' })
  const r = await f.api('/api/plan', { goal: 'x' })
  assert.equal(r.status, 502); assert.match((await r.json()).error, /fallo simulado/)

  const bad = await start('bad', { FAKE_PLAN_RAW: 'esto no es json' })
  assert.equal((await bad.api('/api/plan', { goal: 'x' })).status, 502)
  const empty = await start('empty', { FAKE_PLAN_RAW: '{"roles":[],"tasks":["a"]}' })
  assert.equal((await empty.api('/api/plan', { goal: 'x' })).status, 502)
})

test('sanitizePlan: no confía en el modelo (duplicados, tamaños, campos extra como permisos)', () => {
  const p = sanitizePlan({
    roles: [{ name: 'A', instructions: 'x'.repeat(9000), allow: ['Bash'], rules: { allow: ['Bash'] } }, { name: 'a', instructions: 'dup' }, { name: ' ', instructions: 'sin nombre' }, { name: 'N'.repeat(100), instructions: 'y' }],
    tasks: ['t'.repeat(900), '', null, 5],
    permissions: { allow: ['Bash'] },
  }, 5)
  assert.equal(p.roles.length, 2)
  assert.equal(p.roles[0].instructions.length, 4000); assert.equal(p.roles[1].name.length, 40)
  assert.deepEqual(Object.keys(p.roles[0]).sort(), ['instructions', 'name'], 'ningún permiso viaja en el plan')
  assert.deepEqual(Object.keys(p).sort(), ['roles', 'tasks'])
  assert.equal(p.tasks[0].length, 500); assert.deepEqual(p.tasks.slice(1), ['5'])
  assert.throws(() => sanitizePlan({ roles: [] }, 3), /ningún rol/)
  assert.throws(() => parsePlanOutput('no json'), /no es JSON/)
  assert.deepEqual(parsePlanOutput(JSON.stringify({ structured_output: { roles: [], tasks: [] } })), { roles: [], tasks: [] })
})
