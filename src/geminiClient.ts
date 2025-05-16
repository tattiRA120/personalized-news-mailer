// src/geminiClient.ts
import { logError, logWarning } from './logger'; // Import logging helpers

interface EmbeddingResponse {
    embedding: {
        values: number[];
    };
}

interface GenerateContentResponse {
    candidates?: Array<{
        content: {
            parts: Array<{
                text: string;
            }>;
        };
    }>;
}

export async function getEmbedding(text: string, env: { GEMINI_API_KEY?: string }): Promise<number[] | null> {
    if (!env.GEMINI_API_KEY) {
        logError('GEMINI_API_KEY is not set.', null);
        return null;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-exp-03-07:embedContent?key=${env.GEMINI_API_KEY}`; // Use gemini-embedding-exp-03-07

    const maxRetries = 10; // Increased maximum number of retries
    let retries = 0;
    let delay = 2000; // Increased initial delay in milliseconds (2 seconds)

    while (retries < maxRetries) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'gemini-embedding-exp-03-07', // Use gemini-embedding-exp-03-07
                    content: {
                        parts: [{ text: text }],
                    },
                }),
            });

            if (response.ok) {
                const data: EmbeddingResponse = await response.json();
                return data.embedding.values;
            } else if (response.status === 429) {
                // Too Many Requests - retry with exponential backoff
                logWarning(`Rate limit exceeded for embedding. Retrying in ${delay}ms. Retry count: ${retries + 1}`, { status: response.status, statusText: response.statusText, retryCount: retries + 1, delay });
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
                retries++;
            } else {
                // Other non-429 errors
                const errorText = await response.text();
                logError(`Error getting embedding: ${response.statusText}`, null, { status: response.status, statusText: response.statusText, errorText });
                return null;
            }
        } catch (error) {
            // Network errors or other exceptions
            logError('Exception when getting embedding:', error);
            // Decide whether to retry on network errors - for now, just return null
            return null;
        }
    }

    // If max retries reached
    logError(`Max retries reached for getting embedding after ${maxRetries} attempts.`, null, { maxRetries });
    return null;
}

interface BatchEmbeddingResponse {
    embeddings: Array<{ values: number[] }>;
}

export async function getEmbeddingsBatch(texts: string[], env: { GEMINI_API_KEY?: string }): Promise<number[][] | null> {
    if (!env.GEMINI_API_KEY) {
        logError('GEMINI_API_KEY is not set.', null);
        return null;
    }

    if (texts.length === 0) {
        return [];
    }

    // The embedding model and endpoint for batch requests
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-exp-03-07:batchEmbedContents?key=${env.GEMINI_API_KEY}`;

    const maxRetries = 5; // Maximum number of retries
    let retries = 0;
    let delay = 1000; // Initial delay in milliseconds (1 second)

    // Prepare the batch request body
    const requests = texts.map(text => ({
        model: 'models/gemini-embedding-exp-03-07',
        content: {
            parts: [{ text: text }],
        },
    }));

    while (retries < maxRetries) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ requests }), // Use the 'requests' array for batch
            });

            if (response.ok) {
                const data: BatchEmbeddingResponse = await response.json();
                // Extract and return the embeddings
                return data.embeddings.map(e => e.values);
            } else if (response.status === 429) {
                // Too Many Requests - retry with exponential backoff
                logWarning(`Rate limit exceeded for batch embedding. Retrying in ${delay}ms. Retry count: ${retries + 1}`, { status: response.status, statusText: response.statusText, retryCount: retries + 1, delay });
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
                retries++;
            } else {
                // Other non-429 errors
                const errorText = await response.text();
                logError(`Error getting batch embeddings: ${response.statusText}`, null, { status: response.status, statusText: response.statusText, errorText });
                return null;
            }
        } catch (error) {
            // Network errors or other exceptions
            logError('Exception when getting batch embeddings:', error);
            // Decide whether to retry on network errors - for now, just return null
            return null;
        }
    }

    // If max retries reached
    logError(`Max retries reached for getting batch embeddings after ${maxRetries} attempts. Batch size: ${texts.length}`, null, { maxRetries, batchSize: texts.length });
    return null;
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
