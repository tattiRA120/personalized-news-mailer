import { collectNews, NewsArticle } from './newsCollector';
import { getUserProfile, updateUserProfile, UserProfile, getAllUserIds, createUserProfile } from './userProfile';
import { selectPersonalizedArticles } from './articleSelector';
import { generateNewsEmail, sendNewsEmail } from './emailGenerator';
import { ClickLogger } from './clickLogger';
import { BatchQueueDO } from './batchQueueDO';
import { logError, logInfo, logWarning } from './logger';
import { uploadOpenAIFile, createOpenAIBatchEmbeddingJob, getOpenAIBatchJobResults, prepareBatchInputFileContent, chunkArray } from './openaiClient'; // chunkArray を追加
import { CHUNK_SIZE } from './config';
// Define the Env interface with bindings from wrangler.jsonc
export interface Env {
	USER_DB: D1Database;
	CLICK_LOGGER: DurableObjectNamespace<ClickLogger>;
    BATCH_QUEUE_DO: DurableObjectNamespace<BatchQueueDO>;
	OPENAI_API_KEY?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GOOGLE_REDIRECT_URI?: string;
	'mail-news-gmail-tokens': KVNamespace;
    BATCH_CALLBACK_TOKENS: KVNamespace;
    DB: D1Database;
    WORKER_BASE_URL?: string;
    DEBUG_API_KEY?: string;
    ASSETS: Fetcher; // ASSETS binding for static assets
}

interface EmailRecipient {
    email: string;
    name?: string;
}

interface D1Result {
    success: boolean;
    error?: string;
    results?: any[]; // all() や first() の結果
    meta?: { duration?: number; served_by?: string; changes?: number; last_row_id?: number; size_after?: number; }; // run() の結果
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

            // --- 1. D1への仮保存 ---
            logInfo('Saving collected articles to D1 temporarily...');
            const articlesToSaveToD1 = articles.map(article => ({
                articleId: article.articleId,
                title: article.title,
                url: article.link,
                publishedAt: article.publishedAt,
                content: article.summary || '', // summary が undefined の場合は空文字列を割り当てる
                embedding: undefined, // embedding は後で更新するため、ここでは undefined
            }));
            await saveArticlesToD1(articlesToSaveToD1, env);
            logInfo(`Saved ${articlesToSaveToD1.length} articles to D1 temporarily.`, { count: articlesToSaveToD1.length });

            // 日本時間22時（UTC 13時）のCronトリガーでのみ埋め込みバッチジョブを作成
            const scheduledHourUTC = new Date(controller.scheduledTime).getUTCHours();
            if (scheduledHourUTC === 13) { // 22:00 JST is 13:00 UTC
                logInfo('Starting OpenAI Batch API embedding job creation...');

                // D1から既存の記事のURLとembeddingの有無を取得
                const { results: existingArticlesInDb } = await env.DB.prepare("SELECT article_id, embedding FROM articles").all();
                const existingArticleIdsWithEmbedding = new Set(
                    (existingArticlesInDb as any[])
                        .filter(row => row.embedding !== null && row.embedding !== undefined)
                        .map(row => row.article_id)
                );
                logInfo(`Found ${existingArticleIdsWithEmbedding.size} articles with existing embeddings in D1.`, { count: existingArticleIdsWithEmbedding.size });

                // 収集した記事から、既にembeddingが存在する記事を除外
                const articlesToEmbed = articles.filter(article => !existingArticleIdsWithEmbedding.has(article.articleId));
                logInfo(`Filtered down to ${articlesToEmbed.length} articles that need embedding.`, { articlesToEmbedCount: articlesToEmbed.length, totalCollected: articles.length });

                if (articlesToEmbed.length === 0) {
                    logInfo('No new articles found that need embedding. Skipping batch job creation.');
                } else {
                    // チャンク分割
                    const chunks = chunkArray(articlesToEmbed, CHUNK_SIZE);
                    logInfo(`Total chunks: ${chunks.length} (each up to ${CHUNK_SIZE} articles)`);

                    // 最初のチャンクをCron内で処理
                    const firstChunk = chunks[0];
                    // セキュリティ強化: コールバックURLに固有トークンを付与し、KVに保存
                    const callbackToken = crypto.randomUUID();
                    const callbackUrl = env.WORKER_BASE_URL
                        ? `${env.WORKER_BASE_URL}/openai-batch-callback?token=${callbackToken}`
                        : `https://mail-news.tattira120.workers.dev/openai-batch-callback?token=${callbackToken}`;

                    // トークンをKVに保存 (有効期限48時間)
                    await env.BATCH_CALLBACK_TOKENS.put(callbackToken, 'true', { expirationTtl: 48 * 60 * 60 });
                    logInfo(`Stored callback token in KV with 48h TTL.`, { callbackToken });

                    // JSONL 生成
                    const jsonl = prepareBatchInputFileContent(firstChunk);
                    const blob = new Blob([jsonl], { type: "application/jsonl" });
                    const filename = `articles_chunk0_${Date.now()}.jsonl`;

                    // ファイルアップロード
                    let uploaded;
                    try {
                        uploaded = await uploadOpenAIFile(filename, blob, "batch", env);
                    } catch (e) {
                        logError("Chunk 0 upload failed", e, { chunkIndex: 0 });
                        return; // Cron を終了
                    }
                    if (!uploaded || !uploaded.id) {
                        logError("Chunk 0 upload returned no file ID.", null, { chunkIndex: 0 });
                        return;
                    }
                    logInfo("Chunk 0 uploaded. File ID:", { fileId: uploaded.id });

                    // バッチジョブ作成
                    try {
                        const job = await createOpenAIBatchEmbeddingJob(
                            uploaded.id,
                            callbackUrl,
                            env
                        );
                        if (!job || !job.id) {
                            logError("Chunk 0 batch job creation returned no job ID.", null, { chunkIndex: 0 });
                            return;
                        }
                        logInfo("Chunk 0 batch job created.", { jobId: job.id });
                    } catch (e) {
                        logError("Chunk 0 batch job creation failed", e, { chunkIndex: 0 });
                        return;
                    }

                    // 残りチャンクを分散処理用に委譲 (Durable Object を利用)
                    const remainingChunks = chunks.slice(1).map((articles: NewsArticle[], index: number) => ({
                        chunkIndex: index + 1, // チャンクインデックスを調整
                        articles: articles
                    }));

                    if (remainingChunks.length > 0) {
                        logInfo(`Delegating ${remainingChunks.length} remaining chunks to BatchQueueDO.`);
                        const batchQueueDOId = env.BATCH_QUEUE_DO.idFromName("batch-embedding-queue");
                        const batchQueueDOStub = env.BATCH_QUEUE_DO.get(batchQueueDOId);

                        await batchQueueDOStub.fetch(new Request('http://dummy-host/queue-chunks', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chunks: remainingChunks }),
                        }));
                        logInfo(`Successfully delegated ${remainingChunks.length} chunks to BatchQueueDO.`);
                    }
                }
            }

            // --- Fetch articles from D1 ---
            logInfo('Fetching articles from D1.');

            // For now, fetch all articles. In a real scenario, you might fetch recent ones or those not yet processed.
            const { results } = await env.DB.prepare("SELECT * FROM articles ORDER BY published_at DESC LIMIT 1000").all(); // Fetch recent 1000 articles
            const articlesFromD1: NewsArticle[] = (results as any[]).map(row => ({
                articleId: row.article_id, // Add articleId
                title: row.title,
                link: row.url,
                sourceName: '', // D1から取得したデータにはsourceNameがないため、空文字列で初期化
                summary: row.content, // Assuming 'content' column stores summary/full text
                embedding: row.embedding ? JSON.parse(row.embedding) : undefined, // Parse JSON string back to array, handle null/undefined
                publishedAt: row.published_at, // Use publishedAt
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


			// --- 2. Get all users ---
			logInfo('Fetching all user IDs...');
			const userIds = await getAllUserIds(env); // env を直接渡す
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

					const userProfile = await getUserProfile(userId, env); // env を直接渡す

					if (!userProfile) {
						logError(`User profile not found for ${userId}. Skipping email sending for this user.`, null, { userId });
						continue; // Skip to the next user
					}
					logInfo(`Loaded user profile for ${userId}.`);

					// Durable Object (ClickLogger) のインスタンスを取得
					const clickLoggerId = env.CLICK_LOGGER.idFromName(userId); // ユーザーIDに対応するDO IDを取得
					const clickLogger: DurableObjectStub<ClickLogger> = env.CLICK_LOGGER.get(clickLoggerId); // DO インスタンスを取得

					// --- 3. Article Selection (MMR + Bandit) ---
					logInfo(`Starting article selection (MMR + Bandit) for user ${userId}...`, { userId });

					// selectPersonalizedArticles 関数に embedding が付与された記事リストを渡す
					const numberOfArticlesToSend = 5; // Define how many articles to send
					const selectedArticles = await selectPersonalizedArticles(articlesWithEmbeddings, userProfile, clickLogger, numberOfArticlesToSend, 0.5);
					logInfo(`Selected ${selectedArticles.length} articles for user ${userId}.`, { userId, selectedCount: selectedArticles.length });

					if (selectedArticles.length === 0) {
						logInfo('No articles selected. Skipping email sending for this user.', { userId });
						continue; // Skip to the next user
					}

					// --- 4. Email Generation & Sending ---
					logInfo(`Generating and sending email for user ${userId}...`, { userId });
					const emailSubject = 'Your Daily Personalized News Update';
					const recipientEmail = userProfile.email; // Use actual user email from profile
					if (!recipientEmail) {
						logError(`User profile for ${userId} does not contain an email address. Skipping email sending.`, null, { userId });
						continue;
					}
					const sender: EmailRecipient = { email: recipientEmail, name: 'Mailify News' }; // Use recipient email as sender for Gmail API

					// generateNewsEmail 関数に userId を渡す
					const htmlEmailContent = generateNewsEmail(selectedArticles, userId);

					// Pass the sender object and env to sendNewsEmail (now using Gmail API)
					const emailResponse = await sendNewsEmail(env, recipientEmail, userId, selectedArticles, sender);

					if (emailResponse.ok) {
						logInfo(`Personalized news email sent to ${recipientEmail} via Gmail API.`, { userId, email: recipientEmail });
					} else {
						logError(`Failed to send email to ${recipientEmail} via Gmail API: ${emailResponse.statusText}`, null, { userId, email: recipientEmail, status: emailResponse.status, statusText: emailResponse.statusText });
					}

					// --- 5. Log Sent Articles to Durable Object ---
					logInfo(`Logging sent articles to ClickLogger for user ${userId}...`, { userId });
					const sentArticlesData = selectedArticles.map(article => ({
						articleId: article.articleId, // articleId を使用
						timestamp: Date.now(), // 送信時のタイムスタンプ
                        embedding: article.embedding, // embedding を含める
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


					// --- 6. Process Click Logs and Update Bandit Model ---
					logInfo(`Processing click logs and updating bandit model for user ${userId}...`, { userId });
					
                    // D1から未処理のクリックログを取得
                    const { results: clickLogs } = await env.USER_DB.prepare(
                        `SELECT article_id, timestamp FROM click_logs WHERE user_id = ?`
                    ).bind(userId).all<{ article_id: string, timestamp: number }>();

                    logInfo(`Found ${clickLogs.length} click logs to process for user ${userId}.`, { userId, count: clickLogs.length });

					if (clickLogs.length > 0) {
						const updatePromises = clickLogs.map(async clickLog => {
							const articleId = clickLog.article_id;

							// D1から記事データ（embeddingを含む）を取得
							const { results } = await env.DB.prepare("SELECT embedding FROM articles WHERE article_id = ?").bind(articleId).all();
							const articleEmbedding = results && results.length > 0 ? JSON.parse((results[0] as any).embedding) : null;

							if (articleEmbedding) {
								// バンディットモデルを更新
								const reward = 1.0; // クリックイベントなので報酬は 1.0
								const updateResponse = await clickLogger.fetch(new Request('http://dummy-host/update-bandit-from-click', {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({ articleId: articleId, embedding: articleEmbedding, reward: reward }),
								}));

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
                        const clickLogIdsToDelete = clickLogs.map(log => log.article_id); // Assuming article_id is unique enough for deletion or need a primary key from click_logs table
                        if (clickLogIdsToDelete.length > 0) {
                            // D1のclick_logsテーブルにPRIMARY KEYのidがあるため、それを使って削除する
                            // SELECT id FROM click_logs WHERE user_id = ? AND article_id IN (...)
                            const { results: idsToDelete } = await env.USER_DB.prepare(
                                `SELECT id FROM click_logs WHERE user_id = ? AND article_id IN (${clickLogIdsToDelete.map(() => '?').join(',')})`
                            ).bind(userId, ...clickLogIdsToDelete).all<{ id: number }>();

                            if (idsToDelete && idsToDelete.length > 0) {
                                const deleteStmt = env.USER_DB.prepare(
                                    `DELETE FROM click_logs WHERE id IN (${idsToDelete.map(() => '?').join(',')})`
                                );
                                await deleteStmt.bind(...idsToDelete.map(row => row.id)).run();
                                logInfo(`Deleted ${idsToDelete.length} processed click logs from D1 for user ${userId}.`, { userId, deletedCount: idsToDelete.length });
                            }
                        }

					} else {
						logInfo(`No click logs to process for user ${userId}.`, { userId });
					}

                    // --- 7. Clean up old logs in D1 ---
                    logInfo(`Starting cleanup of old logs for user ${userId}...`, { userId });
                    const daysToKeepLogs = 30; // ログを保持する日数 (調整可能)
                    const cutoffTimestamp = Date.now() - daysToKeepLogs * 24 * 60 * 60 * 1000; // 指定日数より前のタイムスタンプ

                    // click_logs, sent_articles, education_logs から古いデータを削除
                    const cleanupPromises = [
                        env.USER_DB.prepare(`DELETE FROM click_logs WHERE user_id = ? AND timestamp < ?`).bind(userId, cutoffTimestamp).run(),
                        env.USER_DB.prepare(`DELETE FROM sent_articles WHERE user_id = ? AND timestamp < ?`).bind(userId, cutoffTimestamp).run(),
                        env.USER_DB.prepare(`DELETE FROM education_logs WHERE user_id = ? AND timestamp < ?`).bind(userId, cutoffTimestamp).run(),
                    ];
                    await Promise.all(cleanupPromises);
                    logInfo(`Finished cleanup of old logs for user ${userId} in D1.`, { userId });


					// TODO: Update user profile with sent article IDs for future reference/negative feedback
					// This could be done here or within the click logging process
					// For now, let's add a placeholder for updating the profile with sent articles
					// userProfile.sentArticleIds は userProfile から削除されたため、このロジックは不要
					// userProfile.interests は教育プログラムで更新されるため、ここでは更新しない
					await updateUserProfile(userProfile, env); // env を直接渡す
					logInfo(`Updated user profile for ${userId}.`, { userId });


				} catch (userProcessError) {
					logError(`Error processing user ${userId}:`, userProcessError, { userId });
					// Continue to the next user even if one user's process fails
				}
			} // End of user loop

            // --- 8. Clean up old articles in D1 ---
            // This should run only for the email sending cron (08:00 JST, 23:00 UTC previous day)
            if (scheduledHourUTC === 23) { // Check if it's the email sending cron
                logInfo('Starting D1 article cleanup...');
                try {
                    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000); // 30 days in milliseconds
                    const { success, error, meta } = await env.DB.prepare("DELETE FROM articles WHERE published_at < ?").bind(thirtyDaysAgo).run() as D1Result;

                    if (success) {
                        logInfo(`Successfully deleted old articles from D1. Rows affected: ${meta?.changes || 0}`, { deletedCount: meta?.changes || 0 });
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
				const { email } = await request.json() as { email: string }; // keywords を削除

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
				const existingUser = await getUserProfile(userId, env); // env を直接渡す
				if (existingUser) {
					logWarning(`Registration failed: User with email ${email} already exists.`, { email, userId });
					return new Response('User already exists', { status: 409 });
				}

				// Create user profile
				const newUserProfile = await createUserProfile(userId, email, env); // env を直接渡す

				logInfo(`User registered successfully: ${userId}`, { userId, email });

				// Generate OAuth consent URL
				if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) {
					logError('Missing Google OAuth environment variables for consent URL generation.', null);
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
				logError('Missing Google OAuth environment variables or KV binding.', null);
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

				// 記事オブジェクトを返す
				const articlesForEducation = articles.map(article => ({
					articleId: article.articleId, // 記事IDとして articleId を使用
					title: article.title,
					summary: article.summary,
					// link: article.link, // 必要であれば追加
				}));

				return new Response(JSON.stringify(articlesForEducation), {
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
				const { userId, selectedArticles } = await request.json() as { userId: string, selectedArticles: NewsArticle[] };

				if (!userId || !Array.isArray(selectedArticles)) {
					logWarning('Submit interests failed: Missing userId or selectedArticles in request body.');
					return new Response('Missing parameters', { status: 400 });
				}

				// Get user profile from D1
				const userProfile = await getUserProfile(userId, env);

				if (!userProfile) {
					logWarning(`Submit interests failed: User profile not found for ${userId}.`, { userId });
					return new Response('User not found', { status: 404 });
				}

				// Update user profile with selected article IDs
				// userProfile.interests は教育プログラムで選択された記事ID (リンク) を保持
				const selectedArticleIds = selectedArticles.map(article => article.articleId);
				userProfile.interests.push(...selectedArticleIds);
				// 重複を排除
				userProfile.interests = [...new Set(userProfile.interests)];

				// Save updated user profile to D1
				await updateUserProfile(userProfile, env);

				logInfo(`User interests updated successfully for user ${userId}.`, { userId, selectedArticleIds });

				// --- Learn from User Education (Send to Durable Object) ---
				logInfo(`Learning from user education for user ${userId}...`, { userId });

				const selectedArticlesWithEmbeddings: { articleId: string; embedding: number[]; }[] = [];

				// 選択された記事ごとにD1からembeddingを取得
				for (const selectedArticle of selectedArticles) {
					const articleId = selectedArticle.articleId;
					const { results } = await env.DB.prepare("SELECT embedding FROM articles WHERE article_id = ?").bind(articleId).all();
					const embedding = results && results.length > 0 ? JSON.parse((results[0] as any).embedding) : null;

					if (embedding) {
						selectedArticlesWithEmbeddings.push({ articleId: articleId, embedding: embedding });
					} else {
						logWarning(`Embedding not found in D1 for selected article: "${selectedArticle.title}". Skipping.`, { articleTitle: selectedArticle.title, articleLink: selectedArticle.articleId });
					}
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
		} else if (request.method === 'POST' && path.startsWith('/openai-batch-callback')) {
			logInfo('OpenAI Batch API callback received');
			try {
                // セキュリティ強化: トークン検証
                const token = url.searchParams.get('token');
                if (!token) {
                    logWarning('OpenAI Batch API callback failed: Missing token in query parameters.');
                    return new Response('Missing token', { status: 401 });
                }

                const tokenExists = await env.BATCH_CALLBACK_TOKENS.get(token);
                if (!tokenExists) {
                    logWarning('OpenAI Batch API callback failed: Invalid or expired token.', { token });
                    return new Response('Invalid or expired token', { status: 401 });
                }

                // トークンは一度しか使用できないように削除
                await env.BATCH_CALLBACK_TOKENS.delete(token);
                logInfo(`Successfully validated and deleted callback token.`, { token });

				const batchResult: any = await request.json(); // Cast to any
				const batchId = batchResult.id; // Assuming the batch ID is in the payload

				if (!batchId) {
					logWarning('OpenAI Batch API callback failed: Missing batch ID in request body.');
					return new Response('Missing batch ID', { status: 400 });
				}

                // output_file_id は batchResult.output_file_id から取得
                const output_file_id = batchResult.output_file_id;

                if (!output_file_id) {
                    logWarning(`OpenAI Batch API callback for ID ${batchId} failed: Missing output_file_id in request body. Batch status: ${batchResult.status}`, { batchId, batchStatus: batchResult.status });
                    // If output_file_id is missing, it means the batch job likely failed or was cancelled.
                    // Log the error and return.
                    return new Response('Missing output file ID', { status: 400 });
                }

				logInfo(`Received callback for OpenAI Batch ID: ${batchId} with output file ID: ${output_file_id}`, { batchId, output_file_id, batchResult });

                // Download batch results
                const batchOutputContent = await getOpenAIBatchJobResults(output_file_id, env);

                if (!batchOutputContent) {
                    logError(`Failed to download batch results for Batch ID: ${batchId}, Output File ID: ${output_file_id}`, null, { batchId, output_file_id });
                    return new Response('Failed to download batch results', { status: 500 });
                }


                // Process batch results and save to D1
                const lines = batchOutputContent.split('\n').filter(line => line.trim() !== '');
                logInfo(`Batch results contain ${lines.length} lines`, { lineCount: lines.length });

                const BATCH_UPDATE_SIZE = 500;
                let updateRecords: {
                    articleId: string;
                    embedding: number[];
                }[] = [];

                for (const [idx, line] of lines.entries()) {
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.response && parsed.response.body && parsed.response.body.data && parsed.response.body.data.length > 0) {
                            const embedding = parsed.response.body.data[0].embedding;
                            const customIdString = parsed.custom_id;

                            try {
                                const originalArticleMetadata = JSON.parse(customIdString);
                                updateRecords.push({
                                    articleId: originalArticleMetadata.articleId, // custom_id から articleId を取得
                                    embedding: embedding,
                                });
                            } catch (parseError) {
                                logError(`Error parsing custom_id JSON for line: ${line}`, parseError, { line });
                            }
                        } else {
                            logWarning(`Batch result line missing expected embedding data: ${line}`, { line });
                        }
                    } catch (jsonParseError) {
                        logError(`Error parsing batch result line as JSON: ${line}`, jsonParseError, { line });
                        continue; // エラーが発生した行はスキップ
                    }

                    // 500 レコードたまったら一括更新
                    if (updateRecords.length >= BATCH_UPDATE_SIZE) {
                        try {
                            await updateArticleEmbeddingsInD1(updateRecords, env);
                            logInfo(`Updated embeddings for ${updateRecords.length} records in D1`, { count: updateRecords.length });
                        } catch (e) {
                            logError("Error updating embeddings batch in D1", e, { batchSize: updateRecords.length });
                        }
                        updateRecords = [];
                    }
                }

                // 残りを更新
                if (updateRecords.length > 0) {
                    try {
                        await updateArticleEmbeddingsInD1(updateRecords, env);
                        logInfo(`Updated embeddings for final ${updateRecords.length} records in D1`, { count: updateRecords.length });
                    } catch (e) {
                        logError("Error updating final embeddings batch in D1", e, { batchSize: updateRecords.length });
                    }
                }

				return new Response('Callback processed', { status: 200 });

			} catch (error) {
				logError('Error processing OpenAI Batch API callback:', error, { requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		} else if (request.method === 'POST' && path === '/delete-all-durable-object-data') {
			logInfo('Request received to delete all Durable Object data');
			try {
				// Get all user IDs from D1
				const userIds = await getAllUserIds(env);
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
		} else if (request.method === 'POST' && path === '/debug/force-embed-articles') {
            logInfo('Debug: Force embed articles request received');
            // Check for DEBUG_API_KEY for authentication
            const debugApiKey = request.headers.get('X-Debug-Key');
            if (debugApiKey !== env.DEBUG_API_KEY) {
                logWarning('Debug: Unauthorized access attempt to /debug/force-embed-articles', { providedKey: debugApiKey });
                return new Response('Unauthorized', { status: 401 });
            }

            try {
                logInfo('Debug: Starting news collection for force embedding...');
                const articles = await collectNews();
                logInfo(`Debug: Collected ${articles.length} articles for force embedding.`, { articleCount: articles.length });

                if (articles.length === 0) {
                    logInfo('Debug: No articles collected for force embedding. Skipping further steps.');
                    return new Response('No articles collected', { status: 200 });
                }

                logInfo('Debug: Starting OpenAI Batch API embedding job creation for force embedding...');

                // D1から既存の記事のURLとembeddingの有無を取得
                const { results: existingArticlesInDb } = await env.DB.prepare("SELECT url, embedding FROM articles").all();
                const existingArticleUrlsWithEmbedding = new Set(
                    (existingArticlesInDb as any[])
                        .filter(row => row.embedding !== null && row.embedding !== undefined)
                        .map(row => row.url)
                );
                logInfo(`Debug: Found ${existingArticleUrlsWithEmbedding.size} articles with existing embeddings in D1.`, { count: existingArticleUrlsWithEmbedding.size });

                // 収集した記事から、既にembeddingが存在する記事を除外
                const articlesToEmbed = articles.filter(article => !existingArticleUrlsWithEmbedding.has(article.link));
                logInfo(`Debug: Filtered down to ${articlesToEmbed.length} articles that need embedding for force embedding.`, { articlesToEmbedCount: articlesToEmbed.length, totalCollected: articles.length });

                if (articlesToEmbed.length === 0) {
                    logInfo('Debug: No new articles found that need embedding for force embedding. Skipping batch job creation.');
                    return new Response('No articles collected that need embedding', { status: 200 });
                }

                const batchInputContent = prepareBatchInputFileContent(articlesToEmbed); // フィルタリングされた articlesToEmbed を渡す
                const batchInputBlob = new Blob([batchInputContent], { type: 'application/jsonl' });
                const filename = `articles_for_embedding_force_${Date.now()}.jsonl`;

                const uploadedFile = await uploadOpenAIFile(filename, batchInputBlob, 'batch', env);

                if (uploadedFile && uploadedFile.id) {
                    // セキュリティ強化: コールバックURLに固有トークンを付与し、KVに保存
                    const callbackToken = crypto.randomUUID();
                    const callbackUrl = env.WORKER_BASE_URL
                        ? `${env.WORKER_BASE_URL}/openai-batch-callback?token=${callbackToken}`
                        : `https://mail-news.tattira120.workers.dev/openai-batch-callback?token=${callbackToken}`;

                    // トークンをKVに保存 (有効期限48時間)
                    await env.BATCH_CALLBACK_TOKENS.put(callbackToken, 'true', { expirationTtl: 48 * 60 * 60 });
                    logInfo(`Debug: Stored callback token in KV with 48h TTL.`, { callbackToken });

                    const batchJob = await createOpenAIBatchEmbeddingJob(uploadedFile.id, callbackUrl, env);

                    if (batchJob && batchJob.id) {
                        logInfo(`Debug: OpenAI Batch API job created successfully for force embedding. Job ID: ${batchJob.id}`, { jobId: batchJob.id });
                        return new Response(JSON.stringify({ message: 'Batch embedding job initiated successfully.', jobId: batchJob.id }), {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' },
                        });
                    } else {
                        logError('Debug: Failed to create OpenAI Batch API job for force embedding.', null, { debug: true });
                        return new Response('Failed to create batch embedding job', { status: 500 });
                    }
                } else {
                    logError('Debug: Failed to upload file to OpenAI for force batch embedding.', null, { debug: true });
                    return new Response('Failed to upload file for batch embedding', { status: 500 });
                }
            } catch (error) {
                logError('Debug: Error during force embedding process:', error, { requestUrl: request.url });
                return new Response('Internal Server Error during force embedding', { status: 500 });
            }
        }


		// Handle other requests or return a default response
		return new Response('Not Found', { status: 404 });
	},
};

// Durable Object class definition (must be exported)
export { ClickLogger } from './clickLogger';
export { BatchQueueDO } from './batchQueueDO'; // BatchQueueDO をエクスポート

async function saveArticlesToD1(
  records: {
    articleId: string;
    title: string;
    url: string;
    publishedAt: number;
    content: string;
    embedding: number[] | undefined; // embedding を undefined も許容するように変更
  }[],
  env: Env
): Promise<void> {
  const stmt = env.DB.prepare(`
    INSERT OR REPLACE INTO articles (article_id, title, url, published_at, content, embedding)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const batch = records.map((rec) => {
    return stmt.bind(
      rec.articleId,
      rec.title,
      rec.url,
      rec.publishedAt,
      rec.content,
      JSON.stringify(rec.embedding)
    );
  });
  await env.DB.batch(batch);
}

async function updateArticleEmbeddingsInD1(
  records: {
    articleId: string;
    embedding: number[];
  }[],
  env: Env
): Promise<void> {
  const stmt = env.DB.prepare(`
    UPDATE articles
    SET embedding = ?
    WHERE article_id = ?
  `);
  const batch = records.map((rec) => {
    return stmt.bind(
      JSON.stringify(rec.embedding),
      rec.articleId
    );
  });
  await env.DB.batch(batch);
}
