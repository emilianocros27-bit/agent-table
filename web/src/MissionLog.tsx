import { useState } from 'react'
import { api, type HubState, type Mission } from './api'

const hhmm = (t: number) => new Date(t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })

export function MissionLog({ mission, hub, onError }: { mission: Mission; hub: HubState; onError: (m: string) => void }) {
  const [title, setTitle] = useState('')
  const tasks = hub.tasks.filter(t => t.missionId === mission.id)
  const events = hub.events.filter(e => e.missionId === mission.id).slice(-60).reverse()

  const add = async () => {
    const t = title.trim()
    if (!t) return
    try {
      await api(`/api/missions/${mission.id}/tasks`, { method: 'POST', body: JSON.stringify({ titles: [t] }) })
      setTitle('')
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const result = hub.results[mission.id]
  return (
    <>
      {result && (
        <>
          <h4>Resultado final</h4>
          <div className="final">{result.text}</div>
        </>
      )}
      <h4>Tareas</h4>
      <ul className="tasks">
        {tasks.map(t => (
          <li key={t.id} className={`task-${t.status.replace(' ', '-')}`} title={t.result ?? ''}>
            <span className="tid">#{t.id}</span> {t.title}
            <em>
              {' '}
              · {t.status}
              {t.para && t.status === 'pendiente' ? ` · para ${t.para}` : ''}
              {t.claimedByName ? ` (${t.claimedByName})` : ''}
            </em>
            {t.result && <div className="result">{t.result}</div>}
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={e => {
          e.preventDefault()
          void add()
        }}
      >
        <input className="grow" placeholder="Nueva tarea" value={title} onChange={e => setTitle(e.target.value)} />
        <button disabled={!title.trim()}>Añadir</button>
      </form>
      <h4>Mensajes y estados</h4>
      <ul className="feed">
        {events.map(e => (
          <li key={e.id} className={`ev-${e.kind}`}>
            <span className="time">{hhmm(e.at)}</span> {e.text}
          </li>
        ))}
        {events.length === 0 && <li className="hint">Sin actividad todavía.</li>}
      </ul>
    </>
  )
}
