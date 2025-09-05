// src/clickLogger.ts

import { initLogger } from './logger';
import { DurableObject } from 'cloudflare:workers';
import { NewsArticle } from './newsCollector';
import { Env } from './index';

// Contextual Bandit (LinUCB) モデルの状態を保持するインターフェース
interface BanditModelState {
    A: number[][]; // d x d 行列
    A_inv: number[][]; // A の逆行列 (d x d 行列)
    b: number[];   // d x 1 ベクトル
    dimension: number; // 特徴量ベクトルの次元 (embedding の次元)
    alpha: number;
}

// Helper function for dot product of two vectors
function dotProduct(v1: number[], v2: number[]): number {
    if (v1.length !== v2.length) {
        throw new Error("Vector dimensions mismatch for dot product.");
    }
    let sum = 0;
    for (let i = 0; i < v1.length; i++) {
        sum += v1[i] * v2[i];
    }
    return sum;
}

// Helper function for matrix-vector multiplication (result = matrix * vector)
function multiplyMatrixVector(matrix: number[][], vector: number[]): number[] {
    const rows = matrix.length;
    const cols = matrix[0].length;
    if (cols !== vector.length) {
        throw new Error("Matrix columns must match vector dimension for multiplication.");
    }
    const result: number[] = Array(rows).fill(0);
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            result[i] += matrix[i][j] * vector[j];
        }
    }
    return result;
}

// Helper function to transpose a matrix
function transposeMatrix(matrix: number[][]): number[][] {
    const rows = matrix.length;
    const cols = matrix[0].length;
    const result: number[][] = Array(cols).fill(0).map(() => Array(rows).fill(0));
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            result[j][i] = matrix[i][j];
        }
    }
    return result;
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
    env: ClickLoggerEnv; // EnvWithDurableObjects の代わりに ClickLoggerEnv を使用

    private inMemoryModels: Map<string, BanditModelState>;
    private readonly modelsR2Key = 'bandit_models.json'; // Key for the aggregated models file in R2
    private dirty: boolean; // Flag to track if in-memory models have changed

    // ロガー関数をインスタンス変数として保持
    private logError: (message: string, error: any, details?: any) => void;
    private logInfo: (message: string, details?: any) => void;
    private logWarning: (message: string, details?: any) => void;
    private logDebug: (message: string, details?: any) => void;

    constructor(state: DurableObjectState, env: ClickLoggerEnv) { // EnvWithDurableObjects の代わりに ClickLoggerEnv を使用
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
            await this.loadModelsFromR2();
        });
    }

    // Load all bandit models from a single R2 object.
    private async loadModelsFromR2(): Promise<void> {
        this.logInfo(`Attempting to load all bandit models from R2 key: ${this.modelsR2Key}`);
        try {
            const object = await this.env.BANDIT_MODELS.get(this.modelsR2Key);

            if (object !== null) {
                const models = await object.json<Record<string, BanditModelState>>();
                this.inMemoryModels = new Map(Object.entries(models));
                this.logInfo(`Successfully loaded ${this.inMemoryModels.size} bandit models from R2.`);
            } else {
                this.logInfo('No existing bandit models file found in R2. Starting with an empty map.');
                this.inMemoryModels = new Map<string, BanditModelState>();
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
        this.logInfo(`Attempting to save ${this.inMemoryModels.size} bandit models to R2.`);
        try {
            const modelsObject = Object.fromEntries(this.inMemoryModels);
            await this.env.BANDIT_MODELS.put(this.modelsR2Key, JSON.stringify(modelsObject));
            this.dirty = false; // Reset dirty flag after successful save
            this.logInfo('Successfully saved all bandit models to R2.');
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
        const dimension = 256; // Dimension for text-embedding-3-small
        const newModel: BanditModelState = {
            A: Array(dimension).fill(0).map(() => Array(dimension).fill(0)),
            A_inv: Array(dimension).fill(0).map(() => Array(dimension).fill(0)), // A_inv を初期化
            b: Array(dimension).fill(0),
            dimension: dimension,
            alpha: 0.5, // UCB parameter
        };
        // Initialize A and A_inv as identity matrices
        for (let i = 0; i < dimension; i++) {
            newModel.A[i][i] = 1.0;
            newModel.A_inv[i][i] = 1.0; // A_inv も単位行列で初期化
        }
        this.inMemoryModels.set(userId, newModel);
        this.dirty = true;
        this.logInfo(`Initialized new bandit model for userId: ${userId}`);
        return newModel;
    }

    async alarm() {
        // This alarm is triggered periodically to save dirty models to R2 and process unclicked articles.
        if (this.dirty) {
            this.logInfo('Alarm triggered. Saving dirty models to R2.');
            await this.saveModelsToR2();
        } else {
            this.logInfo('Alarm triggered, but no changes to save.');
        }

        // Process unclicked articles
        await this.processUnclickedArticles();
    }

    // Helper to ensure an alarm is set.
    private async ensureAlarmIsSet(): Promise<void> {
        const currentAlarm = await this.state.storage.getAlarm();
        if (currentAlarm === null) {
            this.logInfo('Alarm not set. Setting a new alarm to run in 60 minutes.');
            // Set an alarm to run in 60 minutes (3600 * 1000 ms)
            const oneHour = 60 * 60 * 1000;
            await this.state.storage.setAlarm(Date.now() + oneHour);
        }
    }

    // Handle requests to the Durable Object
    async fetch(request: Request): Promise<Response> {
        // Ensure an alarm is set to periodically save data.
        await this.ensureAlarmIsSet();

        const url = new URL(request.url);
        const path = url.pathname;

        // /get-ucb-values エンドポイントのリクエストボディの型定義
        interface GetUcbValuesRequestBody {
            userId: string;
            articlesWithEmbeddings: { articleId: string, embedding: number[] }[];
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

        // /learn-from-education エンドポイントのリクエストボディの型定義
        interface LearnFromEducationRequestBody {
            userId: string;
            selectedArticles: { articleId: string, embedding: number[] }[];
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
        } else if (request.method === 'POST' && path === '/get-ucb-values') {
             try {
                const { userId, articlesWithEmbeddings } = await request.json() as GetUcbValuesRequestBody;
                if (!userId || !Array.isArray(articlesWithEmbeddings)) {
                     return new Response('Invalid input: userId and articlesWithEmbeddings array are required', { status: 400 });
                }

                let banditModel = this.inMemoryModels.get(userId);
                if (!banditModel) {
                    this.logWarning(`No model found for user ${userId} in get-ucb-values. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

                const ucbValues = this.getUCBValues(banditModel, articlesWithEmbeddings);
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
                    this.logInfo(`No valid sent articles to log for user ${userId}.`, { userId });
                }

                this.logInfo(`Successfully logged ${sentArticles.length} sent articles for user ${userId}`);
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
                    if (article.embedding) {
                        this.updateBanditModel(banditModel, article.embedding, 1.0, userId);
                        logStatements.push(
                            this.env.DB.prepare(
                                `INSERT INTO education_logs (user_id, article_id, timestamp, action) VALUES (?, ?, ?, ?)`
                            ).bind(userId, article.articleId, Date.now(), 'selected')
                        );
                    }
                }
                
                if (logStatements.length > 0) {
                    await this.env.DB.batch(logStatements);
                    this.dirty = true;
                    this.logInfo(`Learned from ${logStatements.length} articles and updated bandit model for user ${userId}.`);
                    await this.saveModelsToR2();
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
                        this.updateBanditModel(banditModel, embed.embedding, 1.0, userId); // 報酬は1.0
                        this.logInfo(`Updated bandit model for user ${userId} with embedding for article ${embed.articleId}.`);
                    }
                    this.dirty = true; // モデルが変更されたことをマーク
                    await this.saveModelsToR2(); // モデルをR2に保存
                } else {
                    this.logInfo('Embedding completed callback received without userId. Skipping bandit model update.', { embeddingsCount: embeddings.length });
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

                this.updateBanditModel(banditModel, embedding, reward, userId);
                this.dirty = true;
                this.logInfo(`Successfully updated bandit model from click for article ${articleId} for user ${userId}`);
                await this.saveModelsToR2();
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
        this.logInfo('Starting to process unclicked articles.');
        try {
            // Get all user IDs that have sent articles
            const { results } = await this.env.DB.prepare(`SELECT DISTINCT user_id FROM sent_articles`).all<{ user_id: string }>();
            const userIds = results.map(row => row.user_id);
            this.logInfo(`Found ${userIds.length} users with sent articles to process.`, { userCount: userIds.length });

            const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000); // 24時間前

            for (const userId of userIds) {
                this.logInfo(`Processing unclicked articles for user: ${userId}`, { userId });
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
                            this.updateBanditModel(banditModel, JSON.parse(article.embedding) as number[], -0.1, userId);
                            this.dirty = true;
                            updatedCount++;
                        }
                    }
                    this.logInfo(`Updated bandit model for user ${userId} with -0.1 reward for ${updatedCount} unclicked articles.`, { userId, updatedCount });
                } else {
                    this.logInfo(`No unclicked articles found for user ${userId} within the last 24 hours.`, { userId });
                }
            }
            this.logInfo('Finished processing unclicked articles.');
        } catch (error) {
            this.logError('Error processing unclicked articles:', error);
        }
    }

    // Calculate UCB values for a list of articles for a specific user model.
    private getUCBValues(banditModel: BanditModelState, articles: { articleId: string, embedding: number[] }[]): { articleId: string, ucb: number }[] {
        if (banditModel.dimension === 0) {
            this.logWarning("Bandit model dimension is zero. Cannot calculate UCB values.");
            return articles.map(article => ({ articleId: article.articleId, ucb: 0 }));
        }

        const { A_inv, b, alpha, dimension } = banditModel; // A_inv を使用
        const ucbResults: { articleId: string, ucb: number }[] = [];

        try {
            for (const article of articles) {
                const x = article.embedding;

                if (!x || x.length !== dimension) {
                    this.logDebug(`Article ${article.articleId} has invalid or missing embedding.`, { articleId: article.articleId });
                    ucbResults.push({ articleId: article.articleId, ucb: 0 });
                    continue;
                }

                const hat_theta = multiplyMatrixVector(A_inv, b);
                const term1 = dotProduct(x, hat_theta);

                const x_T_A_inv: number[] = [];
                const A_inv_T = transposeMatrix(A_inv);
                for (let i = 0; i < dimension; i++) {
                    x_T_A_inv.push(dotProduct(x, A_inv_T[i]));
                }

                const term2_sqrt = dotProduct(x_T_A_inv, x);
                const term2 = alpha * Math.sqrt(Math.abs(term2_sqrt)); // Use Math.abs for safety

                const ucb = term1 + term2;
                // Limit detailed logging to the first 5 articles or when explicitly in debug mode
                if (ucbResults.length < 5 /* || process.env.DEBUG_UCB === 'true' */) {
                    this.logDebug(`Calculated UCB for article ${article.articleId}: Term1=${term1.toFixed(4)}, Term2=${term2.toFixed(4)}, UCB=${ucb.toFixed(4)}`, { articleId: article.articleId, term1, term2, ucb });
                }
                ucbResults.push({ articleId: article.articleId, ucb: ucb });
            }
        } catch (error) {
            this.logError("Error during UCB calculation:", error);
            return articles.map(article => ({ articleId: article.articleId, ucb: 0 }));
        }
        return ucbResults;
    }

    // Helper to normalize errors to Error objects
    private normalizeError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    // Update a specific user's bandit model.
    private updateBanditModel(banditModel: BanditModelState, embedding: number[], reward: number, userId: string): void {
        if (embedding.length !== banditModel.dimension) {
            this.logWarning("Cannot update bandit model: embedding dimension mismatch.", { userId, embeddingLength: embedding.length, modelDimension: banditModel.dimension });
            return;
        }

        const { A, A_inv, b, dimension } = banditModel; // A_inv を追加
        const x = embedding;

        // Sherman-Morrison formula を使用して A_inv を更新
        // A_new_inv = A_old_inv - (A_old_inv * x * x^T * A_old_inv) / (1 + x^T * A_old_inv * x)

        // 1. A_old_inv * x
        const A_inv_x = multiplyMatrixVector(A_inv, x); // d x 1 ベクトル

        // 2. x^T * A_old_inv * x
        const x_T_A_inv_x = dotProduct(x, A_inv_x); // スカラー

        // 3. denominator = 1 + x^T * A_old_inv * x
        const denominator = 1 + x_T_A_inv_x;

        if (denominator === 0) {
            this.logError("Denominator is zero in Sherman-Morrison update. Skipping update.", null, { userId: userId, embeddingLength: embedding.length, reward });
            return;
        }

        // 4. numerator_matrix = (A_old_inv * x) * (x^T * A_old_inv)
        // (d x 1) * (1 x d) = d x d 行列
        const numerator_matrix: number[][] = Array(dimension).fill(0).map(() => Array(dimension).fill(0));
        for (let i = 0; i < dimension; i++) {
            for (let j = 0; j < dimension; j++) {
                numerator_matrix[i][j] = A_inv_x[i] * A_inv_x[j];
            }
        }

        // 5. A_new_inv = A_old_inv - numerator_matrix / denominator
        for (let i = 0; i < dimension; i++) {
            for (let j = 0; j < dimension; j++) {
                A_inv[i][j] -= numerator_matrix[i][j] / denominator;
            }
        }

        // b = b + reward * x
        for (let i = 0; i < dimension; i++) {
            b[i] += reward * x[i];
        }

        // A は明示的に更新する必要はないが、整合性のため更新する
        // A = A + x * x^T
        for (let i = 0; i < dimension; i++) {
            for (let j = 0; j < dimension; j++) {
                A[i][j] += x[i] * x[j];
            }
        }
        this.logDebug(`Bandit model updated for user ${userId} with reward ${reward.toFixed(2)}.`, { userId, reward });
    }
}
