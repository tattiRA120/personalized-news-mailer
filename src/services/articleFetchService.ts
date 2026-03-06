import { Env } from '../types/bindings';
import { getArticlesFromD1, getUserCTR, getRecentPositiveFeedbackEmbeddings } from './d1Service';
import { selectDissimilarArticles } from '../articleSelector';
import { getUserProfile } from '../userProfile';
import { NewsArticle } from '../newsCollector';
import { OPENAI_EMBEDDING_DIMENSION } from '../config';
import { getDb } from '../db';
import { articles, educationLogs } from '../db/schema';
import { isNotNull, gte, and, count, eq, desc } from 'drizzle-orm';
import { Logger } from '../logger';

export async function getArticlesForEducationData(env: Env, userId?: string) {
    const logger = new Logger(env);
    let whereClause = `embedding IS NOT NULL`;
    const params: any[] = [];

    if (userId) {
        whereClause += ` AND article_id NOT IN (SELECT article_id FROM education_logs WHERE user_id = ?) AND article_id NOT IN (SELECT article_id FROM sent_articles WHERE user_id = ?)`;
        params.push(userId, userId);
    }

    const candidateArticles = await getArticlesFromD1(env, 200, 0, whereClause, params);

    if (candidateArticles.length === 0) {
        return { articles: [], score: 0 };
    }

    const selectedArticles = await selectDissimilarArticles(candidateArticles, 30, env);
    const articlesForResponse = selectedArticles.map((article) => ({
        articleId: article.articleId,
        title: article.title,
        summary: article.summary,
        link: article.link,
        sourceName: article.sourceName,
    }));

    return { articles: articlesForResponse, score: 0 };
}

export async function getPersonalizedArticlesData(env: Env, userId: string, lambda: number = 0.5) {
    const logger = new Logger(env);
    const userProfile = await getUserProfile(userId, env);

    if (!userProfile) {
        const whereClause = `embedding IS NOT NULL AND article_id NOT IN (SELECT article_id FROM education_logs WHERE user_id = ?) AND article_id NOT IN (SELECT article_id FROM sent_articles WHERE user_id = ?)`;
        const allArticlesWithEmbeddings = await getArticlesFromD1(env, 1000, 0, whereClause, [userId, userId]);
        const dissimilarArticles = await selectDissimilarArticles(allArticlesWithEmbeddings, 20, env);
        const articlesForResponse = dissimilarArticles.map((article: NewsArticle) => ({
            articleId: article.articleId,
            title: article.title,
            summary: article.summary,
            link: article.link,
            sourceName: article.sourceName,
        }));
        return { articles: articlesForResponse, score: 0 };
    }

    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - 24);
    const cutoffTimestamp = cutoffDate.getTime();

    const whereClause = `embedding IS NOT NULL AND article_id NOT IN (SELECT article_id FROM education_logs WHERE user_id = ?) AND article_id NOT IN (SELECT article_id FROM sent_articles WHERE user_id = ?) AND published_at >= ?`;
    const allArticlesWithEmbeddings = await getArticlesFromD1(env, 1000, 0, whereClause, [userId, userId, cutoffTimestamp]);

    if (allArticlesWithEmbeddings.length === 0) {
        return { articles: [], score: 0 };
    }

    const userCTR = await getUserCTR(env, userId);
    const db = getDb(env);

    const negativeFeedbackResult = await db.select({
        embedding: articles.embedding
    })
        .from(educationLogs)
        .innerJoin(articles, eq(educationLogs.article_id, articles.article_id))
        .where(and(
            eq(educationLogs.user_id, userId),
            eq(educationLogs.action, 'not_interested'),
            isNotNull(articles.embedding)
        ))
        .orderBy(desc(educationLogs.timestamp))
        .limit(50);

    const negativeFeedbackEmbeddings: number[][] = [];
    if (negativeFeedbackResult) {
        for (const row of negativeFeedbackResult) {
            try {
                const embedding = row.embedding ? JSON.parse(row.embedding) : null;
                if (Array.isArray(embedding)) {
                    negativeFeedbackEmbeddings.push(embedding);
                }
            } catch (e) {
                // ignore syntax error
            }
        }
    }

    const recentInterestEmbeddings = await getRecentPositiveFeedbackEmbeddings(env, userId, 10);
    const wasmDOId = env.WASM_DO.idFromName("wasm-calculator");
    const wasmDOStub = env.WASM_DO.get(wasmDOId);

    const EXTENDED_EMBEDDING_DIMENSION = OPENAI_EMBEDDING_DIMENSION + 1;
    let userProfileEmbeddingForSelection: number[];
    if (userProfile.embedding && userProfile.embedding.length === EXTENDED_EMBEDDING_DIMENSION) {
        userProfileEmbeddingForSelection = [...userProfile.embedding];
    } else {
        userProfileEmbeddingForSelection = new Array(EXTENDED_EMBEDDING_DIMENSION).fill(0);
    }
    userProfileEmbeddingForSelection[EXTENDED_EMBEDDING_DIMENSION - 1] = 0.0;

    const now = Date.now();
    const articlesWithUpdatedFreshness = allArticlesWithEmbeddings.map((article) => {
        let normalizedAge = 0;
        if (article.publishedAt) {
            const publishedDate = new Date(article.publishedAt);
            if (!isNaN(publishedDate.getTime())) {
                const ageInHours = (now - publishedDate.getTime()) / (1000 * 60 * 60);
                normalizedAge = Math.min(ageInHours / (24 * 7), 1.0);
            }
        }
        const updatedEmbedding = [...article.embedding!];
        updatedEmbedding[EXTENDED_EMBEDDING_DIMENSION - 1] = normalizedAge;
        return { ...article, embedding: updatedEmbedding };
    });

    const response = await wasmDOStub.fetch(new Request(`${env.WORKER_BASE_URL}/select-personalized-articles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            articles: articlesWithUpdatedFreshness,
            userProfileEmbeddingForSelection: userProfileEmbeddingForSelection,
            userId: userId,
            count: 20,
            userCTR: userCTR,
            lambda: lambda,
            workerBaseUrl: env.WORKER_BASE_URL,
            negativeFeedbackEmbeddings: negativeFeedbackEmbeddings,
            recentInterestEmbeddings: recentInterestEmbeddings,
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
    } else {
        selectedArticles = [];
    }

    const articlesForResponse = selectedArticles.map((article: NewsArticle) => ({
        articleId: article.articleId,
        title: article.title,
        summary: article.summary,
        link: article.link,
        sourceName: article.sourceName,
    }));

    const score = Math.max(0, avgRelevance) * 100;

    return {
        articles: articlesForResponse,
        score: score
    };
}
