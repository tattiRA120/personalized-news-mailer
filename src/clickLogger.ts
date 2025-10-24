// src/clickLogger.ts

import { initLogger } from './logger';
import { DurableObject } from 'cloudflare:workers';
import { NewsArticle } from './newsCollector';
import { Env } from './index';
import init, { get_ucb_values_bulk, update_bandit_model } from '../linalg-wasm/pkg/linalg_wasm';
import wasm from '../linalg-wasm/pkg/linalg_wasm_bg.wasm';
import { updateUserProfile } from './userProfile';
import { OPENAI_EMBEDDING_DIMENSION } from './config';

// 記事の鮮度情報を1次元追加するため、最終的な埋め込みベクトルの次元は OPENAI_EMBEDDING_DIMENSION + 1 となる
export const EXTENDED_EMBEDDING_DIMENSION = OPENAI_EMBEDDING_DIMENSION + 1; // orchestratorから参照するためexport

// Contextual Bandit (LinUCB) モデルの状態を保持するインターフェース
interface BanditModelState {
    A_inv: Float64Array; // d x d 行列 (フラット化)
    b: Float64Array;   // d x 1 ベクトル
    dimension: number; // 特徴量ベクトルの次元 (embedding の次元)
    alpha: number;
}

// ClickLogger Durable Object が必要とする Env の拡張
interface ClickLoggerEnv extends Env {
    BANDIT_MODELS: R2Bucket; // R2 Bucket binding for bandit model state
    DB: D1Database; // D1 Database binding for all tables (articles, users, logs)
}

// Durable Object class for managing click logs and bandit models for ALL users.
// This acts as a central hub to minimize R2 access.
export class ClickLogger extends DurableObject {
    state: DurableObjectState;
    env: ClickLoggerEnv;

    private inMemoryModels: Map<string, BanditModelState>;
    private readonly modelsR2Key = 'bandit_models.json'; // Key for the aggregated models file in R2
    private dirty: boolean; // Flag to track if in-memory models have changed

    // ロガー関数をインスタンス変数として保持
    private logError: (message: string, error: any, details?: any) => void;
    private logInfo: (message: string, details?: any) => void;
    private logWarning: (message: string, details?: any) => void;
    private logDebug: (message: string, details?: any) => void;

    constructor(state: DurableObjectState, env: ClickLoggerEnv) {
        super(state, env);
        this.state = state;
        this.env = env;
        this.inMemoryModels = new Map<string, BanditModelState>();
        this.dirty = false;

        // ロガーを初期化し、インスタンス変数に割り当てる
        const { logError, logInfo, logWarning, logDebug } = initLogger(env);
        this.logError = logError;
        this.logInfo = logInfo;
        this.logWarning = logWarning;
        this.logDebug = logDebug;

        // Load all models from R2 into memory on startup.
        this.state.blockConcurrencyWhile(async () => {
            this.logDebug('WASMモジュールを初期化します...');
            await init(wasm); // WASMモジュールの初期化
            this.logDebug('WASMモジュールの初期化完了');
            await this.loadModelsFromR2();
        });
    }

    // Load all bandit models from a single R2 object.
    private async loadModelsFromR2(): Promise<void> {
        this.logDebug(`Attempting to load all bandit models from R2 key: ${this.modelsR2Key}`);
        try {
            const object = await this.env.BANDIT_MODELS.get(this.modelsR2Key);

            if (object !== null) {
                // object.size が 0 の場合も空のJSONとして扱う
                if (object.size === 0) {
                    this.logWarning('Existing bandit models file found in R2 but it is empty (0B). Initializing with an empty map and saving an empty JSON object to R2.');
                    this.inMemoryModels = new Map<string, BanditModelState>();
                    await this.env.BANDIT_MODELS.put(this.modelsR2Key, JSON.stringify({}));
                    return; // 処理を終了
                }
                const modelsRecord = await object.json<Record<string, { A_inv: number[], b: number[], dimension: number, alpha: number }>>();
                this.inMemoryModels = new Map(Object.entries(modelsRecord).map(([userId, model]) => [
                    userId,
                    {
                        A_inv: new Float64Array(model.A_inv),
                        b: new Float64Array(model.b),
                        dimension: model.dimension,
                        alpha: model.alpha,
                    }
                ]));
                this.logDebug(`Successfully loaded ${this.inMemoryModels.size} bandit models from R2.`);
            } else {
                this.logDebug('No existing bandit models file found in R2. Initializing with an empty map and saving an empty JSON object to R2.');
                this.inMemoryModels = new Map<string, BanditModelState>();
                // R2に空のJSONオブジェクトを書き込む
                await this.env.BANDIT_MODELS.put(this.modelsR2Key, JSON.stringify({}));
            }
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logError('Error loading bandit models from R2. Starting fresh.', err, { errorName: err.name, errorMessage: err.message });
            // In case of a loading/parsing error, start with a clean slate to avoid corruption.
            this.inMemoryModels = new Map<string, BanditModelState>();
        }
    }

    // Save all in-memory bandit models to a single R2 object.
    private async saveModelsToR2(): Promise<void> {
        this.logDebug(`Attempting to save ${this.inMemoryModels.size} bandit models to R2.`);
        try {
            const modelsToSave = Object.fromEntries(
                Array.from(this.inMemoryModels.entries()).map(([userId, model]) => [
                    userId,
                    {
                        A_inv: Array.from(model.A_inv),
                        b: Array.from(model.b),
                        dimension: model.dimension,
                        alpha: model.alpha,
                    }
                ])
            );
            await this.env.BANDIT_MODELS.put(this.modelsR2Key, JSON.stringify(modelsToSave));
            this.dirty = false; // Reset dirty flag after successful save
            this.logDebug('Successfully saved all bandit models to R2.');
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logError('Failed to save bandit models to R2.', err, {
                name: err.name,
                message: err.message,
                stack: err.stack,
            });
        }
    }
    
    // Initialize a new bandit model for a specific user.
    private initializeNewBanditModel(userId: string): BanditModelState {
        const dimension = EXTENDED_EMBEDDING_DIMENSION; // Dimension for text-embedding-3-small + 1 (freshness)
        const aInvArray = new Float64Array(dimension * dimension).fill(0);
        const bArray = new Float64Array(dimension).fill(0);

        // Initialize A_inv as an identity matrix (flattened)
        for (let i = 0; i < dimension; i++) {
            aInvArray[i * dimension + i] = 1.0;
        }

        const newModel: BanditModelState = {
            A_inv: aInvArray,
            b: bArray,
            dimension: dimension,
            alpha: 0.5, // UCB parameter
        };
        this.inMemoryModels.set(userId, newModel);
        this.dirty = true;
        this.logDebug(`Initialized new bandit model for userId: ${userId}`);
        return newModel;
    }

    // ユーザープロファイルの埋め込みをD1に更新するプライベートメソッド
    private async updateUserProfileEmbeddingInD1(userId: string, banditModel: BanditModelState): Promise<void> {
        this.logDebug(`Attempting to update user profile embedding in D1 for user: ${userId}`);
        try {
            // BanditModelのbベクトルをユーザーの興味プロファイルとして使用
            // L2ノルムで正規化
            const bVector = Array.from(banditModel.b);
            const norm = Math.sqrt(bVector.reduce((sum, val) => sum + val * val, 0));
            const normalizedEmbedding = norm > 0 ? bVector.map(val => val / norm) : new Array(banditModel.dimension).fill(0);

            // userProfile.ts の updateUserProfile 関数を呼び出す
            // email を保持するために、まず現在のユーザープロファイルを取得する
            const currentUserProfile = await this.env.DB.prepare(
                `SELECT email FROM users WHERE user_id = ?`
            ).bind(userId).first<{ email: string }>();

            const emailToUpdate = currentUserProfile?.email || ''; // 既存のemailを使用、なければ空文字列

            await updateUserProfile({ userId: userId, email: emailToUpdate, embedding: normalizedEmbedding }, this.env);
            this.logInfo(`Successfully updated user profile embedding in D1 for user: ${userId}`);
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logError('Error updating user profile embedding in D1:', err, { userId, errorName: err.name, errorMessage: err.message });
        }
    }

    async alarm() {
        // This alarm is triggered periodically to save dirty models to R2 and process unclicked articles.
        if (this.dirty) {
            this.logInfo('Alarm triggered. Saving dirty models to R2.');
            await this.saveModelsToR2();
        } else {
            this.logDebug('Alarm triggered, but no changes to save.');
        }

        // Process unclicked articles
        await this.processUnclickedArticles();
    }

    // Helper to ensure an alarm is set.
    private async ensureAlarmIsSet(): Promise<void> {
        const currentAlarm = await this.state.storage.getAlarm();
        if (currentAlarm === null || currentAlarm < Date.now()) { // アラームが設定されていないか、過去の時刻の場合
            this.logDebug('Alarm not set or expired. Setting a new alarm to run in 60 minutes.');
            // Set an alarm to run in 60 minutes (3600 * 1000 ms)
            const oneHour = 60 * 60 * 1000;
            await this.state.storage.setAlarm(Date.now() + oneHour);
        } else {
            this.logDebug(`Alarm already set for ${new Date(currentAlarm).toISOString()}.`);
        }
    }

    // Handle requests to the Durable Object
    async fetch(request: Request): Promise<Response> {
        // Ensure an alarm is set to periodically save data.
        // This is crucial for ensuring alarm() is called even if the DO is idle for a long time.
        await this.ensureAlarmIsSet();

        const url = new URL(request.url);
        const path = url.pathname;

        // /get-ucb-values エンドポイントのリクエストボディの型定義
        interface GetUcbValuesRequestBody {
            userId: string;
            articlesWithEmbeddings: { articleId: string, embedding: number[] }[];
            userCTR: number;
        }

        // /log-sent-articles エンドポイントのリクエストボディの型定義
        interface LogSentArticlesRequestBody {
            userId: string;
            sentArticles: { articleId: string, timestamp: number, embedding: number[] }[];
        }

        // /log-click エンドポイントのリクエストボディの型定義
        interface LogClickRequestBody {
            userId: string;
            articleId: string;
            timestamp: number;
        }

        // /update-bandit-from-click エンドポイントのリクエストボディの型定義
        interface UpdateBanditFromClickRequestBody {
            userId: string;
            articleId: string;
            embedding: number[];
            reward: number;
        }

        // /log-feedback エンドポイントのリクエストボディの型定義
        interface LogFeedbackRequestBody {
            userId: string;
            articleId: string;
            feedback: 'interested' | 'not_interested';
            timestamp: number;
        }

        // /learn-from-education エンドポイントのリクエストボディの型定義
        interface LearnFromEducationRequestBody {
            userId: string;
            selectedArticles: { articleId: string, embedding: number[], reward: number }[];
        }

        // /embedding-completed-callback エンドポイントのリクエストボディの型定義
        interface EmbeddingCompletedCallbackRequestBody {
            userId: string; // userIdを追加
            embeddings: { articleId: string; embedding: number[]; }[];
        }

        if (request.method === 'POST' && path === '/log-click') {
            try {
                const { userId, articleId, timestamp } = await request.json() as LogClickRequestBody;

                if (!userId || !articleId || timestamp === undefined) {
                    this.logWarning('Log click failed: Missing userId, articleId, or timestamp.');
                    return new Response('Missing parameters', { status: 400 });
                }

                await this.env.DB.prepare(
                    `INSERT INTO click_logs (user_id, article_id, timestamp) VALUES (?, ?, ?)`
                ).bind(userId, articleId, timestamp).run();

                this.logInfo(`Logged click for user ${userId}, article ${articleId}`);
                return new Response('Click logged', { status: 200 });

            } catch (error) {
                this.logError('Error logging click:', error, { requestUrl: request.url });
                return new Response('Error logging click', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/log-feedback') {
            try {
                const { userId, articleId, feedback, timestamp } = await request.json() as LogFeedbackRequestBody;

                if (!userId || !articleId || !feedback || !timestamp) {
                    this.logWarning('Log feedback failed: Missing parameters.');
                    return new Response('Missing parameters', { status: 400 });
                }

                // 1. Determine reward based on feedback
                const reward = feedback === 'interested' ? 2.0 : -1.0;

                // 2. Get the article's embedding from D1 (sent_articles table)
                const articleResult = await this.env.DB.prepare(
                    `SELECT embedding FROM sent_articles WHERE user_id = ? AND article_id = ? ORDER BY timestamp DESC LIMIT 1`
                ).bind(userId, articleId).first<{ embedding: string }>();

                if (!articleResult || !articleResult.embedding) {
                    this.logWarning(`Could not find embedding for article ${articleId} for user ${userId} to log feedback.`, { userId, articleId });
                    // Even if embedding is not found, we can log the feedback itself.
                    // For now, we just return an error response.
                    return new Response('Article embedding not found', { status: 404 });
                }

                let embedding: number[] | undefined;

                // 2.1. sent_articles テーブルから embedding を取得
                const sentArticleResult = await this.env.DB.prepare(
                    `SELECT embedding FROM sent_articles WHERE user_id = ? AND article_id = ? ORDER BY timestamp DESC LIMIT 1`
                ).bind(userId, articleId).first<{ embedding: string }>();

                if (sentArticleResult && sentArticleResult.embedding) {
                    embedding = JSON.parse(sentArticleResult.embedding) as number[];
                    this.logDebug(`Found embedding in sent_articles for article ${articleId} for user ${userId}.`, { userId, articleId });
                } else {
                    // 2.2. sent_articles にない場合、articles テーブルから embedding を取得
                    this.logDebug(`Embedding not found in sent_articles for article ${articleId} for user ${userId}. Attempting to fetch from articles table.`, { userId, articleId });
                    const originalArticle = await this.env.DB.prepare(
                        `SELECT embedding, published_at FROM articles WHERE article_id = ?`
                    ).bind(articleId).first<{ embedding: string | null, published_at: string | null }>(); // null許容型に変更

                    this.logDebug(`Original article fetch result for ${articleId}:`, {
                        userId,
                        articleId,
                        originalArticle: originalArticle,
                        embeddingRaw: originalArticle?.embedding,
                        publishedAtRaw: originalArticle?.published_at
                    });

                    if (originalArticle && originalArticle.embedding && originalArticle.published_at) {
                        try {
                            const originalEmbedding = JSON.parse(originalArticle.embedding) as number[];
                            this.logDebug(`Parsed original embedding for ${articleId}:`, { userId, articleId, parsedEmbedding: originalEmbedding.slice(0, 5) }); // 最初の5要素のみログ

                            const now = Date.now();
                            const ageInHours = (now - new Date(originalArticle.published_at).getTime()) / (1000 * 60 * 60);
                            const normalizedAge = Math.min(ageInHours / (24 * 7), 1.0);
                            embedding = [...originalEmbedding, normalizedAge]; // 鮮度情報を付加して拡張
                            this.logDebug(`Successfully fetched and extended embedding from articles table for article ${articleId}. New dimension: ${embedding.length}`, { userId, articleId, newEmbeddingLength: embedding.length });
                        } catch (parseError) {
                            this.logError(`Error parsing embedding JSON for article ${articleId}:`, parseError, { userId, articleId, embeddingRaw: originalArticle.embedding });
                            return new Response('Error parsing article embedding', { status: 500 });
                        }
                    } else {
                        this.logWarning(`Could not find valid embedding or published_at for article ${articleId} for user ${userId} in articles table. Cannot update bandit model.`, {
                            userId,
                            articleId,
                            originalArticleExists: !!originalArticle,
                            embeddingExists: !!originalArticle?.embedding,
                            publishedAtExists: !!originalArticle?.published_at
                        });
                        return new Response('Article embedding or published_at not found in articles table', { status: 404 });
                    }
                }

                // 3. Update the bandit model
                let banditModel = this.inMemoryModels.get(userId);
                if (!banditModel) {
                    this.logWarning(`No model found for user ${userId} in log-feedback. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

                // embeddingの次元がモデルの次元と一致しない場合のフォールバック処理 (既に上記で処理済みだが念のため)
                if (embedding.length !== banditModel.dimension) {
                    this.logError(`Final embedding dimension mismatch for article ${articleId}. Expected ${banditModel.dimension}, got ${embedding.length}. Cannot update bandit model.`, null, {
                        userId,
                        articleId,
                        embeddingLength: embedding.length,
                        modelDimension: banditModel.dimension
                    });
                    return new Response('Embedding dimension mismatch', { status: 500 });
                }

                await this.updateBanditModel(banditModel, embedding, reward, userId);
                this.dirty = true;
                this.logInfo(`Successfully updated bandit model from feedback for article ${articleId} for user ${userId}`, { userId, articleId, feedback, reward });
                
                // 4. Log the feedback to education_logs table
                await this.env.DB.prepare(
                    `INSERT INTO education_logs (user_id, article_id, timestamp, action) VALUES (?, ?, ?, ?)`
                ).bind(userId, articleId, timestamp, feedback).run();
                this.logInfo(`Logged feedback to education_logs for user ${userId}, article ${articleId}, feedback: ${feedback}`);

                return new Response('Feedback logged and model updated', { status: 200 });

            } catch (error) {
                this.logError('Error logging feedback:', error, { requestUrl: request.url });
                return new Response('Error logging feedback', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/get-ucb-values') {
             try {
                const { userId, articlesWithEmbeddings, userCTR } = await request.json() as GetUcbValuesRequestBody;
                if (!userId || !Array.isArray(articlesWithEmbeddings) || userCTR === undefined) {
                     return new Response('Invalid input: userId, articlesWithEmbeddings array, and userCTR are required', { status: 400 });
                }

                let banditModel = this.inMemoryModels.get(userId);
                if (!banditModel) {
                    this.logWarning(`No model found for user ${userId} in get-ucb-values. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

                // articlesWithEmbeddings は既に鮮度情報が付与された257次元のembeddingを持つことを想定
                const ucbValues = await this.getUCBValues(userId, banditModel, articlesWithEmbeddings, userCTR);
                // Limit logging to the first 10 UCB values for performance
                const limitedUcbValues = ucbValues.slice(0, 10).map(u => ({ articleId: u.articleId, ucb: u.ucb.toFixed(4) }));
                this.logDebug(
                    `Calculated UCB values for user ${userId} (showing up to 10): ${JSON.stringify(limitedUcbValues)}`,
                    { userId, totalUcbCount: ucbValues.length }
                );
                return new Response(JSON.stringify(ucbValues), {
                    headers: { 'Content-Type': 'application/json' },
                });

            } catch (error) {
                this.logError('Error getting UCB values:', error);
                return new Response('Error getting UCB values', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/log-sent-articles') {
            try {
                const { userId, sentArticles } = await request.json() as LogSentArticlesRequestBody;
                if (!userId || !Array.isArray(sentArticles)) {
                    return new Response('Invalid input: userId and sentArticles array are required', { status: 400 });
                }

                const statements = [];
                for (const article of sentArticles) {
                    // sent_articles に挿入する前に、articles テーブルに article_id が存在するか確認
                    const articleExists = await this.env.DB.prepare(`SELECT article_id FROM articles WHERE article_id = ?`).bind(article.articleId).all();
                    if (articleExists.results && articleExists.results.length > 0) {
                        statements.push(
                            this.env.DB.prepare(
                                `INSERT INTO sent_articles (user_id, article_id, timestamp, embedding) VALUES (?, ?, ?, ?)`
                            ).bind(userId, article.articleId, article.timestamp, article.embedding ? JSON.stringify(article.embedding) : null)
                        );
                    } else {
                        this.logWarning(`Skipping logging sent article ${article.articleId} for user ${userId} due to missing article in 'articles' table.`, { userId, articleId: article.articleId });
                    }
                }
                if (statements.length > 0) {
                    await this.env.DB.batch(statements);
                } else {
                    this.logDebug(`No valid sent articles to log for user ${userId}.`, { userId });
                }

                this.logDebug(`Successfully logged ${sentArticles.length} sent articles for user ${userId}`);
                return new Response('Sent articles logged', { status: 200 });

            } catch (error) {
                this.logError('Error logging sent articles:', error);
                return new Response('Error logging sent articles', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/decay-rewards') {
            this.logWarning('/decay-rewards endpoint is deprecated.');
            return new Response('Deprecated endpoint', { status: 410 });
        } else if (request.method === 'POST' && path === '/learn-from-education') {
            try {
                const { userId, selectedArticles } = await request.json() as LearnFromEducationRequestBody;
                if (!userId || !Array.isArray(selectedArticles)) {
                    return new Response('Invalid parameters: userId and selectedArticles array are required', { status: 400 });
                }

                let banditModel = this.inMemoryModels.get(userId);
                if (!banditModel) {
                    this.logWarning(`No model found for user ${userId} in learn-from-education. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

                const logStatements = [];
                for (const article of selectedArticles) {
                    if (article.embedding && article.reward !== undefined) {
                        let embeddingToUse = article.embedding;

                        // embeddingの次元がモデルの次元と一致しない場合のフォールバック処理
                        if (embeddingToUse.length !== banditModel.dimension) {
                            this.logWarning(`Embedding dimension mismatch for article ${article.articleId} from selectedArticles. Attempting to re-fetch and extend.`, {
                                userId,
                                articleId: article.articleId,
                                selectedArticleEmbeddingLength: embeddingToUse.length,
                                modelDimension: banditModel.dimension
                            });

                            // D1のarticlesテーブルから元のembeddingとpublished_atを再取得
                            const originalArticle = await this.env.DB.prepare(
                                `SELECT embedding, published_at FROM articles WHERE article_id = ?`
                            ).bind(article.articleId).first<{ embedding: string, published_at: string | null }>()

                            if (originalArticle && originalArticle.embedding && originalArticle.published_at !== null) {
                                const originalEmbedding = JSON.parse(originalArticle.embedding) as number[];
                                const now = Date.now();
                                const ageInHours = (now - new Date(originalArticle.published_at).getTime()) / (1000 * 60 * 60);
                                const normalizedAge = Math.min(ageInHours / (24 * 7), 1.0);
                                embeddingToUse = [...originalEmbedding, normalizedAge]; // 鮮度情報を付加して拡張

                                this.logDebug(`Successfully re-fetched and extended embedding for article ${article.articleId}. New dimension: ${embeddingToUse.length}`, { userId, articleId: article.articleId, newEmbeddingLength: embeddingToUse.length });
                            } else {
                                this.logError(`Failed to re-fetch original embedding for article ${article.articleId} from articles table. Cannot update bandit model.`, null, { userId, articleId: article.articleId });
                                // エラーが発生した場合でも、この記事の学習はスキップし、次の記事に進む
                                continue;
                            }
                        }

                        await this.updateBanditModel(banditModel, embeddingToUse, article.reward, userId);
                        logStatements.push(
                            this.env.DB.prepare(
                                `INSERT INTO education_logs (user_id, article_id, timestamp, action) VALUES (?, ?, ?, ?)`
                            ).bind(userId, article.articleId, Date.now(), article.reward > 0 ? 'interested' : 'not_interested')
                        );
                    }
                }
                
                if (logStatements.length > 0) {
                    await this.env.DB.batch(logStatements);
                    this.dirty = true;
                    this.logDebug(`Learned from ${logStatements.length} articles and updated bandit model for user ${userId}.`);
                    await this.saveModelsToR2(); // モデルの変更を即座にR2へ保存
                }
                return new Response('Learning from education completed', { status: 200 });

            } catch (error) {
                this.logError('Error learning from education:', error, { requestUrl: request.url });
                return new Response('Error learning from education', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/embedding-completed-callback') {
            try {
                const { userId, embeddings } = await request.json() as EmbeddingCompletedCallbackRequestBody;
                if (!Array.isArray(embeddings) || embeddings.length === 0) {
                    this.logWarning('Embedding completed callback failed: No embeddings provided.');
                    return new Response('No embeddings provided', { status: 400 });
                }

                if (userId) { // userId が存在する場合のみバンディットモデルを更新
                    let banditModel = this.inMemoryModels.get(userId);
                    if (!banditModel) {
                        this.logWarning(`No model found for user ${userId} during embedding callback. Initializing a new one.`);
                        banditModel = this.initializeNewBanditModel(userId);
                    }

                    for (const embed of embeddings) {
                        // embedding-completed-callback は OpenAI Batch API からのコールバックであり、
                        // ここで受け取るembeddingは256次元であるため、鮮度情報 (0.0) を追加して257次元にする。
                        const embeddingWithFreshness = [...embed.embedding, 0.0];
                        await this.updateBanditModel(banditModel, embeddingWithFreshness, 1.0, userId); // 報酬は1.0
                        this.logDebug(`Updated bandit model for user ${userId} with embedding for article ${embed.articleId}.`);
                    }
                    this.dirty = true; // モデルが変更されたことをマーク
                } else {
                    this.logDebug('Embedding completed callback received without userId. Skipping bandit model update.', { embeddingsCount: embeddings.length });
                }
                
                return new Response('Embedding completed callback processed', { status: 200 });
            } catch (error) {
                this.logError('Error processing embedding completed callback:', error, { requestUrl: request.url });
                return new Response('Error processing callback', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/update-bandit-from-click') {
             try {
                const { userId, articleId, embedding, reward } = await request.json() as UpdateBanditFromClickRequestBody;
                if (!userId || !articleId || !embedding || reward === undefined) {
                    return new Response('Missing parameters', { status: 400 });
                }

                let banditModel = this.inMemoryModels.get(userId);
                if (!banditModel) {
                    this.logWarning(`No model found for user ${userId} in update-bandit-from-click. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

                await this.updateBanditModel(banditModel, embedding, reward, userId);
                this.dirty = true;
                this.logDebug(`Successfully updated bandit model from click for article ${articleId} for user ${userId}`);
                return new Response('Bandit model updated', { status: 200 });

            } catch (error) {
                this.logError('Error updating bandit model from click:', error, { requestUrl: request.url });
                return new Response('Error updating bandit model from click', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/delete-all-data') {
            // This is a destructive operation and should be used with caution.
            // It now deletes the entire R2 object.
            try {
                this.logInfo(`Deleting all bandit models from R2.`);
                await this.env.BANDIT_MODELS.delete(this.modelsR2Key);
                this.inMemoryModels.clear();
                this.dirty = false;
                this.logInfo(`All bandit models deleted.`);
                return new Response('All bandit models deleted', { status: 200 });
            } catch (error) {
                this.logError('Error deleting all bandit models:', error, { requestUrl: request.url });
                return new Response('Error deleting all models', { status: 500 });
            }
        }


        // Handle other requests
        return new Response('Not Found', { status: 404 });
    }

    // Process unclicked articles and update bandit models
    private async processUnclickedArticles(): Promise<void> {
        this.logDebug('Starting to process unclicked articles.');
        try {
            // Get all user IDs that have sent articles
            const { results } = await this.env.DB.prepare(`SELECT DISTINCT user_id FROM sent_articles`).all<{ user_id: string }>();
            const userIds = results.map(row => row.user_id);
            this.logDebug(`Found ${userIds.length} users with sent articles to process.`, { userCount: userIds.length });

            const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000); // 24時間前

            for (const userId of userIds) {
                this.logDebug(`Processing unclicked articles for user: ${userId}`, { userId });
                const unclickedArticles = await this.env.DB.prepare(
                    `SELECT sa.article_id, sa.embedding
                     FROM sent_articles sa
                     LEFT JOIN click_logs cl ON sa.user_id = cl.user_id AND sa.article_id = cl.article_id
                     WHERE sa.user_id = ? AND sa.timestamp >= ? AND cl.id IS NULL`
                ).bind(userId, twentyFourHoursAgo).all<{ article_id: string, embedding: string }>();

                if (unclickedArticles.results && unclickedArticles.results.length > 0) {
                    let banditModel = this.inMemoryModels.get(userId);
                    if (!banditModel) {
                        this.logWarning(`No bandit model found for user ${userId} during unclicked article processing. Initializing a new one.`);
                        banditModel = this.initializeNewBanditModel(userId);
                    }

                    let updatedCount = 0;
                    for (const article of unclickedArticles.results) {
                        if (article.embedding) {
                            // クリックされなかった記事には負の報酬を与える (例: -0.1)
                            await this.updateBanditModel(banditModel, JSON.parse(article.embedding) as number[], -0.1, userId);
                            this.dirty = true;
                            updatedCount++;
                        }
                    }
                    this.logDebug(`Updated bandit model for user ${userId} with -0.1 reward for ${updatedCount} unclicked articles.`, { userId, updatedCount });
                } else {
                    this.logDebug(`No unclicked articles found for user ${userId} within the last 24 hours.`, { userId });
                }
            }
            this.logDebug('Finished processing unclicked articles.');
        } catch (error) {
            this.logError('Error processing unclicked articles:', error);
        }
    }

    // Calculate UCB values for a list of articles for a specific user model using WASM.
    private async getUCBValues(userId: string, banditModel: BanditModelState, articles: { articleId: string, embedding: number[] }[], userCTR: number): Promise<{ articleId: string, ucb: number }[]> {
        if (banditModel.dimension === 0) {
            this.logWarning("Bandit model dimension is zero. Cannot calculate UCB values.", { userId });
            return articles.map(article => ({ articleId: article.articleId, ucb: 0 }));
        }

        try {
            // WASM 側の BanditModel 構造体に合うようにデータを変換
            const wasmModel = {
                a_inv: Array.from(banditModel.A_inv),
                b: Array.from(banditModel.b),
                dimension: banditModel.dimension,
            };

            // WASM 側の Article 構造体の配列に合うようにデータを変換
            const wasmArticles = articles.map(article => {
                // embedding が null または undefined でないことを確認
                if (!article.embedding || article.embedding.length !== banditModel.dimension) {
                    this.logWarning(`Skipping article ${article.articleId} due to invalid or mismatched embedding dimension for UCB calculation.`, {
                        userId,
                        articleId: article.articleId,
                        embeddingLength: article.embedding?.length,
                        modelDimension: banditModel.dimension
                    });
                    return null; // 不正な記事はスキップ
                }
                return {
                    articleId: article.articleId,
                    embedding: article.embedding,
                };
            }).filter(Boolean) as { articleId: string, embedding: number[] }[]; // null を除去

            if (wasmArticles.length === 0) {
                this.logWarning("No valid articles with embeddings to calculate UCB values for.", { userId });
                return [];
            }

            // WASM 関数を呼び出し
            const ucbResults: { articleId: string, ucb: number }[] = await get_ucb_values_bulk(
                wasmModel,
                wasmArticles,
                userCTR
            );

            // Limit logging to the first 10 UCB values for performance
            const limitedUcbValues = ucbResults.slice(0, 10).map(u => ({ articleId: u.articleId, ucb: u.ucb.toFixed(4) }));
            this.logDebug(
                `Calculated UCB values for user ${userId} (showing up to 10): ${JSON.stringify(limitedUcbValues)}`,
                { userId, totalUcbCount: ucbResults.length }
            );

            return ucbResults;
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logError("Error during WASM UCB calculation:", err, {
                userId,
                articlesCount: articles.length,
                errorName: err.name,
                errorMessage: err.message,
                stack: err.stack,
            });
            return articles.map(article => ({ articleId: article.articleId, ucb: 0 }));
        }
    }

    // Helper to normalize errors to Error objects
    private normalizeError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    // Update a specific user's bandit model using WASM.
    private async updateBanditModel(banditModel: BanditModelState, embedding: number[], reward: number, userId: string): Promise<void> {
        // embedding の厳密な検証
        if (!embedding) {
            this.logWarning("Cannot update bandit model: embedding is null or undefined.", { userId });
            return;
        }
        if (!Array.isArray(embedding)) {
            this.logWarning("Cannot update bandit model: embedding is not an array.", { userId, embeddingType: typeof embedding });
            return;
        }
        if (embedding.length !== banditModel.dimension) {
            this.logWarning("Cannot update bandit model: embedding dimension mismatch.", { userId, embeddingLength: embedding.length, modelDimension: banditModel.dimension });
            return;
        }
        if (!embedding.every(e => typeof e === 'number' && isFinite(e))) {
            this.logWarning("Cannot update bandit model: embedding contains non-finite numbers (NaN/Infinity).", {
                userId,
                embeddingSample: embedding.slice(0, 5), // 最初の5要素をログに記録
                embeddingLength: embedding.length,
            });
            return;
        }

        try {
            // WASM 側の BanditModel 構造体に合うようにデータを変換
            const wasmModel = {
                a_inv: Array.from(banditModel.A_inv),
                b: Array.from(banditModel.b),
                dimension: banditModel.dimension,
            };

            // WASM 関数を呼び出し、更新されたモデルを受け取る
            const updatedWasmModel = update_bandit_model(
                wasmModel,
                new Float64Array(embedding),
                reward
            );

            // 更新されたモデルで inMemoryModels を更新
            banditModel.A_inv = updatedWasmModel.a_inv;
            banditModel.b = updatedWasmModel.b;
            // dimension は変わらないので更新不要

            this.logDebug(`Bandit model updated for user ${userId} with reward ${reward.toFixed(2)}.`, { userId, reward });

            // バンディットモデル更新後、ユーザープロファイルの埋め込みも更新
            await this.updateUserProfileEmbeddingInD1(userId, banditModel);
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logError("Error during WASM bandit model update:", err, {
                userId,
                reward,
                embeddingLength: embedding?.length,
                embeddingStart: embedding ? embedding.slice(0, 5) : 'N/A', // 最初の5要素をログに記録
                errorName: err.name,
                errorMessage: err.message,
                stack: err.stack,
            });
        }
    }
}
