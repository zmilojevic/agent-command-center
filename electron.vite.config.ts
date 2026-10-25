import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: 'es' } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: 'es' } } },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html'), mobile: resolve('src/renderer/mobile.html') } } },
  },
})
