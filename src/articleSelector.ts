// @ts-nocheck
// src/articleSelector.ts

import { Logger } from './logger';
import { NewsArticle } from './newsCollector';
import { Env } from './index';

// コサイン類似度をバッチで計算するヘルパー関数 (Durable Object経由)
async function cosineSimilarityBulk(vec1s: number[][], vec2s: number[][], logger: Logger, env: Env): Promise<number[]> {
    if (vec1s.length === 0 || vec1s.length !== vec2s.length) {
        logger.warn("Input vector arrays are empty or have mismatched lengths for bulk cosine similarity.", { vec1sLength: vec1s.length, vec2sLength: vec2s.length });
        return new Array(vec1s.length).fill(0);
    }

    try {
        const wasmDOId = env.WASM_DO.idFromName("wasm-calculator");
        const wasmDOStub = env.WASM_DO.get(wasmDOId);

        const response = await wasmDOStub.fetch(new Request(`${env.WORKER_BASE_URL}/bulk-cosine-similarity`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vec1s, vec2s }),
        }));

        if (response.ok) {
            const data = await response.json() as { results: number[] };
            logger.debug(`Bulk cosine similarity calculated via WASM DO. Returned ${data.results.length} results.`, { requestCount: vec1s.length, resultCount: data.results.length });
            return data.results;
        } else {
            const errorText = await response.text();
            logger.error(`Failed to calculate bulk cosine similarity via WASM DO: ${response.statusText}. Error: ${errorText}`, null, { status: response.status, statusText: response.statusText });
            return new Array(vec1s.length).fill(0); // エラー時は0の配列を返す
        }
    } catch (error) {
        logger.error("Exception when calculating bulk cosine similarity via WASM DO:", error);
        return new Array(vec1s.length).fill(0); // エラー時は0の配列を返す
    }
}

// 全記事間の類似度行列を計算するヘルパー関数 (Durable Object経由)
async function calculateSimilarityMatrix(vectors: number[][], logger: Logger, env: Env): Promise<number[][]> {
    if (vectors.length === 0) {
        logger.warn("Input vector array is empty for similarity matrix calculation.", { vectorsLength: vectors.length });
        return [];
    }

    try {
        const wasmDOId = env.WASM_DO.idFromName("wasm-calculator");
        const wasmDOStub = env.WASM_DO.get(wasmDOId);

        const response = await wasmDOStub.fetch(new Request(`${env.WORKER_BASE_URL}/calculate-similarity-matrix`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vectors }),
        }));

        if (response.ok) {
            const data = await response.json() as { results: number[][] };
            logger.debug(`Similarity matrix calculated via WASM DO. Returned ${data.results.length}x${data.results[0]?.length || 0} matrix.`, { vectorCount: vectors.length, matrixSize: data.results.length });
            return data.results;
        } else {
            const errorText = await response.text();
            logger.error(`Failed to calculate similarity matrix via WASM DO: ${response.statusText}. Error: ${errorText}`, null, { status: response.status, statusText: response.statusText });
            return []; // エラー時は空の配列を返す
        }
    } catch (error) {
        logger.error("Exception when calculating similarity matrix via WASM DO:", error);
        return []; // エラー時は空の配列を返す
    }
}

/**
 * D1に保存されている記事の中から、互いに類似度が低い記事を組み合わせて選択します。
 * @param articles 選択対象となる記事の配列（embeddingを含む）
 * @param count 選択する記事の数
 * @param env 環境変数
 * @returns 選択された記事の配列
 */
export async function selectDissimilarArticles(
    articles: NewsArticle[],
    count: number,
    env: Env
): Promise<NewsArticle[]> {
    const logger = new Logger(env);

    if (articles.length === 0 || count <= 0) {
        logger.info("No articles or count is zero, returning empty selection for dissimilar articles.", { articleCount: articles.length, count });
        return [];
    }

    // embeddingがない記事は除外
    const articlesWithEmbeddings = articles.filter(article => article.embedding !== undefined && article.embedding.length > 0);

    if (articlesWithEmbeddings.length < count) {
        logger.warn(`Not enough articles with embeddings to select ${count} dissimilar articles. Selecting all available.`, { available: articlesWithEmbeddings.length, requested: count });
        return articlesWithEmbeddings;
    }

    logger.info(`Selecting ${count} dissimilar articles from ${articlesWithEmbeddings.length} available articles.`, { availableCount: articlesWithEmbeddings.length, requestedCount: count });

    const selected: NewsArticle[] = [];
    const remaining = [...articlesWithEmbeddings];

    // 最初の記事をランダムに選択
    const randomIndex = Math.floor(Math.random() * remaining.length);
    const firstArticle = remaining.splice(randomIndex, 1)[0];
    selected.push(firstArticle);
    logger.debug(`Selected first article randomly: "${firstArticle.title}"`, { articleTitle: firstArticle.title });

    const allArticleEmbeddings = articles.filter(article => article.embedding !== undefined).map(article => article.embedding!);
    // 全記事間の類似度行列を事前に計算 (ループの外で1回だけ実行)
    const similarityMatrix = allArticleEmbeddings.length > 0
        ? await calculateSimilarityMatrix(allArticleEmbeddings, logger, env)
        : [];

    const articleIdToIndexMap = new Map<string, number>();
    articles.forEach((article, index) => {
        articleIdToIndexMap.set(article.articleId, index);
    });

    while (selected.length < count && remaining.length > 0) {
        let bestDissimilarityScore = -Infinity;
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

            // スコア = 1 - (選択済みリスト内の各記事とのコサイン類似度の最大値)
            // 類似度が低いほどスコアが高くなる
            const dissimilarityScore = 1 - maxSimilarityWithSelected;

            if (dissimilarityScore > bestDissimilarityScore) {
                bestDissimilarityScore = dissimilarityScore;
                bestArticleIndex = i;
            }
        }

        if (bestArticleIndex !== -1) {
            const [nextArticle] = remaining.splice(bestArticleIndex, 1);
            selected.push(nextArticle);
            logger.debug(`Selected article "${nextArticle.title}" with dissimilarity score: ${bestDissimilarityScore.toFixed(4)}`, { articleTitle: nextArticle.title, dissimilarityScore: bestDissimilarityScore });
        } else {
            logger.warn("Could not find a suitable dissimilar article. Stopping selection.", { selectedCount: selected.length, remainingCount: remaining.length });
            break;
        }
    }

    logger.info(`Finished selecting dissimilar articles. Selected ${selected.length} articles.`, { selectedCount: selected.length });
    return selected;
}

