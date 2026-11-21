import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HttpError } from './missions.js'

export interface Plan {
  roles: Array<{ name: string; instructions: string }>
  tasks: string[]
}

const SCHEMA = {
  type: 'object',
  properties: {
    roles: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, instructions: { type: 'string' } }, required: ['name', 'instructions'] },
    },
    tasks: { type: 'array', items: { type: 'string' } },
  },
  required: ['roles', 'tasks'],
}

const buildPrompt = (goal: string, maxAgents: number) =>
  [
    'Descompón la meta en roles y tareas para varios agentes de Claude Code que trabajarán en paralelo, cada uno en su propio git worktree.',
    `Usa el mínimo de roles necesario, máximo ${maxAgents}. Cada rol: nombre corto y unas instrucciones concretas de su responsabilidad (qué archivos o áreas toca y cuáles no).`,
    'Las tareas deben ser concretas, verificables e independientes cuando sea posible (máximo 12). No incluyas permisos ni comandos.',
    'Responde solo con el JSON pedido, en español.',
    '',
    `Meta: ${goal}`,
  ].join('\n')

/** Extrae el plan de la salida JSON de `claude -p` (structured_output o texto con JSON). */
export function parsePlanOutput(stdout: string): unknown {
  let top: any
  try {
    top = JSON.parse(stdout)
  } catch {
    throw new HttpError(502, 'Claude devolvió una salida que no es JSON')
  }
  if (top?.is_error) throw new HttpError(502, `Claude falló: ${String(top.result ?? 'sin detalle').slice(0, 300)}`)
  if (top?.structured_output && typeof top.structured_output === 'object') return top.structured_output
  const text = String(top?.result ?? '')
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new HttpError(502, 'Claude no devolvió un plan')
  try {
    return JSON.parse(m[0])
  } catch {
    throw new HttpError(502, 'El plan de Claude no es JSON válido')
  }
}

/** Valida y recorta el plan: nunca confía en la forma ni en los tamaños que devuelve el modelo. */
export function sanitizePlan(raw: any, maxAgents: number): Plan {
  const roles: Plan['roles'] = []
  const seen = new Set<string>()
  for (const r of Array.isArray(raw?.roles) ? raw.roles : []) {
    const name = String(r?.name ?? '').trim().slice(0, 40)
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    roles.push({ name, instructions: String(r?.instructions ?? '').trim().slice(0, 4000) })
    if (roles.length >= maxAgents) break
  }
  const tasks = (Array.isArray(raw?.tasks) ? raw.tasks : []).map((t: unknown) => String(t ?? '').trim().slice(0, 500)).filter(Boolean).slice(0, 30)
  if (!roles.length) throw new HttpError(502, 'El plan no trae ningún rol utilizable')
  return { roles, tasks }
}

let busy = false

/**
 * Una llamada no interactiva a Claude, SIN herramientas (--tools ""), sin guardar sesión, en una carpeta vacía
 * (no lee el repo ni ejecuta hooks del proyecto) y con tope de coste. El plan es solo una propuesta: el usuario lo edita.
 */
export async function proposePlan(goal: string, maxAgents: number, opts: { command: string; env: Record<string, string>; model: string }): Promise<Plan> {
  if (busy) throw new HttpError(409, 'Ya hay un plan en curso')
  busy = true
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-plan-'))
  try {
    const args = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--model', opts.model, '--max-budget-usd', '0.5', '--json-schema', JSON.stringify(SCHEMA)]
    const stdout = await new Promise<string>((resolve, reject) => {
      const p = spawn(opts.command, args, { cwd, env: opts.env })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        p.kill()
        reject(new HttpError(504, 'Claude tardó más de 2 minutos en proponer el plan'))
      }, 120_000)
      p.stdout.on('data', d => (out += d))
      p.stderr.on('data', d => (err += d))
      p.on('error', e => (clearTimeout(timer), reject(new HttpError(500, `No se pudo ejecutar claude: ${e.message}`))))
      p.on('close', code => {
        clearTimeout(timer)
        if (code === 0) resolve(out)
        else reject(new HttpError(502, `claude terminó con código ${code}: ${(err || out).trim().slice(0, 300)}`))
      })
      p.stdin.end(buildPrompt(goal, maxAgents))
    })
    return sanitizePlan(parsePlanOutput(stdout), maxAgents)
  } finally {
    busy = false
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}
