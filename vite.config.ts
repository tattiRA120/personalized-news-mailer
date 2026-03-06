import { defineConfig } from 'vite'
import honox from 'honox/vite'
import build from '@hono/vite-build/cloudflare-workers'

export default defineConfig(({ mode }) => {
    if (mode === 'client') {
        return {
            build: {
                rollupOptions: {
                    input: ['./app/client.ts'],
                    output: {
                        entryFileNames: 'static/client.js',
                        chunkFileNames: 'static/assets/[name]-[hash].js',
                        assetFileNames: 'static/assets/[name].[ext]',
                    },
                },
                emptyOutDir: false,
            },
        }
    } else {
        return {
            plugins: [
                honox(),
                build({
                    entry: 'app/server.ts'
                })
            ],
            build: {
                rollupOptions: {
                    external: [/^cloudflare:/, /\.wasm$/, 'linalg-wasm-bg.wasm', 'LINALG_WASM']
                }
            }
        }
    }
})
