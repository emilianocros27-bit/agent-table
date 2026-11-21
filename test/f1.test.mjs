// Prueba F1: servidor real + claude falso. Sin gastar tokens.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import xterm from '@xterm/headless'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-f1-')))
let srv, base, token, port

before(async () => {
  srv = spawn('node_modules/.bin/tsx', ['server/index.ts', '--project', project], {
    cwd: root,
    env: { ...process.env, CLAUDE_BIN: path.join(root, 'scripts/fake-claude.mjs'), CLAUDE_ARGS: '' },
  })
  const url = await new Promise((res, rej) => {
    let buf = ''
    srv.stdout.on('data', d => { buf += d; const m = buf.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/); if (m) res(m[0]) })
    srv.stderr.on('data', d => process.stderr.write(d))
    setTimeout(() => rej(new Error('servidor no arrancó')), 15000)
  })
  const u = new URL(url)
  port = u.port; token = u.searchParams.get('token'); base = `http://127.0.0.1:${port}`
})
after(() => srv?.kill())

const api = (p, init = {}) => fetch(base + p, { ...init, headers: { 'x-token': token, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } })

/** Cliente de terminal: acumula los bytes crudos del WebSocket. */
function termClient(id, cols = 100, rows = 30, origin = base) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${id}?token=${token}`, { origin })
  const c = { ws, raw: '', waitFor: (re, ms = 5000) => new Promise((res, rej) => {
    const t0 = Date.now()
    const i = setInterval(() => {
      if (re.test(c.raw)) { clearInterval(i); res() }
      else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error(`timeout esperando ${re}; recibido: ${JSON.stringify(c.raw.slice(-300))}`)) }
    }, 30)
  }) }
  ws.on('message', d => (c.raw += d.toString()))
  c.opened = new Promise((res, rej) => { ws.on('open', () => { ws.send(JSON.stringify({ t: 'attach', cols, rows })); res() }); ws.on('error', rej) })
  return c
}

test('seguridad: sin token, host/origin ajenos y cwd fuera del proyecto', async () => {
  assert.equal((await fetch(base + '/api/agents')).status, 401)
  assert.equal((await fetch(base + '/api/agents', { headers: { 'x-token': 'x'.repeat(48) } })).status, 401)
  assert.equal((await fetch(base + '/api/agents', { headers: { 'x-token': token, origin: 'http://evil.example' } })).status, 403)
  const hostStatus = await new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/agents', headers: { 'x-token': token, host: 'evil.example' } }, m => { m.resume(); res(m.statusCode) })
    r.on('error', rej); r.end()
  })
  assert.equal(hostStatus, 403)
  const out = await api('/api/agents', { method: 'POST', body: JSON.stringify({ cwd: '/tmp' }) })
  assert.equal(out.status, 400)
  const up = await api('/api/agents', { method: 'POST', body: JSON.stringify({ cwd: '..' }) })
  assert.equal(up.status, 400)
  // WebSocket con Origin ajeno rechazado
  await assert.rejects(new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events?token=${token}`, { origin: 'http://evil.example' })
    ws.on('open', res); ws.on('error', rej)
  }))
  // WebSocket sin token rechazado
  await assert.rejects(new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events?token=bad`, { origin: base })
    ws.on('open', res); ws.on('error', rej)
  }))
})

test('PTY real: bytes sin alterar, entrada, resize y reconexión con scrollback', async () => {
  const a = await (await api('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'T1' }) })).json()
  assert.equal(a.state, 'activo')

  const c1 = termClient(a.id, 100, 30)
  await c1.opened
  await c1.waitFor(/FAKE-READY cols=100 rows=30 agent=\w+/)
  // Los bytes de escape, el color truecolor y el unicode llegan idénticos (sin filtrar ni reescribir).
  c1.ws.send(JSON.stringify({ t: 'in', d: 'ansi\r' }))
  const expected = '\x1b[38;2;215;119;87mTRUECOLOR\x1b[0m \x1b[1;4mNEGRITA\x1b[0m \x1b[48;5;196m256\x1b[0m ▐▛███▜▌ áéí ✓ 日本語\r\r\n' // el PTY (ONLCR) convierte \n en \r\n, igual que en cualquier terminal
  await c1.waitFor(/NEGRITA/)
  assert.ok(c1.raw.includes(expected), 'secuencias ANSI/unicode alteradas: ' + JSON.stringify(c1.raw.slice(-200)))

  c1.ws.send(JSON.stringify({ t: 'in', d: 'hola\r' }))
  await c1.waitFor(/eco: hola/)

  c1.ws.send(JSON.stringify({ t: 'resize', cols: 80, rows: 24 }))
  await c1.waitFor(/RESIZE cols=80 rows=24/)

  // Reconexión: nuevo WebSocket, snapshot con el estado de pantalla.
  c1.ws.close()
  const c2 = termClient(a.id, 80, 24)
  await c2.opened
  await c2.waitFor(/RESIZE cols=80 rows=24/)
  const t = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  await new Promise(r => t.write(c2.raw, r))
  const screen = Array.from({ length: t.buffer.active.length }, (_, i) => t.buffer.active.getLine(i)?.translateToString(true)).join('\n')
  assert.match(screen, /FAKE-READY/)
  assert.match(screen, /eco: hola/)
  assert.match(screen, /RESIZE cols=80 rows=24/)

  // Datos en vivo siguen llegando tras reconectar
  c2.ws.send(JSON.stringify({ t: 'in', d: 'permiso\r' }))
  await c2.waitFor(/Do you want to proceed\?/)
  c2.ws.send(JSON.stringify({ t: 'in', d: '1' }))
  await c2.waitFor(/PERMISO-OK/)

  // Cerrar agente
  c2.ws.close()
  assert.equal((await api(`/api/agents/${a.id}`, { method: 'DELETE' })).status, 200)
  const list = await (await api('/api/agents')).json()
  assert.equal(list.find(x => x.id === a.id), undefined)
})

test('eventos: estado terminado cuando el proceso sale', async () => {
  const a = await (await api('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'T2' }) })).json()
  const c = termClient(a.id); await c.opened; await c.waitFor(/FAKE-READY/)
  c.ws.send(JSON.stringify({ t: 'in', d: '\x04' }))
  await c.waitFor(/bye/)
  await new Promise(r => setTimeout(r, 500))
  const list = await (await api('/api/agents')).json()
  assert.equal(list.find(x => x.id === a.id).state, 'terminado')
  c.ws.close()
})
