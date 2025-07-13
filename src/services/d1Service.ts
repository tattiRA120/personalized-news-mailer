import { D1Database } from '@cloudflare/workers-types';
import { logError, logInfo, logWarning } from '../logger';
import { NewsArticle } from '../newsCollector'; // NewsArticle型をインポート
import { chunkArray } from '../utils/textProcessor'; // chunkArrayをインポート

export interface Env {
    USER_DB: D1Database;
    DB: D1Database; // articlesテーブル用
}

export interface ArticleWithEmbedding extends NewsArticle {
    embedding?: number[];
}

interface D1Result {
    success: boolean;
    error?: string;
    results?: any[];
    meta?: { duration?: number; served_by?: string; changes?: number; last_row_id?: number; size_after?: number; };
}

/**
 * D1データベースに記事を保存します。
 * 既存の記事はスキップし、新規記事のみを挿入します。
 * @param articles 保存する記事の配列
 * @param env 環境変数
 * @returns 保存された記事の数
 */
export async function saveArticlesToD1(articles: NewsArticle[], env: Env): Promise<number> {
    if (articles.length === 0) {
        logInfo('No articles to save to D1. Skipping.');
        return 0;
    }

    logInfo(`Attempting to save ${articles.length} articles to D1.`, { count: articles.length });
    let savedCount = 0;

    try {
        const CHUNK_SIZE_SQL_VARIABLES = 10; // SQLiteの変数制限を考慮してチャンクサイズを設定
        const articleChunks = chunkArray(articles, CHUNK_SIZE_SQL_VARIABLES); // 記事の配列をチャンクに分割

        for (const chunk of articleChunks) {
            const placeholders = chunk.map(() => '(?, ?, ?, ?, ?)').join(','); // articleId, title, url, publishedAt, content
            const query = `INSERT INTO articles (article_id, title, url, published_at, content) VALUES ${placeholders} ON CONFLICT(article_id) DO NOTHING`;
            const stmt = env.DB.prepare(query);

            const bindParams: (string | number | undefined)[] = [];
            for (const article of chunk) {
                bindParams.push(
                    article.articleId,
                    article.title,
                    article.link,
                    article.publishedAt,
                    article.content || '' // contentがundefinedの場合は空文字列
                );
            }

            logInfo(`Executing D1 batch insert for ${chunk.length} articles.`, { query, chunkCount: chunk.length });
            const { success, error, meta } = await stmt.bind(...bindParams).run() as D1Result;

            if (success) {
                savedCount += meta?.changes || 0;
                logInfo(`Successfully inserted/updated ${meta?.changes || 0} articles in D1 batch.`, { changes: meta?.changes || 0 });
            } else {
                logError(`Failed to save articles to D1 in batch: ${error}`, null, { error });
            }
        }
        logInfo(`Finished saving articles to D1. Total saved: ${savedCount}.`, { totalSaved: savedCount });
        return savedCount;
    } catch (error) {
        logError('Error saving articles to D1:', error, { count: articles.length });
        return savedCount;
    }
}

/**
 * D1データベースから記事を取得します。
 * @param env 環境変数
 * @param limit 取得する記事の最大数
 * @param offset 取得を開始するオフセット
 * @param whereClause WHERE句 (例: "embedding IS NULL")
 * @param bindParams WHERE句にバインドするパラメータ
 * @returns 取得された記事の配列
 */
export async function getArticlesFromD1(env: Env, limit: number = 1000, offset: number = 0, whereClause: string = '', bindParams: any[] = []): Promise<ArticleWithEmbedding[]> {
    logInfo(`Fetching articles from D1 with limit ${limit}, offset ${offset}, where: ${whereClause}.`);
    try {
        let query = `SELECT article_id, title, url, published_at, content, embedding FROM articles`;
        if (whereClause) {
            query += ` WHERE ${whereClause}`;
        }
        query += ` ORDER BY published_at DESC LIMIT ? OFFSET ?`;

        const stmt = env.DB.prepare(query);
        const { results } = await stmt.bind(...bindParams, limit, offset).all<any>();

        const articles: ArticleWithEmbedding[] = (results as any[]).map(row => ({
            articleId: row.article_id,
            title: row.title,
            link: row.url,
            sourceName: '', // D1から取得したデータにはsourceNameがないため、空文字列で初期化
            summary: row.content ? row.content.substring(0, Math.min(row.content.length, 200)) : '',
            content: row.content,
            embedding: row.embedding ? JSON.parse(row.embedding) : undefined, // embeddingはD1から取得し、必要に応じて付与
            publishedAt: row.published_at,
        }));
        logInfo(`Fetched ${articles.length} articles from D1.`, { count: articles.length });
        return articles;
    } catch (error) {
        logError('Error fetching articles from D1:', error);
        return [];
    }
}

/**
 * D1データベースから特定の記事IDの記事を取得します。
 * @param articleId 取得する記事のID
 * @param env 環境変数
 * @returns 記事オブジェクト、またはnull
 */
export async function getArticleByIdFromD1(articleId: string, env: Env): Promise<ArticleWithEmbedding | null> {
    logInfo(`Fetching article by ID from D1: ${articleId}.`);
    try {
        const { results } = await env.DB.prepare("SELECT article_id, title, url, published_at, content, embedding FROM articles WHERE article_id = ?").bind(articleId).all<any>();
        if (results && results.length > 0) {
            const row = results[0];
            const article: ArticleWithEmbedding = {
                articleId: row.article_id,
                title: row.title,
                link: row.url,
                sourceName: '',
                summary: row.content ? row.content.substring(0, Math.min(row.content.length, 200)) : '',
                content: row.content,
                embedding: row.embedding ? JSON.parse(row.embedding) : undefined, // embeddingはD1から取得し、必要に応じて付与
                publishedAt: row.published_at,
            };
            logInfo(`Found article by ID: ${articleId}.`, { articleId });
            return article;
        }
        logWarning(`Article with ID ${articleId} not found in D1.`, { articleId });
        return null;
    } catch (error) {
        logError(`Error fetching article by ID ${articleId} from D1:`, error);
        return null;
    }
}

/**
 * D1データベースの記事のembeddingを更新します。
 * @param articleId 更新する記事のID
 * @param embedding 更新するembedding
 * @param env 環境変数
 * @returns 更新が成功したかどうか
 */
export async function updateArticleEmbeddingInD1(articleId: string, embedding: number[], env: Env): Promise<boolean> {
    logInfo(`Updating embedding for article ${articleId} in D1.`);
    try {
        const { success, error, meta } = await env.DB.prepare("UPDATE articles SET embedding = ? WHERE article_id = ?").bind(JSON.stringify(embedding), articleId).run() as D1Result;
        if (success) {
            logInfo(`Successfully updated embedding for article ${articleId}. Changes: ${meta?.changes || 0}`, { articleId, changes: meta?.changes || 0 });
            return true;
        } else {
            logError(`Failed to update embedding for article ${articleId}: ${error}`, null, { articleId, error });
            return false;
        }
    } catch (error) {
        logError(`Error updating embedding for article ${articleId} in D1:`, error);
        return false;
    }
}

/**
 * D1データベースから古い記事を削除します。
 * @param env 環境変数
 * @param cutoffTimestamp 削除する記事のpublished_atがこのタイムスタンプより古いもの
 * @param embeddingIsNull embeddingがNULLの記事のみを対象とするか
 * @returns 削除された記事の数
 */
export async function deleteOldArticlesFromD1(env: Env, cutoffTimestamp: number, embeddingIsNull: boolean = false): Promise<number> {
    logInfo(`Deleting old articles from D1 older than ${new Date(cutoffTimestamp).toISOString()}. Embedding IS NULL: ${embeddingIsNull}`);
    try {
        let query = `DELETE FROM articles WHERE published_at < ?`;
        if (embeddingIsNull) {
            query += ` AND embedding IS NULL`;
        }
        const { success, error, meta } = await env.DB.prepare(query).bind(cutoffTimestamp).run() as D1Result;

        if (success) {
            logInfo(`Successfully deleted ${meta?.changes || 0} old articles from D1.`, { deletedCount: meta?.changes || 0 });
            return meta?.changes || 0;
        } else {
            logError(`Failed to delete old articles from D1: ${error}`, null, { error });
            return 0;
        }
    } catch (error) {
        logError('Error during D1 article cleanup:', error);
        return 0;
    }
}

/**
 * D1データベースから古いログエントリを削除します。
 * @param env 環境変数
 * @param userId ユーザーID
 * @param cutoffTimestamp 削除するログのtimestampがこのタイムスタンプより古いもの
 * @returns 削除されたログエントリの数
 */
export async function cleanupOldUserLogs(env: Env, userId: string, cutoffTimestamp: number): Promise<number> {
    logInfo(`Cleaning up old logs for user ${userId} in USER_DB older than ${new Date(cutoffTimestamp).toISOString()}.`);
    let totalDeleted = 0;
    try {
        const tables = ['click_logs', 'sent_articles', 'education_logs'];
        for (const table of tables) {
            const { success, error, meta } = await env.USER_DB.prepare(`DELETE FROM ${table} WHERE user_id = ? AND timestamp < ?`).bind(userId, cutoffTimestamp).run() as D1Result;
            if (success) {
                totalDeleted += meta?.changes || 0;
                logInfo(`Deleted ${meta?.changes || 0} old entries from ${table} for user ${userId}.`, { table, userId, deletedCount: meta?.changes || 0 });
            } else {
                logError(`Failed to delete old entries from ${table} for user ${userId}: ${error}`, null, { table, userId, error });
            }
        }
        logInfo(`Finished cleanup of old logs for user ${userId} in USER_DB. Total deleted: ${totalDeleted}.`, { userId, totalDeleted });
        return totalDeleted;
    } catch (error) {
        logError(`Error during cleanup of old user logs for user ${userId}:`, error);
        return totalDeleted;
    }
}

/**
 * D1データベースから未処理のクリックログを取得します。
 * @param env 環境変数
 * @param userId ユーザーID
 * @returns 未処理のクリックログの配列
 */
export async function getClickLogsForUser(env: Env, userId: string): Promise<{ article_id: string, timestamp: number }[]> {
    logInfo(`Fetching click logs for user ${userId} from USER_DB.`);
    try {
        const { results } = await env.USER_DB.prepare(
            `SELECT article_id, timestamp FROM click_logs WHERE user_id = ?`
        ).bind(userId).all<{ article_id: string, timestamp: number }>();
        logInfo(`Found ${results.length} click logs for user ${userId}.`, { userId, count: results.length });
        return results;
    } catch (error) {
        logError(`Error fetching click logs for user ${userId} from USER_DB:`, error);
        return [];
    }
}

/**
 * D1データベースから処理済みのクリックログを削除します。
 * @param env 環境変数
 * @param userId ユーザーID
 * @param articleIdsToDelete 削除する記事IDの配列
 * @returns 削除されたログエントリの数
 */
export async function deleteProcessedClickLogs(env: Env, userId: string, articleIdsToDelete: string[]): Promise<number> {
    if (articleIdsToDelete.length === 0) {
        logInfo('No click logs to delete. Skipping.');
        return 0;
    }
    logInfo(`Deleting ${articleIdsToDelete.length} processed click logs for user ${userId} from USER_DB.`);
    let totalDeleted = 0;
    try {
        const CHUNK_SIZE_SQL_VARIABLES = 50;
        const articleIdChunks = chunkArray(articleIdsToDelete, CHUNK_SIZE_SQL_VARIABLES);

        for (const chunk of articleIdChunks) {
            const placeholders = chunk.map(() => '?').join(',');
            const query = `DELETE FROM click_logs WHERE user_id = ? AND article_id IN (${placeholders})`;
            const stmt = env.USER_DB.prepare(query);
            const { success, error, meta } = await stmt.bind(userId, ...chunk).run() as D1Result;

            if (success) {
                totalDeleted += meta?.changes || 0;
                logInfo(`Deleted ${meta?.changes || 0} click logs in batch for user ${userId}.`, { userId, deletedCount: meta?.changes || 0 });
            } else {
                logError(`Failed to delete click logs in batch for user ${userId}: ${error}`, null, { userId, error });
            }
        }
        logInfo(`Finished deleting processed click logs for user ${userId}. Total deleted: ${totalDeleted}.`, { userId, totalDeleted });
        return totalDeleted;
    } catch (error) {
        logError(`Error deleting processed click logs for user ${userId} from USER_DB:`, error);
        return totalDeleted;
    }
}
