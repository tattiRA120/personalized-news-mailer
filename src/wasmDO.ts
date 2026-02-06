import { DurableObject } from "cloudflare:workers";

// WASMモジュールをインポート
import init, { cosine_similarity } from '../linalg-wasm/pkg/linalg_wasm.js';
import wasmModule from '../linalg-wasm/pkg/linalg_wasm_bg.wasm';
import { cosine_similarity_bulk, calculate_similarity_matrix } from '../linalg-wasm/pkg/linalg_wasm';

// 依存関係のインポート
import { ClickLogger } from './clickLogger';
import { Logger } from './logger';
import { NewsArticleWithEmbedding, SelectPersonalizedArticlesRequest } from './types/wasm';
import { Env } from './types/bindings';
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
            this.logger.info(`WASM DO middleware check`, {
                wasmInitialized: this.wasmInitialized,
                path: c.req.path,
                method: c.req.method
            });

            if (!this.wasmInitialized) {
                this.logger.warn(`WASM not initialized yet for request: ${c.req.method} ${c.req.path}`);
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
                const { articles, userProfileEmbeddingForSelection, userId, count, userCTR, lambda = 0.5, workerBaseUrl, negativeFeedbackEmbeddings, recentInterestEmbeddings } = await c.req.json<SelectPersonalizedArticlesRequest>();

                if (!articles || !userProfileEmbeddingForSelection || !userId || !count || userCTR === undefined) {
                    return c.text("Missing required parameters for personalized article selection.", 400);
                }

                this.logger.info(`Selecting personalized articles for user ${userId} using Portfolio Algorithm.`, { userId, articleCount: articles.length, count });

                // --- 1. Pre-calculate scores for all articles ---

                // Fetch UCB values from ClickLogger
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
                        }
                    } catch (error) {
                        this.logger.error('Error fetching UCB values from ClickLogger in WASM DO:', error, { userId });
                    }
                }

                // Long-Term Interest Relevance (Sim to User Profile)
                const longTermRelevanceMap = new Map<string, number>();
                if (userProfileEmbeddingForSelection) {
                    const vec1s = articles.filter(a => a.embedding).map(() => userProfileEmbeddingForSelection);
                    const vec2s = articles.filter(a => a.embedding).map(a => a.embedding!);
                    if (vec1s.length > 0) {
                        const results = cosine_similarity_bulk(vec1s, vec2s);
                        const articlesWithEmb = articles.filter(a => a.embedding);
                        results.forEach((sim: number, idx: number) => {
                            longTermRelevanceMap.set(articlesWithEmb[idx].articleId, sim);
                        });
                    }
                }

                // Short-Term Interest Relevance (Max Sim to Recent Clicks)
                const shortTermRelevanceMap = new Map<string, number>();
                if (recentInterestEmbeddings && recentInterestEmbeddings.length > 0) {
                    articles.forEach(article => {
                        if (article.embedding) {
                            let maxSim = 0;
                            for (const recentEmb of recentInterestEmbeddings) {
                                if (article.embedding.length === recentEmb.length) {
                                    const sim = cosine_similarity(article.embedding, recentEmb);
                                    if (sim > maxSim) maxSim = sim;
                                }
                            }
                            shortTermRelevanceMap.set(article.articleId, maxSim);
                        }
                    });
                }

                // Negative Feedback Penalty
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

                // Freshness & UCB Scores
                const articlesWithScores = articles.map(article => {
                    const ucbInfo = ucbValues.find(ucb => ucb.articleId === article.articleId);
                    const ucb = ucbInfo ? ucbInfo.ucb : 0;
                    let freshnessScore = 0;
                    if (article.embedding && article.embedding.length > 0) {
                        const normalizedAge = article.embedding[article.embedding.length - 1];
                        freshnessScore = Math.max(0, 1.0 - normalizedAge);
                    }
                    const longTerm = longTermRelevanceMap.get(article.articleId) || 0;
                    const shortTerm = shortTermRelevanceMap.get(article.articleId) || 0;
                    const negPenalty = negativePenaltyMap.get(article.articleId) || 0;

                    return {
                        ...article,
                        ucb,
                        freshnessScore,
                        longTermRelevance: longTerm,
                        shortTermRelevance: shortTerm,
                        negativePenalty: negPenalty,
                    };
                });

                // Filter out articles with high negative penalty
                const validCandidates = articlesWithScores.filter(a => a.embedding && a.negativePenalty < 0.75);

                // --- 2. Portfolio Selection: 3 Buckets ---
                const selectedIds = new Set<string>();
                const selected: typeof validCandidates = [];

                const countA = Math.max(1, Math.floor(count * 0.4)); // Long-Term: 40%
                const countB = Math.max(1, Math.floor(count * 0.4)); // Short-Term: 40%
                const countC = Math.max(1, count - countA - countB);  // Exploration: 20%

                // Bucket A: Long-Term Interest (Sort by longTermRelevance)
                const bucketA = [...validCandidates]
                    .sort((a, b) => b.longTermRelevance - a.longTermRelevance)
                    .filter(a => !selectedIds.has(a.articleId))
                    .slice(0, countA);
                bucketA.forEach(a => { selected.push(a); selectedIds.add(a.articleId); });
                this.logger.debug(`Portfolio Bucket A (Long-Term): Selected ${bucketA.length} articles.`);

                // Bucket B: Short-Term Interest (Sort by shortTermRelevance)
                const bucketB = [...validCandidates]
                    .sort((a, b) => b.shortTermRelevance - a.shortTermRelevance)
                    .filter(a => !selectedIds.has(a.articleId))
                    .slice(0, countB);
                bucketB.forEach(a => { selected.push(a); selectedIds.add(a.articleId); });
                this.logger.debug(`Portfolio Bucket B (Short-Term): Selected ${bucketB.length} articles.`);

                // Bucket C: Exploration (Sort by UCB + Freshness)
                const bucketC = [...validCandidates]
                    .sort((a, b) => (b.ucb + b.freshnessScore) - (a.ucb + a.freshnessScore))
                    .filter(a => !selectedIds.has(a.articleId))
                    .slice(0, countC);
                bucketC.forEach(a => { selected.push(a); selectedIds.add(a.articleId); });
                this.logger.debug(`Portfolio Bucket C (Exploration): Selected ${bucketC.length} articles.`);

                // --- 3. MMR De-duplication Pass (Relaxed) ---
                // Remove near-duplicate articles from the final list
                const { cosine_similarity_one_to_many } = await import('../linalg-wasm/pkg/linalg_wasm');
                const finalSelected: typeof selected = [];
                const SIMILARITY_THRESHOLD = 0.90;

                for (const article of selected) {
                    if (!article.embedding) {
                        finalSelected.push(article);
                        continue;
                    }
                    let isDuplicate = false;
                    if (finalSelected.length > 0) {
                        const existingEmbeddings = finalSelected.filter(a => a.embedding).map(a => a.embedding!);
                        if (existingEmbeddings.length > 0) {
                            try {
                                const sims = cosine_similarity_one_to_many(article.embedding, existingEmbeddings) as number[];
                                if (sims.some(s => s > SIMILARITY_THRESHOLD)) {
                                    isDuplicate = true;
                                }
                            } catch (e) {
                                this.logger.warn("MMR dedup fallback", e);
                            }
                        }
                    }
                    if (!isDuplicate) {
                        finalSelected.push(article);
                    }
                }

                // If MMR removed too many, fill from remaining candidates
                if (finalSelected.length < count) {
                    const remaining = validCandidates
                        .filter(a => !finalSelected.some(f => f.articleId === a.articleId))
                        .sort((a, b) => (b.longTermRelevance + b.shortTermRelevance) - (a.longTermRelevance + a.shortTermRelevance));
                    let idx = 0;
                    while (finalSelected.length < count && idx < remaining.length) {
                        finalSelected.push(remaining[idx]);
                        idx++;
                    }
                }

                this.logger.info(`Finished Portfolio Algorithm. Selected ${finalSelected.length} articles.`, { userId, selectedCount: finalSelected.length });

                const avgRelevance = finalSelected.reduce((sum, a) => sum + (a.longTermRelevance || 0), 0) / (finalSelected.length || 1);

                return c.json({
                    articles: finalSelected,
                    avgRelevance: avgRelevance
                });

            } catch (e: any) {
                this.logger.error(`Error executing WASM function:`, e);
                return c.json({
                    error: `Failed to execute WASM function: ${e.message || e}`
                }, 500);
            }
        });


        // Not Found Handler
        this.app.notFound((c) => {
            this.logger.error(`WASM DO: Route not found`, {
                method: c.req.method,
                path: c.req.path,
                url: c.req.url
            });
            return c.text('Not Found', 404);
        });
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        this.logger.info(`WASM DO received request: ${request.method} ${url.pathname}`, {
            method: request.method,
            pathname: url.pathname,
            fullUrl: request.url
        });

        const response = await this.app.fetch(request, this.env);

        this.logger.info(`WASM DO response status: ${response.status}`, {
            status: response.status,
            pathname: url.pathname
        });

        return response;
    }
}
