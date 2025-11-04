import { DurableObject } from "cloudflare:workers";

// WASMモジュールをインポート
import init, { cosine_similarity } from '../linalg-wasm/pkg/linalg_wasm.js';
import wasmModule from '../linalg-wasm/pkg/linalg_wasm_bg.wasm';
import { cosine_similarity_bulk, calculate_similarity_matrix } from '../linalg-wasm/pkg/linalg_wasm';

// 環境変数の型定義
interface Env {
    WASM_DO: DurableObjectNamespace<WasmDO>;
}

export class WasmDO extends DurableObject<Env> {
    private wasmInitialized: boolean = false;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        ctx.waitUntil(this.initializeWasm());
    }

    async initializeWasm() {
        if (!this.wasmInitialized) {
            try {
                await init(wasmModule);
                this.wasmInitialized = true;
                console.log("WASM initialized successfully in Durable Object.");
            } catch (e) {
                console.error("Failed to initialize WASM in Durable Object:", e);
                throw new Error(`WASM initialization failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        let path = url.pathname;

        // Durable Object が期待するパスに変換するため、/wasm-do を削除
        if (path.startsWith('/wasm-do')) {
            path = path.replace('/wasm-do', '');
        }

        if (!this.wasmInitialized) {
            return new Response("WASM is not initialized yet. Please try again.", { status: 503 });
        }

        try {
            if (path === '/bulk-cosine-similarity') {
                const { vec1s, vec2s } = await request.json() as { vec1s: number[][], vec2s: number[][] };

                if (!vec1s || !vec2s || !Array.isArray(vec1s) || !Array.isArray(vec2s)) {
                    return new Response("Missing or invalid vec1s or vec2s in request body. Please provide JSON arrays of arrays.", { status: 400 });
                }

                const results = cosine_similarity_bulk(vec1s, vec2s);

                return new Response(JSON.stringify({
                    results: results,
                    message: `WASM cosine_similarity_bulk function executed in Durable Object.`
                }), { headers: { "Content-Type": "application/json" } });

            } else if (path === '/single-cosine-similarity') {
                const vec1Param = url.searchParams.get("vec1");
                const vec2Param = url.searchParams.get("vec2");

                if (!vec1Param || !vec2Param) {
                    return new Response("Missing vec1 or vec2 parameters. Please provide JSON arrays.", { status: 400 });
                }

                const vec1 = JSON.parse(vec1Param);
                const vec2 = JSON.parse(vec2Param);

                if (!Array.isArray(vec1) || !Array.isArray(vec2)) {
                    return new Response("vec1 and vec2 must be JSON arrays.", { status: 400 });
                }

                const result = cosine_similarity(vec1, vec2);

                return new Response(JSON.stringify({
                    vec1: vec1,
                    vec2: vec2,
                    result: result,
                    message: `WASM cosine_similarity function executed in Durable Object.`
                }), { headers: { "Content-Type": "application/json" } });
            } else if (path === '/calculate-similarity-matrix') {
                const { vectors } = await request.json() as { vectors: number[][] };

                if (!vectors || !Array.isArray(vectors)) {
                    return new Response("Missing or invalid 'vectors' in request body. Please provide a JSON array of arrays.", { status: 400 });
                }

                const results = calculate_similarity_matrix(vectors);

                return new Response(JSON.stringify({
                    results: results,
                    message: `WASM calculate_similarity_matrix function executed in Durable Object.`
                }), { headers: { "Content-Type": "application/json" } });

            } else {
                return new Response("Invalid WASM DO endpoint. Use /bulk-cosine-similarity (POST), /single-cosine-similarity (GET), or /calculate-similarity-matrix (POST).", { status: 404 });
            }

        } catch (e: any) {
            console.error(`Error executing WASM function:`, e);
            return new Response(JSON.stringify({
                error: `Failed to execute WASM function: ${e.message || e}`
            }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }
}
