// src/userProfile.ts

import { logError, logInfo, logWarning } from './logger'; // Import logging helpers

// NewsArticleWithCategory インターフェースの定義
interface NewsArticleWithCategory {
    title: string;
    link: string;
}

interface EnvWithUserDB {
    USER_DB: D1Database;
}

export interface UserProfile {
    userId: string;
    email: string;
    interests: string[]; // 教育プログラムで選択された記事ID (リンク)
    embedding?: number[]; // ユーザーの興味を表す埋め込みベクトル
}

export async function getUserProfile(userId: string, env: EnvWithUserDB): Promise<UserProfile | null> {
    try {
        const { results } = await env.USER_DB.prepare(
            `SELECT user_id, email, interests, embedding FROM users WHERE user_id = ?`
        ).bind(userId).all<UserProfile>();

        if (results && results.length > 0) {
            const userProfile = results[0];
            // interestsが文字列として保存されている場合、JSON.parseで配列に戻す
            if (typeof userProfile.interests === 'string') {
                userProfile.interests = JSON.parse(userProfile.interests);
            } else if (!userProfile.interests) {
                // interestsがnullまたはundefinedの場合、空の配列で初期化
                userProfile.interests = [];
            }
            // embeddingが文字列として保存されている場合、JSON.parseで配列に戻す
            if (typeof userProfile.embedding === 'string') {
                userProfile.embedding = JSON.parse(userProfile.embedding);
            }
            logInfo(`Retrieved user profile for ${userId}.`, { userId });
            return userProfile;
        } else {
            logInfo(`User profile not found for ${userId}.`, { userId });
            return null;
        }
    } catch (error) {
        logError(`Error getting user profile for ${userId}:`, error, { userId });
        return null;
    }
}

export async function updateUserProfile(profile: UserProfile, env: EnvWithUserDB): Promise<void> {
    try {
        // interestsとembeddingを文字列として保存
        const interestsString = JSON.stringify(profile.interests);
        const embeddingString = profile.embedding ? JSON.stringify(profile.embedding) : null;
        await env.USER_DB.prepare(
            `UPDATE users SET email = ?, interests = ?, embedding = ? WHERE user_id = ?`
        ).bind(profile.email, interestsString, embeddingString, profile.userId).run();
        logInfo(`Updated user profile for ${profile.userId}.`, { userId: profile.userId });
    } catch (error) {
        logError(`Error updating user profile for ${profile.userId}:`, error, { userId: profile.userId });
    }
}

export async function createUserProfile(userId: string, email: string, env: EnvWithUserDB): Promise<UserProfile> {
    const newUserProfile: UserProfile = {
        userId: userId,
        email: email,
        interests: [],
        embedding: undefined, // 初期は埋め込みなし
    };

    try {
        await env.USER_DB.prepare(
            `INSERT INTO users (user_id, email, embedding) VALUES (?, ?, ?)`
        ).bind(newUserProfile.userId, newUserProfile.email, null).run();
        logInfo(`Created new user profile for ${userId} with email ${email}`, { userId, email });
        return newUserProfile;
    } catch (error) {
        logError(`Error creating user profile for ${userId}:`, error, { userId, email });
        throw error; // Re-throw to indicate failure
    }
}

export async function getUserIdByEmail(email: string, env: EnvWithUserDB): Promise<string | null> {
    try {
        const { results } = await env.USER_DB.prepare(
            `SELECT user_id FROM users WHERE email = ?`
        ).bind(email).all<{ user_id: string }>();

        if (results && results.length > 0) {
            const userId = results[0].user_id;
            logInfo(`Retrieved user ID for email ${email}: ${userId}`, { email, userId });
            return userId;
        } else {
            logInfo(`User ID not found for email ${email}.`, { email });
            return null;
        }
    } catch (error) {
        logError(`Error getting user ID for email ${email}:`, error, { email });
        return null;
    }
}

export async function getAllUserIds(env: EnvWithUserDB): Promise<string[]> {
    try {
        const { results } = await env.USER_DB.prepare(
            `SELECT user_id FROM users`
        ).all<{ user_id: string }>();

        const userIds = results ? results.map(row => row.user_id) : [];
        logInfo(`Retrieved ${userIds.length} user IDs.`, { userCount: userIds.length });
        return userIds;
    } catch (error) {
        logError('Error getting all user IDs:', error);
        return [];
    }
}
