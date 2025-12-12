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

export class WasmDO extends DurableObject<Env> {
    private wasmInitialized: boolean = false;
    private logger: Logger; // Loggerインスタンスを保持

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.logger = new Logger(env); // Loggerを初期化
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

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        let path = url.pathname;

        // Durable Object が期待するパスに変換するため、/wasm-do を削除
        if (path.startsWith('/wasm-do')) {
            path = path.replace('/wasm-do', '');
        }

        if (!this.wasmInitialized) {
            return new Response("WASM is not initialized yet. Please try again.", { status: 503 });
        }

        try {
            if (path === '/bulk-cosine-similarity') {
                const { vec1s, vec2s } = await request.json() as { vec1s: number[][], vec2s: number[][] };

                if (!vec1s || !vec2s || !Array.isArray(vec1s) || !Array.isArray(vec2s)) {
                    return new Response("Missing or invalid vec1s or vec2s in request body. Please provide JSON arrays of arrays.", { status: 400 });
                }

                const results = cosine_similarity_bulk(vec1s, vec2s);

                return new Response(JSON.stringify({
                    results: results,
                    message: `WASM cosine_similarity_bulk function executed in Durable Object.`
                }), { headers: { "Content-Type": "application/json" } });

            } else if (path === '/single-cosine-similarity') {
                const vec1Param = url.searchParams.get("vec1");
                const vec2Param = url.searchParams.get("vec2");

                if (!vec1Param || !vec2Param) {
                    return new Response("Missing vec1 or vec2 parameters. Please provide JSON arrays.", { status: 400 });
                }

                const vec1 = JSON.parse(vec1Param);
                const vec2 = JSON.parse(vec2Param);

                if (!Array.isArray(vec1) || !Array.isArray(vec2)) {
                    return new Response("vec1 and vec2 must be JSON arrays.", { status: 400 });
                }

                const result = cosine_similarity(vec1, vec2);

                return new Response(JSON.stringify({
                    vec1: vec1,
                    vec2: vec2,
                    result: result,
                    message: `WASM cosine_similarity function executed in Durable Object.`
                }), { headers: { "Content-Type": "application/json" } });
            } else if (path === '/calculate-similarity-matrix') {
                const { vectors } = await request.json() as { vectors: number[][] };

                if (!vectors || !Array.isArray(vectors)) {
                    return new Response("Missing or invalid 'vectors' in request body. Please provide a JSON array of arrays.", { status: 400 });
                }

                const results = calculate_similarity_matrix(vectors);

                return new Response(JSON.stringify({
                    results: results,
                    message: `WASM calculate_similarity_matrix function executed in Durable Object.`
                }), { headers: { "Content-Type": "application/json" } });

            } else if (path === '/select-personalized-articles') {
                const { articles, userProfileEmbeddingForSelection, userId, count, userCTR, lambda = 0.5, workerBaseUrl, negativeFeedbackEmbeddings } = await request.json() as SelectPersonalizedArticlesRequest;

                if (!articles || !userProfileEmbeddingForSelection || !userId || !count || userCTR === undefined) {
                    return new Response("Missing required parameters for personalized article selection.", { status: 400 });
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
                    // Optimization: Use bulk similarity or loop? Since negative feedback is usually small, loop is okay.
                    // Or better, use our new one-to-many?
                    // For now, keep simple JS loop as "negativeFeedbackEmbeddings" is likely small (<10).
                    articles.forEach(article => {
                        if (article.embedding) {
                            let maxSim = 0.0;
                            for (const negEmb of negativeFeedbackEmbeddings) {
                                if (article.embedding.length === negEmb.length) {
                                    // Use simple dot product if normalized, or cosine_similarity from wasm import
                                    // We imported cosine_similarity from pkg
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
                    // Interest is most important for "Smartness".
                    // UCB helps verify exploration.
                    const interestWeight = 3.0;
                    const baseUcbWeight = 1.0;
                    const ucbWeight = baseUcbWeight + (1 - userCTR) * 0.5;

                    // Freshness
                    let freshnessScore = 0;
                    if (article.embedding && article.embedding.length > 0) {
                        const normalizedAge = article.embedding[article.embedding.length - 1]; // 0=New, 1=Old
                        // Exponential decay: e^(-5 * age) to prioritize very fresh content heavily
                        // normalizedAge is roughly (hours / 24) * some_factor ?
                        // Assuming normalizedAge is 0.0 to 1.0 mapping linearly to 24-48 hours.
                        // Let's use linear for now but sharper.
                        freshnessScore = Math.max(0, 1.0 - normalizedAge);
                    }
                    const freshnessWeight = 0.8; // Increased slightly

                    // Penalty
                    const penaltyWeight = 5.0; // Strong penalty for disallowed content
                    const maxSimilarityWithNegative = negativePenaltyMap.get(article.articleId) || 0;

                    let finalScore = (interestRelevance * interestWeight) + (ucb * ucbWeight) + (freshnessScore * freshnessWeight);

                    if (maxSimilarityWithNegative > 0.6) {
                        // Soft penalty 0.6-0.8, Hard penalty > 0.8
                        const penaltyFactor = maxSimilarityWithNegative > 0.85 ? 10.0 : 1.0;
                        finalScore -= maxSimilarityWithNegative * penaltyWeight * penaltyFactor;
                    }

                    return {
                        ...article,
                        ucb,
                        finalScore,
                        interestRelevance,
                        embedding: article.embedding // Ensure embedding is kept for MMR
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

                // Initialize maxSimilarityWithSelected for all candidates
                // Map candidate index to its max similarity with any selected article
                // Since candidates array changes (shift/splice), we can just store this property on the object or parallel array.
                // Let's use a Map<articleId, number> for current max similarity.
                const maxSimMap = new Map<string, number>();

                // Import dynamically added function
                const { cosine_similarity_one_to_many } = await import('../linalg-wasm/pkg/linalg_wasm');

                while (selected.length < count && candidates.length > 0) {
                    const lastSelected = selected[selected.length - 1];

                    // Optimization: Only calculate similarity between `lastSelected` and all `candidates`.
                    // Then update `maxSimMap`.

                    if (lastSelected && lastSelected.embedding) {
                        const candidateEmbeddings = candidates.map(c => c.embedding!);

                        // Calls new Rust function: one-to-many
                        let newSims: number[] = [];
                        try {
                            newSims = cosine_similarity_one_to_many(lastSelected.embedding, candidateEmbeddings) as number[];
                        } catch (e) {
                            this.logger.error("Failed to use cosine_similarity_one_to_many, falling back to TS loop", e);
                            // Fallback TS loop
                            const target = lastSelected.embedding;
                            newSims = candidateEmbeddings.map(cand => {
                                // Simple cosine sim
                                let dot = 0; let m1 = 0; let m2 = 0;
                                for (let k = 0; k < target.length; k++) {
                                    dot += target[k] * cand[k];
                                    m1 += target[k] ** 2;
                                    m2 += cand[k] ** 2;
                                }
                                return (m1 && m2) ? dot / (Math.sqrt(m1) * Math.sqrt(m2)) : 0;
                            });
                        }

                        // Update maxSimMap
                        candidates.forEach((cand, idx) => {
                            const newSim = newSims[idx];
                            const currentMax = maxSimMap.get(cand.articleId) || 0;
                            if (newSim > currentMax) {
                                maxSimMap.set(cand.articleId, newSim);
                            }
                        });
                    }

                    // Now find best MMR score
                    let bestScore = -Infinity;
                    let bestIndex = -1;

                    for (let i = 0; i < candidates.length; i++) {
                        const cand = candidates[i];
                        const sim = maxSimMap.get(cand.articleId) || 0;
                        const relevance = cand.finalScore;

                        // Dynamic Penalty:
                        // if sim > 0.9 -> huge penalty (duplicate)
                        // if sim > 0.7 -> moderate penalty (very similar)
                        // else -> standard penalty

                        let redundancyPenalty = 0;
                        if (sim > 0.95) redundancyPenalty = 100.0;
                        else if (sim > 0.8) redundancyPenalty = 10.0 * sim;
                        else redundancyPenalty = (1.0 - lambda) * sim * 5.0; // original factor 

                        const mmr = lambda * relevance - redundancyPenalty;

                        if (mmr > bestScore) {
                            bestScore = mmr;
                            bestIndex = i;
                        }
                    }

                    if (bestIndex !== -1) {
                        selected.push(candidates.splice(bestIndex, 1)[0]);
                    } else {
                        // Should not happen if candidates > 0, but break just in case
                        break;
                    }
                }

                this.logger.info(`Finished personalized article selection via Optimized MMR. Selected ${selected.length} articles.`, { userId, selectedCount: selected.length });

                const avgRelevance = selected.reduce((sum, a) => sum + (a.interestRelevance || 0), 0) / (selected.length || 1);

                return new Response(JSON.stringify({
                    articles: selected,
                    avgRelevance: avgRelevance
                }), { headers: { "Content-Type": "application/json" } });

            } else {
                return new Response("Invalid WASM DO endpoint.", { status: 404 });
            }
        } catch (e: any) {
            this.logger.error(`Error executing WASM function:`, e);
            return new Response(JSON.stringify({
                error: `Failed to execute WASM function: ${e.message || e}`
            }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }
}
