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

// Assuming a KV Namespace binding named 'USER_PROFILES'
// Add this binding to your wrangler.toml:
// [[kv_namespaces]]
// binding = "USER_PROFILES"
// id = "<your_kv_namespace_id>"

export async function getUserProfile(userId: string, env: { USER_PROFILES: KVNamespace }): Promise<UserProfile | null> {
    try {
        const profile = await env.USER_PROFILES.get(userId, { type: 'json' });
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

export async function updateUserProfile(profile: UserProfile, env: { USER_PROFILES: KVNamespace }): Promise<void> {
    try {
        await env.USER_PROFILES.put(profile.userId, JSON.stringify(profile));
        logInfo(`Updated user profile for ${profile.userId}.`, { userId: profile.userId });
    } catch (error) {
        logError(`Error updating user profile for ${profile.userId}:`, error, { userId: profile.userId });
    }
}

// Create a new user profile and store email-to-userId mapping
export async function createUserProfile(userId: string, email: string, env: { USER_PROFILES: KVNamespace }): Promise<UserProfile> {
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
        await env.USER_PROFILES.put(userId, JSON.stringify(newUserProfile));
        // Save the email-to-userId mapping
        await env.USER_PROFILES.put(`email_to_userId:${email}`, userId);
        logInfo(`Created new user profile for ${userId} with email ${email}`, { userId, email });
        return newUserProfile;
    } catch (error) {
        logError(`Error creating user profile for ${userId}:`, error, { userId, email });
        throw error; // Re-throw to indicate failure
    }
}

// Get user ID by email address
export async function getUserIdByEmail(email: string, env: { USER_PROFILES: KVNamespace }): Promise<string | null> {
    try {
        const userId = await env.USER_PROFILES.get(`email_to_userId:${email}`);
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
export async function getAllUserIds(env: { USER_PROFILES: KVNamespace }): Promise<string[]> {
    try {
        // List all keys with no prefix to get user IDs directly,
        // or list keys with a specific prefix if user IDs are stored with one.
        // Assuming user IDs are stored as top-level keys for now.
        // Need to filter out email_to_userId keys.
        const listResult = await env.USER_PROFILES.list();
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
//     const profile = await getUserProfile(userId, env);
//     if (!profile) {
//         return null;
//     }
//     // Logic to generate/retrieve interest vector from profile data (e.g., averaging clicked article vectors)
//     return null;
// }
