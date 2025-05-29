// @ts-nocheck
// src/articleSelector.ts

import { UserProfile } from './userProfile';
import { ClickLogger } from './clickLogger'; // ClickLogger型が必要なのでimport
import { logError, logInfo, logWarning } from './logger'; // Import logging helpers

import { NewsArticle } from './newsCollector'; // Import NewsArticle from newsCollector.ts

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
// @ts-ignore: Durable Object Stub の型に関するエラーを抑制
export async function selectPersonalizedArticles(
    articles: NewsArticle[],
    userProfile: UserProfile,
    clickLogger: DurableObjectStub<any>, // Durable Object インスタンスを受け取る (型エラー回避のためanyを使用)
    count: number,
    lambda: number = 0.5, // MMR パラメータ
    allSentArticles: NewsArticle[] // ユーザーに送信された全記事のリストを追加 (現在は使用しないが引数として残す)
): Promise<NewsArticle[]> {
    if (articles.length === 0 || count <= 0) {
        logInfo("No articles or count is zero, returning empty selection.", { articleCount: articles.length, count });
        return [];
    }

    logInfo(`Selecting personalized articles for user ${userProfile.userId}`, { userId: userProfile.userId, articleCount: articles.length, count });

    // Durable Object から記事のUCB値を取得
    const articlesWithEmbeddings = articles
        .filter(article => article.embedding !== undefined) // embedding が存在する記事のみ
        .map(article => ({ articleId: article.link, embedding: article.embedding! })); // articleId として link を使用

    let ucbValues: { articleId: string, ucb: number }[] = [];
    if (articlesWithEmbeddings.length > 0) {
        try {
            const response = await clickLogger.fetch(new Request('http://dummy-host/get-ucb-values', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ articlesWithEmbeddings }),
            }));

            if (response.ok) {
                ucbValues = await response.json();
                logInfo(`Received ${ucbValues.length} UCB values from ClickLogger.`, { userId: userProfile.userId, ucbCount: ucbValues.length });
            } else {
                const errorText = await response.text();
                logError(`Failed to get UCB values from ClickLogger: ${response.statusText}`, null, { userId: userProfile.userId, status: response.status, statusText: response.statusText, errorText });
            }
        } catch (error) {
            logError('Error fetching UCB values from ClickLogger:', error, { userId: userProfile.userId });
        }
    } else {
        logWarning("No articles with embeddings to send to ClickLogger for UCB calculation.", { userId: userProfile.userId });
    }


    // 記事にUCB値をマッピングし、最終的な関連度スコアを計算
    // ユーザーの興味関心データ（選択された記事のembedding）を取得
    // userProfile.interests には選択された記事の articleId (ここではリンク) が格納されている
    const interestedArticleLinks = userProfile.interests || [];
    const interestedArticles = articles.filter(article => interestedArticleLinks.includes(article.link));

    // 興味関心のある記事のembeddingの平均ベクトルを計算
    let averageInterestedEmbedding: number[] | null = null;
    if (interestedArticles.length > 0) {
        const dimension = interestedArticles[0].embedding?.length || 0;
        if (dimension > 0) {
            averageInterestedEmbedding = Array(dimension).fill(0);
            for (const article of interestedArticles) {
                if (article.embedding && article.embedding.length === dimension) {
                    for (let i = 0; i < dimension; i++) {
                        averageInterestedEmbedding[i] += article.embedding[i];
                    }
                }
            }
            for (let i = 0; i < dimension; i++) {
                averageInterestedEmbedding[i] /= interestedArticles.length;
            }
        }
    }

    const articlesWithFinalScore = articles.map(article => {
        const ucbInfo = ucbValues.find(ucb => ucb.articleId === article.link); // articleId は link と仮定
        const ucb = ucbInfo ? ucbInfo.ucb : 0; // UCB値がない場合は0とする

        // ユーザーの興味関心との関連度を計算 (コサイン類似度を使用)
        let interestRelevance = 0;
        if (averageInterestedEmbedding && article.embedding) {
            interestRelevance = cosineSimilarity(averageInterestedEmbedding, article.embedding);
        }

        // 最終的な関連度スコアを計算
        // 興味関心との関連度と UCB 値を組み合わせます。
        // TODO: これらの重みは調整可能なハイパーパラメータとすることができます。
        const interestWeight = 1.0;
        const ucbWeight = 0.5;
        const finalScore = interestRelevance * interestWeight + ucb * ucbWeight;

        return {
            ...article,
            ucb: ucb, // UCB値も保持
            finalScore: finalScore, // 最終スコアを保持
            interestRelevance: interestRelevance, // 興味関心との関連度も保持（デバッグ用など）
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
