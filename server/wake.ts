import type { PtyManager } from './pty-manager.js'
import type { Approvals } from './approvals.js'
import type { Hub } from './hub.js'
import type { MissionService } from './missions.js'

const IDLE_MS = 3000
const COOLDOWN_MS = 30_000
const MAX_NUDGES = 20

/**
 * Los agentes de Claude Code trabajan por turnos: uno que terminó su turno no se entera de mensajes ni tareas nuevas.
 * En misiones con coordinador, si un agente lleva unos segundos inactivo (hook Stop) y tiene trabajo pendiente
 * (mensajes sin leer o tareas dirigidas a él), se le envía una línea corta como si la escribiera el usuario.
 * No mira la pantalla ni responde diálogos: solo actúa con el estado que dan los hooks y el buzón.
 */
export class Waker {
  private last = new Map<string, number>()
  private count = new Map<string, number>()
  private timer: NodeJS.Timeout

  constructor(private manager: PtyManager, private approvals: Approvals, private hub: Hub, private missions: MissionService) {
    this.timer = setInterval(() => this.scan(), 2000)
    this.timer.unref()
  }

  stop() {
    clearInterval(this.timer)
  }

  scan() {
    const statuses = this.approvals.statuses()
    for (const m of this.missions.list()) {
      if (m.status !== 'activa' || !m.roles.some(r => r.coordinator)) continue
      for (const a of m.agents) {
        if (!this.manager.isActive(a.id)) continue
        const st = statuses[a.id]
        if (st?.phase !== 'inactivo' || Date.now() - st.since < IDLE_MS) continue
        if (Date.now() - (this.last.get(a.id) ?? 0) < COOLDOWN_MS || (this.count.get(a.id) ?? 0) >= MAX_NUDGES) continue
        const isCoord = m.roles.find(r => r.name === a.role)?.coordinator === true
        const text = this.hub.pendingWork(m.id, a.id, a.name, isCoord)
        if (!text) continue
        this.last.set(a.id, Date.now())
        this.count.set(a.id, (this.count.get(a.id) ?? 0) + 1)
        this.manager.write(a.id, text)
        // El Enter va aparte: Claude Code trata una ráfaga con salto de línea como texto pegado, no como envío.
        setTimeout(() => this.manager.write(a.id, '\r'), 400)
      }
    }
  }
}
