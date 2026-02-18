
import { Hono } from 'hono';
import { Env } from '../types/bindings';
import { getLogger } from '../middlewares/logger';
import { NewsArticle } from '../newsCollector';
import { generateAndSaveEmbeddings } from '../services/embeddingService';
import { saveArticlesToD1, getArticlesFromD1, ArticleWithEmbedding } from '../services/d1Service';
import { getUserProfile } from '../userProfile';

const app = new Hono<{ Bindings: Env }>();

// --- Submit Education Feedback Handler ---
app.post('/submit-education-feedback', async (c) => {
    const logger = getLogger(c);
    logger.debug('Submit education feedback request received');
    try {
        const { userId, feedbackData } = await c.req.json() as {
            userId: string,
            feedbackData: { article: NewsArticle, feedback: 'interested' | 'not_interested' }[]
        };

        if (!userId || !Array.isArray(feedbackData)) {
            logger.warn('Submit education feedback failed: Missing userId or feedbackData.');
            return new Response('Missing parameters', { status: 400 });
        }

        const userProfile = await getUserProfile(userId, c.env);
        if (!userProfile) {
            return c.json({ message: 'User not found' }, 404);
        }

        logger.debug(`Processing ${feedbackData.length} feedback items for user ${userId}.`, { userId, count: feedbackData.length });

        const articlesNeedingEmbedding: NewsArticle[] = [];
        const articlesToLearn: { articleId: string; embedding: number[]; reward: number; }[] = [];

        // 1. 記事の保存とembedding確認
        const articlesToSave = feedbackData.map(item => item.article);
        // 重複排除
        const uniqueArticlesToSave = Array.from(new Map(articlesToSave.map(a => [a.articleId, a])).values());

        // D1に保存 (INSERT OR IGNORE)
        c.executionCtx.waitUntil(saveArticlesToD1(uniqueArticlesToSave, c.env));

        // 2. Embeddingの確認と取得
        const articleIds = uniqueArticlesToSave.map(a => a.articleId);
        const existingArticlesWithEmbeddingsInD1 = await getArticlesFromD1(c.env, articleIds.length, 0, `article_id IN (${articleIds.map(() => '?').join(',')}) AND embedding IS NOT NULL`, articleIds);
        const existingArticleIdsWithEmbeddingsSet = new Set(existingArticlesWithEmbeddingsInD1.map(article => article.articleId));

        for (const item of feedbackData) {
            const article = item.article;
            const feedback = item.feedback;
            const reward = feedback === 'interested' ? 20.0 : -20.0; // 興味あり: 20.0, 興味なし: -20.0 (clickLoggerの教育フィードバックと統一)

            if (existingArticleIdsWithEmbeddingsSet.has(article.articleId)) {
                const existingArticle = existingArticlesWithEmbeddingsInD1.find(a => a.articleId === article.articleId);
                if (existingArticle && existingArticle.embedding) {
                    articlesToLearn.push({
                        articleId: article.articleId,
                        embedding: existingArticle.embedding,
                        reward: reward
                    });
                }
            } else {
                articlesNeedingEmbedding.push(article);
            }
        }

        // 3. Embedding生成が必要な記事の処理
        if (articlesNeedingEmbedding.length > 0) {
            // 重複排除
            const uniqueArticlesNeedingEmbedding = Array.from(new Map(articlesNeedingEmbedding.map(a => [a.articleId, a])).values());
            logger.debug(`Generating embeddings for ${uniqueArticlesNeedingEmbedding.length} articles.`, { count: uniqueArticlesNeedingEmbedding.length });
            c.executionCtx.waitUntil(generateAndSaveEmbeddings(uniqueArticlesNeedingEmbedding, c.env, userId, false));
        }

        // 4. バンディットモデルの更新 (embeddingがある記事のみ)
        let learnSuccessCount = 0;
        let learnErrorCount = 0;

        if (articlesToLearn.length > 0) {
            const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
            const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);

            const batchSize = 10;
            for (let i = 0; i < articlesToLearn.length; i += batchSize) {
                const batch = articlesToLearn.slice(i, i + batchSize);
                try {
                    const learnResponse = await clickLogger.fetch(
                        new Request(`${c.env.WORKER_BASE_URL}/learn-from-education`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                userId: userId,
                                selectedArticles: batch
                            }),
                        })
                    );

                    if (learnResponse.ok) {
                        learnSuccessCount += batch.length;
                        logger.debug(`Successfully sent batch for learning to ClickLogger for user ${userId}.`, { userId, batchSize: batch.length });
                    } else {
                        learnErrorCount += batch.length;
                        const errorText = await learnResponse.text();
                        logger.warn(`Failed to send batch for learning to ClickLogger for user ${userId}: ${learnResponse.statusText}`, null, { userId, status: learnResponse.status, statusText: learnResponse.statusText, errorText });
                    }
                } catch (error) {
                    learnErrorCount += batch.length;
                    logger.error(`Exception when sending batch for learning to ClickLogger for user ${userId}:`, error, { userId, batchSize: batch.length });
                }
            }
        }

        const totalProcessed = articlesNeedingEmbedding.length + articlesToLearn.length;
        const message = learnErrorCount > 0
            ? `フィードバックを受け付けました。${totalProcessed}件中${learnSuccessCount}件の学習を完了しました。`
            : 'フィードバックを受け付けました。';

        logger.info(`Education feedback processed for user ${userId}. Total: ${totalProcessed}, Learned: ${learnSuccessCount}, Errors: ${learnErrorCount}, NeedEmbedding: ${articlesNeedingEmbedding.length}`, {
            userId,
            totalProcessed,
            learnSuccessCount,
            learnErrorCount,
            needEmbedding: articlesNeedingEmbedding.length
        });

        return c.json({
            message: message,
            processed: totalProcessed,
            learned: learnSuccessCount,
            errors: learnErrorCount
        }, 200);

    } catch (error) {
        logger.error('Error submitting education feedback:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error', { status: 500 });
    }
});

// --- Submit Interests Handler ---
app.post('/submit-interests', async (c) => {
    const logger = getLogger(c);
    logger.debug('Submit interests request received from public/script.js');
    try {
        const { userId, selectedArticles } = await c.req.json() as { userId: string, selectedArticles: NewsArticle[] };

        if (!userId || !Array.isArray(selectedArticles)) {
            logger.warn('Submit interests failed: Missing userId or selectedArticles in request body.');
            return new Response('Missing parameters', { status: 400 });
        }

        const userProfile = await getUserProfile(userId, c.env);

        if (!userProfile) {
            logger.warn(`Submit interests failed: User profile not found for ${userId}.`, { userId });
            return c.json({ message: 'User not found' }, 404);
        }

        logger.debug(`User selected articles received for user ${userId} from public/script.js.`, { userId, selectedArticleCount: selectedArticles.length });

        const articlesNeedingEmbedding: NewsArticle[] = [];
        const selectedArticlesWithEmbeddings: { articleId: string; embedding: number[]; }[] = [];

        // 1. 選択された記事の中から、既にD1に存在しembeddingを持っている記事を先に問い合わせる
        const articleIds = selectedArticles.map(article => article.articleId);
        const existingArticlesWithEmbeddingsInD1: ArticleWithEmbedding[] = await getArticlesFromD1(c.env, articleIds.length, 0, `article_id IN (${articleIds.map(() => '?').join(',')}) AND embedding IS NOT NULL`, articleIds);
        const existingArticleIdsWithEmbeddingsSet = new Set(existingArticlesWithEmbeddingsInD1.map(article => article.articleId));

        // 2. 新しい記事だけをD1に保存（重複はINSERT OR IGNOREでスキップされる）
        c.executionCtx.waitUntil(saveArticlesToD1(selectedArticles, c.env));
        logger.debug(`Selected articles saved to D1 for user ${userId}.`, { userId, savedArticleCount: selectedArticles.length });

        // 3. embeddingがないと判明した記事と、新たに追加した記事を対象に、embedding生成処理を開始する
        for (const selectedArticle of selectedArticles) {
            if (existingArticleIdsWithEmbeddingsSet.has(selectedArticle.articleId)) {
                // 既にembeddingが存在する記事
                const existingArticle = existingArticlesWithEmbeddingsInD1.find(a => a.articleId === selectedArticle.articleId);
                if (existingArticle && existingArticle.embedding) {
                    selectedArticlesWithEmbeddings.push({ articleId: existingArticle.articleId, embedding: existingArticle.embedding });
                }
            } else {
                // embeddingがまだ存在しない記事
                articlesNeedingEmbedding.push(selectedArticle);
            }
        }

        if (articlesNeedingEmbedding.length > 0) {
            logger.debug(`Generating embeddings for ${articlesNeedingEmbedding.length} articles. This will be processed asynchronously.`, { count: articlesNeedingEmbedding.length });
            c.executionCtx.waitUntil(generateAndSaveEmbeddings(articlesNeedingEmbedding, c.env, userId, false));
        }

        // 4. 既に埋め込みがある記事のみでバンディットモデルを更新
        if (selectedArticlesWithEmbeddings.length > 0) {
            const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
            const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);

            const batchSize = 10;
            logger.debug(`Sending selected articles with existing embeddings for learning to ClickLogger in batches of ${batchSize} for user ${userId}.`, { userId, totalCount: selectedArticlesWithEmbeddings.length, batchSize });

            for (let i = 0; i < selectedArticlesWithEmbeddings.length; i += batchSize) {
                const batch = selectedArticlesWithEmbeddings.slice(i, i + batchSize);
                logger.debug(`Sending batch ${Math.floor(i / batchSize) + 1} with ${batch.length} articles for user ${userId}.`, { userId, batchNumber: Math.floor(i / batchSize) + 1, batchCount: batch.length });

                const learnResponse = await clickLogger.fetch(
                    new Request(`${c.env.WORKER_BASE_URL}/learn-from-education`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            userId: userId,
                            selectedArticles: batch.map(article => ({
                                articleId: article.articleId,
                                embedding: article.embedding!,
                                reward: 20.0, // 興味ありとして報酬20.0 (clickLoggerの教育フィードバックと統一)
                            })),
                        }),
                    })
                );

                if (learnResponse.ok) {
                    logger.debug(`Successfully sent batch ${Math.floor(i / batchSize) + 1} for learning to ClickLogger for user ${userId}.`, { userId, batchNumber: Math.floor(i / batchSize) + 1 });
                } else {
                    logger.error(`Failed to send batch ${Math.floor(i / batchSize) + 1} for learning to ClickLogger for user ${userId}: ${learnResponse.statusText}`, null, { userId, batchNumber: Math.floor(i / batchSize) + 1, status: learnResponse.status, statusText: learnResponse.statusText });
                }
            }
        }

        return c.json({ message: '興味関心の更新が開始されました。埋め込み生成が必要な記事は非同期で処理されます。' }, 200);

    } catch (error) {
        logger.error('Error submitting interests:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error', { status: 500 });
    }
});

// --- MMR Settings Handler ---
app.get('/api/mmr-settings', async (c) => {
    const logger = getLogger(c);
    logger.debug('Request received for MMR settings');
    try {
        const userId = c.req.query('userId');

        if (!userId) {
            logger.warn('Get MMR settings failed: Missing userId.');
            return new Response('Missing userId', { status: 400 });
        }

        // ClickLogger から lambda を取得
        const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
        const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);

        const lambdaResponse = await clickLogger.fetch(
            new Request(`${c.env.WORKER_BASE_URL}/get-mmr-lambda?userId=${encodeURIComponent(userId)}`, {
                method: 'GET',
            })
        );

        if (!lambdaResponse.ok) {
            const errorText = await lambdaResponse.text();
            logger.error(`Failed to get MMR lambda from ClickLogger: ${lambdaResponse.statusText}`, null, { userId, status: lambdaResponse.status, statusText: lambdaResponse.statusText, errorText });
            return new Response(`Failed to get MMR lambda: ${lambdaResponse.statusText}`, { status: lambdaResponse.status });
        }

        const { lambda } = await lambdaResponse.json() as { lambda: number };
        logger.debug(`Retrieved MMR lambda for user ${userId}: ${lambda}`, { userId, lambda });

        return c.json({ lambda }, 200);

    } catch (error) {
        logger.error('Error getting MMR settings:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error', { status: 500 });
    }
});

// --- Get Preference Score Handler ---
app.get('/api/preference-score', async (c) => {
    const logger = getLogger(c);
    logger.debug('Request received for current preference score');
    try {
        const userId = c.req.query('userId');

        if (!userId) {
            logger.warn('Get preference score failed: Missing userId.');
            return new Response('Missing userId', { status: 400 });
        }

        const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
        const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);

        const scoreResponse = await clickLogger.fetch(
            new Request(`${c.env.WORKER_BASE_URL}/get-preference-score?userId=${encodeURIComponent(userId)}`, {
                method: 'GET',
            })
        );

        if (!scoreResponse.ok) {
            const errorText = await scoreResponse.text();
            logger.error(`Failed to get preference score from ClickLogger: ${scoreResponse.statusText}`, null, { userId, status: scoreResponse.status, statusText: scoreResponse.statusText, errorText });
            return new Response(`Failed to get preference score: ${scoreResponse.statusText}`, { status: scoreResponse.status });
        }

        const { score } = await scoreResponse.json() as { score: number };
        logger.debug(`Current preference score retrieved for user ${userId}: ${score}`, { userId, score });

        return c.json({ score }, 200);

    } catch (error) {
        logger.error('Error getting preference score:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error', { status: 500 });
    }
});

app.post('/api/preference-score', async (c) => {
    const logger = getLogger(c);
    logger.debug('Request received for preference score calculation');
    try {
        const { userId, selectedArticleIds } = await c.req.json() as { userId: string, selectedArticleIds: string[] };

        if (!userId || !Array.isArray(selectedArticleIds) || selectedArticleIds.length === 0) {
            logger.warn('Preference score calculation failed: Missing userId or selectedArticleIds.');
            return new Response('Missing userId or selectedArticleIds', { status: 400 });
        }

        const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
        const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);

        const scoreResponse = await clickLogger.fetch(
            new Request(`${c.env.WORKER_BASE_URL}/calculate-preference-score`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, selectedArticleIds }),
            })
        );

        if (!scoreResponse.ok) {
            const errorText = await scoreResponse.text();
            logger.error(`Failed to get preference score from ClickLogger: ${scoreResponse.statusText}`, null, { userId, status: scoreResponse.status, statusText: scoreResponse.statusText, errorText });
            return new Response(`Failed to calculate preference score: ${scoreResponse.statusText}`, { status: scoreResponse.status });
        }

        const { score } = await scoreResponse.json() as { score: number };
        logger.debug(`Preference score calculated for user ${userId}: ${score}`, { userId, score });

        return c.json({ score }, 200);

    } catch (error) {
        logger.error('Error calculating preference score:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error', { status: 500 });
    }
});

// --- Get Alignment Score Handler ---
app.get('/api/alignment-score', async (c) => {
    const logger = getLogger(c);
    const userId = c.req.query('userId');

    if (!userId) {
        return new Response('Missing userId', { status: 400 });
    }

    try {
        const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
        const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);

        const response = await clickLogger.fetch(
            new Request(`${c.env.WORKER_BASE_URL}/calculate-alignment-score`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId })
            })
        );

        if (!response.ok) {
            const errorText = await response.text();
            logger.error(`Failed to get alignment score: ${response.statusText}`, null, { userId, errorText });
            return new Response(`Failed to get alignment score: ${response.statusText}`, { status: response.status });
        }

        const data = await response.json();
        return c.json(data, 200);
    } catch (e) {
        logger.error('Error getting alignment score', e);
        return new Response('Internal Server Error', { status: 500 });
    }
});

// --- Reset User Data Handler ---
app.post('/api/reset-user-data', async (c) => {
    const logger = getLogger(c);
    try {
        const { userId } = await c.req.json() as { userId: string };
        if (!userId) return new Response('Missing userId', { status: 400 });

        const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
        const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);

        const response = await clickLogger.fetch(
            new Request(`${c.env.WORKER_BASE_URL}/reset-user-data`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId })
            })
        );

        if (!response.ok) {
            return new Response('Failed to reset data', { status: response.status });
        }

        return c.json({ message: 'User data reset successfully' }, 200);
    } catch (e) {
        logger.error('Error resetting user data', e);
        return new Response('Internal Server Error', { status: 500 });
    }
});

// --- Get User Stats Handler (for Education Level) ---
app.get('/api/user-stats', async (c) => {
    const logger = getLogger(c);
    const userId = c.req.query('userId');

    if (!userId) {
        return new Response('Missing userId', { status: 400 });
    }

    try {
        const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
        const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);

        const response = await clickLogger.fetch(
            new Request(`${c.env.WORKER_BASE_URL}/get-user-stats?userId=${encodeURIComponent(userId)}`, {
                method: 'GET',
            })
        );

        if (!response.ok) {
            const errorText = await response.text();
            logger.error(`Failed to get user stats: ${response.statusText}`, null, { userId, errorText });
            // Fallback to 0 if fails, to not break UI
            return c.json({ educationCount: 0 }, 200);
        }

        const data = await response.json();
        return c.json(data, 200);
    } catch (e) {
        logger.error('Error getting user stats', e);
        return c.json({ educationCount: 0 }, 200);
    }
});

export default app;
