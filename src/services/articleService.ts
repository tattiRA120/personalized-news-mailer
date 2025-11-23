import { Env } from '../index';
import { collectNews, NewsArticle } from '../newsCollector';
import { saveArticlesToD1, ArticleWithEmbedding } from './d1Service';
import { Logger } from '../logger';
import { chunkArray } from '../utils/textProcessor';

/**
 * Collects fresh articles from RSS feeds, saves only new ones to D1, and returns only the new articles with persistent IDs.
 * This function follows the safe pattern from orchestrateMailDelivery:
 * 1. Collect articles from RSS
 * 2. Check which already exist in D1
 * 3. Save only new articles
 * 4. Fetch only new articles by article_id to get persistent data
 * @param env Environment variables
 * @returns Only new articles with persistent database IDs
 */
export async function collectAndSaveNews(env: Env): Promise<ArticleWithEmbedding[]> {
    const logger = new Logger(env);

    // 1. Collect fresh articles from RSS feeds
    const collectedArticles: NewsArticle[] = await collectNews(env);
    logger.debug(`Collected ${collectedArticles.length} fresh articles from RSS feeds.`, { count: collectedArticles.length });

    if (collectedArticles.length === 0) {
        logger.warn('No articles collected from RSS feeds.');
        return [];
    }

    // 2. Check which articles already exist in D1 by article_id
    const articleIds = collectedArticles.map(a => a.articleId).filter(Boolean) as string[];
    logger.debug(`Checking ${articleIds.length} article IDs against D1.`, { count: articleIds.length });

    const CHUNK_SIZE_SQL_VARIABLES = 50;
    const articleIdChunks = chunkArray(articleIds, CHUNK_SIZE_SQL_VARIABLES);
    const existingArticleIds = new Set<string>();

    for (const chunk of articleIdChunks) {
        const placeholders = chunk.map(() => '?').join(',');
        const query = `SELECT article_id FROM articles WHERE article_id IN (${placeholders})`;
        const stmt = env.DB.prepare(query);
        const { results: existingRows } = await stmt.bind(...chunk).all<{ article_id: string }>();
        existingRows.forEach(row => existingArticleIds.add(row.article_id));
    }
    logger.debug(`Found ${existingArticleIds.size} existing article IDs in D1.`, { count: existingArticleIds.size });

    // 3. Filter to get only new articles
    const newArticles = collectedArticles.filter(article => article.articleId && !existingArticleIds.has(article.articleId));
    logger.debug(`Filtered down to ${newArticles.length} new articles to be saved.`, { count: newArticles.length });

    if (newArticles.length === 0) {
        logger.info('No new articles to save. All articles already exist in D1.');
        return [];
    }

    // 4. Save only new articles to D1
    await saveArticlesToD1(newArticles, env);
    logger.debug(`Saved ${newArticles.length} new articles to D1.`, { count: newArticles.length });

    // 5. Fetch only new articles from D1 by article_id to get persistent data
    const newArticleIds = newArticles.map(a => a.articleId).filter(Boolean) as string[];
    const newArticleIdChunks = chunkArray(newArticleIds, CHUNK_SIZE_SQL_VARIABLES);
    const newArticlesWithIds: ArticleWithEmbedding[] = [];

    for (const chunk of newArticleIdChunks) {
        const placeholders = chunk.map(() => '?').join(',');
        const { results: d1Articles } = await env.DB.prepare(
            `SELECT article_id, title, url, content, embedding, published_at FROM articles WHERE article_id IN (${placeholders})`
        ).bind(...chunk).all<any>();

        const articlesFromChunk = d1Articles.map(row => ({
            articleId: row.article_id,
            title: row.title,
            link: row.url,
            sourceName: '',
            summary: row.content ? row.content.substring(0, Math.min(row.content.length, 200)) : '',
            content: row.content,
            embedding: row.embedding ? JSON.parse(row.embedding) : undefined,
            publishedAt: row.published_at,
        }));

        newArticlesWithIds.push(...articlesFromChunk);
    }

    // 6. Restore sourceName from collected articles
    const urlToSourceMap = new Map(newArticles.map(a => [a.link, a.sourceName]));
    newArticlesWithIds.forEach(a => {
        if (urlToSourceMap.has(a.link)) {
            a.sourceName = urlToSourceMap.get(a.link) || '';
        }
    });

    logger.info(`Collected and saved ${newArticles.length} new articles. Returning ${newArticlesWithIds.length} new articles with persistent IDs.`, { newCount: newArticles.length, returnCount: newArticlesWithIds.length });
    return newArticlesWithIds;
}
