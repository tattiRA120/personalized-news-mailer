import { Env } from '../index'; // Env型をインポート
import { collectNews, NewsArticle } from '../newsCollector';
import { generateAndSaveEmbeddings } from '../services/embeddingService';
import { saveArticlesToD1, getArticlesFromD1, getArticleByIdFromD1, deleteOldArticlesFromD1, cleanupOldUserLogs, getClickLogsForUser, deleteProcessedClickLogs } from '../services/d1Service';
import { getAllUserIds, getUserProfile } from '../userProfile';
import { selectPersonalizedArticles } from '../articleSelector';
import { generateNewsEmail, sendNewsEmail } from '../emailGenerator';
import { ClickLogger } from '../clickLogger';
import { logError, logInfo, logWarning } from '../logger';
import { chunkArray } from '../utils/textProcessor';

interface EmailRecipient {
    email: string;
    name?: string;
}

// NewsArticle型を拡張してembeddingプロパティを持つように定義
interface NewsArticleWithEmbedding extends NewsArticle {
    embedding?: number[];
}

/**
 * 定期実行タスクのメインオーケストレーションロジック。
 * ニュース収集、埋め込み生成、メール送信、ログ処理、クリーンアップを行います。
 * @param env 環境変数
 * @param scheduledTime スケジュールされた実行時間 (UTC)
 */
export async function orchestrateMailDelivery(env: Env, scheduledTime: Date): Promise<void> {
    logInfo('Mail delivery orchestration started', { scheduledTime: scheduledTime.toISOString() });

    try {
        // --- 1. News Collection ---
        logInfo('Starting news collection...');
        const articles = await collectNews();
        logInfo(`Collected ${articles.length} articles.`, { articleCount: articles.length });

        if (articles.length === 0) {
            logInfo('No articles collected. Skipping further steps.');
            return;
        }

        // --- 1. 新規記事のみをD1に保存 ---
        const articleIds = articles.map(a => a.articleId).filter(Boolean) as string[];
        logInfo(`Collected ${articleIds.length} article IDs from new articles.`, { count: articleIds.length });

        let newArticles: NewsArticle[] = [];
        if (articleIds.length > 0) {
            const CHUNK_SIZE_SQL_VARIABLES = 50;
            const articleIdChunks = chunkArray(articleIds, CHUNK_SIZE_SQL_VARIABLES);
            const existingArticleIds = new Set<string>();

            for (const chunk of articleIdChunks) {
                const placeholders = chunk.map(() => '?').join(',');
                const query = `SELECT article_id FROM articles WHERE article_id IN (${placeholders})`;
                logInfo(`Executing D1 query to find existing articles: ${query} with ${chunk.length} variables.`, { query, variableCount: chunk.length });
                const stmt = env.DB.prepare(query);
                const { results: existingRows } = await stmt.bind(...chunk).all<{ article_id: string }>();
                existingRows.forEach(row => existingArticleIds.add(row.article_id));
            }
            logInfo(`Found ${existingArticleIds.size} existing article IDs in D1.`, { count: existingArticleIds.size });

            newArticles = articles.filter(article => article.articleId && !existingArticleIds.has(article.articleId));
            logInfo(`Filtered down to ${newArticles.length} new articles to be saved.`, { count: newArticles.length });

            if (newArticles.length > 0) {
                await saveArticlesToD1(newArticles, env); // d1ServiceのsaveArticlesToD1を使用
                logInfo(`Saved ${newArticles.length} new articles to D1.`, { count: newArticles.length });
            }
        }

        // 日本時間22時（UTC 13時）のCronトリガーでのみ埋め込みバッチジョブを作成
        const scheduledHourUTC = scheduledTime.getUTCHours();
        if (scheduledHourUTC === 13) { // 22:00 JST is 13:00 UTC
        // D1からembeddingがまだない記事を取得
        const articlesMissingEmbedding = await getArticlesFromD1(env, 1000, 0, "embedding IS NULL") as NewsArticleWithEmbedding[];
        logInfo(`Found ${articlesMissingEmbedding.length} articles missing embeddings in D1.`, { count: articlesMissingEmbedding.length });

        if (articlesMissingEmbedding.length > 0) {
            await generateAndSaveEmbeddings(articlesMissingEmbedding, env);
        } else {
            logInfo('No new articles found that need embedding. Skipping batch job creation.');
        }
    }

    // --- Fetch articles from D1 ---
    logInfo('Fetching articles from D1 for email sending.');
    const articlesFromD1 = await getArticlesFromD1(env, 1000) as NewsArticleWithEmbedding[]; // d1ServiceのgetArticlesFromD1を使用
    logInfo(`Fetched ${articlesFromD1.length} articles from D1.`, { count: articlesFromD1.length });

    if (articlesFromD1.length === 0) {
        logInfo('No articles found in D1 for email sending. Skipping further steps.');
        return;
    }

    const articlesWithEmbeddings = articlesFromD1.filter(article => article.embedding && article.embedding.length > 0) as NewsArticleWithEmbedding[];
    logInfo(`Found ${articlesWithEmbeddings.length} articles with embeddings from D1.`, { count: articlesWithEmbeddings.length });

    if (articlesWithEmbeddings.length === 0) {
        logWarning('No articles with embeddings found in D1. Cannot proceed with personalization.', null);
        return;
    }

        // --- 2. Get all users ---
        logInfo('Fetching all user IDs...');
        const userIds = await getAllUserIds(env);
        logInfo(`Found ${userIds.length} users to process.`, { userCount: userIds.length });

        if (userIds.length === 0) {
            logInfo('No users found. Skipping email sending.');
            return;
        }

        // --- Process each user ---
        logInfo('Processing news for each user...');
        for (const userId of userIds) {
            try {
                logInfo(`Processing user: ${userId}`);

                const userProfile = await getUserProfile(userId, env);

                if (!userProfile) {
                    logError(`User profile not found for ${userId}. Skipping email sending for this user.`, null, { userId });
                    continue;
                }
                logInfo(`Loaded user profile for ${userId}.`);

                const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
                const clickLogger: DurableObjectStub<ClickLogger> = env.CLICK_LOGGER.get(clickLoggerId);

                // --- 3. Article Selection (MMR + Bandit) ---
                logInfo(`Starting article selection (MMR + Bandit) for user ${userId}...`, { userId });
                const numberOfArticlesToSend = 5;
                const selectedArticles = await selectPersonalizedArticles(articlesWithEmbeddings, userProfile, clickLogger, userId, numberOfArticlesToSend, 0.5, env) as NewsArticleWithEmbedding[];
                logInfo(`Selected ${selectedArticles.length} articles for user ${userId}.`, { userId, selectedCount: selectedArticles.length });

                if (selectedArticles.length === 0) {
                    logInfo('No articles selected. Skipping email sending for this user.', { userId });
                    continue;
                }

                // --- 4. Email Generation & Sending ---
                logInfo(`Generating and sending email for user ${userId}...`, { userId });
                const recipientEmail = userProfile.email;
                if (!recipientEmail) {
                    logError(`User profile for ${userId} does not contain an email address. Skipping email sending.`, null, { userId });
                    continue;
                }
                const sender: EmailRecipient = { email: recipientEmail, name: 'Mailify News' };

                const emailResponse = await sendNewsEmail(env, recipientEmail, userId, selectedArticles, sender);

                if (emailResponse.ok) {
                    logInfo(`Personalized news email sent to ${recipientEmail} via Gmail API.`, { userId, email: recipientEmail });
                } else {
                    logError(`Failed to send email to ${recipientEmail} via Gmail API: ${emailResponse.statusText}`, null, { userId, email: recipientEmail, status: emailResponse.status, statusText: emailResponse.statusText });
                }

                // --- 5. Log Sent Articles to Durable Object ---
                logInfo(`Logging sent articles to ClickLogger for user ${userId}...`, { userId });
                const sentArticlesData = selectedArticles.map(article => ({
                    articleId: article.articleId,
                    timestamp: Date.now(),
                    embedding: article.embedding!, // NewsArticleWithEmbeddingなのでembeddingは存在すると仮定
                }));

                const logSentResponse = await clickLogger.fetch(
                    new Request(`${env.WORKER_BASE_URL}/log-sent-articles`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: userId, sentArticles: sentArticlesData }),
                    })
                );

                if (logSentResponse.ok) {
                    logInfo(`Successfully logged sent articles for user ${userId}.`, { userId });
                } else {
                    logError(`Failed to log sent articles for user ${userId}: ${logSentResponse.statusText}`, null, { userId, status: logSentResponse.status, statusText: logSentResponse.statusText });
                }

                // --- 6. Process Click Logs and Update Bandit Model ---
                logInfo(`Processing click logs and updating bandit model for user ${userId}...`, { userId });

                const clickLogs = await getClickLogsForUser(env, userId); // d1ServiceのgetClickLogsForUserを使用
                logInfo(`Found ${clickLogs.length} click logs to process for user ${userId}.`, { userId, count: clickLogs.length });

                if (clickLogs.length > 0) {
                    const updatePromises = clickLogs.map(async clickLog => {
                        const articleId = clickLog.article_id;
                        const article = await getArticleByIdFromD1(articleId, env) as NewsArticleWithEmbedding | null; // d1ServiceのgetArticleByIdFromD1を使用

                        if (article && article.embedding) {
                            const reward = 1.0;
                            const updateResponse = await clickLogger.fetch(
                                new Request('/update-bandit-from-click', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ userId: userId, articleId: articleId, embedding: article.embedding, reward: reward }),
                                })
                            );

                            if (updateResponse.ok) {
                                logInfo(`Successfully updated bandit model from click for article ${articleId} for user ${userId}.`, { userId, articleId });
                            } else {
                                logError(`Failed to update bandit model from click for article ${articleId} for user ${userId}: ${updateResponse.statusText}`, null, { userId, articleId, status: updateResponse.status, statusText: updateResponse.statusText });
                            }
                        } else {
                            logWarning(`Article embedding not found in D1 for clicked article ${articleId} for user ${userId}. Cannot update bandit model.`, { userId, articleId });
                        }
                    });
                    await Promise.all(updatePromises);
                    logInfo(`Finished processing click logs and updating bandit model for user ${userId}.`, { userId });

                    // 処理済みのクリックログをD1から削除
                    const clickLogArticleIdsToDelete = clickLogs.map(log => log.article_id);
                    await deleteProcessedClickLogs(env, userId, clickLogArticleIdsToDelete); // d1ServiceのdeleteProcessedClickLogsを使用

                } else {
                    logInfo(`No click logs to process for user ${userId}.`, { userId });
                }

                // --- 7. Clean up old logs in D1 ---
                logInfo(`Starting cleanup of old logs for user ${userId}...`, { userId });
                const daysToKeepLogs = 30;
                const cutoffTimestamp = Date.now() - daysToKeepLogs * 24 * 60 * 60 * 1000;
                await cleanupOldUserLogs(env, userId, cutoffTimestamp); // d1ServiceのcleanupOldUserLogsを使用

                logInfo(`Finished processing user ${userId}.`, { userId });

            } catch (userProcessError) {
                logError(`Error processing user ${userId}:`, userProcessError, { userId });
            }
        } // End of user loop

        // --- 8. Clean up old articles in D1 ---
        if (scheduledHourUTC === 23) { // Check if it's the email sending cron (08:00 JST, 23:00 UTC previous day)
            logInfo('Starting D1 article cleanup...');
            try {
                const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
                await deleteOldArticlesFromD1(env, twentyFourHoursAgo, true); // embeddingがNULLの24時間以上前の記事を削除

                const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
                await deleteOldArticlesFromD1(env, thirtyDaysAgo, false); // 30日以上前の全ての記事を削除

            } catch (cleanupError) {
                logError('Error during D1 article cleanup:', cleanupError);
            }
        }

        logInfo('Mail delivery orchestration finished.');

    } catch (mainError) {
        logError('Error during mail delivery orchestration:', mainError);
    }
}
