// src/openaiClient.ts
import { logError, logWarning, logInfo } from './logger'; // Import logging helpers

interface OpenAIEmbeddingResponse {
    data: Array<{
        embedding: number[];
        index: number;
    }>;
    model: string;
    usage: {
        prompt_tokens: number;
        total_tokens: number;
    };
}

export async function getOpenAIEmbeddingsBatch(texts: string[], env: { OPENAI_API_KEY?: string }): Promise<number[][] | null> {
    if (!env.OPENAI_API_KEY) {
        logError('OPENAI_API_KEY is not set.', null);
        return null;
    }

    if (texts.length === 0) {
        return [];
    }

    const url = `https://api.openai.com/v1/embeddings`;
    const model = "text-embedding-3-small"; // Use the specified OpenAI model

    const maxRetries = 3; // Reduced maximum number of retries for OpenAI
    let retries = 0;
    let delay = 500; // Reduced initial delay in milliseconds (0.5 seconds)

    // OpenAI API accepts an array of strings for the input
    const requestBody = {
        input: texts,
        model: model,
        encoding_format: "float" // Specify float format for embeddings
    };

    while (retries < maxRetries) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
            });

            // Read the response body as text first for logging
            const responseBodyText = await response.text();
            try {
                // Attempt to parse the response body as JSON
                const data: OpenAIEmbeddingResponse = JSON.parse(responseBodyText);

                if (response.ok) {
                    // OpenAI returns embeddings in the 'data' array, sorted by index
                    // We need to ensure they are in the same order as the input texts
                    const embeddings = new Array(texts.length);
                    for (const item of data.data) {
                        embeddings[item.index] = item.embedding;
                    }

                    if (embeddings.length !== texts.length) {
                        logWarning(`OpenAI returned ${embeddings.length} embeddings for a batch of ${texts.length} texts.`, { returnedCount: embeddings.length, expectedCount: texts.length, responseBody: responseBodyText });
                        // Decide how to handle this case - for now, return the partial list
                    } else {
                         logInfo(`Successfully received ${embeddings.length} embeddings from OpenAI.`, { returnedCount: embeddings.length, expectedCount: texts.length });
                    }


                    return embeddings;

                } else if (response.status === 429) {
                    // Too Many Requests - retry with exponential backoff
                    logWarning(`Rate limit exceeded for OpenAI batch embedding. Retrying in ${delay}ms. Retry count: ${retries + 1}`, { status: response.status, statusText: response.statusText, retryCount: retries + 1, delay, responseBody: responseBodyText });
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= 2; // Exponential backoff
                    retries++;
                } else {
                    // Other non-429 errors
                    logError(`Error getting OpenAI batch embeddings: ${response.statusText}`, null, { status: response.status, statusText: response.statusText, responseBody: responseBodyText });
                    return null;
                }
            } catch (jsonError) {
                 // Error parsing JSON
                logError('Error parsing OpenAI batch embeddings response JSON:', jsonError, { status: response.status, statusText: response.statusText, responseBody: responseBodyText });
                return null;
            }
        } catch (error) {
            // Network errors or other exceptions
            logError('Exception when getting OpenAI batch embeddings:', error);
            // Decide whether to retry on network errors - for now, just return null
            return null;
        }
    }

    // If max retries reached
    logError(`Max retries reached for getting OpenAI batch embeddings after ${maxRetries} attempts. Batch size: ${texts.length}`, null, { maxRetries, batchSize: texts.length });
    return null;
}
