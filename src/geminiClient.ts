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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=${env.GEMINI_API_KEY}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'embedding-001',
                content: {
                    parts: [{ text: text }],
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            logError(`Error getting embedding: ${response.statusText}`, null, { status: response.status, statusText: response.statusText, errorText });
            return null;
        }

        const data: EmbeddingResponse = await response.json();
        return data.embedding.values;

    } catch (error) {
        logError('Exception when getting embedding:', error);
        return null;
    }
}

export async function generateContent(prompt: string, env: { GEMINI_API_KEY?: string }): Promise<string | null> {
    if (!env.GEMINI_API_KEY) {
        logError('GEMINI_API_KEY is not set.', null);
        return null;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${env.GEMINI_API_KEY}`;

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

        if (!response.ok) {
            const errorText = await response.text();
            logError(`Error generating content: ${response.statusText}`, null, { status: response.status, statusText: response.statusText, errorText });
            return null;
        }

        const data: GenerateContentResponse = await response.json();
        if (data.candidates && data.candidates.length > 0 && data.candidates[0].content.parts.length > 0) {
            return data.candidates[0].content.parts[0].text;
        } else {
            logWarning('No content generated.');
            return null;
        }

    } catch (error) {
        logError('Exception when generating content:', error);
        return null;
    }
}
