import { useState } from 'react'
import { DeleteIcon } from './icons/delete'
import { LoaderIcon } from './icons/loader'
import { PlusIcon } from './icons/plus'
import { SparklesIcon } from './icons/sparkles'
import { api, type Mission } from './api'

interface RoleForm {
  name: string
  instructions: string
  allow: string
  deny: string
}
const emptyRole = (): RoleForm => ({ name: '', instructions: '', allow: '', deny: '' })
const lines = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean)

export function Organizer({ defaultMax, onLaunched, onCancel }: { defaultMax: number; onLaunched: (id: string) => void; onCancel: () => void }) {
  const [goal, setGoal] = useState('')
  const [max, setMax] = useState(defaultMax)
  const [mode, setMode] = useState<'nativa' | 'bandeja'>('nativa')
  const [coordinator, setCoordinator] = useState(true)
  const [autoEdits, setAutoEdits] = useState(false)
  const [allow, setAllow] = useState('Bash(npm test)')
  const [deny, setDeny] = useState('Bash(rm -rf *)\nBash(git push *)')
  const [tasks, setTasks] = useState('')
  const [roles, setRoles] = useState<RoleForm[]>([emptyRole()])
  const [busy, setBusy] = useState(false)
  const [planning, setPlanning] = useState(false)
  const [planned, setPlanned] = useState(false)
  const [error, setError] = useState('')

  const setRole = (i: number, patch: Partial<RoleForm>) => setRoles(r => r.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const agentCount = roles.length + (coordinator ? 1 : 0)
  const tooMany = agentCount > max

  /** Una llamada a Claude (sin herramientas) que propone roles y tareas; todo queda editable antes de lanzar. */
  const propose = async () => {
    setPlanning(true)
    setError('')
    try {
      const p = await api<{ roles: Array<{ name: string; instructions: string }>; tasks: string[] }>('/api/plan', { method: 'POST', body: JSON.stringify({ goal, maxAgents: max }) })
      setRoles(p.roles.map(r => ({ ...emptyRole(), ...r })))
      setTasks(p.tasks.join('\n'))
      setPlanned(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPlanning(false)
    }
  }

  const launch = async () => {
    setBusy(true)
    setError('')
    try {
      const m = await api<Mission>('/api/missions', {
        method: 'POST',
        body: JSON.stringify({
          goal,
          maxAgents: max,
          mode,
          coordinator,
          autoEdits,
          tasks: lines(tasks),
          rules: { allow: lines(allow), deny: lines(deny) },
          roles: roles.map(r => ({ name: r.name, instructions: r.instructions, rules: { allow: lines(r.allow), deny: lines(r.deny) } })),
        }),
      })
      try {
        await api(`/api/missions/${m.id}/launch`, { method: 'POST' })
      } catch (e) {
        await api(`/api/missions/${m.id}`, { method: 'DELETE' }).catch(() => {})
        throw e
      }
      onLaunched(m.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="organizer">
      <h2>Nueva misión</h2>
      <label>
        Meta
        <textarea rows={3} value={goal} onChange={e => setGoal(e.target.value)} />
      </label>
      <div className="row">
        <button disabled={planning || !goal.trim()} onClick={propose} title="Una llamada a Claude, sin herramientas, que cuenta para tu consumo">
          {planning ? <LoaderIcon size={14} /> : <SparklesIcon size={14} />} {planning ? 'Proponiendo…' : 'Proponer plan'}
        </button>
        {planned && <span className="hint">Plan propuesto: revisa y edita roles y tareas antes de lanzar.</span>}
      </div>
      <label className="inline">
        Máximo de agentes
        <input type="number" min={1} max={12} value={max} onChange={e => setMax(Number(e.target.value))} />
      </label>
      <p className="warn">Cada agente es una sesión de Claude Code distinta: con {agentCount} agente{agentCount === 1 ? '' : 's'}{coordinator ? ' (contando al coordinador)' : ''}, el gasto de tokens se multiplica por {agentCount}.</p>

      <label className="check">
        <input type="checkbox" checked={coordinator} onChange={e => setCoordinator(e.target.checked)} /> Coordinador («cerebro»): reparte las tareas entre los roles, vigila y publica el resultado final
      </label>
      <label className="check">
        <input type="checkbox" checked={autoEdits} onChange={e => setAutoEdits(e.target.checked)} /> Aceptar ediciones automáticamente (acceptEdits). Los comandos y lo demás siguen pidiendo aprobación
      </label>
      <p className="hint">Al lanzar, cada agente recibe solo su prompt y empieza a trabajar: no tienes que escribirles nada.</p>
      <div className="radios" role="radiogroup" aria-label="Modo de aprobaciones">
        <label>
          <input type="radio" checked={mode === 'nativa'} onChange={() => setMode('nativa')} /> Terminal nativa
        </label>
        <label>
          <input type="radio" checked={mode === 'bandeja'} onChange={() => setMode('bandeja')} /> Bandeja de aprobaciones
        </label>
      </div>
      <p className="hint">
        {mode === 'nativa'
          ? 'Los permisos se responden en cada terminal, como siempre. La barra lateral solo avisa.'
          : 'Los permisos se responden en la bandeja y el diálogo de la terminal no aparece para lo que gestiona la bandeja.'}
      </p>
      <div className="rules">
        <label>
          Reglas allow de la misión (una por línea)
          <textarea rows={3} value={allow} onChange={e => setAllow(e.target.value)} />
        </label>
        <label>
          Reglas deny de la misión (una por línea)
          <textarea rows={3} value={deny} onChange={e => setDeny(e.target.value)} />
        </label>
      </div>
      <p className="hint">Formato de Claude Code: Tool o Tool(especificador). Todo lo que no coincida pide aprobación; deny gana sobre allow.</p>

      <label>
        Tareas iniciales (opcional, una por línea). Con coordinador, él crea y reparte las que falten
        <textarea rows={3} value={tasks} onChange={e => setTasks(e.target.value)} />
      </label>

      {roles.map((r, i) => (
        <fieldset key={i}>
          <legend>Rol {i + 1}</legend>
          <input placeholder="Nombre" value={r.name} onChange={e => setRole(i, { name: e.target.value })} />
          <textarea rows={3} placeholder="Instrucciones" value={r.instructions} onChange={e => setRole(i, { instructions: e.target.value })} />
          <div className="rules">
            <label>
              Allow del rol
              <textarea rows={2} value={r.allow} onChange={e => setRole(i, { allow: e.target.value })} />
            </label>
            <label>
              Deny del rol
              <textarea rows={2} value={r.deny} onChange={e => setRole(i, { deny: e.target.value })} />
            </label>
          </div>
          {roles.length > 1 && (
            <button title="Quitar rol" onClick={() => setRoles(rs => rs.filter((_, j) => j !== i))}>
              <DeleteIcon size={14} />
            </button>
          )}
        </fieldset>
      ))}
      <div className="row">
        <button disabled={roles.length >= max} onClick={() => setRoles(r => [...r, emptyRole()])}>
          <PlusIcon size={14} /> Añadir rol
        </button>
        <span className="grow" />
        <button onClick={onCancel}>Cancelar</button>
        <button className="primary" disabled={busy || !goal.trim() || tooMany || roles.some(r => !r.name.trim())} onClick={launch}>
          Lanzar misión
        </button>
      </div>
      {tooMany && <div className="error">Hay más roles que el máximo de agentes.</div>}
      {error && <div className="error">{error}</div>}
    </div>
  )
}
