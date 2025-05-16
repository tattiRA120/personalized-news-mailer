// src/geminiClient.ts
import { logError, logWarning } from './logger'; // Import logging helpers

interface GenerateContentResponse {
    candidates?: Array<{
        content: {
            parts: Array<{
                text: string;
            }>;
        };
    }>;
}

export async function generateContent(prompt: string, env: { GEMINI_API_KEY?: string }): Promise<string | null> {
    if (!env.GEMINI_API_KEY) {
        logError('GEMINI_API_KEY is not set.', null);
        return null;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`; // Use gemini-2.0-flash for v1beta

    const maxRetries = 5; // Maximum number of retries
    let retries = 0;
    let delay = 1000; // Initial delay in milliseconds (1 second)

    while (retries < maxRetries) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: prompt }]
                    }]
                }),
            });

            if (response.ok) {
                const data: GenerateContentResponse = await response.json();
                if (data.candidates && data.candidates.length > 0 && data.candidates[0].content.parts.length > 0) {
                    return data.candidates[0].content.parts[0].text;
                } else {
                    logWarning('No content generated.');
                    return null;
                }
            } else if (response.status === 429) {
                // Too Many Requests - retry with exponential backoff
                logWarning(`Rate limit exceeded for content generation. Retrying in ${delay}ms. Retry count: ${retries + 1}`, { status: response.status, statusText: response.statusText, retryCount: retries + 1, delay });
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
                retries++;
            } else {
                // Other non-429 errors
                const errorText = await response.text();
                logError(`Error generating content: ${response.statusText}`, null, { status: response.status, statusText: response.statusText, errorText });
                return null;
            }
        } catch (error) {
            // Network errors or other exceptions
            logError('Exception when generating content:', error);
            // Decide whether to retry on network errors - for now, just return null
            return null;
        }
    }

    // If max retries reached
    logError(`Max retries reached for generating content after ${maxRetries} attempts.`, null, { maxRetries });
    return null;
}
