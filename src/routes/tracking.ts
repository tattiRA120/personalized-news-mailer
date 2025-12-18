
import { Hono } from 'hono';
import { Env } from '../types/bindings';
import { getLogger } from '../middlewares/logger';
import { decodeHtmlEntities } from '../utils/htmlDecoder';

const app = new Hono<{ Bindings: Env }>();

// --- Click Tracking Handler ---
app.get('/track-click', async (c) => {
    const logger = getLogger(c);
    logger.debug('Click tracking request received');
    const userId = c.req.query('userId');
    const articleId = c.req.query('articleId');
    const encodedRedirectUrl = c.req.query('redirectUrl');

    if (!userId || !articleId || !encodedRedirectUrl) {
        logger.warn('Click tracking failed: Missing userId, articleId, or redirectUrl.');
        return new Response('Missing parameters', { status: 400 });
    }

    let redirectUrl: string;
    try {
        // まずURLエンコードをデコードし、次にHTMLエンティティをデコードする
        const decodedUri = decodeURIComponent(encodedRedirectUrl);
        redirectUrl = decodeHtmlEntities(decodedUri);
    } catch (e) {
        logger.error('Click tracking failed: Invalid redirectUrl encoding or HTML entities.', e, { encodedRedirectUrl });
        return new Response('Invalid redirectUrl encoding or HTML entities', { status: 400 });
    }

    try {
        const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
        const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);

        const logClickResponse = await clickLogger.fetch(
            new Request(`${c.env.WORKER_BASE_URL}/log-click`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: userId, articleId: articleId, timestamp: Date.now() }),
            })
        );

        if (logClickResponse.ok) {
            logger.debug(`Click logged successfully for user ${userId}, article ${articleId}`, { userId, articleId });
        } else {
            logger.error(`Failed to log click for user ${userId}, article ${articleId}: ${logClickResponse.statusText}`, null, { userId, articleId, status: logClickResponse.status, statusText: logClickResponse.statusText });
        }

        return c.redirect(redirectUrl, 302);

    } catch (error) {
        logger.error('Error during click tracking:', error, { userId, articleId, redirectUrl, requestUrl: c.req.url });
        return new Response('Internal Server Error', { status: 500 });
    }
});

// --- Feedback Tracking Handler ---
app.get('/track-feedback', async (c) => {
    const logger = getLogger(c);
    logger.debug('Feedback tracking request received');
    const userId = c.req.query('userId');
    const articleId = c.req.query('articleId');
    const feedback = c.req.query('feedback'); // 'interested' or 'not_interested'

    if (!userId || !articleId || !feedback) {
        logger.warn('Feedback tracking failed: Missing userId, articleId, or feedback.');
        return new Response('Missing parameters', { status: 400 });
    }

    if (feedback !== 'interested' && feedback !== 'not_interested') {
        logger.warn(`Invalid feedback value: ${feedback}`);
        return new Response('Invalid feedback value', { status: 400 });
    }

    try {
        const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
        const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);

        const logFeedbackResponse = await clickLogger.fetch(
            new Request(`${c.env.WORKER_BASE_URL}/log-feedback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, articleId, feedback, timestamp: Date.now(), immediateUpdate: false }),
            })
        );

        if (logFeedbackResponse.ok) {
            logger.debug(`Feedback logged successfully for user ${userId}, article ${articleId}, feedback: ${feedback}`, { userId, articleId, feedback });
        } else {
            logger.error(`Failed to log feedback for user ${userId}, article ${articleId}: ${logFeedbackResponse.statusText}`, null, { userId, articleId, status: logFeedbackResponse.status, statusText: logFeedbackResponse.statusText });
        }

        // ユーザーにフィードバックが記録されたことを伝える簡単なメッセージを返す
        return new Response('フィードバックありがとうございます！', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });

    } catch (error) {
        logger.error('Error during feedback tracking:', error, { userId, articleId, feedback, requestUrl: c.req.url });
        return new Response('Internal Server Error', { status: 500 });
    }
});

// --- Batch Feedback Handler ---
app.post('/track-feedback-batch', async (c) => {
    const logger = getLogger(c);
    try {
        const { userId, feedbackData, immediateUpdate } = await c.req.json() as {
            userId: string,
            feedbackData: { articleId: string, feedback: 'interested' | 'not_interested' }[],
            immediateUpdate?: boolean
        };

        logger.info(`Batch feedback request: userId=${userId}, count=${feedbackData?.length}, immediateUpdate=${immediateUpdate}`);

        if (!userId || !Array.isArray(feedbackData)) {
            return new Response('Missing parameters', { status: 400 });
        }

        const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
        const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);

        // Process feedback in parallel
        const promises = feedbackData.map(item => {
            return clickLogger.fetch(new Request(`${c.env.WORKER_BASE_URL}/log-feedback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId,
                    articleId: item.articleId,
                    feedback: item.feedback,
                    timestamp: Date.now(),
                    immediateUpdate: immediateUpdate
                })
            }));
        });

        await Promise.all(promises);

        return c.json({ message: 'Batch feedback processed' }, 200);
    } catch (error) {
        logger.error('Error processing batch feedback:', error);
        return new Response('Internal Server Error', { status: 500 });
    }
});

export default app;
