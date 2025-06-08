// src/openaiClient.ts
import { logError, logWarning, logInfo } from './logger'; // Import logging helpers
import { OPENAI_EMBEDDING_MODEL } from './config'; // Import the model name from config
import { NewsArticle } from './newsCollector'; // Import NewsArticle interface

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
export async function createOpenAIBatchEmbeddingJob(inputFileId: string, env: { OPENAI_API_KEY?: string }): Promise<OpenAIBatchJob | null> {
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
            // 必要に応じて他のメタデータをここに保持
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
 * @param articles An array of NewsArticle objects to embed.
 * @returns A string formatted for OpenAI batch input file.
 */
export function prepareBatchInputFileContent(articles: NewsArticle[]): string {
    return articles.map(article => JSON.stringify({
        custom_id: JSON.stringify({
            articleId: article.articleId // custom_id に articleId のみを含める
        }),
        method: "POST",
        url: "/v1/embeddings",
        body: {
            model: OPENAI_EMBEDDING_MODEL,
            input: `${article.title}. ${article.summary || ''}`, // タイトルとサマリーを結合
            encoding_format: "float"
        }
    })).join('\n');
}

// Export the upload function as well, as it will be used by index.ts
export { uploadOpenAIFile };

/**
 * Chunks an array into smaller arrays.
 * @param array The array to chunk.
 * @param size The maximum size of each chunk.
 * @returns An array of chunks.
 */
export function chunkArray<T>(array: T[], size: number): T[][] {
    const chunkedArr: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
        chunkedArr.push(array.slice(i, i + size));
    }
    return chunkedArr;
}
