import { DurableObject } from "cloudflare:workers";

// WASMモジュールをインポート
import init, { cosine_similarity } from '../linalg-wasm/pkg/linalg_wasm.js';
import wasmModule from '../linalg-wasm/pkg/linalg_wasm_bg.wasm';
import { cosine_similarity_bulk, calculate_similarity_matrix, cosine_similarity_one_to_many } from '../linalg-wasm/pkg/linalg_wasm';

// 依存関係のインポート
import { ClickLogger } from './clickLogger';
import { Logger } from './logger';
import { NewsArticleWithEmbedding, SelectPersonalizedArticlesRequest } from './types/wasm';
import { Env } from './types/bindings';
import { Hono } from 'hono';

interface ScoredArticle extends NewsArticleWithEmbedding {
    ucb: number;
    freshnessScore: number;
    longTermRelevance: number;
    shortTermRelevance: number;
    negativePenalty: number;
    explorationScore: number;
}

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
            /* ログ過多のためコメントアウト
            this.logger.info(`WASM DO middleware check`, {
                wasmInitialized: this.wasmInitialized,
                path: c.req.path,
                method: c.req.method
            });
            */

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
        // Iterative Selection with Integrated Diversity (Refactored)
        this.app.post('/select-personalized-articles', async (c) => {
            try {
                const { articles, userProfileEmbeddingForSelection, userId, count, userCTR, lambda = 0.5, workerBaseUrl, negativeFeedbackEmbeddings, recentInterestEmbeddings } = await c.req.json<SelectPersonalizedArticlesRequest>();

                if (!articles || !userProfileEmbeddingForSelection || !userId || !count || userCTR === undefined) {
                    return c.text("Missing required parameters for personalized article selection.", 400);
                }

                this.logger.info(`Selecting personalized articles for user ${userId} using Iterative Selection Algorithm.`, { userId, articleCount: articles.length, count });

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

                // Short-Term Interest Relevance (Time-Decayed Weighted Average)
                // recentInterestEmbeddings は既に直近のもの順（新しい順）に来ていると仮定したいが、配列なのでインデックス0が最新かどうかに依存する。
                // d1Service.ts の getRecentPositiveFeedbackEmbeddings 実装を見ると `ORDER BY timestamp DESC` なので、0が最新。
                const shortTermRelevanceMap = new Map<string, number>();
                if (recentInterestEmbeddings && recentInterestEmbeddings.length > 0) {
                    articles.forEach(article => {
                        if (article.embedding) {
                            let weightedSum = 0;
                            let totalWeight = 0;
                            const DECAY_FACTOR = 0.8; // 古いものほど影響力を下げる

                            for (let i = 0; i < recentInterestEmbeddings.length; i++) {
                                const recentEmb = recentInterestEmbeddings[i];
                                if (article.embedding.length === recentEmb.length) {
                                    const sim = cosine_similarity(article.embedding, recentEmb);
                                    // 類似度が正の場合のみ加算（負の類似度はノイズになり得るので無視、あるいはそのまま加算もアリだが今回は正の興味にフォーカス）
                                    if (sim > 0) {
                                        const weight = Math.pow(DECAY_FACTOR, i);
                                        weightedSum += sim * weight;
                                        totalWeight += weight;
                                    }
                                }
                            }
                            // 重み付け平均。履歴がない場合は0。
                            shortTermRelevanceMap.set(article.articleId, totalWeight > 0 ? weightedSum / totalWeight : 0);
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

                // Calculate Scores
                const articlesWithScores: ScoredArticle[] = articles.map(article => {
                    const ucbInfo = ucbValues.find(ucb => ucb.articleId === article.articleId);
                    const ucb = ucbInfo ? ucbInfo.ucb : 0.0;
                    
                    let freshnessScore = 0.0;
                    // Freshness is normalized 0 to 1 based on age in updated embedding
                    if (article.embedding && article.embedding.length > 0) {
                        const normalizedAge = article.embedding[article.embedding.length - 1];
                        // normalizedAge is 0 (newest) to 1 (oldest/1week)
                        freshnessScore = Math.max(0, 1.0 - normalizedAge);
                    }
                    
                    const longTerm = longTermRelevanceMap.get(article.articleId) || 0;
                    const shortTerm = shortTermRelevanceMap.get(article.articleId) || 0;
                    const negPenalty = negativePenaltyMap.get(article.articleId) || 0;

                    // Exploration Score: Combine UCB and Freshness
                    // UCB is typically small (e.g. 0.1 - 0.5 range for limited trials), Freshness is 0-1.
                    // Normalize UCB? For now, we scale Freshness to match UCB's importance or vice versa.
                    // Let's simply weight them.
                    const explorationScore = (ucb * 1.5) + (freshnessScore * 1.0);

                    return {
                        ...article,
                        embedding: article.embedding!, // Filter ensures this later
                        ucb,
                        freshnessScore,
                        longTermRelevance: longTerm,
                        shortTermRelevance: shortTerm,
                        negativePenalty: negPenalty,
                        explorationScore: explorationScore
                    };
                });

                // Filter valid candidates
                // Must have embedding, and must not be too similar to negative feedback
                let candidates = articlesWithScores.filter(a => a.embedding !== undefined && a.negativePenalty < 0.75);

                // --- 2. Iterative Selection with Integrated Diversity ---
                
                const selectedArticles: ScoredArticle[] = [];
                const selectedIds = new Set<string>();
                
                // Diversity Check Helper
                const SIMILARITY_THRESHOLD = 0.85; // 重複とみなす閾値
                const isTooSimilarToSelected = (candidate: ScoredArticle): boolean => {
                    if (selectedArticles.length === 0) return false;
                    const existingEmbeddings = selectedArticles.map(a => a.embedding);
                    // cosine_similarity_one_to_many は1つのベクトルと複数のベクトルの類似度配列を返す
                    const sims = cosine_similarity_one_to_many(candidate.embedding, existingEmbeddings) as number[];
                    // どれか1つでも閾値を超えたら「類似しすぎ」と判定
                    return sims.some(sim => sim > SIMILARITY_THRESHOLD);
                };

                // Sort candidates for each criterion beforehand to optimize selection
                // Note: We need to re-scan for diversity, so we can't just pop from a stack,
                // but we can iterate through a sorted list until we find a non-similar one.
                const sortedByLong = [...candidates].sort((a, b) => b.longTermRelevance - a.longTermRelevance);
                const sortedByShort = [...candidates].sort((a, b) => b.shortTermRelevance - a.shortTermRelevance);
                const sortedByExplore = [...candidates].sort((a, b) => b.explorationScore - a.explorationScore);

                // Pointers for each sorted list
                let ptrLong = 0;
                let ptrShort = 0;
                let ptrExplore = 0;

                // Selection Ratios
                // Pattern: A, B, A, B, C... (40% A, 40% B, 20% C)
                // Cycle of 5: A, B, A, B, C
                const selectionPattern = ['A', 'B', 'A', 'B', 'C'];
                let patternIdx = 0;

                while (selectedArticles.length < count && candidates.length > selectedIds.size) {
                    const turn = selectionPattern[patternIdx % selectionPattern.length];
                    let chosen: ScoredArticle | null = null;
                    let sourceBucket = '';

                    if (turn === 'A') {
                        // Long-Term
                        while (ptrLong < sortedByLong.length) {
                            const cand = sortedByLong[ptrLong];
                            ptrLong++;
                            if (!selectedIds.has(cand.articleId)) {
                                if (!isTooSimilarToSelected(cand)) {
                                    chosen = cand;
                                    sourceBucket = 'Long-Term';
                                    break;
                                }
                            }
                        }
                    } else if (turn === 'B') {
                        // Short-Term
                        while (ptrShort < sortedByShort.length) {
                            const cand = sortedByShort[ptrShort];
                            ptrShort++;
                            if (!selectedIds.has(cand.articleId)) {
                                if (!isTooSimilarToSelected(cand)) {
                                    chosen = cand;
                                    sourceBucket = 'Short-Term';
                                    break;
                                }
                            }
                        }
                    } else {
                        // Exploration (C)
                        while (ptrExplore < sortedByExplore.length) {
                            const cand = sortedByExplore[ptrExplore];
                            ptrExplore++;
                            if (!selectedIds.has(cand.articleId)) {
                                if (!isTooSimilarToSelected(cand)) {
                                    chosen = cand;
                                    sourceBucket = 'Exploration';
                                    break;
                                }
                            }
                        }
                    }

                    // If failed to find in the preferred bucket (due to diversity checks), 
                    // try to fallback to the best remaining available from ANY list
                    // (For simplicity, we just skip the turn if null, and the loop continues to next turn pattern)
                    // But if we skip too many times, we might not fill the list.
                    // Let's implement a fallback inside the loop if chosen is null.
                    
                    if (!chosen) {
                         // Fallback: Pick highest "Long-Term" (safest) that isn't selected, ignorance of diversity check if strictly needed?
                         // Better: Relax diversity check? Or just pick next available from sortedByLong skipping diversity check if we represent "Desperation"
                         // For now, let's just proceed to next turn. If we circle through all patterns and can't find anything, we might be stuck.
                         // But `candidates.length > selectedIds.size` ensures we have candidates.
                         // If we iterated through ALL sorted lists and found nothing, it means everything remaining is "too similar".
                         // In that case, we MUST pick something.
                         if (ptrLong >= sortedByLong.length && ptrShort >= sortedByShort.length && ptrExplore >= sortedByExplore.length) {
                             // All lists exhausted with diversity check.
                             // Force pick from remaining unselected
                             const remaining = candidates.filter(a => !selectedIds.has(a.articleId));
                             if (remaining.length > 0) {
                                 chosen = remaining[0]; // Pick any
                                 sourceBucket = 'Fallback';
                             } else {
                                 break; // No more candidates
                             }
                         }
                    }

                    if (chosen) {
                        selectedArticles.push(chosen);
                        selectedIds.add(chosen.articleId);
                        // Log chosen article for debugging?
                        // this.logger.debug(`Selected: ${chosen.title} [${sourceBucket}]`);
                    }
                    
                    patternIdx++;
                }

                this.logger.info(`Finished Iterative Selection. Selected ${selectedArticles.length} articles.`, { userId, selectedCount: selectedArticles.length });

                const avgRelevance = selectedArticles.reduce((sum, a) => sum + (a.longTermRelevance || 0), 0) / (selectedArticles.length || 1);

                return c.json({
                    articles: selectedArticles,
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
        // this.logger.info(`WASM DO received request: ${request.method} ${url.pathname}`, { // ログ削減
        //     method: request.method,
        //     pathname: url.pathname,
        //     fullUrl: request.url
        // });

        const response = await this.app.fetch(request, this.env);

        // this.logger.info(`WASM DO response status: ${response.status}`, { // ログ削減
        //     status: response.status,
        //     pathname: url.pathname
        // });

        return response;
    }
}
