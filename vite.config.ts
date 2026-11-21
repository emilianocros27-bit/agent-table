import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'web/src') } },
  build: { outDir: '../dist/web', emptyOutDir: true },
})
