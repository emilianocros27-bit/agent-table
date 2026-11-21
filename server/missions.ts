import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { JsonStore } from './store.js'
import type { PtyManager } from './pty-manager.js'
import { assertRepoWithCommit, ensureExcluded, git, slug } from './git.js'
import { mergeRules, validateRules, type Rules } from './rules.js'

export interface Role {
  name: string
  instructions: string
  rules: Rules
  /** El «cerebro»: reparte tareas, vigila y publica el resultado final. */
  coordinator?: boolean
}
export type Mode = 'nativa' | 'bandeja'
export interface MissionAgent {
  id: string
  name: string
  role: string
  worktree: string
  branch: string
  baseSha: string
  cleaned?: boolean
}
export type MissionStatus = 'borrador' | 'activa' | 'detenida' | 'terminada'
export interface Mission {
  id: string
  goal: string
  maxAgents: number
  mode: Mode
  /** Lanza con --permission-mode acceptEdits (las ediciones no preguntan; Bash y lo demás sí). */
  autoEdits?: boolean
  rules: Rules
  roles: Role[]
  agents: MissionAgent[]
  status: MissionStatus
  createdAt: number
}
export interface WorktreeStatus {
  agentId: string
  name: string
  branch: string
  exists: boolean
  dirty: boolean
  ahead: number
  active: boolean
}
export interface CleanupResult {
  agentId: string
  worktree: 'eliminado' | 'conservado' | 'ausente'
  branch: 'eliminada' | 'conservada' | '-'
  motivo?: string
}

export class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg)
  }
}

export const COORDINATOR_NAME = 'Coordinador'
export const DEFAULT_MAX_AGENTS = 4

/** Prompt que se envía solo al arrancar cada agente: así empiezan a trabajar sin que el usuario escriba nada. */
export function kickoffPrompt(m: Mission, role: Role, agent: { worktree: string; branch: string }, all: Array<{ name: string; branch: string; coordinator?: boolean }>): string {
  const workers = all.filter(a => !a.coordinator)
  const coord = all.find(a => a.coordinator)
  if (role.coordinator) {
    return [
      'Eres el cerebro de esta misión: repartes el trabajo, vigilas y entregas el resultado final. Empieza ahora, sin esperar al usuario.',
      `Meta: ${m.goal}`,
      `Trabajadores: ${workers.map(w => w.name).join(', ') || '(ninguno)'}.`,
      '1. Llama a list_tasks. Si faltan tareas, créalas con create_task (una por entregable, con el trabajador en «para»). Si ya existen tareas, no las dupliques: envía a cada trabajador con send_message su cometido y qué tareas debe tomar.',
      '2. Vigila: alterna read_inbox, list_tasks y post_status hasta que todas las tareas estén «hecha». No hagas tú el trabajo de los trabajadores.',
      `3. Integra: desde tu worktree usa git para revisar o fusionar sus ramas (${workers.map(w => w.branch).join(', ')}) y redacta RESULTADO.md con el resultado final.`,
      '4. Llama a publish_result con el resumen final y cuéntaselo al usuario en tu terminal.',
    ].join('\n')
  }
  return [
    'Empieza ahora, sin esperar instrucciones del usuario.',
    `1. Llama a list_tasks y reclama con claim_task las tareas dirigidas a «${role.name}» (o las libres que encajen con tu rol).`,
    coord ? `2. Si aún no hay tareas para ti, espera a ${coord.name}: usa post_status y read_inbox cada cierto tiempo hasta recibir tu cometido.` : '2. Si no hay tareas libres para ti, usa read_inbox para ver si otro agente te pide algo.',
    `3. Trabaja en tu worktree (${agent.worktree}). Al terminar: git add y git commit en tu rama (${agent.branch}), llama a complete_task con un resultado concreto (qué hiciste y en qué archivos)${coord ? ` y avisa a ${coord.name} con send_message` : ''}.`,
    `Si necesitas algo de otro agente (${all.filter(a => a.name !== role.name).map(a => a.name).join(', ') || 'ninguno'}), pídeselo con send_message.`,
  ].join('\n')
}
export const HARD_MAX_AGENTS = 12

export interface LaunchEnv {
  command: string
  baseArgs: string[]
  env: Record<string, string>
  /** Base de los hooks, p. ej. http://127.0.0.1:1234 */
  hookBase: string
  /** Token propio de cada agente: sirve solo para sus hooks y su API de herramientas (nunca para decidir aprobaciones). */
  hookTokenFor: (agentId: string) => string
  /** Ruta absoluta de scripts/mesa-mcp.mjs */
  mcpScript: string
}

const PROMPT_TOOL_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|WebSearch|mcp__.*'

/** Contenido de .claude/settings.local.json del worktree: hooks hacia el backend y reglas de permisos nativas. */
export function buildAgentSettings(hookBase: string, agentId: string, mode: Mode, rules: Rules, existing: Record<string, any> = {}) {
  const hook = (event: string, timeout: number) => ({
    type: 'http',
    url: `${hookBase}/hook/${event}?agent=${agentId}`,
    headers: { Authorization: 'Bearer $MESA_HOOK_TOKEN' },
    allowedEnvVars: ['MESA_HOOK_TOKEN'],
    timeout,
  })
  const events: Array<[string, number, string?]> = [
    ['UserPromptSubmit', 10],
    ['PermissionRequest', 10], // solo avisa; en modo nativa y bandeja nunca decide
    ['Notification', 10],
    ['PostToolUse', 10],
    ['PostToolUseFailure', 10],
    ['Stop', 10],
  ]

  if (mode === 'bandeja') events.push(['PreToolUse', 600, PROMPT_TOOL_MATCHER])
  const hooks: Record<string, unknown[]> = { ...(existing.hooks ?? {}) }
  for (const [ev, timeout, matcher] of events) {
    hooks[ev] = [...(hooks[ev] ?? []), { ...(matcher ? { matcher } : {}), hooks: [hook(ev, timeout)] }]
  }
  const perm = existing.permissions ?? {}
  const union = (a: string[] = [], b: string[]) => [...new Set([...a, ...b])]
  return {
    ...existing,
    hooks,
    // Las herramientas de Mesa solo hablan con el backend; el servidor MCP se aprueba aquí (sin diálogo) y sus herramientas se permiten.
    enabledMcpjsonServers: [...new Set([...(existing.enabledMcpjsonServers ?? []), 'mesa'])],
    permissions: { ...perm, allow: union(perm.allow, [...rules.allow, MESA_TOOLS_RULE]), deny: union(perm.deny, rules.deny) },
  }
}

export const MESA_TOOLS_RULE = 'mcp__mesa__*'

/** .mcp.json del worktree: registra el servidor MCP de Mesa; el token llega por variable de entorno, no escrito en el archivo. */
export function buildMcpConfig(mcpScript: string, hookBase: string, existing: Record<string, any> = {}) {
  return {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      mesa: {
        command: 'node',
        args: [mcpScript],
        env: { MESA_URL: hookBase, AGENT_ID: '${AGENT_ID}', MESA_HOOK_TOKEN: '${MESA_HOOK_TOKEN}', MESA_COORDINATOR: '${MESA_COORDINATOR:-0}' },
      },
    },
  }
}

/** Sustituye --permission-mode por `mode` (nunca bypass). */
export function withMode(args: string[], mode?: 'acceptEdits'): string[] {
  if (!mode) return args
  const out = [...args]
  const i = out.indexOf('--permission-mode')
  if (i >= 0) out[i + 1] = mode
  else out.push('--permission-mode', mode)
  return out
}

export class MissionService extends EventEmitter {
  private store: JsonStore<Mission[]>
  private missions: Mission[]

  constructor(private project: string, dataDir: string, private manager: PtyManager, private launchEnv: () => LaunchEnv) {
    super()
    this.store = new JsonStore<Mission[]>(dataDir, 'missions.json', [])
    this.missions = this.store.load()
    // Los PTYs no sobreviven a un reinicio del servidor.
    for (const m of this.missions) if (m.status === 'activa') m.status = 'detenida'
    this.persist()
  }

  private persist() {
    this.store.save(this.missions)
    this.emit('change')
  }

  list() {
    return this.missions
  }
  get(id: string) {
    const m = this.missions.find(x => x.id === id)
    if (!m) throw new HttpError(404, 'misión inexistente')
    return m
  }

  create(input: { goal?: unknown; maxAgents?: unknown; roles?: unknown; mode?: unknown; rules?: unknown; coordinator?: unknown; autoEdits?: unknown }): Mission {
    const goal = String(input.goal ?? '').trim()
    const mode = (input.mode ?? 'nativa') as Mode
    if (mode !== 'nativa' && mode !== 'bandeja') throw new HttpError(400, 'Modo inválido (nativa o bandeja)')
    let missionRules: Rules
    try {
      const r = (input.rules ?? {}) as { allow?: unknown; deny?: unknown }
      missionRules = { allow: validateRules(r.allow, 'Reglas allow de la misión'), deny: validateRules(r.deny, 'Reglas deny de la misión') }
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
    if (!goal || goal.length > 2000) throw new HttpError(400, 'La meta es obligatoria (máx. 2000 caracteres)')
    const maxAgents = input.maxAgents === undefined ? DEFAULT_MAX_AGENTS : Number(input.maxAgents)
    if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > HARD_MAX_AGENTS)
      throw new HttpError(400, `El máximo de agentes debe ser un entero entre 1 y ${HARD_MAX_AGENTS}`)
    if (!Array.isArray(input.roles) || input.roles.length < 1) throw new HttpError(400, 'Define al menos un rol')
    const withCoordinator = input.coordinator === true
    const total = input.roles.length + (withCoordinator ? 1 : 0)
    if (total > maxAgents) throw new HttpError(400, `Hay más agentes (${total}${withCoordinator ? ', contando al coordinador' : ''}) que el máximo (${maxAgents})`)
    const names = new Set<string>(withCoordinator ? [COORDINATOR_NAME.toLowerCase()] : [])
    const roles: Role[] = input.roles.map((r: { name?: unknown; instructions?: unknown; rules?: { allow?: unknown; deny?: unknown } }) => {
      const name = String(r?.name ?? '').trim()
      const instructions = String(r?.instructions ?? '').trim()
      if (!name || name.length > 40) throw new HttpError(400, 'Cada rol necesita un nombre (máx. 40 caracteres)')
      if (instructions.length > 4000) throw new HttpError(400, `Instrucciones demasiado largas en «${name}»`)
      if (names.has(name.toLowerCase())) throw new HttpError(400, `Nombre de rol repetido: ${name}`)
      names.add(name.toLowerCase())
      let rr: Rules
      try {
        rr = { allow: validateRules(r?.rules?.allow, `Reglas allow de «${name}»`), deny: validateRules(r?.rules?.deny, `Reglas deny de «${name}»`) }
      } catch (e) {
        throw new HttpError(400, (e as Error).message)
      }
      return { name, instructions, rules: rr }
    })
    if (withCoordinator) roles.unshift({ name: COORDINATOR_NAME, instructions: '', rules: { allow: [], deny: [] }, coordinator: true })
    const m: Mission = { id: crypto.randomUUID().slice(0, 8), goal, maxAgents, mode, autoEdits: input.autoEdits === true, rules: missionRules, roles, agents: [], status: 'borrador', createdAt: Date.now() }
    this.missions.push(m)
    this.persist()
    return m
  }

  deleteDraft(id: string) {
    const m = this.get(id)
    if (m.status === 'activa') throw new HttpError(409, 'Detén la misión antes de borrarla')
    if (m.agents.some(a => !a.cleaned)) throw new HttpError(409, 'La misión aún tiene worktrees; límpialos primero')
    this.missions = this.missions.filter(x => x !== m)
    this.persist()
  }

  async launch(id: string): Promise<Mission> {
    const m = this.get(id)
    if (m.status !== 'borrador') throw new HttpError(409, `La misión está ${m.status}; solo se lanzan borradores`)
    let head: string
    try {
      head = await assertRepoWithCommit(this.project)
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
    await ensureExcluded(this.project, ['.mesa/', '.claude/settings.local.json', '.mcp.json'])
    const { command, baseArgs, env, hookBase, hookTokenFor, mcpScript } = this.launchEnv()
    const created: MissionAgent[] = []
    const started: string[] = []
    try {
      const used = new Set<string>()
      const plan = m.roles.map(r => {
        let s = slug(r.name)
        for (let n = 2; used.has(s); n++) s = `${slug(r.name)}-${n}`
        used.add(s)
        return { name: r.name, slug: s, branch: `mesa/${m.id}/${s}`, coordinator: r.coordinator }
      })
      for (const [idx, role] of m.roles.entries()) {
        const s = plan[idx].slug
        const agentId = crypto.randomUUID().slice(0, 8)
        const branch = plan[idx].branch
        const wt = path.join(this.project, '.mesa', 'worktrees', m.id, s)
        fs.mkdirSync(path.dirname(wt), { recursive: true })
        await git(this.project, 'worktree', 'add', '-b', branch, wt, 'HEAD')
        const agent: MissionAgent = { id: agentId, name: role.name, role: role.name, worktree: wt, branch, baseSha: head }
        created.push(agent)
        const file = path.join(wt, '.claude', 'settings.local.json')
        let existing: Record<string, unknown> = {}
        try {
          existing = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch {
          /* no existe o no es JSON */
        }
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify(buildAgentSettings(hookBase, agentId, m.mode, mergeRules(m.rules, role.rules), existing), null, 2))
        const mcpFile = path.join(wt, '.mcp.json')
        let mcpExisting: Record<string, unknown> = {}
        try {
          mcpExisting = JSON.parse(fs.readFileSync(mcpFile, 'utf8'))
        } catch {
          /* no existe */
        }
        fs.writeFileSync(mcpFile, JSON.stringify(buildMcpConfig(mcpScript, hookBase, mcpExisting), null, 2))
        const sysPrompt = [
          `Eres «${role.name}», uno de ${m.roles.length} agentes de Claude Code que trabajan en paralelo en una misma misión.`,
          `Meta de la misión: ${m.goal}`,
          role.instructions && `Tus instrucciones: ${role.instructions}`,
          `Trabajas en tu propio git worktree (rama ${branch}); no toques los worktrees de otros agentes.`,
        ].filter(Boolean).join('\n')
        this.manager.spawn({
          id: agentId,
          name: role.name,
          cwd: wt,
          command,
          args: [...withMode(baseArgs, m.autoEdits ? 'acceptEdits' : undefined), '--append-system-prompt', sysPrompt, kickoffPrompt(m, role, agent, plan)],
          env: { ...env, AGENT_ID: agentId, MISSION_ID: m.id, ...(role.coordinator ? { MESA_COORDINATOR: '1' } : {}), MESA_HOOK_TOKEN: hookTokenFor(agentId), MESA_URL: hookBase },
          missionId: m.id,
          role: role.name,
        })
        started.push(agentId)
      }
    } catch (e) {
      for (const a of started) this.manager.remove(a)
      for (const a of created) await this.removeWorktree(a, true).catch(() => {})
      throw new HttpError(500, `No se pudo lanzar la misión: ${(e as Error).message}`)
    }
    m.agents = created
    m.status = 'activa'
    this.persist()
    return m
  }

  /** Misión, agente y reglas efectivas (misión + rol) de un agente; para decidir en los hooks. */
  agentContext(agentId: string) {
    for (const m of this.missions) {
      const a = m.agents.find(x => x.id === agentId)
      if (a) return { mission: m, agent: a, rules: mergeRules(m.rules, m.roles.find(r => r.name === a.role)?.rules, { allow: [MESA_TOOLS_RULE] }) }
    }
    return null
  }

  stopAgent(agentId: string) {
    if (!this.manager.has(agentId)) throw new HttpError(404, 'agente inexistente')
    this.manager.kill(agentId)
  }

  /** Detiene todos los agentes; conserva worktrees. */
  stop(id: string): Mission {
    const m = this.get(id)
    for (const a of m.agents) if (this.manager.has(a.id)) this.manager.kill(a.id)
    if (m.status === 'activa') m.status = 'detenida'
    this.persist()
    return m
  }

  finish(id: string): Mission {
    const m = this.stop(id)
    m.status = 'terminada'
    this.persist()
    return m
  }

  async worktrees(id: string): Promise<WorktreeStatus[]> {
    const m = this.get(id)
    return Promise.all(
      m.agents.filter(a => !a.cleaned).map(async a => {
        const exists = fs.existsSync(a.worktree)
        let dirty = false
        let ahead = 0
        if (exists) {
          dirty = (await git(a.worktree, 'status', '--porcelain').catch(() => 'x')) !== ''
          ahead = Number(await git(a.worktree, 'rev-list', '--count', `${a.baseSha}..HEAD`).catch(() => '0'))
        }
        return { agentId: a.id, name: a.name, branch: a.branch, exists, dirty, ahead, active: this.manager.isActive(a.id) }
      }),
    )
  }

  private async removeWorktree(a: MissionAgent, force: boolean) {
    if (fs.existsSync(a.worktree)) await git(this.project, 'worktree', 'remove', ...(force ? ['--force'] : []), a.worktree)
    await git(this.project, 'worktree', 'prune').catch(() => {})
  }

  /**
   * Limpia worktrees. Nunca descarta trabajo sin permiso explícito:
   * - con cambios sin commitear: se conserva salvo force=true;
   * - rama con commits propios: se conserva siempre (se puede fusionar a mano).
   */
  async cleanup(id: string, force: boolean): Promise<CleanupResult[]> {
    const m = this.get(id)
    if (m.status === 'activa') throw new HttpError(409, 'Detén la misión antes de limpiar')
    const results: CleanupResult[] = []
    for (const st of await this.worktrees(id)) {
      const a = m.agents.find(x => x.id === st.agentId)!
      if (st.active) {
        results.push({ agentId: a.id, worktree: 'conservado', branch: 'conservada', motivo: 'el agente sigue activo' })
        continue
      }
      let wtResult: CleanupResult['worktree'] = 'ausente'
      let motivo: string | undefined
      if (st.exists) {
        if (st.dirty && !force) {
          results.push({ agentId: a.id, worktree: 'conservado', branch: 'conservada', motivo: 'tiene cambios sin commitear' })
          continue
        }
        try {
          await this.removeWorktree(a, force)
          wtResult = 'eliminado'
        } catch (e) {
          results.push({ agentId: a.id, worktree: 'conservado', branch: 'conservada', motivo: (e as Error).message })
          continue
        }
      }
      let br: CleanupResult['branch'] = 'conservada'
      if (st.ahead === 0) {
        br = await git(this.project, 'branch', '-D', a.branch).then(() => 'eliminada' as const, () => 'conservada' as const)
      } else motivo = `la rama ${a.branch} tiene ${st.ahead} commit(s) propios; se conserva`
      a.cleaned = true
      results.push({ agentId: a.id, worktree: wtResult, branch: br, motivo })
    }
    const base = path.join(this.project, '.mesa', 'worktrees', m.id)
    try {
      fs.rmdirSync(base)
    } catch {
      /* no vacío o inexistente */
    }
    this.persist()
    return results
  }
}
