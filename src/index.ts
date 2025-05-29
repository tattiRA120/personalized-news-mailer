// @ts-nocheck
import { collectNews } from './newsCollector';
import { uploadOpenAIFile, createOpenAIBatchEmbeddingJob, prepareBatchInputFileContent } from './openaiClient'; // Import OpenAI Batch API client functions
import { getUserProfile, updateUserProfile, UserProfile, getAllUserIds, createUserProfile, updateCategoryInterestScores } from './userProfile'; // Assuming these functions are in userProfile.ts
import { selectTopArticles, selectPersonalizedArticles } from './articleSelector'; // Assuming these functions are in articleSelector.ts
import { generateNewsEmail, sendNewsEmail } from './emailGenerator'; // Assuming these functions are in emailGenerator.ts
import { ClickLogger } from './clickLogger'; // Assuming this is your Durable Object class
import { logError, logInfo, logWarning } from './logger'; // Import logging helpers
import { classifyArticles } from './categoryClassifier'; // Import classifyArticles
import { extractKeywordsFromText, updateCategoryKeywords, getCategoryList, EnvWithKeywordsKV } from './keywordManager'; // キーワード抽出と更新関数、カテゴリーリスト関連関数をインポート

// EnvWithKeywordsKV を拡張して AI バインディングも含むようにする
interface EnvWithAIAndKeywordsKV extends EnvWithKeywordsKV {
    AI: Ai;
}

// Define the Env interface with bindings from wrangler.jsonc
// EnvWithAIAndKeywordsKV を継承し、その他のバインディングを追加
export interface Env extends EnvWithAIAndKeywordsKV {
	'mail-news-user-profiles': KVNamespace;
	CLICK_LOGGER: DurableObjectNamespace;
	OPENAI_API_KEY?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GOOGLE_REDIRECT_URI?: string;
	'mail-news-gmail-tokens': KVNamespace;
    ARTICLE_EMBEDDINGS: KVNamespace; // KV for temporary article storage or old embeddings
    DB: D1Database; // D1 Database binding
}

interface EmailRecipient {
    email: string;
    name?: string;
}

interface NewsArticle {
    title: string;
    link: string;
    // Add other fields as needed, including category, score and embedding
    category?: string; // Add category field
    score?: number; // Assuming a relevance score is added in the scoring step
    embedding?: number[]; // Assuming embedding vector is added in the embedding step
    ucb?: number; // UCB値を保持するためのフィールドを追加
    finalScore?: number; // 最終スコアを保持するためのフィールドを追加
    llmResponse?: string; // Add field to store LLM response for debugging
}


// KVにembeddingをキャッシュするためのキーを生成する関数
function getEmbeddingCacheKey(articleLink: string): string {
    // 記事リンクのハッシュなど、一意で安全なキーを生成する
    // ここでは簡易的にリンクをそのまま使用（長いURLの場合はハッシュ化を検討）
    return `embedding:${articleLink}`;
}


export default {
	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
		logInfo('Scheduled task started', { scheduledTime: controller.scheduledTime });

		try {
			// --- 1. News Collection ---
			logInfo('Starting news collection...');
			const articles = await collectNews();
			logInfo(`Collected ${articles.length} articles.`, { articleCount: articles.length });

			if (articles.length === 0) {
				logInfo('No articles collected. Skipping further steps.');
				return;
			}

            // --- 2. Article Classification ---
            logInfo('Starting article classification...');
            // classifyArticles 関数に EnvWithAIAndKeywordsKV 型として env を渡す
            const classifiedArticles = await classifyArticles(articles, env);
            logInfo(`Finished article classification.`, { classifiedCount: classifiedArticles.length });


			// --- 3. Get all users ---
			logInfo('Fetching all user IDs...');
			// Pass the correct KV binding to userProfile functions
			const userIds = await getAllUserIds({ 'mail-news-user-profiles': env['mail-news-user-profiles'] });
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

					// Pass the correct KV binding to userProfile functions
					const userProfile = await getUserProfile(userId, { 'mail-news-user-profiles': env['mail-news-user-profiles'] });

					if (!userProfile) {
						logError(`User profile not found for ${userId}. Skipping email sending for this user.`, null, { userId });
						continue; // Skip to the next user
					}
					logInfo(`Loaded user profile for ${userId}.`);

                    // --- 4. Update Category Interest Scores ---
                    logInfo(`Updating category interest scores for user ${userId}...`, { userId });
                    // ClickLogger から教育プログラムログ、クリックログ、送信ログを取得
                    // 過去7日間のログを取得する例
                    const now = Date.now();
                    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000; // 7日前 (ミリ秒)

					// Durable Object (ClickLogger) のインスタンスを取得
					const clickLoggerId = env.CLICK_LOGGER.idFromName(userId); // ユーザーIDに対応するDO IDを取得
					const clickLogger = env.CLICK_LOGGER.get(clickLoggerId); // DO インスタンスを取得

                    const educationLogs = await clickLogger.getEducationLogs(sevenDaysAgo, now);
                    const clickLogs = await clickLogger.getClickLogs(sevenDaysAgo, now);
                    const sentLogs = await clickLogger.getSentLogs(sevenDaysAgo, now);

                    // 過去に送信された記事のログを取得し、NewsArticle[] 形式に変換
                    const allSentArticles: NewsArticle[] = sentLogs.map(log => ({
                        title: '', // タイトルはログに含まれないので空文字列
                        link: log.articleId, // articleId を link として使用
                        summary: '', // サマリーも空文字列
                        category: undefined, // カテゴリーも不明
                        score: undefined,
                        embedding: undefined, // embedding はログに含まれないので undefined
                        ucb: undefined,
                        finalScore: undefined,
                        llmResponse: undefined,
                    }));


                    const updatedUserProfile = await updateCategoryInterestScores(
                        userProfile,
                        educationLogs, // 取得したログデータを渡す
                        clickLogs, // 取得したログデータを渡す
                        sentLogs, // 取得したログデータを渡す
                        classifiedArticles, // カテゴリー情報付きの全記事リストを渡す
                        env // env オブジェクトを渡す
                    );
                    // 更新されたユーザープロファイルを保存
                    await updateUserProfile(updatedUserProfile, { 'mail-news-user-profiles': env['mail-news-user-profiles'] });
                    logInfo(`Finished updating category interest scores for user ${userId}.`, { userId });


					// --- 5. First Selection (Category-based) ---
					logInfo(`Starting first selection (category-based) for user ${userId}...`, { userId });
                    const firstSelectedArticles: NewsArticle[] = []; // NewsArticle型を使用
                    const articlesByCategory: { [category: string]: NewsArticle[] } = {}; // NewsArticle型を使用

                    // 記事をカテゴリーごとにグループ化
                    for (const article of classifiedArticles) {
                        const category = article.category || 'その他';
                        if (!articlesByCategory[category]) {
                            articlesByCategory[category] = [];
                        }
                        articlesByCategory[category].push(article);
                    }

                    // カテゴリー興味関心スコアでカテゴリーをソート (降順)
                    const sortedCategories = Object.keys(userProfile.categoryInterestScores).sort((a, b) =>
                        (userProfile.categoryInterestScores[b] || 0) - (userProfile.categoryInterestScores[a] || 0)
                    );

                    const maxArticlesForEmbedding = 50; // Embeddingを行う記事数の上限 (調整可能)
                    const minArticlesPerCategory = 1; // 各カテゴリーから最低限選択する記事数 (調整可能)
                    let articlesCountForEmbedding = 0;

                    // 動的に取得したカテゴリーリストを使用
                    const currentCategoryList = await getCategoryList(env);
                    const numberOfCategories = currentCategoryList.length > 0 ? currentCategoryList.length : 1; // カテゴリーがない場合は1として計算

                    // カテゴリーごとの合計興味関心スコアを計算
                    let totalInterestScore = 0;
                    for (const category in userProfile.categoryInterestScores) {
                        totalInterestScore += userProfile.categoryInterestScores[category];
                    }

                    // 興味関心の高いカテゴリーから順に、配分された記事数を選択
                    for (const category of sortedCategories) {
                        const articlesInCategory = articlesByCategory[category] || [];
                        if (articlesInCategory.length === 0) continue;

                        // このカテゴリーから選択する記事数を計算
                        let articlesToSelectFromCategory = minArticlesPerCategory; // まず最低数を確保

                        // 残りの選択可能な記事数を、興味関心スコアに応じて比例配分
                        const remainingArticlesPool = maxArticlesForEmbedding - (numberOfCategories * minArticlesPerCategory);
                        if (totalInterestScore > 0 && remainingArticlesPool > 0) {
                            const categoryInterestRatio = (userProfile.categoryInterestScores[category] || 0) / totalInterestScore; // 0の場合を考慮
                            const proportionalAllocation = Math.floor(categoryInterestRatio * remainingArticlesPool);
                            articlesToSelectFromCategory += proportionalAllocation;
                        } else if (remainingArticlesPool > 0) {
                            // 合計スコアが0の場合、残りを均等に配分
                            const equalAllocation = Math.floor(remainingArticlesPool / numberOfCategories);
                            articlesToSelectFromCategory += equalAllocation;
                        }


                        // カテゴリー内の記事総数を超えないように調整
                        articlesToSelectFromCategory = Math.min(articlesToSelectFromCategory, articlesInCategory.length);

                        // Embeddingを行う記事数の上限を超えないように調整
                        articlesToSelectFromCategory = Math.min(articlesToSelectFromCategory, maxArticlesForEmbedding - articlesCountForEmbedding);


                        // カテゴリー内の記事を収集順（簡易的な新しさ）でソート
                        const sortedArticlesInCategory = [...articlesInCategory]; // 収集順は元のarticlesリストの順序と仮定

                        let selectedCountInCategory = 0;
                        for (const article of sortedArticlesInCategory) {
                            if (articlesCountForEmbedding < maxArticlesForEmbedding && selectedCountInCategory < articlesToSelectFromCategory) {
                                firstSelectedArticles.push(article);
                                articlesCountForEmbedding++;
                                selectedCountInCategory++;
                            } else {
                                break;
                            }
                        }
                    }

                    // まだ上限に達していない場合、残りの記事を収集順に追加（多様性確保の最終手段）
                    // このステップは、上記の配分ロジックで上限に達しなかった場合にのみ実行される
                     if (articlesCountForEmbedding < maxArticlesForEmbedding) {
                         const currentlySelectedLinks = new Set(firstSelectedArticles.map(a => a.link));
                         for (const article of classifiedArticles) {
                             if (articlesCountForEmbedding < maxArticlesForEmbedding && !currentlySelectedLinks.has(article.link)) {
                                 firstSelectedArticles.push(article);
                                 articlesCountForEmbedding++;
                                 currentlySelectedLinks.add(article.link); // 重複防止
                             } else if (articlesCountForEmbedding >= maxArticlesForEmbedding) {
                                 break;
                             }
                         }
                     }


					logInfo(`Finished first selection. Selected ${firstSelectedArticles.length} articles for embedding.`, { userId, selectedCount: firstSelectedArticles.length });

                    // Check if the current cron is for embedding generation (22:00 JST)
                    // The scheduledTime is UTC, so 22:00 JST is 13:00 UTC
                    const scheduledHourUTC = new Date(controller.scheduledTime).getUTCHours();

                    if (scheduledHourUTC === 13) { // This is the 22:00 JST cron for embedding generation
                        logInfo('Current cron is for embedding generation. Initiating OpenAI Batch API job.');

                        const articlesToEmbedForBatch = classifiedArticles.map(article => ({
                            id: article.link, // Use article link as custom_id
                            text: `${article.title} ${article.summary || ''}` // Combine title and summary for embedding
                        }));

                        if (articlesToEmbedForBatch.length === 0) {
                            logInfo('No articles to embed. Skipping batch job creation.');
                            return;
                        }

                        // Prepare input file content for Batch API
                        const batchInputContent = prepareBatchInputFileContent(articlesToEmbedForBatch);
                        const batchInputBlob = new Blob([batchInputContent], { type: 'application/jsonl' });
                        const filename = `batch_input_${Date.now()}.jsonl`;

                        // Upload input file to OpenAI
                        const uploadedFile = await uploadOpenAIFile(filename, batchInputBlob, 'batch', env);

                        if (!uploadedFile) {
                            logError('Failed to upload batch input file to OpenAI. Cannot create batch job.', null);
                            return;
                        }

                        // Create Batch API job
                        // Construct the callback URL for the current worker
                        // Assuming the worker is deployed at a known URL, e.g., https://your-worker-name.your-account.workers.dev
                        // For local testing, this might need to be a ngrok URL or similar.
                        // In production, you'd use the actual worker URL.
                        // For now, we'll use a placeholder and assume it's handled by deployment environment.
                        const workerUrl = `https://${env.WORKER_NAME}.${env.CLOUDFLARE_ACCOUNT_ID}.workers.dev`; // Example, adjust as needed
                        const callbackUrl = `${workerUrl}/openai-batch-callback`;

                        const batchJob = await createOpenAIBatchEmbeddingJob(uploadedFile.id, callbackUrl, env);

                        if (batchJob) {
                            logInfo(`OpenAI Batch Embedding Job created successfully. Job ID: ${batchJob.id}. Input File ID: ${uploadedFile.id}`, { jobId: batchJob.id, inputFileId: uploadedFile.id });
                            // Store job ID and input file ID in KV or D1 for later reference if needed
                            // For simplicity, we'll just log it for now.
                        } else {
                            logError('Failed to create OpenAI Batch Embedding Job.', null);
                        }

                        logInfo('Embedding generation cron finished. Waiting for Batch API callback.');
                        return; // Exit here, email sending will be handled by the morning cron
                    }

                    // If it's the morning cron (08:00 JST, which is 23:00 UTC the previous day)
                    // This part will be executed by the 08:00 JST cron for email sending
                    logInfo('Current cron is for email sending. Fetching articles from D1.');

                    // --- Fetch articles from D1 ---
                    // For now, fetch all articles. In a real scenario, you might fetch recent ones or those not yet processed.
                    const { results } = await env.DB.prepare("SELECT * FROM articles ORDER BY published_at DESC LIMIT 1000").all(); // Fetch recent 1000 articles
                    const articlesFromD1: NewsArticle[] = (results as any[]).map(row => ({
                        title: row.title,
                        link: row.url,
                        summary: row.content, // Assuming 'content' column stores summary/full text
                        category: row.category, // Assuming category is stored
                        embedding: JSON.parse(row.embedding), // Parse JSON string back to array
                        published_at: row.published_at,
                    }));
                    logInfo(`Fetched ${articlesFromD1.length} articles from D1.`, { count: articlesFromD1.length });

                    if (articlesFromD1.length === 0) {
                        logInfo('No articles found in D1 for email sending. Skipping further steps.');
                        return;
                    }

                    // Filter out articles without embeddings (should not happen if batch job completed successfully)
                    const articlesWithEmbeddings = articlesFromD1.filter(article => article.embedding && article.embedding.length > 0);
                    logInfo(`Found ${articlesWithEmbeddings.length} articles with embeddings from D1.`, { count: articlesWithEmbeddings.length });

                    if (articlesWithEmbeddings.length === 0) {
                        logWarning('No articles with embeddings found in D1. Cannot proceed with personalization.', null);
                        return;
                    }

					// --- 8. Second Selection (MMR + Bandit) ---
					logInfo(`Starting second selection (MMR + Bandit) for user ${userId}...`, { userId });

					// selectPersonalizedArticles 関数に embedding が付与された記事リストを渡す
					// @ts-ignore: Durable Object Stub の型に関するエラーを抑制
					const numberOfArticlesToSend = 5; // Define how many articles to send
					const selectedArticles = await selectPersonalizedArticles(articlesWithEmbeddings, userProfile, clickLogger, numberOfArticlesToSend, 0.5, allSentArticles);
					logInfo(`Selected ${selectedArticles.length} articles for user ${userId} after second selection.`, { userId, selectedCount: selectedArticles.length });

					if (selectedArticles.length === 0) {
						logInfo('No articles selected after second selection. Skipping email sending for this user.', { userId });
						continue; // Skip to the next user
					}

					// --- 8. Email Generation & Sending ---
					logInfo(`Generating and sending email for user ${userId}...`, { userId });
					const emailSubject = 'Your Daily Personalized News Update';
					// TODO: Use actual user email from userProfile or a separate mapping
					// For now, using a placeholder. Need to store email in userProfile or KV mapping.
					const recipientEmail = userProfile.email; // Use actual user email from profile
					if (!recipientEmail) {
						logError(`User profile for ${userId} does not contain an email address. Skipping email sending.`, null, { userId });
						continue;
					}
					const recipient: EmailRecipient = { email: recipientEmail, name: userProfile.userId }; // Use actual user email from profile
					const sender: EmailRecipient = { email: recipientEmail, name: 'Mailify News' }; // Use recipient email as sender for Gmail API

					// generateNewsEmail 関数に userId を渡す
					const htmlEmailContent = generateNewsEmail(selectedArticles, userId);

					// Pass the sender object and env to sendNewsEmail (now using Gmail API)
					const emailResponse = await sendNewsEmail(env, recipientEmail, userId, selectedArticles, sender);

					if (emailResponse.ok) {
						logInfo(`Personalized news email sent to ${recipient.email} via Gmail API.`, { userId, email: recipient.email });
					} else {
						logError(`Failed to send email to ${recipient.email} via Gmail API: ${emailResponse.statusText}`, null, { userId, email: recipient.email, status: emailResponse.status, statusText: emailResponse.statusText });
					}

					// --- 9. Log Sent Articles to Durable Object ---
					logInfo(`Logging sent articles to ClickLogger for user ${userId}...`, { userId });
					const sentArticlesData = selectedArticles.map(article => ({
						articleId: article.link, // articleId は link と仮定
						timestamp: Date.now(), // 送信時のタイムスタンプ
						// embedding は Durable Object に保存しない
					}));

					// In scheduled task, request.url is not defined. Use relative path.
					const logSentResponse = await clickLogger.fetch(new Request('http://dummy-host/log-sent-articles', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ sentArticles: sentArticlesData }),
					}));

					if (logSentResponse.ok) {
						logInfo(`Successfully logged sent articles for user ${userId}.`, { userId });
					} else {
						logError(`Failed to log sent articles for user ${userId}: ${logSentResponse.statusText}`, null, { userId, status: logSentResponse.status, statusText: logSentResponse.statusText });
					}


					// --- 10. Process Click Logs and Update Bandit Model & Keyword Optimization ---
					logInfo(`Processing click logs and updating bandit model & optimizing keywords for user ${userId}...`, { userId });
					// Durable Object から未処理のクリックログを取得し、削除
					const clickLogsToProcess = await clickLogger.getAndClearClickLogs();
					logInfo(`Found ${clickLogsToProcess.length} click logs to process for user ${userId}.`, { userId, count: clickLogsToProcess.length });

					if (clickLogsToProcess.length > 0) {
						const updatePromises = clickLogsToProcess.map(async clickLog => {
							const articleId = clickLog.articleId;
							const clickedCategory = clickLog.category; // クリックされた記事のカテゴリ
							const cacheKey = `article:${articleId}`; // 記事IDはリンクと仮定

							try {
								// KVから記事データ（embeddingを含む）を取得
								const cachedArticle = await env.ARTICLE_EMBEDDINGS.get(cacheKey, { type: 'json' }) as NewsArticle | null;

								if (cachedArticle && cachedArticle.embedding) {
									// バンディットモデルを更新
									const reward = 1.0; // クリックイベントなので報酬は 1.0
									const updateResponse = await clickLogger.fetch(new Request('http://dummy-host/update-bandit-from-click', {
										method: 'POST',
										headers: { 'Content-Type': 'application/json' },
										body: JSON.stringify({ articleId: articleId, embedding: cachedArticle.embedding, reward: reward, category: clickedCategory }),
									}));

									if (updateResponse.ok) {
										logInfo(`Successfully updated bandit model from click for article ${articleId} (category: ${clickedCategory}) for user ${userId}.`, { userId, articleId, category: clickedCategory });
									} else {
										logError(`Failed to update bandit model from click for article ${articleId} (category: ${clickedCategory}) for user ${userId}: ${updateResponse.statusText}`, null, { userId, articleId, category: clickedCategory, status: updateResponse.status, statusText: updateResponse.statusText });
									}

									// TODO: キーワード最適化ロジックをここに追加
									// ユーザーの興味関心カテゴリとクリックされた記事のカテゴリを比較し、
									// 不一致があった場合に、記事のタイトルやサマリーから新しいキーワードを抽出し、
									// 関連するカテゴリのキーワード辞書に追加する。
									// これは、userProfile.ts の updateUserProfile を呼び出す形になるか、
									// または新しい Durable Object を導入してキーワード辞書を管理するか検討。
									// キーワード最適化ロジック
									// クリックされた記事のカテゴリとユーザーの興味関心カテゴリを比較
									const userInterestCategory = userProfile.categoryInterestScores ? Object.keys(userProfile.categoryInterestScores).reduce((a, b) => (userProfile.categoryInterestScores[a] || 0) > (userProfile.categoryInterestScores[b] || 0) ? a : b, 'その他') : 'その他';

									if (clickedCategory && clickedCategory !== userInterestCategory) {
										logInfo(`User clicked article in category '${clickedCategory}' but primary interest is '${userInterestCategory}'. Analyzing for keyword optimization.`, { userId, clickedCategory, userInterestCategory });

										// 記事のタイトルとサマリーからキーワードを抽出
										const articleText = `${cachedArticle.title} ${cachedArticle.summary || ''}`;
										const extractedKeywords = extractKeywordsFromText(articleText);

										if (extractedKeywords.length > 0) {
											logInfo(`Extracted ${extractedKeywords.length} keywords from clicked article for category '${clickedCategory}'.`, { userId, articleId, extractedKeywords });
											// 抽出されたキーワードを該当カテゴリの辞書に追加
											await updateCategoryKeywords(clickedCategory, extractedKeywords, env);
										} else {
											logInfo(`No new keywords extracted from clicked article for category '${clickedCategory}'.`, { userId, articleId });
										}
									} else {
										logInfo(`Clicked article category '${clickedCategory}' matches user's primary interest or no category found. No keyword optimization needed.`, { userId, clickedCategory, userInterestCategory });
									}

								} else {
									logWarning(`Article data or embedding not found in KV for clicked article ${articleId} for user ${userId}. Cannot update bandit model or optimize keywords.`, { userId, articleId });
								}
							} catch (updateError) {
								logError(`Error processing click log for article ${articleId} for user ${userId}:`, updateError, { userId, articleId });
							}
						});
						await Promise.all(updatePromises);
						logInfo(`Finished processing click logs and updating bandit model & optimizing keywords for user ${userId}.`, { userId });
					} else {
						logInfo(`No click logs to process for user ${userId}.`, { userId });
					}

                    // --- 11. Clean up old logs in Durable Object ---
                    logInfo(`Starting cleanup of old logs for user ${userId}...`, { userId });
                    const daysToKeepLogs = 30; // ログを保持する日数 (調整可能)
                    await clickLogger.cleanupOldLogs(daysToKeepLogs);
                    logInfo(`Finished cleanup of old logs for user ${userId}.`, { userId });


					// TODO: Update user profile with sent article IDs for future reference/negative feedback
					// This could be done here or within the click logging process
					// For now, let's add a placeholder for updating the profile with sent articles
					if (userProfile.sentArticleIds) {
						userProfile.sentArticleIds.push(...selectedArticles.map(a => a.link)); // articleId は link と仮定
					} else {
						userProfile.sentArticleIds = selectedArticles.map(a => a.link); // articleId は link と仮定
					}
					// Pass the correct KV binding to userProfile functions
					await updateUserProfile(userProfile, { 'mail-news-user-profiles': env['mail-news-user-profiles'] });
					logInfo(`Updated user profile for ${userId} with sent article IDs.`, { userId });


				} catch (userProcessError) {
					logError(`Error processing user ${userId}:`, userProcessError, { userId });
					// Continue to the next user even if one user's process fails
				}
			} // End of user loop
            // --- 12. Clean up old embeddings in KV ---
            logInfo('Starting KV embedding cleanup...');
            try {
                const listResult = await env.ARTICLE_EMBEDDINGS.list({ prefix: 'embedding:' });
                const embeddingKeys = listResult.keys;

                const maxEmbeddingKeys = 5000; // KVに保持するembeddingキーの最大数 (調整可能)

                if (embeddingKeys.length > maxEmbeddingKeys) {
                    logWarning(`KV embedding keys exceed limit (${maxEmbeddingKeys}). Cleaning up old keys.`, { currentCount: embeddingKeys.length, limit: maxEmbeddingKeys });

                    // 古いキーを削除 (簡易的にリストの先頭から削除)
                    const keysToDelete = embeddingKeys.slice(0, embeddingKeys.length - maxEmbeddingKeys);
                    logInfo(`Deleting ${keysToDelete.length} old embedding keys.`, { count: keysToDelete.length });

                    const deletePromises = keysToDelete.map(key => env.ARTICLE_EMBEDDINGS.delete(key.name));
                    await Promise.all(deletePromises);

                    logInfo(`Finished KV embedding cleanup. Deleted ${keysToDelete.length} keys.`, { deletedCount: keysToDelete.length });
                } else {
                    logInfo(`KV embedding key count (${embeddingKeys.length}) is within limit. No cleanup needed.`, { currentCount: embeddingKeys.length, limit: maxEmbeddingKeys });
                }

            } catch (cleanupError) {
                logError('Error during KV embedding cleanup:', cleanupError);
            }

            // --- 13. Clean up old articles in D1 ---
            // This should run only for the email sending cron (08:00 JST, 23:00 UTC previous day)
            if (scheduledHourUTC === 23) { // Check if it's the email sending cron
                logInfo('Starting D1 article cleanup...');
                try {
                    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000); // 30 days in milliseconds
                    const { success, error, results } = await env.DB.prepare("DELETE FROM articles WHERE published_at < ?").bind(thirtyDaysAgo).run();

                    if (success) {
                        logInfo(`Successfully deleted old articles from D1. Rows affected: ${results?.changes || 0}`, { deletedCount: results?.changes || 0 });
                    } else {
                        logError(`Failed to delete old articles from D1: ${error}`, null, { error });
                    }
                } catch (cleanupError) {
                    logError('Error during D1 article cleanup:', cleanupError);
                }
            }

			logInfo('Scheduled task finished.');

		} catch (mainError) {
			logError('Error during scheduled task execution:', mainError);
			// Optionally send an alert or log to an external service
		}
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// --- Static File Server ---
		// Use env.ASSETS to serve static files from the 'public' directory
		// The ASSETS binding is automatically configured by Wrangler for static deployments
		if (path.startsWith('/public/')) {
			// Remove the leading '/public' to get the asset path
			const assetPath = path.replace('/public', '');
			// Fetch the asset using the ASSETS binding
			const response = await env.ASSETS.fetch(new Request(new URL(assetPath, request.url)));

			if (response.status === 404) {
				// If the specific asset is not found, try serving index.html for the root of /public/
				if (assetPath === '/') {
					const indexHtmlResponse = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url)));
					if (indexHtmlResponse.ok) {
						return indexHtmlResponse;
					}
				}
				// If index.html is also not found or it wasn't the root request, return 404
				return new Response('Not Found', { status: 404 });
			}

			return response;
		}


		// --- User Registration Handler ---
		if (request.method === 'POST' && path === '/register') {
			logInfo('Registration request received');
			try {
				const { email, keywords } = await request.json();

				if (!email) {
					logWarning('Registration failed: Missing email in request body.');
					return new Response('Missing email', { status: 400 });
				}

				// Generate a simple user ID (e.g., hash of email)
				const encoder = new TextEncoder();
				const data = encoder.encode(email);
				const hashBuffer = await crypto.subtle.digest('SHA-256', data);
				const userId = Array.from(new Uint8Array(hashBuffer))
					.map(b => b.toString(16).padStart(2, '0'))
					.join('');

				// Check if user already exists
				// Pass the correct KV binding to userProfile functions
				const existingUser = await getUserProfile(userId, { 'mail-news-user-profiles': env['mail-news-user-profiles'] });
				if (existingUser) {
					logWarning(`Registration failed: User with email ${email} already exists.`, { email, userId });
					return new Response('User already exists', { status: 409 });
				}

				// Create user profile
				// Pass the correct KV binding to userProfile functions
				const newUserProfile = await createUserProfile(userId, email, { 'mail-news-user-profiles': env['mail-news-user-profiles'] });

				// Optionally add initial keywords if provided
				if (keywords && Array.isArray(keywords)) {
					newUserProfile.keywords = keywords.map(kw => String(kw)); // Ensure keywords are strings
					// Pass the correct KV binding to userProfile functions
					await updateUserProfile(newUserProfile, { 'mail-news-user-profiles': env['mail-news-user-profiles'] });
					logInfo(`Added initial keywords for user ${userId}.`, { userId, keywords: newUserProfile.keywords });
				}

				logInfo(`User registered successfully: ${userId}`, { userId, email });

				// Generate OAuth consent URL
				if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) {
					logError('Missing Google OAuth environment variables for consent URL generation.');
					return new Response('Server configuration error', { status: 500 });
				}

				const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
				authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
				authUrl.searchParams.set('redirect_uri', env.GOOGLE_REDIRECT_URI);
				authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.send');
				authUrl.searchParams.set('access_type', 'offline'); // To get a refresh token
				authUrl.searchParams.set('prompt', 'consent'); // To ensure refresh token is returned
				authUrl.searchParams.set('response_type', 'code');
				authUrl.searchParams.set('state', userId); // Include userId in state parameter

				logInfo(`Generated OAuth consent URL for user ${userId}`, { userId, authUrl: authUrl.toString() });

				// Return the consent URL to the user
				return new Response(JSON.stringify({ message: 'User registered. Please authorize Gmail access.', authUrl: authUrl.toString() }), {
					status: 201,
					headers: { 'Content-Type': 'application/json' },
				});

			} catch (error) {
				logError('Error during user registration:', error, { requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		// --- Click Tracking Handler ---
		if (request.method === 'GET' && path === '/track-click') {
			logInfo('Click tracking request received');
			const userId = url.searchParams.get('userId');
			const articleId = url.searchParams.get('articleId');
			const redirectUrl = url.searchParams.get('redirectUrl');

			if (!userId || !articleId || !redirectUrl) {
				logWarning('Click tracking failed: Missing userId, articleId, or redirectUrl.');
				return new Response('Missing parameters', { status: 400 });
			}

			try {
				// Get the Durable Object for this user
				const clickLoggerId = env.CLICK_LOGGER.idFromName(userId);
				const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

				// Send a request to the Durable Object to log the click
				// Use a relative path for the Durable Object fetch
				const logClickResponse = await clickLogger.fetch(new Request('http://dummy-host/log-click', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ userId, articleId, timestamp: Date.now() }),
				}));

				if (logClickResponse.ok) {
					logInfo(`Click logged successfully for user ${userId}, article ${articleId}`, { userId, articleId });
				} else {
					logError(`Failed to log click for user ${userId}, article ${articleId}: ${logClickResponse.statusText}`, null, { userId, articleId, status: logClickResponse.status, statusText: logClickResponse.statusText });
				}

				// Redirect the user to the original article URL
				return Response.redirect(redirectUrl, 302);

			} catch (error) {
				logError('Error during click tracking:', error, { userId, articleId, redirectUrl, requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		// --- OAuth2 Callback Handler ---
		if (request.method === 'GET' && path === '/oauth2callback') {
			logInfo('OAuth2 callback request received');

			const code = url.searchParams.get('code');
			const userId = url.searchParams.get('state'); // Get userId from state parameter

			if (!code) {
				logWarning('OAuth2 callback failed: Missing authorization code.');
				return new Response('Missing authorization code', { status: 400 });
			}

			if (!userId) {
				logWarning('OAuth2 callback failed: Missing state parameter (userId).');
				return new Response('Missing state parameter', { status: 400 });
			}

			// TODO: Implement state parameter verification for CSRF protection

			if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI || !env['mail-news-gmail-tokens']) {
				logError('Missing Google OAuth environment variables or KV binding.');
				return new Response('Server configuration error', { status: 500 });
			}

			try {
				// Exchange authorization code for tokens
				const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: new URLSearchParams({
						code: code,
						client_id: env.GOOGLE_CLIENT_ID,
						client_secret: env.GOOGLE_CLIENT_SECRET,
						redirect_uri: env.GOOGLE_REDIRECT_URI,
						grant_type: 'authorization_code',
					}).toString(),
				});

				if (!tokenResponse.ok) {
					const errorText = await tokenResponse.text();
					logError(`Failed to exchange authorization code for tokens: ${tokenResponse.statusText}`, null, { status: tokenResponse.status, statusText: tokenResponse.statusText, errorText });
					return new Response(`Error exchanging code: ${tokenResponse.statusText}`, { status: tokenResponse.status });
				}

				const tokenData: any = await tokenResponse.json();
				const accessToken = tokenData.access_token;
				const refreshToken = tokenData.refresh_token; // This will only be returned on the first exchange with access_type=offline

				if (!refreshToken) {
					logWarning('No refresh token received. Ensure access_type=offline was requested and this is the first authorization.');
					// Depending on the flow, this might be expected if already authorized
				}

				// Securely store the refresh token, associated with the user ID.
				await env['mail-news-gmail-tokens'].put(`refresh_token:${userId}`, refreshToken);
				logInfo(`Successfully stored refresh token for user ${userId}.`, { userId });

				return new Response('Authorization successful. You can close this window.', { status: 200 });

			} catch (error) {
				logError('Error during OAuth2 callback processing:', error, { userId, requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		// --- Get Articles for Education Handler ---
		if (request.method === 'GET' && path === '/get-articles-for-education') {
			logInfo('Request received for articles for education');
			try {
				const articles = await collectNews();
				logInfo(`Collected ${articles.length} articles for education.`, { articleCount: articles.length });

                // 記事を分類 (EnvWithAIAndKeywordsKV 型として env を渡す)
                const classifiedArticles = await classifyArticles(articles, env);
                logInfo(`Classified ${classifiedArticles.length} articles for education.`, { classifiedCount: classifiedArticles.length });


				// 分類結果を含む記事オブジェクトを返す
				const articlesWithClassification = classifiedArticles.map(article => ({
					articleId: article.link, // 記事IDとしてリンクを使用
					title: article.title,
					summary: article.summary,
					category: article.category, // 分類されたカテゴリーを追加
					llmResponse: article.llmResponse, // LLMの応答を追加 (LLMが使用された場合)
					// link: article.link, // 必要であれば追加
				}));

				return new Response(JSON.stringify(articlesWithClassification), {
					headers: { 'Content-Type': 'application/json' },
					status: 200,
				});

			} catch (error) {
				logError('Error fetching articles for education:', error, { requestUrl: request.url });
				return new Response('Error fetching articles', { status: 500 });
			}
		}

		// --- Submit Interests Handler ---
		if (request.method === 'POST' && path === '/submit-interests') {
			logInfo('Submit interests request received');
			try {
				// リクエストボディから userId と selectedArticles (記事オブジェクトの配列) を取得
				const { userId, selectedArticles } = await request.json();

				if (!userId || !Array.isArray(selectedArticles)) {
					logWarning('Submit interests failed: Missing userId or selectedArticles in request body.');
					return new Response('Missing parameters', { status: 400 });
				}

				// Get user profile from KV
				// Pass the correct KV binding to userProfile functions
				const userProfile = await getUserProfile(userId, { 'mail-news-user-profiles': env['mail-news-user-profiles'] });

				if (!userProfile) {
					logWarning(`Submit interests failed: User profile not found for ${userId}.`, { userId });
					return new Response('User not found', { status: 404 });
				}

				// Update user profile with selected article IDs
				// 既存の興味関心データがあればそれに追加
				const selectedArticleIds = selectedArticles.map(article => article.articleId);
				if (userProfile.interests) {
					userProfile.interests.push(...selectedArticleIds);
					// 重複を排除
					userProfile.interests = [...new Set(userProfile.interests)];
				} else {
					userProfile.interests = selectedArticleIds;
				}

				// Save updated user profile to KV
				// Pass the correct KV binding to userProfile functions
				await updateUserProfile(userProfile, { 'mail-news-user-profiles': env['mail-news-user-profiles'] });

				logInfo(`User interests updated successfully for user ${userId}.`, { userId, selectedArticleIds });

				// --- Learn from User Education (Send to Durable Object) ---
				logInfo(`Learning from user education for user ${userId}...`, { userId });

				const articlesToEmbed: NewsArticle[] = [];
				const articlesToEmbedTexts: string[] = [];
				const selectedArticlesWithEmbeddings: { articleId: string; embedding: number[]; }[] = [];

				// 選択された記事ごとにKVから取得し、embeddingを確認。KVにない場合はembedding生成対象とする。
				for (const selectedArticle of selectedArticles) {
					const articleId = selectedArticle.articleId;
					const cacheKey = `article:${articleId}`; // 記事IDはリンクと仮定
					const cachedArticle = await env.ARTICLE_EMBEDDINGS.get(cacheKey, { type: 'json' }) as NewsArticle | null;

					if (cachedArticle && cachedArticle.embedding) {
						// KVにあり、embeddingもある場合
						selectedArticlesWithEmbeddings.push({ articleId: cachedArticle.link, embedding: cachedArticle.embedding });
					} else {
						// KVにない、またはKVにはあるがembeddingがない場合
						// embedding生成対象リストに追加
						articlesToEmbed.push(selectedArticle); // フロントエンドから受け取った記事データを使用
						articlesToEmbedTexts.push(`${selectedArticle.title} ${selectedArticle.articleId}`); // embedding生成用のテキスト
					}
				}

				// embeddingが必要な記事があればバッチで生成
				if (articlesToEmbed.length > 0) {
					logInfo(`Generating embeddings for ${articlesToEmbed.length} selected articles for education...`, { count: articlesToEmbed.length });
					const embeddings = await getOpenAIEmbeddingsBatch(articlesToEmbedTexts, env);

					if (embeddings && embeddings.length === articlesToEmbed.length) {
						const articleCachePromises = [];
						for (let i = 0; i < articlesToEmbed.length; i++) {
							const article = articlesToEmbed[i];
							const embedding = embeddings[i];
							if (embedding) {
								selectedArticlesWithEmbeddings.push({ articleId: article.articleId, embedding });
								// 生成したembeddingをKVにキャッシュ（スケジュールタスクと同様のロジック）
								const cacheKey = `article:${article.articleId}`; // 記事IDはリンクと仮定
								const expirationTtl = 30 * 24 * 60 * 60; // 30 days in seconds
								// 既存の記事データにembeddingを追加して保存（KVに記事データがなかった場合は新規作成）
								const cachedArticle = await env.ARTICLE_EMBEDDINGS.get(cacheKey, { type: 'json' }) as NewsArticle | null;
								const updatedArticle = cachedArticle ? { ...cachedArticle, embedding } : { ...article, embedding }; // KVに既存データがあればそれを使用、なければフロントエンドからのデータを使用
								articleCachePromises.push(env.ARTICLE_EMBEDDINGS.put(cacheKey, JSON.stringify(updatedArticle), { expirationTtl }));
								logInfo(`Cached generated embedding for article: "${article.title}"`, { articleTitle: article.title, articleLink: article.articleId });
							} else {
								logWarning(`Embedding generation failed for selected article: "${article.title}". Skipping.`, { articleTitle: article.title, articleLink: article.articleId });
							}
						}
						await Promise.all(articleCachePromises);
						logInfo(`Finished generating and caching embeddings for ${articlesToEmbed.length} selected articles.`, { count: articlesToEmbed.length });
					} else {
						logError(`Embedding generation failed for selected articles batch. Expected ${articlesToEmbed.length} embeddings, got ${embeddings?.length}.`, null, { expected: articlesToEmbed.length, received: embeddings?.length });
					}
				} else {
					logInfo('No selected articles needed embedding generation (all had embeddings or were not found).');
				}


				if (selectedArticlesWithEmbeddings.length > 0) {
					// Get the Durable Object for this user
					const clickLoggerId = env.CLICK_LOGGER.idFromName(userId);
					const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

					const batchSize = 10; // バッチサイズを定義 (調整可能)
					logInfo(`Sending selected articles for learning to ClickLogger in batches of ${batchSize} for user ${userId}.`, { userId, totalCount: selectedArticlesWithEmbeddings.length, batchSize });

					for (let i = 0; i < selectedArticlesWithEmbeddings.length; i += batchSize) {
						const batch = selectedArticlesWithEmbeddings.slice(i, i + batchSize);
						logInfo(`Sending batch ${Math.floor(i / batchSize) + 1} with ${batch.length} articles for user ${userId}.`, { userId, batchNumber: Math.floor(i / batchSize) + 1, batchCount: batch.length });

						// Send a request to the Durable Object to learn from selected articles
						// Use a relative path for the Durable Object fetch
						const learnResponse = await clickLogger.fetch(new Request('http://dummy-host/learn-from-education', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ selectedArticles: batch }),
						}));

						if (learnResponse.ok) {
							logInfo(`Successfully sent batch ${Math.floor(i / batchSize) + 1} for learning to ClickLogger for user ${userId}.`, { userId, batchNumber: Math.floor(i / batchSize) + 1 });
						} else {
							logError(`Failed to send batch ${Math.floor(i / batchSize) + 1} for learning to ClickLogger for user ${userId}: ${learnResponse.statusText}`, null, { userId, batchNumber: Math.floor(i / batchSize) + 1, status: learnResponse.status, statusText: learnResponse.statusText });
							// エラーが発生した場合、後続のバッチ処理を中断するか継続するか検討
							// ここではエラーをログに出力し、処理を継続します。
						}
					}

					logInfo(`Finished sending all batches for learning to ClickLogger for user ${userId}.`, { userId, totalCount: selectedArticlesWithEmbeddings.length });

				} else {
					logWarning(`No selected articles with embeddings to send for learning for user ${userId}.`, { userId });
				}


				return new Response(JSON.stringify({ message: '興味関心が更新されました。' }), {
					headers: { 'Content-Type': 'application/json' },
					status: 200,
				});

			} catch (error) {
				logError('Error submitting interests:', error, { requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		} else if (request.method === 'POST' && path === '/delete-all-durable-object-data') {
			logInfo('Request received to delete all Durable Object data');
			try {
				// Get all user IDs from KV
				const userIds = await getAllUserIds({ 'mail-news-user-profiles': env['mail-news-user-profiles'] });
				logInfo(`Found ${userIds.length} users. Deleting data for each Durable Object.`, { userCount: userIds.length });

				const deletePromises = userIds.map(async userId => {
					try {
						const clickLoggerId = env.CLICK_LOGGER.idFromName(userId);
						const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);
						// Send request to the Durable Object to delete its data
						const deleteResponse = await clickLogger.fetch(new Request('http://dummy-host/delete-all-data', {
							method: 'POST',
						}));

						if (deleteResponse.ok) {
							logInfo(`Successfully deleted data for Durable Object for user ${userId}.`, { userId });
						} else {
							logError(`Failed to delete data for Durable Object for user ${userId}: ${deleteResponse.statusText}`, null, { userId, status: deleteResponse.status, statusText: deleteResponse.statusText });
						}
					} catch (error) {
						logError(`Error processing Durable Object deletion for user ${userId}:`, error, { userId });
					}
				});

				await Promise.all(deletePromises);

				logInfo('Finished attempting to delete data for all Durable Objects.');
				return new Response('Attempted to delete data for all Durable Objects', { status: 200 });

			} catch (error) {
				logError('Error during deletion of all Durable Object data:', error, { requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		} else if (request.method === 'POST' && path === '/openai-batch-callback') {
            logInfo('OpenAI Batch API callback received.');
            try {
                const batchJobData = await request.json();
                const jobId = batchJobData.id;
                const status = batchJobData.status;
                const output_file_id = batchJobData.output_file_id;

                logInfo(`Batch Job ${jobId} status: ${status}. Output File ID: ${output_file_id}`, { jobId, status, output_file_id });

                if (status === 'completed' && output_file_id) {
                    logInfo(`Batch Job ${jobId} completed. Fetching results...`, { jobId });
                    const resultsContent = await getOpenAIBatchJobResults(output_file_id, env);

                    if (resultsContent) {
                        const lines = resultsContent.split('\n').filter(line => line.trim() !== '');
                        const articlesToSave: { id: string, title: string, url: string, published_at: number, content: string, embedding: number[] }[] = [];

                        for (const line of lines) {
                            try {
                                const result = JSON.parse(line);
                                if (result.response && result.response.body && result.response.body.data && result.response.body.data.length > 0) {
                                    const customId = result.custom_id; // This is the article link
                                    const embedding = result.response.body.data[0].embedding;

                                    // Retrieve original article data from KV using customId (article link)
                                    // This assumes the original article data (title, url, content, published_at)
                                    // was stored in KV with a key like `article:${link}` during collection.
                                    const originalArticle = await env.ARTICLE_EMBEDDINGS.get(`article:${customId}`, { type: 'json' });

                                    if (originalArticle) {
                                        articlesToSave.push({
                                            id: customId,
                                            title: originalArticle.title,
                                            url: originalArticle.link,
                                            published_at: originalArticle.published_at,
                                            content: originalArticle.summary, // Assuming summary is stored as content
                                            embedding: embedding,
                                        });
                                    } else {
                                        logWarning(`Original article data not found in KV for custom_id: ${customId}. Skipping D1 save for this article.`, { customId });
                                    }
                                } else {
                                    logWarning(`Batch result line missing expected data structure: ${line}`, { line });
                                }
                            } catch (parseError) {
                                logError(`Error parsing batch result line: ${line}`, parseError);
                            }
                        }

                        if (articlesToSave.length > 0) {
                            logInfo(`Saving ${articlesToSave.length} articles with embeddings to D1...`, { count: articlesToSave.length });
                            const insertPromises = articlesToSave.map(article =>
                                env.DB.prepare(
                                    "INSERT OR REPLACE INTO articles (id, title, url, published_at, content, embedding) VALUES (?, ?, ?, ?, ?, ?)"
                                ).bind(
                                    article.id,
                                    article.title,
                                    article.url,
                                    article.published_at,
                                    article.content,
                                    JSON.stringify(article.embedding) // Store embedding as JSON string
                                ).run()
                            );
                            await Promise.all(insertPromises);
                            logInfo(`Successfully saved ${articlesToSave.length} articles to D1.`, { savedCount: articlesToSave.length });

                            // Clean up temporary article data from KV after saving to D1
                            const deleteKvPromises = articlesToSave.map(article =>
                                env.ARTICLE_EMBEDDINGS.delete(`article:${article.id}`)
                            );
                            await Promise.all(deleteKvPromises);
                            logInfo(`Cleaned up temporary KV data for ${articlesToSave.length} articles.`, { cleanedCount: articlesToSave.length });

                        } else {
                            logWarning('No valid embedding results to save to D1.', null);
                        }
                    } else {
                        logError(`Failed to fetch results for batch job ${jobId}.`, null, { jobId });
                    }
                } else if (status === 'failed' || status === 'cancelled') {
                    logError(`OpenAI Batch Job ${jobId} failed or was cancelled.`, null, { jobId, status, errors: batchJobData.errors });
                } else {
                    logInfo(`OpenAI Batch Job ${jobId} is still in progress or has an unexpected status: ${status}`, { jobId, status });
                }

                return new Response('Callback processed', { status: 200 });
            } catch (error) {
                logError('Error processing OpenAI Batch API callback:', error, { requestUrl: request.url });
                return new Response('Internal Server Error', { status: 500 });
            }
        }


		// Handle Durable Object requests
		if (path.startsWith('/do/')) {
			const parts = path.split('/');
			if (parts.length >= 4 && parts[3] === 'delete-all-data' && request.method === 'POST') {
				const doId = parts[2]; // Assuming DO ID is the third part of the path
				try {
					const id = env.CLICK_LOGGER.idFromString(doId);
					const clickLogger = env.CLICK_LOGGER.get(id);
					// Forward the request to the Durable Object
					return clickLogger.fetch(request);
				} catch (error) {
					logError(`Error fetching Durable Object ${doId}:`, error);
					return new Response('Error fetching Durable Object', { status: 500 });
				}
			}
			// Add other Durable Object endpoint routing here if needed
		}


		// Handle other requests or return a default response
		return new Response('Not Found', { status: 404 });
	},
};

// Durable Object class definition (must be exported)
export { ClickLogger } from './clickLogger';
