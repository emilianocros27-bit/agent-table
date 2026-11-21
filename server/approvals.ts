import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

export type Phase = 'trabajando' | 'esperando aprobación' | 'inactivo'
export interface AgentStatus {
  phase: Phase
  /** Dónde se responde la aprobación pendiente: 'bandeja' o 'terminal'. */
  via?: 'bandeja' | 'terminal'
  tool?: string
  since: number
}
export interface Approval {
  id: string
  agentId: string
  missionId: string
  tool: string
  input: Record<string, unknown>
  createdAt: number
}
export interface Decision {
  behavior: 'allow' | 'deny'
  message?: string
}

interface Pending extends Approval {
  resolve: (d: Decision) => void
}

/** Estado de agentes (por hooks) y cola de aprobaciones de la bandeja. */
export class Approvals extends EventEmitter {
  private status = new Map<string, AgentStatus>()
  private pending = new Map<string, Pending>()

  statuses(): Record<string, AgentStatus> {
    return Object.fromEntries(this.status)
  }

  list(): Approval[] {
    return [...this.pending.values()].map(({ resolve: _r, ...a }) => a)
  }

  setStatus(agentId: string, phase: Phase, extra: Partial<AgentStatus> = {}) {
    const cur = this.status.get(agentId)
    // Mientras haya algo pendiente en la bandeja, solo lo resuelve la decisión (o el fin del proceso).
    if (cur?.phase === 'esperando aprobación' && cur.via === 'bandeja' && phase !== 'esperando aprobación') return
    if (cur && cur.phase === phase && cur.via === extra.via && cur.tool === extra.tool) return
    this.status.set(agentId, { phase, since: Date.now(), ...extra })
    this.emit('change')
  }

  /** Encola una petición y espera la decisión del usuario. `signal` aborta si el hook se cierra. */
  request(agentId: string, missionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<Decision | null> {
    const id = crypto.randomUUID().slice(0, 8)
    return new Promise(resolve => {
      const done = (d: Decision | null) => {
        if (!this.pending.delete(id)) return
        const cur = this.status.get(agentId)
        if (cur?.via === 'bandeja') this.status.delete(agentId)
        this.setStatus(agentId, 'trabajando')
        this.emit('change')
        resolve(d)
      }
      this.pending.set(id, { id, agentId, missionId, tool, input, createdAt: Date.now(), resolve: d => done(d) })
      this.status.set(agentId, { phase: 'esperando aprobación', via: 'bandeja', tool, since: Date.now() })
      signal.addEventListener('abort', () => done(null), { once: true })
      this.emit('change')
    })
  }

  decide(id: string, decision: Decision): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    p.resolve(decision)
    return true
  }

  /** El agente terminó: sus peticiones pendientes se deniegan y se limpia su estado. */
  dropAgent(agentId: string) {
    for (const p of [...this.pending.values()]) if (p.agentId === agentId) p.resolve({ behavior: 'deny', message: 'El agente terminó' })
    this.status.delete(agentId)
    this.emit('change')
  }
}
