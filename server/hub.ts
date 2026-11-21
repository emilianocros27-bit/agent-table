import { EventEmitter } from 'node:events'
import { JsonStore } from './store.js'

export interface Msg {
  id: number
  missionId: string
  from: string
  fromName: string
  /** id de agente o 'todos' */
  to: string
  toName: string
  text: string
  at: number
  readBy: string[]
}
export type TaskStatus = 'pendiente' | 'en curso' | 'hecha'
export interface Task {
  id: number
  missionId: string
  title: string
  status: TaskStatus
  /** Rol al que va dirigida (la fija el coordinador); vacío = libre. */
  para?: string
  claimedBy?: string
  claimedByName?: string
  result?: string
  createdAt: number
  updatedAt: number
}
export interface HubEvent {
  id: number
  at: number
  missionId: string
  kind: 'mensaje' | 'estado' | 'tarea'
  agentName?: string
  text: string
}
interface State {
  seq: number
  messages: Msg[]
  tasks: Task[]
  events: HubEvent[]
  statusText: Record<string, { text: string; at: number }>
  results: Record<string, { text: string; at: number }>
}
export interface Caller {
  missionId: string
  agentId: string
  agentName: string
  isCoordinator: boolean
  peers: Array<{ id: string; name: string }>
}

/** Error mostrable al agente como resultado de la herramienta. */
export class ToolError extends Error {}

const MAX_TEXT = 4000
const MAX_STATUS = 500
const CAP_MESSAGES = 2000
const CAP_EVENTS = 500

const str = (v: unknown, label: string, max: number) => {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) throw new ToolError(`Falta «${label}»`)
  if (s.length > max) throw new ToolError(`«${label}» supera ${max} caracteres`)
  return s
}

/** Buzón entre agentes, lista de tareas y estados. Todo por misión; el backend es la única fuente de verdad. */
export class Hub extends EventEmitter {
  private store: JsonStore<State>
  private s: State

  constructor(dataDir: string) {
    super()
    this.store = new JsonStore<State>(dataDir, 'hub.json', { seq: 0, messages: [], tasks: [], events: [], statusText: {}, results: {} })
    this.s = this.store.load()
    this.s.results ??= {}
  }

  private commit() {
    this.s.messages = this.s.messages.slice(-CAP_MESSAGES)
    this.s.events = this.s.events.slice(-CAP_EVENTS * 4)
    this.store.save(this.s)
    this.emit('change')
  }
  private event(missionId: string, kind: HubEvent['kind'], text: string, agentName?: string) {
    this.s.events.push({ id: ++this.s.seq, at: Date.now(), missionId, kind, agentName, text })
  }

  snapshot() {
    return { messages: this.s.messages, tasks: this.s.tasks, events: this.s.events, statusText: this.s.statusText, results: this.s.results }
  }

  // --- acciones del usuario (UI) ---
  addTasks(missionId: string, titles: string[]): Task[] {
    const out: Task[] = []
    for (const raw of titles) {
      const title = raw.trim()
      if (!title) continue
      if (title.length > 500) throw new ToolError('Una tarea supera 500 caracteres')
      const id = Math.max(0, ...this.s.tasks.filter(t => t.missionId === missionId).map(t => t.id)) + 1
      const t: Task = { id, missionId, title, status: 'pendiente', createdAt: Date.now(), updatedAt: Date.now() }
      this.s.tasks.push(t)
      this.event(missionId, 'tarea', `Tarea #${id} creada: ${title}`)
      out.push(t)
    }
    if (out.length) this.commit()
    return out
  }

  /** ¿Tiene trabajo esperando este agente? Sirve para despertarlo cuando está inactivo. */
  pendingWork(missionId: string, agentId: string, agentName: string, isCoordinator: boolean): string | null {
    const unread = this.s.messages.some(m => m.missionId === missionId && m.from !== agentId && (m.to === agentId || m.to === 'todos') && !m.readBy.includes(agentId))
    const tasks = this.s.tasks.filter(t => t.missionId === missionId)
    if (!isCoordinator) {
      const mine = tasks.some(t => t.status === 'pendiente' && t.para?.toLowerCase() === agentName.toLowerCase())
      if (unread || mine) return 'Tienes mensajes o tareas nuevas en la misión. Llama a read_inbox y a list_tasks y continúa con tu cometido (reclama con claim_task las tareas dirigidas a ti).'
      return null
    }
    const allDone = tasks.length > 0 && tasks.every(t => t.status === 'hecha')
    if (allDone && !this.s.results[missionId]) return 'Todas las tareas de la misión están hechas. Integra el trabajo de las ramas, escribe RESULTADO.md y llama a publish_result con el resumen final.'
    if (unread) return 'Hay mensajes nuevos de tus trabajadores. Llama a read_inbox y a list_tasks y sigue coordinando la misión.'
    return null
  }

  // --- herramientas MCP (las llaman los agentes) ---
  call(tool: string, args: Record<string, unknown>, who: Caller): unknown {
    switch (tool) {
      case 'send_message':
        return this.sendMessage(args, who)
      case 'read_inbox':
        return this.readInbox(who)
      case 'list_tasks':
        return this.listTasks(who)
      case 'claim_task':
        return this.claim(args, who)
      case 'complete_task':
        return this.complete(args, who)
      case 'post_status':
        return this.postStatus(args, who)
      case 'create_task':
        return this.createTask(args, who)
      case 'publish_result':
        return this.publishResult(args, who)
      default:
        throw new ToolError(`Herramienta desconocida: ${tool}`)
    }
  }

  private sendMessage(args: Record<string, unknown>, who: Caller) {
    const to = str(args.to, 'to', 60)
    const text = str(args.texto ?? args.text, 'texto', MAX_TEXT)
    let target: { id: string; name: string }
    if (to.toLowerCase() === 'todos') target = { id: 'todos', name: 'todos' }
    else {
      const found = who.peers.find(p => p.id === to || p.name.toLowerCase() === to.toLowerCase())
      if (!found) throw new ToolError(`Destinatario desconocido «${to}». Válidos: ${who.peers.filter(p => p.id !== who.agentId).map(p => p.name).join(', ') || '(ninguno)'} o «todos»`)
      if (found.id === who.agentId) throw new ToolError('No puedes enviarte mensajes a ti mismo')
      target = found
    }
    const m: Msg = { id: ++this.s.seq, missionId: who.missionId, from: who.agentId, fromName: who.agentName, to: target.id, toName: target.name, text, at: Date.now(), readBy: [] }
    this.s.messages.push(m)
    this.event(who.missionId, 'mensaje', `${who.agentName} → ${target.name}: ${text}`, who.agentName)
    this.commit()
    return { enviado: true, id: m.id, a: target.name }
  }

  private readInbox(who: Caller) {
    const mine = this.s.messages.filter(
      m => m.missionId === who.missionId && m.from !== who.agentId && (m.to === who.agentId || m.to === 'todos') && !m.readBy.includes(who.agentId),
    )
    for (const m of mine) m.readBy.push(who.agentId)
    if (mine.length) this.commit()
    return mine.map(m => ({ id: m.id, de: m.fromName, para: m.to === 'todos' ? 'todos' : 'ti', texto: m.text, hora: new Date(m.at).toISOString() }))
  }

  private listTasks(who: Caller) {
    return this.s.tasks
      .filter(t => t.missionId === who.missionId)
      .map(t => ({ id: t.id, titulo: t.title, para: t.para ?? null, estado: t.status, tomada_por: t.claimedByName ?? null, resultado: t.result ?? null }))
  }

  private task(args: Record<string, unknown>, who: Caller) {
    const id = Number(args.id)
    const t = this.s.tasks.find(x => x.missionId === who.missionId && x.id === id)
    if (!Number.isInteger(id) || !t) throw new ToolError(`No existe la tarea ${String(args.id)} en esta misión`)
    return t
  }

  private claim(args: Record<string, unknown>, who: Caller) {
    const t = this.task(args, who)
    if (t.status !== 'pendiente') throw new ToolError(`La tarea #${t.id} ya está ${t.status}${t.claimedByName ? ` (${t.claimedByName})` : ''}`)
    if (t.para && t.para.toLowerCase() !== who.agentName.toLowerCase()) throw new ToolError(`La tarea #${t.id} está dirigida a ${t.para}, no a ti`)
    t.status = 'en curso'
    t.claimedBy = who.agentId
    t.claimedByName = who.agentName
    t.updatedAt = Date.now()
    this.event(who.missionId, 'tarea', `${who.agentName} tomó la tarea #${t.id}: ${t.title}`, who.agentName)
    this.commit()
    return { tomada: true, id: t.id, titulo: t.title }
  }

  private complete(args: Record<string, unknown>, who: Caller) {
    const t = this.task(args, who)
    const result = str(args.resultado ?? args.result, 'resultado', MAX_TEXT)
    if (t.claimedBy !== who.agentId) throw new ToolError(`Solo quien tomó la tarea #${t.id} puede completarla${t.claimedByName ? ` (${t.claimedByName})` : ' (nadie la ha tomado)'}`)
    if (t.status === 'hecha') throw new ToolError(`La tarea #${t.id} ya estaba completada`)
    t.status = 'hecha'
    t.result = result
    t.updatedAt = Date.now()
    this.event(who.missionId, 'tarea', `${who.agentName} completó la tarea #${t.id}: ${result}`, who.agentName)
    this.commit()
    return { completada: true, id: t.id }
  }

  private coordinatorOnly(who: Caller, what: string) {
    if (!who.isCoordinator) throw new ToolError(`Solo el coordinador puede ${what}`)
  }

  /** Solo el coordinador crea tareas; `para` debe ser el nombre de un agente de la misión. */
  private createTask(args: Record<string, unknown>, who: Caller) {
    this.coordinatorOnly(who, 'crear tareas')
    const title = str(args.titulo ?? args.title, 'titulo', 500)
    const paraRaw = typeof args.para === 'string' ? args.para.trim() : ''
    let para: string | undefined
    if (paraRaw) {
      const p = who.peers.find(x => x.name.toLowerCase() === paraRaw.toLowerCase())
      if (!p) throw new ToolError(`«para» desconocido «${paraRaw}». Válidos: ${who.peers.map(x => x.name).join(', ')}`)
      para = p.name
    }
    const id = Math.max(0, ...this.s.tasks.filter(t => t.missionId === who.missionId).map(t => t.id)) + 1
    this.s.tasks.push({ id, missionId: who.missionId, title, para, status: 'pendiente', createdAt: Date.now(), updatedAt: Date.now() })
    this.event(who.missionId, 'tarea', `${who.agentName} creó la tarea #${id}${para ? ` para ${para}` : ''}: ${title}`, who.agentName)
    this.commit()
    return { creada: true, id, para: para ?? null }
  }

  private publishResult(args: Record<string, unknown>, who: Caller) {
    this.coordinatorOnly(who, 'publicar el resultado final')
    const text = str(args.texto ?? args.text, 'texto', 8000)
    this.s.results[who.missionId] = { text, at: Date.now() }
    this.event(who.missionId, 'estado', `${who.agentName} publicó el resultado final`, who.agentName)
    this.commit()
    return { publicado: true }
  }

  private postStatus(args: Record<string, unknown>, who: Caller) {
    const text = str(args.texto ?? args.text, 'texto', MAX_STATUS)
    this.s.statusText[who.agentId] = { text, at: Date.now() }
    this.event(who.missionId, 'estado', `${who.agentName}: ${text}`, who.agentName)
    this.commit()
    return { publicado: true }
  }
}
