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
    // ユーザーに送信された記事のembeddingを保存するマップ
    sentArticlesEmbeddings: { [articleId: string]: number[] };
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
    env: any; // TODO: Define a proper Env interface if needed

    private banditModel: BanditModelState | null = null;
    private readonly banditStateKey = 'banditModelState';
    private readonly sentArticlesKey = 'sentArticlesEmbeddings'; // 送信済み記事embeddingのストレージキー

    constructor(state: DurableObjectState, env: any) {
        this.state = state;
        this.env = env;

        // Durable Object が初めてロードされたときに状態を読み込む
        this.state.blockConcurrencyWhile(async () => {
            await this.loadState();
        });
    }

    // Durable Object の状態（バンディットモデルと送信済み記事embedding）をストレージから読み込む
    private async loadState(): Promise<void> {
        const savedState = await this.state.storage.get<Map<string, any>>([this.banditStateKey, this.sentArticlesKey]);

        const savedModel = savedState.get(this.banditStateKey);
        // 取得した値を unknown にキャストしてから目的の型にキャスト
        if (savedModel !== undefined && savedModel !== null) {
             this.banditModel = savedModel as unknown as BanditModelState;
             logInfo(`Loaded bandit model state for ${this.state.id.toString()}`);
        } else {
            // モデルがまだ存在しない場合は初期化
            // TODO: embedding の次元数をどう取得するか検討が必要。
            // 最初の記事の embedding 次元を使うか、設定で持つか。
            // ここでは仮に次元を100とします。実際には動的に決定する必要があります。
            const dimension = 100; // 仮の次元数
            this.banditModel = {
                A: Array(dimension).fill(0).map(() => Array(dimension).fill(0)),
                b: Array(dimension).fill(0),
                dimension: dimension,
                alpha: 0.1, // UCB パラメータ alpha
                sentArticlesEmbeddings: {}, // 初期化時に空のオブジェクトを設定
            };
            // A を単位行列で初期化 (LinUCB の標準的な初期化)
            for (let i = 0; i < dimension; i++) {
                this.banditModel.A[i][i] = 1.0;
            }
            logInfo(`Initialized new bandit model state for ${this.state.id.toString()}`);
        }

        const savedSentArticles = savedState.get(this.sentArticlesKey);
        // 送信済み記事embeddingを読み込む
        // 取得した値を unknown にキャストしてから目的の型にキャスト
        if (savedSentArticles !== undefined && savedSentArticles !== null) {
             if (this.banditModel) {
                this.banditModel.sentArticlesEmbeddings = savedSentArticles as unknown as { [articleId: string]: number[] };
                logInfo(`Loaded sent articles embeddings for ${this.state.id.toString()}`);
             }
        } else {
             if (this.banditModel) {
                this.banditModel.sentArticlesEmbeddings = {}; // 初期化
                logInfo(`Initialized empty sent articles embeddings for ${this.state.id.toString()}`);
             }
        }

        // 初期状態を保存 (モデルが初期化された場合のみ)
        if (this.banditModel && savedModel === undefined || savedModel === null) { // savedModel が undefined または null の場合
             await this.saveState();
        }
    }

    // Durable Object の状態（バンディットモデルと送信済み記事embedding）をストレージに保存する
    private async saveState(): Promise<void> {
        if (this.banditModel) {
            await this.state.storage.put(this.banditStateKey, this.banditModel);
            await this.state.storage.put(this.sentArticlesKey, this.banditModel.sentArticlesEmbeddings);
            logInfo(`Saved Durable Object state for ${this.state.id.toString()}`);
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
            sentArticles: { articleId: string, timestamp: number, embedding: number[] }[];
        }

        // /log-click エンドポイントのリクエストボディの型定義
        interface LogClickRequestBody {
            articleId: string;
            timestamp: number;
            // embedding と reward は Durable Object 側で処理する
            // embedding?: number[];
            // reward?: number;
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
                // embedding と reward はここでは保存しない（バンディットモデル更新時に使用）
                const eventKey = `click:${this.state.id.toString()}:${articleId}:${timestamp}`; // キーフォーマット例
                await this.state.storage.put(eventKey, { articleId, timestamp });

                logInfo(`Logged click for user ${this.state.id.toString()}, article ${articleId} at ${timestamp}`);

                // クリックイベントに基づいてバンディットモデルを更新
                if (this.banditModel && this.banditModel.sentArticlesEmbeddings) { // banditModel と sentArticlesEmbeddings が存在するか確認
                    // 保存済みのembeddingを取得
                    const embedding = this.banditModel.sentArticlesEmbeddings[articleId];
                    const reward = 1.0; // クリックイベントなので報酬は 1.0

                    if (embedding) {
                        this.updateBanditModel(embedding, reward);
                        await this.saveState(); // 状態全体を保存
                        logInfo(`Updated bandit model for user ${this.state.id.toString()} with click on ${articleId} and reward ${reward}`);
                    } else {
                        logWarning(`Cannot update bandit model for user ${this.state.id.toString()}: embedding not found for article ${articleId}.`);
                    }
                } else {
                    logWarning(`Cannot update bandit model for user ${this.state.id.toString()}: model not initialized or sentArticlesEmbeddings is missing.`);
                }

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
                const { sentArticles } = await request.json() as LogSentArticlesRequestBody;
                if (!Array.isArray(sentArticles)) {
                    return new Response('Invalid input: sentArticles must be an array', { status: 400 });
                }

                logInfo(`Logging ${sentArticles.length} sent articles for user ${this.state.id.toString()}`);

                if (this.banditModel) {
                    // 送信した記事のembeddingをマップに保存
                    sentArticles.forEach(article => {
                        if (article.embedding) {
                            // 非nullアサーションを追加してTypeScriptのエラーを抑制
                            this.banditModel!.sentArticlesEmbeddings[article.articleId] = article.embedding;
                        } else {
                            logWarning(`Embedding missing for sent article ${article.articleId}. Cannot save embedding.`);
                        }
                    });

                    // 状態全体を保存
                    await this.saveState();
                    logInfo(`Successfully logged sent articles and saved embeddings for user ${this.state.id.toString()}`);
                } else {
                    logWarning(`Bandit model not initialized. Cannot log sent articles embeddings for user ${this.state.id.toString()}`);
                }


                return new Response('Sent articles logged', { status: 200 });

            } catch (error) {
                logError('Error logging sent articles:', error);
                return new Response('Error logging sent articles', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/decay-rewards') {
            try {
                logInfo(`Starting reward decay process for user ${this.state.id.toString()}`);

                if (!this.banditModel) {
                    logWarning(`Bandit model not initialized. Skipping reward decay for user ${this.state.id.toString()}`);
                    return new Response('Bandit model not initialized', { status: 500 });
                }

                // 一定期間（例: 24時間）以上前の送信済み記事を取得
                const decayThreshold = Date.now() - 24 * 60 * 60 * 1000; // 24時間前
                // Durable Object のストレージから sent: プレフィックスで始まるキーをリストアップ
                const sentArticleKeys = await this.state.storage.list({ prefix: 'sent:' });

                const articlesToDecay: { articleId: string, embedding: number[] }[] = [];
                const keysToDelete: string[] = [];

                // sentArticleKeys は Map<string, any> なので、キーのみを処理
                for (const key of sentArticleKeys.keys()) {
                     // キーからタイムスタンプと articleId を抽出
                    const parts = key.split(':');
                    if (parts.length >= 3) { // キーフォーマット sent:<timestamp>:<articleId> を想定
                        const timestamp = parseInt(parts[1], 10);
                        const articleId = parts.slice(2).join(':'); // articleId にコロンが含まれる可能性を考慮

                        if (timestamp < decayThreshold) {
                            // 減衰対象の記事
                            // この記事に対応するクリックイベントがあるか確認
                            // クリックイベントのキーは click:<userId>:<articleId>:<timestamp> の形式で保存されていると想定
                            // 正確なキープレフィックスで検索するために、articleId と timestamp を使用
                            const clickEventKeyPrefix = `click:${this.state.id.toString()}:${articleId}:${timestamp}`;
                            const clickEvents = await this.state.storage.list({ prefix: clickEventKeyPrefix });

                            if (clickEvents.keys.length === 0) {
                                // クリックイベントがない場合、報酬を減衰
                                logInfo(`Decaying reward for article ${articleId} (sent at ${timestamp})`);
                                // 保存済みのembeddingを取得
                                const embedding = this.banditModel.sentArticlesEmbeddings[articleId];

                                if (embedding) {
                                    // 報酬ゼロでモデルを更新
                                    this.updateBanditModel(embedding, 0.0); // 報酬ゼロ
                                    articlesToDecay.push({ articleId: articleId, embedding: embedding }); // ログ用
                                    // 減衰処理を行った記事のembeddingはマップから削除
                                    delete this.banditModel.sentArticlesEmbeddings[articleId];
                                } else {
                                    logWarning(`Cannot decay reward for article ${articleId}: embedding not found in sentArticlesEmbeddings.`);
                                }
                            } else {
                                logInfo(`Article ${articleId} was clicked (sent at ${timestamp}). No decay needed.`);
                            }
                            // 処理済みの送信済み記事キーを削除リストに追加
                            keysToDelete.push(key);
                        }
                    } else {
                        logWarning(`Invalid sent article key format: ${key}`);
                    }
                }

                // 状態全体を保存 (バンディットモデルと更新されたsentArticlesEmbeddings)
                if (articlesToDecay.length > 0 || keysToDelete.length > 0) {
                     await this.saveState();
                     if (articlesToDecay.length > 0) {
                        logInfo(`Saved Durable Object state after decaying rewards.`);
                     }
                     if (keysToDelete.length > 0) {
                        logInfo(`Deleted ${keysToDelete.length} processed sent article keys.`);
                     }
                } else {
                    logInfo(`No articles to decay or delete for user ${this.state.id.toString()}`);
                }


                logInfo(`Reward decay process finished for user ${this.state.id.toString()}`);

                return new Response('Reward decay process completed', { status: 200 });

            } catch (error) {
                logError('Error during reward decay process:', error);
                return new Response('Error during reward decay process', { status: 500 });
            }
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
                    // 各選択された記事のembeddingでバンディットモデルを更新
                    for (const article of selectedArticles) {
                        if (article.embedding) {
                            // ユーザー教育による選択は報酬 1.0 として学習
                            this.updateBanditModel(article.embedding, 1.0);
                            logInfo(`Updated bandit model with education data for article ${article.articleId}`, { userId: this.state.id.toString(), articleId: article.articleId });
                        } else {
                            logWarning(`Cannot update bandit model with education data for article ${article.articleId}: embedding missing.`);
                        }
                    }

                    // 状態全体を保存
                    if (selectedArticles.length > 0) {
                         await this.saveState();
                         logInfo(`Saved Durable Object state after learning from education.`);
                    }
                } else {
                    logWarning(`Bandit model not initialized. Cannot learn from education for user ${this.state.id.toString()}`);
                }


                return new Response('Learning from education completed', { status: 200 });

            } catch (error) {
                logError('Error learning from education:', error, { userId: this.state.id.toString(), requestUrl: request.url });
                return new Response('Error learning from education', { status: 500 });
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

    // クリックイベントに基づいてバンディットモデルを更新するメソッド
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
