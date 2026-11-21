export interface AgentInfo {
  id: string
  name: string
  cwd: string
  state: 'activo' | 'terminado'
  exitCode: number | null
  startedAt: number
  missionId?: string
  role?: string
}

export interface Rules {
  allow: string[]
  deny: string[]
}
export interface Role {
  name: string
  instructions: string
  rules?: Rules
  coordinator?: boolean
}
export interface Approval {
  id: string
  agentId: string
  missionId: string
  tool: string
  input: Record<string, unknown>
  createdAt: number
}
export interface AgentStatus {
  phase: 'trabajando' | 'esperando aprobación' | 'inactivo'
  via?: 'bandeja' | 'terminal'
  tool?: string
  since: number
}
export interface MissionAgent {
  id: string
  name: string
  role: string
  worktree: string
  branch: string
  cleaned?: boolean
}
export interface Mission {
  id: string
  goal: string
  maxAgents: number
  mode: 'nativa' | 'bandeja'
  autoEdits?: boolean
  rules: Rules
  roles: Role[]
  agents: MissionAgent[]
  status: 'borrador' | 'activa' | 'detenida' | 'terminada'
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
  worktree: string
  branch: string
  motivo?: string
}

/** Un token válido es solo hexadecimal; cualquier otra cosa (texto pegado de más, «…», etc.) se descarta. */
const validToken = (t: string | null | undefined) => (t && /^[0-9a-f]{20,}$/i.test(t.trim()) ? t.trim() : '')

function readToken(): string {
  const fromUrl = validToken(new URL(location.href).searchParams.get('token'))
  try {
    if (fromUrl) {
      sessionStorage.setItem('mesa-token', fromUrl)
      history.replaceState(null, '', location.pathname)
      return fromUrl
    }
    return validToken(sessionStorage.getItem('mesa-token'))
  } catch {
    return fromUrl
  }
}

export const token = readToken()

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { 'x-token': token, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
  })
  if (r.status === 401) throw new Error('Token inválido o caducado: abre la URL con ?token=… que imprimió «npm start» (cambia en cada ejecución)')
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
  return r.json()
}

export const wsUrl = (path: string) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}?token=${encodeURIComponent(token)}`

export interface HubTask {
  id: number
  missionId: string
  title: string
  para?: string
  status: 'pendiente' | 'en curso' | 'hecha'
  claimedByName?: string
  result?: string
}
export interface HubEvent {
  id: number
  at: number
  missionId: string
  kind: 'mensaje' | 'estado' | 'tarea'
  text: string
}
export interface HubState {
  tasks: HubTask[]
  events: HubEvent[]
  statusText: Record<string, { text: string; at: number }>
  results: Record<string, { text: string; at: number }>
}

/** Guarda el token a partir de la URL completa que imprime «npm start» y recarga. */
export function saveTokenFromText(text: string): boolean {
  const m = text.match(/[?&]token=([0-9a-f]{20,})/i) ?? text.trim().match(/^([0-9a-f]{40,})$/i)
  if (!m) return false
  try {
    sessionStorage.setItem('mesa-token', m[1])
  } catch {
    return false
  }
  location.reload()
  return true
}
