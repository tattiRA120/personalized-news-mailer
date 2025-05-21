// @ts-nocheck
import { collectNews } from './newsCollector';
import { getOpenAIEmbeddingsBatch } from './openaiClient'; // Import OpenAI embeddings client
import { getUserProfile, updateUserProfile, UserProfile, getAllUserIds, createUserProfile, updateCategoryInterestScores } from './userProfile'; // Assuming these functions are in userProfile.ts
import { selectTopArticles, selectPersonalizedArticles } from './articleSelector'; // Assuming these functions are in articleSelector.ts
import { generateNewsEmail, sendNewsEmail } from './emailGenerator'; // Assuming these functions are in emailGenerator.ts
import { ClickLogger } from './clickLogger'; // Assuming this is your Durable Object class
import { logError, logInfo, logWarning } from './logger'; // Import logging helpers
import { classifyArticles } from './categoryClassifier'; // Import classifyArticles
import { ARTICLE_CATEGORIES } from './config'; // カテゴリーリストを取得するためにconfigをインポート

// Define the Env interface with bindings from wrangler.jsonc
export interface Env {
	'mail-news-user-profiles': KVNamespace; // KV Namespace binding name from wrangler.jsonc
	CLICK_LOGGER: DurableObjectNamespace;
	GEMINI_API_KEY?: string; // Assuming GEMINI_API_KEY is set as a secret or var (for scoring)
	OPENAI_API_KEY?: string; // Import OpenAI embeddings client
	// Add other bindings as needed (e.g., R2, Queues)
	GOOGLE_CLIENT_ID?: string; // Add Google Client ID
	GOOGLE_CLIENT_SECRET?: string; // Add Google Client Secret
	GOOGLE_REDIRECT_URI?: string; // Add Google Redirect URI
	'mail-news-gmail-tokens': KVNamespace; // KV Namespace for storing Gmail refresh tokens
    ARTICLE_EMBEDDINGS: KVNamespace; // KV Namespace for caching article embeddings
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
            const classifiedArticles = classifyArticles(articles);
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

                    const educationLogs = await clickLogger.getEducationLogs(sevenDaysAgo, now);
                    const clickLogs = await clickLogger.getClickLogs(sevenDaysAgo, now);
                    const sentLogs = await clickLogger.getSentLogs(sevenDaysAgo, now);


                    const updatedUserProfile = updateCategoryInterestScores(
                        userProfile,
                        educationLogs, // 取得したログデータを渡す
                        clickLogs, // 取得したログデータを渡す
                        sentLogs, // 取得したログデータを渡す
                        classifiedArticles // カテゴリー情報付きの全記事リストを渡す
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
                        const remainingArticlesPool = maxArticlesForEmbedding - (ARTICLE_CATEGORIES.length * minArticlesPerCategory);
                        if (totalInterestScore > 0 && remainingArticlesPool > 0) {
                            const categoryInterestRatio = userProfile.categoryInterestScores[category] / totalInterestScore;
                            const proportionalAllocation = Math.floor(categoryInterestRatio * remainingArticlesPool);
                            articlesToSelectFromCategory += proportionalAllocation;
                        } else if (remainingArticlesPool > 0) {
                            // 合計スコアが0の場合、残りを均等に配分
                            const equalAllocation = Math.floor(remainingArticlesPool / ARTICLE_CATEGORIES.length);
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


					// --- 6. Embedding Generation & Caching ---
					logInfo(`Generating embeddings and checking cache for user ${userId}...`, { userId });

					const articlesWithEmbeddings: NewsArticle[] = []; // NewsArticle型を使用
                    const articlesToEmbed: NewsArticle[] = []; // NewsArticle型を使用
                    const articlesToEmbedTexts: string[] = [];

                    // キャッシュを確認し、キャッシュがない記事をembedding対象とする
                    for (const article of firstSelectedArticles) {
                        const cacheKey = getEmbeddingCacheKey(article.link);
                        const cachedEmbedding = await env.ARTICLE_EMBEDDINGS.get(cacheKey, { type: 'json' });

                        if (cachedEmbedding) {
                            logInfo(`Embedding cache hit for article: "${article.title}"`, { articleTitle: article.title, articleLink: article.link });
                            articlesWithEmbeddings.push({ ...article, embedding: cachedEmbedding as number[] });
                        } else {
                            logInfo(`Embedding cache miss for article: "${article.title}". Adding to embedding queue.`, { articleTitle: article.title, articleLink: article.link });
                            articlesToEmbed.push(article);
                            articlesToEmbedTexts.push(`${article.title} ${article.link}`);
                        }
                    }

                    // キャッシュがない記事に対してバッチでembeddingを生成
                    if (articlesToEmbed.length > 0) {
                        logInfo(`Generating embeddings for ${articlesToEmbed.length} articles...`, { count: articlesToEmbed.length });
                        const embeddings = await getOpenAIEmbeddingsBatch(articlesToEmbedTexts, env);

                        if (embeddings && embeddings.length === articlesToEmbed.length) {
                            for (let i = 0; i < articlesToEmbed.length; i++) {
                                const article = articlesToEmbed[i];
                                const embedding = embeddings[i];
                                if (embedding) {
                                    articlesWithEmbeddings.push({ ...article, embedding });
                                    // Embedding 結果を KV にキャッシュ
                                    const cacheKey = getEmbeddingCacheKey(article.link);
                                    // TODO: KVの容量制限を考慮し、有効期限を設定するなど
                                    // 有効期限を30日（秒単位）に設定
                                    const expirationTtl = 30 * 24 * 60 * 60; // 30 days in seconds
                                    await env.ARTICLE_EMBEDDINGS.put(cacheKey, JSON.stringify(embedding), { expirationTtl });
                                    logInfo(`Cached embedding for article: "${article.title}" with TTL ${expirationTtl}s`, { articleTitle: article.title, articleLink: article.link, expirationTtl });
                                } else {
                                     logWarning(`Embedding generation failed for article: "${article.title}". Skipping.`, { articleTitle: article.title, articleLink: article.link });
                                }
                            }
                             logInfo(`Finished generating and caching embeddings for ${articlesToEmbed.length} articles.`, { count: articlesToEmbed.length });
                        } else {
                            logError(`Embedding generation failed for batch. Expected ${articlesToEmbed.length} embeddings, got ${embeddings?.length}.`, null, { expected: articlesToEmbed.length, received: embeddings?.length });
                        }
                    } else {
                         logInfo('No articles needed embedding generation (all were cached).');
                    }


					logInfo(`Finished embedding generation and caching for user ${userId}. Processed ${articlesWithEmbeddings.length} articles with embeddings.`, { userId, processedCount: articlesWithEmbeddings.length });


					// --- 7. Second Selection (MMR + Bandit) ---
					logInfo(`Starting second selection (MMR + Bandit) for user ${userId}...`, { userId });
					// Durable Object (ClickLogger) のインスタンスを取得
					const clickLoggerId = env.CLICK_LOGGER.idFromName(userId); // ユーザーIDに対応するDO IDを取得
					const clickLogger = env.CLICK_LOGGER.get(clickLoggerId); // DO インスタンスを取得

					// selectPersonalizedArticles 関数に embedding が付与された記事リストを渡す
					// @ts-ignore: Durable Object Stub の型に関するエラーを抑制
					const numberOfArticlesToSend = 5; // Define how many articles to send
					const selectedArticles = await selectPersonalizedArticles(articlesWithEmbeddings, userProfile, clickLogger, numberOfArticlesToSend);
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
						embedding: article.embedding, // embedding も一緒に保存
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


					// --- 10. Trigger Reward Decay in Durable Object ---
					logInfo(`Triggering reward decay in ClickLogger for user ${userId}...`, { userId });
					// In scheduled task, request.url is not defined. Use relative path.
					const decayResponse = await clickLogger.fetch(new Request('http://dummy-host/decay-rewards', {
						method: 'POST',
					}));

					if (decayResponse.ok) {
						logInfo(`Successfully triggered reward decay for user ${userId}.`, { userId });
					} else {
						logError(`Failed to trigger reward decay for user ${userId}: ${decayResponse.statusText}`, null, { userId, status: decayResponse.status, statusText: decayResponse.statusText });
					}


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
            // --- 11. Clean up old embeddings in KV ---
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


		// --- Webhook Handler (for Brevo click events) ---
		if (request.method === 'POST' && path === '/webhook/brevo') {
			logInfo('Brevo webhook received');

			try {
				// Brevo webhook signature verification
				// Brevo の署名ヘッダー名と検証方法に合わせて修正
				const signature = request.headers.get('X-Sib-Webhook-Signature'); // 仮のヘッダー名
				const rawBody = await request.text(); // 検証には生のボディが必要

				if (!signature || !env.BREVO_WEBHOOK_SECRET) {
					logWarning('Missing signature or webhook secret.');
					return new Response('Unauthorized', { status: 401 });
				}

				try {
					const encoder = new TextEncoder();
					const key = await crypto.subtle.importKey(
						'raw',
						encoder.encode(env.BREVO_WEBHOOK_SECRET),
						{ name: 'HMAC', hash: 'SHA-256' },
						false,
						['sign']
					);

					// Brevo の署名検証に使用するデータ形式に合わせて修正
					// ドキュメントによると、検証にはリクエストボディ自体を使用するようです。
					const data = rawBody;
					const signatureBytes = await crypto.subtle.sign(
						'HMAC',
						key,
						encoder.encode(data)
					);

					const expectedSignature = Array.from(new Uint8Array(signatureBytes))
						.map(b => b.toString(16).padStart(2, '0'))
						.join('');

					if (expectedSignature !== signature) {
						logWarning('Webhook signature mismatch.');
						return new Response('Unauthorized', { status: 401 });
					}

					logInfo('Webhook signature verified successfully.');

					// Process events (parse JSON from rawBody after verification)
					const event = JSON.parse(rawBody); // Brevo のペイロードは単一のイベントオブジェクトのようです
					logInfo('Received webhook event:', { event });

					if (event.event === 'clicked') {
						logInfo('Click event received:', { event });
						// Brevo のペイロードから必要な情報を抽出
						const clickedUrl = event.url; // クリックされたURL
						const email = event.email; // クリックしたユーザーのメールアドレス
						const customData = event['X-Mailin-Custom']; // カスタムデータ

						if (clickedUrl && email) {
							try {
								// カスタムデータから userId と articleId を抽出することを想定
								// メール生成時に X-Mailin-Custom ヘッダーに JSON 文字列などで含める必要があるかもしれません。
								// 例: {"userId": "...", "articleId": "..."}
								let userId = null;
								let articleId = null;

								if (customData) {
									try {
										const parsedCustomData = JSON.parse(customData);
										userId = parsedCustomData.userId;
										articleId = parsedCustomData.articleId;
									} catch (e) {
										logError('Error parsing X-Mailin-Custom:', e, { customData });
									}
								}

								if (userId && articleId) {
									logInfo(`Processing click for user ${userId}, article ${articleId}`, { userId, articleId });
									// Get the Durable Object for this user
									const id = env.CLICK_LOGGER.idFromName(userId);
									const obj = env.CLICK_LOGGER.get(id);

									// Send a request to the Durable Object to log the click
									// TODO: Determine the actual reward based on event data if available (e.g., time spent on page via another webhook/pixel)
									// For now, sending a default reward (e.g., 1.0 for a click)
									const reward = 1.0; // Default reward for a click
									const logClickResponse = await obj.fetch(new Request(new URL('/log-click', request.url), {
										method: 'POST',
										headers: { 'Content-Type': 'application/json' },
										body: JSON.stringify({ articleId: articleId, timestamp: event.ts_epoch, embedding: null, reward: reward }), // embedding はDO側で取得する必要があるかも
									}));

									if (logClickResponse.ok) {
										logInfo(`Click logged successfully for user ${userId}, article ${articleId}`, { userId, articleId });
									} else {
										logError(`Failed to log click for user ${userId}, article ${articleId}: ${logClickResponse.statusText}`, null, { userId, articleId, status: logClickResponse.status, statusText: logClickResponse.statusText });
									}

									// TODO: Update user profile in KV with clicked article ID
									// Pass the correct KV binding to userProfile functions
									const userProfile = await getUserProfile(userId, { 'mail-news-user-profiles': env['mail-news-user-profiles'] });
									if (userProfile && !userProfile.clickedArticleIds.includes(articleId)) {
										await updateUserProfile({ ...userProfile, clickedArticleIds: [...userProfile.clickedArticleIds, articleId] }, { 'mail-news-user-profiles': env['mail-news-user-profiles'] });
										logInfo(`Updated user profile for ${userId} with clicked article ${articleId}.`, { userId, articleId });
									}

								} else {
									logWarning('Could not extract userId or articleId from Brevo webhook payload or X-Mailin-Custom.', { event });
									// メールアドレスからユーザーIDを検索して処理を続行することも検討
									// const userProfile = await getUserByEmail(email, { 'mail-news-user-profiles': env['mail-news-user-profiles'] }); // getUserByEmail 関数が必要
									// if (userProfile) { ... }
								}

							} catch (e) {
								logError(`Error processing click event from Brevo webhook:`, e, { event });
							}
						} else {
							logWarning('Missing clickedUrl or email in Brevo webhook payload.', { event });
						}
					}
					// TODO: Handle other event types (e.g., opened, bounced, etc.)

					return new Response('Webhook processed', { status: 200 });

				} catch (error) {
					logError('Error processing webhook signature or event:', error, { requestUrl: request.url });
					return new Response('Error processing webhook', { status: 500 });
				}
			} catch (mainFetchError) {
				logError('Error during fetch handler execution:', mainFetchError, { requestUrl: request.url });
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

				// 記事のタイトル、リンク、サマリーのみを返す（必要に応じて他の情報も追加）
				const simplifiedArticles = articles.map(article => ({
					articleId: article.link, // 記事IDとしてリンクを使用
					title: article.title,
					summary: article.summary,
					// link: article.link, // 必要であれば追加
				}));

				return new Response(JSON.stringify(simplifiedArticles), {
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
				const { userId, selectedArticleIds } = await request.json();

				if (!userId || !Array.isArray(selectedArticleIds)) {
					logWarning('Submit interests failed: Missing userId or selectedArticleIds in request body.');
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

				// 記事リストを再度取得してembeddingを抽出
				const allArticles = await collectNews();
				const selectedArticlesWithEmbeddings = allArticles
					.filter(article => selectedArticleIds.includes(article.link) && article.embedding !== undefined)
					.map(article => ({ articleId: article.link, embedding: article.embedding! }));

				if (selectedArticlesWithEmbeddings.length > 0) {
					// Get the Durable Object for this user
					const clickLoggerId = env.CLICK_LOGGER.idFromName(userId);
					const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

					// Send a request to the Durable Object to learn from selected articles
					// Use a relative path for the Durable Object fetch
					const learnResponse = await clickLogger.fetch(new Request('http://dummy-host/learn-from-education', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ selectedArticles: selectedArticlesWithEmbeddings }),
					}));

					if (learnResponse.ok) {
						logInfo(`Successfully sent selected articles for learning to ClickLogger for user ${userId}.`, { userId, selectedCount: selectedArticlesWithEmbeddings.length });
					} else {
						logError(`Failed to send selected articles for learning to ClickLogger for user ${userId}: ${learnResponse.statusText}`, null, { userId, status: logResponse.status, statusText: logResponse.statusText });
					}
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
		}


		// Handle other requests or return a default response
		return new Response('Not Found', { status: 404 });
	},
};

// Durable Object class definition (must be exported)
export { ClickLogger } from './clickLogger';
