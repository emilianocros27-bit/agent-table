import fs from 'node:fs'
import path from 'node:path'

/** Estado en un archivo JSON, escritura atómica (tmp + rename). */
export class JsonStore<T> {
  private file: string
  constructor(dir: string, name: string, private fallback: T) {
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, name)
  }
  load(): T {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as T
    } catch {
      return structuredClone(this.fallback)
    }
  }
  save(value: T) {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, this.file)
  }
}
