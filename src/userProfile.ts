// src/userProfile.ts

import { Logger } from './logger';
import { Env } from './types/bindings';
import { getDb } from './db';
import { users } from './db/schema';
import { eq } from 'drizzle-orm';

interface UserProfile {
    userId: string;
    email: string;
    embedding?: number[]; // ユーザーの興味を表す埋め込みベクトル
    mmrLambda?: number; // MMRのlambda設定
}

export async function getUserProfile(userId: string, env: Env): Promise<UserProfile | null> {
    const logger = new Logger(env);
    try {
        const db = getDb(env);
        const results = await db.select({
            user_id: users.user_id,
            email: users.email,
            embedding: users.embedding,
            mmr_lambda: users.mmr_lambda
        })
            .from(users)
            .where(eq(users.user_id, userId))
            .limit(1);

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
        const db = getDb(env);
        await db.update(users)
            .set({
                email: profile.email,
                embedding: embeddingString,
                mmr_lambda: profile.mmrLambda || 0.5
            })
            .where(eq(users.user_id, profile.userId))
            .run();
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
        const db = getDb(env);
        await db.insert(users).values({
            user_id: newUserProfile.userId,
            email: newUserProfile.email,
            embedding: null,
            mmr_lambda: newUserProfile.mmrLambda
        }).run();
        logger.info(`Created new user profile for ${userId} with email ${email}`, { userId, email });
        return newUserProfile;
    } catch (error) {
        logger.error(`Error creating user profile for ${userId}:`, error, { userId, email });
        throw error; // Re-throw to indicate failure
    }
}

export async function getAllUserIds(env: Env): Promise<string[]> {
    const logger = new Logger(env);
    try {
        const db = getDb(env);
        const results = await db.select({
            user_id: users.user_id
        }).from(users);

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
        const db = getDb(env);
        const results = await db.select({
            mmr_lambda: users.mmr_lambda
        })
            .from(users)
            .where(eq(users.user_id, userId))
            .limit(1);

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
