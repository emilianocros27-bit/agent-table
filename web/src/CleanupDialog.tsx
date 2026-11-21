import { useEffect, useState } from 'react'
import { api, type CleanupResult, type Mission, type WorktreeStatus } from './api'

export function CleanupDialog({ mission, onClose }: { mission: Mission; onClose: () => void }) {
  const [rows, setRows] = useState<WorktreeStatus[] | null>(null)
  const [force, setForce] = useState(false)
  const [res, setRes] = useState<CleanupResult[] | null>(null)
  const [error, setError] = useState('')

  const load = () => api<WorktreeStatus[]>(`/api/missions/${mission.id}/worktrees`).then(setRows).catch(e => setError(e.message))
  useEffect(() => void load(), [mission.id])

  const run = async () => {
    setError('')
    try {
      setRes(await api<CleanupResult[]>(`/api/missions/${mission.id}/cleanup`, { method: 'POST', body: JSON.stringify({ force }) }))
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const anyDirty = rows?.some(r => r.dirty)
  return (
    <div className="modal-back">
      <div className="modal">
        <h3>Limpiar worktrees</h3>
        {rows && rows.length === 0 && <p>No quedan worktrees de esta misión.</p>}
        {rows && rows.length > 0 && (
          <table>
            <thead>
              <tr><th>Agente</th><th>Rama</th><th>Sin commitear</th><th>Commits</th></tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.agentId}>
                  <td>{r.name}</td><td>{r.branch}</td><td>{r.dirty ? 'sí' : 'no'}</td><td>{r.ahead}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">Las ramas con commits propios se conservan siempre. Los worktrees con cambios sin commitear se conservan salvo que lo autorices abajo.</p>
        {anyDirty && (
          <label className="inline danger">
            <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} /> Descartar cambios sin commitear (no se puede deshacer)
          </label>
        )}
        {res && (
          <ul>
            {res.map(r => (
              <li key={r.agentId}>
                {rows?.find(x => x.agentId === r.agentId)?.name ?? r.agentId}: worktree {r.worktree}, rama {r.branch}
                {r.motivo ? ` (${r.motivo})` : ''}
              </li>
            ))}
          </ul>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row">
          <span className="grow" />
          <button onClick={onClose}>Cerrar</button>
          {rows && rows.length > 0 && (
            <button className="primary" onClick={run}>
              Eliminar worktrees
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
