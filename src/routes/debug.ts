
import { Hono } from 'hono';
import { Env } from '../types/bindings';
import { getLogger } from '../middlewares/logger';
import { debugAuthMiddleware } from '../middlewares/auth';
import { collectNews, NewsArticle } from '../newsCollector';
import { saveArticlesToD1 } from '../services/d1Service';
import { generateAndSaveEmbeddings } from '../services/embeddingService';
import { orchestrateMailDelivery } from '../orchestrators/mailOrchestrator';

const app = new Hono<{ Bindings: Env }>();

// Unprotected route (Preserving original behavior, though potentially risky)
app.post('/delete-all-durable-object-data', async (c) => {
    const logger = getLogger(c);
    logger.debug('Request received to delete all Durable Object data');
    try {
        const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
        const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);

        const deleteResponse = await clickLogger.fetch(
            new Request(new URL('/delete-all-data', c.req.url), {
                method: 'POST',
            })
        );

        if (deleteResponse.ok) {
            logger.debug('Successfully triggered deletion of all bandit models.');
            return new Response('Triggered deletion of all bandit models.', { status: 200 });
        } else {
            logger.error(`Failed to trigger deletion of all bandit models: ${deleteResponse.statusText}`, null, { status: deleteResponse.status, statusText: deleteResponse.statusText });
            return new Response('Failed to trigger deletion.', { status: 500 });
        }

    } catch (error) {
        logger.error('Error during deletion of all Durable Object data:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error', { status: 500 });
    }
});

// Group debug routes
const debug = new Hono<{ Bindings: Env }>();
debug.use('*', debugAuthMiddleware);

debug.post('/force-embed-articles', async (c) => {
    const logger = getLogger(c);
    logger.debug('Debug: Force embed articles request received');

    try {
        logger.debug('Debug: Starting news collection for force embedding...');
        const articles: NewsArticle[] = await collectNews(c.env);
        logger.debug(`Debug: Collected ${articles.length} articles for force embedding.`, { articleCount: articles.length });

        if (articles.length === 0) {
            logger.debug('Debug: No articles collected for force embedding. Skipping further steps.');
            return new Response('No articles collected', { status: 200 });
        }

        const articlesToSaveToD1: NewsArticle[] = articles.map(article => ({
            articleId: article.articleId,
            title: article.title,
            link: article.link,
            sourceName: article.sourceName,
            summary: article.summary,
            content: article.content,
            publishedAt: article.publishedAt || Date.now(),
        }));
        await saveArticlesToD1(articlesToSaveToD1, c.env);
        logger.debug(`Debug: Saved ${articlesToSaveToD1.length} articles to D1 temporarily for force embedding.`, { count: articlesToSaveToD1.length });

        await generateAndSaveEmbeddings(articles, c.env, 'debug-user', true);

        return c.json({ message: 'Batch embedding job initiated successfully (debug mode).' }, 200);
    } catch (error) {
        logger.error('Debug: Error during force embedding process:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error during force embedding', { status: 500 });
    }
});

debug.post('/delete-user-data', async (c) => {
    const logger = getLogger(c);
    logger.debug('Debug: Delete user data request received');

    try {
        const { userId } = await c.req.json() as { userId: string };
        if (!userId) {
            logger.warn('Debug: Delete user data failed: Missing userId in request body.');
            return new Response('Missing userId', { status: 400 });
        }

        logger.debug(`Debug: Deleting user data for user ${userId} from DB...`, { userId });

        await c.env.DB.prepare(`DELETE FROM users WHERE user_id = ?`).bind(userId).run();
        logger.debug(`Debug: Deleted user profile for ${userId}.`, { userId });

        await c.env.DB.prepare(`DELETE FROM click_logs WHERE user_id = ?`).bind(userId).run();
        logger.debug(`Debug: Deleted click logs for ${userId}.`, { userId });

        await c.env.DB.prepare(`DELETE FROM sent_articles WHERE user_id = ?`).bind(userId).run();
        logger.debug(`Debug: Deleted sent articles for ${userId}.`, { userId });

        await c.env.DB.prepare(`DELETE FROM education_logs WHERE user_id = ?`).bind(userId).run();
        logger.debug(`Debug: Deleted education logs for ${userId}.`, { userId });

        await c.env['mail-news-gmail-tokens'].delete(`refresh_token:${userId}`);
        logger.debug(`Debug: Deleted Gmail refresh token for ${userId}.`, { userId });

        logger.debug(`Debug: Successfully deleted all data for user ${userId}.`, { userId });
        return c.json({ message: `User data for ${userId} deleted successfully.` }, 200);

    } catch (error) {
        logger.error('Debug: Error during user data deletion:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error during user data deletion', { status: 500 });
    }
});

debug.post('/trigger-batch-alarm', async (c) => {
    const logger = getLogger(c);
    logger.debug('Debug: Trigger BatchQueueDO alarm request received');

    try {
        const batchQueueDOId = c.env.BATCH_QUEUE_DO.idFromName("batch-embedding-queue");
        const batchQueueDOStub = c.env.BATCH_QUEUE_DO.get(batchQueueDOId);
        const doResponse = await batchQueueDOStub.fetch(
            new Request(`${c.env.WORKER_BASE_URL}/debug/trigger-alarm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            })
        );
        if (doResponse.ok) {
            logger.debug('Debug: Successfully triggered BatchQueueDO alarm.');
            return new Response('BatchQueueDO alarm triggered successfully.', { status: 200 });
        } else {
            logger.error(`Debug: Failed to trigger BatchQueueDO alarm: ${doResponse.statusText}`, null, { status: doResponse.status, statusText: doResponse.statusText });
            return new Response(`Failed to trigger BatchQueueDO alarm: ${doResponse.statusText}`, { status: doResponse.status });
        }
    } catch (error) {
        logger.error('Debug: Error triggering BatchQueueDO alarm:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error during BatchQueueDO alarm trigger', { status: 500 });
    }
});

debug.post('/send-test-email', async (c) => {
    const logger = getLogger(c);
    logger.debug('Debug: Send test email request received');

    try {
        await orchestrateMailDelivery(c.env, new Date(), true);
        logger.debug('Debug: Test email delivery orchestrated successfully.');
        return c.json({ message: 'Test email delivery orchestrated successfully.' }, 200);
    } catch (error) {
        logger.error('Debug: Error during test email delivery:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error during test email delivery', { status: 500 });
    }
});

debug.post('/generate-oauth-url', async (c) => {
    const logger = getLogger(c);
    logger.debug('Debug: Generate OAuth URL request received');

    try {
        const { email } = await c.req.json() as { email: string };
        if (!email) {
            logger.warn('Debug: Generate OAuth URL failed: Missing email in request body.');
            return new Response('Missing email', { status: 400 });
        }

        const encoder = new TextEncoder();
        const data = encoder.encode(email);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const userId = Array.from(new Uint8Array(hashBuffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

        if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_REDIRECT_URI) {
            logger.error('Missing Google OAuth environment variables for consent URL generation.', null);
            return new Response('Server configuration error', { status: 500 });
        }

        const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authUrl.searchParams.set('client_id', c.env.GOOGLE_CLIENT_ID);
        authUrl.searchParams.set('redirect_uri', c.env.GOOGLE_REDIRECT_URI);
        authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.send');
        authUrl.searchParams.set('access_type', 'offline');
        authUrl.searchParams.set('prompt', 'consent');
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('state', userId);

        logger.debug(`Debug: Generated OAuth consent URL for user ${userId}`, { userId, authUrl: authUrl.toString() });

        return c.json({ message: 'OAuth consent URL generated.', authUrl: authUrl.toString() }, 200);

    } catch (error) {
        logger.error('Debug: Error during OAuth URL generation:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error during OAuth URL generation', { status: 500 });
    }
});

debug.post('/process-pending-feedback', async (c) => {
    const logger = getLogger(c);
    logger.debug('Debug: Process pending feedback request received');

    try {
        const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
        const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);
        const doResponse = await clickLogger.fetch(
            new Request(`${c.env.WORKER_BASE_URL}/debug/process-pending-feedback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            })
        );
        if (doResponse.ok) {
            logger.debug('Debug: Successfully triggered processPendingFeedback.');
            return new Response('ProcessPendingFeedback triggered successfully.', { status: 200 });
        } else {
            const errorText = await doResponse.text();
            logger.error(`Debug: Failed to trigger processPendingFeedback: ${doResponse.statusText}`, null, { status: doResponse.status, statusText: doResponse.statusText, errorText });
            return new Response(`Failed to trigger processPendingFeedback: ${doResponse.statusText} - ${errorText}`, { status: doResponse.status });
        }
    } catch (error) {
        logger.error('Debug: Error triggering processPendingFeedback:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error during processPendingFeedback trigger', { status: 500 });
    }
});

debug.get('/check-exclusions', async (c) => {
    const logger = getLogger(c);
    logger.debug('Debug: Check exclusions request received');

    try {
        const userId = c.req.query('userId');
        if (!userId) return new Response('Missing userId', { status: 400 });

        // 1. User's feedback history
        const feedbackLogs = await c.env.DB.prepare(`SELECT article_id, action, timestamp FROM education_logs WHERE user_id = ?`).bind(userId).all();

        // 2. Articles that WOULD be returned without exclusion
        const cutoffDate = new Date();
        cutoffDate.setHours(cutoffDate.getHours() - 24);
        const cutoffTimestamp = cutoffDate.getTime();

        const candidates = await c.env.DB.prepare(`SELECT article_id, title, published_at FROM articles WHERE embedding IS NOT NULL AND published_at >= ? LIMIT 50`).bind(cutoffTimestamp).all();

        return c.json({
            feedbackLogs: feedbackLogs.results,
            candidates: candidates.results,
            cutoffTimestamp
        }, 200);
    } catch (e) {
        return c.json({ error: String(e) }, 500);
    }
});

// Mount debug routes
app.route('/debug', debug);

export default app;
