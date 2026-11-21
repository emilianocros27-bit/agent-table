import { useState } from 'react'
import { CheckIcon } from './icons/check'
import { XIcon } from './icons/x'
import { api, type Approval, type Mission, type MissionAgent } from './api'

/** Texto exacto de lo que el agente quiere hacer. */
function detail(a: Approval): { main: string; extra?: string } {
  const i = a.input as Record<string, unknown>
  if (a.tool === 'Bash') return { main: String(i.command ?? ''), extra: i.description ? String(i.description) : undefined }
  const path = String(i.file_path ?? i.notebook_path ?? i.url ?? i.query ?? '')
  if (path) {
    const body = i.content ?? (i.old_string !== undefined ? `- ${i.old_string}\n+ ${i.new_string}` : undefined)
    return { main: path, extra: body === undefined ? undefined : String(body).slice(0, 1200) }
  }
  return { main: JSON.stringify(i, null, 2) }
}

export function Tray({ mission, approvals, agents, onError }: { mission: Mission; approvals: Approval[]; agents: MissionAgent[]; onError: (m: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const decide = async (id: string, decision: 'allow' | 'deny') => {
    setBusy(id)
    try {
      await api(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision }) })
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <aside className="tray" aria-label="Bandeja de aprobaciones">
      <h3>
        Aprobaciones <span className={`count ${approvals.length ? 'hot' : ''}`}>{approvals.length}</span>
      </h3>
      {approvals.length === 0 && <div className="hint">Sin peticiones pendientes.</div>}
      {approvals.map(a => {
        const d = detail(a)
        return (
          <article key={a.id}>
            <div className="who">
              {agents.find(x => x.id === a.agentId)?.name ?? a.agentId} · <b>{a.tool}</b>
            </div>
            <pre>{d.main}</pre>
            {d.extra && <pre className="extra">{d.extra}</pre>}
            <div className="row">
              <button className="ok" disabled={busy === a.id} onClick={() => decide(a.id, 'allow')}>
                <CheckIcon size={14} /> Aprobar
              </button>
              <button className="no" disabled={busy === a.id} onClick={() => decide(a.id, 'deny')}>
                <XIcon size={14} /> Rechazar
              </button>
            </div>
          </article>
        )
      })}
      <div className="hint">Reglas de la misión: {mission.rules.allow.length} allow, {mission.rules.deny.length} deny. Lo demás pide tu aprobación.</div>
    </aside>
  )
}
