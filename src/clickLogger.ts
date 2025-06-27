// src/clickLogger.ts

import { logError, logInfo, logWarning } from './logger'; // Import logging helpers
import { DurableObject } from 'cloudflare:workers'; // DurableObject をインポート

interface NewsArticle {
    articleId: string; // D1のarticlesテーブルのPRIMARY KEY
    title: string;
    url: string;
    published_at: number;
    content?: string;
    embedding?: string; // D1ではTEXTとして保存されるため
}

// Contextual Bandit (LinUCB) モデルの状態を保持するインターフェース
interface BanditModelState {
    // LinUCB のパラメータ
    // A: 各アームの特徴量の外積の和 (d x d 行列)
    // b: 各アームの特徴量と報酬の積の和 (d x 1 ベクトル)
    // ここでは簡略化のため、各アーム（記事ID）ごとに A と b を持つ構造を考えます。
    // より効率的な実装では、グローバルな A と b を持ち、アームごとに特徴量ベクトル x を管理します。
    // Durable Object のストレージに保存するため、シリアライズ可能な形式である必要があります。
    // 例: { articleId: { A: number[][], b: number[] } }
    // または、グローバルな A, b と、各記事IDに対応する特徴量ベクトル x を別途管理
    // 今回は、ユーザーごとに Durable Object があるため、グローバルな A, b を Durable Object の状態として持ちます。
    A: number[][]; // d x d 行列
    b: number[];   // d x 1 ベクトル
    // 各アーム（記事）の特徴量ベクトル x は、記事データ自体に含まれる embedding を使用します。
    // バンディットモデルの次元 d は、embedding ベクトルの次元に一致します。
    dimension: number; // 特徴量ベクトルの次元 (embedding の次元)
    // その他のバンディット関連パラメータ (例: alpha for UCB)
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


// Helper function to invert a matrix using Gaussian elimination with partial pivoting
// NOTE: This is a basic implementation and may not be numerically stable for all matrices,
// especially large or ill-conditioned ones. For production use with high-dimensional
// embeddings, consider a dedicated numerical library or a more robust implementation
// like Cholesky decomposition if the matrix is guaranteed to be symmetric positive definite.
function invertMatrix(matrix: number[][]): number[][] {
    const n = matrix.length;
    if (n === 0 || matrix[0].length !== n) {
        throw new Error("Matrix must be square and non-empty.");
    }

    // Create an augmented matrix [matrix | Identity]
    const augmentedMatrix: number[][] = Array(n).fill(0).map(() => Array(2 * n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            augmentedMatrix[i][j] = matrix[i][j];
        }
        augmentedMatrix[i][i + n] = 1; // Add identity matrix
    }

    // Apply Gaussian elimination
    for (let i = 0; i < n; i++) {
        // Find pivot row (partial pivoting)
        let maxRow = i;
        for (let k = i + 1; k < n; k++) {
            if (Math.abs(augmentedMatrix[k][i]) > Math.abs(augmentedMatrix[maxRow][i])) {
                maxRow = k;
            }
        }
        // Swap rows
        [augmentedMatrix[i], augmentedMatrix[maxRow]] = [augmentedMatrix[maxRow], augmentedMatrix[i]];

        // Check for singular matrix
        if (augmentedMatrix[i][i] === 0) {
            throw new Error("Matrix is singular and cannot be inverted.");
        }

        // Normalize pivot row
        const pivot = augmentedMatrix[i][i];
        for (let j = i; j < 2 * n; j++) {
            augmentedMatrix[i][j] /= pivot;
        }

        // Eliminate other rows
        for (let k = 0; k < n; k++) {
            if (k !== i) {
                const factor = augmentedMatrix[k][i];
                for (let j = i; j < 2 * n; j++) {
                    augmentedMatrix[k][j] -= factor * augmentedMatrix[i][j];
                }
            }
        }
    }

    // Extract the inverse matrix (the right half of the augmented matrix)
    const inverse: number[][] = Array(n).fill(0).map(() => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            inverse[i][j] = augmentedMatrix[i][j + n];
        }
    }

    return inverse;
}


// Durable Object class for managing click logs and bandit model per user
interface EnvWithDurableObjects {
    BANDIT_MODELS: R2Bucket; // R2 Bucket binding for bandit model state
    USER_DB: D1Database; // D1 Database binding for user profiles and logs
    DB: D1Database; // D1 Database binding for articles
}

// Durable Object class for managing click logs and bandit models for ALL users.
// This acts as a central hub to minimize R2 access.
export class ClickLogger extends DurableObject {
    state: DurableObjectState;
    env: EnvWithDurableObjects;

    private inMemoryModels: Map<string, BanditModelState>;
    private readonly modelsR2Key = 'bandit_models.json'; // Key for the aggregated models file in R2
    private dirty: boolean; // Flag to track if in-memory models have changed

    constructor(state: DurableObjectState, env: EnvWithDurableObjects) {
        super(state, env);
        this.state = state;
        this.env = env;
        this.inMemoryModels = new Map<string, BanditModelState>();
        this.dirty = false;

        // Load all models from R2 into memory on startup.
        this.state.blockConcurrencyWhile(async () => {
            await this.loadModelsFromR2();
        });
    }

    // Load all bandit models from a single R2 object.
    private async loadModelsFromR2(): Promise<void> {
        logInfo(`Attempting to load all bandit models from R2 key: ${this.modelsR2Key}`);
        try {
            const object = await this.env.BANDIT_MODELS.get(this.modelsR2Key);

            if (object !== null) {
                const models = await object.json<Record<string, BanditModelState>>();
                this.inMemoryModels = new Map(Object.entries(models));
                logInfo(`Successfully loaded ${this.inMemoryModels.size} bandit models from R2.`);
            } else {
                logInfo('No existing bandit models file found in R2. Starting with an empty map.');
                this.inMemoryModels = new Map<string, BanditModelState>();
            }
        } catch (error) {
            logError('Error loading bandit models from R2. Starting fresh.', error);
            // In case of a loading/parsing error, start with a clean slate to avoid corruption.
            this.inMemoryModels = new Map<string, BanditModelState>();
        }
    }

    // Save all in-memory bandit models to a single R2 object.
    private async saveModelsToR2(): Promise<void> {
        logInfo(`Attempting to save ${this.inMemoryModels.size} bandit models to R2.`);
        try {
            const modelsObject = Object.fromEntries(this.inMemoryModels);
            await this.env.BANDIT_MODELS.put(this.modelsR2Key, JSON.stringify(modelsObject));
            this.dirty = false; // Reset dirty flag after successful save
            logInfo('Successfully saved all bandit models to R2.');
        } catch (error) {
            logError('Failed to save bandit models to R2.', error);
        }
    }
    
    // Initialize a new bandit model for a specific user.
    private initializeNewBanditModel(userId: string): BanditModelState {
        const dimension = 1536; // Dimension for text-embedding-3-small
        const newModel: BanditModelState = {
            A: Array(dimension).fill(0).map(() => Array(dimension).fill(0)),
            b: Array(dimension).fill(0),
            dimension: dimension,
            alpha: 0.1, // UCB parameter
        };
        // Initialize A as an identity matrix
        for (let i = 0; i < dimension; i++) {
            newModel.A[i][i] = 1.0;
        }
        this.inMemoryModels.set(userId, newModel);
        this.dirty = true;
        logInfo(`Initialized new bandit model for userId: ${userId}`);
        return newModel;
    }

    async alarm() {
        // This alarm is triggered periodically to save dirty models to R2.
        if (this.dirty) {
            logInfo('Alarm triggered. Saving dirty models to R2.');
            await this.saveModelsToR2();
        } else {
            logInfo('Alarm triggered, but no changes to save.');
        }
    }

    // Helper to ensure an alarm is set.
    private async ensureAlarmIsSet(): Promise<void> {
        const currentAlarm = await this.state.storage.getAlarm();
        if (currentAlarm === null) {
            logInfo('Alarm not set. Setting a new alarm to run in 60 minutes.');
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

        if (request.method === 'POST' && path === '/log-click') {
            try {
                const { userId, articleId, timestamp } = await request.json() as LogClickRequestBody;

                if (!userId || !articleId || timestamp === undefined) {
                    logWarning('Log click failed: Missing userId, articleId, or timestamp.');
                    return new Response('Missing parameters', { status: 400 });
                }

                await this.env.USER_DB.prepare(
                    `INSERT INTO click_logs (user_id, article_id, timestamp) VALUES (?, ?, ?)`
                ).bind(userId, articleId, timestamp).run();

                logInfo(`Logged click for user ${userId}, article ${articleId}`);
                return new Response('Click logged', { status: 200 });

            } catch (error) {
                logError('Error logging click:', error, { requestUrl: request.url });
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
                    logWarning(`No model found for user ${userId} in get-ucb-values. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

                const ucbValues = this.getUCBValues(banditModel, articlesWithEmbeddings);
                return new Response(JSON.stringify(ucbValues), {
                    headers: { 'Content-Type': 'application/json' },
                });

            } catch (error) {
                logError('Error getting UCB values:', error);
                return new Response('Error getting UCB values', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/log-sent-articles') {
            try {
                const { userId, sentArticles } = await request.json() as LogSentArticlesRequestBody;
                if (!userId || !Array.isArray(sentArticles)) {
                    return new Response('Invalid input: userId and sentArticles array are required', { status: 400 });
                }

                const statements = sentArticles.map(article => 
                    this.env.USER_DB.prepare(
                        `INSERT INTO sent_articles (user_id, article_id, timestamp, embedding) VALUES (?, ?, ?, ?)`
                    ).bind(userId, article.articleId, article.timestamp, article.embedding ? JSON.stringify(article.embedding) : null)
                );
                await this.env.USER_DB.batch(statements);

                logInfo(`Successfully logged ${sentArticles.length} sent articles for user ${userId}`);
                return new Response('Sent articles logged', { status: 200 });

            } catch (error) {
                logError('Error logging sent articles:', error);
                return new Response('Error logging sent articles', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/decay-rewards') {
            logWarning('/decay-rewards endpoint is deprecated.');
            return new Response('Deprecated endpoint', { status: 410 });
        } else if (request.method === 'POST' && path === '/learn-from-education') {
            try {
                const { userId, selectedArticles } = await request.json() as LearnFromEducationRequestBody;
                if (!userId || !Array.isArray(selectedArticles)) {
                    return new Response('Invalid parameters: userId and selectedArticles array are required', { status: 400 });
                }

                let banditModel = this.inMemoryModels.get(userId);
                if (!banditModel) {
                    logWarning(`No model found for user ${userId} in learn-from-education. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

                const logStatements = [];
                for (const article of selectedArticles) {
                    if (article.embedding) {
                        this.updateBanditModel(banditModel, article.embedding, 1.0);
                        logStatements.push(
                            this.env.USER_DB.prepare(
                                `INSERT INTO education_logs (user_id, article_id, timestamp, action) VALUES (?, ?, ?, ?)`
                            ).bind(userId, article.articleId, Date.now(), 'selected')
                        );
                    }
                }
                
                if (logStatements.length > 0) {
                    await this.env.USER_DB.batch(logStatements);
                    this.dirty = true;
                    logInfo(`Learned from ${logStatements.length} articles and updated bandit model for user ${userId}.`);
                }

                return new Response('Learning from education completed', { status: 200 });

            } catch (error) {
                logError('Error learning from education:', error, { requestUrl: request.url });
                return new Response('Error learning from education', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/update-bandit-from-click') {
             try {
                const { userId, articleId, embedding, reward } = await request.json() as UpdateBanditFromClickRequestBody;
                if (!userId || !articleId || !embedding || reward === undefined) {
                    return new Response('Missing parameters', { status: 400 });
                }

                let banditModel = this.inMemoryModels.get(userId);
                if (!banditModel) {
                    logWarning(`No model found for user ${userId} in update-bandit-from-click. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

                this.updateBanditModel(banditModel, embedding, reward);
                this.dirty = true;
                logInfo(`Successfully updated bandit model from click for article ${articleId} for user ${userId}`);
                
                return new Response('Bandit model updated', { status: 200 });

            } catch (error) {
                logError('Error updating bandit model from click:', error, { requestUrl: request.url });
                return new Response('Error updating bandit model from click', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/delete-all-data') {
            // This is a destructive operation and should be used with caution.
            // It now deletes the entire R2 object.
            try {
                logInfo(`Deleting all bandit models from R2.`);
                await this.env.BANDIT_MODELS.delete(this.modelsR2Key);
                this.inMemoryModels.clear();
                this.dirty = false;
                logInfo(`All bandit models deleted.`);
                return new Response('All bandit models deleted', { status: 200 });
            } catch (error) {
                logError('Error deleting all bandit models:', error, { requestUrl: request.url });
                return new Response('Error deleting all models', { status: 500 });
            }
        }


        // Handle other requests
        return new Response('Not Found', { status: 404 });
    }

    // Calculate UCB values for a list of articles for a specific user model.
    private getUCBValues(banditModel: BanditModelState, articles: { articleId: string, embedding: number[] }[]): { articleId: string, ucb: number }[] {
        if (banditModel.dimension === 0) {
            logWarning("Bandit model dimension is zero. Cannot calculate UCB values.");
            return articles.map(article => ({ articleId: article.articleId, ucb: 0 }));
        }

        const { A, b, alpha, dimension } = banditModel;
        const ucbResults: { articleId: string, ucb: number }[] = [];

        try {
            const A_inv = invertMatrix(A);

            for (const article of articles) {
                const x = article.embedding;

                if (!x || x.length !== dimension) {
                    logWarning(`Article ${article.articleId} has invalid or missing embedding.`);
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

                ucbResults.push({ articleId: article.articleId, ucb: term1 + term2 });
            }
        } catch (error) {
            logError("Error during UCB calculation:", error);
            return articles.map(article => ({ articleId: article.articleId, ucb: 0 }));
        }
        return ucbResults;
    }

    // Update a specific user's bandit model.
    private updateBanditModel(banditModel: BanditModelState, embedding: number[], reward: number): void {
        if (embedding.length !== banditModel.dimension) {
            logWarning("Cannot update bandit model: embedding dimension mismatch.");
            return;
        }

        const { A, b, dimension } = banditModel;
        const x = embedding;

        // A = A + x * x^T
        for (let i = 0; i < dimension; i++) {
            for (let j = 0; j < dimension; j++) {
                A[i][j] += x[i] * x[j];
            }
        }

        // b = b + reward * x
        for (let i = 0; i < dimension; i++) {
            b[i] += reward * x[i];
        }
    }
}
