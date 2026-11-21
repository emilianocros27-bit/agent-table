import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import pty from 'node-pty'
import xtermHeadless from '@xterm/headless'
import serializePkg from '@xterm/addon-serialize'
import type { WebSocket } from 'ws'

const { Terminal } = xtermHeadless as unknown as { Terminal: typeof import('@xterm/headless').Terminal }
const { SerializeAddon } = serializePkg as unknown as { SerializeAddon: typeof import('@xterm/addon-serialize').SerializeAddon }

export type AgentState = 'activo' | 'terminado'

export interface AgentInfo {
  id: string
  name: string
  cwd: string
  state: AgentState
  exitCode: number | null
  startedAt: number
  missionId?: string
  role?: string
}

interface Client {
  ws: WebSocket
  live: boolean
  buffer: string[]
}

interface Session {
  info: AgentInfo
  proc: pty.IPty
  mirror: InstanceType<typeof Terminal>
  serializer: InstanceType<typeof SerializeAddon>
  clients: Set<Client>
}

export interface SpawnOptions {
  id: string
  name: string
  cwd: string
  command: string
  args: string[]
  env: Record<string, string>
  cols?: number
  rows?: number
  missionId?: string
  role?: string
}

/** Verifica que `target` esté dentro de `root` (resuelve symlinks). */
export function isInside(root: string, target: string): boolean {
  let r: string, t: string
  try {
    r = fs.realpathSync(root)
    t = fs.realpathSync(target)
  } catch {
    return false
  }
  const rel = path.relative(r, t)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export class PtyManager extends EventEmitter {
  private sessions = new Map<string, Session>()

  constructor(private projectRoot: string) {
    super()
  }

  list(): AgentInfo[] {
    return [...this.sessions.values()].map(s => ({ ...s.info }))
  }

  has(id: string) {
    return this.sessions.has(id)
  }

  spawn(o: SpawnOptions): AgentInfo {
    if (!isInside(this.projectRoot, o.cwd)) throw new Error('cwd fuera de la carpeta del proyecto')
    const cols = o.cols ?? 120
    const rows = o.rows ?? 32
    const proc = pty.spawn(o.command, o.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: o.cwd,
      env: { ...o.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    })
    const mirror = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
    const serializer = new SerializeAddon()
    mirror.loadAddon(serializer)
    const info: AgentInfo = { id: o.id, name: o.name, cwd: o.cwd, state: 'activo', exitCode: null, startedAt: Date.now(), missionId: o.missionId, role: o.role }
    const s: Session = { info, proc, mirror, serializer, clients: new Set() }
    this.sessions.set(o.id, s)

    proc.onData(data => {
      mirror.write(data)
      for (const c of s.clients) {
        if (c.live) c.ws.send(data)
        else c.buffer.push(data)
      }
    })
    proc.onExit(({ exitCode }) => {
      info.state = 'terminado'
      info.exitCode = exitCode
      this.emit('exit', info.id)
      this.emit('change')
    })
    this.emit('change')
    return { ...info }
  }

  /** Conecta un WebSocket: envía el estado actual y luego el flujo en vivo, sin tocar los bytes. */
  async attach(id: string, ws: WebSocket, cols: number, rows: number) {
    const s = this.sessions.get(id)
    if (!s) return ws.close(4404, 'agente inexistente')
    if (s.info.state === 'activo') this.resize(id, cols, rows)
    const client: Client = { ws, live: false, buffer: [] }
    s.clients.add(client)
    ws.on('close', () => s.clients.delete(client))
    // Marcador: espera a que el espejo procese todo lo recibido hasta ahora.
    await new Promise<void>(res => s.mirror.write('', res))
    if (ws.readyState !== ws.OPEN) return
    ws.send('\x1bc' + s.serializer.serialize())
    for (const d of client.buffer) ws.send(d)
    client.buffer = []
    client.live = true
  }

  write(id: string, data: string) {
    const s = this.sessions.get(id)
    if (s && s.info.state === 'activo') s.proc.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    const s = this.sessions.get(id)
    if (!s || s.info.state !== 'activo') return
    cols = Math.max(2, Math.min(500, Math.floor(cols)))
    rows = Math.max(2, Math.min(200, Math.floor(rows)))
    if (s.proc.cols === cols && s.proc.rows === rows) return
    s.proc.resize(cols, rows)
    s.mirror.resize(cols, rows)
  }

  kill(id: string) {
    const s = this.sessions.get(id)
    if (!s) return false
    if (s.info.state === 'activo') s.proc.kill()
    return true
  }

  isActive(id: string) {
    return this.sessions.get(id)?.info.state === 'activo'
  }

  remove(id: string) {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.info.state === 'activo') s.proc.kill()
    for (const c of s.clients) c.ws.close(1000, 'agente eliminado')
    s.mirror.dispose()
    this.sessions.delete(id)
    this.emit('change')
  }

  killAll() {
    for (const s of this.sessions.values()) if (s.info.state === 'activo') s.proc.kill()
  }
}
