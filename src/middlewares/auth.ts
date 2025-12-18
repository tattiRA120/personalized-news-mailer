
import { MiddlewareHandler } from 'hono';
import { Env } from '../types/bindings';
import { getLogger } from './logger';

export const debugAuthMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    const logger = getLogger(c);
    const debugApiKey = c.req.header('X-Debug-Key');

    // Debug API key check
    if (debugApiKey !== c.env.DEBUG_API_KEY) {
        logger.warn('Debug: Unauthorized access attempt', { providedKey: debugApiKey, url: c.req.url });
        return new Response('Unauthorized', { status: 401 });
    }
    await next();
};
