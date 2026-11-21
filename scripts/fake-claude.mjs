#!/usr/bin/env node
// `claude` falso para pruebas sin gastar tokens. Simula una TUI (colores, caja de entrada, diálogo de permiso,
// reacción a resize) y ejecuta los hooks HTTP de .claude/settings.local.json como lo hace Claude Code:
// UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop. Activar con CLAUDE_BIN=scripts/fake-claude.mjs
//
// Comandos de prueba (escritos en la terminal):  ansi | env | permiso | tool <Nombre> <modo> <argumento...>
import fs from 'node:fs'
import path from 'node:path'

// Modo no interactivo (-p): usado por «Proponer plan». Lee el prompt por stdin y responde un plan fijo en JSON.
if (process.argv.includes('-p')) {
  if (process.env.PLAN_ARGS_FILE) fs.appendFileSync(process.env.PLAN_ARGS_FILE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\n')
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', d => (input += d))
  process.stdin.on('end', () => {
    if (process.env.FAKE_PLAN_FAIL) { console.log(JSON.stringify({ type: 'result', is_error: true, result: 'fallo simulado' })); process.exit(0) }
    const goal = input.split('Meta: ')[1]?.trim() ?? ''
    const plan = process.env.FAKE_PLAN_RAW ?? JSON.stringify({ roles: [{ name: 'Backend', instructions: `API para: ${goal}` }, { name: 'Frontend', instructions: 'UI' }, { name: 'Tercero', instructions: 'x' }], tasks: ['Diseñar modelo', 'Implementar endpoints', '  '] })
    console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Aquí tienes el plan:\n' + plan }))
  })
} else {
const out = s => process.stdout.write(s)
const ESC = '\x1b'
const size = () => `cols=${process.stdout.columns} rows=${process.stdout.rows}`

let settings = {}
try { settings = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.claude/settings.local.json'), 'utf8')) } catch {}

async function runHooks(event, payload = {}, tool) {
  let result = null
  for (const e of settings.hooks?.[event] ?? []) {
    if (e.matcher && tool && !new RegExp(e.matcher).test(tool)) continue
    for (const h of e.hooks ?? []) {
      if (h.type !== 'http') continue
      const headers = { 'content-type': 'application/json' }
      for (const [k, v] of Object.entries(h.headers ?? {}))
        headers[k] = v.replace(/\$\{?(\w+)\}?/g, (_, n) => ((h.allowedEnvVars ?? []).includes(n) ? process.env[n] ?? '' : ''))
      try {
        const r = await fetch(h.url, {
          method: 'POST', headers,
          body: JSON.stringify({ session_id: 'fake', cwd: process.cwd(), hook_event_name: event, ...payload }),
          signal: AbortSignal.timeout((h.timeout ?? 600) * 1000),
        })
        const txt = await r.text()
        if (r.ok && txt) { try { result = JSON.parse(txt) } catch {} }
        else if (!r.ok) out(`\r\nHOOK-HTTP-${r.status} ${event}\r\n`)
      } catch {}
    }
  }
  return result
}

const naive = (rule, name, arg) => {
  const m = rule.match(/^(\w+)(?:\((.*)\))?$/)
  if (!m || m[1] !== name) return false
  if (m[2] === undefined) return true
  return m[2].endsWith('*') ? arg.startsWith(m[2].slice(0, -1)) : m[2] === arg
}

let permResolve = null
const askNative = async (name, input) => {
  await runHooks('PermissionRequest', { tool_name: name, tool_input: input, permission_mode: 'default' }, name)
  out(`\r\n${ESC}[1mDo you want to proceed?${ESC}[0m\r\n❯ 1. Yes\r\n  2. No\r\n`)
  return new Promise(res => (permResolve = res))
}

async function callTool(name, mode, arg) {
  const input = name === 'Bash' ? { command: arg } : { file_path: arg }
  const run = async () => { out(`\r\nTOOL-RUN ${name} ${arg}\r\n`); await runHooks('PostToolUse', { tool_name: name, tool_input: input }, name) }
  const pre = await runHooks('PreToolUse', { tool_name: name, tool_input: input, permission_mode: mode }, name)
  const dec = pre?.hookSpecificOutput?.permissionDecision
  if (dec === 'deny') return out(`\r\nTOOL-DENIED-HOOK ${pre.hookSpecificOutput.permissionDecisionReason}\r\n`)
  if (dec === 'allow') return run()
  if ((settings.permissions?.deny ?? []).some(r => naive(r, name, arg))) return out(`\r\nTOOL-DENIED-NATIVE ${name} ${arg}\r\n`)
  if ((settings.permissions?.allow ?? []).some(r => naive(r, name, arg))) return run()
  if (mode !== 'default') return run()
  const yes = await askNative(name, input)
  if (yes) return run()
  out(`\r\nTOOL-DENIED-TERMINAL ${name} ${arg}\r\n`)
}

out(`${ESC}[38;2;215;119;87m▐▛███▜▌${ESC}[0m ${ESC}[1mFake Code${ESC}[0m v0.0.1\r\n`)
out(`${ESC}[2m${'─'.repeat(40)}${ESC}[0m\r\n`)
out(`FAKE-READY ${size()} agent=${process.env.AGENT_ID ?? '-'} áéí ✓ 日本語\r\n`)
out(`FAKE-ARGS ${JSON.stringify(process.argv.slice(2))} cwd=${process.cwd()} mission=${process.env.MISSION_ID ?? '-'}\r\n`)
const prompt = () => out(`${ESC}[2m❯ ${ESC}[0m`)
prompt()

let line = ''
let busy = false
process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.setEncoding('utf8')
process.stdout.on('resize', () => out(`\r\nRESIZE ${size()}\r\n`))

async function submit(l) {
  busy = true
  await runHooks('UserPromptSubmit', { prompt: l })
  if (/^permiso/.test(l)) { const y = await askNative('Bash', { command: 'x' }); out(y ? '\r\nPERMISO-OK\r\n' : '\r\nPERMISO-NO\r\n') }
  else if (l === 'ansi') out(`\r\n${ESC}[38;2;215;119;87mTRUECOLOR${ESC}[0m ${ESC}[1;4mNEGRITA${ESC}[0m ${ESC}[48;5;196m256${ESC}[0m ▐▛███▜▌ áéí ✓ 日本語\r\n`)
  else if (l === 'env') out(`\r\nENVDUMP ${JSON.stringify(process.env)}\r\n`)
  else if (l.startsWith('tool ')) { const [, name, mode, ...rest] = l.split(' '); await callTool(name, mode, rest.join(' ')) }
  else out(`\r\neco: ${l}\r\n`)
  await runHooks('Stop', {})
  busy = false
  prompt()
}

process.stdin.on('data', d => {
  for (const ch of d) {
    if (ch === '\x03' || ch === '\x04') { out('\r\nbye\r\n'); process.exit(0) }
    if (permResolve) {
      if (ch === '1' || ch === '\r') { const r = permResolve; permResolve = null; r(true) }
      else if (ch === '2' || ch === '\x1b') { const r = permResolve; permResolve = null; r(false) }
      continue
    }
    if (busy) continue
    if (ch === '\r') { const l = line; line = ''; void submit(l) }
    else if (ch === '\x7f') { if (line) { line = line.slice(0, -1); out('\b \b') } }
    else if (ch >= ' ') { line += ch; out(ch) }
  }
})
}
