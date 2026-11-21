import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { WebSocketServer, type WebSocket } from 'ws'
import { PtyManager, isInside } from './pty-manager.js'
import { MissionService, HttpError } from './missions.js'
import { Approvals } from './approvals.js'
import { Hub, ToolError } from './hub.js'
import { evaluate, needsTray } from './rules.js'
import { proposePlan } from './plan.js'
import { Waker } from './wake.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(here, '..')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}

const projectArg = path.resolve(arg('project') ?? process.env.PROJECT_DIR ?? process.cwd())
if (!fs.existsSync(projectArg) || !fs.statSync(projectArg).isDirectory()) {
  console.error(`La carpeta del proyecto no existe: ${projectArg}\nUsa una ruta real: npm start -- --project ~/Desktop/mi-repo`)
  process.exit(1)
}
const projectRoot = fs.realpathSync(projectArg)
const claudeBin = process.env.CLAUDE_BIN ?? 'claude'
const port = Number(arg('port') ?? process.env.PORT ?? 0)
const token = crypto.randomBytes(24).toString('hex')
// Cada agente tiene su propio token (HMAC de su id): sirve solo para sus hooks y herramientas, jamás para decidir aprobaciones ni usar /api.
const hookSecret = crypto.randomBytes(32)
const hookTokenFor = (agentId: string) => crypto.createHmac('sha256', hookSecret).update(agentId).digest('hex')
let actualPort = 0

/** Si git no tiene identidad configurada, los agentes no podrían hacer commit en su rama: se les da una solo a ellos. */
function gitIdentityEnv(): Record<string, string> {
  const has = (k: string) => spawnSync('git', ['config', k], { encoding: 'utf8' }).stdout.trim() !== ''
  if (has('user.name') && has('user.email')) return {}
  return { GIT_AUTHOR_NAME: 'Mesa de Agentes', GIT_AUTHOR_EMAIL: 'mesa@localhost', GIT_COMMITTER_NAME: 'Mesa de Agentes', GIT_COMMITTER_EMAIL: 'mesa@localhost' }
}
const gitEnv = gitIdentityEnv()

/** Entorno para el hijo: sin marcadores de sesión heredados de otro Claude Code. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (/^CLAUDECODE$|^CLAUDE_AGENT_SDK|^CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|ENTRYPOINT)$/.test(k)) continue
    out[k] = v
  }
  return { ...gitEnv, ...out, ...extra }
}

const manager = new PtyManager(projectRoot)
const baseArgs = (process.env.CLAUDE_ARGS ?? '--permission-mode default').split(' ').filter(Boolean)
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(rootDir, 'data'))
const approvals = new Approvals()
manager.on('exit', (id: string) => approvals.dropAgent(id))
const missions = new MissionService(projectRoot, dataDir, manager, () => ({
  command: claudeBin,
  baseArgs,
  env: childEnv({}),
  hookBase: `http://127.0.0.1:${actualPort}`,
  hookTokenFor,
  mcpScript: path.join(rootDir, 'scripts/mesa-mcp.mjs'),
}))
const hub = new Hub(dataDir)
const waker = new Waker(manager, approvals, hub, missions)
const app = Fastify({ logger: false })

let allowedHosts: Set<string>
const allowedOrigins = () => new Set([...allowedHosts].map(h => `http://${h}`))

function tokenOk(t: unknown) {
  if (typeof t !== 'string' || t.length !== token.length) return false
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token))
}

// Anti DNS-rebinding: solo Host local conocido. Anti CSRF: Origin, si viene, debe ser el propio.
app.addHook('onRequest', async (req, reply) => {
  if (!allowedHosts.has(req.headers.host ?? '')) return reply.code(403).send({ error: 'host no permitido' })
  const origin = req.headers.origin
  if (origin && !allowedOrigins().has(origin)) return reply.code(403).send({ error: 'origin no permitido' })
  if (req.url.startsWith('/api/') && !tokenOk(req.headers['x-token'])) return reply.code(401).send({ error: 'token inválido' })
  if (req.url.startsWith('/hook/') || req.url.startsWith('/agent-api/')) {
    const agent = new URL(req.url, 'http://x').searchParams.get('agent') ?? ''
    const given = String(req.headers.authorization ?? '')
    const want = `Bearer ${hookTokenFor(agent)}`
    if (!agent || given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want)))
      return reply.code(401).send({ error: 'token de agente inválido' })
  }
})

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message })
  reply.code(err.statusCode ?? 500).send({ error: err.message })
})

app.get('/api/config', async () => ({ project: projectRoot, defaultMaxAgents: 4 }))
app.get('/api/missions', async () => missions.list())
app.post<{ Body: Record<string, unknown> }>('/api/missions', async req => {
  const m = missions.create(req.body ?? {})
  if (Array.isArray(req.body?.tasks)) hub.addTasks(m.id, req.body.tasks.map(String))
  return m
})
app.post<{ Params: { id: string }; Body: { titles?: unknown } }>('/api/missions/:id/tasks', async req => {
  missions.get(req.params.id)
  if (!Array.isArray(req.body?.titles) || !req.body.titles.length) throw new HttpError(400, 'Indica al menos una tarea')
  return hub.addTasks(req.params.id, req.body.titles.map(String))
})
app.delete<{ Params: { id: string } }>('/api/missions/:id', async req => (missions.deleteDraft(req.params.id), { ok: true }))
app.post<{ Params: { id: string } }>('/api/missions/:id/launch', async req => missions.launch(req.params.id))
app.post<{ Params: { id: string } }>('/api/missions/:id/stop', async req => missions.stop(req.params.id))
app.post<{ Params: { id: string } }>('/api/missions/:id/finish', async req => missions.finish(req.params.id))
app.get<{ Params: { id: string } }>('/api/missions/:id/worktrees', async req => missions.worktrees(req.params.id))
app.post<{ Params: { id: string }; Body: { force?: boolean } }>('/api/missions/:id/cleanup', async req =>
  missions.cleanup(req.params.id, req.body?.force === true))
app.post<{ Body: { goal?: string; maxAgents?: number } }>('/api/plan', async req => {
  const goal = String(req.body?.goal ?? '').trim()
  const max = Number(req.body?.maxAgents ?? 4)
  if (!goal || goal.length > 2000) throw new HttpError(400, 'La meta es obligatoria (máx. 2000 caracteres)')
  if (!Number.isInteger(max) || max < 1 || max > 12) throw new HttpError(400, 'Máximo de agentes entre 1 y 12')
  return proposePlan(goal, max, { command: claudeBin, env: childEnv({}), model: process.env.PLAN_MODEL ?? 'sonnet' })
})
app.get('/api/approvals', async () => approvals.list())
app.post<{ Params: { id: string }; Body: { decision?: string; message?: string } }>('/api/approvals/:id', async (req, reply) => {
  const d = req.body?.decision
  if (d !== 'allow' && d !== 'deny') return reply.code(400).send({ error: 'decision debe ser allow o deny' })
  const message = d === 'deny' ? (req.body?.message?.slice(0, 500) || 'Rechazado por el usuario desde la bandeja') : undefined
  if (!approvals.decide(req.params.id, { behavior: d, message })) return reply.code(404).send({ error: 'la petición ya no está pendiente' })
  return { ok: true }
})

// --- API de herramientas MCP (la llama scripts/mesa-mcp.mjs con el token del agente) ---
app.post<{ Params: { tool: string }; Querystring: { agent?: string }; Body: Record<string, unknown> }>('/agent-api/:tool', async (req, reply) => {
  const ctx = missions.agentContext(req.query.agent ?? '')
  if (!ctx) return reply.code(404).send({ error: 'agente desconocido' })
  try {
    const result = hub.call(req.params.tool, req.body ?? {}, {
      missionId: ctx.mission.id,
      agentId: ctx.agent.id,
      agentName: ctx.agent.name,
      isCoordinator: ctx.mission.roles.find(r => r.name === ctx.agent.role)?.coordinator === true,
      peers: ctx.mission.agents.map(a => ({ id: a.id, name: a.name })),
    })
    return { result }
  } catch (e) {
    if (e instanceof ToolError) return reply.code(400).send({ error: e.message })
    throw e
  }
})

// --- Hooks de Claude Code (los agentes los llaman con el token de hook) ---
const preDecision = (decision: 'allow' | 'deny', reason: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
})
app.post<{ Params: { event: string }; Querystring: { agent?: string } }>('/hook/:event', async (req, reply) => {
  const agentId = req.query.agent ?? ''
  const ctx = missions.agentContext(agentId)
  if (!ctx || !manager.has(agentId)) return reply.code(200).send()
  const body = (req.body ?? {}) as Record<string, any>
  switch (req.params.event) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      approvals.setStatus(agentId, 'trabajando')
      break
    case 'Stop':
      approvals.setStatus(agentId, 'inactivo')
      break
    case 'PermissionRequest':
      approvals.setStatus(agentId, 'esperando aprobación', { via: 'terminal', tool: String(body.tool_name ?? '') })
      break
    case 'Notification':
      if (body.notification_type === 'permission_prompt') approvals.setStatus(agentId, 'esperando aprobación', { via: 'terminal' })
      break
    case 'PreToolUse': {
      if (ctx.mission.mode !== 'bandeja') break
      const tool = String(body.tool_name ?? '')
      const input = (body.tool_input ?? {}) as Record<string, unknown>
      const verdict = evaluate(tool, input, ctx.rules)
      if (verdict === 'deny') return reply.code(200).send(preDecision('deny', 'Denegado por una regla de la misión'))
      if (verdict === 'allow') return reply.code(200).send(preDecision('allow', 'Permitido por una regla de la misión'))
      if (!needsTray(tool, input, body.permission_mode)) break
      const ac = new AbortController()
      reply.raw.on('close', () => !reply.raw.writableEnded && ac.abort())
      const d = await approvals.request(agentId, ctx.mission.id, tool, input, ac.signal)
      if (!d) return reply // conexión cerrada: nadie a quien responder
      return reply.code(200).send(preDecision(d.behavior, d.message ?? (d.behavior === 'allow' ? 'Aprobado desde la bandeja' : 'Rechazado')))
    }
  }
  return reply.code(200).send()
})

app.post<{ Params: { id: string } }>('/api/agents/:id/stop', async req => (missions.stopAgent(req.params.id), { ok: true }))
app.get('/api/agents', async () => manager.list())

app.post<{ Body: { name?: string; cwd?: string } }>('/api/agents', async (req, reply) => {
  const n = manager.list().length + 1
  const id = crypto.randomUUID().slice(0, 8)
  const cwd = req.body?.cwd ? path.resolve(projectRoot, req.body.cwd) : projectRoot
  if (!isInside(projectRoot, cwd)) return reply.code(400).send({ error: 'cwd fuera de la carpeta del proyecto' })
  try {
    return manager.spawn({
      id,
      name: req.body?.name?.slice(0, 40) || `Agente ${n}`,
      cwd,
      command: claudeBin,
      args: baseArgs,
      env: childEnv({ AGENT_ID: id }),
    })
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message })
  }
})

app.delete<{ Params: { id: string } }>('/api/agents/:id', async (req, reply) => {
  if (!manager.has(req.params.id)) return reply.code(404).send({ error: 'no existe' })
  manager.remove(req.params.id)
  return { ok: true }
})

const webDir = path.join(rootDir, 'dist/web')
if (fs.existsSync(webDir)) await app.register(fastifyStatic, { root: webDir })

// --- WebSockets: /ws/term/:id (bytes crudos) y /ws/events (estado de agentes) ---
const wss = new WebSocketServer({ noServer: true })
const eventClients = new Set<WebSocket>()
const snapshot = () =>
  JSON.stringify({ type: 'state', agents: manager.list(), missions: missions.list(), approvals: approvals.list(), statuses: approvals.statuses(), hub: hub.snapshot() })
const pushAgents = () => {
  const msg = snapshot()
  for (const c of eventClients) if (c.readyState === c.OPEN) c.send(msg)
}
manager.on('change', pushAgents)
missions.on('change', pushAgents)
approvals.on('change', pushAgents)
hub.on('change', pushAgents)

app.server.on('upgrade', (req, socket, head) => {
  const reject = (code: number) => {
    socket.write(`HTTP/1.1 ${code} Rechazado\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }
  const url = new URL(req.url ?? '/', 'http://x')
  if (!allowedHosts.has(req.headers.host ?? '')) return reject(403)
  if (!req.headers.origin || !allowedOrigins().has(req.headers.origin)) return reject(403)
  if (!tokenOk(url.searchParams.get('token'))) return reject(401)
  const term = url.pathname.match(/^\/ws\/term\/([\w-]+)$/)
  if (!term && url.pathname !== '/ws/events') return reject(404)
  wss.handleUpgrade(req, socket, head, ws => {
    if (!term) {
      eventClients.add(ws)
      ws.on('close', () => eventClients.delete(ws))
      ws.send(snapshot())
      return
    }
    const id = term[1]
    let attached = false
    ws.on('message', raw => {
      let m: { t?: string; d?: string; cols?: number; rows?: number }
      try {
        m = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (m.t === 'attach' && !attached && m.cols && m.rows) {
        attached = true
        void manager.attach(id, ws, m.cols, m.rows)
      } else if (m.t === 'in' && typeof m.d === 'string') manager.write(id, m.d)
      else if (m.t === 'resize' && m.cols && m.rows) manager.resize(id, m.cols, m.rows)
    })
  })
})

await app.listen({ host: '127.0.0.1', port })
actualPort = (app.server.address() as { port: number }).port
allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`])
console.log(`Mesa de Agentes: http://127.0.0.1:${actualPort}/?token=${token}`)
console.log(`Proyecto: ${projectRoot}`)

const shutdown = () => {
  waker.stop()
  manager.killAll()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
