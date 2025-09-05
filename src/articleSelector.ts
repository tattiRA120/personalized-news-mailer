// @ts-nocheck
// src/articleSelector.ts

import { UserProfile } from './userProfile';
import { ClickLogger } from './clickLogger';
import { logError, logInfo, logWarning } from './logger';
import { NewsArticle } from './newsCollector';
import { getArticleByIdFromD1 } from './services/d1Service'; // D1ServiceからgetArticleByIdFromD1をインポート
import { Env } from './index';

// コサイン類似度を計算するヘルパー関数
function cosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length || vec1.length === 0) {
        logWarning("Vector dimensions mismatch or zero length for cosine similarity.", { vec1Length: vec1.length, vec2Length: vec2.length });
        return 0; // ベクトルのサイズが異なるかゼロの場合は類似度なし
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
        dotProduct += vec1[i] * vec2[i];
        norm1 += vec1[i] * vec1[i];
        norm2 += vec2[i] * vec2[i];
    }

    if (norm1 === 0 || norm2 === 0) {
        logWarning("Zero vector encountered for cosine similarity.", { norm1, norm2 });
        return 0; // ゼロベクトルとの類似度なし
    }

    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

// MMR (Maximal Marginal Relevance) と Contextual Bandit を組み合わせて記事を選択する関数
// ClickLogger Durable Object を引数として受け取り、バンディットモデルからUCB値を取得する
export async function selectPersonalizedArticles(
    articles: NewsArticle[],
    userProfile: UserProfile,
    clickLogger: DurableObjectStub<ClickLogger>, // Durable Object インスタンスを受け取る
    userId: string,
    count: number,
    lambda: number = 0.5, // MMR パラメータ
    env: Env
): Promise<NewsArticle[]> {
    if (articles.length === 0 || count <= 0) {
        logInfo("No articles or count is zero, returning empty selection.", { articleCount: articles.length, count });
        return [];
    }

    logInfo(`Selecting personalized articles for user ${userProfile.userId}`, { userId: userProfile.userId, articleCount: articles.length, count });

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
                body: JSON.stringify({ userId: userId, articlesWithEmbeddings: articlesWithEmbeddings }),
            }));

            if (response.ok) {
                ucbValues = await response.json();
                logInfo(`Received ${ucbValues.length} UCB values from ClickLogger.`, { userId: userProfile.userId, ucbCount: ucbValues.length });
                if (ucbValues.length === 0) {
                    logWarning(`ClickLogger returned empty UCB values for user ${userId}.`, { userId: userProfile.userId });
                }
            } else {
                const errorText = await response.text();
                logError(`Failed to get UCB values from ClickLogger: ${response.statusText}`, undefined, { userId: userProfile.userId, status: response.status, statusText: response.statusText, errorText });
            }
        } catch (error) {
            logError('Error fetching UCB values from ClickLogger:', error, { userId: userProfile.userId });
        }
    } else {
        logWarning("No articles with embeddings to send to ClickLogger for UCB calculation.", { userId: userProfile.userId });
    }


    // 記事にUCB値をマッピングし、最終的な関連度スコアを計算
    // ユーザーの興味関心データ（userProfile.embedding）を取得
    const userInterestEmbedding = userProfile.embedding;

    const articlesWithFinalScore = articles.map(article => {
        const ucbInfo = ucbValues.find(ucb => ucb.articleId === article.articleId); // articleId で検索
        const ucb = ucbInfo ? ucbInfo.ucb : 0; // UCB値がない場合は0とする

        // ユーザーの興味関心との関連度を計算 (コサイン類似度を使用)
        let interestRelevance = 0;
        if (userInterestEmbedding && article.embedding) {
            interestRelevance = cosineSimilarity(userInterestEmbedding, article.embedding);
        }

        // TODO: これらの重みは調整可能なハイパーパラメータとすることができます。
        const interestWeight = 1.0;
        const ucbWeight = 1.0;
        const finalScore = interestRelevance * interestWeight + ucb * ucbWeight;

        logDebug(`Article "${article.title}" - Interest Relevance: ${interestRelevance.toFixed(4)}, UCB: ${ucb.toFixed(4)}, Final Score: ${finalScore.toFixed(4)}`, {
            userId: userProfile.userId,
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

    // 最終スコアで降順にソート
    const sortedArticles = [...articlesWithFinalScore].sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));

    logInfo(`Sorted articles by final score.`, { userId: userProfile.userId });

    const selected: NewsArticle[] = [];
    const remaining = [...sortedArticles];

    // 最初の記事（最も最終スコアが高い）を選択
    const firstArticle = remaining.shift();
    if (firstArticle) {
        selected.push(firstArticle);
        logInfo(`Selected first article: "${firstArticle.title}" (Final Score: ${firstArticle.finalScore})`, { userId: userProfile.userId, articleTitle: firstArticle.title, finalScore: firstArticle.finalScore });
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
                        const similarity = cosineSimilarity(currentArticle.embedding, selectedArticle.embedding);
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
            logInfo(`Selected article "${nextArticle.title}" using MMR (MMR Score: ${bestMMRScore}).`, { userId: userProfile.userId, articleTitle: nextArticle.title, mmrScore: bestMMRScore });
        } else {
            // 適切な記事が見つからなかった場合（例: 全ての記事のembeddingがないなど）
            logWarning("Could not find a suitable article using MMR. Stopping selection.", { userId: userProfile.userId, selectedCount: selected.length, remainingCount: remaining.length });
            break;
        }
    }

    logInfo(`Finished personalized article selection. Selected ${selected.length} articles.`, { userId: userProfile.userId, selectedCount: selected.length });
    return selected;
}


// Basic function to select top N articles based on score (元の関数も残しておく)
export function selectTopArticles(articles: NewsArticle[], count: number): NewsArticle[] {
    logInfo(`Selecting top ${count} articles based on score.`, { count, articleCount: articles.length });
    // Sort articles by score in descending order
    const sortedArticles = articles.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Select the top N articles
    const selected = sortedArticles.slice(0, count);
    logInfo(`Selected ${selected.length} top articles.`, { selectedCount: selected.length });
    return selected;
}
