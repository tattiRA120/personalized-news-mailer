
import { Hono } from 'hono';
import { Env } from '../types/bindings';
import { getLogger } from '../middlewares/logger';
import { getArticlesFromD1, getUserCTR, getRecentPositiveFeedbackEmbeddings } from '../services/d1Service';
import { selectDissimilarArticles } from '../articleSelector';
import { getUserProfile } from '../userProfile';
import { NewsArticle } from '../newsCollector';
import { OPENAI_EMBEDDING_DIMENSION } from '../config';
import { getDb } from '../db';
import { articles, educationLogs } from '../db/schema';
import { isNotNull, gte, and, count, eq, desc } from 'drizzle-orm';

const app = new Hono<{ Bindings: Env }>();

import { getArticlesForEducationData, getPersonalizedArticlesData } from '../services/articleFetchService';

app.get('/get-articles-for-education', async (c) => {
    const logger = getLogger(c);
    logger.debug('Request received for articles for education');
    try {
        const userId = c.req.query('userId');
        const data = await getArticlesForEducationData(c.env, userId);
        return c.json(data, 200);
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
            lambda = 0.5;
        }

        const data = await getPersonalizedArticlesData(c.env, userId, lambda);
        return c.json(data, 200);

    } catch (error) {
        logger.error('Error fetching personalized articles:', error, { requestUrl: c.req.url });
        return new Response('Error fetching personalized articles', { status: 500 });
    }
});

export default app;
