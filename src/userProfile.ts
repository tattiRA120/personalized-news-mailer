// src/userProfile.ts

import { Logger } from './logger';
import { Env } from './types/bindings';

export interface UserProfile {
    userId: string;
    email: string;
    embedding?: number[]; // ユーザーの興味を表す埋め込みベクトル
    mmrLambda?: number; // MMRのlambda設定
}

export async function getUserProfile(userId: string, env: Env): Promise<UserProfile | null> {
    const logger = new Logger(env);
    try {
        const { results } = await env.DB.prepare(
            `SELECT user_id, email, embedding, mmr_lambda FROM users WHERE user_id = ?`
        ).bind(userId).all<{ user_id: string; email: string; embedding: string | null; mmr_lambda: number | null; }>();

        if (results && results.length > 0) {
            const rawProfile = results[0];
            const userProfile: UserProfile = {
                userId: rawProfile.user_id, // user_id を userId にマッピング
                email: rawProfile.email,
                embedding: rawProfile.embedding ? JSON.parse(rawProfile.embedding) : undefined,
                mmrLambda: rawProfile.mmr_lambda ?? 0.5, // nullの場合はデフォルト値0.5
            };
            logger.info(`Retrieved user profile for ${userId}.`, { userId });
            return userProfile;
        } else {
            logger.info(`User profile not found for ${userId}.`, { userId });
            return null;
        }
    } catch (error) {
        logger.error(`Error getting user profile for ${userId}:`, error, { userId });
        return null;
    }
}

export async function updateUserProfile(profile: UserProfile, env: Env): Promise<void> {
    const logger = new Logger(env);
    try {
        // embeddingを文字列として保存
        const embeddingString = profile.embedding ? JSON.stringify(profile.embedding) : null;
        await env.DB.prepare(
            `UPDATE users SET email = ?, embedding = ?, mmr_lambda = ? WHERE user_id = ?`
        ).bind(profile.email, embeddingString, profile.mmrLambda || 0.5, profile.userId).run();
        logger.info(`Updated user profile for ${profile.userId}.`, { userId: profile.userId });
    } catch (error) {
        logger.error(`Error updating user profile for ${profile.userId}:`, error, { userId: profile.userId });
    }
}

export async function createUserProfile(userId: string, email: string, env: Env): Promise<UserProfile> {
    const logger = new Logger(env);
    const newUserProfile: UserProfile = {
        userId: userId,
        email: email,
        embedding: undefined, // 初期は埋め込みなし
        mmrLambda: 0.5, // 初期値は0.5
    };

    try {
        await env.DB.prepare(
            `INSERT INTO users (user_id, email, embedding, mmr_lambda) VALUES (?, ?, ?, ?)`
        ).bind(newUserProfile.userId, newUserProfile.email, null, newUserProfile.mmrLambda).run();
        logger.info(`Created new user profile for ${userId} with email ${email}`, { userId, email });
        return newUserProfile;
    } catch (error) {
        logger.error(`Error creating user profile for ${userId}:`, error, { userId, email });
        throw error; // Re-throw to indicate failure
    }
}

export async function getUserIdByEmail(email: string, env: Env): Promise<string | null> {
    const logger = new Logger(env);
    try {
        const { results } = await env.DB.prepare(
            `SELECT user_id FROM users WHERE email = ?`
        ).bind(email).all<{ user_id: string }>();

        if (results && results.length > 0) {
            const userId = results[0].user_id;
            logger.info(`Retrieved user ID for email ${email}: ${userId}`, { email, userId });
            return userId;
        } else {
            logger.info(`User ID not found for email ${email}.`, { email });
            return null;
        }
    } catch (error) {
        logger.error(`Error getting user ID for email ${email}:`, error, { email });
        return null;
    }
}

export async function getAllUserIds(env: Env): Promise<string[]> {
    const logger = new Logger(env);
    try {
        const { results } = await env.DB.prepare(
            `SELECT user_id FROM users`
        ).all<{ user_id: string }>();

        const userIds = results ? results.map(row => row.user_id) : [];
        logger.info(`Retrieved ${userIds.length} user IDs.`, { userCount: userIds.length });
        return userIds;
    } catch (error) {
        logger.error('Error getting all user IDs:', error);
        return [];
    }
}

/**
 * ユーザーのMMR lambda設定を取得します。
 * @param userId ユーザーID
 * @param env 環境変数
 * @returns MMR lambda値（デフォルト0.5）
 */
export async function getMMRLambda(userId: string, env: Env): Promise<number> {
    const logger = new Logger(env);
    try {
        const { results } = await env.DB.prepare(
            `SELECT mmr_lambda FROM users WHERE user_id = ?`
        ).bind(userId).all<{ mmr_lambda: number | null }>();

        if (results && results.length > 0) {
            const lambda = results[0].mmr_lambda ?? 0.5;
            logger.debug(`Retrieved MMR lambda for ${userId}: ${lambda}`, { userId, lambda });
            return lambda;
        } else {
            logger.debug(`User profile not found for ${userId}. Returning default lambda 0.5.`, { userId });
            return 0.5;
        }
    } catch (error) {
        logger.error(`Error getting MMR lambda for ${userId}:`, error, { userId });
        return 0.5; // エラー時はデフォルト値
    }
}

/**
 * ユーザーのMMR lambda設定を更新します。
 * @param userId ユーザーID
 * @param lambda 新しいlambda値
 * @param env 環境変数
 * @returns 更新が成功したかどうか
 */
export async function updateMMRLambda(userId: string, lambda: number, env: Env): Promise<boolean> {
    const logger = new Logger(env);
    try {
        const clampedLambda = Math.max(0, Math.min(1, lambda)); // 0-1の範囲に制限
        const { success, error } = await env.DB.prepare(
            `UPDATE users SET mmr_lambda = ? WHERE user_id = ?`
        ).bind(clampedLambda, userId).run();

        if (success) {
            logger.info(`Updated MMR lambda for ${userId}: ${clampedLambda}`, { userId, lambda: clampedLambda });
            return true;
        } else {
            logger.error(`Failed to update MMR lambda for ${userId}: ${error}`, null, { userId, lambda: clampedLambda, error });
            return false;
        }
    } catch (error) {
        logger.error(`Error updating MMR lambda for ${userId}:`, error, { userId, lambda });
        return false;
    }
}
