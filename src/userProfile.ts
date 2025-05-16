// src/userProfile.ts
import { logError, logInfo } from './logger'; // Import logging helpers

export interface UserProfile {
    userId: string;
    email?: string; // Add email to profile for easier access
    keywords: string[];
    clickedArticleIds: string[]; // Using article IDs (e.g., URL hash or unique identifier)
    sentArticleIds?: string[]; // Track articles sent to the user
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
        } else {
            logInfo(`User profile not found for ${userId}.`, { userId });
        }
        return profile as UserProfile | null;
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
        keywords: [], // Initial empty keywords
        clickedArticleIds: [], // Initial empty click history
        sentArticleIds: [], // Initialize sent articles array
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


// TODO: Implement function to get/generate user interest vector based on profile data
// export async function getUserInterestVector(userId: string, env: Env): Promise<number[] | null> {
//     const profile = await getUserProfile(userId, { 'mail-news-user-profiles': env['mail-news-user-profiles'] });
//     if (!profile) {
//         return null;
//     }
//     // Logic to generate/retrieve interest vector from profile data (e.g., averaging clicked article vectors)
//     return null;
// }
