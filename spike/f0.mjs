// F0: spike de hooks. Uso: node spike/f0.mjs <nativa|allow|deny>
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import pty from 'node-pty'

const mode = process.argv[2] || 'nativa'
const root = process.env.F0_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'f0-'))
const repo = path.join(root, `repo-${mode}`)
fs.mkdirSync(repo, { recursive: true })
execSync('git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init', { cwd: repo })

const token = crypto.randomBytes(16).toString('hex')
const t0 = Date.now()
const ev = []
const log = (k, d = {}) => { const e = { t: ((Date.now() - t0) / 1000).toFixed(1), k, ...d }; ev.push(e); console.log(JSON.stringify(e)) }

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => (body += c))
  req.on('end', () => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); log('hook-401', { url: req.url }); return }
    let j = {}; try { j = JSON.parse(body) } catch {}
    if (req.url === '/hook/permission') {
      log('PermissionRequest', { tool: j.tool_name, input: j.tool_input, mode: j.permission_mode })
      if (mode === 'nativa') { res.writeHead(200).end(); log('respondido-vacio'); return }
      setTimeout(() => {
        const decision = mode === 'allow'
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: 'Rechazado por el usuario desde la bandeja' }
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }))
        log('decision-enviada', { behavior: decision.behavior })
      }, 3000)
      return
    }
    if (req.url === '/hook/pre') {
      log('PreToolUse', { tool: j.tool_name })
      setTimeout(() => {
        const allow = mode === 'pre-allow'
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: 'Decision desde la bandeja' } }))
        log('decision-enviada', { behavior: allow ? 'allow' : 'deny' })
      }, 3000)
      return
    }
    log(req.url.replace('/hook/', ''), { keys: Object.keys(j), notification_type: j.notification_type, message: j.message, last: (j.last_assistant_message || '').slice(0, 80) })
    res.writeHead(200).end()
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const h = p => [{ hooks: [{ type: 'http', url: `http://127.0.0.1:${port}/hook/${p}`, headers: { Authorization: 'Bearer $MESA_TOKEN' }, allowedEnvVars: ['MESA_TOKEN'], timeout: 120 }] }]
fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
fs.writeFileSync(path.join(repo, '.claude/settings.local.json'), JSON.stringify({ hooks: { ...(mode.startsWith('pre') ? { PreToolUse: [{ matcher: 'Bash', hooks: h('pre')[0].hooks }] } : { PermissionRequest: h('permission') }), Notification: h('notification'), Stop: h('stop') } }, null, 2))

const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/i.test(k)))
const env = { ...clean, TERM: 'xterm-256color', COLORTERM: 'truecolor', MESA_TOKEN: token, AGENT_ID: 'a1', MISSION_ID: 'm1' }
const term = pty.spawn('claude', ['--model', 'haiku', '--permission-mode', 'default', '--append-system-prompt', 'Eres el agente a1.'], { name: 'xterm-256color', cols: 120, rows: 40, cwd: repo, env })
let raw = ''
term.onData(d => (raw += d))
const strip = s => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
let seen = 0
const has = re => re.test(strip(raw).slice(seen))
const mark = () => { seen = strip(raw).length }

let step = 'trust', stepAt = Date.now(), done = false
const to = (s) => { step = s; stepAt = Date.now(); log('step', { s }) }
const tick = setInterval(() => {
  if (!ev.some(e => e.k === 'DIALOGO-NATIVO-PTY') && /Doyouwanttoproceed/.test(strip(raw).replace(/\s+/g, ''))) log('DIALOGO-NATIVO-PTY', { decisionYaEnviada: ev.some(e => e.k === 'decision-enviada') })
  const age = Date.now() - stepAt
  if (step === 'trust') {
    if (has(/trust/i)) { log('dialogo-confianza-visto'); mark(); term.write('\x1b[B'); setTimeout(() => term.write('\r'), 1200); to('wait-prompt') }
    else if (has(/❯|> /) && age > 4000) { log('sin-dialogo-confianza'); mark(); to('send') }
  } else if (step === 'wait-prompt') {
    if (false) { log('dialogo-mcp'); mark(); term.write('\r') }
    if (age > 5000) { mark(); to('send') }
  } else if (step === 'send') {
    term.write('Ejecuta exactamente este comando bash y nada mas: echo hola > salida.txt')
    setTimeout(() => term.write('\r'), 400)
    mark(); to('wait-dialog')
  } else if (step === 'wait-dialog') {
    if (false) {
      log('DIALOGO-NATIVO-VISIBLE', { tras_ms: age })
      if (mode === 'nativa') { mark(); term.write('\r'); to('wait-stop') }
      else { to('wait-stop') } // en bandeja no deberia verse
    } else if (ev.some(e => e.k === 'decision-enviada') || (mode === 'nativa' && ev.some(e => e.k === 'DIALOGO-NATIVO-PTY'))) { if (mode === 'nativa') { term.write('\r') } to('wait-stop') }
    if (age > 60000) { log('timeout-wait-dialog'); finish() }
  } else if (step === 'wait-stop') {
    if (ev.some(e => e.k === 'stop')) setTimeout(finish, 1500)
    if (age > 60000) { log('timeout-stop'); finish() }
  }
}, 500)
setTimeout(() => { log('timeout-global'); finish() }, 150000)

function finish() {
  if (done) return; done = true
  clearInterval(tick)
  const dialogSeen = ev.some(e => e.k === 'DIALOGO-NATIVO-PTY')
  const file = fs.existsSync(path.join(repo, 'salida.txt'))
  log('RESUMEN', { mode, dialogoNativoEnPTY: dialogSeen, archivoCreado: file, eventos: [...new Set(ev.map(e => e.k))] })
  fs.writeFileSync(path.join(root, `raw-${mode}.txt`), raw)
  term.kill(); server.close(); setTimeout(() => process.exit(0), 300)
}
