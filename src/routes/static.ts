
import { Hono } from 'hono';
import { Env } from '../types/bindings';

const app = new Hono<{ Bindings: Env }>();

app.get('/public/*', async (c) => {
    const url = new URL(c.req.url);
    const assetPath = url.pathname.replace('/public', '');
    const response = await c.env.ASSETS.fetch(new Request(new URL(assetPath, c.req.url)));

    if (response.status === 404) {
        if (assetPath === '/') {
            const indexHtmlResponse = await c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)));
            if (indexHtmlResponse.ok) {
                return indexHtmlResponse;
            }
        }
        return new Response('Not Found', { status: 404 });
    }
    return response;
});

export default app;
