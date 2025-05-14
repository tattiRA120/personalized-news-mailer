// @ts-nocheck
import { collectNews } from './newsCollector';
import { getEmbedding, generateContent } from './geminiClient'; // Assuming these functions are in geminiClient.ts
import { getUserProfile, updateUserProfile, UserProfile, getAllUserIds } from './userProfile'; // Assuming these functions are in userProfile.ts
import { selectTopArticles, selectPersonalizedArticles } from './articleSelector'; // Assuming these functions are in articleSelector.ts
import { generateNewsEmail, sendNewsEmail } from './emailGenerator'; // Assuming these functions are in emailGenerator.ts
import { ClickLogger } from './clickLogger'; // Assuming this is your Durable Object class
import { logError, logInfo, logWarning } from './logger'; // Import logging helpers

// Define the Env interface with bindings from wrangler.jsonc
export interface Env {
	USER_PROFILES: KVNamespace;
	CLICK_LOGGER: DurableObjectNamespace;
	GEMINI_API_KEY?: string; // Assuming GEMINI_API_KEY is set as a secret or var
	BREVO_API_KEY?: string; // Assuming BREVO_API_KEY is set as a secret or var
	BREVO_WEBHOOK_SECRET?: string; // Assuming BREVO_WEBHOOK_SECRET is set as a secret or var
	// Add other bindings as needed (e.g., R2, Queues)
}

interface EmailRecipient {
    email: string;
    name?: string;
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
						continue; // Skip to the next user
					}
					logInfo(`Loaded user profile for ${userId}.`);

					// --- 3. Embedding & Scoring (per user, based on profile) ---
					logInfo(`Generating embeddings and scoring articles for user ${userId}...`);
					const articlesWithScores: (typeof articles[0] & { score?: number, embedding?: number[] })[] = [];
					for (const article of articles) {
						try {
							// Get embedding
							const embedding = await getEmbedding(`${article.title} ${article.link}`, env); // Use title and link for embedding
							if (!embedding) {
								logWarning(`Could not get embedding for article: ${article.title}. Skipping.`, { articleTitle: article.title });
								continue; // Skip article if embedding fails
							}

							// Calculate relevance score based on user profile keywords and article content/title
							// Using Gemini to score based on keywords and article content/title
							let score = 0;
							// Ensure userProfile.keywords is not empty before creating prompt
							const keywordsPrompt = userProfile.keywords && userProfile.keywords.length > 0 ?
								`ユーザーの興味キーワード「${userProfile.keywords.join(', ')}」にどの程度関連しているか` :
								'一般的なニュースとしてどの程度重要か'; // Fallback prompt if no keywords

							const scoringPrompt = `以下の記事が、${keywordsPrompt}を0から100のスコアで評価してください。スコアのみを数値で回答してください。記事タイトル: "${article.title}"。記事リンク: "${article.link}"`;
							const scoreResponse = await generateContent(scoringPrompt, env);

							if (scoreResponse) {
								try {
									score = parseInt(scoreResponse.trim(), 10);
									if (isNaN(score) || score < 0 || score > 100) {
										logWarning(`Invalid score received from Gemini for article "${article.title}": ${scoreResponse}. Assigning default low score.`, { articleTitle: article.title, scoreResponse });
										score = 10; // Default low score for invalid response
									} else {
										logInfo(`Scored article "${article.title}": ${score}`, { articleTitle: article.title, score });
									}
								} catch (e) {
									logError(`Error parsing score response for article "${article.title}": ${scoreResponse}`, e, { articleTitle: article.title, scoreResponse });
									score = 10; // Default low score on error
								}
							} else {
								logWarning(`Could not get score response from Gemini for article: ${article.title}. Assigning default low score.`, { articleTitle: article.title });
								score = 10; // Default low score
							}

							articlesWithScores.push({ ...article, score, embedding });

						} catch (articleProcessError) {
							logError(`Error processing article "${article.title}" for user ${userId}:`, articleProcessError, { userId, articleTitle: article.title });
							// Continue to the next article even if one fails
						}
					}
					logInfo(`Finished embedding and scoring for user ${userId}. Processed ${articlesWithScores.length} articles.`, { userId, processedCount: articlesWithScores.length });


					// --- 4. Diversity MMR + Bandit ---
					logInfo(`Selecting personalized articles for user ${userId}...`, { userId });
					// Durable Object (ClickLogger) のインスタンスを取得
					const clickLoggerId = env.CLICK_LOGGER.idFromName(userId); // ユーザーIDに対応するDO IDを取得
					const clickLogger = env.CLICK_LOGGER.get(clickLoggerId); // DO インスタンスを取得

					// selectPersonalizedArticles 関数に Durable Object インスタンスを渡す
					// @ts-ignore: Durable Object Stub の型に関するエラーを抑制
					const numberOfArticlesToSend = 5; // Define how many articles to send
					const selectedArticles = await selectPersonalizedArticles(articlesWithScores, userProfile, clickLogger, numberOfArticlesToSend);
					logInfo(`Selected ${selectedArticles.length} articles for user ${userId}.`, { userId, selectedCount: selectedArticles.length });

					if (selectedArticles.length === 0) {
						logInfo('No articles selected after scoring and filtering. Skipping email sending for this user.', { userId });
						continue; // Skip to the next user
					}

					// --- 5. Email Generation & Sending ---
					logInfo(`Generating and sending email for user ${userId}...`, { userId });
					const emailSubject = 'Your Daily Personalized News Update';
					// TODO: Use actual user email from userProfile or a separate mapping
					// For now, using a placeholder. Need to store email in userProfile or KV mapping.
					const recipientEmail = userProfile.email; // Use actual user email from profile
					if (!recipientEmail) {
						logError(`User profile for ${userId} does not contain an email address. Skipping email sending.`, null, { userId });
						continue;
					}
					const recipient: EmailRecipient = { email: recipientEmail, name: userProfile.userId }; // Using userId as name for now
					const sender: EmailRecipient = { email: 'sender@yourdomain.com', name: 'News Bot' }; // TODO: Use your verified SendGrid sender email

					// generateNewsEmail 関数に userId を渡す
					const htmlEmailContent = generateNewsEmail(selectedArticles, userId);

					const emailSent = await sendNewsEmail(env.BREVO_API_KEY, recipientEmail, userId, selectedArticles);

					if (emailSent) {
						logInfo(`Personalized news email sent to ${recipient.email}`, { userId, email: recipient.email });
					} else {
						logError(`Failed to send email to ${recipient.email}`, null, { userId, email: recipient.email });
					}

					// --- Log Sent Articles to Durable Object ---
					logInfo(`Logging sent articles to ClickLogger for user ${userId}...`, { userId });
					const sentArticlesData = selectedArticles.map(article => ({
						articleId: article.articleId,
						timestamp: Date.now(), // 送信時のタイムスタンプ
						embedding: article.embedding, // embedding も一緒に保存
					}));

					const logSentResponse = await clickLogger.fetch(new Request(new URL('/log-sent-articles', request.url), {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ sentArticles: sentArticlesData }),
					}));

					if (logSentResponse.ok) {
						logInfo(`Successfully logged sent articles for user ${userId}.`, { userId });
					} else {
						logError(`Failed to log sent articles for user ${userId}: ${logSentResponse.statusText}`, null, { userId, status: logSentResponse.status, statusText: logSentResponse.statusText });
					}


					// --- Trigger Reward Decay in Durable Object ---
					logInfo(`Triggering reward decay in ClickLogger for user ${userId}...`, { userId });
					const decayResponse = await clickLogger.fetch(new Request(new URL('/decay-rewards', request.url), {
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
						userProfile.sentArticleIds.push(...selectedArticles.map(a => a.articleId));
					} else {
						userProfile.sentArticleIds = selectedArticles.map(a => a.articleId);
					}
					await updateUserProfile(userProfile, env);
					logInfo(`Updated user profile for ${userId} with sent article IDs.`, { userId });


				} catch (userProcessError) {
					logError(`Error processing user ${userId}:`, userProcessError, { userId });
					// Continue to the next user even if one user's process fails
				}
			} // End of user loop
					logInfo('Scheduled task finished.');

		} catch (mainError) {
			logError('Error during scheduled task execution:', mainError);
			// Optionally send an alert or log to an external service
		}
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

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
									const userProfile = await getUserProfile(userId, env);
									if (userProfile && !userProfile.clickedArticleIds.includes(articleId)) {
										userProfile.clickedArticleIds.push(articleId);
										await updateUserProfile(userProfile, env);
										logInfo(`Updated user profile for ${userId} with clicked article ${articleId}.`, { userId, articleId });
									}

								} else {
									logWarning('Could not extract userId or articleId from Brevo webhook payload or X-Mailin-Custom.', { event });
									// メールアドレスからユーザーIDを検索して処理を続行することも検討
									// const userProfile = await getUserByEmail(email, env); // getUserByEmail 関数が必要
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

		// Handle other requests or return a default response
		return new Response('Not Found', { status: 404 });
	},
};

// Durable Object class definition (must be exported)
export { ClickLogger } from './clickLogger';
