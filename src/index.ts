import { getUserProfile, createUserProfile } from './userProfile';
import { ClickLogger } from './clickLogger';
import { BatchQueueDO } from './batchQueueDO';
import { logError, logInfo, logWarning } from './logger';
import { collectNews, NewsArticle } from './newsCollector';
import { generateAndSaveEmbeddings } from './services/embeddingService';
import { saveArticlesToD1, getArticlesFromD1, ArticleWithEmbedding } from './services/d1Service';
import { orchestrateMailDelivery } from './orchestrators/mailOrchestrator';
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

export default {
	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
		await orchestrateMailDelivery(env, new Date(controller.scheduledTime));
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
			logInfo('Registration request received');
			try {
				const { email } = await request.json() as { email: string };

				if (!email) {
					logWarning('Registration failed: Missing email in request body.');
					return new Response('Missing email', { status: 400 });
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
				logInfo(`User registered successfully: ${userId}`, { userId, email });

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

				logInfo(`Generated OAuth consent URL for user ${userId}`, { userId, authUrl: authUrl.toString() });

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
				const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
				const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

				const logClickResponse = await clickLogger.fetch(
                    new Request('/log-click', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: userId, articleId: articleId, timestamp: Date.now() }),
                    })
                );

				if (logClickResponse.ok) {
					logInfo(`Click logged successfully for user ${userId}, article ${articleId}`, { userId, articleId });
				} else {
					logError(`Failed to log click for user ${userId}, article ${articleId}: ${logClickResponse.statusText}`, null, { userId, articleId, status: logClickResponse.status, statusText: logClickResponse.statusText });
				}

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
				const articles: NewsArticle[] = await collectNews();
				logInfo(`Collected ${articles.length} articles for education.`, { articleCount: articles.length });

				const articlesForEducation = articles.map((article: NewsArticle) => ({
					articleId: article.articleId,
					title: article.title,
					summary: article.summary,
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
				const { userId, selectedArticles } = await request.json() as { userId: string, selectedArticles: NewsArticle[] };

				if (!userId || !Array.isArray(selectedArticles)) {
					logWarning('Submit interests failed: Missing userId or selectedArticles in request body.');
					return new Response('Missing parameters', { status: 400 });
				}

				const userProfile = await getUserProfile(userId, env);

				if (!userProfile) {
					logWarning(`Submit interests failed: User profile not found for ${userId}.`, { userId });
					return new Response('User not found', { status: 404 });
				}

				logInfo(`User education articles processed successfully for user ${userId}.`, { userId });

				logInfo(`Learning from user education for user ${userId}...`, { userId });

				const selectedArticlesWithEmbeddings: { articleId: string; embedding: number[]; }[] = [];

				for (const selectedArticle of selectedArticles) {
					const articleId = selectedArticle.articleId;
					const article: ArticleWithEmbedding[] = await getArticlesFromD1(env, 1, 0, "article_id = ?", [articleId]);
					const embedding = article.length > 0 ? article[0].embedding : undefined;

					if (embedding) {
						selectedArticlesWithEmbeddings.push({ articleId: articleId, embedding: embedding });
					} else {
						logWarning(`Embedding not found in D1 for selected article: "${selectedArticle.title}". Skipping.`, { articleTitle: selectedArticle.title, articleLink: selectedArticle.articleId });
					}
				}

				if (selectedArticlesWithEmbeddings.length > 0) {
					const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
					const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

					const batchSize = 10;
					logInfo(`Sending selected articles for learning to ClickLogger in batches of ${batchSize} for user ${userId}.`, { userId, totalCount: selectedArticlesWithEmbeddings.length, batchSize });

					for (let i = 0; i < selectedArticlesWithEmbeddings.length; i += batchSize) {
						const batch = selectedArticlesWithEmbeddings.slice(i, i + batchSize);
						logInfo(`Sending batch ${Math.floor(i / batchSize) + 1} with ${batch.length} articles for user ${userId}.`, { userId, batchNumber: Math.floor(i / batchSize) + 1, batchCount: batch.length });

						const learnResponse = await clickLogger.fetch(
                            new Request('/learn-from-education', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ userId: userId, selectedArticles: batch }),
                            })
                        );

						if (learnResponse.ok) {
							logInfo(`Successfully sent batch ${Math.floor(i / batchSize) + 1} for learning to ClickLogger for user ${userId}.`, { userId, batchNumber: Math.floor(i / batchSize) + 1 });
						} else {
							logError(`Failed to send batch ${Math.floor(i / batchSize) + 1} for learning to ClickLogger for user ${userId}: ${learnResponse.statusText}`, null, { userId, batchNumber: Math.floor(i / batchSize) + 1, status: learnResponse.status, statusText: learnResponse.statusText });
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
				const clickLoggerId = env.CLICK_LOGGER.idFromName("global-click-logger-hub");
				const clickLogger = env.CLICK_LOGGER.get(clickLoggerId);

				const deleteResponse = await clickLogger.fetch(
                    new Request('/delete-all-data', {
                        method: 'POST',
                    })
                );

				if (deleteResponse.ok) {
					logInfo('Successfully triggered deletion of all bandit models.');
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
            logInfo('Debug: Force embed articles request received');
            const debugApiKey = request.headers.get('X-Debug-Key');
            if (debugApiKey !== env.DEBUG_API_KEY) {
                logWarning('Debug: Unauthorized access attempt to /debug/force-embed-articles', { providedKey: debugApiKey });
                return new Response('Unauthorized', { status: 401 });
            }

            try {
                logInfo('Debug: Starting news collection for force embedding...');
                const articles: NewsArticle[] = await collectNews();
                logInfo(`Debug: Collected ${articles.length} articles for force embedding.`, { articleCount: articles.length });

                if (articles.length === 0) {
                    logInfo('Debug: No articles collected for force embedding. Skipping further steps.');
                    return new Response('No articles collected', { status: 200 });
                }

                const articlesToSaveToD1 = articles.map(article => ({
                    articleId: article.articleId,
                    title: article.title,
                    link: article.link,
                    sourceName: article.sourceName,
                    url: article.link,
                    publishedAt: article.publishedAt,
                    content: article.summary || '',
                    embedding: undefined,
                }));
                await saveArticlesToD1(articlesToSaveToD1, env);
                logInfo(`Debug: Saved ${articlesToSaveToD1.length} articles to D1 temporarily for force embedding.`, { count: articlesToSaveToD1.length });

                await generateAndSaveEmbeddings(articles, env, true);

                return new Response(JSON.stringify({ message: 'Batch embedding job initiated successfully (debug mode).' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            } catch (error) {
                logError('Debug: Error during force embedding process:', error, { requestUrl: request.url });
                return new Response('Internal Server Error during force embedding', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/debug/delete-user-data') {
            logInfo('Debug: Delete user data request received');
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

                logInfo(`Debug: Deleting user data for user ${userId} from USER_DB...`, { userId });

                await env.USER_DB.prepare(`DELETE FROM users WHERE user_id = ?`).bind(userId).run();
                logInfo(`Debug: Deleted user profile for ${userId}.`, { userId });

                await env.USER_DB.prepare(`DELETE FROM click_logs WHERE user_id = ?`).bind(userId).run();
                logInfo(`Debug: Deleted click logs for ${userId}.`, { userId });

                await env.USER_DB.prepare(`DELETE FROM sent_articles WHERE user_id = ?`).bind(userId).run();
                logInfo(`Debug: Deleted sent articles for ${userId}.`, { userId });

                await env.USER_DB.prepare(`DELETE FROM education_logs WHERE user_id = ?`).bind(userId).run();
                logInfo(`Debug: Deleted education logs for ${userId}.`, { userId });

                await env['mail-news-gmail-tokens'].delete(`refresh_token:${userId}`);
                logInfo(`Debug: Deleted Gmail refresh token for ${userId}.`, { userId });

                logInfo(`Debug: Successfully deleted all data for user ${userId}.`, { userId });
                return new Response(JSON.stringify({ message: `User data for ${userId} deleted successfully.` }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });

            } catch (error) {
                logError('Debug: Error during user data deletion:', error, { requestUrl: request.url });
                return new Response('Internal Server Error during user data deletion', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/debug/trigger-batch-alarm') {
            logInfo('Debug: Trigger BatchQueueDO alarm request received');
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
                    logInfo('Debug: Successfully triggered BatchQueueDO alarm.');
                    return new Response('BatchQueueDO alarm triggered successfully.', { status: 200 });
                } else {
                    logError(`Debug: Failed to trigger BatchQueueDO alarm: ${doResponse.statusText}`, null, { status: doResponse.status, statusText: doResponse.statusText });
                    return new Response(`Failed to trigger BatchQueueDO alarm: ${doResponse.statusText}`, { status: doResponse.status });
                }
            } catch (error) {
                logError('Debug: Error triggering BatchQueueDO alarm:', error, { requestUrl: request.url });
                return new Response('Internal Server Error during BatchQueueDO alarm trigger', { status: 500 });
            }
        }


		// Handle other requests or return a default response
		return new Response('Not Found', { status: 404 });
	},
};

// Durable Object class definition (must be exported)
export { ClickLogger } from './clickLogger';
export { BatchQueueDO } from './batchQueueDO'; // BatchQueueDO をエクスポート
