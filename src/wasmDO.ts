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

                this.logger.info(`Selecting personalized articles for user ${userId} in WASM DO.`, { userId, articleCount: articles.length, count });

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
                            this.logger.info(`Received ${ucbValues.length} UCB values from ClickLogger in WASM DO.`, { userId, ucbCount: ucbValues.length });
                        } else {
                            const errorText = await response.text();
                            this.logger.error(`Failed to get UCB values from ClickLogger in WASM DO: ${response.statusText}. Error: ${errorText}`, undefined, { userId, status: response.status, statusText: response.statusText, errorText });
                        }
                    } catch (error) {
                        this.logger.error('Error fetching UCB values from ClickLogger in WASM DO:', error, { userId });
                    }
                } else {
                    this.logger.warn("No articles with embeddings to send to ClickLogger for UCB calculation in WASM DO.", { userId });
                }

                // ユーザーの興味関心との関連度をバッチで計算 (コサイン類似度を使用)
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

                // Pre-calculate negative feedback similarities
                const negativePenaltyMap = new Map<string, number>();
                if (negativeFeedbackEmbeddings && negativeFeedbackEmbeddings.length > 0) {
                    articles.forEach(article => {
                        if (article.embedding) {
                            let maxSim = -1.0; // Initialize with lowest possible similarity
                            for (const negEmb of negativeFeedbackEmbeddings) {
                                // Ensure dimensions match (ignoring freshness dimension difference if any, but ideally they match)
                                // Assuming both are extended or both are not, or at least compatible for dot product
                                if (article.embedding.length === negEmb.length) {
                                    const sim = cosine_similarity(article.embedding, negEmb);
                                    if (sim > maxSim) maxSim = sim;
                                }
                            }
                            negativePenaltyMap.set(article.articleId, maxSim);
                        }
                    });
                }

                const articlesWithFinalScore = articles.map((article, index) => {
                    const ucbInfo = ucbValues.find(ucb => ucb.articleId === article.articleId);
                    const ucb = ucbInfo ? ucbInfo.ucb : 0;

                    let interestRelevance = 0;
                    const relevanceIndex = articleIndicesForInterestRelevance.indexOf(index);
                    if (relevanceIndex !== -1) {
                        interestRelevance = interestRelevanceResults[relevanceIndex];
                    }

                    const interestWeight = 3.0;
                    const baseUcbWeight = 1.0;
                    const ucbWeight = baseUcbWeight + (1 - userCTR) * 0.5;

                    // --- Freshness Boost ---
                    const freshnessWeight = 0.5;
                    // embeddingの最後の要素が鮮度情報 (0.0 - 1.0, 1.0が最新)
                    // ただし、embeddingの次元が拡張されている場合のみ
                    let freshnessScore = 0;
                    if (article.embedding && article.embedding.length > 0) {
                        // 最後の要素を取得
                        const normalizedAge = article.embedding[article.embedding.length - 1];
                        // normalizedAgeは 0(最新) -> 1(古い) なので、 1 - normalizedAge でスコア化
                        freshnessScore = 1.0 - normalizedAge;
                    }

                    // --- Negative Feedback Penalty ---
                    const penaltyWeight = 2.0;
                    const maxSimilarityWithNegative = negativePenaltyMap.get(article.articleId) || 0;

                    let finalScore = interestRelevance * interestWeight + ucb * ucbWeight + freshnessScore * freshnessWeight;

                    // Apply penalty if similarity is significant (e.g., > 0.5)
                    if (maxSimilarityWithNegative > 0.5) {
                        finalScore -= maxSimilarityWithNegative * penaltyWeight;
                    }


                    return {
                        ...article,
                        ucb: ucb,
                        finalScore: finalScore,
                    };
                });

                // 最終スコアで降順にソート
                const sortedArticles = [...articlesWithFinalScore].sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));

                const selected: NewsArticleWithEmbedding[] = [];
                const remaining = [...sortedArticles];

                // 最初の記事（最も最終スコアが高い）を選択
                const firstArticle = remaining.shift();
                if (firstArticle) {
                    selected.push(firstArticle);
                }

                // MMRのための全記事間の類似度行列を事前に計算
                const allArticleEmbeddings = articles.filter(article => article.embedding !== undefined).map(article => article.embedding!);
                const similarityMatrix = allArticleEmbeddings.length > 0
                    ? calculate_similarity_matrix(allArticleEmbeddings)
                    : [];

                // 記事IDとインデックスのマッピングを作成
                const articleIdToIndexMap = new Map<string, number>();
                articles.forEach((article: NewsArticleWithEmbedding, index: number) => {
                    articleIdToIndexMap.set(article.articleId, index);
                });

                // 残りからMMRに基づいて記事を選択
                while (selected.length < count && remaining.length > 0) {
                    let bestMMRScore = -Infinity;
                    let bestArticleIndex = -1;

                    for (let i = 0; i < remaining.length; i++) {
                        const currentArticle = remaining[i];
                        if (!currentArticle.embedding) {
                            continue;
                        }

                        let maxSimilarityWithSelected = 0;
                        const currentArticleOriginalIndex = articleIdToIndexMap.get(currentArticle.articleId);

                        if (currentArticleOriginalIndex !== undefined) {
                            for (const selectedArticle of selected) {
                                const selectedArticleOriginalIndex = articleIdToIndexMap.get(selectedArticle.articleId);
                                if (selectedArticleOriginalIndex !== undefined && similarityMatrix[currentArticleOriginalIndex] && similarityMatrix[currentArticleOriginalIndex][selectedArticleOriginalIndex] !== undefined) {
                                    maxSimilarityWithSelected = Math.max(maxSimilarityWithSelected, similarityMatrix[currentArticleOriginalIndex][selectedArticleOriginalIndex]);
                                }
                            }
                        }

                        // MMR スコアの計算: lambda * Relevance - (1 - lambda) * Similarity
                        // Relevance は finalScore を使用
                        const relevance = currentArticle.finalScore || 0;
                        // Similarity は 0-1 の範囲だが、finalScoreはより大きな値を取りうるため、
                        // 類似度ペナルティをスケールアップして効果を保証する (係数 5.0)
                        const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarityWithSelected * 5.0;

                        if (mmrScore > bestMMRScore) {
                            bestMMRScore = mmrScore;
                            bestArticleIndex = i;
                        }
                    }

                    if (bestArticleIndex !== -1) {
                        const [nextArticle] = remaining.splice(bestArticleIndex, 1);
                        selected.push(nextArticle);
                    } else {
                        break;
                    }
                }

                this.logger.info(`Finished personalized article selection in WASM DO. Selected ${selected.length} articles.`, { userId, selectedCount: selected.length });

                return new Response(JSON.stringify(selected), { headers: { "Content-Type": "application/json" } });

            } else {
                return new Response("Invalid WASM DO endpoint. Use /bulk-cosine-similarity (POST), /single-cosine-similarity (GET), /calculate-similarity-matrix (POST), or /select-personalized-articles (POST).", { status: 404 });
            }

        } catch (e: any) {
            this.logger.error(`Error executing WASM function:`, e);
            return new Response(JSON.stringify({
                error: `Failed to execute WASM function: ${e.message || e}`
            }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }
}
