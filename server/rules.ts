/**
 * Evaluador de reglas allow/deny con la sintaxis de permisos de Claude Code: `Tool` o `Tool(especificador)`.
 * Es deliberadamente conservador: para allow en Bash rechaza comandos compuestos (el hueco "npm test && curl evil"
 * no existe); para deny prueba el comando completo y cada segmento. Claude Code aplica además las mismas reglas
 * de forma nativa (se escriben en settings.local.json), así que esto es defensa en profundidad y decide la bandeja.
 */

export interface Rules {
  allow: string[]
  deny: string[]
}
export type Verdict = 'deny' | 'allow' | 'none'

const RULE_RE = /^([A-Za-z_][\w.*-]*)(?:\(([\s\S]*)\))?$/
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])
const SHELL_META = /[;&|<>`$()\n\r\\]/

export function parseRule(rule: string): { tool: string; spec?: string } | null {
  const m = rule.trim().match(RULE_RE)
  return m ? { tool: m[1], spec: m[2] } : null
}

export function validateRules(list: unknown, label: string): string[] {
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new Error(`${label}: debe ser una lista`)
  if (list.length > 50) throw new Error(`${label}: máximo 50 reglas`)
  return list.map(r => {
    const s = String(r).trim()
    if (!s || s.length > 200 || !parseRule(s)) throw new Error(`${label}: regla inválida «${s.slice(0, 40)}» (usa Tool o Tool(especificador))`)
    return s
  })
}

const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

function globToRe(spec: string, kind: 'cmd' | 'path'): RegExp {
  if (kind === 'cmd') {
    // `npm test:*` (forma antigua) = prefijo con límite de palabra
    if (spec.endsWith(':*')) return new RegExp(`^${esc(spec.slice(0, -2))}(?:\\s.*)?$`, 's')
    return new RegExp(`^${spec.split('*').map(esc).join('.*')}$`, 's')
  }
  const re = spec
    .split('**')
    .map(p => p.split('*').map(esc).join('[^/]*'))
    .join('.*')
  return new RegExp(`^${re}$`)
}

function toolMatches(ruleTool: string, tool: string): boolean {
  if (ruleTool === tool) return true
  if (ruleTool === 'Edit' && EDIT_TOOLS.has(tool)) return true
  if (ruleTool === 'Read' && READ_TOOLS.has(tool)) return true
  if (ruleTool.startsWith('mcp__') && ruleTool.endsWith('__*')) return tool.startsWith(ruleTool.slice(0, -1))
  return false
}

const inputPath = (i: Record<string, unknown>) => String(i.file_path ?? i.notebook_path ?? i.path ?? '')

function specMatches(tool: string, input: Record<string, unknown>, spec: string, forAllow: boolean): boolean {
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '').trim()
    const re = globToRe(spec.trim(), 'cmd')
    if (forAllow) return !SHELL_META.test(cmd) && re.test(cmd)
    return re.test(cmd) || cmd.split(/[;&|\n`$()<>]+/).some(seg => seg.trim() && re.test(seg.trim()))
  }
  if (tool === 'WebFetch') {
    const m = spec.match(/^domain:(.+)$/)
    if (!m) return false
    try {
      return new URL(String(input.url ?? '')).hostname === m[1]
    } catch {
      return false
    }
  }
  if (EDIT_TOOLS.has(tool) || READ_TOOLS.has(tool)) {
    const p = inputPath(input)
    return !!p && globToRe(spec.replace(/^\/\//, '/'), 'path').test(p)
  }
  return false // especificador desconocido para esta herramienta: no coincide
}

function matchOne(rule: string, tool: string, input: Record<string, unknown>, forAllow: boolean): boolean {
  const r = parseRule(rule)
  if (!r || !toolMatches(r.tool, tool)) return false
  if (r.spec === undefined || r.spec === '' || r.spec === '*') return true
  return specMatches(tool, input, r.spec, forAllow)
}

/** deny gana siempre sobre allow. */
export function evaluate(tool: string, input: Record<string, unknown>, rules: Rules): Verdict {
  if (rules.deny.some(r => matchOne(r, tool, input, false))) return 'deny'
  if (rules.allow.some(r => matchOne(r, tool, input, true))) return 'allow'
  return 'none'
}

export function mergeRules(...sets: Array<Partial<Rules> | undefined>): Rules {
  const out: Rules = { allow: [], deny: [] }
  for (const s of sets) {
    for (const k of ['allow', 'deny'] as const) for (const r of s?.[k] ?? []) if (!out[k].includes(r)) out[k].push(r)
  }
  return out
}

// --- ¿Claude pediría permiso en modo `default`? (aproximación para decidir si va a la bandeja) ---

const PROMPT_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch'])
const READONLY_CMD = /^(ls|pwd|cat|head|tail|wc|grep|rg|which|date|whoami|echo|stat|file|tree|git (status|diff|log|show|branch|rev-parse)|node --version|npm --version)(\s[^;&|<>`$()\\\n]*)?$/

/**
 * En modo default Claude pide permiso por estas herramientas. En acceptEdits las ediciones no preguntan pero
 * Bash y lo demás sí; en auto/plan/dontAsk decide su propio flujo y la bandeja no interviene.
 */
export function needsTray(tool: string, input: Record<string, unknown>, permissionMode: string | undefined): boolean {
  if (permissionMode === 'acceptEdits' && EDIT_TOOLS.has(tool)) return false
  if (permissionMode && permissionMode !== 'default' && permissionMode !== 'acceptEdits') return false
  if (!(PROMPT_TOOLS.has(tool) || tool.startsWith('mcp__'))) return false
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '').trim()
    if (READONLY_CMD.test(cmd) && !/\s(-exec|-delete)\b/.test(cmd)) return false
  }
  return true
}
