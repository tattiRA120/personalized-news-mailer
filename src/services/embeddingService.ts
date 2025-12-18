import { NewsArticle } from '../newsCollector';
import { uploadOpenAIFile, createOpenAIBatchEmbeddingJob, getOpenAIBatchJobResults, prepareBatchInputFileContent, getOpenAIBatchJobStatus } from '../openaiClient';
import { Logger } from '../logger';
import { chunkArray } from '../utils/textProcessor';
import { CHUNK_SIZE } from '../config';
import { Env } from '../types/bindings';
import { updateArticleEmbeddingInD1 } from './d1Service'; // d1ServiceからupdateArticleEmbeddingInD1をインポート

// NewsArticle型を拡張してembeddingプロパティを持つように定義
interface NewsArticleWithEmbedding extends NewsArticle {
    embedding?: number[];
}

export async function generateAndSaveEmbeddings(articles: NewsArticleWithEmbedding[], env: Env, userId: string, isDebug: boolean = false): Promise<void> {
    const logger = new Logger(env);
    logger.debug(`${isDebug ? 'Debug: ' : ''}Starting OpenAI Batch API embedding job creation for user ${userId}...`);

    // generateAndSaveEmbeddingsは、引数で渡されたarticlesのみを処理対象とする
    // D1からembeddingがNULLの記事を取得してマージするロジックは削除
    // 呼び出し元でembeddingが必要な記事のみをフィルタリングして渡すことを想定
    let articlesToEmbed = articles;

    logger.debug(`${isDebug ? 'Debug: ' : ''}Received ${articlesToEmbed.length} articles for embedding.`, { articlesToEmbedCount: articlesToEmbed.length });

    if (articlesToEmbed.length === 0) {
        logger.debug(`${isDebug ? 'Debug: ' : ''}No articles found that need embedding. Skipping batch job creation.`);
        return;
    }

    if (isDebug) {
        // デバッグ時はembeddingする記事数を3に制限
        articlesToEmbed = articlesToEmbed.slice(0, 3);
        logger.debug(`Debug: Limiting force embedding to ${articlesToEmbed.length} articles for debugging purposes.`, { limitedCount: articlesToEmbed.length });
    }

    const chunks = chunkArray(articlesToEmbed, CHUNK_SIZE);
    logger.debug(`${isDebug ? 'Debug: ' : ''}Total chunks: ${chunks.length} (each up to ${CHUNK_SIZE} articles)`);

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const jsonl = prepareBatchInputFileContent(chunk);
        const blob = new Blob([jsonl], { type: "application/jsonl" });
        const filename = `articles_chunk${i}_${Date.now()}.jsonl`;

        let uploaded;
        try {
            uploaded = await uploadOpenAIFile(filename, blob, "batch", env);
        } catch (e) {
            logger.error(`${isDebug ? 'Debug: ' : ''}Chunk ${i} upload failed`, e, { chunkIndex: i });
            continue; // 次のチャンクへ
        }
        if (!uploaded || !uploaded.id) {
            logger.error(`${isDebug ? 'Debug: ' : ''}Chunk ${i} upload returned no file ID.`, null, { chunkIndex: i });
            continue;
        }
        logger.debug(`${isDebug ? 'Debug: ' : ''}Chunk ${i} uploaded. File ID:`, { fileId: uploaded.id, chunkIndex: i });

        let job;
        try {
            job = await createOpenAIBatchEmbeddingJob(uploaded.id, env);
            if (!job || !job.id) {
                logger.error(`${isDebug ? 'Debug: ' : ''}Chunk ${i} batch job creation returned no job ID.`, null, { chunkIndex: i });
                continue;
            }
            logger.debug(`${isDebug ? 'Debug: ' : ''}Chunk ${i} batch job created.`, { jobId: job.id, chunkIndex: i });
        } catch (e) {
            logger.error(`${isDebug ? 'Debug: ' : ''}Chunk ${i} batch job creation failed`, e, { chunkIndex: i });
            continue;
        }

        // Durable Object にバッチジョブIDを渡し、ポーリングを委譲
        logger.debug(`${isDebug ? 'Debug: ' : ''}Delegating batch job ${job.id} (Chunk ${i}) to BatchQueueDO for polling.`);
        const batchQueueDOId = env.BATCH_QUEUE_DO.idFromName("batch-embedding-queue");
        const batchQueueDOStub = env.BATCH_QUEUE_DO.get(batchQueueDOId);

        await batchQueueDOStub.fetch(
            new Request(`${env.WORKER_BASE_URL}/start-polling`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ batchId: job.id, inputFileId: uploaded.id, userId: userId }), // userIdを追加
            })
        );
        logger.debug(`${isDebug ? 'Debug: ' : ''}Successfully delegated batch job ${job.id} (Chunk ${i}) to BatchQueueDO for user ${userId}.`);
    }
}
