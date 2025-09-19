import { Env } from '../index';
import { collectNews, NewsArticle } from '../newsCollector';
import { generateAndSaveEmbeddings } from '../services/embeddingService';
import { saveArticlesToD1, getArticlesFromD1, getArticleByIdFromD1, deleteOldArticlesFromD1, cleanupOldUserLogs, getClickLogsForUser, deleteProcessedClickLogs, getUserCTR } from '../services/d1Service';
import { getAllUserIds, getUserProfile } from '../userProfile';
import { selectPersonalizedArticles, cosineSimilarity } from '../articleSelector';
import { generateNewsEmail, sendNewsEmail } from '../emailGenerator';
import { ClickLogger } from '../clickLogger';
import { initLogger } from '../logger';
import { chunkArray } from '../utils/textProcessor';
import { DurableObjectStub } from '@cloudflare/workers-types';

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
 * @param isTestRun テスト実行かどうかを示すフラグ (オプション)
 */
export async function orchestrateMailDelivery(env: Env, scheduledTime: Date, isTestRun: boolean = false): Promise<void> {
    const { logError, logInfo, logWarning, logDebug } = initLogger(env);
    logInfo('Mail delivery orchestration started', { scheduledTime: scheduledTime.toISOString(), isTestRun });

    try {
        // --- 1. News Collection ---
        logInfo('Starting news collection...');
        const articles = await collectNews(env);
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
                logDebug(`Executing D1 query to find existing articles: ${query} with ${chunk.length} variables.`, { query, variableCount: chunk.length });
                const stmt = env.DB.prepare(query);
                const { results: existingRows } = await stmt.bind(...chunk).all<{ article_id: string }>();
                existingRows.forEach(row => existingArticleIds.add(row.article_id));
            }
            logDebug(`Found ${existingArticleIds.size} existing article IDs in D1.`, { count: existingArticleIds.size });

            newArticles = articles.filter(article => article.articleId && !existingArticleIds.has(article.articleId));
            logInfo(`Filtered down to ${newArticles.length} new articles to be saved.`, { count: newArticles.length });

            if (newArticles.length > 0) {
                await saveArticlesToD1(newArticles, env); // d1ServiceのsaveArticlesToD1を使用
                logInfo(`Saved ${newArticles.length} new articles to D1.`, { count: newArticles.length });
            }
        }

        const scheduledHourUTC = scheduledTime.getUTCHours();

        // UTC 13時 (日本時間 22時) のCronトリガーでのみ埋め込みバッチジョブを作成
        if (scheduledHourUTC === 13) {
            logInfo('Starting embedding generation for articles missing embeddings in D1.');
            const articlesMissingEmbedding = await getArticlesFromD1(env, 1000, 0, "embedding IS NULL") as NewsArticleWithEmbedding[];
            logInfo(`Found ${articlesMissingEmbedding.length} articles missing embeddings in D1.`, { count: articlesMissingEmbedding.length });

            if (articlesMissingEmbedding.length > 0) {
                await generateAndSaveEmbeddings(articlesMissingEmbedding, env, "__SYSTEM_EMBEDDING__", false);
            } else {
                logInfo('No articles found that need embedding. Skipping batch job creation.');
            }
        }

        // UTC 23時 (日本時間 8時) のCronトリガー、またはテスト実行の場合にメール送信と関連動作を実行
        if (isTestRun || scheduledHourUTC === 23) {
            // --- Fetch articles from D1 ---
            logInfo('Fetching articles from D1 for email sending (only articles with embeddings).');
            const articlesWithEmbeddings = await getArticlesFromD1(env, 1000) as NewsArticleWithEmbedding[]; // d1ServiceのgetArticlesFromD1を使用
            logInfo(`Fetched ${articlesWithEmbeddings.length} articles with embeddings from D1.`, { count: articlesWithEmbeddings.length });

            if (articlesWithEmbeddings.length === 0) {
                logWarning('No articles with embeddings found in D1. Cannot proceed with personalization.', null);
                return; // メール送信をスキップ
            }

            // --- 2. Get all users ---
            logInfo('Fetching all user IDs...');
            const userIds = await getAllUserIds(env);
            logInfo(`Found ${userIds.length} users to process.`, { userCount: userIds.length });

            if (userIds.length === 0) {
                logInfo('No users found. Skipping email sending.');
                return; // メール送信をスキップ
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
                    const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

                    // --- 3. Article Selection (MMR + Bandit) ---
                    logInfo(`Starting article selection (MMR + Bandit) for user ${userId}...`, { userId });
                    const numberOfArticlesToSend = 5;

                    // Get user's CTR for dynamic parameter adjustment
                    const userCTR = await getUserCTR(env, userId);

                    // --- Feature Engineering: Add article freshness ---
                    const now = Date.now();
                    const articlesWithFeatures = articlesWithEmbeddings.map(article => {
                        const ageInHours = (now - new Date(article.publishedAt).getTime()) / (1000 * 60 * 60);
                        // Normalize age (e.g., cap at 7 days, scale to 0-1)
                        const normalizedAge = Math.min(ageInHours / (24 * 7), 1.0);
                        const extendedEmbedding = article.embedding ? [...article.embedding, normalizedAge] : undefined;
                        return { ...article, embedding: extendedEmbedding };
                    });

                    // UCB計算の負荷を軽減しつつ、より多くの記事を対象とするため、記事候補を戦略的にサンプリング
                    // --- Strategic Sampling for Article Candidates ---
                    const EXPLOITATION_COUNT = 150;
                    const EXPLORATION_COUNT = 50;

                    let articlesForSelection: NewsArticleWithEmbedding[] = [];

                    if (userProfile.embedding && userProfile.embedding.length > 0) {
                        // NOTE: We use the original embeddings for similarity calculation, not the extended ones.
                        const articlesWithSimilarity = articlesWithEmbeddings.map(article => ({
                            ...article,
                            similarity: article.embedding ? cosineSimilarity(userProfile.embedding!, article.embedding) : 0,
                        })).sort((a, b) => b.similarity - a.similarity);

                        // Exploitation: Get top N articles based on similarity
                        const exploitationArticles = articlesWithSimilarity.slice(0, EXPLOITATION_COUNT);
                        const exploitationArticleIds = new Set(exploitationArticles.map(a => a.articleId));

                        // Exploration: Get random M articles from the rest
                        const remainingForExploration = articlesWithFeatures.filter(a => !exploitationArticleIds.has(a.articleId));
                        const explorationArticles: NewsArticleWithEmbedding[] = [];
                        const explorationIndices = new Set<number>();
                        while (explorationArticles.length < EXPLORATION_COUNT && explorationArticles.length < remainingForExploration.length) {
                            const randomIndex = Math.floor(Math.random() * remainingForExploration.length);
                            if (!explorationIndices.has(randomIndex)) {
                                explorationArticles.push(remainingForExploration[randomIndex]);
                                explorationIndices.add(randomIndex);
                            }
                        }
                        
                        articlesForSelection = [...exploitationArticles, ...explorationArticles];
                        logInfo(`Created a candidate pool of ${articlesForSelection.length} articles (${exploitationArticles.length} exploitation, ${explorationArticles.length} exploration).`, { userId });

                    } else {
                        // Fallback for users without an embedding profile: use the latest articles
                        logWarning(`User ${userId} has no embedding profile. Falling back to latest articles for selection.`, { userId });
                        articlesForSelection = articlesWithFeatures.slice(0, EXPLOITATION_COUNT + EXPLORATION_COUNT);
                    }

                    logInfo(`Selecting personalized articles for user ${userId} from ${articlesForSelection.length} candidates.`, { userId, candidateCount: articlesForSelection.length });
                    const selectedArticles = await selectPersonalizedArticles(articlesForSelection, userProfile, clickLogger, userId, numberOfArticlesToSend, userCTR, 0.5, env) as NewsArticleWithEmbedding[];
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

                    const emailResponse = await sendNewsEmail(env as any, recipientEmail, userId, selectedArticles, sender);

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
                                    new Request(`${env.WORKER_BASE_URL}/update-bandit-from-click`, { // 絶対パスに修正
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
