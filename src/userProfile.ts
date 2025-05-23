// src/userProfile.ts

import { logError, logInfo, logWarning } from './logger'; // Import logging helpers
import { ARTICLE_CATEGORIES } from './config'; // カテゴリーリストを取得するためにconfigをインポート

// NewsArticleWithCategory インターフェースの定義
interface NewsArticleWithCategory {
    title: string;
    link: string;
    category?: string; // カテゴリー情報を含む
    // Add other fields as needed
}


export interface UserProfile {
    userId: string;
    email?: string; // Add email to profile for easier access
    // keywords?: string[]; // 廃止
    interests: string[]; // 教育プログラムで選択された記事ID (リンク)
    clickedArticleIds: string[]; // クリックされた記事ID (リンク)
    sentArticleIds?: string[]; // Track articles sent to the user
    categoryInterestScores: { [category: string]: number }; // カテゴリーごとの興味関心スコアを追加
    categoryLastUpdated?: { [category: string]: number }; // カテゴリーごとの最終更新タイムスタンプを追加 (Unix time in milliseconds)
    // Add other profile data as needed
    // interestVector?: number[]; // To be generated/updated based on clicked articles
}

// Assuming a KV Namespace binding named 'mail-news-user-profiles' from wrangler.jsonc
// Add this binding to your wrangler.toml:
// [[kv_namespaces]]
// binding = "mail-news-user-profiles"
// id = "<your_kv_namespace_id>"

export async function getUserProfile(userId: string, env: { 'mail-news-user-profiles': KVNamespace }): Promise<UserProfile | null> {
    try {
        const profile = await env['mail-news-user-profiles'].get(userId, { type: 'json' });
        if (profile) {
            logInfo(`Retrieved user profile for ${userId}.`, { userId });
            // profile が UserProfile 型であることを確認し、categoryInterestScores や categoryLastUpdated が存在しない場合に初期化
            const userProfile = profile as UserProfile; // 明示的にキャスト
            if (!userProfile.categoryInterestScores) {
                 userProfile.categoryInterestScores = {};
                 logInfo(`Initialized categoryInterestScores for user ${userId}.`, { userId });
            }
            if (!userProfile.categoryLastUpdated) {
                userProfile.categoryLastUpdated = {};
                logInfo(`Initialized categoryLastUpdated for user ${userId}.`, { userId });
            }
            return userProfile; // キャストしたオブジェクトを返す
        } else {
            logInfo(`User profile not found for ${userId}.`, { userId });
            return null;
        }
    } catch (error) {
        logError(`Error getting user profile for ${userId}:`, error, { userId });
        return null;
    }
}

export async function updateUserProfile(profile: UserProfile, env: { 'mail-news-user-profiles': KVNamespace }): Promise<void> {
    try {
        await env['mail-news-user-profiles'].put(profile.userId, JSON.stringify(profile));
        logInfo(`Updated user profile for ${profile.userId}.`, { userId: profile.userId });
    } catch (error) {
        logError(`Error updating user profile for ${profile.userId}:`, error, { userId: profile.userId });
    }
}

// Create a new user profile and store email-to-userId mapping
export async function createUserProfile(userId: string, email: string, env: { 'mail-news-user-profiles': KVNamespace }): Promise<UserProfile> {
    const newUserProfile: UserProfile = {
        userId: userId,
        email: email, // Store email in profile
        interests: [], // Initial empty click history (教育プログラム)
        clickedArticleIds: [], // Initial empty click history (メールクリック)
        sentArticleIds: [], // Initialize sent articles array
        categoryInterestScores: {}, // カテゴリーごとの興味関心スコアを初期化
        categoryLastUpdated: {}, // カテゴリーごとの最終更新タイムスタンプを初期化
        // Initialize other profile data as needed
    };

    try {
        // Save the user profile
        await env['mail-news-user-profiles'].put(userId, JSON.stringify(newUserProfile));
        // Save the email-to-userId mapping
        await env['mail-news-user-profiles'].put(`email_to_userId:${email}`, userId);
        logInfo(`Created new user profile for ${userId} with email ${email}`, { userId, email });
        return newUserProfile;
    } catch (error) {
        logError(`Error creating user profile for ${userId}:`, error, { userId, email });
        throw error; // Re-throw to indicate failure
    }
}

// Get user ID by email address
export async function getUserIdByEmail(email: string, env: { 'mail-news-user-profiles': KVNamespace }): Promise<string | null> {
    try {
        const userId = await env['mail-news-user-profiles'].get(`email_to_userId:${email}`);
        if (userId) {
            logInfo(`Retrieved user ID for email ${email}: ${userId}`, { email, userId });
        } else {
            logInfo(`User ID not found for email ${email}.`, { email });
        }
        return userId;
    } catch (error) {
        logError(`Error getting user ID for email ${email}:`, error, { email });
        return null;
    }
}

// Get all user IDs
export async function getAllUserIds(env: { 'mail-news-user-profiles': KVNamespace }): Promise<string[]> {
    try {
        // List all keys with no prefix to get user IDs directly,
        // or list keys with a specific prefix if user IDs are stored with one.
        // Assuming user IDs are stored as top-level keys for now.
        // Need to filter out email_to_userId keys.
        const listResult = await env['mail-news-user-profiles'].list();
        const userIds = listResult.keys
            .map(key => key.name)
            .filter(keyName => !keyName.startsWith('email_to_userId:')); // Filter out mapping keys

        logInfo(`Retrieved ${userIds.length} user IDs.`, { userCount: userIds.length });
        return userIds;
    } catch (error) {
        logError('Error getting all user IDs:', error);
        return []; // Return empty array on error
    }
}

/**
 * ユーザーのカテゴリー興味関心スコアを更新する
 * @param userProfile 更新対象のユーザープロファイル
 * @param educationLogs 教育プログラムで新しく選択された記事のログリスト（記事IDとタイムスタンプを含む）
 * @param clickLogs メールで新しくクリックされた記事のログリスト（記事IDとタイムスタンプを含む）
 * @param sentLogs メールで送信された記事のログリスト（記事IDとタイムスタンプを含む）
 * @param classifiedArticles カテゴリー情報付きの全記事リスト（ログに含まれる記事IDに対応するカテゴリーを取得するため）
 * @returns 更新されたユーザープロファイル
 */
export function updateCategoryInterestScores(
    userProfile: UserProfile,
    educationLogs: { articleId: string; timestamp: number; }[],
    clickLogs: { articleId: string; timestamp: number; }[],
    sentLogs: { articleId: string; timestamp: number; }[],
    classifiedArticles: NewsArticleWithCategory[] // カテゴリー情報付き記事リスト
): UserProfile {
    logInfo(`Updating category interest scores for user ${userProfile.userId}.`, { userId: userProfile.userId });

    // 現在のスコアと最終更新タイムスタンプをコピー
    const updatedScores = { ...userProfile.categoryInterestScores };
    const updatedLastUpdated = { ...userProfile.categoryLastUpdated };

    // 各カテゴリーの初期スコアを0とする（まだスコアがないカテゴリーの場合）
    for (const category of ARTICLE_CATEGORIES) {
        if (updatedScores[category] === undefined) {
            updatedScores[category] = 0;
        }
    }

    // 記事IDからカテゴリーを素早く引けるマップを作成
    const articleCategoryMap = new Map<string, string>();
    for (const article of classifiedArticles) {
        if (article.category) {
            articleCategoryMap.set(article.link, article.category); // 記事IDはlinkと仮定
        }
    }

    const now = Date.now(); // 現在のタイムスタンプ (ミリ秒)
    const millisecondsPerDay = 24 * 60 * 60 * 1000;
    const decayPeriodDays = 30; // スコアを減衰させる期間 (日)
    const decayFactor = 0.5; // 減衰率 (例: 0.5で半分になる)

    // --- 最終更新から一定期間経過したカテゴリーのスコアを減衰 ---
    for (const category in updatedScores) {
        const lastUpdated = updatedLastUpdated[category] || 0;
        const daysSinceLastUpdate = (now - lastUpdated) / millisecondsPerDay;

        if (daysSinceLastUpdate > decayPeriodDays) {
            // 一定期間更新がない場合、スコアを減衰させる
            // シンプルに半分にする例
            updatedScores[category] = (updatedScores[category] || 0) * decayFactor;
            logInfo(`Category '${category}' score decayed due to inactivity (${daysSinceLastUpdate.toFixed(1)} days since last update). New score: ${updatedScores[category].toFixed(2)}.`, { userId: userProfile.userId, category: category, daysSinceLastUpdate, newScore: updatedScores[category] });
        }
    }


    // --- 教育プログラムでの選択に基づくスコア更新 ---
    const educationWeight = 1.5; // 教育プログラムの選択に与える重み
    for (const log of educationLogs) {
        const category = articleCategoryMap.get(log.articleId);
        if (category) {
            // 時間減衰を考慮した加算
            const daysAgo = (now - log.timestamp) / millisecondsPerDay;
            const timeDecay = Math.exp(-daysAgo / 30); // 例: 30日で約1/eに減衰
            updatedScores[category] = (updatedScores[category] || 0) + timeDecay * educationWeight;
            updatedLastUpdated[category] = now; // スコアが更新されたカテゴリーの最終更新タイムスタンプを更新
            logInfo(`Education selection in category '${category}' added score (decayed: ${timeDecay.toFixed(2)}).`, { userId: userProfile.userId, category: category, timeDecay });
        }
    }

    // --- メールクリックに基づくスコア更新 ---
    const clickWeight = 1.0; // クリックに与える重み
    const impressionWeight = 0.5; // インプレッション（送信）に与える負の重み（クリックされなかった場合の減点）

    // カテゴリーごとの送信数とクリック数を集計
    const categorySentCounts: { [category: string]: number } = {};
    const categoryClickCounts: { [category: string]: number } = {};
    const categoryClickTimestamps: { [category: string]: number[] } = {}; // 時間減衰用タイムスタンプ

    for (const log of sentLogs) {
        const category = articleCategoryMap.get(log.articleId);
        if (category) {
            categorySentCounts[category] = (categorySentCounts[category] || 0) + 1;
        }
    }

    for (const log of clickLogs) {
        const category = articleCategoryMap.get(log.articleId);
        if (category) {
            categoryClickCounts[category] = (categoryClickCounts[category] || 0) + 1;
            if (!categoryClickTimestamps[category]) {
                categoryClickTimestamps[category] = [];
            }
            categoryClickTimestamps[category].push(log.timestamp);
        }
    }

    for (const category of ARTICLE_CATEGORIES) {
        if (category === 'その他') continue;

        const sentCount = categorySentCounts[category] || 0;
        const clickCount = categoryClickCounts[category] || 0;
        const clickTimestamps = categoryClickTimestamps[category] || [];

        // クリック率に基づくスコア加算
        if (sentCount > 0) {
            const clickRate = clickCount / sentCount;
            // クリック率が高いほどスコア貢献大
            updatedScores[category] = (updatedScores[category] || 0) + clickRate * clickWeight;
            updatedLastUpdated[category] = now; // スコアが更新されたカテゴリーの最終更新タイムスタンプを更新
             logInfo(`Category '${category}' added score based on click rate (${clickRate.toFixed(2)}).`, { userId: userProfile.userId, category: category, clickRate });
        } else if (clickCount > 0) {
             // 送信数が0だがクリックがある場合（理論上は少ないはずだが）
             updatedScores[category] = (updatedScores[category] || 0) + clickCount * clickWeight;
             updatedLastUpdated[category] = now; // スコアが更新されたカテゴリーの最終更新タイムスタンプを更新
             logWarning(`Category '${category}' has clicks but 0 sent count. Adding score based on click count.`, { userId: userProfile.userId, category: category, clickCount });
        }


        // 時間減衰を考慮したクリック頻度に基づくスコア加算
        let timeDecayedClickScore = 0;
        for (const timestamp of clickTimestamps) {
             const daysAgo = (now - timestamp) / millisecondsPerDay;
             const timeDecay = Math.exp(-daysAgo / 30); // 例: 30日で約1/eに減衰
             timeDecayedClickScore += timeDecay;
        }
         updatedScores[category] = (updatedScores[category] || 0) + timeDecayedClickScore * clickWeight;
         if (timeDecayedClickScore > 0) {
             updatedLastUpdated[category] = now; // スコアが更新されたカテゴリーの最終更新タイムスタンプを更新
         }
         logInfo(`Category '${category}' added score based on time-decayed clicks (${timeDecayedClickScore.toFixed(2)}).`, { userId: userProfile.userId, category: category, timeDecayedClickScore });


        // クリックされなかった場合の減点 (インプレッションに基づく)
        // 送信されたがクリックされなかった記事が多いカテゴリーはスコアを減らす
        const notClickedCount = sentCount - clickCount;
        if (notClickedCount > 0) {
             // 簡易的に、クリックされなかった数に負の重みをつける
             updatedScores[category] = (updatedScores[category] || 0) - notClickedCount * impressionWeight;
             // 減点の場合も最終更新タイムスタンプを更新するかは検討の余地あり。今回は更新しないでおく。
             logInfo(`Category '${category}' deducted score based on not clicked count (${notClickedCount}).`, { userId: userProfile.userId, category: category, notClickedCount });
        }
    }

    // --- スコアの正規化 ---
    let totalScore = 0;
    for (const category in updatedScores) {
        // スコアが負にならないようにする
        updatedScores[category] = Math.max(0, updatedScores[category]);
        totalScore += updatedScores[category];
    }

    // 合計が1になるように正規化
    if (totalScore > 0) {
        for (const category in updatedScores) {
            updatedScores[category] /= totalScore;
        }
         logInfo(`Normalized category interest scores. Total score: ${totalScore.toFixed(2)}.`, { userId: userProfile.userId, totalScore });
    } else {
         logInfo('Total category interest score is 0. Skipping normalization.', { userId: userProfile.userId });
         // 全てのスコアが0の場合、均等に興味があるとするか、全て0のままにするか検討
         // ここでは全て0のままにする
    }


    userProfile.categoryInterestScores = updatedScores;
    userProfile.categoryLastUpdated = updatedLastUpdated; // 最終更新タイムスタンプをプロファイルに保存
    logInfo(`Finished updating category interest scores for user ${userProfile.userId}.`, { userId: userProfile.userId, scores: updatedScores, lastUpdated: updatedLastUpdated });

    return userProfile;
}


// TODO: Implement function to get/generate user interest vector based on profile data
// export async function getUserInterestVector(userId: string, env: Env): Promise<number[] | null> {
//     const profile = await getUserProfile(userId, { 'mail-news-user-profiles': env['mail-news-user-profiles'] });
//     if (!profile) {
//         return null;
//     }
//     // Logic to generate/retrieve interest vector from profile data (e.g., averaging clicked article vectors)
//     return null;
// }
