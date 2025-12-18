import { DurableObject } from "cloudflare:workers";

// WASMモジュールをインポート
import init, { cosine_similarity } from '../linalg-wasm/pkg/linalg_wasm.js';
import wasmModule from '../linalg-wasm/pkg/linalg_wasm_bg.wasm';
import { cosine_similarity_bulk, calculate_similarity_matrix } from '../linalg-wasm/pkg/linalg_wasm';

// 依存関係のインポート
import { ClickLogger } from './clickLogger';
import { Logger } from './logger';
import { NewsArticleWithEmbedding, SelectPersonalizedArticlesRequest } from './types/wasm';
import { Env } from './index';
import { Hono } from 'hono';

export class WasmDO extends DurableObject<Env> {
    private wasmInitialized: boolean = false;
    private logger: Logger; // Loggerインスタンスを保持
    private app: Hono<{ Bindings: Env }>;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.logger = new Logger(env); // Loggerを初期化
        this.app = new Hono<{ Bindings: Env }>();
        this.setupRoutes();
        ctx.waitUntil(this.initializeWasm());
    }

    async initializeWasm() {
        if (!this.wasmInitialized) {
            try {
                await init(wasmModule);
                this.wasmInitialized = true;
                this.logger.debug("WASM initialized successfully in Durable Object.");
            } catch (e) {
                this.logger.error("Failed to initialize WASM in Durable Object:", e);
                throw new Error(`WASM initialization failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    private setupRoutes() {
        // Middleware to check WASM initialization
        this.app.use('*', async (c, next) => {
            if (!this.wasmInitialized) {
                return c.text("WASM is not initialized yet. Please try again.", 503);
            }
            await next();
        });

        // POST /bulk-cosine-similarity
        this.app.post('/bulk-cosine-similarity', async (c) => {
            try {
                const { vec1s, vec2s } = await c.req.json<{ vec1s: number[][], vec2s: number[][] }>();

                if (!vec1s || !vec2s || !Array.isArray(vec1s) || !Array.isArray(vec2s)) {
                    return c.text("Missing or invalid vec1s or vec2s in request body. Please provide JSON arrays of arrays.", 400);
                }

                const results = cosine_similarity_bulk(vec1s, vec2s);

                return c.json({
                    results: results,
                    message: `WASM cosine_similarity_bulk function executed in Durable Object.`
                });
            } catch (e) {
                this.logger.error('Error in /bulk-cosine-similarity:', e);
                return c.text('Internal Server Error', 500);
            }
        });

        // GET /single-cosine-similarity
        this.app.get('/single-cosine-similarity', async (c) => {
            try {
                const vec1Param = c.req.query("vec1");
                const vec2Param = c.req.query("vec2");

                if (!vec1Param || !vec2Param) {
                    return c.text("Missing vec1 or vec2 parameters. Please provide JSON arrays.", 400);
                }

                const vec1 = JSON.parse(vec1Param);
                const vec2 = JSON.parse(vec2Param);

                if (!Array.isArray(vec1) || !Array.isArray(vec2)) {
                    return c.text("vec1 and vec2 must be JSON arrays.", 400);
                }

                const result = cosine_similarity(vec1, vec2);

                return c.json({
                    vec1: vec1,
                    vec2: vec2,
                    result: result,
                    message: `WASM cosine_similarity function executed in Durable Object.`
                });
            } catch (e) {
                this.logger.error('Error in /single-cosine-similarity:', e);
                return c.text('Internal Server Error', 500);
            }
        });

        // POST /calculate-similarity-matrix
        this.app.post('/calculate-similarity-matrix', async (c) => {
            try {
                const { vectors } = await c.req.json<{ vectors: number[][] }>();

                if (!vectors || !Array.isArray(vectors)) {
                    return c.text("Missing or invalid 'vectors' in request body. Please provide a JSON array of arrays.", 400);
                }

                const results = calculate_similarity_matrix(vectors);

                return c.json({
                    results: results,
                    message: `WASM calculate_similarity_matrix function executed in Durable Object.`
                });
            } catch (e) {
                this.logger.error('Error in /calculate-similarity-matrix:', e);
                return c.text('Internal Server Error', 500);
            }
        });

        // POST /select-personalized-articles
        this.app.post('/select-personalized-articles', async (c) => {
            try {
                const { articles, userProfileEmbeddingForSelection, userId, count, userCTR, lambda = 0.5, workerBaseUrl, negativeFeedbackEmbeddings } = await c.req.json<SelectPersonalizedArticlesRequest>();

                if (!articles || !userProfileEmbeddingForSelection || !userId || !count || userCTR === undefined) {
                    return c.text("Missing required parameters for personalized article selection.", 400);
                }

                this.logger.info(`Selecting personalized articles for user ${userId} in WASM DO (Optimized).`, { userId, articleCount: articles.length, count });

                // Durable Object から記事のUCB値を取得
                const articlesWithEmbeddingsForUCB = articles
                    .filter((article: NewsArticleWithEmbedding) => article.embedding !== undefined)
                    .map((article: NewsArticleWithEmbedding) => ({ articleId: article.articleId, embedding: article.embedding! }));

                let ucbValues: { articleId: string, ucb: number }[] = [];
                if (articlesWithEmbeddingsForUCB.length > 0) {
                    try {
                        const clickLoggerId = this.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
                        const clickLoggerStub = this.env.CLICK_LOGGER.get(clickLoggerId);

                        const response = await clickLoggerStub.fetch(new Request(`${workerBaseUrl}/get-ucb-values`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userId: userId, articlesWithEmbeddings: articlesWithEmbeddingsForUCB, userCTR: userCTR }),
                        }));

                        if (response.ok) {
                            ucbValues = await response.json();
                            this.logger.info(`Received ${ucbValues.length} UCB values from ClickLogger.`, { userId });
                        } else {
                            const text = await response.text();
                            this.logger.error(`Failed to get UCB values: ${response.status} ${text}`);
                        }
                    } catch (error) {
                        this.logger.error('Error fetching UCB values from ClickLogger in WASM DO:', error, { userId });
                    }
                }

                // ユーザー興味関心との関連度計算
                const vec1sForInterestRelevance: number[][] = [];
                const vec2sForInterestRelevance: number[][] = [];
                const articleIndicesForInterestRelevance: number[] = [];

                articles.forEach((article: NewsArticleWithEmbedding, index: number) => {
                    if (userProfileEmbeddingForSelection && article.embedding) {
                        vec1sForInterestRelevance.push(userProfileEmbeddingForSelection);
                        vec2sForInterestRelevance.push(article.embedding);
                        articleIndicesForInterestRelevance.push(index);
                    }
                });

                const interestRelevanceResults = vec1sForInterestRelevance.length > 0
                    ? cosine_similarity_bulk(vec1sForInterestRelevance, vec2sForInterestRelevance)
                    : [];

                // Negative Feedback Penalty Pre-calculation
                const negativePenaltyMap = new Map<string, number>();
                if (negativeFeedbackEmbeddings && negativeFeedbackEmbeddings.length > 0) {
                    articles.forEach(article => {
                        if (article.embedding) {
                            let maxSim = 0.0;
                            for (const negEmb of negativeFeedbackEmbeddings) {
                                if (article.embedding.length === negEmb.length) {
                                    const sim = cosine_similarity(article.embedding, negEmb);
                                    if (sim > maxSim) maxSim = sim;
                                }
                            }
                            negativePenaltyMap.set(article.articleId, maxSim);
                        }
                    });
                }

                // Calculate Initial Scores
                const articlesWithFinalScore = articles.map((article, index) => {
                    const ucbInfo = ucbValues.find(ucb => ucb.articleId === article.articleId);
                    const ucb = ucbInfo ? ucbInfo.ucb : 0;

                    let interestRelevance = 0;
                    const relevanceIndex = articleIndicesForInterestRelevance.indexOf(index);
                    if (relevanceIndex !== -1) {
                        interestRelevance = interestRelevanceResults[relevanceIndex];
                    }

                    // Weights
                    const interestWeight = 3.0;
                    const baseUcbWeight = 1.0;
                    const ucbWeight = baseUcbWeight + (1 - userCTR) * 0.5;

                    // Freshness
                    let freshnessScore = 0;
                    if (article.embedding && article.embedding.length > 0) {
                        const normalizedAge = article.embedding[article.embedding.length - 1]; // 0=New, 1=Old
                        freshnessScore = Math.max(0, 1.0 - normalizedAge);
                    }
                    const freshnessWeight = 0.8;

                    // Penalty
                    const penaltyWeight = 5.0;
                    const maxSimilarityWithNegative = negativePenaltyMap.get(article.articleId) || 0;

                    let finalScore = (interestRelevance * interestWeight) + (ucb * ucbWeight) + (freshnessScore * freshnessWeight);

                    if (maxSimilarityWithNegative > 0.6) {
                        const penaltyFactor = maxSimilarityWithNegative > 0.85 ? 10.0 : 1.0;
                        finalScore -= maxSimilarityWithNegative * penaltyWeight * penaltyFactor;
                    }

                    return {
                        ...article,
                        ucb,
                        finalScore,
                        interestRelevance,
                        embedding: article.embedding
                    };
                });

                // Filter out invalid scores or highly negative ones effectively
                const validCandidates = articlesWithFinalScore.filter(a => a.embedding && a.finalScore > -100);

                // Sort by initial score to pick the first best candidate
                validCandidates.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));

                const selected: any[] = [];
                const candidates = [...validCandidates];

                // --- Optimized MMR Loop with O(k*N) complexity ---

                // 1. Pick top 1
                if (candidates.length > 0) {
                    selected.push(candidates.shift());
                }

                const maxSimMap = new Map<string, number>();

                const { cosine_similarity_one_to_many } = await import('../linalg-wasm/pkg/linalg_wasm');

                while (selected.length < count && candidates.length > 0) {
                    const lastSelected = selected[selected.length - 1];

                    if (lastSelected && lastSelected.embedding) {
                        const candidateEmbeddings = candidates.map(c => c.embedding!);

                        let newSims: number[] = [];
                        try {
                            newSims = cosine_similarity_one_to_many(lastSelected.embedding, candidateEmbeddings) as number[];
                        } catch (e) {
                            this.logger.error("Failed to use cosine_similarity_one_to_many, falling back to TS loop", e);
                            const target = lastSelected.embedding;
                            newSims = candidateEmbeddings.map(cand => {
                                let dot = 0; let m1 = 0; let m2 = 0;
                                for (let k = 0; k < target.length; k++) {
                                    dot += target[k] * cand[k];
                                    m1 += target[k] ** 2;
                                    m2 += cand[k] ** 2;
                                }
                                return (m1 && m2) ? dot / (Math.sqrt(m1) * Math.sqrt(m2)) : 0;
                            });
                        }

                        candidates.forEach((cand, idx) => {
                            const newSim = newSims[idx];
                            const currentMax = maxSimMap.get(cand.articleId) || 0;
                            if (newSim > currentMax) {
                                maxSimMap.set(cand.articleId, newSim);
                            }
                        });
                    }

                    let bestScore = -Infinity;
                    let bestIndex = -1;

                    for (let i = 0; i < candidates.length; i++) {
                        const cand = candidates[i];
                        const sim = maxSimMap.get(cand.articleId) || 0;
                        const relevance = cand.finalScore;

                        let redundancyPenalty = 0;
                        if (sim > 0.95) redundancyPenalty = 100.0;
                        else if (sim > 0.8) redundancyPenalty = 10.0 * sim;
                        else redundancyPenalty = (1.0 - lambda) * sim * 5.0;

                        const mmr = lambda * relevance - redundancyPenalty;

                        if (mmr > bestScore) {
                            bestScore = mmr;
                            bestIndex = i;
                        }
                    }

                    if (bestIndex !== -1) {
                        selected.push(candidates.splice(bestIndex, 1)[0]);
                    } else {
                        break;
                    }
                }

                this.logger.info(`Finished personalized article selection via Optimized MMR. Selected ${selected.length} articles.`, { userId, selectedCount: selected.length });

                const avgRelevance = selected.reduce((sum, a) => sum + (a.interestRelevance || 0), 0) / (selected.length || 1);

                return c.json({
                    articles: selected,
                    avgRelevance: avgRelevance
                });

            } catch (e: any) {
                this.logger.error(`Error executing WASM function:`, e);
                return c.json({
                    error: `Failed to execute WASM function: ${e.message || e}`
                }, 500);
            }
        });
    }

    async fetch(request: Request): Promise<Response> {
        return this.app.fetch(request, this.env);
    }
}
