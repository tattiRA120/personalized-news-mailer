import { NewsArticle } from '../newsCollector';
import { uploadOpenAIFile, createOpenAIBatchEmbeddingJob, getOpenAIBatchJobResults, prepareBatchInputFileContent, getOpenAIBatchJobStatus } from '../openaiClient';
import { logError, logInfo, logWarning } from '../logger';
import { chunkArray } from '../utils/textProcessor';
import { CHUNK_SIZE } from '../config';
import { Env } from '../index'; // Env インターフェースをインポート

async function saveArticlesToD1(
  records: {
    articleId: string;
    title: string;
    url: string;
    publishedAt: number;
    content: string;
    embedding: number[] | undefined;
  }[],
  env: Env
): Promise<void> {
  const CHUNK_SIZE_SQL_VARIABLES = 50;
  const recordChunks = chunkArray(records, CHUNK_SIZE_SQL_VARIABLES);

  for (const chunk of recordChunks) {
    const query = `
      INSERT OR IGNORE INTO articles (article_id, title, url, published_at, content, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    logInfo(`Executing D1 batch INSERT query for ${chunk.length} records.`, { query, recordCount: chunk.length });
    const stmt = env.DB.prepare(query);
    const batch = chunk.map((rec) => {
      return stmt.bind(
        rec.articleId,
        rec.title,
        rec.url,
        rec.publishedAt,
        rec.content,
        rec.embedding !== undefined ? JSON.stringify(rec.embedding) : null
      );
    });
    await env.DB.batch(batch);
  }
}

async function updateArticleEmbeddingsInD1(
  records: {
    articleId: string;
    embedding: number[];
  }[],
  env: Env
): Promise<void> {
  const CHUNK_SIZE_SQL_VARIABLES = 50;
  const recordChunks = chunkArray(records, CHUNK_SIZE_SQL_VARIABLES);

  for (const chunk of recordChunks) {
    const query = `
      UPDATE articles
      SET embedding = ?
      WHERE article_id = ?
    `;
    logInfo(`Executing D1 batch UPDATE query for ${chunk.length} records.`, { query, recordCount: chunk.length });
    const stmt = env.DB.prepare(query);
    const batch = chunk.map((rec) => {
      return stmt.bind(
        JSON.stringify(rec.embedding),
        rec.articleId
      );
    });
    await env.DB.batch(batch);
  }
}

export async function generateAndSaveEmbeddings(articles: NewsArticle[], env: Env, isDebug: boolean = false): Promise<void> {
    logInfo(`${isDebug ? 'Debug: ' : ''}Starting OpenAI Batch API embedding job creation...`);

    // D1から既存の記事のarticle_idとembeddingの有無を取得
    const { results: existingArticlesInDb } = await env.DB.prepare("SELECT article_id, embedding FROM articles").all();
    const existingArticleIdsWithEmbedding = new Set(
        (existingArticlesInDb as any[])
            .filter(row => row.embedding !== null && row.embedding !== undefined && row.article_id !== null && row.article_id !== undefined)
            .map(row => row.article_id)
    );
    logInfo(`${isDebug ? 'Debug: ' : ''}Found ${existingArticleIdsWithEmbedding.size} articles with existing embeddings in D1 (based on article ID).`, { count: existingArticleIdsWithEmbedding.size });

    // 収集した記事から、既にembeddingが存在する記事を除外 (articleIdで判断)
    let articlesToEmbed = articles.filter(article => article.articleId && !existingArticleIdsWithEmbedding.has(article.articleId));
    logInfo(`${isDebug ? 'Debug: ' : ''}Filtered down to ${articlesToEmbed.length} articles that need embedding.`, { articlesToEmbedCount: articlesToEmbed.length, totalCollected: articles.length });

    if (articlesToEmbed.length === 0) {
        logInfo(`${isDebug ? 'Debug: ' : ''}No new articles found that need embedding. Skipping batch job creation.`);
        return;
    }

    if (isDebug) {
        // デバッグ時はembeddingする記事数を3に制限
        articlesToEmbed = articlesToEmbed.slice(0, 3);
        logInfo(`Debug: Limiting force embedding to ${articlesToEmbed.length} articles for debugging purposes.`, { limitedCount: articlesToEmbed.length });
    }

    const chunks = chunkArray(articlesToEmbed, CHUNK_SIZE);
    logInfo(`${isDebug ? 'Debug: ' : ''}Total chunks: ${chunks.length} (each up to ${CHUNK_SIZE} articles)`);

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const jsonl = prepareBatchInputFileContent(chunk);
        const blob = new Blob([jsonl], { type: "application/jsonl" });
        const filename = `articles_chunk${i}_${Date.now()}.jsonl`;

        let uploaded;
        try {
            uploaded = await uploadOpenAIFile(filename, blob, "batch", env);
        } catch (e) {
            logError(`${isDebug ? 'Debug: ' : ''}Chunk ${i} upload failed`, e, { chunkIndex: i });
            continue; // 次のチャンクへ
        }
        if (!uploaded || !uploaded.id) {
            logError(`${isDebug ? 'Debug: ' : ''}Chunk ${i} upload returned no file ID.`, null, { chunkIndex: i });
            continue;
        }
        logInfo(`${isDebug ? 'Debug: ' : ''}Chunk ${i} uploaded. File ID:`, { fileId: uploaded.id, chunkIndex: i });

        let job;
        try {
            job = await createOpenAIBatchEmbeddingJob(uploaded.id, env);
            if (!job || !job.id) {
                logError(`${isDebug ? 'Debug: ' : ''}Chunk ${i} batch job creation returned no job ID.`, null, { chunkIndex: i });
                continue;
            }
            logInfo(`${isDebug ? 'Debug: ' : ''}Chunk ${i} batch job created.`, { jobId: job.id, chunkIndex: i });
        } catch (e) {
            logError(`${isDebug ? 'Debug: ' : ''}Chunk ${i} batch job creation failed`, e, { chunkIndex: i });
            continue;
        }

        // Durable Object にバッチジョブIDを渡し、ポーリングを委譲
        logInfo(`${isDebug ? 'Debug: ' : ''}Delegating batch job ${job.id} (Chunk ${i}) to BatchQueueDO for polling.`);
        const batchQueueDOId = env.BATCH_QUEUE_DO.idFromName("batch-embedding-queue");
        const batchQueueDOStub = env.BATCH_QUEUE_DO.get(batchQueueDOId);

        await batchQueueDOStub.fetch(
            new Request(`${env.WORKER_BASE_URL}/start-polling`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ batchId: job.id, inputFileId: uploaded.id }),
            })
        );
        logInfo(`${isDebug ? 'Debug: ' : ''}Successfully delegated batch job ${job.id} (Chunk ${i}) to BatchQueueDO.`);
    }
}

export { saveArticlesToD1, updateArticleEmbeddingsInD1 };
