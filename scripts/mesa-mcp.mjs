#!/usr/bin/env node
// Servidor MCP (stdio, JSON-RPC por líneas) de Mesa de Agentes. No guarda nada: cada herramienta
// llama al backend (MESA_URL) con el token propio de este agente. Se registra por worktree en .mcp.json.
import readline from 'node:readline'

const URL_BASE = process.env.MESA_URL
const AGENT = process.env.AGENT_ID
const TOKEN = process.env.MESA_HOOK_TOKEN

const str = d => ({ type: 'string', description: d })
const TOOLS = [
  { name: 'send_message', description: 'Envía un mensaje a otro agente de la misión (por nombre) o a «todos».', inputSchema: { type: 'object', properties: { to: str('Nombre del agente destinatario, o «todos»'), texto: str('Contenido del mensaje') }, required: ['to', 'texto'] } },
  { name: 'read_inbox', description: 'Lee y marca como leídos los mensajes que otros agentes te enviaron.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_tasks', description: 'Lista las tareas de la misión con su estado y quién las tomó.', inputSchema: { type: 'object', properties: {} } },
  { name: 'claim_task', description: 'Toma una tarea pendiente para trabajar en ella.', inputSchema: { type: 'object', properties: { id: { type: 'integer', description: 'Número de la tarea' } }, required: ['id'] } },
  { name: 'complete_task', description: 'Marca como hecha una tarea que tomaste, con su resultado.', inputSchema: { type: 'object', properties: { id: { type: 'integer', description: 'Número de la tarea' }, resultado: str('Qué se hizo y dónde (rama, archivos)') }, required: ['id', 'resultado'] } },
  { name: 'post_status', description: 'Publica una línea breve sobre lo que estás haciendo, visible para el usuario y los demás agentes.', inputSchema: { type: 'object', properties: { texto: str('Estado actual') }, required: ['texto'] } },
]

const COORD_TOOLS = [
  { name: 'create_task', description: 'Solo coordinador: crea una tarea para la misión, opcionalmente dirigida a un agente por nombre.', inputSchema: { type: 'object', properties: { titulo: str('Qué hay que entregar, concreto y verificable'), para: str('Nombre del agente que debe tomarla (opcional)') }, required: ['titulo'] } },
  { name: 'publish_result', description: 'Solo coordinador: publica el resultado final de la misión (se muestra al usuario).', inputSchema: { type: 'object', properties: { texto: str('Resumen del resultado final y dónde está (rama, archivos)') }, required: ['texto'] } },
]
if (process.env.MESA_COORDINATOR === '1') TOOLS.push(...COORD_TOOLS)

const send = o => process.stdout.write(JSON.stringify(o) + '\n')
const ok = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function callTool(name, args) {
  if (!URL_BASE || !AGENT || !TOKEN) return { isError: true, content: [{ type: 'text', text: 'Mesa de Agentes no está configurada en este proceso (faltan MESA_URL, AGENT_ID o MESA_HOOK_TOKEN)' }] }
  try {
    const r = await fetch(`${URL_BASE}/agent-api/${name}?agent=${encodeURIComponent(AGENT)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(15000),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) return { isError: true, content: [{ type: 'text', text: body.error ?? `Error ${r.status}` }] }
    return { content: [{ type: 'text', text: JSON.stringify(body.result, null, 2) }] }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `No se pudo contactar con Mesa de Agentes: ${e.message}` }] }
  }
}

readline.createInterface({ input: process.stdin }).on('line', async line => {
  let m
  try { m = JSON.parse(line) } catch { return }
  const { id, method, params } = m
  if (id === undefined) return // notificaciones (initialized, cancelled...)
  switch (method) {
    case 'initialize':
      return ok(id, { protocolVersion: params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mesa', version: '1.0.0' } })
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, { tools: TOOLS })
    case 'tools/call':
      if (!TOOLS.some(t => t.name === params?.name)) return fail(id, -32602, `Herramienta desconocida: ${params?.name}`)
      return ok(id, await callTool(params.name, params.arguments))
    default:
      return fail(id, -32601, `Método no soportado: ${method}`)
  }
})
