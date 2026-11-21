import { useEffect, useRef, useState } from 'react'
import { BanIcon } from './icons/ban'
import { MaximizeIcon } from './icons/maximize'
import { MinimizeIcon } from './icons/minimize'
import { PlusIcon } from './icons/plus'
import { XIcon } from './icons/x'
import { api, token, saveTokenFromText, wsUrl, type AgentInfo, type AgentStatus, type Approval, type HubState, type Mission } from './api'
import { MissionLog } from './MissionLog'
import { Tray } from './Tray'
import { TerminalPane } from './TerminalPane'
import { Organizer } from './Organizer'
import { CleanupDialog } from './CleanupDialog'

type Layout = 1 | 2 | 3 | 4
const SHAPES: Record<Layout, number[]> = { 1: [1], 2: [2], 3: [2, 1], 4: [2, 2] }

function useState_() {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [missions, setMissions] = useState<Mission[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})
  const [hub, setHub] = useState<HubState>({ tasks: [], events: [], statusText: {}, results: {} })
  useEffect(() => {
    let ws: WebSocket | null = null
    let stop = false
    let t: number | undefined
    const connect = () => {
      ws = new WebSocket(wsUrl('/ws/events'))
      ws.onmessage = e => {
        const m = JSON.parse(e.data)
        if (m.type === 'state') {
          setAgents(m.agents)
          setMissions(m.missions)
          setApprovals(m.approvals)
          setStatuses(m.statuses)
          setHub(m.hub)
        }
      }
      ws.onclose = () => {
        if (!stop) t = window.setTimeout(connect, 1000)
      }
    }
    connect()
    return () => {
      stop = true
      clearTimeout(t)
      ws?.close()
    }
  }, [])
  return { agents, missions, approvals, statuses, hub }
}

/** Reparte el espacio entre `n` celdas con fracciones arrastrables. */
function Split({ dir, count, children }: { dir: 'row' | 'col'; count: number; children: React.ReactNode[] }) {
  const [fr, setFr] = useState<number[]>(() => Array(count).fill(1))
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => setFr(Array(count).fill(1)), [count])

  const drag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault()
    const rect = box.current!.getBoundingClientRect()
    const total = dir === 'row' ? rect.width : rect.height
    const sum = fr.reduce((a, b) => a + b, 0)
    const start = dir === 'row' ? e.clientX : e.clientY
    const base = [...fr]
    const move = (ev: PointerEvent) => {
      const d = (((dir === 'row' ? ev.clientX : ev.clientY) - start) / total) * sum
      const a = Math.max(0.15, base[i] + d)
      const b = Math.max(0.15, base[i + 1] - d)
      const next = [...base]
      next[i] = a
      next[i + 1] = base[i] + base[i + 1] - a < 0.15 ? 0.15 : b
      setFr(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div ref={box} className={`split split-${dir}`}>
      {children.map((c, i) => (
        <div key={i} className="split-cell" style={{ flex: `${fr[i] ?? 1} 1 0` }}>
          {c}
          {i < children.length - 1 && <div className={`handle handle-${dir}`} onPointerDown={drag(i)} />}
        </div>
      ))}
    </div>
  )
}

export function phaseLabel(agent: AgentInfo | undefined, st: AgentStatus | undefined): { key: string; text: string } {
  if (!agent || agent.state === 'terminado') return { key: 'terminado', text: agent ? `terminado (${agent.exitCode})` : 'terminado' }
  if (!st) return { key: 'trabajando', text: 'activo' }
  if (st.phase === 'esperando aprobación')
    return { key: 'espera', text: st.via === 'terminal' ? 'esperando aprobación en la terminal' : 'esperando aprobación en la bandeja' }
  return { key: st.phase, text: st.phase }
}

function Frame({ agent, status, maximized, onMax, onStop, onClose }: { agent: AgentInfo; status?: AgentStatus; maximized: boolean; onMax: () => void; onStop: () => void; onClose: () => void }) {
  const ph = phaseLabel(agent, status)
  return (
    <section className="frame">
      <header>
        <span className={`dot dot-${ph.key}`} />
        <span className="name">{agent.name}</span>
        <span className={`state state-${ph.key}`}>{ph.text}</span>
        {agent.state === 'activo' && (
          <button title="Detener agente" onClick={onStop}>
            <BanIcon size={14} />
          </button>
        )}
        <button title={maximized ? 'Restaurar' : 'Maximizar'} onClick={onMax}>
          {maximized ? <MinimizeIcon size={14} /> : <MaximizeIcon size={14} />}
        </button>
        <button title="Quitar de la vista y detener" onClick={onClose}>
          <XIcon size={14} />
        </button>
      </header>
      <TerminalPane agentId={agent.id} />
    </section>
  )
}

const STATUS_LABEL: Record<Mission['status'], string> = { borrador: 'borrador', activa: 'activa', detenida: 'detenida', terminada: 'terminada' }

function TokenGate() {
  const [text, setText] = useState('')
  const [bad, setBad] = useState(false)
  return (
    <div className="organizer">
      <h2>Falta el token de esta ejecución</h2>
      <p className="hint">Pega la línea completa que imprimió «npm start» (empieza por http://127.0.0.1 y termina en ?token=…).</p>
      <input value={text} onChange={e => { setText(e.target.value); setBad(false) }} placeholder="http://127.0.0.1:PUERTO/?token=…" />
      <div className="row">
        <button className="primary" disabled={!text.trim()} onClick={() => setBad(!saveTokenFromText(text))}>Usar este token</button>
      </div>
      {bad && <div className="error">No encontré un token en ese texto. Copia la línea completa, sin cortar.</div>}
    </div>
  )
}

export function App() {
  const { agents, missions, approvals, statuses, hub } = useState_()
  const [project, setProject] = useState('')
  const [defaultMax, setDefaultMax] = useState(4)
  const [layout, setLayout] = useState<Layout>(2)
  const [maxId, setMaxId] = useState<string | null>(null)
  const [front, setFront] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [organizing, setOrganizing] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [error, setError] = useState('')
  const [authFailed, setAuthFailed] = useState(!token)

  useEffect(() => {
    api<{ project: string; defaultMaxAgents: number }>('/api/config')
      .then(c => {
        setProject(c.project)
        setDefaultMax(c.defaultMaxAgents)
      })
      .catch(e => {
        setError(e.message)
        if (/Token inválido/.test(e.message)) setAuthFailed(true)
      })
  }, [])

  const launched = missions.filter(m => m.status !== 'borrador')
  useEffect(() => {
    if (!selected || !launched.some(m => m.id === selected)) setSelected(launched.length ? launched[launched.length - 1].id : null)
  }, [missions])

  const mission = launched.find(m => m.id === selected) ?? null
  const act = (path: string, label: string) => () => {
    setError('')
    api(path, { method: 'POST' }).catch(e => setError(`${label}: ${e.message}`))
  }
  const close = (id: string) => {
    if (maxId === id) setMaxId(null)
    api(`/api/agents/${id}`, { method: 'DELETE' }).catch(e => setError(e.message))
  }

  const ordered = agents
    .filter(a => (mission ? a.missionId === mission.id : false))
    .sort((a, b) => {
      const ia = front.indexOf(a.id)
      const ib = front.indexOf(b.id)
      if (ia !== ib) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib)
      return a.startedAt - b.startedAt
    })
  const slots = SHAPES[layout].reduce((a, b) => a + b, 0)
  const visible = maxId ? ordered.filter(a => a.id === maxId) : ordered.slice(0, slots)
  const frame = (a: AgentInfo) => (
    <Frame
      key={a.id}
      agent={a}
      status={statuses[a.id]}
      maximized={maxId === a.id}
      onMax={() => setMaxId(maxId === a.id ? null : a.id)}
      onStop={act(`/api/agents/${a.id}/stop`, 'No se pudo detener')}
      onClose={() => close(a.id)}
    />
  )

  let body: React.ReactNode
  if (authFailed) body = <TokenGate />
  else if (organizing)
    body = (
      <Organizer
        defaultMax={defaultMax}
        onCancel={() => setOrganizing(false)}
        onLaunched={id => {
          setSelected(id)
          setOrganizing(false)
          setMaxId(null)
        }}
      />
    )
  else if (!visible.length) body = <div className="empty">{mission ? 'No hay terminales vivas en esta misión.' : 'Sin misión. Usa «Nueva misión».'}</div>
  else if (maxId) body = frame(visible[0])
  else {
    let k = 0
    const rows = SHAPES[layout].map(n => visible.slice(k, (k += n))).filter(r => r.length)
    body = (
      <Split dir="col" count={rows.length} key={`${layout}-${rows.length}`}>
        {rows.map((r, i) => (
          <Split dir="row" count={r.length} key={`${i}-${r.length}`}>
            {r.map(frame)}
          </Split>
        ))}
      </Split>
    )
  }

  const liveState = (id: string) => agents.find(a => a.id === id)
  const hasWorktrees = mission?.agents.some(a => !a.cleaned)

  return (
    <div className="app">
      <aside>
        <div className="project" title={project}>{project}</div>
        <button className="primary" onClick={() => setOrganizing(true)}>
          <PlusIcon size={14} /> Nueva misión
        </button>

        {launched.length > 1 && (
          <ul className="agents missions">
            {[...launched].reverse().map(m => (
              <li key={m.id} className={m.id === selected ? 'sel' : ''} onClick={() => { setSelected(m.id); setOrganizing(false); setMaxId(null) }}>
                <span className="grow">{m.goal.slice(0, 40)}</span>
                <span className="status">{STATUS_LABEL[m.status]}</span>
              </li>
            ))}
          </ul>
        )}

        {mission && (
          <div className="mission-box">
            <div className="mission-goal" title={mission.goal}>{mission.goal}</div>
            <div className="status">Misión {STATUS_LABEL[mission.status]}</div>
            <div className="layouts" role="group" aria-label="Distribución">
              {([1, 2, 3, 4] as Layout[]).map(n => (
                <button key={n} className={layout === n ? 'on' : ''} onClick={() => { setLayout(n); setMaxId(null) }}>
                  {n}
                </button>
              ))}
            </div>
            <ul className="agents">
              {mission.agents.map(ma => {
                const live = liveState(ma.id)
                const shown = live && visible.some(v => v.id === ma.id)
                return (
                  <li key={ma.id} onClick={() => live && (setFront(f => [ma.id, ...f.filter(x => x !== ma.id)]), setMaxId(null), setOrganizing(false))}>
                    <span className={`dot dot-${phaseLabel(live, statuses[ma.id]).key}`} />
                    <span className="grow">{ma.name}{mission.roles.find(r => r.name === ma.role)?.coordinator && <em> (coordinador)</em>}{live && <em> · {phaseLabel(live, statuses[ma.id]).text}</em>}{live && !shown && <em> · oculto</em>}
                      {hub.statusText[ma.id] && <span className="statustext">{hub.statusText[ma.id].text}</span>}</span>
                    {ma.cleaned && <em>limpio</em>}
                  </li>
                )
              })}
            </ul>
            <MissionLog mission={mission} hub={hub} onError={setError} />
            {mission.status === 'activa' && <button onClick={act(`/api/missions/${mission.id}/stop`, 'No se pudo detener')}>Detener misión</button>}
            {mission.status !== 'terminada' && (
              <button onClick={act(`/api/missions/${mission.id}/finish`, 'No se pudo terminar')}>Terminar misión</button>
            )}
            {mission.status !== 'activa' && hasWorktrees && <button onClick={() => setCleaning(true)}>Limpiar worktrees…</button>}
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </aside>
      <main>{body}</main>
      {mission?.mode === 'bandeja' && !organizing && <Tray mission={mission} approvals={approvals.filter(a => a.missionId === mission.id)} agents={mission.agents} onError={setError} />}
      {cleaning && mission && <CleanupDialog mission={mission} onClose={() => setCleaning(false)} />}
    </div>
  )
}
