
import { Context, MiddlewareHandler } from 'hono';
import { Logger } from '../logger';
import { Env } from '../types/bindings';

declare module 'hono' {
    interface ContextVariableMap {
        logger: Logger;
    }
}

export const loggerMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    c.set('logger', new Logger(c.env));
    await next();
};

export const getLogger = (c: Context) => {
    return c.get('logger') as Logger;
};
