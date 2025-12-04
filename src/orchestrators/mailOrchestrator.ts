import { Env } from '../index';
import { collectNews, NewsArticle } from '../newsCollector';
import { generateAndSaveEmbeddings } from '../services/embeddingService';
import { saveArticlesToD1, getArticlesFromD1, getArticleByIdFromD1, deleteOldArticlesFromD1, cleanupOldUserLogs, getClickLogsForUser, deleteProcessedClickLogs, getUserCTR } from '../services/d1Service';
import { collectAndSaveNews } from '../services/articleService';
import { getAllUserIds, getUserProfile, getMMRLambda } from '../userProfile';
import { generateNewsEmail, sendNewsEmail } from '../emailGenerator';
import { ClickLogger } from '../clickLogger';
import { getSentArticlesForUser } from '../services/d1Service';
import { Logger } from '../logger';
import { chunkArray } from '../utils/textProcessor';
import { DurableObjectStub } from '@cloudflare/workers-types';
import { OPENAI_EMBEDDING_DIMENSION } from '../config';

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
    const logger = new Logger(env);
    logger.debug('Mail delivery orchestration started', { scheduledTime: scheduledTime.toISOString(), isTestRun });

    try {
        // --- 1. News Collection and Save ---
        logger.debug('Starting news collection and save...');
        const articlesWithIds = await collectAndSaveNews(env);
        logger.debug(`Collected and saved ${articlesWithIds.length} articles with persistent IDs.`, { articleCount: articlesWithIds.length });

        if (articlesWithIds.length === 0) {
            logger.debug('No articles collected. Skipping further steps.');
            return;
        }

        const scheduledHourUTC = scheduledTime.getUTCHours();

        // UTC 13時 (日本時間 22時) または UTC 21時 (日本時間 6時) のCronトリガーでのみ埋め込みバッチジョブを作成
        if (scheduledHourUTC === 13 || scheduledHourUTC === 21) {
            logger.debug('Starting embedding generation for articles missing embeddings in D1.');
            const articlesMissingEmbedding = await getArticlesFromD1(env, 1000, 0, "embedding IS NULL") as NewsArticleWithEmbedding[];
            logger.debug(`Found ${articlesMissingEmbedding.length} articles missing embeddings in D1.`, { count: articlesMissingEmbedding.length });

            if (articlesMissingEmbedding.length > 0) {
                await generateAndSaveEmbeddings(articlesMissingEmbedding, env, "__SYSTEM_EMBEDDING__", false);
            } else {
                logger.debug('No articles found that need embedding. Skipping batch job creation.');
            }
        }

        // UTC 23時 (日本時間 8時) のCronトリガー、またはテスト実行の場合にメール送信と関連動作を実行
        if (isTestRun || scheduledHourUTC === 23) {

            // --- 1. Clean up old articles in D1 ---
            logger.debug('Starting D1 article cleanup...');
            try {
                const now = Date.now();

                // 残す記事のIDを収集
                const articleIdsToKeep = new Set<string>();

                // 1. 過去7日間に公開された記事 (RSSフィードからの再取得を防ぐため)
                const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
                const recentArticles = await env.DB.prepare(`SELECT DISTINCT article_id FROM articles WHERE published_at >= ?`).bind(sevenDaysAgo).all<{ article_id: string }>();
                recentArticles.results?.forEach(row => articleIdsToKeep.add(row.article_id));
                logger.debug(`Keeping ${recentArticles.results?.length || 0} articles published in the last 7 days.`);

                // 2. embeddingがまだ生成されていない記事 (published_atに関わらず)
                const articlesMissingEmbedding = await env.DB.prepare(`SELECT DISTINCT article_id FROM articles WHERE embedding IS NULL`).all<{ article_id: string }>();
                articlesMissingEmbedding.results?.forEach(row => articleIdsToKeep.add(row.article_id));
                logger.debug(`Keeping ${articlesMissingEmbedding.results?.length || 0} articles missing embeddings.`);

                // 最終的な残す記事のIDリストを渡してクリーンアップを実行
                await deleteOldArticlesFromD1(env, Array.from(articleIdsToKeep));

            } catch (cleanupError) {
                logger.error('Error during D1 article cleanup:', cleanupError);
            }

            // --- Fetch articles from D1 ---
            logger.debug('Fetching articles from D1 for email sending (only articles with embeddings and published in last 24 hours).');
            const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
            const whereClause = `embedding IS NOT NULL AND published_at >= ?`;
            const articlesWithEmbeddings = await getArticlesFromD1(env, 1000, 0, whereClause, [twentyFourHoursAgo]) as NewsArticleWithEmbedding[]; // d1ServiceのgetArticlesFromD1を使用
            logger.debug(`Fetched ${articlesWithEmbeddings.length} articles with embeddings from D1.`, { count: articlesWithEmbeddings.length });

            if (articlesWithEmbeddings.length === 0) {
                logger.warn('No articles with embeddings found in D1. Cannot proceed with personalization.', null);
                return; // メール送信をスキップ
            }

            // --- 2. Get all users ---
            logger.debug('Fetching all user IDs...');
            const userIds = await getAllUserIds(env);
            logger.debug(`Found ${userIds.length} users to process.`, { userCount: userIds.length });

            if (userIds.length === 0) {
                logger.debug('No users found. Skipping email sending.');
                return; // メール送信をスキップ
            }

            // --- Process each user ---
            logger.debug('Processing news for each user...');
            for (const userId of userIds) {
                try {
                    logger.debug(`Processing user: ${userId}`);

                    const userProfile = await getUserProfile(userId, env);

                    if (!userProfile) {
                        logger.error(`User profile not found for ${userId}. Skipping email sending for this user.`, null, { userId });
                        continue;
                    }
                    logger.debug(`Loaded user profile for ${userId}.`);

                    const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
                    const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

                    // --- 3. Article Selection (MMR + Bandit) ---
                    logger.debug(`Starting article selection (MMR + Bandit) for user ${userId}...`, { userId });
                    const numberOfArticlesToSend = 5;

                    // Get user's CTR for dynamic parameter adjustment
                    const userCTR = await getUserCTR(env, userId);

                    const EXTENDED_EMBEDDING_DIMENSION = OPENAI_EMBEDDING_DIMENSION + 1;

                    // ユーザープロファイルの埋め込みベクトルを準備
                    let userProfileEmbeddingForSelection: number[];
                    if (userProfile.embedding && userProfile.embedding.length === EXTENDED_EMBEDDING_DIMENSION) {
                        userProfileEmbeddingForSelection = [...userProfile.embedding];
                    } else {
                        logger.warn(`User ${userId} has an embedding of unexpected dimension ${userProfile.embedding?.length}. Initializing with zero vector for selection.`, { userId, embeddingLength: userProfile.embedding?.length });
                        userProfileEmbeddingForSelection = new Array(EXTENDED_EMBEDDING_DIMENSION).fill(0);
                    }
                    // ユーザープロファイルの鮮度情報は常に0.0で上書き
                    userProfileEmbeddingForSelection[OPENAI_EMBEDDING_DIMENSION] = 0.0;

                    // 記事の埋め込みベクトルに鮮度情報を更新
                    const now = Date.now();
                    const articlesWithUpdatedFreshness = articlesWithEmbeddings
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

                            // 既存の513次元embeddingの最後の要素（鮮度情報）を更新
                            const updatedEmbedding = [...article.embedding!]; // 参照渡しを防ぐためにコピー
                            updatedEmbedding[OPENAI_EMBEDDING_DIMENSION] = normalizedAge;

                            return {
                                ...article,
                                embedding: updatedEmbedding,
                            };
                        });

                    // --- Exclude already sent articles ---
                    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
                    const sentArticles = await getSentArticlesForUser(env, userId, sevenDaysAgo);
                    const sentArticleIds = new Set(sentArticles.map(sa => sa.article_id));

                    const filteredArticlesForSelection = articlesWithUpdatedFreshness.filter(article => !sentArticleIds.has(article.articleId));
                    logger.debug(`Filtered out ${articlesWithUpdatedFreshness.length - filteredArticlesForSelection.length} already sent articles. Remaining candidates: ${filteredArticlesForSelection.length}.`, { userId, filteredCount: filteredArticlesForSelection.length });

                    if (filteredArticlesForSelection.length === 0) {
                        logger.debug('No articles remaining after filtering sent articles. Skipping email sending for this user.', { userId });
                        continue;
                    }

                    // ユーザーの保存されたMMR lambdaを取得
                    const userMMRLambda = await getMMRLambda(userId, env);
                    logger.debug(`Using saved MMR lambda for user ${userId}: ${userMMRLambda}`, { userId, lambda: userMMRLambda });

                    // --- Fetch Negative Feedback Embeddings ---
                    // 興味なしと判定された記事の埋め込みを取得 (sent_articlesと結合)
                    const negativeFeedbackResult = await env.DB.prepare(
                        `SELECT sa.embedding
                         FROM education_logs el
                         JOIN sent_articles sa ON el.article_id = sa.article_id AND el.user_id = sa.user_id
                         WHERE el.user_id = ? AND el.action = 'not_interested' AND sa.embedding IS NOT NULL
                         ORDER BY el.timestamp DESC
                         LIMIT 50`
                    ).bind(userId).all<{ embedding: string }>();

                    const negativeFeedbackEmbeddings: number[][] = [];
                    if (negativeFeedbackResult.results) {
                        for (const row of negativeFeedbackResult.results) {
                            try {
                                const embedding = JSON.parse(row.embedding);
                                if (Array.isArray(embedding)) {
                                    negativeFeedbackEmbeddings.push(embedding);
                                }
                            } catch (e) {
                                logger.warn(`Failed to parse embedding for negative feedback article`, e);
                            }
                        }
                    }
                    logger.debug(`Fetched ${negativeFeedbackEmbeddings.length} negative feedback embeddings for user ${userId}.`, { userId, count: negativeFeedbackEmbeddings.length });


                    logger.debug(`Selecting personalized articles for user ${userId} from ${filteredArticlesForSelection.length} candidates.`, { userId, candidateCount: filteredArticlesForSelection.length });

                    // WASM DOを使用してパーソナライズド記事を選択
                    const wasmDOId = env.WASM_DO.idFromName("wasm-calculator");
                    const wasmDOStub = env.WASM_DO.get(wasmDOId);

                    const response = await wasmDOStub.fetch(new Request(`${env.WORKER_BASE_URL}/wasm-do/select-personalized-articles`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            articles: filteredArticlesForSelection,
                            userProfileEmbeddingForSelection: userProfileEmbeddingForSelection,
                            userId: userId,
                            count: numberOfArticlesToSend,
                            userCTR: userCTR,
                            lambda: userMMRLambda,
                            workerBaseUrl: env.WORKER_BASE_URL,
                            negativeFeedbackEmbeddings: negativeFeedbackEmbeddings,
                        }),
                    }));

                    let selectedArticles: NewsArticleWithEmbedding[] = [];
                    if (response.ok) {
                        selectedArticles = await response.json();
                        logger.debug(`Selected ${selectedArticles.length} articles for user ${userId} via WASM DO.`, { userId, selectedCount: selectedArticles.length });
                    } else {
                        const errorText = await response.text();
                        logger.error(`Failed to select personalized articles for user ${userId} via WASM DO: ${response.statusText}. Error: ${errorText}`, null, { userId, status: response.status, statusText: response.statusText });
                        // エラー時は空の配列を使用
                        selectedArticles = [];
                    }

                    if (selectedArticles.length === 0) {
                        logger.debug('No articles selected. Skipping email sending for this user.', { userId });
                        continue;
                    }

                    // --- 4. Email Generation & Sending ---
                    logger.debug(`Generating and sending email for user ${userId}...`, { userId });
                    const recipientEmail = userProfile.email;
                    if (!recipientEmail) {
                        logger.error(`User profile for ${userId} does not contain an email address. Skipping email sending.`, null, { userId });
                        continue;
                    }
                    const sender: EmailRecipient = { email: recipientEmail, name: 'Mailify News' };

                    const emailResponse = await sendNewsEmail(env as any, recipientEmail, userId, selectedArticles, sender);

                    if (emailResponse.ok) {
                        logger.debug(`Personalized news email sent to ${recipientEmail} via Gmail API.`, { userId, email: recipientEmail });
                    } else {
                        logger.error(`Failed to send email to ${recipientEmail} via Gmail API: ${emailResponse.statusText}`, null, { userId, email: recipientEmail, status: emailResponse.status, statusText: emailResponse.statusText });
                    }

                    // --- 5. Log Sent Articles to Durable Object ---
                    logger.debug(`Logging sent articles to ClickLogger for user ${userId}...`, { userId });
                    // embeddingが存在し、かつ次元が513である記事のみをフィルタリングして保存
                    const filteredSentArticlesData = selectedArticles
                        .filter(article => article.embedding && article.embedding.length === EXTENDED_EMBEDDING_DIMENSION)
                        .map(article => ({
                            articleId: article.articleId,
                            timestamp: Date.now(),
                            embedding: article.embedding!,
                            publishedAt: article.publishedAt!,
                        }));

                    if (filteredSentArticlesData.length === 0) {
                        logger.warn(`No valid articles with 513-dimension embedding to log for user ${userId}. Skipping logging sent articles.`, { userId, selectedArticlesCount: selectedArticles.length });
                    } else {
                        const logSentResponse = await clickLogger.fetch(
                            new Request(`${env.WORKER_BASE_URL}/log-sent-articles`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ userId: userId, sentArticles: filteredSentArticlesData }),
                            })
                        );

                        if (logSentResponse.ok) {
                            logger.debug(`Successfully logged sent articles for user ${userId}.`, { userId });
                        } else {
                            logger.error(`Failed to log sent articles for user ${userId}: ${logSentResponse.statusText}`, null, { userId, status: logSentResponse.status, statusText: logSentResponse.statusText });
                        }
                    }

                    // --- 6. Process Click Logs and Update Bandit Model ---
                    logger.debug(`Processing click logs and updating bandit model for user ${userId}...`, { userId });

                    const clickLogs = await getClickLogsForUser(env, userId); // d1ServiceのgetClickLogsForUserを使用
                    logger.debug(`Found ${clickLogs.length} click logs to process for user ${userId}.`, { userId, count: clickLogs.length });

                    if (clickLogs.length > 0) {
                        const updatePromises = clickLogs.map(async clickLog => {
                            const articleId = clickLog.article_id;
                            const article = await getArticleByIdFromD1(articleId, env) as NewsArticleWithEmbedding | null; // d1ServiceのgetArticleByIdFromD1を使用

                            if (article && article.embedding && article.publishedAt) {
                                const reward = 1.0;
                                const now = Date.now();
                                const ageInHours = (now - new Date(article.publishedAt).getTime()) / (1000 * 60 * 60);
                                const normalizedAge = Math.min(ageInHours / (24 * 7), 1.0);
                                const extendedEmbedding = [...article.embedding, normalizedAge];

                                const updateResponse = await clickLogger.fetch(
                                    new Request(`${env.WORKER_BASE_URL}/update-bandit-from-click`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ userId: userId, articleId: articleId, embedding: extendedEmbedding, reward: reward }),
                                    })
                                );

                                if (updateResponse.ok) {
                                    logger.debug(`Successfully updated bandit model from click for article ${articleId} for user ${userId}.`, { userId, articleId });
                                } else {
                                    logger.error(`Failed to update bandit model from click for article ${articleId} for user ${userId}: ${updateResponse.statusText}`, null, { userId, articleId, status: updateResponse.status, statusText: updateResponse.statusText });
                                }
                            } else {
                                logger.warn(`Article embedding not found in D1 for clicked article ${articleId} for user ${userId}. Cannot update bandit model.`, { userId, articleId });
                            }
                        });
                        await Promise.all(updatePromises);
                        logger.debug(`Finished processing click logs and updating bandit model for user ${userId}.`, { userId });

                        // 処理済みのクリックログをD1から削除
                        const clickLogArticleIdsToDelete = clickLogs.map(log => log.article_id);
                        await deleteProcessedClickLogs(env, userId, clickLogArticleIdsToDelete); // d1ServiceのdeleteProcessedClickLogsを使用

                    } else {
                        logger.debug(`No click logs to process for user ${userId}.`, { userId });
                    }

                    // --- 7. Clean up old logs in D1 ---
                    logger.debug(`Starting cleanup of old logs for user ${userId}...`, { userId });
                    const daysToKeepLogs = 30;
                    const cutoffTimestamp = Date.now() - daysToKeepLogs * 24 * 60 * 60 * 1000;
                    await cleanupOldUserLogs(env, userId, cutoffTimestamp); // d1ServiceのcleanupOldUserLogsを使用

                    logger.debug(`Finished processing user ${userId}.`, { userId });

                } catch (userProcessError) {
                    logger.error(`Error processing user ${userId}:`, userProcessError, { userId });
                }
            } // End of user loop
        }

        logger.debug('Mail delivery orchestration finished.');

    } catch (mainError) {
        logger.error('Error during mail delivery orchestration:', mainError);
    }
}
