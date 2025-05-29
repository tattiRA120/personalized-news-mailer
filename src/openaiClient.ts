// src/openaiClient.ts
import { logError, logWarning, logInfo } from './logger'; // Import logging helpers
import { OPENAI_EMBEDDING_MODEL } from './config'; // Import the model name from config

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

interface OpenAIBatchJob {
    id: string;
    object: string;
    endpoint: string;
    errors: any | null;
    created_at: number;
    completed_at: number | null;
    cancelled_at: number | null;
    request_counts: {
        total: number;
        completed: number;
        failed: number;
    };
    status: 'validating' | 'pending' | 'running' | 'completing' | 'completed' | 'failed' | 'cancelled';
    output_file_id: string | null;
    error_file_id: string | null;
    input_file_id: string;
    completion_window: string;
}

interface OpenAIFile {
    id: string;
    object: string;
    bytes: number;
    created_at: number;
    filename: string;
    purpose: string;
    status: string;
    status_details: any | null;
}

/**
 * Uploads a file to OpenAI for batch processing.
 * @param filename The name of the file to upload.
 * @param content The content of the file as a Blob.
 * @param purpose The purpose of the file (e.g., "batch").
 * @param env Environment variables containing OPENAI_API_KEY.
 * @returns The uploaded file object or null on failure.
 */
async function uploadOpenAIFile(filename: string, content: Blob, purpose: string, env: { OPENAI_API_KEY?: string }): Promise<OpenAIFile | null> {
    if (!env.OPENAI_API_KEY) {
        logError('OPENAI_API_KEY is not set for file upload.', null);
        return null;
    }

    const url = `https://api.openai.com/v1/files`;
    const formData = new FormData();
    formData.append('file', content, filename);
    formData.append('purpose', purpose);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            },
            body: formData,
        });

        const data: OpenAIFile = await response.json(); // Explicitly cast to OpenAIFile
        if (response.ok) {
            logInfo(`Successfully uploaded file ${filename} to OpenAI. File ID: ${data.id}`, { fileId: data.id, filename });
            return data;
        } else {
            logError(`Error uploading file to OpenAI: ${response.statusText}`, null, { status: response.status, statusText: response.statusText, responseBody: data });
            return null;
        }
    } catch (error) {
        logError('Exception when uploading file to OpenAI:', error);
        return null;
    }
}

/**
 * Creates an OpenAI batch embedding job.
 * @param inputFileId The ID of the uploaded input file.
 * @param callbackUrl The URL where OpenAI should send the callback when the job is complete.
 * @param env Environment variables containing OPENAI_API_KEY.
 * @returns The created batch job object or null on failure.
 */
export async function createOpenAIBatchEmbeddingJob(inputFileId: string, callbackUrl: string, env: { OPENAI_API_KEY?: string }): Promise<OpenAIBatchJob | null> {
    if (!env.OPENAI_API_KEY) {
        logError('OPENAI_API_KEY is not set for batch job creation.', null);
        return null;
    }

    const url = `https://api.openai.com/v1/batches`;
    const requestBody = {
        input_file_id: inputFileId,
        endpoint: "/v1/embeddings",
        completion_window: "24h", // Or "48h"
        metadata: {
            callback_url: callbackUrl,
        },
        // For embeddings, the model is specified in the input file for each request
        // but we can also specify a default model here if needed.
        // model: OPENAI_EMBEDDING_MODEL, // This might not be needed for embeddings batch endpoint
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
        });

        const data: OpenAIBatchJob = await response.json(); // Explicitly cast to OpenAIBatchJob
        if (response.ok) {
            logInfo(`Successfully created OpenAI batch embedding job. Job ID: ${data.id}`, { jobId: data.id, inputFileId });
            return data;
        } else {
            logError(`Error creating OpenAI batch embedding job: ${response.statusText}`, null, { status: response.status, statusText: response.statusText, responseBody: data });
            return null;
        }
    } catch (error) {
        logError('Exception when creating OpenAI batch embedding job:', error);
        return null;
    }
}

/**
 * Retrieves the status of an OpenAI batch job.
 * @param jobId The ID of the batch job.
 * @param env Environment variables containing OPENAI_API_KEY.
 * @returns The batch job object or null on failure.
 */
export async function getOpenAIBatchJobStatus(jobId: string, env: { OPENAI_API_KEY?: string }): Promise<OpenAIBatchJob | null> {
    if (!env.OPENAI_API_KEY) {
        logError('OPENAI_API_KEY is not set for batch job status retrieval.', null);
        return null;
    }

    const url = `https://api.openai.com/v1/batches/${jobId}`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            },
        });

        const data: OpenAIBatchJob = await response.json(); // Explicitly cast to OpenAIBatchJob
        if (response.ok) {
            logInfo(`Successfully retrieved OpenAI batch job status for Job ID: ${jobId}. Status: ${data.status}`, { jobId, status: data.status });
            return data;
        } else {
            logError(`Error getting OpenAI batch job status: ${response.statusText}`, null, { status: response.status, statusText: response.statusText, responseBody: data });
            return null;
        }
    } catch (error) {
        logError('Exception when getting OpenAI batch job status:', error);
        return null;
    }
}

/**
 * Retrieves the results of a completed OpenAI batch job.
 * @param output_file_id The ID of the output file from the completed batch job.
 * @param env Environment variables containing OPENAI_API_KEY.
 * @returns The results as a string or null on failure.
 */
export async function getOpenAIBatchJobResults(output_file_id: string, env: { OPENAI_API_KEY?: string }): Promise<string | null> {
    if (!env.OPENAI_API_KEY) {
        logError('OPENAI_API_KEY is not set for batch job results retrieval.', null);
        return null;
    }

    const url = `https://api.openai.com/v1/files/${output_file_id}/content`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            },
        });

        if (response.ok) {
            const content = await response.text();
            logInfo(`Successfully retrieved OpenAI batch job results from file ID: ${output_file_id}.`, { output_file_id });
            return content;
        } else {
            logError(`Error getting OpenAI batch job results: ${response.statusText}`, null, { status: response.status, statusText: response.statusText });
            return null;
        }
    } catch (error) {
        logError('Exception when getting OpenAI batch job results:', error);
        return null;
    }
}

/**
 * Prepares the input file content for OpenAI Batch API.
 * Each line in the file should be a JSON object with "custom_id" and "method" and "url" and "body".
 * For embeddings, the body contains the model and input text.
 * @param texts An array of texts to embed.
 * @returns A string formatted for OpenAI batch input file.
 */
export function prepareBatchInputFileContent(texts: { id: string, text: string }[]): string {
    return texts.map(item => JSON.stringify({
        custom_id: item.id,
        method: "POST",
        url: "/v1/embeddings",
        body: {
            model: OPENAI_EMBEDDING_MODEL,
            input: item.text,
            encoding_format: "float"
        }
    })).join('\n');
}

// Keep the existing getOpenAIEmbeddingsBatch for direct calls if needed,
// or remove it if all embedding generation will go through the Batch API.
// For now, we'll keep it but rename it to avoid confusion with the new batch job flow.
// It's also good to have a synchronous option for smaller requests or testing.
export async function getOpenAIEmbeddingsDirect(texts: string[], env: { OPENAI_API_KEY?: string }): Promise<number[][] | null> {
    if (!env.OPENAI_API_KEY) {
        logError('OPENAI_API_KEY is not set.', null);
        return null;
    }

    if (texts.length === 0) {
        return [];
    }

    const url = `https://api.openai.com/v1/embeddings`;
    const model = OPENAI_EMBEDDING_MODEL; // Use the specified OpenAI model from config

    const maxRetries = 3; // Reduced maximum number of retries for OpenAI
    let retries = 0;
    let delay = 500; // Reduced initial delay in milliseconds (0.5 seconds)

    const requestBody = {
        input: texts,
        model: model,
        encoding_format: "float"
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

            const responseBodyText = await response.text();
            try {
                const data: OpenAIEmbeddingResponse = JSON.parse(responseBodyText);

                if (response.ok) {
                    const embeddings = new Array(texts.length);
                    for (const item of data.data) {
                        embeddings[item.index] = item.embedding;
                    }

                    if (embeddings.length !== texts.length) {
                        logWarning(`OpenAI returned ${embeddings.length} embeddings for a batch of ${texts.length} texts.`, { returnedCount: embeddings.length, expectedCount: texts.length, responseBody: responseBodyText });
                    } else {
                         logInfo(`Successfully received ${embeddings.length} embeddings from OpenAI.`, { returnedCount: embeddings.length, expectedCount: texts.length });
                    }
                    return embeddings;

                } else if (response.status === 429) {
                    logWarning(`Rate limit exceeded for OpenAI direct embedding. Retrying in ${delay}ms. Retry count: ${retries + 1}`, { status: response.status, statusText: response.statusText, retryCount: retries + 1, delay, responseBody: responseBodyText });
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= 2;
                    retries++;
                } else {
                    logError(`Error getting OpenAI direct embeddings: ${response.statusText}`, null, { status: response.status, statusText: response.statusText, responseBody: responseBodyText });
                    return null;
                }
            } catch (jsonError) {
                logError('Error parsing OpenAI direct embeddings response JSON:', jsonError, { status: response.status, statusText: response.statusText, responseBody: responseBodyText });
                return null;
            }
        } catch (error) {
            logError('Exception when getting OpenAI direct embeddings:', error);
            return null;
        }
    }

    logError(`Max retries reached for getting OpenAI direct embeddings after ${maxRetries} attempts. Batch size: ${texts.length}`, null, { maxRetries, batchSize: texts.length });
    return null;
}

// Export the upload function as well, as it will be used by index.ts
export { uploadOpenAIFile };
