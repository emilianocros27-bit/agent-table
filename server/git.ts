import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Ejecuta git sin shell; los argumentos nunca se interpretan como comandos. */
export function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim()))
      else resolve(stdout.toString().trim())
    })
  })
}

export async function assertRepoWithCommit(project: string): Promise<string> {
  try {
    await git(project, 'rev-parse', '--is-inside-work-tree')
  } catch {
    throw new Error('La carpeta del proyecto no es un repositorio git')
  }
  try {
    return await git(project, 'rev-parse', 'HEAD')
  } catch {
    throw new Error('El repositorio no tiene ningún commit; haz uno antes de lanzar agentes')
  }
}

/** Añade patrones a .git/info/exclude (común a todos los worktrees) sin tocar archivos versionados. */
export async function ensureExcluded(project: string, patterns: string[]) {
  const rel = await git(project, 'rev-parse', '--git-path', 'info/exclude')
  const file = path.resolve(project, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const missing = patterns.filter(p => !cur.split('\n').includes(p))
  if (missing.length) fs.appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n')
}

export const slug = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'agente'
