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

// Durable Object class for managing click logs and bandit model per user
export class ClickLogger extends DurableObject {
    state: DurableObjectState;
    env: EnvWithDurableObjects;

    private banditModel: BanditModelState | null = null;
    private readonly banditStateKey = 'banditModelState.json'; // R2に保存するオブジェクトのキー

    constructor(state: DurableObjectState, env: EnvWithDurableObjects) {
        super(state, env); // 親クラスのコンストラクターを呼び出す
        this.state = state;
        this.env = env;

        // Durable Object が初めてロードされたときに状態を読み込む
        this.state.blockConcurrencyWhile(async () => {
            await this.cleanupOldDOData(); // 古いDOデータをクリーンアップ
            await this.loadState();
        });
    }

    // Durable Object の古いデータをクリーンアップするメソッド
    private async cleanupOldDOData(): Promise<void> {
        logInfo(`Cleaning up old Durable Object data for ${this.state.id.toString()}`);
        try {
            // Durable Object のストレージからすべてのキーをリストアップし、削除
            const allKeys = await this.state.storage.list();
            const keysToDelete = Array.from(allKeys.keys());
            if (keysToDelete.length > 0) {
                await this.state.storage.delete(keysToDelete);
                logInfo(`Deleted ${keysToDelete.length} old keys from Durable Object storage for ${this.state.id.toString()}`);
            } else {
                logInfo(`No old data found in Durable Object storage for ${this.state.id.toString()}`);
            }
        } catch (error) {
            logError(`Error cleaning up old Durable Object data for ${this.state.id.toString()}:`, error);
        }
    }

    // Durable Object の状態（バンディットモデル）をR2から読み込む
    private async loadState(): Promise<void> {
        const userId = this.state.id.toString();
        const objectKey = `${userId}/${this.banditStateKey}`; // ユーザーIDごとにフォルダ分け

        try {
            const object = await this.env.BANDIT_MODELS.get(objectKey);

            if (object !== null) {
                const stateText = await object.text();
                const loadedState = JSON.parse(stateText) as BanditModelState;

                // 読み込んだデータが正しい形式か基本的なチェックを行う
                if (Array.isArray(loadedState.A) && Array.isArray(loadedState.b) && typeof loadedState.dimension === 'number' && typeof loadedState.alpha === 'number') {
                    this.banditModel = loadedState;
                    logInfo(`Loaded bandit model state from R2 for ${userId}`);
                } else {
                    logWarning(`Invalid bandit model data format in R2 for ${userId}. Initializing new model.`);
                    await this.initializeNewBanditModel();
                }
            } else {
                // モデルがまだR2に存在しない場合は初期化
                logInfo(`Bandit model state not found in R2 for ${userId}. Initializing new model.`);
                await this.initializeNewBanditModel();
            }
        } catch (error) {
            logError(`Error loading bandit model state from R2 for ${userId}:`, error);
            logWarning(`Initializing new bandit model due to loading error for ${userId}.`);
            await this.initializeNewBanditModel();
        }
    }

    // 新しいバンディットモデルを初期化するヘルパーメソッド
    private async initializeNewBanditModel(): Promise<void> {
        // OpenAI Embedding API (text-embedding-3-small) の次元数 1536 で設定する。
        const dimension = 1536; // OpenAI Embedding API の次元数
        this.banditModel = {
            A: Array(dimension).fill(0).map(() => Array(dimension).fill(0)),
            b: Array(dimension).fill(0),
            dimension: dimension,
            alpha: 0.1, // UCB パラメータ alpha
        };
        // A を単位行列で初期化 (LinUCB の標準的な初期化)
        for (let i = 0; i < dimension; i++) {
            this.banditModel.A[i][i] = 1.0;
        }
        logInfo(`Initialized new bandit model state with dimension ${dimension} for ${this.state.id.toString()}`);
        // 初期状態を保存
        await this.saveState();
    }

    // Durable Object の状態（バンディットモデル）をR2に保存する
    private async saveState(): Promise<void> {
        if (this.banditModel) {
            const userId = this.state.id.toString();
            const objectKey = `${userId}/${this.banditStateKey}`; // ユーザーIDごとにフォルダ分け

            try {
                // JSON形式で保存
                const stateJson = JSON.stringify(this.banditModel);
                await this.env.BANDIT_MODELS.put(objectKey, stateJson);
                logInfo(`Saved bandit model state to R2 for ${userId}`);
            } catch (error) {
                logError(`Error saving bandit model state to R2 for ${userId}:`, error);
                // エラーハンドリングを検討 (リトライ、アラートなど)
            }
        }
    }

    // Handle requests to the Durable Object
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;
        const userId = this.state.id.toString();

        // /get-ucb-values エンドポイントのリクエストボディの型定義
        interface GetUcbValuesRequestBody {
            articlesWithEmbeddings: { articleId: string, embedding: number[] }[];
        }

        // /log-sent-articles エンドポイントのリクエストボディの型定義
        interface LogSentArticlesRequestBody {
            sentArticles: { articleId: string, timestamp: number, embedding: number[] }[];
        }

        // /log-click エンドポイントのリクエストボディの型定義
        interface LogClickRequestBody {
            articleId: string;
            timestamp: number;
        }

        // /update-bandit-from-click エンドポイントのリクエストボディの型定義
        interface UpdateBanditFromClickRequestBody {
            articleId: string;
            embedding: number[];
            reward: number;
        }

        // /learn-from-education エンドポイントのリクエストボディの型定義
        interface LearnFromEducationRequestBody {
            selectedArticles: { articleId: string, embedding: number[] }[];
        }

        if (request.method === 'POST' && path === '/log-click') {
            try {
                const { articleId, timestamp } = await request.json() as LogClickRequestBody;

                if (!articleId || timestamp === undefined) {
                    logWarning('Log click failed: Missing articleId or timestamp in request body.');
                    return new Response('Missing parameters', { status: 400 });
                }

                // D1にクリックログを保存
                await this.env.USER_DB.prepare(
                    `INSERT INTO click_logs (user_id, article_id, timestamp) VALUES (?, ?, ?)`
                ).bind(userId, articleId, timestamp).run();

                logInfo(`Logged click for user ${userId}, article ${articleId} at ${timestamp}`);

                return new Response('Click logged', { status: 200 });

            } catch (error) {
                logError('Error logging click:', error, { userId, requestUrl: request.url });
                return new Response('Error logging click', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/get-ucb-values') {
             try {
                if (!this.banditModel) {
                    // モデルがロードされていない場合はエラー
                     return new Response('Bandit model not loaded', { status: 500 });
                }

                const { articlesWithEmbeddings } = await request.json() as GetUcbValuesRequestBody; // 記事リストと埋め込みベクトルを受け取る
                if (!Array.isArray(articlesWithEmbeddings)) {
                     return new Response('Invalid input: articlesWithEmbeddings must be an array', { status: 400 });
                }

                const ucbValues = this.getUCBValues(articlesWithEmbeddings);

                return new Response(JSON.stringify(ucbValues), {
                    headers: { 'Content-Type': 'application/json' },
                    status: 200
                });

            } catch (error) {
                logError('Error getting UCB values:', error);
                return new Response('Error getting UCB values', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/log-sent-articles') {
            try {
                const { sentArticles } = await request.json() as LogSentArticlesRequestBody;
                if (!Array.isArray(sentArticles)) {
                    return new Response('Invalid input: sentArticles must be an array', { status: 400 });
                }

                logInfo(`Logging ${sentArticles.length} sent articles for user ${userId}`);

                // D1に送信ログを保存
                const insertPromises = sentArticles.map(async article => {
                    const embeddingString = article.embedding ? JSON.stringify(article.embedding) : null;
                    await this.env.USER_DB.prepare(
                        `INSERT INTO sent_articles (user_id, article_id, timestamp, embedding) VALUES (?, ?, ?, ?)`
                    ).bind(userId, article.articleId, article.timestamp, embeddingString).run();
                });
                await Promise.all(insertPromises);

                logInfo(`Successfully logged sent articles for user ${userId}`);

                return new Response('Sent articles logged', { status: 200 });

            } catch (error) {
                logError('Error logging sent articles:', error);
                return new Response('Error logging sent articles', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/decay-rewards') {
            // このエンドポイントは定期バッチ処理に置き換えられるため、ここでは何もしないか、廃止する
            logWarning('/decay-rewards endpoint is deprecated and will be replaced by a batch process.');
            return new Response('Deprecated endpoint', { status: 405 }); // Method Not Allowed or similar
        } else if (request.method === 'POST' && path === '/learn-from-education') {
            try {
                const { selectedArticles } = await request.json() as LearnFromEducationRequestBody;

                if (!Array.isArray(selectedArticles)) {
                    logWarning('Learn from education failed: selectedArticles is not an array.');
                    return new Response('Invalid parameters', { status: 400 });
                }

                logInfo(`Learning from ${selectedArticles.length} selected articles for user ${userId}`);

                if (this.banditModel) {
                    const insertPromises = selectedArticles.map(async article => {
                        if (article.embedding) {
                            // ユーザー教育による選択は報酬 1.0 として学習
                            this.updateBanditModel(article.embedding, 1.0);
                            logInfo(`Updated bandit model with education data for article ${article.articleId}`, { userId, articleId: article.articleId });

                            // D1に教育プログラムログを保存
                            await this.env.USER_DB.prepare(
                                `INSERT INTO education_logs (user_id, article_id, timestamp, action) VALUES (?, ?, ?, ?)`
                            ).bind(userId, article.articleId, Date.now(), 'selected').run();
                        } else {
                            logWarning(`Cannot update bandit model or log education data for article ${article.articleId}: embedding missing.`);
                        }
                    });
                    await Promise.all(insertPromises);

                    // 状態全体を保存 (バンディットモデルの更新を含む)
                    if (selectedArticles.length > 0) {
                         await this.saveState();
                         logInfo(`Saved Durable Object state after learning from education.`);
                    }
                } else {
                    logWarning(`Bandit model not initialized. Cannot learn from education or log education data for user ${userId}`);
                }

                return new Response('Learning from education completed', { status: 200 });

            } catch (error) {
                logError('Error learning from education:', error, { userId, requestUrl: request.url });
                return new Response('Error learning from education', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/update-bandit-from-click') {
             try {
                const { articleId, embedding, reward } = await request.json() as UpdateBanditFromClickRequestBody;

                if (!articleId || !embedding || reward === undefined) {
                    logWarning('Update bandit from click failed: Missing parameters.');
                    return new Response('Missing parameters', { status: 400 });
                }

                logInfo(`Updating bandit model from click for article ${articleId} with reward ${reward}`);

                if (this.banditModel) {
                    this.updateBanditModel(embedding, reward);
                    await this.saveState();
                    logInfo(`Successfully updated bandit model from click for article ${articleId}`);
                } else {
                    logWarning(`Bandit model not initialized. Cannot update bandit model from click for article ${articleId}.`);
                    return new Response('Bandit model not initialized', { status: 500 });
                }

                return new Response('Bandit model updated from click', { status: 200 });

            } catch (error) {
                logError('Error updating bandit model from click:', error, { userId, requestUrl: request.url });
                return new Response('Error updating bandit model from click', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/delete-all-data') {
            try {
                logInfo(`Deleting all data for Durable Object ${userId}`);
                await this.state.storage.deleteAll();
                logInfo(`All data deleted for Durable Object ${userId}`);
                return new Response('All data deleted', { status: 200 });
            } catch (error) {
                logError('Error deleting all data:', error, { userId, requestUrl: request.url });
                return new Response('Error deleting all data', { status: 500 });
            }
        }


        // Handle other requests
        return new Response('Not Found', { status: 404 });
    }

    // 記事リストに対して LinUCB の UCB 値を計算する
    private getUCBValues(articles: { articleId: string, embedding: number[] }[]): { articleId: string, ucb: number }[] {
        if (!this.banditModel || this.banditModel.dimension === 0) {
            logWarning("Bandit model not initialized or dimension is zero. Cannot calculate UCB values.");
            return articles.map(article => ({ articleId: article.articleId, ucb: 0 })); // UCB値ゼロを返す
        }

        const { A, b, alpha, dimension } = this.banditModel;
        const ucbResults: { articleId: string, ucb: number }[] = [];

        try {
            // A の逆行列を計算
            const A_inv = invertMatrix(A);

            for (const article of articles) {
                const x = article.embedding; // 記事の特徴量ベクトル (embedding)

                if (!x || x.length !== dimension) {
                    logWarning(`Article ${article.articleId} has invalid or missing embedding.`, { articleId: article.articleId });
                    ucbResults.push({ articleId: article.articleId, ucb: 0 }); // UCB値ゼロ
                    continue;
                }

                // LinUCB の UCB 計算式: p_t(a) = x_t(a)^T * hat_theta_a + alpha * sqrt(x_t(a)^T * A_a_inverse * x_t(a))
                // hat_theta_a = A_a_inverse * b_a
                // ここではグローバルな A, b を使っているので、hat_theta = A_inverse * b となります。
                const hat_theta = multiplyMatrixVector(A_inv, b);

                // UCB 値の計算
                const term1 = dotProduct(x, hat_theta); // x^T * hat_theta

                // Calculate x^T * A_inv
                const x_T_A_inv: number[] = [];
                const A_inv_T = transposeMatrix(A_inv); // Transpose A_inv to easily get columns as rows
                for (let i = 0; i < dimension; i++) {
                    x_T_A_inv.push(dotProduct(x, A_inv_T[i])); // Dot product of x and i-th column of A_inv
                }

                const term2_sqrt = dotProduct(x_T_A_inv, x); // (x^T * A_inv) * x
                const term2 = alpha * Math.sqrt(term2_sqrt); // alpha * sqrt(x^T * A_inv * x)

                const ucb = term1 + term2;

                ucbResults.push({ articleId: article.articleId, ucb: ucb });
            }
        } catch (error) {
            logError("Error during UCB calculation:", error);
            // エラーが発生した場合は、全ての記事に対してUCB値ゼロを返すか、エラーを伝えるか検討
            // ここではUCB値ゼロを返します。
            return articles.map(article => ({ articleId: article.articleId, ucb: 0 }));
        }


        return ucbResults;
    }

    // バンディットモデルを更新するメソッド
    // このメソッドは、教育プログラムからの学習時と、定期バッチ処理によるクリックログからの学習時に使用される
    private updateBanditModel(embedding: number[], reward: number): void {
        if (!this.banditModel || embedding.length !== this.banditModel.dimension) {
            logWarning("Cannot update bandit model: model not initialized or embedding dimension mismatch.");
            return;
        }

        const { A, b } = this.banditModel;
        const x = embedding;

        // A = A + x * x^T (行列の外積を加算)
        for (let i = 0; i < this.banditModel.dimension; i++) {
            for (let j = 0; j < this.banditModel.dimension; j++) {
                A[i][j] += x[i] * x[j];
            }
        }

        // b = b + reward * x (ベクトルに加算)
        for (let i = 0; i < this.banditModel.dimension; i++) {
            b[i] += reward * x[i];
        }
    }
}
