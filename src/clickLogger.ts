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
            this.logger.info(`Successfully updated user profile embedding in D1 for user: ${userId}`);
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

            // 興味なしの割合が高い場合にlambdaを高くする（類似性を重視）
            if (notInterestRatio > 0.5) {
                baseLambda += 0.2; // 興味なしが多い場合は強く類似性を高く
            } else if (notInterestRatio > 0.3) {
                baseLambda += 0.1; // 興味なしが少し多い場合は少し類似性を高く
            }

            // 興味ありの割合が高い場合でも適度に探索性を保つ
            if (interestRatio > 0.8) {
                baseLambda -= 0.1; // 興味ありが多い場合は少し探索性を高く
            }

            // 最近の興味なし傾向を考慮
            if (recentNotInterestRatio > 0.4) {
                baseLambda += 0.15; // 最近興味なしが多い場合は類似性を高く
            }

            // フィードバック数の影響
            if (totalCount < 5) {
                baseLambda += 0.1; // 少ない場合は類似性を高くして安全に
            } else if (totalCount > 15) {
                baseLambda += 0.05; // 十分なデータがある場合は少し類似性を高く
            }

            // 興味なしの多様性による調整（興味なしの割合が高い場合）
            if (notInterestRatio > interestRatio) {
                baseLambda += 0.1; // 興味なしが多い場合は類似性を高く
            }

            lambda = Math.max(0.3, Math.min(0.9, baseLambda)); // 0.3-0.9の範囲に制限

            this.logger.debug(`Optimized MMR lambda for user ${userId} (not interested reduction): ${lambda.toFixed(3)}`, {
                userId,
                lambda,
                userCTR,
                interestRatio,
                notInterestRatio,
                recentNotInterestRatio,
                totalCount,
                baseLambda: baseLambda.toFixed(3)
            });

        } else {
            // フィードバックがない場合はCTRに基づいて調整（少し類似性を高めに）
            lambda = 0.5 + (userCTR * 0.2); // CTRに応じて0.5-0.7の範囲

            this.logger.debug(`Initial MMR lambda for user ${userId}: ${lambda.toFixed(3)} (based on CTR: ${userCTR})`, {
                userId,
                lambda,
                userCTR
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
        if (this.dirty) {
            this.logger.info('Alarm triggered. Saving dirty models to R2.');
            await this.saveModelsToR2();
        } else {
            this.logger.debug('Alarm triggered, but no changes to save.');
        }

        // Process unclicked articles
        await this.processUnclickedArticles();

        // Process pending feedback and update models
        await this.processPendingFeedback();
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
            try {
                const { userId, articleId, timestamp } = await request.json() as LogClickRequestBody;

                if (!userId || !articleId || timestamp === undefined) {
                    this.logger.warn('Log click failed: Missing userId, articleId, or timestamp.');
                    return new Response('Missing parameters', { status: 400 });
                }

                this.state.waitUntil(this.env.DB.prepare(
                    `INSERT INTO click_logs (user_id, article_id, timestamp) VALUES (?, ?, ?)`
                ).bind(userId, articleId, timestamp).run());

                this.logger.info(`Logged click for user ${userId}, article ${articleId}`);
                return new Response('Click logged', { status: 200 });

            } catch (error) {
                this.logger.error('Error logging click:', error, { requestUrl: request.url });
                return new Response('Error logging click', { status: 500 });
            }
        } else if (request.method === 'POST' && path === '/log-feedback') {
            try {
                const { userId, articleId, feedback, timestamp, immediateUpdate } = await request.json() as LogFeedbackRequestBody;

                if (!userId || !articleId || !feedback || !timestamp) {
                    this.logger.warn('Log feedback failed: Missing parameters.');
                    return new Response('Missing parameters', { status: 400 });
                }

                // 1. Determine reward based on feedback
                const reward = feedback === 'interested' ? 2.0 : -1.0;

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
                        return new Response('Article embedding not found', { status: 404 });
                    }
                }

                // 3. Update the bandit model if immediate update is requested
                if (immediateUpdate) {
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

                // 4. Log the feedback to education_logs table
                this.state.waitUntil(this.env.DB.prepare(
                    `INSERT INTO education_logs (user_id, article_id, timestamp, action) VALUES (?, ?, ?, ?)`
                ).bind(userId, articleId, timestamp, feedback).run());
                this.logger.info(`Logged feedback to education_logs for user ${userId}, article ${articleId}, feedback: ${feedback}`);

                return new Response('Feedback logged', { status: 200 });

            } catch (error) {
                this.logger.error('Error logging feedback:', error, { requestUrl: request.url });
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

            } catch (error) {
                this.logger.error('Error getting UCB values:', error);
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

            } catch (error) {
                this.logger.error('Error logging sent articles:', error);
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

                        await this.updateBanditModel(banditModel, embeddingToUse, article.reward, userId);
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
                    await this.saveModelsToR2(); // モデルの変更を即座にR2へ保存
                }
                return new Response('Learning from education completed', { status: 200 });

            } catch (error) {
                this.logger.error('Error learning from education:', error, { requestUrl: request.url });
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
                        await this.updateBanditModel(banditModel, embed.embedding, 1.0, userId); // 報酬は1.0
                        this.logger.debug(`Updated bandit model for user ${userId} with embedding for article ${embed.articleId}.`);
                    }
                    this.dirty = true; // モデルが変更されたことをマーク
                } else {
                    this.logger.debug('Embedding completed callback received without userId. Skipping bandit model update.', { embeddingsCount: embeddings.length });
                }
                
                return new Response('Embedding completed callback processed', { status: 200 });
            } catch (error) {
                this.logger.error('Error processing embedding completed callback:', error, { requestUrl: request.url });
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

            } catch (error) {
                this.logger.error('Error updating bandit model from click:', error, { requestUrl: request.url });
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
            } catch (error) {
                this.logger.error('Error deleting all bandit models:', error, { requestUrl: request.url });
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

            } catch (error) {
                this.logger.error('Error calculating preference score in ClickLogger:', error, { requestUrl: request.url });
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

                let banditModel = this.inMemoryModels.get(userId);
                if (!banditModel) {
                    // モデルが存在しない場合、スコアは0%
                    this.logger.debug(`No model found for user ${userId}. Returning 0% score.`, { userId });
                    return new Response(JSON.stringify({ score: 0 }), {
                        headers: { 'Content-Type': 'application/json' },
                        status: 200,
                    });
                }

                // ユーザーの好みベクトル (bベクトル) の最大絶対値を計算
                const bVector = Array.from(banditModel.b);
                const maxAbs = Math.max(...bVector.map(Math.abs));

                // 最大絶対値を0-1に正規化し、スコアに変換 (例: 最大値が大きいほどスコアが高い)
                // 閾値として、5を基準に正規化（報酬2.0で1回で40%）
                const threshold = 5;
                const normalizedScore = Math.min(1, maxAbs / threshold);
                const preferenceScore = normalizedScore * 100;

                this.logger.debug(`Calculated current preference score for user ${userId}: ${preferenceScore.toFixed(2)}% (maxAbs: ${maxAbs.toFixed(2)})`, { userId, score: preferenceScore, maxAbs });

                return new Response(JSON.stringify({ score: preferenceScore }), {
                    headers: { 'Content-Type': 'application/json' },
                    status: 200,
                });

            } catch (error) {
                this.logger.error('Error getting preference score in ClickLogger:', error, { requestUrl: request.url });
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

            } catch (error) {
                this.logger.error('Error getting MMR lambda in ClickLogger:', error, { requestUrl: request.url });
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

            } catch (error) {
                this.logger.error('Error calculating MMR lambda in ClickLogger:', error, { requestUrl: request.url });
                return new Response('Internal Server Error', { status: 500 });
            }
        }


        // Handle other requests
        return new Response('Not Found', { status: 404 });
    }

    // Process unclicked articles and update bandit models
    private async processUnclickedArticles(): Promise<void> {
        this.logger.debug('Starting to process unclicked articles.');
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

            this.logger.debug(`Found ${articlesByUser.size} users with unclicked articles to process.`, { userCount: articlesByUser.size });

            const now = Date.now();
            for (const [userId, unclickedArticlesForUser] of articlesByUser.entries()) {
                this.logger.debug(`Processing unclicked articles for user: ${userId}`, { userId, articleCount: unclickedArticlesForUser.length });

                let banditModel = this.inMemoryModels.get(userId);
                if (!banditModel) {
                    this.logger.warn(`No bandit model found for user ${userId} during unclicked article processing. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

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
                        await this.updateBanditModel(banditModel, embeddingToUse, -0.1, userId);
                        this.dirty = true;
                        updatedCount++;
                    } else {
                        this.logger.warn(`Article ${article.article_id} from sent_articles missing embedding or published_at. Skipping update.`, { userId, articleId: article.article_id, hasEmbedding: !!article.embedding, hasPublishedAt: !!article.published_at });
                    }
                }
                this.logger.debug(`Updated bandit model for user ${userId} with -0.1 reward for ${updatedCount} unclicked articles.`, { userId, updatedCount });
            }
            this.logger.debug('Finished processing unclicked articles.');
        } catch (error) {
            this.logger.error('Error processing unclicked articles:', error);
        }
    }

    // Process pending feedback and update bandit models and lambda
    private async processPendingFeedback(): Promise<void> {
        this.logger.debug('Starting to process pending feedback.');
        try {
            // Get all user IDs that have feedback logs
            const { results } = await this.env.DB.prepare(`SELECT DISTINCT user_id FROM education_logs`).all<{ user_id: string }>();
            // すべてのユーザーの最近のフィードバックログを一度に取得
            const allFeedbackLogs = await this.env.DB.prepare(
                `SELECT user_id, article_id, action, timestamp FROM education_logs ORDER BY timestamp DESC LIMIT 500` // 取得数を増やす
            ).all<{ user_id: string, article_id: string, action: string, timestamp: number }>();

            if (!allFeedbackLogs.results || allFeedbackLogs.results.length === 0) {
                this.logger.debug('No feedback logs found for any user.');
                return;
            }

            // ユーザーIDごとにフィードバックログをグループ化
            const feedbackLogsByUser = new Map<string, { article_id: string, action: string, timestamp: number }[]>();
            for (const log of allFeedbackLogs.results) {
                if (!feedbackLogsByUser.has(log.user_id)) {
                    feedbackLogsByUser.set(log.user_id, []);
                }
                feedbackLogsByUser.get(log.user_id)?.push(log);
            }

            this.logger.debug(`Found ${feedbackLogsByUser.size} users with feedback logs to process.`, { userCount: feedbackLogsByUser.size });

            // 必要な記事の埋め込みを事前に取得するためのIDリスト
            const articleIdsToFetch = new Set<string>();
            for (const logs of feedbackLogsByUser.values()) {
                for (const log of logs) {
                    articleIdsToFetch.add(log.article_id);
                }
            }
            const articleIdsArray = Array.from(articleIdsToFetch);
            
            // sent_articles と articles テーブルから必要な埋め込みを一度に取得
            const sentArticlesEmbeddings = await this.env.DB.prepare(
                `SELECT article_id, embedding, published_at FROM sent_articles WHERE article_id IN (${articleIdsArray.map(() => '?').join(',')})`
            ).bind(...articleIdsArray).all<{ article_id: string, embedding: string, published_at: string }>();

            const articlesEmbeddings = await this.env.DB.prepare(
                `SELECT article_id, embedding, published_at FROM articles WHERE article_id IN (${articleIdsArray.map(() => '?').join(',')})`
            ).bind(...articleIdsArray).all<{ article_id: string, embedding: string | null, published_at: string | null }>();

            const allEmbeddingsMap = new Map<string, { embedding: number[], published_at: string }>();

            for (const article of sentArticlesEmbeddings.results) {
                if (article.embedding && article.published_at) {
                    allEmbeddingsMap.set(article.article_id, { embedding: JSON.parse(article.embedding), published_at: article.published_at });
                }
            }
            for (const article of articlesEmbeddings.results) {
                if (article.embedding && article.published_at && !allEmbeddingsMap.has(article.article_id)) {
                    allEmbeddingsMap.set(article.article_id, { embedding: JSON.parse(article.embedding), published_at: article.published_at });
                }
            }
            this.logger.debug(`Pre-fetched ${allEmbeddingsMap.size} article embeddings for feedback processing.`, { embeddingCount: allEmbeddingsMap.size });


            for (const [userId, feedbackLogsForUser] of feedbackLogsByUser.entries()) {
                this.logger.debug(`Processing pending feedback for user: ${userId}`, { userId, feedbackCount: feedbackLogsForUser.length });

                let banditModel = this.inMemoryModels.get(userId);
                if (!banditModel) {
                    this.logger.warn(`No bandit model found for user ${userId} during feedback processing. Initializing a new one.`);
                    banditModel = this.initializeNewBanditModel(userId);
                }

                let updatedCount = 0;
                const now = Date.now();
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
                            const reward = log.action === 'interested' ? 2.0 : -1.0;
                            await this.updateBanditModel(banditModel, embedding, reward, userId);
                            this.dirty = true;
                            updatedCount++;
                        } else {
                            this.logger.warn(`Skipping feedback for article ${log.article_id} due to missing or mismatched embedding.`, { userId, articleId: log.article_id });
                        }
                    } else {
                        this.logger.warn(`Skipping feedback for article ${log.article_id} due to missing embedding data.`, { userId, articleId: log.article_id });
                    }
                }

                this.logger.debug(`Updated bandit model for user ${userId} with ${updatedCount} feedback entries.`, { userId, updatedCount });

                // Calculate and update MMR lambda
                const lambda = await this.calculateMMRLambda(userId);
                await this.env.DB.prepare(
                    `UPDATE users SET mmr_lambda = ? WHERE user_id = ?`
                ).bind(lambda, userId).run();
                this.logger.debug(`Updated MMR lambda for user ${userId}: ${lambda}`, { userId, lambda });
            }
            this.logger.debug('Finished processing pending feedback.');
        } catch (error) {
            this.logger.error('Error processing pending feedback:', error);
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

    // Helper to normalize errors to Error objects
    private normalizeError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    // Update a specific user's bandit model using WASM.
    private async updateBanditModel(banditModel: BanditModelState, embedding: number[], reward: number, userId: string): Promise<void> {
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

            // バンディットモデル更新後、ユーザープロファイルの埋め込みも更新
            await this.updateUserProfileEmbeddingInD1(userId, banditModel);
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
