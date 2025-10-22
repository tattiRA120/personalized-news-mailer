import { getUserProfile, createUserProfile } from './userProfile';
import { ClickLogger } from './clickLogger';
import { BatchQueueDO } from './batchQueueDO';
import { initLogger } from './logger';
import { collectNews, NewsArticle } from './newsCollector';
import { generateAndSaveEmbeddings } from './services/embeddingService';
import { saveArticlesToD1, getArticlesFromD1, ArticleWithEmbedding } from './services/d1Service';
import { orchestrateMailDelivery } from './orchestrators/mailOrchestrator';
import { generateNewsEmail, sendNewsEmail } from './emailGenerator';
import { decodeHtmlEntities } from './utils/htmlDecoder';
import { selectDissimilarArticles } from './articleSelector';
// Define the Env interface with bindings from wrangler.jsonc
export interface Env {
	DB: D1Database;
	CLICK_LOGGER: DurableObjectNamespace<ClickLogger>;
    BATCH_QUEUE_DO: DurableObjectNamespace<BatchQueueDO>;
	OPENAI_API_KEY?: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	GOOGLE_REDIRECT_URI: string;
	'mail-news-gmail-tokens': KVNamespace;
    BATCH_CALLBACK_TOKENS: KVNamespace;
    WORKER_BASE_URL?: string;
    DEBUG_API_KEY?: string;
    ASSETS: Fetcher; // ASSETS binding for static assets
    LOG_LEVEL?: string;
    GOOGLE_NEWS_DECODER_API_URL: string;
    DECODER_SECRET: string;
}

interface EmailRecipient {
    email: string;
    name?: string;
}

export default {
	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
        const { logError, logInfo, logWarning, logDebug } = initLogger(env);
		await orchestrateMailDelivery(env, new Date(controller.scheduledTime));
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const { logError, logInfo, logWarning, logDebug } = initLogger(env);
		const url = new URL(request.url);
		const path = url.pathname;

		// --- Static File Server ---
		if (path.startsWith('/public/')) {
			const assetPath = path.replace('/public', '');
			const response = await env.ASSETS.fetch(new Request(new URL(assetPath, request.url)));

			if (response.status === 404) {
				if (assetPath === '/') {
					const indexHtmlResponse = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url)));
					if (indexHtmlResponse.ok) {
						return indexHtmlResponse;
					}
				}
				return new Response('Not Found', { status: 404 });
			}
			return response;
		}

		// --- User Registration Handler ---
		if (request.method === 'POST' && path === '/register') {
			logDebug('Registration request received');
			let requestBody;
			try {
				requestBody = await request.json();
				logDebug('Registration request body:', requestBody);
			} catch (jsonError) {
				logError('Failed to parse registration request body as JSON:', jsonError);
				return new Response('Invalid JSON in request body', { status: 400 });
			}

			try {
				const { email } = requestBody as { email: string };

				if (!email) {
					logWarning('Registration failed: Missing email in request body.');
					return new Response('Missing email', { status: 400 });
				}

				// Basic email format validation
				const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
				if (!emailRegex.test(email)) {
					logWarning(`Registration failed: Invalid email format for ${email}.`, { email });
					return new Response('Invalid email format', { status: 400 });
				}

				const encoder = new TextEncoder();
				const data = encoder.encode(email);
				const hashBuffer = await crypto.subtle.digest('SHA-256', data);
				const userId = Array.from(new Uint8Array(hashBuffer))
					.map(b => b.toString(16).padStart(2, '0'))
					.join('');

				const existingUser = await getUserProfile(userId, env);
				if (existingUser) {
					logWarning(`Registration failed: User with email ${email} already exists.`, { email, userId });
					return new Response('User already exists', { status: 409 });
				}

				await createUserProfile(userId, email, env);
				logDebug(`User registered successfully: ${userId}`, { userId, email });

				if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) {
					logError('Missing Google OAuth environment variables for consent URL generation.', null);
					return new Response('Server configuration error', { status: 500 });
				}

				const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
				authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
				authUrl.searchParams.set('redirect_uri', env.GOOGLE_REDIRECT_URI);
				authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.send');
				authUrl.searchParams.set('access_type', 'offline');
				authUrl.searchParams.set('prompt', 'consent');
				authUrl.searchParams.set('response_type', 'code');
				authUrl.searchParams.set('state', userId);

				logDebug(`Generated OAuth consent URL for user ${userId}`, { userId, authUrl: authUrl.toString() });

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
			logDebug('Click tracking request received');
			const userId = url.searchParams.get('userId');
			const articleId = url.searchParams.get('articleId');
			const encodedRedirectUrl = url.searchParams.get('redirectUrl');

			if (!userId || !articleId || !encodedRedirectUrl) {
				logWarning('Click tracking failed: Missing userId, articleId, or redirectUrl.');
				return new Response('Missing parameters', { status: 400 });
			}

			let redirectUrl: string;
			try {
				// まずURLエンコードをデコードし、次にHTMLエンティティをデコードする
				const decodedUri = decodeURIComponent(encodedRedirectUrl);
				redirectUrl = decodeHtmlEntities(decodedUri);
			} catch (e) {
				logError('Click tracking failed: Invalid redirectUrl encoding or HTML entities.', e, { encodedRedirectUrl });
				return new Response('Invalid redirectUrl encoding or HTML entities', { status: 400 });
			}

			try {
				const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
				const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

				const logClickResponse = await clickLogger.fetch(
                    new Request(`${env.WORKER_BASE_URL}/log-click`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: userId, articleId: articleId, timestamp: Date.now() }),
                    })
                );

				if (logClickResponse.ok) {
					logDebug(`Click logged successfully for user ${userId}, article ${articleId}`, { userId, articleId });
				} else {
					logError(`Failed to log click for user ${userId}, article ${articleId}: ${logClickResponse.statusText}`, null, { userId, articleId, status: logClickResponse.status, statusText: logClickResponse.statusText });
				}

				return Response.redirect(redirectUrl, 302);

			} catch (error) {
				logError('Error during click tracking:', error, { userId, articleId, redirectUrl, requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		// --- Feedback Tracking Handler ---
		if (request.method === 'GET' && path === '/track-feedback') {
			logDebug('Feedback tracking request received');
			const userId = url.searchParams.get('userId');
			const articleId = url.searchParams.get('articleId');
			const feedback = url.searchParams.get('feedback'); // 'interested' or 'not_interested'

			if (!userId || !articleId || !feedback) {
				logWarning('Feedback tracking failed: Missing userId, articleId, or feedback.');
				return new Response('Missing parameters', { status: 400 });
			}

			if (feedback !== 'interested' && feedback !== 'not_interested') {
				logWarning(`Invalid feedback value: ${feedback}`);
				return new Response('Invalid feedback value', { status: 400 });
			}

			try {
				const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
				const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

				const logFeedbackResponse = await clickLogger.fetch(
					new Request(`${env.WORKER_BASE_URL}/log-feedback`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ userId, articleId, feedback, timestamp: Date.now() }),
					})
				);

				if (logFeedbackResponse.ok) {
					logDebug(`Feedback logged successfully for user ${userId}, article ${articleId}, feedback: ${feedback}`, { userId, articleId, feedback });
				} else {
					logError(`Failed to log feedback for user ${userId}, article ${articleId}: ${logFeedbackResponse.statusText}`, null, { userId, articleId, status: logFeedbackResponse.status, statusText: logFeedbackResponse.statusText });
				}

				// ユーザーにフィードバックが記録されたことを伝える簡単なメッセージを返す
				return new Response('フィードバックありがとうございます！', {
					status: 200,
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				});

			} catch (error) {
				logError('Error during feedback tracking:', error, { userId, articleId, feedback, requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		// --- OAuth2 Callback Handler ---
		if (request.method === 'GET' && path === '/oauth2callback') {
			logDebug('OAuth2 callback request received');

			const code = url.searchParams.get('code');
			const userId = url.searchParams.get('state');

			if (!code) {
				logWarning('OAuth2 callback failed: Missing authorization code.');
				return new Response('Missing authorization code', { status: 400 });
			}

			if (!userId) {
				logWarning('OAuth2 callback failed: Missing state parameter (userId).');
				return new Response('Missing state parameter', { status: 400 });
			}

			if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI || !env['mail-news-gmail-tokens']) {
				logError('Missing Google OAuth environment variables or KV binding.', null);
				return new Response('Server configuration error', { status: 500 });
			}

			try {
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
				const refreshToken = tokenData.refresh_token;

				if (!refreshToken) {
					logWarning('No refresh token received. Ensure access_type=offline was requested and this is the first authorization.');
				}

				await env['mail-news-gmail-tokens'].put(`refresh_token:${userId}`, refreshToken);
				logDebug(`Successfully stored refresh token for user ${userId}.`, { userId });

				return new Response('Authorization successful. You can close this window.', { status: 200 });

			} catch (error) {
				logError('Error during OAuth2 callback processing:', error, { userId, requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		// --- Get Articles for Education Handler ---
		if (request.method === 'GET' && path === '/get-articles-for-education') {
			logDebug('Request received for articles for education');
			try {
				const articles: NewsArticle[] = await collectNews(env);
				logDebug(`Collected ${articles.length} articles for education.`, { articleCount: articles.length });

				const articlesForEducation = articles.map((article: NewsArticle) => ({
					articleId: article.articleId,
					title: article.title,
					summary: article.summary,
					link: article.link,
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
			logDebug('Submit interests request received');
			try {
				const { userId, selectedArticles } = await request.json() as { userId: string, selectedArticles: NewsArticle[] };

				if (!userId || !Array.isArray(selectedArticles)) {
					logWarning('Submit interests failed: Missing userId or selectedArticles in request body.');
					return new Response('Missing parameters', { status: 400 });
				}

				const userProfile = await getUserProfile(userId, env);

				if (!userProfile) {
					logWarning(`Submit interests failed: User profile not found for ${userId}.`, { userId });
					return new Response(JSON.stringify({ message: 'User not found' }), {
						status: 404,
						headers: { 'Content-Type': 'application/json' },
					});
				}

				logDebug(`User education articles received for user ${userId}.`, { userId, selectedArticleCount: selectedArticles.length });

				const articlesNeedingEmbedding: NewsArticle[] = [];
				const selectedArticlesWithEmbeddings: { articleId: string; embedding: number[]; }[] = [];

				// 1. 選択された記事の中から、既にD1に存在しembeddingを持っている記事を先に問い合わせる
				const articleIds = selectedArticles.map(article => article.articleId);
				const existingArticlesWithEmbeddingsInD1: ArticleWithEmbedding[] = await getArticlesFromD1(env, articleIds.length, 0, `article_id IN (${articleIds.map(() => '?').join(',')}) AND embedding IS NOT NULL`, articleIds);
				const existingArticleIdsWithEmbeddingsSet = new Set(existingArticlesWithEmbeddingsInD1.map(article => article.articleId));

				// 2. 新しい記事だけをD1に保存（重複はINSERT OR IGNOREでスキップされる）
				await saveArticlesToD1(selectedArticles, env);
				logDebug(`Selected articles saved to D1 for user ${userId}.`, { userId, savedArticleCount: selectedArticles.length });

				// 3. embeddingがないと判明した記事と、新たに追加した記事を対象に、embedding生成処理を開始する
				for (const selectedArticle of selectedArticles) {
					if (existingArticleIdsWithEmbeddingsSet.has(selectedArticle.articleId)) {
						// 既にembeddingが存在する記事
						const existingArticle = existingArticlesWithEmbeddingsInD1.find(a => a.articleId === selectedArticle.articleId);
						if (existingArticle && existingArticle.embedding) {
							selectedArticlesWithEmbeddings.push({ articleId: existingArticle.articleId, embedding: existingArticle.embedding });
						} else {
							// ここに到達することはないはずだが、念のためログ
							logWarning(`Article "${selectedArticle.title}" (ID: ${selectedArticle.articleId}) was expected to have embedding but not found.`, { articleId: selectedArticle.articleId, articleTitle: selectedArticle.title });
							articlesNeedingEmbedding.push(selectedArticle);
						}
					} else {
						// embeddingがまだ存在しない記事（新規保存されたか、以前から存在したがembeddingがなかった記事）
						articlesNeedingEmbedding.push(selectedArticle);
					}
				}

				if (articlesNeedingEmbedding.length > 0) {
					logDebug(`Generating embeddings for ${articlesNeedingEmbedding.length} articles. This will be processed asynchronously.`, { count: articlesNeedingEmbedding.length });
					await generateAndSaveEmbeddings(articlesNeedingEmbedding, env, userId, false);
				} else {
					logDebug(`No new embeddings needed for selected articles for user ${userId}.`, { userId });
				}

				// 4. 既に埋め込みがある記事のみでバンディットモデルを更新
				if (selectedArticlesWithEmbeddings.length > 0) {
					const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
					const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

					const batchSize = 10;
					logDebug(`Sending selected articles with existing embeddings for learning to ClickLogger in batches of ${batchSize} for user ${userId}.`, { userId, totalCount: selectedArticlesWithEmbeddings.length, batchSize });

					for (let i = 0; i < selectedArticlesWithEmbeddings.length; i += batchSize) {
						const batch = selectedArticlesWithEmbeddings.slice(i, i + batchSize);
						logDebug(`Sending batch ${Math.floor(i / batchSize) + 1} with ${batch.length} articles for user ${userId}.`, { userId, batchNumber: Math.floor(i / batchSize) + 1, batchCount: batch.length });

						const learnResponse = await clickLogger.fetch(
                            new Request(`${env.WORKER_BASE_URL}/learn-from-education`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ userId: userId, selectedArticles: batch }),
                            })
                        );

						if (learnResponse.ok) {
							logDebug(`Successfully sent batch ${Math.floor(i / batchSize) + 1} for learning to ClickLogger for user ${userId}.`, { userId, batchNumber: Math.floor(i / batchSize) + 1 });
						} else {
							logError(`Failed to send batch ${Math.floor(i / batchSize) + 1} for learning to ClickLogger for user ${userId}: ${learnResponse.statusText}`, null, { userId, batchNumber: Math.floor(i / batchSize) + 1, status: learnResponse.status, statusText: learnResponse.statusText });
						}
					}
					logDebug(`Finished sending all batches for learning to ClickLogger for user ${userId}.`, { userId, totalCount: selectedArticlesWithEmbeddings.length });
				} else {
					logWarning(`No selected articles with existing embeddings to send for learning for user ${userId}.`, { userId });
				}

				return new Response(JSON.stringify({ message: '興味関心の更新が開始されました。埋め込み生成が必要な記事は非同期で処理されます。' }), {
					headers: { 'Content-Type': 'application/json' },
					status: 200,
				});

			} catch (error) {
				logError('Error submitting interests:', error, { requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		} else if (request.method === 'POST' && path === '/delete-all-durable-object-data') {
			logDebug('Request received to delete all Durable Object data');
			try {
				const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
				const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

				const deleteResponse = await clickLogger.fetch(
                    new Request(new URL('/delete-all-data', request.url), {
                        method: 'POST',
                    })
                );

				if (deleteResponse.ok) {
					logDebug('Successfully triggered deletion of all bandit models.');
					return new Response('Triggered deletion of all bandit models.', { status: 200 });
				} else {
					logError(`Failed to trigger deletion of all bandit models: ${deleteResponse.statusText}`, null, { status: deleteResponse.status, statusText: deleteResponse.statusText });
					return new Response('Failed to trigger deletion.', { status: 500 });
				}

			} catch (error) {
				logError('Error during deletion of all Durable Object data:', error, { requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		} else if (request.method === 'POST' && path === '/debug/force-embed-articles') {
            logDebug('Debug: Force embed articles request received');
            const debugApiKey = request.headers.get('X-Debug-Key');
            if (debugApiKey !== env.DEBUG_API_KEY) {
                logWarning('Debug: Unauthorized access attempt to /debug/force-embed-articles', { providedKey: debugApiKey });
                return new Response('Unauthorized', { status: 401 });
            }

            try {
                logDebug('Debug: Starting news collection for force embedding...');
                const articles: NewsArticle[] = await collectNews(env);
                logDebug(`Debug: Collected ${articles.length} articles for force embedding.`, { articleCount: articles.length });

                if (articles.length === 0) {
                    logDebug('Debug: No articles collected for force embedding. Skipping further steps.');
                    return new Response('No articles collected', { status: 200 });
                }

                const articlesToSaveToD1: NewsArticle[] = articles.map(article => ({
                    articleId: article.articleId,
                    title: article.title,
                    link: article.link,
                    sourceName: article.sourceName,
                    summary: article.summary,
                    content: article.content,
                    publishedAt: article.publishedAt || Date.now(),
                }));
                await saveArticlesToD1(articlesToSaveToD1, env);
                logDebug(`Debug: Saved ${articlesToSaveToD1.length} articles to D1 temporarily for force embedding.`, { count: articlesToSaveToD1.length });

                // debug/force-embed-articles では特定のユーザーIDがないため、ダミーのユーザーIDを渡すか、
                // generateAndSaveEmbeddings の userId パラメータをオプショナルにするか、
                // あるいはこのデバッグエンドポイントのロジックを調整する必要がある。
                // ここでは、デバッグ目的のため、仮のユーザーID 'debug-user' を渡す。
                await generateAndSaveEmbeddings(articles, env, 'debug-user', true);

                return new Response(JSON.stringify({ message: 'Batch embedding job initiated successfully (debug mode).' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            } catch (error) {
                logError('Debug: Error during force embedding process:', error, { requestUrl: request.url });
                return new Response('Internal Server Error during force embedding', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/debug/delete-user-data') {
            logDebug('Debug: Delete user data request received');
            const debugApiKey = request.headers.get('X-Debug-Key');
            if (debugApiKey !== env.DEBUG_API_KEY) {
                logWarning('Debug: Unauthorized access attempt to /debug/delete-user-data', { providedKey: debugApiKey });
                return new Response('Unauthorized', { status: 401 });
            }

            try {
                const { userId } = await request.json() as { userId: string };
                if (!userId) {
                    logWarning('Debug: Delete user data failed: Missing userId in request body.');
                    return new Response('Missing userId', { status: 400 });
                }

                logDebug(`Debug: Deleting user data for user ${userId} from DB...`, { userId });

                await env.DB.prepare(`DELETE FROM users WHERE user_id = ?`).bind(userId).run();
                logDebug(`Debug: Deleted user profile for ${userId}.`, { userId });

                await env.DB.prepare(`DELETE FROM click_logs WHERE user_id = ?`).bind(userId).run();
                logDebug(`Debug: Deleted click logs for ${userId}.`, { userId });

                await env.DB.prepare(`DELETE FROM sent_articles WHERE user_id = ?`).bind(userId).run();
                logDebug(`Debug: Deleted sent articles for ${userId}.`, { userId });

                await env.DB.prepare(`DELETE FROM education_logs WHERE user_id = ?`).bind(userId).run();
                logDebug(`Debug: Deleted education logs for ${userId}.`, { userId });

                await env['mail-news-gmail-tokens'].delete(`refresh_token:${userId}`);
                logDebug(`Debug: Deleted Gmail refresh token for ${userId}.`, { userId });

                logDebug(`Debug: Successfully deleted all data for user ${userId}.`, { userId });
                return new Response(JSON.stringify({ message: `User data for ${userId} deleted successfully.` }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });

            } catch (error) {
                logError('Debug: Error during user data deletion:', error, { requestUrl: request.url });
                return new Response('Internal Server Error during user data deletion', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/debug/trigger-batch-alarm') {
            logDebug('Debug: Trigger BatchQueueDO alarm request received');
            const debugApiKey = request.headers.get('X-Debug-Key');
            if (debugApiKey !== env.DEBUG_API_KEY) {
                logWarning('Debug: Unauthorized access attempt to /debug/trigger-batch-alarm', { providedKey: debugApiKey });
                return new Response('Unauthorized', { status: 401 });
            }
            try {
                const batchQueueDOId = env.BATCH_QUEUE_DO.idFromName("batch-embedding-queue");
                const batchQueueDOStub = env.BATCH_QUEUE_DO.get(batchQueueDOId);
                const doResponse = await batchQueueDOStub.fetch(
                    new Request(`${env.WORKER_BASE_URL}/debug/trigger-alarm`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                    })
                );
                if (doResponse.ok) {
                    logDebug('Debug: Successfully triggered BatchQueueDO alarm.');
                    return new Response('BatchQueueDO alarm triggered successfully.', { status: 200 });
                } else {
                    logError(`Debug: Failed to trigger BatchQueueDO alarm: ${doResponse.statusText}`, null, { status: doResponse.status, statusText: doResponse.statusText });
                    return new Response(`Failed to trigger BatchQueueDO alarm: ${doResponse.statusText}`, { status: doResponse.status });
                }
            } catch (error) {
                logError('Debug: Error triggering BatchQueueDO alarm:', error, { requestUrl: request.url });
                return new Response('Internal Server Error during BatchQueueDO alarm trigger', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/debug/send-test-email') {
            logDebug('Debug: Send test email request received');
            const debugApiKey = request.headers.get('X-Debug-Key');
            if (debugApiKey !== env.DEBUG_API_KEY) {
                logWarning('Debug: Unauthorized access attempt to /debug/send-test-email', { providedKey: debugApiKey });
                return new Response('Unauthorized', { status: 401 });
            }
            try {
                // orchestrateMailDelivery は scheduled と同じ引数を取る
                // テスト目的のため、現在時刻を渡し、isTestRun フラグを true に設定する
                await orchestrateMailDelivery(env, new Date(), true);
                logDebug('Debug: Test email delivery orchestrated successfully.');
                return new Response(JSON.stringify({ message: 'Test email delivery orchestrated successfully.' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            } catch (error) {
                logError('Debug: Error during test email delivery:', error, { requestUrl: request.url });
				return new Response('Internal Server Error during test email delivery', { status: 500 });
			}
        } else if (request.method === 'POST' && path === '/debug/generate-oauth-url') {
            logDebug('Debug: Generate OAuth URL request received');
            const debugApiKey = request.headers.get('X-Debug-Key');
            if (debugApiKey !== env.DEBUG_API_KEY) {
                logWarning('Debug: Unauthorized access attempt to /debug/generate-oauth-url', { providedKey: debugApiKey });
                return new Response('Unauthorized', { status: 401 });
            }
            try {
                const { email } = await request.json() as { email: string };
                if (!email) {
                    logWarning('Debug: Generate OAuth URL failed: Missing email in request body.');
                    return new Response('Missing email', { status: 400 });
                }

                const encoder = new TextEncoder();
                const data = encoder.encode(email);
                const hashBuffer = await crypto.subtle.digest('SHA-256', data);
                const userId = Array.from(new Uint8Array(hashBuffer))
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');

                if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) {
                    logError('Missing Google OAuth environment variables for consent URL generation.', null);
                    return new Response('Server configuration error', { status: 500 });
                }

                const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
                authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
                authUrl.searchParams.set('redirect_uri', env.GOOGLE_REDIRECT_URI);
                authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.send');
                authUrl.searchParams.set('access_type', 'offline');
                authUrl.searchParams.set('prompt', 'consent');
                authUrl.searchParams.set('response_type', 'code');
                authUrl.searchParams.set('state', userId);

                logDebug(`Debug: Generated OAuth consent URL for user ${userId}`, { userId, authUrl: authUrl.toString() });

                return new Response(JSON.stringify({ message: 'OAuth consent URL generated.', authUrl: authUrl.toString() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });

            } catch (error) {
                logError('Debug: Error during OAuth URL generation:', error, { requestUrl: request.url });
                return new Response('Internal Server Error during OAuth URL generation', { status: 500 });
            }
        } else if (request.method === 'GET' && path === '/get-dissimilar-articles') {
            logDebug('Request received for dissimilar articles for education program');
            try {
                // D1からembeddingを持つすべての記事を取得
                const allArticlesWithEmbeddings = await getArticlesFromD1(env, 1000, 0, 'embedding IS NOT NULL');
                logDebug(`Found ${allArticlesWithEmbeddings.length} articles with embeddings in D1.`, { count: allArticlesWithEmbeddings.length });

                // 類似度の低い記事を20件選択
                const dissimilarArticles = await selectDissimilarArticles(allArticlesWithEmbeddings, 20, env);
                logDebug(`Selected ${dissimilarArticles.length} dissimilar articles.`, { count: dissimilarArticles.length });

                // フロントエンドに返すために必要な情報のみを抽出
                const articlesForResponse = dissimilarArticles.map((article: NewsArticle) => ({ // NewsArticle 型を明示的に指定
                    articleId: article.articleId,
                    title: article.title,
                    summary: article.summary,
                    link: article.link,
                    sourceName: article.sourceName,
                }));

                return new Response(JSON.stringify(articlesForResponse), {
                    headers: { 'Content-Type': 'application/json' },
                    status: 200,
                });

            } catch (error) {
                logError('Error fetching dissimilar articles:', error, { requestUrl: request.url });
                return new Response('Error fetching dissimilar articles', { status: 500 });
            }
        }


		// Handle other requests or return a default response
		return new Response('Not Found', { status: 404 });
	},
};

// Durable Object class definition (must be exported)
export { ClickLogger } from './clickLogger';
export { BatchQueueDO } from './batchQueueDO';
