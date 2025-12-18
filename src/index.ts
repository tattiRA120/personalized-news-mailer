
import { Hono } from 'hono';
import { getUserProfile, createUserProfile } from './userProfile';
import { ClickLogger } from './clickLogger';
import { BatchQueueDO } from './batchQueueDO';
import { WasmDO } from './wasmDO';
import { Logger } from './logger';
import { collectNews, NewsArticle } from './newsCollector';
import { generateAndSaveEmbeddings } from './services/embeddingService';
import { saveArticlesToD1, getArticlesFromD1, ArticleWithEmbedding, getUserCTR } from './services/d1Service';
import { orchestrateMailDelivery } from './orchestrators/mailOrchestrator';
import { decodeHtmlEntities } from './utils/htmlDecoder';
import { selectDissimilarArticles } from './articleSelector';
import { OPENAI_EMBEDDING_DIMENSION } from './config';

// Define the Env interface with bindings from wrangler.jsonc
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

interface EmailRecipient {
    email: string;
    name?: string;
}


type Variables = {
    logger: Logger;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();


// Middleware for Logger
app.use('*', async (c, next) => {
    c.set('logger', new Logger(c.env));
    await next();
});

// Helper to get logger
const getLogger = (c: any) => c.get('logger') as Logger;

// --- Static File Server ---
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

// --- User Registration Handler ---
app.post('/register', async (c) => {
    const logger = getLogger(c);
    logger.debug('Registration request received');
    let requestBody;
    try {
        requestBody = await c.req.json();
        logger.debug('Registration request body:', requestBody);
    } catch (jsonError) {
        logger.error('Failed to parse registration request body as JSON:', jsonError);
        return new Response('Invalid JSON in request body', { status: 400 });
    }

    try {
        const { email } = requestBody as { email: string };

        if (!email) {
            logger.warn('Registration failed: Missing email in request body.');
            return new Response('Missing email', { status: 400 });
        }

        // Basic email format validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            logger.warn(`Registration failed: Invalid email format for ${email}.`, { email });
            return new Response('Invalid email format', { status: 400 });
        }

        const encoder = new TextEncoder();
        const data = encoder.encode(email);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const userId = Array.from(new Uint8Array(hashBuffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

        const existingUser = await getUserProfile(userId, c.env);
        if (existingUser) {
            logger.warn(`Registration failed: User with email ${email} already exists.`, { email, userId });
            return new Response('User already exists', { status: 409 });
        }

        c.executionCtx.waitUntil(createUserProfile(userId, email, c.env));
        logger.debug(`User registered successfully: ${userId}`, { userId, email });

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

        logger.debug(`Generated OAuth consent URL for user ${userId}`, { userId, authUrl: authUrl.toString() });

        return c.json({ message: 'User registered. Please authorize Gmail access.', authUrl: authUrl.toString() }, 201);

    } catch (error) {
        logger.error('Error during user registration:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error', { status: 500 });
    }
});

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

// --- OAuth2 Callback Handler ---
app.get('/oauth2callback', async (c) => {
    const logger = getLogger(c);
    logger.debug('OAuth2 callback request received');

    const code = c.req.query('code');
    const userId = c.req.query('state');

    if (!code) {
        logger.warn('OAuth2 callback failed: Missing authorization code.');
        return new Response('Missing authorization code', { status: 400 });
    }

    if (!userId) {
        logger.warn('OAuth2 callback failed: Missing state parameter (userId).');
        return new Response('Missing state parameter', { status: 400 });
    }

    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET || !c.env.GOOGLE_REDIRECT_URI || !c.env['mail-news-gmail-tokens']) {
        logger.error('Missing Google OAuth environment variables or KV binding.', null);
        return new Response('Server configuration error', { status: 500 });
    }

    try {
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                code: code,
                client_id: c.env.GOOGLE_CLIENT_ID,
                client_secret: c.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: c.env.GOOGLE_REDIRECT_URI,
                grant_type: 'authorization_code',
            }).toString(),
        });

        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            logger.error(`Failed to exchange authorization code for tokens: ${tokenResponse.statusText}`, null, { status: tokenResponse.status, statusText: tokenResponse.statusText, errorText });
            return new Response(`Error exchanging code: ${tokenResponse.statusText}`, { status: tokenResponse.status });
        }

        const tokenData: any = await tokenResponse.json();
        const refreshToken = tokenData.refresh_token;

        if (!refreshToken) {
            logger.warn('No refresh token received. Ensure access_type=offline was requested and this is the first authorization.');
        }

        c.executionCtx.waitUntil(c.env['mail-news-gmail-tokens'].put(`refresh_token:${userId}`, refreshToken));
        logger.debug(`Successfully stored refresh token for user ${userId}.`, { userId });

        return new Response('Authorization successful. You can close this window.', { status: 200 });

    } catch (error) {
        logger.error('Error during OAuth2 callback processing:', error, { userId, requestUrl: c.req.url });
        return new Response('Internal Server Error', { status: 500 });
    }
});

// --- Get Articles for Education Handler ---
app.get('/get-articles-for-education', async (c) => {
    const logger = getLogger(c);
    logger.debug('Request received for articles for education');
    try {
        const userId = c.req.query('userId');

        // Trigger fresh news collection in background to keep DB updated
        // Removed to prevent resource contention during user request (rely on scheduled collection)
        // c.executionCtx.waitUntil(collectAndSaveNews(c.env));

        // Fetch candidate articles from D1 that have embeddings and haven't been seen/sent
        // "New Discoveries" should be diverse, so we use selectDissimilarArticles on valid candidates
        let whereClause = `embedding IS NOT NULL`;
        const params: any[] = [];

        if (userId) {
            whereClause += ` AND article_id NOT IN (SELECT article_id FROM education_logs WHERE user_id = ?) AND article_id NOT IN (SELECT article_id FROM sent_articles WHERE user_id = ?)`;
            params.push(userId, userId);
        }

        // Get more candidates than needed to allow good diversity selection
        const candidateArticles = await getArticlesFromD1(c.env, 200, 0, whereClause, params);

        if (candidateArticles.length === 0) {
            logger.info('No cached articles with embeddings found for education. Returning empty list (wait for background fetch).');
            return c.json({ articles: [], score: 0 }, 200);
        }

        // Select 30 dissimilar articles
        const selectedArticles = await selectDissimilarArticles(candidateArticles, 30, c.env);
        logger.debug(`Selected ${selectedArticles.length} dissimilar articles for education (New Discoveries).`, { count: selectedArticles.length });

        const articlesForResponse = selectedArticles.map((article) => ({
            articleId: article.articleId,
            title: article.title,
            summary: article.summary,
            link: article.link,
            sourceName: article.sourceName,
        }));

        return c.json({
            articles: articlesForResponse,
            score: 0 // New Discoveries doesn't have a personalization score
        }, 200);

    } catch (error) {
        logger.error('Error fetching articles for education:', error, { requestUrl: c.req.url });
        return new Response('Error fetching articles', { status: 500 });
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

// --- Submit Education Feedback Handler (New) ---
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
            const reward = feedback === 'interested' ? 5.0 : -1.0; // 興味あり: 5.0, 興味なし: -1.0

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
                // embeddingがない場合でも、後で学習できるようにログには残したいが、
                // 現状のアーキテクチャではembeddingがないとバンディットの更新ができない。
                // embedding生成後にコールバックで学習させる仕組みが必要だが、
                // ここでは簡略化のため、embedding生成リクエストだけ投げておく。
                // (厳密には、生成後に学習させるフローが必要)
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
        if (articlesToLearn.length > 0) {
            const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
            const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);

            const batchSize = 10;
            for (let i = 0; i < articlesToLearn.length; i += batchSize) {
                const batch = articlesToLearn.slice(i, i + batchSize);
                await clickLogger.fetch(
                    new Request(`${c.env.WORKER_BASE_URL}/learn-from-education`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            userId: userId,
                            selectedArticles: batch
                        }),
                    })
                );
            }
        }

        return c.json({ message: 'フィードバックを受け付けました。' }, 200);

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
                } else {
                    // ここに到達することはないはずだが、念のためログ
                    logger.warn(`Article "${selectedArticle.title}" (ID: ${selectedArticle.articleId}) was expected to have embedding but not found.`, { articleId: selectedArticle.articleId, articleTitle: selectedArticle.title });
                    articlesNeedingEmbedding.push(selectedArticle);
                }
            } else {
                // embeddingがまだ存在しない記事（新規保存されたか、以前から存在したがembeddingがなかった記事）
                articlesNeedingEmbedding.push(selectedArticle);
            }
        }

        if (articlesNeedingEmbedding.length > 0) {
            logger.debug(`Generating embeddings for ${articlesNeedingEmbedding.length} articles. This will be processed asynchronously.`, { count: articlesNeedingEmbedding.length });
            c.executionCtx.waitUntil(generateAndSaveEmbeddings(articlesNeedingEmbedding, c.env, userId, false));
        } else {
            logger.debug(`No new embeddings needed for selected articles for user ${userId}.`, { userId });
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
                                reward: 5.0, // 興味ありとして報酬5.0 (以前は1.0だったが強化)
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
            logger.debug(`Finished sending all batches for learning to ClickLogger for user ${userId}.`, { userId, totalCount: selectedArticlesWithEmbeddings.length });
        } else {
            logger.warn(`No selected articles with existing embeddings to send for learning for user ${userId}.`, { userId });
        }

        return c.json({ message: '興味関心の更新が開始されました。埋め込み生成が必要な記事は非同期で処理されます。' }, 200);

    } catch (error) {
        logger.error('Error submitting interests:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error', { status: 500 });
    }
});

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


// --- Debug Endpoints ---

app.post('/debug/force-embed-articles', async (c) => {
    const logger = getLogger(c);
    logger.debug('Debug: Force embed articles request received');
    const debugApiKey = c.req.header('X-Debug-Key');
    if (debugApiKey !== c.env.DEBUG_API_KEY) {
        logger.warn('Debug: Unauthorized access attempt to /debug/force-embed-articles', { providedKey: debugApiKey });
        return new Response('Unauthorized', { status: 401 });
    }

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

app.post('/debug/delete-user-data', async (c) => {
    const logger = getLogger(c);
    logger.debug('Debug: Delete user data request received');
    const debugApiKey = c.req.header('X-Debug-Key');
    if (debugApiKey !== c.env.DEBUG_API_KEY) {
        logger.warn('Debug: Unauthorized access attempt to /debug/delete-user-data', { providedKey: debugApiKey });
        return new Response('Unauthorized', { status: 401 });
    }

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

app.post('/debug/trigger-batch-alarm', async (c) => {
    const logger = getLogger(c);
    logger.debug('Debug: Trigger BatchQueueDO alarm request received');
    const debugApiKey = c.req.header('X-Debug-Key');
    if (debugApiKey !== c.env.DEBUG_API_KEY) {
        logger.warn('Debug: Unauthorized access attempt to /debug/trigger-batch-alarm', { providedKey: debugApiKey });
        return new Response('Unauthorized', { status: 401 });
    }
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

app.post('/debug/send-test-email', async (c) => {
    const logger = getLogger(c);
    logger.debug('Debug: Send test email request received');
    const debugApiKey = c.req.header('X-Debug-Key');
    if (debugApiKey !== c.env.DEBUG_API_KEY) {
        logger.warn('Debug: Unauthorized access attempt to /debug/send-test-email', { providedKey: debugApiKey });
        return new Response('Unauthorized', { status: 401 });
    }
    try {
        await orchestrateMailDelivery(c.env, new Date(), true);
        logger.debug('Debug: Test email delivery orchestrated successfully.');
        return c.json({ message: 'Test email delivery orchestrated successfully.' }, 200);
    } catch (error) {
        logger.error('Debug: Error during test email delivery:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error during test email delivery', { status: 500 });
    }
});

app.post('/debug/generate-oauth-url', async (c) => {
    const logger = getLogger(c);
    logger.debug('Debug: Generate OAuth URL request received');
    const debugApiKey = c.req.header('X-Debug-Key');
    if (debugApiKey !== c.env.DEBUG_API_KEY) {
        logger.warn('Debug: Unauthorized access attempt to /debug/generate-oauth-url', { providedKey: debugApiKey });
        return new Response('Unauthorized', { status: 401 });
    }
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

app.post('/debug/process-pending-feedback', async (c) => {
    const logger = getLogger(c);
    logger.debug('Debug: Process pending feedback request received');
    const debugApiKey = c.req.header('X-Debug-Key');
    if (debugApiKey !== c.env.DEBUG_API_KEY) {
        logger.warn('Debug: Unauthorized access attempt to /debug/process-pending-feedback', { providedKey: debugApiKey });
        return new Response('Unauthorized', { status: 401 });
    }
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

app.get('/debug/check-exclusions', async (c) => {
    const logger = getLogger(c);
    logger.debug('Debug: Check exclusions request received');
    const debugApiKey = c.req.header('X-Debug-Key');
    if (debugApiKey !== c.env.DEBUG_API_KEY) {
        return new Response('Unauthorized', { status: 401 });
    }
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

// --- Article Getters ---
app.get('/get-dissimilar-articles', async (c) => {
    const logger = getLogger(c);
    logger.debug('Request received for dissimilar articles for education program');
    try {
        const userId = c.req.query('userId');
        if (!userId) {
            logger.warn('Get dissimilar articles failed: Missing userId.');
            return new Response('Missing userId', { status: 400 });
        }

        // D1からembeddingを持つ記事を取得し、ユーザーがフィードバックした記事および配信済み記事を除外
        const whereClause = `embedding IS NOT NULL AND article_id NOT IN (SELECT article_id FROM education_logs WHERE user_id = ?) AND article_id NOT IN (SELECT article_id FROM sent_articles WHERE user_id = ?)`;
        const allArticlesWithEmbeddings = await getArticlesFromD1(c.env, 1000, 0, whereClause, [userId, userId]);
        logger.debug(`Found ${allArticlesWithEmbeddings.length} articles with embeddings in D1 (excluding feedbacked articles for user ${userId}).`, { count: allArticlesWithEmbeddings.length, userId });

        // 類似度の低い記事を20件選択
        const dissimilarArticles = await selectDissimilarArticles(allArticlesWithEmbeddings, 20, c.env);
        logger.debug(`Selected ${dissimilarArticles.length} dissimilar articles.`, { count: dissimilarArticles.length });

        // フロントエンドに返すために必要な情報のみを抽出
        const articlesForResponse = dissimilarArticles.map((article: NewsArticle) => ({ // NewsArticle 型を明示的に指定
            articleId: article.articleId,
            title: article.title,
            summary: article.summary,
            link: article.link,
            sourceName: article.sourceName,
        }));

        return c.json(articlesForResponse, 200);

    } catch (error) {
        logger.error('Error fetching dissimilar articles:', error, { requestUrl: c.req.url });
        return new Response('Error fetching dissimilar articles', { status: 500 });
    }
});

app.get('/get-personalized-articles', async (c) => {
    const logger = getLogger(c);
    logger.debug('Request received for personalized articles');
    try {
        const userId = c.req.query('userId');
        const lambdaParam = c.req.query('lambda');

        if (!userId) {
            logger.warn('Get personalized articles failed: Missing userId.');
            return new Response('Missing userId', { status: 400 });
        }

        let lambda = lambdaParam ? parseFloat(lambdaParam) : 0.5;
        if (isNaN(lambda) || lambda < 0 || lambda > 1) {
            logger.warn(`Invalid lambda value: ${lambdaParam}. Using default 0.5.`);
            lambda = 0.5;
        }

        // ユーザープロファイルを取得
        const userProfile = await getUserProfile(userId, c.env);
        if (!userProfile) {
            logger.warn(`User profile not found for ${userId}. Falling back to dissimilar articles.`, { userId });
            // プロファイルがない場合はdissimilar articlesを返す
            const whereClause = `embedding IS NOT NULL AND article_id NOT IN (SELECT article_id FROM education_logs WHERE user_id = ?) AND article_id NOT IN (SELECT article_id FROM sent_articles WHERE user_id = ?)`;
            const allArticlesWithEmbeddings = await getArticlesFromD1(c.env, 1000, 0, whereClause, [userId, userId]);
            const dissimilarArticles = await selectDissimilarArticles(allArticlesWithEmbeddings, 20, c.env);
            const articlesForResponse = dissimilarArticles.map((article: NewsArticle) => ({
                articleId: article.articleId,
                title: article.title,
                summary: article.summary,
                link: article.link,
                sourceName: article.sourceName,
            }));
            return c.json(articlesForResponse, 200);
        }

        // D1からembeddingを持つ記事を取得し、ユーザーがフィードバックした記事（education_logs）および配信済み/即時フィードバック済み記事（sent_articles）を除外
        // 24時間以内の記事のみを対象とする
        const cutoffDate = new Date();
        cutoffDate.setHours(cutoffDate.getHours() - 24);
        const cutoffTimestamp = cutoffDate.getTime();

        const whereClause = `embedding IS NOT NULL AND article_id NOT IN (SELECT article_id FROM education_logs WHERE user_id = ?) AND article_id NOT IN (SELECT article_id FROM sent_articles WHERE user_id = ?) AND published_at >= ?`;
        const allArticlesWithEmbeddings = await getArticlesFromD1(c.env, 1000, 0, whereClause, [userId, userId, cutoffTimestamp]);

        // 除外された記事の数を確認するためのログ (デバッグ用)
        const totalArticlesCount = await c.env.DB.prepare(`SELECT COUNT(*) as count FROM articles WHERE embedding IS NOT NULL AND published_at >= ?`).bind(cutoffTimestamp).first<{ count: number }>();
        const excludedCount = (totalArticlesCount?.count || 0) - allArticlesWithEmbeddings.length;

        logger.info(`Found ${allArticlesWithEmbeddings.length} articles with embeddings in D1 (newer than 24 hours, excluding feedbacked articles for user ${userId}). Excluded approx ${excludedCount} articles based on feedback.`, { count: allArticlesWithEmbeddings.length, userId, cutoffDate: cutoffDate.toISOString() });

        if (allArticlesWithEmbeddings.length === 0) {
            logger.warn('No articles with embeddings found. Returning empty list.', { userId });
            return c.json([], 200);
        }

        // ユーザーのCTRを取得
        const userCTR = await getUserCTR(c.env, userId);

        // ClickLogger Durable Objectを取得
        const clickLoggerId = c.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
        const clickLogger = c.env.CLICK_LOGGER.get(clickLoggerId);

        // ユーザープロファイルの埋め込みベクトルを準備
        const EXTENDED_EMBEDDING_DIMENSION = OPENAI_EMBEDDING_DIMENSION + 1;
        let userProfileEmbeddingForSelection: number[];
        if (userProfile.embedding && userProfile.embedding.length === EXTENDED_EMBEDDING_DIMENSION) {
            userProfileEmbeddingForSelection = [...userProfile.embedding]; // 参照渡しを防ぐためにコピー
        } else {
            logger.warn(`User ${userId} has an embedding of unexpected dimension ${userProfile.embedding?.length}. Initializing with zero vector for selection.`, { userId, embeddingLength: userProfile.embedding?.length });
            userProfileEmbeddingForSelection = new Array(EXTENDED_EMBEDDING_DIMENSION).fill(0);
        }
        // ユーザープロファイルの鮮度情報は常に0.0で上書き
        userProfileEmbeddingForSelection[EXTENDED_EMBEDDING_DIMENSION - 1] = 0.0; // 最後の要素を上書き

        // 記事の埋め込みベクトルに鮮度情報を更新
        const now = Date.now();
        const articlesWithUpdatedFreshness = allArticlesWithEmbeddings
            .map((article) => {
                let normalizedAge = 0; // デフォルト値

                if (article.publishedAt) {
                    const publishedDate = new Date(article.publishedAt);
                    if (isNaN(publishedDate.getTime())) {
                        logger.warn(`Invalid publishedAt date for article ${article.articleId}. Using default freshness (0).`, { articleId: article.articleId, publishedAt: article.publishedAt });
                        normalizedAge = 0; // 不正な日付の場合は0にフォールバック
                    } else {
                        const ageInHours = (now - publishedDate.getTime()) / (1000 * 60 * 60);
                        normalizedAge = Math.min(ageInHours / (24 * 7), 1.0); // 1週間で正規化
                    }
                } else {
                    logger.warn(`Could not find publishedAt for article ${article.articleId}. Using default freshness (0).`, { articleId: article.articleId });
                    normalizedAge = 0; // publishedAtがない場合は0にフォールバック
                }

                // 既存の257次元embeddingの最後の要素（鮮度情報）を更新
                const updatedEmbedding = [...article.embedding!]; // 参照渡しを防ぐためにコピー
                updatedEmbedding[EXTENDED_EMBEDDING_DIMENSION - 1] = normalizedAge;

                return {
                    ...article,
                    embedding: updatedEmbedding,
                };
            });

        // WASM DOを使用してパーソナライズド記事を選択
        const wasmDOId = c.env.WASM_DO.idFromName("wasm-calculator");
        const wasmDOStub = c.env.WASM_DO.get(wasmDOId);

        const response = await wasmDOStub.fetch(new Request(`${c.env.WORKER_BASE_URL}/wasm-do/select-personalized-articles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                articles: articlesWithUpdatedFreshness,
                userProfileEmbeddingForSelection: userProfileEmbeddingForSelection,
                userId: userId,
                count: 20, // 20件選択
                userCTR: userCTR,
                lambda: lambda,
                workerBaseUrl: c.env.WORKER_BASE_URL,
            }),
        }));

        let selectedArticles: NewsArticle[] = [];
        let avgRelevance = 0;

        if (response.ok) {
            const wasmResult: any = await response.json();
            if (Array.isArray(wasmResult)) {
                selectedArticles = wasmResult;
            } else {
                selectedArticles = wasmResult.articles || [];
                avgRelevance = wasmResult.avgRelevance || 0;
            }
            logger.debug(`Selected ${selectedArticles.length} personalized articles for user ${userId} via WASM DO. Avg Relevance: ${avgRelevance}`, { userId, selectedCount: selectedArticles.length, avgRelevance });
        } else {
            const errorText = await response.text();
            logger.error(`Failed to select personalized articles for user ${userId} via WASM DO: ${response.statusText}. Error: ${errorText}`, null, { userId, status: response.status, statusText: response.statusText });
            // エラー時は空の配列を使用
            selectedArticles = [];
        }

        logger.debug(`Selected ${selectedArticles.length} personalized articles for user ${userId}.`, { userId, selectedCount: selectedArticles.length });

        // フロントエンドに返すために必要な情報のみを抽出
        const articlesForResponse = selectedArticles.map((article: NewsArticle) => ({
            articleId: article.articleId,
            title: article.title,
            summary: article.summary,
            link: article.link,
            sourceName: article.sourceName,
        }));

        // Calculate match score (0-100%)
        const score = Math.max(0, avgRelevance) * 100;

        return c.json({
            articles: articlesForResponse,
            score: score
        }, 200);

    } catch (error) {
        logger.error('Error fetching personalized articles:', error, { requestUrl: c.req.url });
        return new Response('Error fetching personalized articles', { status: 500 });
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

// --- WASM Durable Object Handler ---
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
            headers: c.req.header(),
            body: c.req.raw.body,
        });

        const doResponse = await wasmDOStub.fetch(wasmRequest); // リクエストをDOに転送

        return doResponse;

    } catch (error) {
        logger.error('Error during WASM Durable Object invocation:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error during WASM Durable Object invocation', { status: 500 });
    }
});


export default {
    fetch: app.fetch,
    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        const logger = new Logger(env);
        // scheduled event uses a separate invocation, so we pass dependencies manually or rely on globals in orchestrateMailDelivery
        // NOTE: orchestrateMailDelivery inside it likely creates its own Logger.
        await orchestrateMailDelivery(env, new Date(controller.scheduledTime));
    },
};

// Durable Object class definition (must be exported)
export { ClickLogger } from './clickLogger';
export { BatchQueueDO } from './batchQueueDO';
export { WasmDO } from './wasmDO';
