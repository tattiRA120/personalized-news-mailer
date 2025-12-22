
import { Hono } from 'hono';
import { Env } from '../types/bindings';
import { getLogger } from '../middlewares/logger';
import { getArticlesFromD1, getUserCTR } from '../services/d1Service';
import { selectDissimilarArticles } from '../articleSelector';
import { getUserProfile } from '../userProfile';
import { NewsArticle } from '../newsCollector';
import { OPENAI_EMBEDDING_DIMENSION } from '../config';

const app = new Hono<{ Bindings: Env }>();

// --- Get Articles for Education Handler ---
app.get('/get-articles-for-education', async (c) => {
    const logger = getLogger(c);
    logger.debug('Request received for articles for education');
    try {
        const userId = c.req.query('userId');

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

// --- Get Dissimilar Articles Handler ---
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

// --- Get Personalized Articles Handler ---
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
            return c.json({ articles: [], score: 0 }, 200);
        }

        // ユーザーのCTRを取得
        const userCTR = await getUserCTR(c.env, userId);

        // WASM DOを使用してパーソナライズド記事を選択
        const wasmDOId = c.env.WASM_DO.idFromName("wasm-calculator");
        const wasmDOStub = c.env.WASM_DO.get(wasmDOId);

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

        const response = await wasmDOStub.fetch(new Request(`${c.env.WORKER_BASE_URL}/select-personalized-articles`, {
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

export default app;
