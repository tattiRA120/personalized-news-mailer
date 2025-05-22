// src/clickLogger.ts

import { logError, logInfo, logWarning } from './logger'; // Import logging helpers

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

interface ClickEvent {
    articleId: string;
    timestamp: number; // Using Unix timestamp
    // Add other event data as needed
    // クリックイベント発生時の記事の特徴量（embedding）はDO側で取得する
    // embedding?: number[];
    // バンディットモデル更新のための報酬
    // reward?: number; // reward はクリックイベントなので 1.0 固定とする
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
export class ClickLogger implements DurableObject {
    state: DurableObjectState;
    env: {
        ARTICLE_EMBEDDINGS: KVNamespace; // KV Namespace binding
    };

    private banditModel: BanditModelState | null = null;
    // Durable Object ストレージにはバンディットモデル全体ではなく、KVのキーなどを保存する
    // private readonly banditStateKey = 'banditModelState';

    constructor(state: DurableObjectState, env: { ARTICLE_EMBEDDINGS: KVNamespace }) {
        this.state = state;
        this.env = env;

        // Durable Object が初めてロードされたときに状態を読み込む
        this.state.blockConcurrencyWhile(async () => {
            await this.loadState();
        });
    }

    // Durable Object の状態（バンディットモデル）をストレージから読み込む
    private async loadState(): Promise<void> {
        // Durable Object ストレージからバンディットモデルの状態を読み込む代わりに、KVから読み込む
        const A_str = await this.env.ARTICLE_EMBEDDINGS.get(`${this.state.id.toString()}_A`);
        const b_str = await this.env.ARTICLE_EMBEDDINGS.get(`${this.state.id.toString()}_b`);
        const dimension_str = await this.env.ARTICLE_EMBEDDINGS.get(`${this.state.id.toString()}_dimension`);
        const alpha_str = await this.env.ARTICLE_EMBEDDINGS.get(`${this.state.id.toString()}_alpha`);


        if (A_str !== null && b_str !== null && dimension_str !== null && alpha_str !== null) {
             try {
                const A = JSON.parse(A_str);
                const b = JSON.parse(b_str);
                const dimension = parseInt(dimension_str, 10);
                const alpha = parseFloat(alpha_str);

                // 読み込んだデータが正しい形式か基本的なチェックを行う
                if (Array.isArray(A) && Array.isArray(b) && typeof dimension === 'number' && typeof alpha === 'number') {
                     this.banditModel = { A, b, dimension, alpha };
                     logInfo(`Loaded bandit model state from KV for ${this.state.id.toString()}`);
                } else {
                     logWarning(`Invalid bandit model data format in KV for ${this.state.id.toString()}. Initializing new model.`);
                     await this.initializeNewBanditModel();
                }
             } catch (error) {
                 logError(`Error parsing bandit model state from KV for ${this.state.id.toString()}:`, error);
                 logWarning(`Initializing new bandit model due to parsing error for ${this.state.id.toString()}.`);
                 await this.initializeNewBanditModel();
             }
        } else {
            // モデルがまだ存在しない場合は初期化
            logInfo(`Bandit model state not found in KV for ${this.state.id.toString()}. Initializing new model.`);
            await this.initializeNewBanditModel();
        }
    }

    // 新しいバンディットモデルを初期化するヘルパーメソッド
    private async initializeNewBanditModel(): Promise<void> {
        // OpenAI Embedding API (text-multilingual-embedding-002) の次元数 1536 で設定する。
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


    // Durable Object の状態（バンディットモデル）をストレージに保存する
    private async saveState(): Promise<void> {
        if (this.banditModel) {
            // バンディットモデル全体ではなく、A, b, dimension, alpha を個別にKVに保存する
            const { A, b, dimension, alpha } = this.banditModel;
            const userId = this.state.id.toString();

            try {
                await this.env.ARTICLE_EMBEDDINGS.put(`${userId}_A`, JSON.stringify(A));
                await this.env.ARTICLE_EMBEDDINGS.put(`${userId}_b`, JSON.stringify(b));
                await this.env.ARTICLE_EMBEDDINGS.put(`${userId}_dimension`, dimension.toString());
                await this.env.ARTICLE_EMBEDDINGS.put(`${userId}_alpha`, alpha.toString());
                logInfo(`Saved bandit model state to KV for ${userId}`);
            } catch (error) {
                logError(`Error saving bandit model state to KV for ${userId}:`, error);
                // エラーハンドリングを検討 (リトライ、アラートなど)
            }
        }
    }

    // Handle requests to the Durable Object
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;

        // /get-ucb-values エンドポイントのリクエストボディの型定義
        interface GetUcbValuesRequestBody {
            articlesWithEmbeddings: { articleId: string, embedding: number[] }[];
        }

        // /log-sent-articles エンドポイントのリクエストボディの型定義
        interface LogSentArticlesRequestBody {
            sentArticles: { articleId: string, timestamp: number }[];
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

        if (request.method === 'POST' && path === '/log-click') {
            try {
                // リクエストボディからクリック情報を取得
                const { articleId, timestamp } = await request.json() as LogClickRequestBody;

                if (!articleId || timestamp === undefined) {
                    logWarning('Log click failed: Missing articleId or timestamp in request body.');
                    return new Response('Missing parameters', { status: 400 });
                }

                // クリックイベントをストレージに保存
                // キーフォーマット: click:<timestamp>:<articleId>
                const eventKey = `click:${timestamp}:${articleId}`;
                await this.state.storage.put(eventKey, { articleId, timestamp });

                logInfo(`Logged click for user ${this.state.id.toString()}, article ${articleId} at ${timestamp}`);

                // バンディットモデルの更新は定期バッチ処理で行うため、ここでは行わない

                return new Response('Click logged', { status: 200 });

            } catch (error) {
                logError('Error logging click:', error, { userId: this.state.id.toString(), requestUrl: request.url });
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
                // 送信ログを保存するのみで、embeddingは保存しない
                const { sentArticles } = await request.json() as LogSentArticlesRequestBody;
                if (!Array.isArray(sentArticles)) {
                    return new Response('Invalid input: sentArticles must be an array', { status: 400 });
                }

                logInfo(`Logging ${sentArticles.length} sent articles for user ${this.state.id.toString()}`);

                // 送信ログを保存
                const putPromises = sentArticles.map(async article => {
                    // キーフォーマット: sent:<timestamp>:<articleId>
                    const logKey = `sent:${article.timestamp}:${article.articleId}`;
                    await this.state.storage.put(logKey, { articleId: article.articleId, timestamp: article.timestamp });
                });
                await Promise.all(putPromises);

                logInfo(`Successfully logged sent articles for user ${this.state.id.toString()}`);

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
                // /learn-from-education エンドポイントのリクエストボディの型定義
                interface LearnFromEducationRequestBody {
                    selectedArticles: { articleId: string, embedding: number[] }[];
                }

                // リクエストボディから選択された記事のembeddingリストを取得
                const { selectedArticles } = await request.json() as LearnFromEducationRequestBody;

                if (!Array.isArray(selectedArticles)) {
                    logWarning('Learn from education failed: selectedArticles is not an array.');
                    return new Response('Invalid parameters', { status: 400 });
                }

                logInfo(`Learning from ${selectedArticles.length} selected articles for user ${this.state.id.toString()}`);

                if (this.banditModel) {
                    // 各選択された記事のembeddingでバンディットモデルを更新し、教育プログラムログを保存
                    const putPromises = selectedArticles.map(async article => {
                        if (article.embedding) {
                            // ユーザー教育による選択は報酬 1.0 として学習
                            this.updateBanditModel(article.embedding, 1.0);
                            logInfo(`Updated bandit model with education data for article ${article.articleId}`, { userId: this.state.id.toString(), articleId: article.articleId });

                            // 教育プログラムログを保存
                            // キーフォーマット: education:<timestamp>:<articleId>
                            const logKey = `education:${Date.now()}:${article.articleId}`;
                            await this.state.storage.put(logKey, { articleId: article.articleId, timestamp: Date.now() });
                        } else {
                            logWarning(`Cannot update bandit model or log education data for article ${article.articleId}: embedding missing.`);
                        }
                    });
                    await Promise.all(putPromises);


                    // 状態全体を保存 (バンディットモデルの更新を含む)
                    if (selectedArticles.length > 0) {
                         await this.saveState();
                         logInfo(`Saved Durable Object state after learning from education.`);
                    }
                } else {
                    logWarning(`Bandit model not initialized. Cannot learn from education or log education data for user ${this.state.id.toString()}`);
                }


                return new Response('Learning from education completed', { status: 200 });

            } catch (error) {
                logError('Error learning from education:', error, { userId: this.state.id.toString(), requestUrl: request.url });
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
                logError('Error updating bandit model from click:', error, { userId: this.state.id.toString(), requestUrl: request.url });
                return new Response('Error updating bandit model from click', { status: 500 });
            }
        }else if (request.method === 'POST' && path === '/delete-all-data') {
            try {
                logInfo(`Deleting all data for Durable Object ${this.state.id.toString()}`);
                await this.state.storage.deleteAll();
                logInfo(`All data deleted for Durable Object ${this.state.id.toString()}`);
                return new Response('All data deleted', { status: 200 });
            } catch (error) {
                logError('Error deleting all data:', error, { userId: this.state.id.toString(), requestUrl: request.url });
                return new Response('Error deleting all data', { status: 500 });
            }
        }


        // Handle other requests
        return new Response('Not Found', { status: 404 });
    }

    // 教育プログラムログを取得するメソッド
    async getEducationLogs(startTime?: number, endTime?: number): Promise<{ articleId: string; timestamp: number; }[]> {
        logInfo(`Getting education logs for user ${this.state.id.toString()}`, { userId: this.state.id.toString(), startTime, endTime });
        const logs: { articleId: string; timestamp: number; }[] = [];
        // Durable Object のストレージから education: プレフィックスで始まるキーをリストアップ
        // キーフォーマット: education:<timestamp>:<articleId>
        const listResult = await this.state.storage.list({ prefix: 'education:' });

        for (const [key, value] of listResult.entries()) {
            // キーから articleId と timestamp を抽出
            const parts = key.split(':');
            if (parts.length >= 3) {
                 const timestamp = parseInt(parts[1], 10);
                 const articleId = parts.slice(2).join(':'); // articleId にコロンが含まれる可能性を考慮

                 if ((startTime === undefined || timestamp >= startTime) && (endTime === undefined || timestamp <= endTime)) {
                     logs.push({ articleId, timestamp });
                 }
            } else {
                 logWarning(`Invalid education log key format: ${key}`);
            }
        }
        logInfo(`Found ${logs.length} education logs.`, { userId: this.state.id.toString(), count: logs.length });
        return logs;
    }

    // クリックログを取得するメソッド
    async getClickLogs(startTime?: number, endTime?: number): Promise<{ articleId: string; timestamp: number; }[]> {
        logInfo(`Getting click logs for user ${this.state.id.toString()}`, { userId: this.state.id.toString(), startTime, endTime });
        const logs: { articleId: string; timestamp: number; }[] = [];
        // Durable Object のストレージから click: プレフィックスで始まるキーをリストアップ
        // キーフォーマット: click:<timestamp>:<articleId>
        const listResult = await this.state.storage.list({ prefix: 'click:' });

        for (const [key, value] of listResult.entries()) {
            // キーから articleId と timestamp を抽出
            const parts = key.split(':');
            if (parts.length >= 3) {
                 const timestamp = parseInt(parts[1], 10);
                 const articleId = parts.slice(2).join(':'); // articleId にコロンが含まれる可能性を考慮

                 if ((startTime === undefined || timestamp >= startTime) && (endTime === undefined || timestamp <= endTime)) {
                     logs.push({ articleId, timestamp });
                 }
            } else {
                 logWarning(`Invalid click log key format: ${key}`);
            }
        }
        logInfo(`Found ${logs.length} click logs.`, { userId: this.state.id.toString(), count: logs.length });
        return logs;
    }

    // 送信ログを取得するメソッド
    async getSentLogs(startTime?: number, endTime?: number): Promise<{ articleId: string; timestamp: number; }[]> {
        logInfo(`Getting sent logs for user ${this.state.id.toString()}`, { userId: this.state.id.toString(), startTime, endTime });
        const logs: { articleId: string; timestamp: number; }[] = [];
        // Durable Object のストレージから sent: プレフィックスで始まるキーをリストアップ
        // キーフォーマット: sent:<timestamp>:<articleId>
        const listResult = await this.state.storage.list({ prefix: 'sent:' });

        for (const [key, value] of listResult.entries()) {
            // キーから articleId と timestamp を抽出
            const parts = key.split(':');
            if (parts.length >= 3) {
                 const timestamp = parseInt(parts[1], 10);
                 const articleId = parts.slice(2).join(':'); // articleId にコロンが含まれる可能性を考慮

                 if ((startTime === undefined || timestamp >= startTime) && (endTime === undefined || timestamp <= endTime)) {
                     logs.push({ articleId, timestamp });
                 }
            } else {
                 logWarning(`Invalid sent log key format: ${key}`);
            }
        }
        logInfo(`Found ${logs.length} sent logs.`, { userId: this.state.id.toString(), count: logs.length });
        return logs;
    }

    // 未処理のクリックログを取得し、ストレージから削除するメソッド
    async getAndClearClickLogs(startTime?: number, endTime?: number): Promise<{ articleId: string; timestamp: number; }[]> {
        logInfo(`Getting and clearing click logs for user ${this.state.id.toString()}`, { userId: this.state.id.toString(), startTime, endTime });
        const logs: { articleId: string; timestamp: number; }[] = [];
        const keysToDelete: string[] = [];

        // Durable Object のストレージから click: プレフィックスで始まるキーをリストアップ
        const listResult = await this.state.storage.list({ prefix: 'click:' });

        for (const [key, value] of listResult.entries()) {
            // キーから articleId と timestamp を抽出
            const parts = key.split(':');
            if (parts.length >= 3) {
                 const timestamp = parseInt(parts[1], 10);
                 const articleId = parts.slice(2).join(':'); // articleId にコロンが含まれる可能性を考慮

                 if ((startTime === undefined || timestamp >= startTime) && (endTime === undefined || timestamp <= endTime)) {
                     logs.push({ articleId, timestamp });
                     keysToDelete.push(key); // 削除リストに追加
                 }
            } else {
                 logWarning(`Invalid click log key format: ${key}`);
            }
        }

        // 取得したログをストレージから削除
        if (keysToDelete.length > 0) {
            logInfo(`Deleting ${keysToDelete.length} processed click log keys.`);
            await this.state.storage.delete(keysToDelete);
        }

        logInfo(`Found and cleared ${logs.length} click logs.`, { userId: this.state.id.toString(), count: logs.length });
        return logs;
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
