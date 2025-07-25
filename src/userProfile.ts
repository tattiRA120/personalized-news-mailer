// src/userProfile.ts

import { initLogger } from './logger';
import { Env } from './index';

export interface UserProfile {
    userId: string;
    email: string;
    embedding?: number[]; // ユーザーの興味を表す埋め込みベクトル
}

export async function getUserProfile(userId: string, env: Env): Promise<UserProfile | null> {
    const { logError, logInfo, logWarning } = initLogger(env);
    try {
        const { results } = await env.DB.prepare(
            `SELECT user_id, email, embedding FROM users WHERE user_id = ?`
        ).bind(userId).all<{ user_id: string; email: string; embedding: string | null; }>();

        if (results && results.length > 0) {
            const rawProfile = results[0];
            const userProfile: UserProfile = {
                userId: rawProfile.user_id, // user_id を userId にマッピング
                email: rawProfile.email,
                embedding: rawProfile.embedding ? JSON.parse(rawProfile.embedding) : undefined,
            };
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

export async function updateUserProfile(profile: UserProfile, env: Env): Promise<void> {
    const { logError, logInfo } = initLogger(env);
    try {
        // embeddingを文字列として保存
        const embeddingString = profile.embedding ? JSON.stringify(profile.embedding) : null;
        await env.DB.prepare(
            `UPDATE users SET email = ?, embedding = ? WHERE user_id = ?`
        ).bind(profile.email, embeddingString, profile.userId).run();
        logInfo(`Updated user profile for ${profile.userId}.`, { userId: profile.userId });
    } catch (error) {
        logError(`Error updating user profile for ${profile.userId}:`, error, { userId: profile.userId });
    }
}

export async function createUserProfile(userId: string, email: string, env: Env): Promise<UserProfile> {
    const { logError, logInfo } = initLogger(env);
    const newUserProfile: UserProfile = {
        userId: userId,
        email: email,
        embedding: undefined, // 初期は埋め込みなし
    };

    try {
        await env.DB.prepare(
            `INSERT INTO users (user_id, email, embedding) VALUES (?, ?, ?)`
        ).bind(newUserProfile.userId, newUserProfile.email, null).run();
        logInfo(`Created new user profile for ${userId} with email ${email}`, { userId, email });
        return newUserProfile;
    } catch (error) {
        logError(`Error creating user profile for ${userId}:`, error, { userId, email });
        throw error; // Re-throw to indicate failure
    }
}

export async function getUserIdByEmail(email: string, env: Env): Promise<string | null> {
    const { logError, logInfo } = initLogger(env);
    try {
        const { results } = await env.DB.prepare(
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

export async function getAllUserIds(env: Env): Promise<string[]> {
    const { logError, logInfo } = initLogger(env);
    try {
        const { results } = await env.DB.prepare(
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
