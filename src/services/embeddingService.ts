import { NewsArticle } from '../newsCollector';
import { uploadOpenAIFile, createOpenAIBatchEmbeddingJob, getOpenAIBatchJobResults, prepareBatchInputFileContent, getOpenAIBatchJobStatus } from '../openaiClient';
import { logError, logInfo, logWarning } from '../logger';
import { chunkArray } from '../utils/textProcessor';
import { CHUNK_SIZE } from '../config';
import { Env } from '../index'; // Env インターフェースをインポート
import { updateArticleEmbeddingInD1 } from './d1Service'; // d1ServiceからupdateArticleEmbeddingInD1をインポート

// NewsArticle型を拡張してembeddingプロパティを持つように定義
interface NewsArticleWithEmbedding extends NewsArticle {
    embedding?: number[];
}

export async function generateAndSaveEmbeddings(articles: NewsArticleWithEmbedding[], env: Env, isDebug: boolean = false): Promise<void> {
    logInfo(`${isDebug ? 'Debug: ' : ''}Starting OpenAI Batch API embedding job creation...`);

    // D1から既存の記事のarticle_idとembeddingの有無を取得
    const { results: existingArticlesInDb } = await env.DB.prepare("SELECT article_id, embedding FROM articles").all();
    const existingArticleIdsWithEmbedding = new Set(
        (existingArticlesInDb as any[])
            .filter(row => row.embedding !== null && row.embedding !== undefined && row.article_id !== null && row.article_id !== undefined)
            .map(row => row.article_id)
    );
    logInfo(`${isDebug ? 'Debug: ' : ''}Found ${existingArticleIdsWithEmbedding.size} articles with existing embeddings in D1 (based on article ID).`, { count: existingArticleIdsWithEmbedding.size });

    // D1からembeddingがNULLの記事を取得
    const { results: articlesMissingEmbeddingInD1 } = await env.DB.prepare("SELECT article_id, title, url, published_at, content FROM articles WHERE embedding IS NULL").all();
    logInfo(`${isDebug ? 'Debug: ' : ''}Found ${articlesMissingEmbeddingInD1.length} articles missing embeddings in D1.`, { count: articlesMissingEmbeddingInD1.length });

    // 新しく収集された記事と、D1から取得した未embedding記事を結合
    // 重複を避けるため、Mapを使用してarticleIdでユニークなリストを作成
    const combinedArticlesMap = new Map<string, NewsArticleWithEmbedding>();
    articles.forEach(article => {
        if (article.articleId) {
            combinedArticlesMap.set(article.articleId, article);
        }
    });
    (articlesMissingEmbeddingInD1 as any[]).forEach(row => {
        if (row.article_id && !combinedArticlesMap.has(row.article_id)) { // 新しい記事にない場合のみ追加
            combinedArticlesMap.set(row.article_id, {
                articleId: row.article_id,
                title: row.title,
                link: row.url,
                publishedAt: row.published_at,
                content: row.content, // D1から取得したcontentを割り当てる
                sourceName: 'D1_missing_embedding', // 識別用にソースを追加 (NewsArticleにsourceNameがあるので)
            });
        }
    });

    let articlesToEmbed = Array.from(combinedArticlesMap.values())
        .filter(article => article.articleId && !existingArticleIdsWithEmbedding.has(article.articleId));

    logInfo(`${isDebug ? 'Debug: ' : ''}Filtered down to ${articlesToEmbed.length} articles that need embedding.`, { articlesToEmbedCount: articlesToEmbed.length, totalCollected: articles.length });

    if (articlesToEmbed.length === 0) {
        logInfo(`${isDebug ? 'Debug: ' : ''}No articles found that need embedding. Skipping batch job creation.`);
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
