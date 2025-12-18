
import { Hono } from 'hono';
import { Env } from '../types/bindings';
import { getLogger } from '../middlewares/logger';

const app = new Hono<{ Bindings: Env }>();

app.all('/wasm-do/*', async (c) => {
    const logger = getLogger(c);
    const path = new URL(c.req.url).pathname;

    logger.debug('WASM Durable Object request received');
    try {
        const wasmDOId = c.env.WASM_DO.idFromName("wasm-calculator");
        const wasmDOStub = c.env.WASM_DO.get(wasmDOId);

        // WasmDO が期待するパスに変換
        const wasmPath = path.replace('/wasm-do', '');
        const wasmUrl = new URL(wasmPath, c.env.WORKER_BASE_URL);
        logger.debug(`Forwarding WASM DO request to: ${wasmUrl.toString()}`, { wasmUrl: wasmUrl.toString() });

        const wasmRequest = new Request(wasmUrl, {
            method: c.req.method,
            headers: c.req.raw.headers,
            body: c.req.raw.body,
        });

        logger.info(`Forwarding to WASM DO`, {
            originalPath: path,
            transformedPath: wasmPath,
            wasmUrl: wasmUrl.toString(),
            method: c.req.method
        });

        const doResponse = await wasmDOStub.fetch(wasmRequest); // リクエストをDOに転送

        logger.info(`WASM DO response received`, {
            status: doResponse.status,
            statusText: doResponse.statusText,
            path: path
        });

        return doResponse;

    } catch (error) {
        logger.error('Error during WASM Durable Object invocation:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error during WASM Durable Object invocation', { status: 500 });
    }
});

export default app;
