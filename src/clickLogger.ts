// src/clickLogger.ts

import { Logger } from './logger';
import { DurableObject } from 'cloudflare:workers';
import { NewsArticle } from './newsCollector';
import { Env } from './index';
import init, { get_ucb_values_bulk, update_bandit_model, cosine_similarity } from '../linalg-wasm/pkg/linalg_wasm';
import wasm from '../linalg-wasm/pkg/linalg_wasm_bg.wasm';
import { updateUserProfile } from './userProfile';
import { OPENAI_EMBEDDING_DIMENSION } from './config';
import { getArticlesFromD1, updateArticleEmbeddingInD1 } from './services/d1Service';

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

    // ロガーインスタンスを保持
    private logger: Logger;

    constructor(state: DurableObjectState, env: ClickLoggerEnv) {
        super(state, env);
        this.state = state;
        this.env = env;
        this.inMemoryModels = new Map<string, BanditModelState>();
        this.dirty = false;

        // ロガーを初期化し、インスタンス変数に割り当てる
        this.logger = new Logger(env);

        // Load all models from R2 into memory on startup.
        this.state.blockConcurrencyWhile(async () => {
            this.logger.debug('WASMモジュールを初期化します...');
            await init(wasm); // WASMモジュールの初期化
            this.logger.debug('WASMモジュールの初期化完了');
            await this.loadModelsFromR2();
        });
    }

    // Load all bandit models from a single R2 object.
    private async loadModelsFromR2(): Promise<void> {
        this.logger.debug(`Attempting to load all bandit models from R2 key: ${this.modelsR2Key}`);
        try {
            const object = await this.env.BANDIT_MODELS.get(this.modelsR2Key);

            if (object !== null) {
                // object.size が 0 の場合も空のJSONとして扱う
                if (object.size === 0) {
                    this.logger.warn('Existing bandit models file found in R2 but it is empty (0B). Initializing with an empty map and saving an empty JSON object to R2.');
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
                this.logger.debug(`Successfully loaded ${this.inMemoryModels.size} bandit models from R2.`);
            } else {
                this.logger.debug('No existing bandit models file found in R2. Initializing with an empty map and saving an empty JSON object to R2.');
                this.inMemoryModels = new Map<string, BanditModelState>();
                // R2に空のJSONオブジェクトを書き込む
                await this.env.BANDIT_MODELS.put(this.modelsR2Key, JSON.stringify({}));
            }
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logger.error('Error loading bandit models from R2. Starting fresh.', err, { errorName: err.name, errorMessage: err.message });
            // In case of a loading/parsing error, start with a clean slate to avoid corruption.
            this.inMemoryModels = new Map<string, BanditModelState>();
        }
    }

    // Save all in-memory bandit models to a single R2 object.
    private async saveModelsToR2(): Promise<void> {
        this.logger.debug(`Attempting to save ${this.inMemoryModels.size} bandit models to R2.`);
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
            this.logger.debug('Successfully saved all bandit models to R2.');
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logger.error('Failed to save bandit models to R2.', err, {
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
        this.logger.debug(`Initialized new bandit model for userId: ${userId}`);
        return newModel;
    }

    // ユーザープロファイルの埋め込みをD1に更新するプライベートメソッド
    private async updateUserProfileEmbeddingInD1(userId: string, banditModel: BanditModelState): Promise<void> {
        this.logger.debug(`Attempting to update user profile embedding in D1 for user: ${userId}`);
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
            this.logger.debug(`Successfully updated user profile embedding in D1 for user: ${userId}`);
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logger.error('Error updating user profile embedding in D1:', err, { userId, errorName: err.name, errorMessage: err.message });
        }
    }

    // MMR lambda を計算するプライベートメソッド
    private async calculateMMRLambda(userId: string): Promise<number> {
        // ユーザーのCTRを取得
        const userCTR = await this.getUserCTR(userId);

        // フィードバック履歴を取得してlambdaを計算
        const feedbackLogs = await this.env.DB.prepare(
            `SELECT action FROM education_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 20`
        ).bind(userId).all<{ action: string }>();

        let lambda = 0.5; // デフォルト値

        if (feedbackLogs.results && feedbackLogs.results.length > 0) {
            this.logger.info(`Calculating optimized MMR lambda with ${feedbackLogs.results.length} feedback entries.`, { userId, feedbackCount: feedbackLogs.results.length });
            // 詳細なフィードバック分析
            const interestedCount = feedbackLogs.results.filter(log => log.action === 'interested').length;
            const notInterestedCount = feedbackLogs.results.filter(log => log.action === 'not_interested').length;
            const totalCount = feedbackLogs.results.length;
            const interestRatio = interestedCount / totalCount;
            const notInterestRatio = notInterestedCount / totalCount;

            // 最近の傾向分析（最近10件）
            const recentLogs = feedbackLogs.results.slice(0, 10);
            const recentInterestedCount = recentLogs.filter(log => log.action === 'interested').length;
            const recentNotInterestedCount = recentLogs.filter(log => log.action === 'not_interested').length;
            const recentTotalCount = recentLogs.length;
            const recentInterestRatio = recentTotalCount > 0 ? recentInterestedCount / recentTotalCount : 0;
            const recentNotInterestRatio = recentTotalCount > 0 ? recentNotInterestedCount / recentTotalCount : 0;

            this.logger.debug(`Feedback analysis for user ${userId}: ${interestedCount}/${totalCount} interested (${(interestRatio * 100).toFixed(1)}%), ${notInterestedCount}/${totalCount} not interested (${(notInterestRatio * 100).toFixed(1)}%)`, {
                userId,
                interestedCount,
                notInterestedCount,
                totalCount,
                interestRatio,
                notInterestRatio,
                recentInterestedCount,
                recentNotInterestedCount,
                recentInterestRatio,
                recentNotInterestRatio
            });

            // 興味なし記事削減のためのlambda計算アルゴリズム
            let baseLambda = 0.6; // 初期値を0.6に上げて類似性を重視

            // CTRの影響（高いCTRは類似性を高く）
            const ctrInfluence = userCTR * 0.2; // CTRが高いほど類似性を高く
            baseLambda += ctrInfluence;

            // 興味なしの割合が高い場合のlambda調整
            // 以前は興味なしが多いと強く類似性を高めていたが、好みが定まっていない段階で守りに入ると逆効果になるため緩和
            if (notInterestRatio > 0.7) {
                baseLambda += 0.1; // 興味なしが非常に多い場合は少し類似性を高くして安全策
            } else if (notInterestRatio > 0.4) {
                // 興味なしがある程度あっても、まだ探索が必要な段階かもしれないので、あまり上げすぎない
                baseLambda += 0.05;
            }

            // 興味ありの割合が高い場合（好みがわかっている場合）は、活用（Exploitation）を促進するために類似性を高める
            if (interestRatio > 0.6) {
                baseLambda += 0.1; // 好みがわかってきたら類似性を高める
            }
            if (interestRatio > 0.8) {
                baseLambda += 0.1; // 非常に好みが明確ならさらに高める
            }

            // 最近の興味なし傾向を考慮
            if (recentNotInterestRatio > 0.6) {
                baseLambda += 0.1; // 最近興味なしが続いている場合は少し類似性を高く
            }

            // フィードバック数の影響
            if (totalCount < 10) {
                // データが少ないうちは、極端な調整を避ける（デフォルトに近い値で探索）
                // 何もしない（baseLambdaのまま）
            } else if (totalCount > 30) {
                baseLambda += 0.05; // 十分なデータがある場合は少し類似性を高くして安定させる
            }

            lambda = Math.max(0.3, Math.min(0.95, baseLambda)); // 0.3-0.95の範囲に制限（上限を少し緩和）

            this.logger.info(`Calculated MMR lambda for user ${userId} (optimized): ${lambda.toFixed(3)}`, {
                userId,
                lambda,
                userCTR: userCTR.toFixed(4),
                interestRatio: interestRatio.toFixed(4),
                notInterestRatio: notInterestRatio.toFixed(4),
                recentNotInterestRatio: recentNotInterestRatio.toFixed(4),
                totalFeedbackCount: totalCount,
                baseLambdaBeforeClamping: baseLambda.toFixed(3)
            });

        } else {
            this.logger.info(`No feedback logs found for user ${userId} or feedbackLogs.results is empty. Calculating initial MMR lambda based on CTR.`, {
                userId,
                feedbackLogsResultsExists: !!feedbackLogs.results,
                feedbackLogsLength: feedbackLogs.results?.length ?? 0
            });
            // フィードバックがない場合はCTRに基づいて調整（少し類似性を高めに）
            lambda = 0.5 + (userCTR * 0.2); // CTRに応じて0.5-0.7の範囲

            this.logger.info(`Calculated MMR lambda for user ${userId} (initial, based on CTR): ${lambda.toFixed(3)}`, {
                userId,
                lambda,
                userCTR: userCTR.toFixed(4)
            });
        }

        return lambda;
    }

    // ユーザーのCTRを取得するプライベートメソッド
    private async getUserCTR(userId: string): Promise<number> {
        try {
            const sinceTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30日間

            // 配信された記事数を取得
            const sentCountResult = await this.env.DB.prepare(
                `SELECT COUNT(DISTINCT article_id) as count FROM sent_articles WHERE user_id = ? AND timestamp >= ?`
            ).bind(userId, sinceTimestamp).first<{ count: number }>();
            const sentCount = sentCountResult?.count ?? 0;

            // クリックされた記事数を取得
            const clickCountResult = await this.env.DB.prepare(
                `SELECT COUNT(DISTINCT article_id) as count FROM click_logs WHERE user_id = ? AND timestamp >= ?`
            ).bind(userId, sinceTimestamp).first<{ count: number }>();
            const clickCount = clickCountResult?.count ?? 0;

            if (sentCount === 0) {
                return 0.5; // 配信履歴がない場合はデフォルト値0.5を返す
            }

            const ctr = clickCount / sentCount;
            this.logger.debug(`Calculated CTR for user ${userId}: ${ctr.toFixed(4)} (${clickCount}/${sentCount})`, { userId, ctr, clickCount, sentCount });
            return ctr;

        } catch (error) {
            this.logger.error(`Error calculating CTR for user ${userId}:`, error, { userId });
            return 0.5; // エラー時もデフォルト値0.5を返す
        }
    }

    async alarm() {
        // This alarm is triggered periodically to save dirty models to R2, process unclicked articles, and update models from feedback.
        try {
            if (this.dirty) {
                this.logger.info('Alarm triggered. Saving dirty models to R2.');
                await this.saveModelsToR2();
            } else {
                this.logger.debug('Alarm triggered, but no changes to save.');
            }
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logger.error('Error saving dirty models in ClickLogger alarm method:', err, {
                errorName: err.name,
                errorMessage: err.message,
                errorStack: err.stack,
                context: 'saveModelsToR2',
            });
        }

        try {
            // Process unclicked articles
            await this.processUnclickedArticles();
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logger.error('Error processing unclicked articles in ClickLogger alarm method:', err, {
                errorName: err.name,
                errorMessage: err.message,
                errorStack: err.stack,
                context: 'processUnclickedArticles',
            });
        }

        try {
            // Process pending feedback and update models
            await this.processPendingFeedback();
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logger.error('Error processing pending feedback in ClickLogger alarm method:', err, {
                errorName: err.name,
                errorMessage: err.message,
                errorStack: err.stack,
                context: 'processPendingFeedback',
            });
        }
    }

    // Helper to ensure an alarm is set.
    private async ensureAlarmIsSet(): Promise<void> {
        const currentAlarm = await this.state.storage.getAlarm();
        if (currentAlarm === null || currentAlarm < Date.now()) { // アラームが設定されていないか、過去の時刻の場合
            this.logger.debug('Alarm not set or expired. Setting a new alarm to run in 60 minutes.');
            // Set an alarm to run in 60 minutes (3600 * 1000 ms)
            const oneHour = 60 * 60 * 1000;
            await this.state.storage.setAlarm(Date.now() + oneHour);
        } else {
            this.logger.debug(`Alarm already set for ${new Date(currentAlarm).toISOString()}.`);
        }
    }

    // Handle requests to the Durable Object
    async fetch(request: Request): Promise<Response> {
        // Ensure an alarm is set to periodically save data.
        // This is crucial for ensuring alarm() is called even if the DO is idle for a long time.
        await this.ensureAlarmIsSet();
        await this.ensureModelsLoaded(); // 各リクエストの前にモデルがロードされていることを確認

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
            sentArticles: { articleId: string, timestamp: number, embedding: number[], publishedAt: string }[];
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
            immediateUpdate?: boolean; // 即時更新フラグ
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
            let userId: string | undefined;
            let articleId: string | undefined;
            try {
                const requestBody = await request.json() as LogClickRequestBody;
                userId = requestBody.userId;
                articleId = requestBody.articleId;
                const timestamp = requestBody.timestamp;

                if (!userId || !articleId || timestamp === undefined) {
                    this.logger.warn('Log click failed: Missing userId, articleId, or timestamp.');
                    return new Response('Missing parameters', { status: 400 });
                }

                this.state.waitUntil(this.env.DB.prepare(
                    `INSERT INTO click_logs (user_id, article_id, timestamp) VALUES (?, ?, ?)`
                ).bind(userId, articleId, timestamp).run());

                this.logger.info(`Logged click for user ${userId}, article ${articleId}`);
                return new Response('Click logged', { status: 200 });

            } catch (error: unknown) {
                const err = this.normalizeError(error);
                if (err.message.includes('FOREIGN KEY constraint failed')) {
                    this.logger.warn(`Ignoring click log due to foreign key constraint failure (user_id: ${userId}, article_id: ${articleId}). Article or user may have been deleted.`, { userId, articleId, errorName: err.name, errorMessage: err.message });
                    return new Response('Click ignored due to missing foreign key', { status: 200 });
                }
                this.logger.error('Error logging click:', err, {
                    requestUrl: request.url,
                    errorName: err.name,
                    errorMessage: err.message,
                    errorStack: err.stack,
                });
                return new Response('Error logging click', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/log-feedback') {
            try {
                const { userId, articleId, feedback, timestamp, immediateUpdate } = await request.json() as LogFeedbackRequestBody;
                this.logger.info(`Log feedback request: userId=${userId}, articleId=${articleId}, feedback=${feedback}, immediateUpdate=${immediateUpdate}`);

                if (!userId || !articleId || !feedback || !timestamp) {
                    this.logger.warn('Log feedback failed: Missing parameters.');
                    return new Response('Missing parameters', { status: 400 });
                }

                // 1. Determine reward based on feedback
                // 教育ページからの明示的なフィードバックは強いシグナルとして扱う
                // 興味あり: 5.0, 興味なし: -5.0 (以前は-1.0だったが、抑制効果を強めるために増強)
                const reward = feedback === 'interested' ? 5.0 : -5.0;

                // 2. Get the article's embedding from D1
                // First, try to get from sent_articles (for regular email feedback)
                let embedding: number[] | undefined;
                let source = 'unknown';

                const sentArticleResult = await this.env.DB.prepare(
                    `SELECT embedding FROM sent_articles WHERE user_id = ? AND article_id = ? ORDER BY timestamp DESC LIMIT 1`
                ).bind(userId, articleId).first<{ embedding: string }>();

                if (sentArticleResult && sentArticleResult.embedding) {
                    this.logger.debug(`Found embedding in sent_articles for article ${articleId} for user ${userId}.`, { userId, articleId });
                    embedding = JSON.parse(sentArticleResult.embedding) as number[];
                    source = 'sent_articles';
                } else {
                    this.logger.debug(`Embedding not found in sent_articles for article ${articleId} for user ${userId}. Fetching from articles table.`, { userId, articleId });
                    // For education program feedback, get from articles table
                    const originalArticle = await this.env.DB.prepare(
                        `SELECT embedding, published_at FROM articles WHERE article_id = ?`
                    ).bind(articleId).first<{ embedding: string | null, published_at: string | null }>();

                    if (originalArticle && originalArticle.embedding && originalArticle.published_at) {
                        try {
                            const originalEmbedding = JSON.parse(originalArticle.embedding) as number[];
                            const now = Date.now();
                            const publishedDate = new Date(originalArticle.published_at);
                            let normalizedAge = 0;

                            if (isNaN(publishedDate.getTime())) {
                                this.logger.warn(`Invalid publishedAt date for article ${articleId} from articles table. Using default freshness (0).`, { userId, articleId, publishedAt: originalArticle.published_at });
                                normalizedAge = 0;
                            } else {
                                const ageInHours = (now - publishedDate.getTime()) / (1000 * 60 * 60);
                                normalizedAge = Math.min(ageInHours / (24 * 7), 1.0);
                            }

                            // embeddingの次元をチェックし、必要に応じて鮮度情報を追加または更新
                            if (originalEmbedding.length === OPENAI_EMBEDDING_DIMENSION) {
                                embedding = [...originalEmbedding, normalizedAge];
                            } else if (originalEmbedding.length === EXTENDED_EMBEDDING_DIMENSION) {
                                embedding = [...originalEmbedding];
                                embedding[OPENAI_EMBEDDING_DIMENSION] = normalizedAge;
                            } else {
                                this.logger.warn(`Article ${articleId} from articles table has unexpected embedding dimension ${originalEmbedding.length}. Expected ${OPENAI_EMBEDDING_DIMENSION} or ${EXTENDED_EMBEDDING_DIMENSION}. Skipping.`, { userId, articleId, embeddingLength: originalEmbedding.length });
                                return new Response('Embedding dimension mismatch', { status: 500 });
                            }
                            source = 'articles';
                            this.logger.debug(`Successfully fetched and extended embedding from articles table for article ${articleId}. New dimension: ${embedding.length}`, { userId, articleId, newEmbeddingLength: embedding.length });
                        } catch (parseError) {
                            this.logger.error(`Error parsing embedding JSON for article ${articleId}:`, parseError, { userId, articleId, embeddingRaw: originalArticle.embedding });
                            return new Response('Error parsing article embedding', { status: 500 });
                        }
                    } else {
                        this.logger.warn(`Could not find embedding for article ${articleId} for user ${userId}. Source: ${source}`, {
                            userId,
                            articleId,
                            sentArticlesExists: !!sentArticleResult,
                            articlesExists: !!originalArticle,
                            embeddingExists: !!originalArticle?.embedding,
                            publishedAtExists: !!originalArticle?.published_at
                        });
                        // embeddingが見つからない場合でも、エラーをログに記録し、200 OKを返すことで、
                        // クライアント側でフィードバック処理がブロックされるのを防ぎます。
                        // ただし、バンディットモデルの更新はスキップされます。
                        this.logger.error(`Failed to find embedding for article ${articleId} for user ${userId}. Cannot update bandit model.`, undefined, {
                            userId,
                            articleId,
                            sentArticlesExists: !!sentArticleResult,
                            articlesExists: !!originalArticle,
                            embeddingExists: !!originalArticle?.embedding,
                            publishedAtExists: !!originalArticle?.published_at,
                            timestamp: new Date().toISOString()
                        });
                        return new Response('Feedback logged (embedding not found, model not updated)', { status: 200 });
                    }
                }

                // 3. Update the bandit model if immediate update is requested
                if (immediateUpdate && embedding) { // embedding が存在する場合のみモデルを更新
                    let banditModel = this.inMemoryModels.get(userId);
                    if (!banditModel) {
                        this.logger.warn(`No model found for user ${userId} in log-feedback. Initializing a new one.`);
                        banditModel = this.initializeNewBanditModel(userId);
                    }

                    // embeddingの次元がモデルの次元と一致しない場合のフォールバック処理 (既に上記で処理済みだが念のため)
                    if (embedding.length !== banditModel.dimension) {
                        this.logger.error(`Final embedding dimension mismatch for article ${articleId}. Expected ${banditModel.dimension}, got ${embedding.length}. Cannot update bandit model.`, null, {
                            userId,
                            articleId,
                            embeddingLength: embedding.length,
                            modelDimension: banditModel.dimension
                        });
                        return new Response('Embedding dimension mismatch', { status: 500 });
                    }

                    await this.updateBanditModel(banditModel, embedding, reward, userId);
                    this.dirty = true;
                    this.logger.info(`Successfully updated bandit model from feedback for article ${articleId} for user ${userId}`, { userId, articleId, feedback, reward });
                } else {
                    this.logger.debug(`Immediate update not requested for feedback from user ${userId}, article ${articleId}. Model update will be handled periodically.`, { userId, articleId, feedback });
                }

                // 4. Log the feedback to education_logs table (only if immediate update was NOT performed)
                // If immediate update was done, we don't need to queue it for later processing.
                if (!immediateUpdate) {
                    await this.env.DB.prepare(
                        `INSERT INTO education_logs (user_id, article_id, timestamp, action) VALUES (?, ?, ?, ?)`
                    ).bind(userId, articleId, timestamp, feedback).run();
                    this.logger.info(`Logged feedback to education_logs for user ${userId}, article ${articleId}, feedback: ${feedback}`);
                } else {
                    this.logger.info(`Skipped logging to education_logs because immediate update was performed for user ${userId}, article ${articleId}`);
                }

                // 5. Record exposure in sent_articles (so it can be excluded later and counted for score)
                // Use INSERT OR IGNORE to avoid errors if it was already sent/recorded
                if (embedding) {
                    await this.env.DB.prepare(
                        `INSERT OR IGNORE INTO sent_articles (user_id, article_id, timestamp, embedding, published_at) VALUES (?, ?, ?, ?, ?)`
                    ).bind(userId, articleId, timestamp, JSON.stringify(embedding), new Date().toISOString()).run(); // published_at is approximate here if not fetched, but acceptable for exclusion
                } else {
                    // Try to insert without embedding if we don't have it, just for ID exclusion
                    await this.env.DB.prepare(
                        `INSERT OR IGNORE INTO sent_articles (user_id, article_id, timestamp) VALUES (?, ?, ?)`
                    ).bind(userId, articleId, timestamp).run();
                }

                // 6. If interested, record as a click in click_logs (for score calculation)
                if (feedback === 'interested') {
                    await this.env.DB.prepare(
                        `INSERT INTO click_logs (user_id, article_id, timestamp) VALUES (?, ?, ?)`
                    ).bind(userId, articleId, timestamp).run();
                    this.logger.info(`Logged interested feedback as click for user ${userId}, article ${articleId}`);
                }

                return new Response('Feedback logged', { status: 200 });

            } catch (error: unknown) {
                const err = this.normalizeError(error);
                this.logger.error('Error logging feedback:', err, {
                    requestUrl: request.url,
                    errorName: err.name,
                    errorMessage: err.message,
                    errorStack: err.stack,
                });
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
                    this.logger.warn(`No model found for user ${userId} in get-ucb-values. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

                const ucbValues = await this.getUCBValues(userId, banditModel, articlesWithEmbeddings, userCTR);
                // Limit logging to the first 10 UCB values for performance
                const limitedUcbValues = ucbValues.slice(0, 10).map(u => ({ articleId: u.articleId, ucb: u.ucb.toFixed(4) }));
                this.logger.debug(
                    `Calculated UCB values for user ${userId} (showing up to 10): ${JSON.stringify(limitedUcbValues)}`,
                    { userId, totalUcbCount: ucbValues.length }
                );
                return new Response(JSON.stringify(ucbValues), {
                    headers: { 'Content-Type': 'application/json' },
                });

            } catch (error: unknown) {
                const err = this.normalizeError(error);
                this.logger.error('Error getting UCB values:', err, {
                    requestUrl: request.url,
                    errorName: err.name,
                    errorMessage: err.message,
                    errorStack: err.stack,
                });
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
                                `INSERT INTO sent_articles (user_id, article_id, timestamp, embedding, published_at) VALUES (?, ?, ?, ?, ?)`
                            ).bind(userId, article.articleId, article.timestamp, article.embedding ? JSON.stringify(article.embedding) : null, article.publishedAt)
                        );
                    } else {
                        this.logger.warn(`Skipping logging sent article ${article.articleId} for user ${userId} due to missing article in 'articles' table.`, { userId, articleId: article.articleId });
                    }
                }
                if (statements.length > 0) {
                    this.state.waitUntil(this.env.DB.batch(statements));
                } else {
                    this.logger.debug(`No valid sent articles to log for user ${userId}.`, { userId });
                }

                this.logger.debug(`Successfully logged ${sentArticles.length} sent articles for user ${userId}`);
                return new Response('Sent articles logged', { status: 200 });

            } catch (error: unknown) {
                const err = this.normalizeError(error);
                this.logger.error('Error logging sent articles:', err, {
                    requestUrl: request.url,
                    errorName: err.name,
                    errorMessage: err.message,
                    errorStack: err.stack,
                });
                return new Response('Error logging sent articles', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/decay-rewards') {
            this.logger.warn('/decay-rewards endpoint is deprecated.');
            return new Response('Deprecated endpoint', { status: 410 });
        } else if (request.method === 'POST' && path === '/learn-from-education') {
            try {
                const { userId, selectedArticles } = await request.json() as LearnFromEducationRequestBody;
                if (!userId || !Array.isArray(selectedArticles)) {
                    return new Response('Invalid parameters: userId and selectedArticles array are required', { status: 400 });
                }

                let banditModel = this.inMemoryModels.get(userId);
                if (!banditModel) {
                    this.logger.warn(`No model found for user ${userId} in learn-from-education. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

                const logStatements = [];
                for (const article of selectedArticles) {
                    if (article.embedding && article.reward !== undefined) {
                        let embeddingToUse = article.embedding;

                        // embeddingの次元がモデルの次元と一致しない場合のフォールバック処理
                        if (embeddingToUse.length !== banditModel.dimension) {
                            this.logger.warn(`Embedding dimension mismatch for article ${article.articleId} from selectedArticles. Attempting to re-fetch and extend.`, {
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
                                const publishedDate = new Date(originalArticle.published_at);
                                let normalizedAge = 0;

                                if (isNaN(publishedDate.getTime())) {
                                    this.logger.warn(`Invalid publishedAt date for article ${article.articleId} from articles table during learn-from-education. Using default freshness (0).`, { userId, articleId: article.articleId, publishedAt: originalArticle.published_at });
                                    normalizedAge = 0;
                                } else {
                                    const ageInHours = (now - publishedDate.getTime()) / (1000 * 60 * 60);
                                    normalizedAge = Math.min(ageInHours / (24 * 7), 1.0);
                                }

                                // embeddingの次元をチェックし、必要に応じて鮮度情報を追加または更新
                                if (originalEmbedding.length === OPENAI_EMBEDDING_DIMENSION) {
                                    embeddingToUse = [...originalEmbedding, normalizedAge];
                                } else if (originalEmbedding.length === EXTENDED_EMBEDDING_DIMENSION) {
                                    embeddingToUse = [...originalEmbedding];
                                    embeddingToUse[OPENAI_EMBEDDING_DIMENSION] = normalizedAge;
                                } else {
                                    this.logger.warn(`Article ${article.articleId} from articles table has unexpected embedding dimension ${originalEmbedding.length} during learn-from-education. Expected ${OPENAI_EMBEDDING_DIMENSION} or ${EXTENDED_EMBEDDING_DIMENSION}. Skipping.`, { userId, articleId: article.articleId, embeddingLength: originalEmbedding.length });
                                    continue;
                                }

                                this.logger.debug(`Successfully re-fetched and extended embedding for article ${article.articleId}. New dimension: ${embeddingToUse.length}`, { userId, articleId: article.articleId, newEmbeddingLength: embeddingToUse.length });
                            } else {
                                this.logger.error(`Failed to re-fetch original embedding for article ${article.articleId} from articles table during learn-from-education. Cannot update bandit model.`, null, { userId, articleId: article.articleId });
                                // エラーが発生した場合でも、この記事の学習はスキップし、次の記事に進む
                                continue;
                            }
                        }

                        await this.updateBanditModel(banditModel, embeddingToUse, article.reward, userId, true);
                        logStatements.push(
                            this.env.DB.prepare(
                                `INSERT INTO education_logs (user_id, article_id, timestamp, action) VALUES (?, ?, ?, ?)`
                            ).bind(userId, article.articleId, Date.now(), article.reward > 0 ? 'interested' : 'not_interested')
                        );
                    }
                }

                if (logStatements.length > 0) {
                    this.state.waitUntil(this.env.DB.batch(logStatements));
                    this.dirty = true;
                    this.logger.debug(`Learned from ${logStatements.length} articles and updated bandit model for user ${userId}.`);
                    await this.updateUserProfileEmbeddingInD1(userId, banditModel); // プロファイル更新
                    await this.saveModelsToR2(); // モデルの変更を即座にR2へ保存
                }
                return new Response('Learning from education completed', { status: 200 });

            } catch (error: unknown) {
                const err = this.normalizeError(error);
                this.logger.error('Error learning from education:', err, {
                    requestUrl: request.url,
                    errorName: err.name,
                    errorMessage: err.message,
                    errorStack: err.stack,
                });
                return new Response('Error learning from education', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/embedding-completed-callback') {
            try {
                const { userId, embeddings } = await request.json() as EmbeddingCompletedCallbackRequestBody;
                if (!Array.isArray(embeddings) || embeddings.length === 0) {
                    this.logger.warn('Embedding completed callback failed: No embeddings provided.');
                    return new Response('No embeddings provided', { status: 400 });
                }

                if (userId) { // userId が存在する場合のみバンディットモデルを更新
                    let banditModel = this.inMemoryModels.get(userId);
                    if (!banditModel) {
                        this.logger.warn(`No model found for user ${userId} during embedding callback. Initializing a new one.`);
                        banditModel = this.initializeNewBanditModel(userId);
                    }

                    for (const embed of embeddings) {
                        // embedding-completed-callback は OpenAI Batch API からのコールバックであり、
                        // BatchQueueDOで既に257次元に拡張されたembeddingを受け取り、D1にも保存済みであるため、
                        // ここではバンディットモデルの更新のみを行う。
                        await this.updateBanditModel(banditModel, embed.embedding, 1.0, userId, true); // 報酬は1.0, プロファイル更新はスキップ
                        this.logger.debug(`Updated bandit model for user ${userId} with embedding for article ${embed.articleId}.`);
                    }
                    // バッチ処理完了後に一度だけユーザープロファイルを更新
                    await this.updateUserProfileEmbeddingInD1(userId, banditModel);
                    this.dirty = true; // モデルが変更されたことをマーク
                } else {
                    this.logger.debug('Embedding completed callback received without userId. Skipping bandit model update.', { embeddingsCount: embeddings.length });
                }

                return new Response('Embedding completed callback processed', { status: 200 });
            } catch (error: unknown) {
                const err = this.normalizeError(error);
                this.logger.error('Error processing embedding completed callback:', err, {
                    requestUrl: request.url,
                    errorName: err.name,
                    errorMessage: err.message,
                    errorStack: err.stack,
                });
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
                    this.logger.warn(`No model found for user ${userId} in update-bandit-from-click. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

                await this.updateBanditModel(banditModel, embedding, reward, userId);
                this.dirty = true;
                this.logger.debug(`Successfully updated bandit model from click for article ${articleId} for user ${userId}`);
                return new Response('Bandit model updated', { status: 200 });

            } catch (error: unknown) {
                const err = this.normalizeError(error);
                this.logger.error('Error updating bandit model from click:', err, {
                    requestUrl: request.url,
                    errorName: err.name,
                    errorMessage: err.message,
                    errorStack: err.stack,
                });
                return new Response('Error updating bandit model from click', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/delete-all-data') {
            // This is a destructive operation and should be used with caution.
            // It now deletes the entire R2 object.
            try {
                this.logger.info(`Deleting all bandit models from R2.`);
                await this.env.BANDIT_MODELS.delete(this.modelsR2Key);
                this.inMemoryModels.clear();
                this.dirty = false;
                this.logger.info(`All bandit models deleted.`);
                return new Response('All bandit models deleted', { status: 200 });
            } catch (error: unknown) {
                const err = this.normalizeError(error);
                this.logger.error('Error deleting all bandit models:', err, {
                    requestUrl: request.url,
                    errorName: err.name,
                    errorMessage: err.message,
                    errorStack: err.stack,
                });
                return new Response('Error deleting all models', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/calculate-preference-score') {
            try {
                const { userId, selectedArticleIds } = await request.json() as { userId: string, selectedArticleIds: string[] };

                if (!userId || !Array.isArray(selectedArticleIds) || selectedArticleIds.length === 0) {
                    this.logger.warn('Calculate preference score failed: Missing userId or selectedArticleIds.');
                    return new Response('Missing parameters', { status: 400 });
                }

                let banditModel = this.inMemoryModels.get(userId);
                if (!banditModel) {
                    this.logger.warn(`No model found for user ${userId} for preference score calculation. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

                // ユーザーの好みベクトル (bベクトル) を取得
                const userPreferenceVector = Array.from(banditModel.b);

                // 選択された記事の埋め込みベクトルを取得し、平均ベクトルを計算
                const articlesWithEmbeddings = await getArticlesFromD1(this.env, selectedArticleIds.length, 0, `article_id IN (${selectedArticleIds.map(() => '?').join(',')}) AND embedding IS NOT NULL`, selectedArticleIds);

                if (articlesWithEmbeddings.length === 0) {
                    this.logger.warn(`No articles with embeddings found for selectedArticleIds for user ${userId}.`, { userId, selectedArticleIds });
                    return new Response('No articles with embeddings found', { status: 404 });
                }

                const articleEmbeddings: number[][] = [];
                for (const article of articlesWithEmbeddings) {
                    if (article.embedding && article.publishedAt) {
                        try {
                            const originalEmbedding = article.embedding;
                            const now = Date.now();
                            const publishedDate = new Date(article.publishedAt);
                            let normalizedAge = 0;

                            if (isNaN(publishedDate.getTime())) {
                                this.logger.warn(`Invalid publishedAt date for article ${article.articleId} during preference score calculation. Using default freshness (0).`, { userId, articleId: article.articleId, publishedAt: article.publishedAt });
                                normalizedAge = 0;
                            } else {
                                const ageInHours = (now - publishedDate.getTime()) / (1000 * 60 * 60);
                                normalizedAge = Math.min(ageInHours / (24 * 7), 1.0);
                            }

                            let extendedEmbedding: number[];
                            if (originalEmbedding.length === OPENAI_EMBEDDING_DIMENSION) {
                                extendedEmbedding = [...originalEmbedding, normalizedAge];
                            } else if (originalEmbedding.length === EXTENDED_EMBEDDING_DIMENSION) {
                                extendedEmbedding = [...originalEmbedding];
                                extendedEmbedding[OPENAI_EMBEDDING_DIMENSION] = normalizedAge;
                            } else {
                                this.logger.warn(`Article ${article.articleId} has unexpected embedding dimension ${originalEmbedding.length} during preference score calculation. Expected ${OPENAI_EMBEDDING_DIMENSION} or ${EXTENDED_EMBEDDING_DIMENSION}. Skipping.`, { userId, articleId: article.articleId, embeddingLength: originalEmbedding.length });
                                continue;
                            }

                            if (extendedEmbedding.length === banditModel.dimension) {
                                articleEmbeddings.push(extendedEmbedding);
                            } else {
                                this.logger.warn(`Article ${article.articleId} has embedding dimension mismatch after extension. Expected ${banditModel.dimension}, got ${extendedEmbedding.length}. Skipping.`, { userId, articleId: article.articleId, extendedEmbeddingLength: extendedEmbedding.length, modelDimension: banditModel.dimension });
                            }
                        } catch (parseError) {
                            this.logger.error(`Error parsing embedding JSON for article ${article.articleId}:`, parseError, { userId, articleId: article.articleId, embeddingRaw: article.embedding });
                        }
                    }
                }

                if (articleEmbeddings.length === 0) {
                    this.logger.warn(`No valid article embeddings found for selected articles for user ${userId}. Cannot calculate preference score.`, { userId, selectedArticleIds });
                    return new Response('No valid article embeddings found', { status: 404 });
                }

                // 選択された記事の平均ベクトルを計算
                const averageArticleVector = new Array(banditModel.dimension).fill(0);
                for (let i = 0; i < banditModel.dimension; i++) {
                    for (const embedding of articleEmbeddings) {
                        averageArticleVector[i] += embedding[i];
                    }
                    averageArticleVector[i] /= articleEmbeddings.length;
                }

                // コサイン類似度を計算
                const similarity = cosine_similarity(
                    userPreferenceVector,
                    averageArticleVector,
                );

                // スコアを0-100のパーセンテージに変換 (類似度は-1から1の範囲なので、0から1に正規化してから100倍)
                const preferenceScore = ((similarity + 1) / 2) * 100;

                this.logger.debug(`Calculated preference score for user ${userId}: ${preferenceScore.toFixed(2)}%`, { userId, score: preferenceScore });

                return new Response(JSON.stringify({ score: preferenceScore }), {
                    headers: { 'Content-Type': 'application/json' },
                    status: 200,
                });

            } catch (error: unknown) {
                const err = this.normalizeError(error);
                this.logger.error('Error calculating preference score in ClickLogger:', err, {
                    requestUrl: request.url,
                    errorName: err.name,
                    errorMessage: err.message,
                    errorStack: err.stack,
                });
                return new Response('Internal Server Error', { status: 500 });
            }
        } else if (request.method === 'GET' && path === '/get-preference-score') {
            try {
                const url = new URL(request.url);
                const userId = url.searchParams.get('userId');

                if (!userId) {
                    this.logger.warn('Get preference score failed: Missing userId.');
                    return new Response('Missing userId', { status: 400 });
                }

                // Calculate score based on Interest Rate: (Clicks / Sent) * 100
                const sentCountResult = await this.env.DB.prepare(
                    `SELECT COUNT(*) as count FROM sent_articles WHERE user_id = ?`
                ).bind(userId).first<{ count: number }>();

                const clickCountResult = await this.env.DB.prepare(
                    `SELECT COUNT(*) as count FROM click_logs WHERE user_id = ?`
                ).bind(userId).first<{ count: number }>();

                const sentCount = sentCountResult?.count || 0;
                const clickCount = clickCountResult?.count || 0;

                let preferenceScore = 0;
                if (sentCount > 0) {
                    preferenceScore = (clickCount / sentCount) * 100;
                }

                // Cap at 100% just in case
                preferenceScore = Math.min(preferenceScore, 100);

                this.logger.debug(`Calculated preference score for user ${userId}: ${preferenceScore.toFixed(2)}% (Clicks: ${clickCount}, Sent: ${sentCount})`, { userId, score: preferenceScore, clickCount, sentCount });

                return new Response(JSON.stringify({ score: preferenceScore }), {
                    headers: { 'Content-Type': 'application/json' },
                    status: 200,
                });

            } catch (error: unknown) {
                const err = this.normalizeError(error);
                this.logger.error('Error getting preference score in ClickLogger:', err, {
                    requestUrl: request.url,
                    errorName: err.name,
                    errorMessage: err.message,
                    errorStack: err.stack,
                });
                return new Response('Internal Server Error', { status: 500 });
            }
        } else if (request.method === 'GET' && path === '/get-mmr-lambda') {
            try {
                const url = new URL(request.url);
                const userId = url.searchParams.get('userId');

                if (!userId) {
                    this.logger.warn('Get MMR lambda failed: Missing userId.');
                    return new Response('Missing userId', { status: 400 });
                }

                // ユーザーの保存されたlambdaを取得
                const userProfile = await this.env.DB.prepare(
                    `SELECT mmr_lambda FROM users WHERE user_id = ?`
                ).bind(userId).first<{ mmr_lambda: number | null }>();

                const lambda = userProfile?.mmr_lambda ?? 0.5;

                this.logger.debug(`Retrieved MMR lambda for user ${userId}: ${lambda}`, { userId, lambda });

                return new Response(JSON.stringify({ lambda }), {
                    headers: { 'Content-Type': 'application/json' },
                    status: 200,
                });

            } catch (error: unknown) {
                const err = this.normalizeError(error);
                this.logger.error('Error getting MMR lambda in ClickLogger:', err, {
                    requestUrl: request.url,
                    errorName: err.name,
                    errorMessage: err.message,
                    errorStack: err.stack,
                });
                return new Response('Internal Server Error', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/calculate-mmr-lambda') {
            try {
                const { userId, immediate } = await request.json() as { userId: string, immediate?: boolean };

                if (!userId) {
                    this.logger.warn('Calculate MMR lambda failed: Missing userId.');
                    return new Response('Missing userId', { status: 400 });
                }

                const lambda = await this.calculateMMRLambda(userId);

                if (immediate) {
                    // 即時更新の場合、lambdaを保存
                    this.state.waitUntil(this.env.DB.prepare(
                        `UPDATE users SET mmr_lambda = ? WHERE user_id = ?`
                    ).bind(lambda, userId).run());
                    this.logger.debug(`Immediately updated MMR lambda for user ${userId}: ${lambda}`, { userId, lambda });
                }

                return new Response(JSON.stringify({ lambda }), {
                    headers: { 'Content-Type': 'application/json' },
                    status: 200,
                });

            } catch (error: unknown) {
                const err = this.normalizeError(error);
                this.logger.error('Error calculating MMR lambda in ClickLogger:', err, {
                    requestUrl: request.url,
                    errorName: err.name,
                    errorMessage: err.message,
                    errorStack: err.stack,
                });
                return new Response('Internal Server Error', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/debug/process-pending-feedback') {
            try {
                this.logger.info('Debug: Manually triggering processPendingFeedback');
                await this.processPendingFeedback();
                return new Response('Processed pending feedback', { status: 200 });
            } catch (error: unknown) {
                const err = this.normalizeError(error);
                this.logger.error('Debug: Error processing pending feedback:', err, {
                    errorName: err.name,
                    errorMessage: err.message,
                    errorStack: err.stack,
                });
                return new Response(`Error: ${err.message}`, { status: 500 });
            }
        }

        // Handle other requests
        return new Response('Not Found', { status: 404 });
    }

    // Debug method to trigger processPendingFeedback manually
    async processPendingFeedbackDebug(): Promise<void> {
        this.logger.info('Debug: Manually triggering processPendingFeedback');
        await this.processPendingFeedback();
    }

    // Process unclicked articles and update bandit models
    private async processUnclickedArticles(): Promise<void> {
        try {
            // Get all user IDs that have sent articles
            const { results } = await this.env.DB.prepare(`SELECT DISTINCT user_id FROM sent_articles`).all<{ user_id: string }>();
            const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000); // 24時間前

            // 過去24時間以内に送信され、かつクリックされていないすべての記事を、すべてのユーザーに対して一度に取得
            const allUnclickedArticles = await this.env.DB.prepare(
                `SELECT sa.user_id, sa.article_id, sa.embedding, sa.published_at
                 FROM sent_articles sa
                 LEFT JOIN click_logs cl ON sa.user_id = cl.user_id AND sa.article_id = cl.article_id
                 WHERE sa.timestamp >= ? AND cl.id IS NULL`
            ).bind(twentyFourHoursAgo).all<{ user_id: string, article_id: string, embedding: string, published_at: string }>();

            if (!allUnclickedArticles.results || allUnclickedArticles.results.length === 0) {
                this.logger.debug('No unclicked articles found within the last 24 hours for any user.');
                return;
            }

            // ユーザーIDごとに記事をグループ化
            const articlesByUser = new Map<string, { article_id: string, embedding: string, published_at: string }[]>();
            for (const article of allUnclickedArticles.results) {
                if (!articlesByUser.has(article.user_id)) {
                    articlesByUser.set(article.user_id, []);
                }
                articlesByUser.get(article.user_id)?.push(article);
            }

            // ユーザーごとの処理をバッチ処理として実行
            const userIds = Array.from(articlesByUser.keys());
            const result = await this.logger.logBatchProcess(
                'unclicked articles processing',
                userIds,
                async (userId: string) => {
                    const unclickedArticlesForUser = articlesByUser.get(userId) || [];

                    let banditModel = this.inMemoryModels.get(userId);
                    if (!banditModel) {
                        this.logger.warn(`No bandit model found for user ${userId} during unclicked article processing. Initializing a new one.`);
                        banditModel = this.initializeNewBanditModel(userId);
                    }

                    const now = Date.now();
                    let updatedCount = 0;
                    for (const article of unclickedArticlesForUser) {
                        if (article.embedding && article.published_at) {
                            const originalEmbedding = JSON.parse(article.embedding) as number[];
                            let embeddingToUse = originalEmbedding;
                            const publishedDate = new Date(article.published_at);
                            let normalizedAge = 0;

                            if (isNaN(publishedDate.getTime())) {
                                this.logger.warn(`Invalid publishedAt date for article ${article.article_id} from sent_articles during unclicked article processing. Using default freshness (0).`, { userId, articleId: article.article_id, publishedAt: article.published_at });
                                normalizedAge = 0;
                            } else {
                                const ageInHours = (now - publishedDate.getTime()) / (1000 * 60 * 60);
                                normalizedAge = Math.min(ageInHours / (24 * 7), 1.0);
                            }

                            // embeddingの次元をチェックし、必要に応じて鮮度情報を追加または更新
                            if (originalEmbedding.length === OPENAI_EMBEDDING_DIMENSION) {
                                embeddingToUse = [...originalEmbedding, normalizedAge];
                            } else if (originalEmbedding.length === EXTENDED_EMBEDDING_DIMENSION) {
                                embeddingToUse = [...originalEmbedding];
                                embeddingToUse[OPENAI_EMBEDDING_DIMENSION] = normalizedAge;
                            } else {
                                this.logger.warn(`Article ${article.article_id} from sent_articles has unexpected embedding dimension ${originalEmbedding.length} during unclicked article processing. Expected ${OPENAI_EMBEDDING_DIMENSION} or ${EXTENDED_EMBEDDING_DIMENSION}. Skipping update.`, { userId, articleId: article.article_id, embeddingLength: originalEmbedding.length });
                                continue;
                            }

                            // クリックされなかった記事には負の報酬を与える (例: -0.1)
                            await this.updateBanditModel(banditModel, embeddingToUse, -0.1, userId, true);
                            this.dirty = true;
                            updatedCount++;
                        } else {
                            this.logger.warn(`Article ${article.article_id} from sent_articles missing embedding or published_at. Skipping update.`, { userId, articleId: article.article_id, hasEmbedding: !!article.embedding, hasPublishedAt: !!article.published_at });
                        }
                    }

                    if (updatedCount > 0) {
                        await this.updateUserProfileEmbeddingInD1(userId, banditModel);
                    }

                    return updatedCount; // 処理した記事数を返す
                },
                {
                    onItemSuccess: (userId: string, index: number, result?: number) => {
                        // 個々のユーザーの成功はdebugレベルでログ
                        this.logger.debug(`Successfully processed unclicked articles for user ${userId}: ${result} articles updated`);
                    },
                    onItemError: (userId: string, index: number, error: any) => {
                        // エラーはlogBatchProcess内で処理されるため、ここでは何もしない
                    }
                }
            );
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logger.error('Error processing unclicked articles:', err, {
                errorName: err.name,
                errorMessage: err.message,
                errorStack: err.stack,
            });
        }
    }

    // Process pending feedback and update bandit models and lambda
    private async processPendingFeedback(): Promise<void> {
        this.logger.info('Starting to process pending feedback.');
        try {
            // Get all user IDs that have feedback logs
            const { results: distinctUsersWithFeedback } = await this.env.DB.prepare(`SELECT DISTINCT user_id FROM education_logs`).all<{ user_id: string }>();
            this.logger.info(`Found ${distinctUsersWithFeedback.length} distinct users with feedback logs.`, { distinctUsersWithFeedbackCount: distinctUsersWithFeedback.length });

            // すべてのユーザーの最近のフィードバックログを一度に取得
            const BATCH_SIZE = 50; // D1のSQL変数制限を考慮してバッチサイズを調整
            const allFeedbackLogs = await this.env.DB.prepare(
                `SELECT user_id, article_id, action, timestamp FROM education_logs ORDER BY timestamp DESC LIMIT 500`
            ).all<{ user_id: string, article_id: string, action: string, timestamp: number }>();

            if (!allFeedbackLogs.results || allFeedbackLogs.results.length === 0) {
                this.logger.info('No feedback logs found in the database for any user.');
                return;
            }
            this.logger.info(`Fetched ${allFeedbackLogs.results.length} feedback logs from the database.`, { totalFeedbackLogsFetched: allFeedbackLogs.results.length });

            // ユーザーIDごとにフィードバックログをグループ化
            const feedbackLogsByUser = new Map<string, { article_id: string, action: string, timestamp: number }[]>();
            for (const log of allFeedbackLogs.results) {
                if (!feedbackLogsByUser.has(log.user_id)) {
                    feedbackLogsByUser.set(log.user_id, []);
                }
                feedbackLogsByUser.get(log.user_id)?.push(log);
            }

            this.logger.info(`Found ${feedbackLogsByUser.size} users with feedback logs to process.`, { userCount: feedbackLogsByUser.size });

            // 必要な記事の埋め込みを事前に取得するためのIDリスト
            const articleIdsToFetch = new Set<string>();
            for (const logs of feedbackLogsByUser.values()) {
                for (const log of logs) {
                    articleIdsToFetch.add(log.article_id);
                }
            }
            const articleIdsArray = Array.from(articleIdsToFetch);
            this.logger.info(`Preparing to fetch embeddings for ${articleIdsArray.length} articles.`, { count: articleIdsArray.length });

            // Chunking to avoid "too many SQL variables" error
            const CHUNK_SIZE = 50;
            const sentArticlesEmbeddingsAccumulator: { article_id: string, embedding: string, published_at: string }[] = [];
            const articlesEmbeddingsAccumulator: { article_id: string, embedding: string | null, published_at: string | null }[] = [];

            for (let i = 0; i < articleIdsArray.length; i += CHUNK_SIZE) {
                const chunk = articleIdsArray.slice(i, i + CHUNK_SIZE);
                if (chunk.length === 0) continue;

                const placeholders = chunk.map(() => "?").join(",");

                // Fetch from sent_articles
                const sentChunk = await this.env.DB.prepare(
                    `SELECT article_id, embedding, published_at FROM sent_articles WHERE article_id IN (${placeholders})`
                ).bind(...chunk).all<{ article_id: string, embedding: string, published_at: string }>();
                if (sentChunk.results) {
                    sentArticlesEmbeddingsAccumulator.push(...sentChunk.results);
                }

                // Fetch from articles
                const articlesChunk = await this.env.DB.prepare(
                    `SELECT article_id, embedding, published_at FROM articles WHERE article_id IN (${placeholders})`
                ).bind(...chunk).all<{ article_id: string, embedding: string | null, published_at: string | null }>();
                if (articlesChunk.results) {
                    articlesEmbeddingsAccumulator.push(...articlesChunk.results);
                }
            }

            this.logger.info(`Fetched ${sentArticlesEmbeddingsAccumulator.length} embeddings from sent_articles.`);
            this.logger.info(`Fetched ${articlesEmbeddingsAccumulator.length} embeddings from articles table.`);

            const allEmbeddingsMap = new Map<string, { embedding: number[], published_at: string }>();

            // Merge results: sent_articles priority
            for (const sentArticle of sentArticlesEmbeddingsAccumulator) {
                if (sentArticle.embedding) {
                    allEmbeddingsMap.set(sentArticle.article_id, { embedding: JSON.parse(sentArticle.embedding), published_at: sentArticle.published_at });
                }
            }

            for (const article of articlesEmbeddingsAccumulator) {
                if (!allEmbeddingsMap.has(article.article_id) && article.embedding) {
                    allEmbeddingsMap.set(article.article_id, { embedding: JSON.parse(article.embedding), published_at: article.published_at || new Date().toISOString() });
                }
            }
            this.logger.info(`Pre-fetched ${allEmbeddingsMap.size} article embeddings for feedback processing.`, { embeddingCount: allEmbeddingsMap.size });

            // Identify articles missing embeddings and trigger batch generation
            const articleIdsMissingEmbeddings = articleIdsArray.filter(id => !allEmbeddingsMap.has(id));
            if (articleIdsMissingEmbeddings.length > 0) {
                this.logger.info(`Found ${articleIdsMissingEmbeddings.length} articles missing embeddings. Triggering batch generation.`, { count: articleIdsMissingEmbeddings.length });

                // Fetch article content for embedding generation
                const { results: articlesForEmbedding } = await this.env.DB.prepare(
                    `SELECT article_id, title, url, content, published_at FROM articles WHERE article_id IN (${articleIdsMissingEmbeddings.map(() => "?").join(",")})`
                ).bind(...articleIdsMissingEmbeddings).all<any>();

                if (articlesForEmbedding.length > 0) {
                    const articlesToEmbed = articlesForEmbedding.map(row => ({
                        articleId: row.article_id,
                        title: row.title,
                        link: row.url,
                        sourceName: '',
                        summary: row.content ? row.content.substring(0, Math.min(row.content.length, 200)) : '',
                        content: row.content,
                        publishedAt: row.published_at,
                    }));

                    // Trigger batch embedding generation (use first user's ID for the job)
                    const firstUserId = feedbackLogsByUser.keys().next().value;
                    if (firstUserId) {
                        this.state.waitUntil(
                            import('./services/embeddingService').then(({ generateAndSaveEmbeddings }) =>
                                generateAndSaveEmbeddings(articlesToEmbed, this.env, firstUserId)
                            )
                        );
                        this.logger.info(`Triggered batch embedding generation for ${articlesToEmbed.length} articles.`, { count: articlesToEmbed.length });
                    }
                }
            }

            for (const [userId, feedbackLogsForUser] of feedbackLogsByUser.entries()) {
                this.logger.info(`Processing pending feedback for user: ${userId}`, { userId, feedbackCount: feedbackLogsForUser.length });

                let banditModel = this.inMemoryModels.get(userId);
                if (!banditModel) {
                    this.logger.warn(`No bandit model found for user ${userId} during feedback processing. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

                let updatedCount = 0;
                const now = Date.now();
                const logStatements = []; // バッチ処理用のステートメントリスト

                for (const log of feedbackLogsForUser) {
                    const articleEmbeddingData = allEmbeddingsMap.get(log.article_id);

                    if (articleEmbeddingData) {
                        const originalEmbedding = articleEmbeddingData.embedding;
                        const publishedAt = articleEmbeddingData.published_at;
                        let embedding: number[] | undefined;

                        const publishedDate = new Date(publishedAt);
                        let normalizedAge = 0;

                        if (isNaN(publishedDate.getTime())) {
                            this.logger.warn(`Invalid publishedAt date for article ${log.article_id} during feedback processing. Using default freshness (0).`, { userId, articleId: log.article_id, publishedAt: publishedAt });
                            normalizedAge = 0;
                        } else {
                            const ageInHours = (now - publishedDate.getTime()) / (1000 * 60 * 60);
                            normalizedAge = Math.min(ageInHours / (24 * 7), 1.0);
                        }

                        if (originalEmbedding.length === OPENAI_EMBEDDING_DIMENSION) {
                            embedding = [...originalEmbedding, normalizedAge];
                        } else if (originalEmbedding.length === EXTENDED_EMBEDDING_DIMENSION) {
                            embedding = [...originalEmbedding];
                            embedding[OPENAI_EMBEDDING_DIMENSION] = normalizedAge;
                        } else {
                            this.logger.warn(`Article ${log.article_id} has unexpected embedding dimension ${originalEmbedding.length} during feedback processing. Expected ${OPENAI_EMBEDDING_DIMENSION} or ${EXTENDED_EMBEDDING_DIMENSION}. Skipping update.`, { userId, articleId: log.article_id, embeddingLength: originalEmbedding.length });
                            continue;
                        }

                        if (embedding && embedding.length === banditModel.dimension) {
                            // 教育ページからの明示的なフィードバックは強いシグナルとして扱う
                            // 興味あり: 5.0, 興味なし: -5.0
                            const reward = log.action === 'interested' ? 5.0 : -5.0;
                            await this.updateBanditModel(banditModel, embedding, reward, userId, true);
                            this.dirty = true;
                            updatedCount++;

                            // Successfully processed, delete the log
                            logStatements.push(
                                this.env.DB.prepare(
                                    `DELETE FROM education_logs WHERE user_id = ? AND article_id = ? AND timestamp = ?`
                                ).bind(userId, log.article_id, log.timestamp)
                            );
                        } else {
                            this.logger.warn(`Skipping feedback for article ${log.article_id} due to missing or mismatched embedding.`, { userId, articleId: log.article_id });
                        }
                    } else {
                        // No embedding available - keep the log for next processing cycle
                        this.logger.debug(`Deferring feedback for article ${log.article_id} - embedding not yet available.`, { userId, articleId: log.article_id });
                    }

                    // バッチサイズに達したら実行
                    if (logStatements.length >= BATCH_SIZE) {
                        this.state.waitUntil(this.env.DB.batch(logStatements));
                        logStatements.length = 0; // リストをクリア
                    }
                }

                // 残りのステートメントを実行
                if (logStatements.length > 0) {
                    this.state.waitUntil(this.env.DB.batch(logStatements));
                }

                if (updatedCount > 0) {
                    await this.updateUserProfileEmbeddingInD1(userId, banditModel);
                }

                this.logger.debug(`Updated bandit model for user ${userId} with ${updatedCount} feedback entries.`, { userId, updatedCount });

                // Calculate and update MMR lambda
                const lambda = await this.calculateMMRLambda(userId);
                this.state.waitUntil(this.env.DB.prepare(
                    `UPDATE users SET mmr_lambda = ? WHERE user_id = ?`
                ).bind(lambda, userId).run());
                this.logger.debug(`Updated MMR lambda for user ${userId}: ${lambda}`, { userId, lambda });
            }
            this.logger.debug('Finished processing pending feedback.');
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logger.error('Error processing pending feedback:', err, {
                errorName: err.name,
                errorMessage: err.message,
                errorStack: err.stack,
                rawError: JSON.stringify(error)
            });
        }
    }

    // Calculate UCB values for a list of articles for a specific user model using WASM.
    private async getUCBValues(userId: string, banditModel: BanditModelState, articles: { articleId: string, embedding: number[] }[], userCTR: number): Promise<{ articleId: string, ucb: number }[]> {
        if (banditModel.dimension === 0) {
            this.logger.warn("Bandit model dimension is zero. Cannot calculate UCB values.", { userId });
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
                    this.logger.warn(`Skipping article ${article.articleId} due to invalid or mismatched embedding dimension for UCB calculation.`, {
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
                this.logger.warn("No valid articles with embeddings to calculate UCB values for.", { userId });
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
            this.logger.debug(
                `Calculated UCB values for user ${userId} (showing up to 10): ${JSON.stringify(limitedUcbValues)}`,
                { userId, totalUcbCount: ucbResults.length }
            );

            return ucbResults;
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logger.error("Error during WASM UCB calculation:", err, {
                userId,
                articlesCount: articles.length,
                errorName: err.name,
                errorMessage: err.message,
                stack: err.stack,
            });
            return articles.map(article => ({ articleId: article.articleId, ucb: 0 }));
        }
    }

    // Durable Objectがアイドル状態から復帰した際に、inMemoryModelsが空であればR2からロードを試みる
    // これはDurable Objectのリセット後に状態が失われる問題への防御的なアプローチ
    private async ensureModelsLoaded(): Promise<void> {
        if (this.inMemoryModels.size === 0) {
            this.logger.warn('inMemoryModels is empty. Attempting to reload models from R2.');
            await this.loadModelsFromR2();
        }
    }

    // Helper to normalize errors to Error objects
    private normalizeError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    // Update a specific user's bandit model using WASM.
    private async updateBanditModel(banditModel: BanditModelState, embedding: number[], reward: number, userId: string, skipProfileUpdate: boolean = false): Promise<void> {
        // embedding の厳密な検証
        if (!embedding) {
            this.logger.warn("Cannot update bandit model: embedding is null or undefined.", { userId });
            return;
        }
        if (!Array.isArray(embedding)) {
            this.logger.warn("Cannot update bandit model: embedding is not an array.", { userId, embeddingType: typeof embedding });
            return;
        }
        if (embedding.length !== banditModel.dimension) {
            this.logger.warn("Cannot update bandit model: embedding dimension mismatch.", { userId, embeddingLength: embedding.length, modelDimension: banditModel.dimension });
            return;
        }
        if (!embedding.every(e => typeof e === 'number' && isFinite(e))) {
            const nanIndex = embedding.findIndex(e => !isFinite(e));
            this.logger.warn(`Cannot update bandit model: embedding contains non-finite numbers (NaN/Infinity). First non-finite value at index ${nanIndex}.`, {
                userId,
                embeddingSample: embedding.slice(Math.max(0, nanIndex - 2), nanIndex + 3), // 問題の箇所の前後をログに記録
                embeddingLength: embedding.length,
                nonFiniteIndex: nanIndex,
                nonFiniteValue: embedding[nanIndex],
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

            this.logger.debug(`Bandit model updated for user ${userId} with reward ${reward.toFixed(2)}.`, { userId, reward });

            // バンディットモデル更新後、ユーザープロファイルの埋め込みも更新 (skipProfileUpdateがfalseの場合のみ)
            if (!skipProfileUpdate) {
                await this.updateUserProfileEmbeddingInD1(userId, banditModel);
            }
        } catch (error: unknown) {
            const err = this.normalizeError(error);
            this.logger.error("Error during WASM bandit model update:", err, {
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
