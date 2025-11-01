// @ts-nocheck
// src/articleSelector.ts

import { UserProfile } from './userProfile';
import { ClickLogger } from './clickLogger';
import { Logger } from './logger';
import { NewsArticle } from './newsCollector';
import { getArticleByIdFromD1 } from './services/d1Service'; // D1ServiceからgetArticleByIdFromD1をインポート
import { Env } from './index';

// コサイン類似度を計算するヘルパー関数 (Durable Object経由)
export async function cosineSimilarity(vec1: number[], vec2: number[], logger: Logger, env: Env): Promise<number> {
    if (vec1.length !== vec2.length || vec1.length === 0) {
        logger.warn("Vector dimensions mismatch or zero length for cosine similarity.", { vec1Length: vec1.length, vec2Length: vec2.length });
        return 0; // ベクトルのサイズが異なるかゼロの場合は類似度なし
    }

    try {
        const wasmDOId = env.WASM_DO.idFromName("wasm-calculator");
        const wasmDOStub = env.WASM_DO.get(wasmDOId);

        const url = new URL(`${env.WORKER_BASE_URL}/wasm-do`);
        url.searchParams.set("vec1", JSON.stringify(vec1));
        url.searchParams.set("vec2", JSON.stringify(vec2));

        const response = await wasmDOStub.fetch(new Request(url.toString(), { method: 'GET' }));

        if (response.ok) {
            const data = await response.json() as { result: number };
            logger.debug(`Cosine similarity calculated via WASM DO: ${data.result}`, { vec1Length: vec1.length, vec2Length: vec2.length });
            return data.result;
        } else {
            logger.error(`Failed to calculate cosine similarity via WASM DO: ${response.statusText}`, null, { status: response.status, statusText: response.statusText });
            return 0; // エラー時は0を返す
        }
    } catch (error) {
        logger.error("Exception when calculating cosine similarity via WASM DO:", error);
        return 0; // エラー時は0を返す
    }
}

// MMR (Maximal Marginal Relevance) と Contextual Bandit を組み合わせて記事を選択する関数
// ClickLogger Durable Object を引数として受け取り、バンディットモデルからUCB値を取得する
export async function selectPersonalizedArticles(
    articles: NewsArticle[],
    userProfileEmbeddingForSelection: number[],
    clickLogger: DurableObjectStub<ClickLogger>, // Durable Object インスタンスを受け取る
    userId: string,
    count: number,
    userCTR: number,
    lambda: number = 0.5, // MMR パラメータ
    env: Env
): Promise<NewsArticle[]> {
    const logger = new Logger(env); // Loggerインスタンスを生成
    if (articles.length === 0 || count <= 0) {
        logger.info("No articles or count is zero, returning empty selection.", { articleCount: articles.length, count });
        return [];
    }

    logger.info(`Selecting personalized articles for user ${userId}`, { userId, articleCount: articles.length, count });

    // Durable Object から記事のUCB値を取得
    const articlesWithEmbeddings = articles
        .filter(article => article.embedding !== undefined) // embedding が存在する記事のみ
        .map(article => ({ articleId: article.articleId, embedding: article.embedding! })); // articleId を使用

    let ucbValues: { articleId: string, ucb: number }[] = [];
    if (articlesWithEmbeddings.length > 0) {
        try {
            // Durable Objectへのリクエストは、ワーカーのベースURLを考慮する必要があるため、
            // ここではダミーホストではなく、相対パスで指定します。
            // Durable Objectは同じワーカー内で動作するため、ホストは不要です。
            const response = await clickLogger.fetch(new Request(`${env.WORKER_BASE_URL}/get-ucb-values`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: userId, articlesWithEmbeddings: articlesWithEmbeddings, userCTR: userCTR }),
            }));

            if (response.ok) {
                ucbValues = await response.json();
                logger.info(`Received ${ucbValues.length} UCB values from ClickLogger.`, { userId, ucbCount: ucbValues.length });
                if (ucbValues.length === 0) {
                    logger.warn(`ClickLogger returned empty UCB values for user ${userId}.`, { userId });
                }
            } else {
                const errorText = await response.text();
                logger.error(`Failed to get UCB values from ClickLogger: ${response.statusText}`, undefined, { userId, status: response.status, statusText: response.statusText, errorText });
            }
        } catch (error) {
            logger.error('Error fetching UCB values from ClickLogger:', error, { userId });
        }
    } else {
        logger.warn("No articles with embeddings to send to ClickLogger for UCB calculation.", { userId });
    }


    // 記事にUCB値をマッピングし、最終的な関連度スコアを計算
    // ユーザーの興味関心データ（userProfileEmbeddingForSelection）を取得
    const userInterestEmbedding = userProfileEmbeddingForSelection;

    const articlesWithFinalScorePromises = articles.map(async article => {
        const ucbInfo = ucbValues.find(ucb => ucb.articleId === article.articleId); // articleId で検索
        const ucb = ucbInfo ? ucbInfo.ucb : 0; // UCB値がない場合は0とする

        // ユーザーの興味関心との関連度を計算 (コサイン類似度を使用)
        let interestRelevance = 0;
        if (userInterestEmbedding && article.embedding) {
            interestRelevance = await cosineSimilarity(userInterestEmbedding, article.embedding, logger, env); // loggerとenvを渡す
        }

        // Dynamically adjust ucbWeight based on user CTR
        // Low CTR -> higher ucbWeight (more exploration)
        // High CTR -> lower ucbWeight (more exploitation)
        const interestWeight = 1.0; // Keep interest relevance weight constant
        const baseUcbWeight = 1.0;
        const ucbWeight = baseUcbWeight + (1 - userCTR) * 1.0; // ucbWeight ranges from 1.0 (CTR=1) to 2.0 (CTR=0)
        logger.debug(`Using dynamic ucbWeight: ${ucbWeight.toFixed(4)} based on CTR: ${userCTR.toFixed(4)}`);

        const finalScore = interestRelevance * interestWeight + ucb * ucbWeight;

        logger.debug(`Article "${article.title}" - Interest Relevance: ${interestRelevance.toFixed(4)}, UCB: ${ucb.toFixed(4)}, Final Score: ${finalScore.toFixed(4)}`, {
            userId,
            articleTitle: article.title,
            interestRelevance: interestRelevance,
            ucb: ucb,
            finalScore: finalScore
        });

        return {
            ...article,
            ucb: ucb, // UCB値も保持
            finalScore: finalScore, // 最終スコアを保持
        };
    });
    const articlesWithFinalScore = await Promise.all(articlesWithFinalScorePromises);

    // 最終スコアで降順にソート
    const sortedArticles = [...articlesWithFinalScore].sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));

    logger.info(`Sorted articles by final score.`, { userId });

    const selected: NewsArticle[] = [];
    const remaining = [...sortedArticles];

    // 最初の記事（最も最終スコアが高い）を選択
    const firstArticle = remaining.shift();
    if (firstArticle) {
        selected.push(firstArticle);
        logger.info(`Selected first article: "${firstArticle.title}" (Final Score: ${firstArticle.finalScore})`, { userId, articleTitle: firstArticle.title, finalScore: firstArticle.finalScore });
    }

    // 残りからMMRに基づいて記事を選択
    while (selected.length < count && remaining.length > 0) {
        let bestMMRScore = -Infinity;
        let bestArticleIndex = -1;

        for (let i = 0; i < remaining.length; i++) {
            const currentArticle = remaining[i];
            let maxSimilarityWithSelected = 0;

            if (currentArticle.embedding) {
                for (const selectedArticle of selected) {
                    if (selectedArticle.embedding) {
                        const similarity = await cosineSimilarity(currentArticle.embedding, selectedArticle.embedding, logger, env);
                        maxSimilarityWithSelected = Math.max(maxSimilarityWithSelected, similarity);
                    }
                }
            } else {
                // 埋め込みがない場合はスキップ
                continue;
            }

            // MMR スコアの計算: lambda * Relevance - (1 - lambda) * Similarity
            // Relevance は finalScore を使用
            const relevance = currentArticle.finalScore || 0;
            const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarityWithSelected;

            if (mmrScore > bestMMRScore) {
                bestMMRScore = mmrScore;
                bestArticleIndex = i;
            }
        }

        if (bestArticleIndex !== -1) {
            const [nextArticle] = remaining.splice(bestArticleIndex, 1);
            selected.push(nextArticle);
            logger.info(`Selected article "${nextArticle.title}" using MMR (MMR Score: ${bestMMRScore}).`, { userId, articleTitle: nextArticle.title, mmrScore: bestMMRScore });
        } else {
            // 適切な記事が見つからなかった場合（例: 全ての記事のembeddingがないなど）
            logger.warn("Could not find a suitable article using MMR. Stopping selection.", { userId, selectedCount: selected.length, remainingCount: remaining.length });
            break;
        }
    }

    logger.info(`Finished personalized article selection. Selected ${selected.length} articles.`, { userId, selectedCount: selected.length });
    return selected;
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
    const logger = new Logger(env); // Loggerインスタンスを生成

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

    // 残りから類似度が低い記事を選択
    while (selected.length < count && remaining.length > 0) {
        let bestDissimilarityScore = -Infinity;
        let bestArticleIndex = -1;

        for (let i = 0; i < remaining.length; i++) {
            const currentArticle = remaining[i];
            let maxSimilarityWithSelected = 0;

            for (const selectedArticle of selected) {
                // embeddingが存在することはフィルタリング済み
                const similarity = await cosineSimilarity(currentArticle.embedding!, selectedArticle.embedding!, logger, env);
                maxSimilarityWithSelected = Math.max(maxSimilarityWithSelected, similarity);
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


// Basic function to select top N articles based on score (元の関数も残しておく)
export function selectTopArticles(articles: NewsArticle[], count: number): NewsArticle[] {
    // logInfo(`Selecting top ${count} articles based on score.`, { count, articleCount: articles.length }); // ログ出力を削除
    // Sort articles by score in descending order
    const sortedArticles = articles.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Select the top N articles
    const selected = sortedArticles.slice(0, count);
    // logInfo(`Selected ${selected.length} top articles.`, { selectedCount: selected.length }); // ログ出力を削除
    return selected;
}
