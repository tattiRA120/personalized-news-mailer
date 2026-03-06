import { createApp } from 'honox/server'
import { Env } from '../src/types/bindings';
import { loggerMiddleware } from '../src/middlewares/logger';
import { orchestrateMailDelivery } from '../src/orchestrators/mailOrchestrator';
import { showRoutes } from 'hono/dev'
import type { ScheduledController, ExecutionContext } from '@cloudflare/workers-types';

// Route imports
import authRoutes from '../src/routes/auth';
import trackingRoutes from '../src/routes/tracking';
import articleRoutes from '../src/routes/articles';
import userRoutes from '../src/routes/user';
import debugRoutes from '../src/routes/debug';
import staticRoutes from '../src/routes/static';
import wasmRoutes from '../src/routes/wasm';

const app = createApp<{ Bindings: Env }>()

// Global Middleware
app.use('*', loggerMiddleware);

// Mount Routes
app.route('/', authRoutes);
app.route('/', trackingRoutes);
app.route('/', articleRoutes);
app.route('/', userRoutes);
app.route('/', debugRoutes);
app.route('/', wasmRoutes);
app.route('/', staticRoutes);

showRoutes(app)

// Exports for Durable Objects
import { ClickLogger } from '../src/clickLogger';
import { BatchQueueDO } from '../src/batchQueueDO';
import { WasmDO } from '../src/wasmDO';

export default {
    fetch: app.fetch,
    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        // Scheduled task logic remains same
        await orchestrateMailDelivery(env, new Date(controller.scheduledTime));
    },
    ClickLogger,
    BatchQueueDO,
    WasmDO,
};

export { ClickLogger, BatchQueueDO, WasmDO };
