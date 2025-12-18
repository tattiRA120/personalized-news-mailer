
import { ClickLogger } from '../clickLogger';
import { BatchQueueDO } from '../batchQueueDO';
import { WasmDO } from '../wasmDO';

export interface Env {
    DB: D1Database;
    CLICK_LOGGER: DurableObjectNamespace<ClickLogger>;
    BATCH_QUEUE_DO: DurableObjectNamespace<BatchQueueDO>;
    WASM_DO: DurableObjectNamespace<WasmDO>;
    OPENAI_API_KEY?: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    GOOGLE_REDIRECT_URI: string;
    'mail-news-gmail-tokens': KVNamespace;
    BATCH_CALLBACK_TOKENS: KVNamespace;
    WORKER_BASE_URL?: string;
    DEBUG_API_KEY?: string;
    ASSETS: Fetcher; // ASSETS binding for static assets
    LOG_LEVEL?: string;
    GOOGLE_NEWS_DECODER_API_URL: string;
    DECODER_SECRET: string;
}
