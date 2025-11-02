import { getUserProfile, createUserProfile, updateMMRLambda } from './userProfile';
import { ClickLogger } from './clickLogger';
import { BatchQueueDO } from './batchQueueDO';
import { WasmDO } from './wasmDO';
import { Logger } from './logger';
import { collectNews, NewsArticle } from './newsCollector';
import { generateAndSaveEmbeddings } from './services/embeddingService';
import { saveArticlesToD1, getArticlesFromD1, ArticleWithEmbedding, getUserCTR } from './services/d1Service';
import { orchestrateMailDelivery } from './orchestrators/mailOrchestrator';
import { generateNewsEmail, sendNewsEmail } from './emailGenerator';
import { decodeHtmlEntities } from './utils/htmlDecoder';
import { selectDissimilarArticles, selectPersonalizedArticles } from './articleSelector';
import { OPENAI_EMBEDDING_DIMENSION } from './config';
// Define the Env interface with bindings from wrangler.jsonc
export interface Env {
	DB: D1Database;
	CLICK_LOGGER: DurableObjectNamespace<ClickLogger>;
    BATCH_QUEUE_DO: DurableObjectNamespace<BatchQueueDO>;
    WASM_DO: DurableObjectNamespace<WasmDO>;
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
        const logger = new Logger(env);
		await orchestrateMailDelivery(env, new Date(controller.scheduledTime));
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const logger = new Logger(env);
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
			logger.debug('Registration request received');
			let requestBody;
			try {
				requestBody = await request.json();
				logger.debug('Registration request body:', requestBody);
			} catch (jsonError) {
				logger.error('Failed to parse registration request body as JSON:', jsonError);
				return new Response('Invalid JSON in request body', { status: 400 });
			}

			try {
				const { email } = requestBody as { email: string };

				if (!email) {
					logger.warn('Registration failed: Missing email in request body.');
					return new Response('Missing email', { status: 400 });
				}

				// Basic email format validation
				const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
				if (!emailRegex.test(email)) {
					logger.warn(`Registration failed: Invalid email format for ${email}.`, { email });
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
					logger.warn(`Registration failed: User with email ${email} already exists.`, { email, userId });
					return new Response('User already exists', { status: 409 });
				}

				await createUserProfile(userId, email, env);
				logger.debug(`User registered successfully: ${userId}`, { userId, email });

				if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) {
					logger.error('Missing Google OAuth environment variables for consent URL generation.', null);
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

				logger.debug(`Generated OAuth consent URL for user ${userId}`, { userId, authUrl: authUrl.toString() });

				return new Response(JSON.stringify({ message: 'User registered. Please authorize Gmail access.', authUrl: authUrl.toString() }), {
					status: 201,
					headers: { 'Content-Type': 'application/json' },
				});

			} catch (error) {
				logger.error('Error during user registration:', error, { requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		// --- Click Tracking Handler ---
		if (request.method === 'GET' && path === '/track-click') {
			logger.debug('Click tracking request received');
			const userId = url.searchParams.get('userId');
			const articleId = url.searchParams.get('articleId');
			const encodedRedirectUrl = url.searchParams.get('redirectUrl');

			if (!userId || !articleId || !encodedRedirectUrl) {
				logger.warn('Click tracking failed: Missing userId, articleId, or redirectUrl.');
				return new Response('Missing parameters', { status: 400 });
			}

			let redirectUrl: string;
			try {
				// まずURLエンコードをデコードし、次にHTMLエンティティをデコードする
				const decodedUri = decodeURIComponent(encodedRedirectUrl);
				redirectUrl = decodeHtmlEntities(decodedUri);
			} catch (e) {
				logger.error('Click tracking failed: Invalid redirectUrl encoding or HTML entities.', e, { encodedRedirectUrl });
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
					logger.debug(`Click logged successfully for user ${userId}, article ${articleId}`, { userId, articleId });
				} else {
					logger.error(`Failed to log click for user ${userId}, article ${articleId}: ${logClickResponse.statusText}`, null, { userId, articleId, status: logClickResponse.status, statusText: logClickResponse.statusText });
				}

				return Response.redirect(redirectUrl, 302);

			} catch (error) {
				logger.error('Error during click tracking:', error, { userId, articleId, redirectUrl, requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		// --- Feedback Tracking Handler ---
		if (request.method === 'GET' && path === '/track-feedback') {
			logger.debug('Feedback tracking request received');
			const userId = url.searchParams.get('userId');
			const articleId = url.searchParams.get('articleId');
			const feedback = url.searchParams.get('feedback'); // 'interested' or 'not_interested'

			if (!userId || !articleId || !feedback) {
				logger.warn('Feedback tracking failed: Missing userId, articleId, or feedback.');
				return new Response('Missing parameters', { status: 400 });
			}

			if (feedback !== 'interested' && feedback !== 'not_interested') {
				logger.warn(`Invalid feedback value: ${feedback}`);
				return new Response('Invalid feedback value', { status: 400 });
			}

			try {
				const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
				const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

				const logFeedbackResponse = await clickLogger.fetch(
					new Request(`${env.WORKER_BASE_URL}/log-feedback`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ userId, articleId, feedback, timestamp: Date.now(), immediateUpdate: false }),
					})
				);

				if (logFeedbackResponse.ok) {
					logger.debug(`Feedback logged successfully for user ${userId}, article ${articleId}, feedback: ${feedback}`, { userId, articleId, feedback });
				} else {
					logger.error(`Failed to log feedback for user ${userId}, article ${articleId}: ${logFeedbackResponse.statusText}`, null, { userId, articleId, status: logFeedbackResponse.status, statusText: logFeedbackResponse.statusText });
				}

				// ユーザーにフィードバックが記録されたことを伝える簡単なメッセージを返す
				return new Response('フィードバックありがとうございます！', {
					status: 200,
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				});

			} catch (error) {
				logger.error('Error during feedback tracking:', error, { userId, articleId, feedback, requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		// --- OAuth2 Callback Handler ---
		if (request.method === 'GET' && path === '/oauth2callback') {
			logger.debug('OAuth2 callback request received');

			const code = url.searchParams.get('code');
			const userId = url.searchParams.get('state');

			if (!code) {
				logger.warn('OAuth2 callback failed: Missing authorization code.');
				return new Response('Missing authorization code', { status: 400 });
			}

			if (!userId) {
				logger.warn('OAuth2 callback failed: Missing state parameter (userId).');
				return new Response('Missing state parameter', { status: 400 });
			}

			if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI || !env['mail-news-gmail-tokens']) {
				logger.error('Missing Google OAuth environment variables or KV binding.', null);
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
					logger.error(`Failed to exchange authorization code for tokens: ${tokenResponse.statusText}`, null, { status: tokenResponse.status, statusText: tokenResponse.statusText, errorText });
					return new Response(`Error exchanging code: ${tokenResponse.statusText}`, { status: tokenResponse.status });
				}

				const tokenData: any = await tokenResponse.json();
				const refreshToken = tokenData.refresh_token;

				if (!refreshToken) {
					logger.warn('No refresh token received. Ensure access_type=offline was requested and this is the first authorization.');
				}

				await env['mail-news-gmail-tokens'].put(`refresh_token:${userId}`, refreshToken);
				logger.debug(`Successfully stored refresh token for user ${userId}.`, { userId });

				return new Response('Authorization successful. You can close this window.', { status: 200 });

			} catch (error) {
				logger.error('Error during OAuth2 callback processing:', error, { userId, requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		// --- Get Articles for Education Handler ---
		if (request.method === 'GET' && path === '/get-articles-for-education') {
			logger.debug('Request received for articles for education');
			try {
				const articles: NewsArticle[] = await collectNews(env);
				logger.debug(`Collected ${articles.length} articles for education.`, { articleCount: articles.length });

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
				logger.error('Error fetching articles for education:', error, { requestUrl: request.url });
				return new Response('Error fetching articles', { status: 500 });
			}
		}

		// --- Submit Interests Handler (for public/script.js - existing functionality) ---
		if (request.method === 'POST' && path === '/submit-interests') {
			logger.debug('Submit interests request received from public/script.js');
			try {
				const { userId, selectedArticles } = await request.json() as { userId: string, selectedArticles: NewsArticle[] };

				if (!userId || !Array.isArray(selectedArticles)) {
					logger.warn('Submit interests failed: Missing userId or selectedArticles in request body.');
					return new Response('Missing parameters', { status: 400 });
				}

				const userProfile = await getUserProfile(userId, env);

				if (!userProfile) {
					logger.warn(`Submit interests failed: User profile not found for ${userId}.`, { userId });
					return new Response(JSON.stringify({ message: 'User not found' }), {
						status: 404,
						headers: { 'Content-Type': 'application/json' },
					});
				}

				logger.debug(`User selected articles received for user ${userId} from public/script.js.`, { userId, selectedArticleCount: selectedArticles.length });

				const articlesNeedingEmbedding: NewsArticle[] = [];
				const selectedArticlesWithEmbeddings: { articleId: string; embedding: number[]; }[] = [];

				// 1. 選択された記事の中から、既にD1に存在しembeddingを持っている記事を先に問い合わせる
				const articleIds = selectedArticles.map(article => article.articleId);
				const existingArticlesWithEmbeddingsInD1: ArticleWithEmbedding[] = await getArticlesFromD1(env, articleIds.length, 0, `article_id IN (${articleIds.map(() => '?').join(',')}) AND embedding IS NOT NULL`, articleIds);
				const existingArticleIdsWithEmbeddingsSet = new Set(existingArticlesWithEmbeddingsInD1.map(article => article.articleId));

				// 2. 新しい記事だけをD1に保存（重複はINSERT OR IGNOREでスキップされる）
				await saveArticlesToD1(selectedArticles, env);
				logger.debug(`Selected articles saved to D1 for user ${userId}.`, { userId, savedArticleCount: selectedArticles.length });

				// 3. embeddingがないと判明した記事と、新たに追加した記事を対象に、embedding生成処理を開始する
				for (const selectedArticle of selectedArticles) {
					if (existingArticleIdsWithEmbeddingsSet.has(selectedArticle.articleId)) {
						// 既にembeddingが存在する記事
						const existingArticle = existingArticlesWithEmbeddingsInD1.find(a => a.articleId === selectedArticle.articleId);
						if (existingArticle && existingArticle.embedding) {
							selectedArticlesWithEmbeddings.push({ articleId: existingArticle.articleId, embedding: existingArticle.embedding });
						} else {
							// ここに到達することはないはずだが、念のためログ
							logger.warn(`Article "${selectedArticle.title}" (ID: ${selectedArticle.articleId}) was expected to have embedding but not found.`, { articleId: selectedArticle.articleId, articleTitle: selectedArticle.title });
							articlesNeedingEmbedding.push(selectedArticle);
						}
					} else {
						// embeddingがまだ存在しない記事（新規保存されたか、以前から存在したがembeddingがなかった記事）
						articlesNeedingEmbedding.push(selectedArticle);
					}
				}

				if (articlesNeedingEmbedding.length > 0) {
					logger.debug(`Generating embeddings for ${articlesNeedingEmbedding.length} articles. This will be processed asynchronously.`, { count: articlesNeedingEmbedding.length });
					await generateAndSaveEmbeddings(articlesNeedingEmbedding, env, userId, false);
				} else {
					logger.debug(`No new embeddings needed for selected articles for user ${userId}.`, { userId });
				}

				// 4. 既に埋め込みがある記事のみでバンディットモデルを更新
				if (selectedArticlesWithEmbeddings.length > 0) {
					const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
					const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

					const batchSize = 10;
					logger.debug(`Sending selected articles with existing embeddings for learning to ClickLogger in batches of ${batchSize} for user ${userId}.`, { userId, totalCount: selectedArticlesWithEmbeddings.length, batchSize });

					for (let i = 0; i < selectedArticlesWithEmbeddings.length; i += batchSize) {
						const batch = selectedArticlesWithEmbeddings.slice(i, i + batchSize);
						logger.debug(`Sending batch ${Math.floor(i / batchSize) + 1} with ${batch.length} articles for user ${userId}.`, { userId, batchNumber: Math.floor(i / batchSize) + 1, batchCount: batch.length });

						const learnResponse = await clickLogger.fetch(
                            new Request(`${env.WORKER_BASE_URL}/learn-from-education`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    userId: userId,
                                    selectedArticles: batch.map(article => ({
                                        articleId: article.articleId,
                                        embedding: article.embedding!,
                                        reward: 1.0, // public/script.js からは常に興味ありとして報酬1.0
                                    })),
                                }),
                            })
                        );

						if (learnResponse.ok) {
							logger.debug(`Successfully sent batch ${Math.floor(i / batchSize) + 1} for learning to ClickLogger for user ${userId}.`, { userId, batchNumber: Math.floor(i / batchSize) + 1 });
						} else {
							logger.error(`Failed to send batch ${Math.floor(i / batchSize) + 1} for learning to ClickLogger for user ${userId}: ${learnResponse.statusText}`, null, { userId, batchNumber: Math.floor(i / batchSize) + 1, status: learnResponse.status, statusText: learnResponse.statusText });
						}
					}
					logger.debug(`Finished sending all batches for learning to ClickLogger for user ${userId}.`, { userId, totalCount: selectedArticlesWithEmbeddings.length });
				} else {
					logger.warn(`No selected articles with existing embeddings to send for learning for user ${userId}.`, { userId });
				}

				return new Response(JSON.stringify({ message: '興味関心の更新が開始されました。埋め込み生成が必要な記事は非同期で処理されます。' }), {
					headers: { 'Content-Type': 'application/json' },
					status: 200,
				});

			} catch (error) {
				logger.error('Error submitting interests:', error, { requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		// --- Submit Education Interests Handler (DELETED - now uses /track-feedback) ---
		// This endpoint has been removed as public/education.js now directly calls /track-feedback.
		// The logic for fetching embeddings and updating the bandit model is now handled within ClickLogger's /log-feedback.
		if (request.method === 'POST' && path === '/delete-all-durable-object-data') {
			logger.debug('Request received to delete all Durable Object data');
			try {
				const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
				const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

				const deleteResponse = await clickLogger.fetch(
                    new Request(new URL('/delete-all-data', request.url), {
                        method: 'POST',
                    })
                );

				if (deleteResponse.ok) {
					logger.debug('Successfully triggered deletion of all bandit models.');
					return new Response('Triggered deletion of all bandit models.', { status: 200 });
				} else {
					logger.error(`Failed to trigger deletion of all bandit models: ${deleteResponse.statusText}`, null, { status: deleteResponse.status, statusText: deleteResponse.statusText });
					return new Response('Failed to trigger deletion.', { status: 500 });
				}

			} catch (error) {
				logger.error('Error during deletion of all Durable Object data:', error, { requestUrl: request.url });
				return new Response('Internal Server Error', { status: 500 });
			}
		} else if (request.method === 'POST' && path === '/debug/force-embed-articles') {
            logger.debug('Debug: Force embed articles request received');
            const debugApiKey = request.headers.get('X-Debug-Key');
            if (debugApiKey !== env.DEBUG_API_KEY) {
                logger.warn('Debug: Unauthorized access attempt to /debug/force-embed-articles', { providedKey: debugApiKey });
                return new Response('Unauthorized', { status: 401 });
            }

            try {
                logger.debug('Debug: Starting news collection for force embedding...');
                const articles: NewsArticle[] = await collectNews(env);
                logger.debug(`Debug: Collected ${articles.length} articles for force embedding.`, { articleCount: articles.length });

                if (articles.length === 0) {
                    logger.debug('Debug: No articles collected for force embedding. Skipping further steps.');
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
                logger.debug(`Debug: Saved ${articlesToSaveToD1.length} articles to D1 temporarily for force embedding.`, { count: articlesToSaveToD1.length });

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
                logger.error('Debug: Error during force embedding process:', error, { requestUrl: request.url });
                return new Response('Internal Server Error during force embedding', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/debug/delete-user-data') {
            logger.debug('Debug: Delete user data request received');
            const debugApiKey = request.headers.get('X-Debug-Key');
            if (debugApiKey !== env.DEBUG_API_KEY) {
                logger.warn('Debug: Unauthorized access attempt to /debug/delete-user-data', { providedKey: debugApiKey });
                return new Response('Unauthorized', { status: 401 });
            }

            try {
                const { userId } = await request.json() as { userId: string };
                if (!userId) {
                    logger.warn('Debug: Delete user data failed: Missing userId in request body.');
                    return new Response('Missing userId', { status: 400 });
                }

                logger.debug(`Debug: Deleting user data for user ${userId} from DB...`, { userId });

                await env.DB.prepare(`DELETE FROM users WHERE user_id = ?`).bind(userId).run();
                logger.debug(`Debug: Deleted user profile for ${userId}.`, { userId });

                await env.DB.prepare(`DELETE FROM click_logs WHERE user_id = ?`).bind(userId).run();
                logger.debug(`Debug: Deleted click logs for ${userId}.`, { userId });

                await env.DB.prepare(`DELETE FROM sent_articles WHERE user_id = ?`).bind(userId).run();
                logger.debug(`Debug: Deleted sent articles for ${userId}.`, { userId });

                await env.DB.prepare(`DELETE FROM education_logs WHERE user_id = ?`).bind(userId).run();
                logger.debug(`Debug: Deleted education logs for ${userId}.`, { userId });

                await env['mail-news-gmail-tokens'].delete(`refresh_token:${userId}`);
                logger.debug(`Debug: Deleted Gmail refresh token for ${userId}.`, { userId });

                logger.debug(`Debug: Successfully deleted all data for user ${userId}.`, { userId });
                return new Response(JSON.stringify({ message: `User data for ${userId} deleted successfully.` }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });

            } catch (error) {
                logger.error('Debug: Error during user data deletion:', error, { requestUrl: request.url });
                return new Response('Internal Server Error during user data deletion', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/debug/trigger-batch-alarm') {
            logger.debug('Debug: Trigger BatchQueueDO alarm request received');
            const debugApiKey = request.headers.get('X-Debug-Key');
            if (debugApiKey !== env.DEBUG_API_KEY) {
                logger.warn('Debug: Unauthorized access attempt to /debug/trigger-batch-alarm', { providedKey: debugApiKey });
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
                    logger.debug('Debug: Successfully triggered BatchQueueDO alarm.');
                    return new Response('BatchQueueDO alarm triggered successfully.', { status: 200 });
                } else {
                    logger.error(`Debug: Failed to trigger BatchQueueDO alarm: ${doResponse.statusText}`, null, { status: doResponse.status, statusText: doResponse.statusText });
                    return new Response(`Failed to trigger BatchQueueDO alarm: ${doResponse.statusText}`, { status: doResponse.status });
                }
            } catch (error) {
                logger.error('Debug: Error triggering BatchQueueDO alarm:', error, { requestUrl: request.url });
                return new Response('Internal Server Error during BatchQueueDO alarm trigger', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/debug/send-test-email') {
            logger.debug('Debug: Send test email request received');
            const debugApiKey = request.headers.get('X-Debug-Key');
            if (debugApiKey !== env.DEBUG_API_KEY) {
                logger.warn('Debug: Unauthorized access attempt to /debug/send-test-email', { providedKey: debugApiKey });
                return new Response('Unauthorized', { status: 401 });
            }
            try {
                // orchestrateMailDelivery は scheduled と同じ引数を取る
                // テスト目的のため、現在時刻を渡し、isTestRun フラグを true に設定する
                await orchestrateMailDelivery(env, new Date(), true);
                logger.debug('Debug: Test email delivery orchestrated successfully.');
                return new Response(JSON.stringify({ message: 'Test email delivery orchestrated successfully.' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            } catch (error) {
                logger.error('Debug: Error during test email delivery:', error, { requestUrl: request.url });
				return new Response('Internal Server Error during test email delivery', { status: 500 });
			}
        } else if (request.method === 'POST' && path === '/debug/generate-oauth-url') {
            logger.debug('Debug: Generate OAuth URL request received');
            const debugApiKey = request.headers.get('X-Debug-Key');
            if (debugApiKey !== env.DEBUG_API_KEY) {
                logger.warn('Debug: Unauthorized access attempt to /debug/generate-oauth-url', { providedKey: debugApiKey });
                return new Response('Unauthorized', { status: 401 });
            }
            try {
                const { email } = await request.json() as { email: string };
                if (!email) {
                    logger.warn('Debug: Generate OAuth URL failed: Missing email in request body.');
                    return new Response('Missing email', { status: 400 });
                }

                const encoder = new TextEncoder();
                const data = encoder.encode(email);
                const hashBuffer = await crypto.subtle.digest('SHA-256', data);
                const userId = Array.from(new Uint8Array(hashBuffer))
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');

                if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) {
                    logger.error('Missing Google OAuth environment variables for consent URL generation.', null);
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

                logger.debug(`Debug: Generated OAuth consent URL for user ${userId}`, { userId, authUrl: authUrl.toString() });

                return new Response(JSON.stringify({ message: 'OAuth consent URL generated.', authUrl: authUrl.toString() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });

            } catch (error) {
                logger.error('Debug: Error during OAuth URL generation:', error, { requestUrl: request.url });
                return new Response('Internal Server Error during OAuth URL generation', { status: 500 });
            }
        } else if (request.method === 'GET' && path === '/get-dissimilar-articles') {
            logger.debug('Request received for dissimilar articles for education program');
            try {
                const userId = url.searchParams.get('userId');
                if (!userId) {
                    logger.warn('Get dissimilar articles failed: Missing userId.');
                    return new Response('Missing userId', { status: 400 });
                }

                // D1からembeddingを持つ記事を取得し、ユーザーがフィードバックした記事を除外
                const whereClause = `embedding IS NOT NULL AND article_id NOT IN (SELECT article_id FROM education_logs WHERE user_id = ?)`;
                const allArticlesWithEmbeddings = await getArticlesFromD1(env, 1000, 0, whereClause, [userId]);
                logger.debug(`Found ${allArticlesWithEmbeddings.length} articles with embeddings in D1 (excluding feedbacked articles for user ${userId}).`, { count: allArticlesWithEmbeddings.length, userId });

                // 類似度の低い記事を20件選択
                const dissimilarArticles = await selectDissimilarArticles(allArticlesWithEmbeddings, 20, env);
                logger.debug(`Selected ${dissimilarArticles.length} dissimilar articles.`, { count: dissimilarArticles.length });

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
                logger.error('Error fetching dissimilar articles:', error, { requestUrl: request.url });
                return new Response('Error fetching dissimilar articles', { status: 500 });
            }
        } else if (request.method === 'GET' && path === '/get-personalized-articles') {
            logger.debug('Request received for personalized articles');
            try {
                const userId = url.searchParams.get('userId');
                const lambdaParam = url.searchParams.get('lambda');

                if (!userId) {
                    logger.warn('Get personalized articles failed: Missing userId.');
                    return new Response('Missing userId', { status: 400 });
                }

                let lambda = lambdaParam ? parseFloat(lambdaParam) : 0.5;
                if (isNaN(lambda) || lambda < 0 || lambda > 1) {
                    logger.warn(`Invalid lambda value: ${lambdaParam}. Using default 0.5.`);
                    lambda = 0.5;
                }

                // ユーザープロファイルを取得
                const userProfile = await getUserProfile(userId, env);
                if (!userProfile) {
                    logger.warn(`User profile not found for ${userId}. Falling back to dissimilar articles.`, { userId });
                    // プロファイルがない場合はdissimilar articlesを返す
                    const whereClause = `embedding IS NOT NULL AND article_id NOT IN (SELECT article_id FROM education_logs WHERE user_id = ?)`;
                    const allArticlesWithEmbeddings = await getArticlesFromD1(env, 1000, 0, whereClause, [userId]);
                    const dissimilarArticles = await selectDissimilarArticles(allArticlesWithEmbeddings, 20, env);
                    const articlesForResponse = dissimilarArticles.map((article: NewsArticle) => ({
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
                }

                // D1からembeddingを持つ記事を取得し、ユーザーがフィードバックした記事を除外
                const whereClause = `embedding IS NOT NULL AND article_id NOT IN (SELECT article_id FROM education_logs WHERE user_id = ?)`;
                const allArticlesWithEmbeddings = await getArticlesFromD1(env, 1000, 0, whereClause, [userId]);
                logger.debug(`Found ${allArticlesWithEmbeddings.length} articles with embeddings in D1 (excluding feedbacked articles for user ${userId}).`, { count: allArticlesWithEmbeddings.length, userId });

                if (allArticlesWithEmbeddings.length === 0) {
                    logger.warn('No articles with embeddings found. Returning empty list.', { userId });
                    return new Response(JSON.stringify([]), {
                        headers: { 'Content-Type': 'application/json' },
                        status: 200,
                    });
                }

                // ユーザーのCTRを取得
                const userCTR = await getUserCTR(env, userId);

                // ClickLogger Durable Objectを取得
                const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
                const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

                // ユーザープロファイルの埋め込みベクトルを準備
                const EXTENDED_EMBEDDING_DIMENSION = OPENAI_EMBEDDING_DIMENSION + 1;
                let userProfileEmbeddingForSelection: number[];
                if (userProfile.embedding && userProfile.embedding.length === EXTENDED_EMBEDDING_DIMENSION) {
                    userProfileEmbeddingForSelection = [...userProfile.embedding]; // 参照渡しを防ぐためにコピー
                } else {
                    logger.warn(`User ${userId} has an embedding of unexpected dimension ${userProfile.embedding?.length}. Initializing with zero vector for selection.`, { userId, embeddingLength: userProfile.embedding?.length });
                    userProfileEmbeddingForSelection = new Array(EXTENDED_EMBEDDING_DIMENSION).fill(0);
                }
                // ユーザープロファイルの鮮度情報は常に0.0で上書き
                userProfileEmbeddingForSelection[EXTENDED_EMBEDDING_DIMENSION - 1] = 0.0; // 最後の要素を上書き

                // 記事の埋め込みベクトルに鮮度情報を更新
                const now = Date.now();
                const articlesWithUpdatedFreshness = allArticlesWithEmbeddings
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

                        // 既存の257次元embeddingの最後の要素（鮮度情報）を更新
                        const updatedEmbedding = [...article.embedding!]; // 参照渡しを防ぐためにコピー
                        updatedEmbedding[EXTENDED_EMBEDDING_DIMENSION - 1] = normalizedAge;

                        return {
                            ...article,
                            embedding: updatedEmbedding,
                        };
                    });

                // selectPersonalizedArticlesを呼び出し
                const selectedArticles = await selectPersonalizedArticles(
                    articlesWithUpdatedFreshness,
                    userProfileEmbeddingForSelection,
                    clickLogger,
                    userId,
                    20, // 20件選択
                    userCTR,
                    lambda,
                    env
                );

                logger.debug(`Selected ${selectedArticles.length} personalized articles for user ${userId}.`, { userId, selectedCount: selectedArticles.length });

                // フロントエンドに返すために必要な情報のみを抽出
                const articlesForResponse = selectedArticles.map((article: NewsArticle) => ({
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
                logger.error('Error fetching personalized articles:', error, { requestUrl: request.url });
                return new Response('Error fetching personalized articles', { status: 500 });
            }
        }

        // --- Get MMR Settings Handler ---
        if (request.method === 'GET' && path === '/api/mmr-settings') {
            logger.debug('Request received for MMR settings');
            try {
                const userId = url.searchParams.get('userId');

                if (!userId) {
                    logger.warn('Get MMR settings failed: Missing userId.');
                    return new Response('Missing userId', { status: 400 });
                }

                // ClickLogger から lambda を取得
                const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
                const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

                const lambdaResponse = await clickLogger.fetch(
                    new Request(`${env.WORKER_BASE_URL}/get-mmr-lambda?userId=${encodeURIComponent(userId)}`, {
                        method: 'GET',
                    })
                );

                if (!lambdaResponse.ok) {
                    const errorText = await lambdaResponse.text();
                    logger.error(`Failed to get MMR lambda from ClickLogger: ${lambdaResponse.statusText}`, null, { userId, status: lambdaResponse.status, statusText: lambdaResponse.statusText, errorText });
                    return new Response(`Failed to get MMR lambda: ${lambdaResponse.statusText}`, { status: lambdaResponse.status });
                }

                const { lambda } = await lambdaResponse.json() as { lambda: number };
                logger.debug(`Retrieved MMR lambda for user ${userId}: ${lambda}`, { userId, lambda });

                return new Response(JSON.stringify({ lambda }), {
                    headers: { 'Content-Type': 'application/json' },
                    status: 200,
                });

            } catch (error) {
                logger.error('Error getting MMR settings:', error, { requestUrl: request.url });
                return new Response('Internal Server Error', { status: 500 });
            }
        }

        // --- Get Preference Score Handler ---
        if (request.method === 'GET' && path === '/api/preference-score') {
            logger.debug('Request received for current preference score');
            try {
                const userId = url.searchParams.get('userId');

                if (!userId) {
                    logger.warn('Get preference score failed: Missing userId.');
                    return new Response('Missing userId', { status: 400 });
                }

                const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
                const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

                const scoreResponse = await clickLogger.fetch(
                    new Request(`${env.WORKER_BASE_URL}/get-preference-score?userId=${encodeURIComponent(userId)}`, {
                        method: 'GET',
                    })
                );

                if (!scoreResponse.ok) {
                    const errorText = await scoreResponse.text();
                    logger.error(`Failed to get preference score from ClickLogger: ${scoreResponse.statusText}`, null, { userId, status: scoreResponse.status, statusText: scoreResponse.statusText, errorText });
                    return new Response(`Failed to get preference score: ${scoreResponse.statusText}`, { status: scoreResponse.status });
                }

                const { score } = await scoreResponse.json() as { score: number };
                logger.debug(`Current preference score retrieved for user ${userId}: ${score}`, { userId, score });

                return new Response(JSON.stringify({ score }), {
                    headers: { 'Content-Type': 'application/json' },
                    status: 200,
                });

            } catch (error) {
                logger.error('Error getting preference score:', error, { requestUrl: request.url });
                return new Response('Internal Server Error', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/api/preference-score') {
            logger.debug('Request received for preference score calculation');
            try {
                const { userId, selectedArticleIds } = await request.json() as { userId: string, selectedArticleIds: string[] };

                if (!userId || !Array.isArray(selectedArticleIds) || selectedArticleIds.length === 0) {
                    logger.warn('Preference score calculation failed: Missing userId or selectedArticleIds.');
                    return new Response('Missing userId or selectedArticleIds', { status: 400 });
                }

                const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
                const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

                const scoreResponse = await clickLogger.fetch(
                    new Request(`${env.WORKER_BASE_URL}/calculate-preference-score`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId, selectedArticleIds }),
                    })
                );

                if (!scoreResponse.ok) {
                    const errorText = await scoreResponse.text();
                    logger.error(`Failed to get preference score from ClickLogger: ${scoreResponse.statusText}`, null, { userId, status: scoreResponse.status, statusText: scoreResponse.statusText, errorText });
                    return new Response(`Failed to calculate preference score: ${scoreResponse.statusText}`, { status: scoreResponse.status });
                }

                const { score } = await scoreResponse.json() as { score: number };
                logger.debug(`Preference score calculated for user ${userId}: ${score}`, { userId, score });

                return new Response(JSON.stringify({ score }), {
                    headers: { 'Content-Type': 'application/json' },
                    status: 200,
                });

            } catch (error) {
                logger.error('Error calculating preference score:', error, { requestUrl: request.url });
                return new Response('Internal Server Error', { status: 500 });
            }
        }

		// --- WASM Durable Object Handler ---
		if (path.startsWith('/wasm-do/')) {
			logger.debug('WASM Durable Object request received');
			try {
				const wasmDOId = env.WASM_DO.idFromName("wasm-calculator");
				const wasmDOStub = env.WASM_DO.get(wasmDOId);

				// WasmDO が期待するパスに変換
				const wasmPath = path.replace('/wasm-do', '');
				const wasmUrl = new URL(wasmPath, env.WORKER_BASE_URL);
				logger.debug(`Forwarding WASM DO request to: ${wasmUrl.toString()}`, { wasmUrl: wasmUrl.toString() });

				const wasmRequest = new Request(wasmUrl, {
					method: request.method,
					headers: request.headers,
					body: request.body,
				});

				const doResponse = await wasmDOStub.fetch(wasmRequest); // リクエストをDOに転送

				return doResponse;

			} catch (error) {
				logger.error('Error during WASM Durable Object invocation:', error, { requestUrl: request.url });
				return new Response('Internal Server Error during WASM Durable Object invocation', { status: 500 });
			}
		}

		// Handle other requests or return a default response
		return new Response('Not Found', { status: 404 });
	},
};

// Durable Object class definition (must be exported)
export { ClickLogger } from './clickLogger';
export { BatchQueueDO } from './batchQueueDO';
export { WasmDO } from './wasmDO';
