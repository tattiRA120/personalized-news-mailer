import { D1Database } from '@cloudflare/workers-types';
import { Logger } from '../logger';
import { NewsArticle } from '../newsCollector';
import { chunkArray } from '../utils/textProcessor';
import { Env } from '../types/bindings';
import { getDb } from '../db';
import { articles, clickLogs, sentArticles, educationLogs } from '../db/schema';
import { eq, inArray, lt, and, desc, sql, gte, countDistinct } from 'drizzle-orm';

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
export async function saveArticlesToD1(newsArticlesToSave: NewsArticle[], env: Env): Promise<number> {
    const logger = new Logger(env);
    if (newsArticlesToSave.length === 0) {
        logger.info('No articles to save to D1. Skipping.');
        return 0;
    }

    logger.info(`Attempting to save ${newsArticlesToSave.length} articles to D1.`, { count: newsArticlesToSave.length });
    let savedCount = 0;

    try {
        const CHUNK_SIZE_SQL_VARIABLES = 10; // SQLiteの変数制限を考慮してチャンクサイズを設定
        const articleChunks = chunkArray(newsArticlesToSave, CHUNK_SIZE_SQL_VARIABLES); // 記事の配列をチャンクに分割

        const result = await logger.logBatchProcess(
            'D1 article batch insert',
            articleChunks,
            async (chunk: NewsArticle[], chunkIndex: number) => {
                let success = false;
                let error = '';
                const db = getDb(env);
                let changes = 0;

                // DrizzleORM doesn't natively support ON CONFLICT DO UPDATE where condition like `articles.content != EXCLUDED.content` easily inside a single batch insert for complex logic.
                // However, we can use `onConflictDoUpdate` from SQLite dialect.

                try {
                    // D1 with Drizzle batch or single insert with onConflictDoUpdate
                    // To do it efficiently, we insert chunk by chunk
                    const valuesToInsert = chunk.map(article => ({
                        article_id: article.articleId,
                        title: article.title,
                        url: article.link,
                        published_at: isNaN(article.publishedAt) ? Date.now() : article.publishedAt,
                        content: article.content || '',
                        embedding: null as string | null // null indicates it needs generating
                    }));

                    const res = await db.insert(articles).values(valuesToInsert)
                        .onConflictDoUpdate({
                            target: articles.url,
                            set: {
                                title: sql`excluded.title`,
                                published_at: sql`excluded.published_at`,
                                content: sql`excluded.content`,
                                // If content changed, reset embedding. Otherwise keep old one.
                                embedding: sql`CASE WHEN articles.content != excluded.content THEN NULL ELSE articles.embedding END`
                            }
                        }).run();

                    success = true;
                    changes = res.meta?.changes || 0;
                } catch (e: any) {
                    success = false;
                    error = e instanceof Error ? e.message : String(e);
                }

                if (success) {
                    const skippedCount = chunk.length - changes;
                    savedCount += changes;

                    if (skippedCount > 0) {
                        logger.warn(`Skipped ${skippedCount} articles in D1 batch due to existing article_id or url.`, { skippedCount, chunkIndex });
                    }
                } else {
                    throw new Error(`Failed to save articles to D1 in batch: ${error}`);
                }
            },
            {
                onItemSuccess: (chunk: NewsArticle[], chunkIndex: number) => {
                    // 個々のチャンクの成功はdebugレベルでログ
                    logger.debug(`Successfully processed article chunk ${chunkIndex + 1}`, { chunkSize: chunk.length });
                },
                onItemError: (chunk: NewsArticle[], chunkIndex: number, error: any) => {
                    // エラーはlogBatchProcess内で処理されるため、ここでは何もしない
                }
            }
        );

        logger.info(`Finished saving articles to D1. Total saved: ${savedCount}.`, { totalSaved: savedCount });
        return savedCount;
    } catch (error) {
        logger.error('Error saving articles to D1:', error, { count: newsArticlesToSave.length });
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
    const logger = new Logger(env);
    logger.info(`Fetching articles from D1 with limit ${limit}, offset ${offset}, where: ${whereClause}.`);
    try {
        const db = getDb(env);

        // This function is tricky because whereClause is passed as string.
        // For safe migration, we'll keep raw SQL for `getArticlesFromD1` since the parameter `whereClause` assumes string injection.
        // It's mostly used by embedding generators.
        // Wait, we can rewrite it to use DB.prepare still, or Drizzle `sql`
        // We will keep raw DB.prepare for this specific function as it dynamically builds strings like "embedding IS NULL".
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

        const articlesFromDb: ArticleWithEmbedding[] = (results as any[]).map(row => ({
            articleId: row.article_id,
            title: row.title,
            link: row.url,
            sourceName: '', // D1から取得したデータにはsourceNameがないため、空文字列で初期化
            summary: row.content ? row.content.substring(0, Math.min(row.content.length, 200)) : '',
            content: row.content,
            embedding: row.embedding ? JSON.parse(row.embedding) : undefined, // embeddingはD1から取得し、必要に応じて付与
            publishedAt: row.published_at,
        }));
        logger.info(`Fetched ${articlesFromDb.length} articles from D1.`, { count: articlesFromDb.length });
        return articlesFromDb;
    } catch (error) {
        logger.error('Error fetching articles from D1:', error, { errorDetails: error instanceof Error ? error.message : error });
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
    const logger = new Logger(env);
    logger.debug(`Fetching article by ID from D1: ${articleId}.`);
    try {
        const db = getDb(env);
        const results = await db.select({
            article_id: articles.article_id,
            title: articles.title,
            url: articles.url,
            published_at: articles.published_at,
            content: articles.content,
            embedding: articles.embedding
        })
            .from(articles)
            .where(eq(articles.article_id, articleId))
            .limit(1);

        if (results && results.length > 0) {
            const row = results[0];
            const article: ArticleWithEmbedding = {
                articleId: row.article_id,
                title: row.title,
                link: row.url,
                sourceName: '',
                summary: row.content ? row.content.substring(0, Math.min(row.content.length, 200)) : '',
                content: row.content || '',
                embedding: row.embedding ? JSON.parse(row.embedding) : undefined, // embeddingはD1から取得し、必要に応じて付与
                publishedAt: row.published_at,
            };
            logger.debug(`Found article by ID: ${articleId}.`, { articleId });
            return article;
        }
        logger.warn(`Article with ID ${articleId} not found in D1.`, { articleId });
        return null;
    } catch (error) {
        logger.error(`Error fetching article by ID ${articleId} from D1:`, error, { articleId, errorDetails: error instanceof Error ? error.message : error });
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
    const logger = new Logger(env);
    logger.info(`Updating embedding for article ${articleId} in D1.`);
    try {
        const db = getDb(env);
        const res = await db.update(articles)
            .set({ embedding: JSON.stringify(embedding) })
            .where(eq(articles.article_id, articleId))
            .run();
        const success = res.success;
        const meta = res.meta;
        if (success) {
            logger.info(`Successfully updated embedding for article ${articleId}. Changes: ${meta?.changes || 0}`, { articleId, changes: meta?.changes || 0 });
            return true;
        } else {
            logger.error(`Failed to update embedding for article ${articleId}`, null, { articleId });
            return false;
        }
    } catch (error) {
        logger.error(`Error updating embedding for article ${articleId} in D1:`, error);
        return false;
    }
}

/**
 * D1データベースから古い記事を削除します。
 * @param env 環境変数
 * @param articleIdsToKeep 削除せずに残す記事のIDの配列
 * @returns 削除された記事の数
 */
export async function deleteOldArticlesFromD1(env: Env, articleIdsToKeep: string[]): Promise<number> {
    const logger = new Logger(env);
    logger.info(`Starting D1 article cleanup. Articles to keep: ${articleIdsToKeep.length} IDs.`);
    try {
        // データベース上のすべての記事IDを取得
        const db = getDb(env);
        const allArticlesResults = await db.select({ article_id: articles.article_id }).from(articles);
        const allArticleIds = new Set(allArticlesResults.map(article => article.article_id));
        logger.debug(`Found ${allArticleIds.size} total articles in D1.`);

        // 残す記事IDのセットを作成
        const keepArticleIdsSet = new Set(articleIdsToKeep);

        // 削除対象の記事IDを特定
        const articleIdsToDelete: string[] = [];
        for (const articleId of allArticleIds) {
            if (!keepArticleIdsSet.has(articleId)) {
                articleIdsToDelete.push(articleId);
            }
        }

        if (articleIdsToDelete.length === 0) {
            logger.info('No articles found to delete from D1. All articles are either to be kept or the database is empty. Skipping cleanup.');
            return 0;
        }

        logger.info(`Found ${articleIdsToDelete.length} articles to delete. Proceeding with cascading deletion.`, { count: articleIdsToDelete.length });

        const CHUNK_SIZE_SQL_VARIABLES = 50;
        const articleIdChunks = chunkArray(articleIdsToDelete, CHUNK_SIZE_SQL_VARIABLES);
        let totalDeleted = 0;

        // 関連テーブルからレコードを削除
        for (const chunk of articleIdChunks) {
            // click_logs
            let res = await db.delete(clickLogs).where(inArray(clickLogs.article_id, chunk)).run();
            if (res.success) {
                logger.info(`Deleted ${res.meta?.changes || 0} entries from click_logs for old articles.`, { table: 'click_logs', deletedCount: res.meta?.changes || 0 });
                totalDeleted += res.meta?.changes || 0;
            } else {
                logger.error(`Failed to delete entries from click_logs for old articles:`, res.error, { table: 'click_logs' });
            }

            // sent_articles
            res = await db.delete(sentArticles).where(inArray(sentArticles.article_id, chunk)).run();
            if (res.success) {
                logger.info(`Deleted ${res.meta?.changes || 0} entries from sent_articles for old articles.`, { table: 'sent_articles', deletedCount: res.meta?.changes || 0 });
                totalDeleted += res.meta?.changes || 0;
            } else {
                logger.error(`Failed to delete entries from sent_articles for old articles:`, res.error, { table: 'sent_articles' });
            }

            // education_logs
            res = await db.delete(educationLogs).where(inArray(educationLogs.article_id, chunk)).run();
            if (res.success) {
                logger.info(`Deleted ${res.meta?.changes || 0} entries from education_logs for old articles.`, { table: 'education_logs', deletedCount: res.meta?.changes || 0 });
                totalDeleted += res.meta?.changes || 0;
            } else {
                logger.error(`Failed to delete entries from education_logs for old articles:`, res.error, { table: 'education_logs' });
            }
        }

        // 最後にarticlesテーブルから記事を削除
        for (const chunk of articleIdChunks) {
            const res = await db.delete(articles).where(inArray(articles.article_id, chunk)).run();
            if (res.success) {
                logger.info(`Successfully deleted ${res.meta?.changes || 0} old articles from 'articles' table.`, { deletedCount: res.meta?.changes || 0 });
                totalDeleted += res.meta?.changes || 0;
            } else {
                logger.error(`Failed to delete old articles from 'articles' table:`, res.error, { error: res.error });
            }
        }

        logger.info(`Finished deleting old articles from D1. Total deleted records across all tables: ${totalDeleted}.`, { totalDeleted });
        return totalDeleted;
    } catch (error) {
        logger.error('Error during D1 article cleanup:', error, { errorDetails: error instanceof Error ? error.message : error });
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
    const logger = new Logger(env);
    logger.info(`Cleaning up old logs for user ${userId} in DB older than ${new Date(cutoffTimestamp).toISOString()}.`);
    let totalDeleted = 0;
    try {
        const db = getDb(env);
        // click_logs
        let res = await db.delete(clickLogs).where(and(eq(clickLogs.user_id, userId), lt(clickLogs.timestamp, cutoffTimestamp))).run();
        if (res.success) {
            totalDeleted += res.meta?.changes || 0;
            logger.info(`Deleted ${res.meta?.changes || 0} old entries from click_logs for user ${userId}.`, { table: 'click_logs', userId, deletedCount: res.meta?.changes || 0 });
        } else {
            logger.error(`Failed to delete old entries from click_logs for user ${userId}: ${res.error}`, null, { table: 'click_logs', userId, error: res.error });
        }

        // sent_articles
        res = await db.delete(sentArticles).where(and(eq(sentArticles.user_id, userId), lt(sentArticles.timestamp, cutoffTimestamp))).run();
        if (res.success) {
            totalDeleted += res.meta?.changes || 0;
            logger.info(`Deleted ${res.meta?.changes || 0} old entries from sent_articles for user ${userId}.`, { table: 'sent_articles', userId, deletedCount: res.meta?.changes || 0 });
        } else {
            logger.error(`Failed to delete old entries from sent_articles for user ${userId}: ${res.error}`, null, { table: 'sent_articles', userId, error: res.error });
        }

        // education_logs
        res = await db.delete(educationLogs).where(and(eq(educationLogs.user_id, userId), lt(educationLogs.timestamp, cutoffTimestamp))).run();
        if (res.success) {
            totalDeleted += res.meta?.changes || 0;
            logger.info(`Deleted ${res.meta?.changes || 0} old entries from education_logs for user ${userId}.`, { table: 'education_logs', userId, deletedCount: res.meta?.changes || 0 });
        } else {
            logger.error(`Failed to delete old entries from education_logs for user ${userId}: ${res.error}`, null, { table: 'education_logs', userId, error: res.error });
        }

        logger.info(`Finished cleanup of old logs for user ${userId} in DB. Total deleted: ${totalDeleted}.`, { userId, totalDeleted });
        return totalDeleted;
    } catch (error) {
        logger.error(`Error during cleanup of old user logs for user ${userId}:`, error, { userId, errorDetails: error instanceof Error ? error.message : error });
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
    const logger = new Logger(env);
    logger.info(`Fetching sent articles for user ${userId} from DB since ${new Date(sinceTimestamp).toISOString()}.`);
    try {
        const db = getDb(env);
        const results = await db.select({
            article_id: sentArticles.article_id,
            timestamp: sentArticles.timestamp,
            embedding: sentArticles.embedding
        })
            .from(sentArticles)
            .where(and(eq(sentArticles.user_id, userId), gte(sentArticles.timestamp, sinceTimestamp)));

        const articles = results.map(row => ({
            article_id: row.article_id,
            timestamp: row.timestamp,
            embedding: (row.embedding ? JSON.parse(row.embedding) : []) as number[],
        }));

        logger.info(`Found ${articles.length} sent articles for user ${userId} since ${new Date(sinceTimestamp).toISOString()}.`, { userId, count: articles.length });
        return articles;
    } catch (error) {
        logger.error(`Error fetching sent articles for user ${userId} from DB:`, error);
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
    const logger = new Logger(env);
    logger.info(`Fetching click logs for user ${userId} from DB.`);
    try {
        const db = getDb(env);
        const results = await db.select({
            article_id: clickLogs.article_id,
            timestamp: clickLogs.timestamp
        })
            .from(clickLogs)
            .where(eq(clickLogs.user_id, userId));
        logger.info(`Found ${results.length} click logs for user ${userId}.`, { userId, count: results.length });
        return results;
    } catch (error) {
        logger.error(`Error fetching click logs for user ${userId} from DB:`, error);
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
    const logger = new Logger(env);
    if (articleIdsToDelete.length === 0) {
        logger.info('No click logs to delete. Skipping.');
        return 0;
    }
    logger.info(`Deleting ${articleIdsToDelete.length} processed click logs for user ${userId} from DB.`);
    let totalDeleted = 0;
    try {
        const CHUNK_SIZE_SQL_VARIABLES = 50;
        const articleIdChunks = chunkArray(articleIdsToDelete, CHUNK_SIZE_SQL_VARIABLES);

        const db = getDb(env);
        for (const chunk of articleIdChunks) {
            const res = await db.delete(clickLogs)
                .where(and(eq(clickLogs.user_id, userId), inArray(clickLogs.article_id, chunk)))
                .run();

            if (res.success) {
                totalDeleted += res.meta?.changes || 0;
                logger.info(`Deleted ${res.meta?.changes || 0} click logs in batch for user ${userId}.`, { userId, deletedCount: res.meta?.changes || 0 });
            } else {
                logger.error(`Failed to delete click logs in batch for user ${userId}: ${res.error}`, null, { userId, error: res.error });
            }
        }
        logger.info(`Finished deleting processed click logs for user ${userId}. Total deleted: ${totalDeleted}.`, { userId, totalDeleted });
        return totalDeleted;
    } catch (error) {
        logger.error(`Error deleting processed click logs for user ${userId} from DB:`, error);
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
    const logger = new Logger(env);
    try {
        const sinceTimestamp = Date.now() - days * 24 * 60 * 60 * 1000;

        const db = getDb(env);
        // 配信された記事数を取得
        const sentCountResults = await db.select({ count: countDistinct(sentArticles.article_id) })
            .from(sentArticles)
            .where(and(eq(sentArticles.user_id, userId), gte(sentArticles.timestamp, sinceTimestamp)));
        const sentCount = sentCountResults[0]?.count ?? 0;

        // クリックされた記事数を取得
        const clickCountResults = await db.select({ count: countDistinct(clickLogs.article_id) })
            .from(clickLogs)
            .where(and(eq(clickLogs.user_id, userId), gte(clickLogs.timestamp, sinceTimestamp)));
        const clickCount = clickCountResults[0]?.count ?? 0;

        if (sentCount === 0) {
            return 0.5; // 配信履歴がない場合はデフォルト値0.5を返す
        }

        const ctr = clickCount / sentCount;
        logger.info(`Calculated CTR for user ${userId}: ${ctr.toFixed(4)} (${clickCount}/${sentCount})`, { userId, ctr, clickCount, sentCount });
        return ctr;

    } catch (error) {
        logger.error(`Error calculating CTR for user ${userId}:`, error, { userId });
        return 0.5; // エラー時もデフォルト値0.5を返す
    }
}

/**
 * ユーザーの直近のポジティブフィードバック（クリック）記事の埋め込みを取得します。
 * ポートフォリオ型推薦アルゴリズムにおける「短期的興味」の計算に使用します。
 * @param env 環境変数
 * @param userId ユーザーID
 * @param limit 取得する記事の最大数（デフォルト10）
 * @returns 直近のクリック記事の埋め込みベクトルの配列
 */
export async function getRecentPositiveFeedbackEmbeddings(env: Env, userId: string, limit: number = 10): Promise<number[][]> {
    const logger = new Logger(env);
    logger.info(`Fetching recent positive feedback embeddings for user ${userId} (limit: ${limit}).`);
    try {
        const db = getDb(env);
        const results = await db.select({
            embedding: articles.embedding
        })
            .from(clickLogs)
            .innerJoin(articles, eq(clickLogs.article_id, articles.article_id))
            .where(and(eq(clickLogs.user_id, userId), sql`${articles.embedding} IS NOT NULL`))
            .orderBy(desc(clickLogs.timestamp))
            .limit(limit);

        const embeddings: number[][] = [];
        if (results) {
            for (const row of results) {
                try {
                    const embedding = row.embedding ? JSON.parse(row.embedding) : null;
                    if (Array.isArray(embedding)) {
                        embeddings.push(embedding);
                    }
                } catch (e) {
                    logger.warn(`Failed to parse embedding for recent positive feedback article`, e);
                }
            }
        }
        logger.info(`Fetched ${embeddings.length} recent positive feedback embeddings for user ${userId}.`, { userId, count: embeddings.length });
        return embeddings;
    } catch (error) {
        logger.error(`Error fetching recent positive feedback embeddings for user ${userId}:`, error, { userId });
        return [];
    }
}

/**
 * ユーザーが明示的に「興味あり」とフィードバックした記事の埋め込みを取得します。
 * ポートフォリオ型推薦アルゴリズムにおける「教育的興味（Explicit Interest）」の計算に使用します。
 * @param env 環境変数
 * @param userId ユーザーID
 * @param limit 取得する記事の最大数（デフォルト50）
 * @returns 興味あり記事の埋め込みベクトルの配列
 */
export async function getExplicitPositiveFeedbackEmbeddings(env: Env, userId: string, limit: number = 50): Promise<number[][]> {
    const logger = new Logger(env);
    logger.info(`Fetching explicit positive feedback embeddings for user ${userId} (limit: ${limit}).`);
    try {
        const db = getDb(env);
        // education_logs と articles (または sent_articles) を結合して埋め込みを取得
        // action = 'interested' のもののみ
        const results = await db.select({
            embedding: articles.embedding
        })
            .from(educationLogs)
            .innerJoin(articles, eq(educationLogs.article_id, articles.article_id))
            .where(and(eq(educationLogs.user_id, userId), eq(educationLogs.action, 'interested'), sql`${articles.embedding} IS NOT NULL`))
            .orderBy(desc(educationLogs.timestamp))
            .limit(limit);

        const embeddings: number[][] = [];
        if (results) {
            for (const row of results) {
                try {
                    const embedding = row.embedding ? JSON.parse(row.embedding) : null;
                    if (Array.isArray(embedding)) {
                        embeddings.push(embedding);
                    }
                } catch (e) {
                    logger.warn(`Failed to parse embedding for explicit positive feedback article`, e);
                }
            }
        }
        logger.info(`Fetched ${embeddings.length} explicit positive feedback embeddings for user ${userId}.`, { userId, count: embeddings.length });
        return embeddings;
    } catch (error) {
        logger.error(`Error fetching explicit positive feedback embeddings for user ${userId}:`, error, { userId });
        return [];
    }
}
