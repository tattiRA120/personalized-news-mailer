import { defineConfig } from 'vite'
import honox from 'honox/vite'
import build from '@hono/vite-build/cloudflare-workers'
import path from 'path'

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
            resolve: {
                alias: {
                    'cloudflare:workers': path.resolve(__dirname, 'src/mocks/cloudflare-workers.ts'),
                    'linalg-wasm-bg.wasm': path.resolve(__dirname, 'src/mocks/wasm-module.ts')
                }
            },
            plugins: [
                honox(),
                build({
                    entry: 'app/server.ts'
                }),
                {
                    name: 'export-durable-objects',
                    apply: 'build',
                    generateBundle(options, bundle) {
                        for (const fileName in bundle) {
                            const chunk = bundle[fileName];
                            if (chunk.type === 'chunk' && chunk.isEntry) {
                                chunk.code = chunk.code.replace(
                                    /export\s*\{\s*([a-zA-Z0-9_$]+)\s*as\s*default\s*\};/g,
                                    'export { $1 as default }; export const ClickLogger = $1.ClickLogger; export const BatchQueueDO = $1.BatchQueueDO; export const WasmDO = $1.WasmDO;'
                                );
                            }
                        }
                    }
                }
            ],
            build: {
                rollupOptions: {
                    external: [/^cloudflare:/, /\.wasm$/, 'linalg-wasm-bg.wasm'],
                    output: {
                        paths: {
                            'linalg-wasm-bg.wasm': './linalg_wasm_bg.wasm'
                        }
                    }
                }
            }
        }
    }
})
