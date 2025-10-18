import { D1Database } from '@cloudflare/workers-types';
import { initLogger } from '../logger';
import { NewsArticle } from '../newsCollector';
import { chunkArray } from '../utils/textProcessor';
import { Env } from '../index';

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
    const { logError, logInfo, logWarning } = initLogger(env);
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
            const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(','); // articleId, title, url, publishedAt, content, embedding
            // ON CONFLICT(article_id) DO NOTHING: article_idが重複する場合は挿入を無視
            // ON CONFLICT(url) DO UPDATE SET ...: URLが重複する場合、title, published_at, contentを更新。
            // contentが変更された場合、embeddingをNULLにリセットして再生成を促す。
            const query = `INSERT OR IGNORE INTO articles (article_id, title, url, published_at, content, embedding) VALUES ${placeholders}`;
            const stmt = env.DB.prepare(query);

            const bindParams: (string | number | null)[] = [];
            for (const article of chunk) {
                bindParams.push(
                    article.articleId,
                    article.title,
                    article.link,
                    article.publishedAt || Date.now(), // publishedAtがundefinedの場合は現在時刻をセット
                    article.content || '', // contentがundefinedの場合は空文字列
                    null // 新しい記事のembeddingはNULLに設定
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
    const { logError, logInfo, logWarning } = initLogger(env);
    logInfo(`Fetching articles from D1 with limit ${limit}, offset ${offset}, where: ${whereClause}.`);
    try {
        let query = `SELECT article_id, title, url, published_at, content, embedding FROM articles`;
        
        let finalWhereClause = whereClause;
        // whereClauseが指定されていない場合、またはembedding IS NULLを含まない場合にのみ、embedding IS NOT NULLを追加
        if (!whereClause || !whereClause.includes("embedding IS NULL")) {
            finalWhereClause = finalWhereClause ? `(${finalWhereClause}) AND embedding IS NOT NULL` : `embedding IS NOT NULL`;
        }

        if (finalWhereClause) {
            query += ` WHERE ${finalWhereClause}`;
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
    const { logError, logInfo, logWarning, logDebug } = initLogger(env);
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
            logDebug(`Found article by ID: ${articleId}.`, { articleId });
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
    const { logError, logInfo, logWarning } = initLogger(env);
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
    const { logError, logInfo, logWarning } = initLogger(env);
    logInfo(`Deleting old articles from D1 older than ${new Date(cutoffTimestamp).toISOString()}. Embedding IS NULL: ${embeddingIsNull}`);
    try {
        let selectQuery = `SELECT article_id FROM articles WHERE published_at < ?`;
        if (embeddingIsNull) {
            selectQuery += ` AND embedding IS NULL`;
        }
        const { results: articlesToDelete } = await env.DB.prepare(selectQuery).bind(cutoffTimestamp).all<{ article_id: string }>();
        const articleIds = articlesToDelete.map(article => article.article_id);

        if (articleIds.length === 0) {
            logInfo('No old articles found to delete from D1. Skipping cleanup.', { cutoffTimestamp, embeddingIsNull });
            return 0;
        }

        logInfo(`Found ${articleIds.length} old articles to delete. Proceeding with cascading deletion.`, { count: articleIds.length });

        const CHUNK_SIZE_SQL_VARIABLES = 50;
        const articleIdChunks = chunkArray(articleIds, CHUNK_SIZE_SQL_VARIABLES);
        let totalDeleted = 0;

        // 関連テーブルからレコードを削除
        const tablesToClean = ['click_logs', 'sent_articles', 'education_logs'];
        for (const table of tablesToClean) {
            for (const chunk of articleIdChunks) {
                const placeholders = chunk.map(() => '?').join(',');
                const deleteQuery = `DELETE FROM ${table} WHERE article_id IN (${placeholders})`;
                const { success, error, meta } = await env.DB.prepare(deleteQuery).bind(...chunk).run() as D1Result;
                if (success) {
                    logInfo(`Deleted ${meta?.changes || 0} entries from ${table} for old articles.`, { table, deletedCount: meta?.changes || 0 });
                    totalDeleted += meta?.changes || 0;
                } else {
                    logError(`Failed to delete entries from ${table} for old articles: ${error}`, null, { table, error });
                }
            }
        }

        // 最後にarticlesテーブルから記事を削除
        for (const chunk of articleIdChunks) {
            const placeholders = chunk.map(() => '?').join(',');
            const deleteArticlesQuery = `DELETE FROM articles WHERE article_id IN (${placeholders})`;
            const { success, error, meta } = await env.DB.prepare(deleteArticlesQuery).bind(...chunk).run() as D1Result;
            if (success) {
                logInfo(`Successfully deleted ${meta?.changes || 0} old articles from 'articles' table.`, { deletedCount: meta?.changes || 0 });
                totalDeleted += meta?.changes || 0;
            } else {
                logError(`Failed to delete old articles from 'articles' table: ${error}`, null, { error });
            }
        }

        logInfo(`Finished deleting old articles from D1. Total deleted records across all tables: ${totalDeleted}.`, { totalDeleted });
        return totalDeleted;
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
    const { logError, logInfo, logWarning } = initLogger(env);
    logInfo(`Cleaning up old logs for user ${userId} in DB older than ${new Date(cutoffTimestamp).toISOString()}.`);
    let totalDeleted = 0;
    try {
        const tables = ['click_logs', 'sent_articles', 'education_logs'];
        for (const table of tables) {
            const { success, error, meta } = await env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ? AND timestamp < ?`).bind(userId, cutoffTimestamp).run() as D1Result; 
            if (success) {
                totalDeleted += meta?.changes || 0;
                logInfo(`Deleted ${meta?.changes || 0} old entries from ${table} for user ${userId}.`, { table, userId, deletedCount: meta?.changes || 0 });
            } else {
                logError(`Failed to delete old entries from ${table} for user ${userId}: ${error}`, null, { table, userId, error });
            }
        }
        logInfo(`Finished cleanup of old logs for user ${userId} in DB. Total deleted: ${totalDeleted}.`, { userId, totalDeleted });
        return totalDeleted;
    } catch (error) {
        logError(`Error during cleanup of old user logs for user ${userId}:`, error);
        return totalDeleted;
    }
}

/**
 * D1データベースから特定のユーザーが送信した記事を取得します。
 * @param env 環境変数
 * @param userId ユーザーID
 * @param sinceTimestamp このタイムスタンプ以降に送信された記事のみを取得
 * @returns 送信された記事の配列
 */
export async function getSentArticlesForUser(env: Env, userId: string, sinceTimestamp: number): Promise<{ article_id: string, timestamp: number, embedding: number[] }[]> {
    const { logError, logInfo } = initLogger(env);
    logInfo(`Fetching sent articles for user ${userId} from DB since ${new Date(sinceTimestamp).toISOString()}.`);
    try {
        const { results } = await env.DB.prepare(
            `SELECT article_id, timestamp, embedding FROM sent_articles WHERE user_id = ? AND timestamp >= ?`
        ).bind(userId, sinceTimestamp).all<{ article_id: string, timestamp: number, embedding: string }>();

        const articles = results.map(row => ({
            article_id: row.article_id,
            timestamp: row.timestamp,
            embedding: JSON.parse(row.embedding) as number[],
        }));

        logInfo(`Found ${articles.length} sent articles for user ${userId} since ${new Date(sinceTimestamp).toISOString()}.`, { userId, count: articles.length });
        return articles;
    } catch (error) {
        logError(`Error fetching sent articles for user ${userId} from DB:`, error);
        return [];
    }
}

/**
 * D1データベースから特定のユーザーが送信したが、クリックされていない記事を取得します。
 * @param env 環境変数
 * @param userId ユーザーID
 * @param sinceTimestamp このタイムスタンプ以降に送信された記事のみを対象
 * @returns 未クリックの送信済み記事の配列
 */
export async function getUnclickedSentArticles(env: Env, userId: string, sinceTimestamp: number): Promise<{ article_id: string, timestamp: number, embedding: number[] }[]> {
    const { logError, logInfo } = initLogger(env);
    logInfo(`Fetching unclicked sent articles for user ${userId} from DB since ${new Date(sinceTimestamp).toISOString()}.`);
    try {
        const { results } = await env.DB.prepare(
            `SELECT sa.article_id, sa.timestamp, sa.embedding
             FROM sent_articles sa
             LEFT JOIN click_logs cl ON sa.user_id = cl.user_id AND sa.article_id = cl.article_id
             WHERE sa.user_id = ? AND sa.timestamp >= ? AND cl.id IS NULL`
        ).bind(userId, sinceTimestamp).all<{ article_id: string, timestamp: number, embedding: string }>();

        const articles = results.map(row => ({
            article_id: row.article_id,
            timestamp: row.timestamp,
            embedding: JSON.parse(row.embedding) as number[],
        }));

        logInfo(`Found ${articles.length} unclicked sent articles for user ${userId} since ${new Date(sinceTimestamp).toISOString()}.`, { userId, count: articles.length });
        return articles;
    } catch (error) {
        logError(`Error fetching unclicked sent articles for user ${userId} from DB:`, error);
        return [];
    }
}

/**
 * D1データベースから未処理のクリックログを取得します。
 * @param env 環境変数
 * @param userId ユーザーID
 * @returns 未処理のクリックログの配列
 */
export async function getClickLogsForUser(env: Env, userId: string): Promise<{ article_id: string, timestamp: number }[]> {
    const { logError, logInfo, logWarning } = initLogger(env);
    logInfo(`Fetching click logs for user ${userId} from DB.`);
    try {
        const { results } = await env.DB.prepare( 
            `SELECT article_id, timestamp FROM click_logs WHERE user_id = ?`
        ).bind(userId).all<{ article_id: string, timestamp: number }>();
        logInfo(`Found ${results.length} click logs for user ${userId}.`, { userId, count: results.length });
        return results;
    } catch (error) {
        logError(`Error fetching click logs for user ${userId} from DB:`, error);
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
    const { logError, logInfo, logWarning } = initLogger(env);
    if (articleIdsToDelete.length === 0) {
        logInfo('No click logs to delete. Skipping.');
        return 0;
    }
    logInfo(`Deleting ${articleIdsToDelete.length} processed click logs for user ${userId} from DB.`);
    let totalDeleted = 0;
    try {
        const CHUNK_SIZE_SQL_VARIABLES = 50;
        const articleIdChunks = chunkArray(articleIdsToDelete, CHUNK_SIZE_SQL_VARIABLES);

        for (const chunk of articleIdChunks) {
            const placeholders = chunk.map(() => '?').join(',');
            const query = `DELETE FROM click_logs WHERE user_id = ? AND article_id IN (${placeholders})`;
            const stmt = env.DB.prepare(query);
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
        logError(`Error deleting processed click logs for user ${userId} from DB:`, error);
        return totalDeleted;
    }
}

/**
 * ユーザーのクリック率 (CTR) を計算します。
 * @param env 環境変数
 * @param userId ユーザーID
 * @param days 考慮する期間（日数）
 * @returns ユーザーのCTR（0から1の間の数値）
 */
export async function getUserCTR(env: Env, userId: string, days: number = 30): Promise<number> {
    const { logError, logInfo } = initLogger(env);
    try {
        const sinceTimestamp = Date.now() - days * 24 * 60 * 60 * 1000;

        // 配信された記事数を取得
        const sentCountResult = await env.DB.prepare(
            `SELECT COUNT(DISTINCT article_id) as count FROM sent_articles WHERE user_id = ? AND timestamp >= ?`
        ).bind(userId, sinceTimestamp).first<{ count: number }>();
        const sentCount = sentCountResult?.count ?? 0;

        // クリックされた記事数を取得
        const clickCountResult = await env.DB.prepare(
            `SELECT COUNT(DISTINCT article_id) as count FROM click_logs WHERE user_id = ? AND timestamp >= ?`
        ).bind(userId, sinceTimestamp).first<{ count: number }>();
        const clickCount = clickCountResult?.count ?? 0;

        if (sentCount === 0) {
            return 0.5; // 配信履歴がない場合はデフォルト値0.5を返す
        }

        const ctr = clickCount / sentCount;
        logInfo(`Calculated CTR for user ${userId}: ${ctr.toFixed(4)} (${clickCount}/${sentCount})`, { userId, ctr, clickCount, sentCount });
        return ctr;

    } catch (error) {
        logError(`Error calculating CTR for user ${userId}:`, error, { userId });
        return 0.5; // エラー時もデフォルト値0.5を返す
    }
}
