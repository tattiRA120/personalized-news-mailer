import { DurableObject } from "cloudflare:workers";

// WASMモジュールをインポート
import init, { cosine_similarity } from '../linalg-wasm/pkg/linalg_wasm.js';
import wasmModule from '../linalg-wasm/pkg/linalg_wasm_bg.wasm';

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
        if (!this.wasmInitialized) {
            return new Response("WASM is not initialized yet. Please try again.", { status: 503 });
        }

        const url = new URL(request.url);
        const vec1Param = url.searchParams.get("vec1");
        const vec2Param = url.searchParams.get("vec2");

        if (!vec1Param || !vec2Param) {
            return new Response("Missing vec1 or vec2 parameters. Please provide JSON arrays.", { status: 400 });
        }

        try {
            const vec1 = JSON.parse(vec1Param);
            const vec2 = JSON.parse(vec2Param);

            if (!Array.isArray(vec1) || !Array.isArray(vec2)) {
                return new Response("vec1 and vec2 must be JSON arrays.", { status: 400 });
            }

            // WASMモジュールの関数を呼び出す
            const result = cosine_similarity(vec1, vec2); // linalg_wasmのcosine_similarity関数を呼び出す

            return new Response(JSON.stringify({
                vec1: vec1,
                vec2: vec2,
                result: result,
                message: `WASM cosine_similarity function executed in Durable Object.`
            }), { headers: { "Content-Type": "application/json" } });

        } catch (e: any) {
            console.error(`Error executing WASM function:`, e);
            return new Response(JSON.stringify({
                error: `Failed to execute WASM function: ${e.message || e}`
            }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }
}
