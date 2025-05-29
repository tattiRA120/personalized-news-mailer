// src/userProfile.ts

import { logError, logInfo, logWarning } from './logger'; // Import logging helpers

// NewsArticleWithCategory インターフェースの定義
interface NewsArticleWithCategory {
    title: string;
    link: string;
}

// user-profiles KV を含むようにする
interface EnvWithUserProfilesKV {
    'mail-news-user-profiles': KVNamespace;
}


export interface UserProfile {
    userId: string;
    email?: string; // Add email to profile for easier access
    // keywords?: string[]; // 廃止
    interests: string[]; // 教育プログラムで選択された記事ID (リンク)
    clickedArticleIds: string[]; // クリックされた記事ID (リンク)
    sentArticleIds?: string[]; // Track articles sent to the user
    // Add other profile data as needed
    // interestVector?: number[]; // To be generated/updated based on clicked articles
}

// Assuming a KV Namespace binding named 'mail-news-user-profiles' from wrangler.jsonc
// Add this binding to your wrangler.toml:
// [[kv_namespaces]]
// binding = "mail-news-user-profiles"
// id = "<your_kv_namespace_id>"

export async function getUserProfile(userId: string, env: EnvWithUserProfilesKV): Promise<UserProfile | null> {
    try {
        const profile = await env['mail-news-user-profiles'].get(userId, { type: 'json' });
        if (profile) {
            logInfo(`Retrieved user profile for ${userId}.`, { userId });
            const userProfile = profile as UserProfile;
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

export async function updateUserProfile(profile: UserProfile, env: EnvWithUserProfilesKV): Promise<void> {
    try {
        await env['mail-news-user-profiles'].put(profile.userId, JSON.stringify(profile));
        logInfo(`Updated user profile for ${profile.userId}.`, { userId: profile.userId });
    } catch (error) {
        logError(`Error updating user profile for ${profile.userId}:`, error, { userId: profile.userId });
    }
}

export async function createUserProfile(userId: string, email: string, env: EnvWithUserProfilesKV): Promise<UserProfile> {
    const newUserProfile: UserProfile = {
        userId: userId,
        email: email,
        interests: [],
        clickedArticleIds: [],
        sentArticleIds: [],
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
export async function getAllUserIds(env: EnvWithUserProfilesKV): Promise<string[]> {
    try {
        const listResult = await env['mail-news-user-profiles'].list();
        const userIds = listResult.keys
            .map(key => key.name)
            .filter(keyName => !keyName.startsWith('email_to_userId:'));

        logInfo(`Retrieved ${userIds.length} user IDs.`, { userCount: userIds.length });
        return userIds;
    } catch (error) {
        logError('Error getting all user IDs:', error);
        return [];
    }
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
