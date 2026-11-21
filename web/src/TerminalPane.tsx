import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { wsUrl } from './api'

/** Terminal pura: los bytes del PTY van a xterm.js tal cual. Nada se dibuja encima. */
export function TerminalPane({ agentId }: { agentId: string }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current!
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, "SF Mono", Monaco, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(el)

    let ws: WebSocket | null = null
    let closed = false
    let retry = 0
    let timer: number | undefined

    const send = (o: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o))

    const connect = () => {
      ws = new WebSocket(wsUrl(`/ws/term/${agentId}`))
      ws.onopen = () => {
        retry = 0
        fit.fit()
        send({ t: 'attach', cols: term.cols, rows: term.rows })
      }
      ws.onmessage = ev => term.write(ev.data as string)
      ws.onclose = ev => {
        if (closed || ev.code === 1000 || ev.code === 4404) return
        timer = window.setTimeout(connect, Math.min(5000, 500 * 2 ** retry++))
      }
    }

    term.onData(d => send({ t: 'in', d }))
    term.onResize(({ cols, rows }) => send({ t: 'resize', cols, rows }))

    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit()
      })
    })
    ro.observe(el)
    fit.fit()
    connect()

    return () => {
      closed = true
      clearTimeout(timer)
      cancelAnimationFrame(raf)
      ro.disconnect()
      ws?.close()
      term.dispose()
    }
  }, [agentId])

  return <div className="term-host" ref={host} />
}
