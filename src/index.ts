
import { Hono } from 'hono';
import { Env } from './types/bindings';
import { loggerMiddleware } from './middlewares/logger';
import { Logger } from './logger';
import { orchestrateMailDelivery } from './orchestrators/mailOrchestrator';

// Route imports
import authRoutes from './routes/auth';
import trackingRoutes from './routes/tracking';
import articleRoutes from './routes/articles';
import userRoutes from './routes/user';
import debugRoutes from './routes/debug';
import staticRoutes from './routes/static';
import wasmRoutes from './routes/wasm';

const app = new Hono<{ Bindings: Env }>();

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

export default {
    fetch: app.fetch,
    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        // Scheduled task logic remains same
        await orchestrateMailDelivery(env, new Date(controller.scheduledTime));
    },
};

// Exports for Durable Objects
export { ClickLogger } from './clickLogger';
export { BatchQueueDO } from './batchQueueDO';
export { WasmDO } from './wasmDO';
