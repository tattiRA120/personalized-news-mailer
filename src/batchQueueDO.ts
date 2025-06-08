import { logError, logInfo, logWarning } from "./logger";
import { uploadOpenAIFile, createOpenAIBatchEmbeddingJob, prepareBatchInputFileContent, getOpenAIBatchJobStatus, getOpenAIBatchJobResults } from "./openaiClient";
import { NewsArticle } from "./newsCollector";
import { Env } from "./index"; // Envインターフェースをインポート
import { DurableObject } from 'cloudflare:workers'; // DurableObject をインポート

interface BatchChunk {
  chunkIndex: number;
  articles: NewsArticle[];
  retryCount?: number; // リトライ回数を追跡
}

interface BatchJobInfo {
  batchId: string;
  inputFileId: string;
  status: string;
  retryCount: number;
}

interface BatchResultItem {
    custom_id: string; // JSON.stringify({ articleId: article.articleId }) された文字列
    embedding: number[];
    // 他のプロパティも存在する可能性あり
}

export class BatchQueueDO extends DurableObject { // DurableObject を継承
  state: DurableObjectState;
  env: Env;
  private processingPromise: Promise<void> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env); // 親クラスのコンストラクタを呼び出す
    this.state = state;
    this.env = env;
    this.state.blockConcurrencyWhile(async () => {
      // DOが初期化される際に、未処理のチャンクがあれば処理を開始
      const storedChunks = await this.state.storage.get<BatchChunk[]>("chunks") || [];
      const storedBatchJobs = await this.state.storage.get<BatchJobInfo[]>("batchJobs") || [];

      if (storedChunks.length > 0) {
        logInfo("BatchQueueDO initialized with pending chunks. Resuming chunk processing.");
        this.processQueue();
      }
      if (storedBatchJobs.length > 0) {
        logInfo("BatchQueueDO initialized with pending batch jobs. Resuming polling.");
        // アラームが設定されていない場合は設定
        if (!await this.state.storage.getAlarm()) {
          await this.state.storage.setAlarm(Date.now() + 60 * 1000); // 1分後にアラームを設定
        }
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/queue-chunks" && request.method === "POST") {
      try {
        const { chunks } = await request.json<{ chunks: BatchChunk[] }>();
        if (!chunks || chunks.length === 0) {
          return new Response("No chunks provided", { status: 400 });
        }

        let currentChunks = await this.state.storage.get<BatchChunk[]>("chunks") || [];
        currentChunks = currentChunks.concat(chunks);
        await this.state.storage.put("chunks", currentChunks);
        logInfo(`Added ${chunks.length} chunks to queue. Total: ${currentChunks.length}`);

        // 処理が実行中でない場合のみ開始
        if (!this.processingPromise) {
          this.processingPromise = this.processQueue();
        }

        return new Response("Chunks queued successfully", { status: 200 });
      } catch (error) {
        logError("Failed to queue chunks in BatchQueueDO", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    } else if (path === "/start-polling" && request.method === "POST") {
      try {
        const { batchId, inputFileId } = await request.json<{ batchId: string; inputFileId: string }>();
        if (!batchId || !inputFileId) {
          return new Response("Missing batchId or inputFileId", { status: 400 });
        }

        let batchJobs = await this.state.storage.get<BatchJobInfo[]>("batchJobs") || [];
        batchJobs.push({ batchId, inputFileId, status: "pending", retryCount: 0 });
        await this.state.storage.put("batchJobs", batchJobs);
        logInfo(`Added batch job ${batchId} to polling queue.`);

        // アラームが設定されていない場合のみ設定
        if (!await this.state.storage.getAlarm()) {
          await this.state.storage.setAlarm(Date.now() + 60 * 1000); // 1分後にアラームを設定
          logInfo("Set initial alarm for batch job polling.");
        }

        return new Response("Polling started for batch job", { status: 200 });
      } catch (error) {
        logError("Failed to start polling in BatchQueueDO", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    logInfo("BatchQueueDO: Alarm triggered. Checking batch job statuses.");
    let batchJobs = await this.state.storage.get<BatchJobInfo[]>("batchJobs") || [];
    const completedJobs: BatchJobInfo[] = [];
    const failedJobs: BatchJobInfo[] = [];
    const pendingJobs: BatchJobInfo[] = [];

    for (const jobInfo of batchJobs) {
      try {
        const statusResponse = await getOpenAIBatchJobStatus(jobInfo.batchId, this.env);
        
        if (!statusResponse) {
            logWarning(`Batch job ${jobInfo.batchId} status response was null. Retrying.`, { jobId: jobInfo.batchId });
            jobInfo.retryCount = (jobInfo.retryCount || 0) + 1;
            const MAX_POLLING_RETRIES = 5;
            if (jobInfo.retryCount <= MAX_POLLING_RETRIES) {
                pendingJobs.push(jobInfo);
            } else {
                logError(`Max polling retries exceeded for batch job ${jobInfo.batchId} due to null response. Skipping.`, new Error('Null status response'), { jobId: jobInfo.batchId });
                failedJobs.push(jobInfo);
            }
            continue;
        }

        jobInfo.status = statusResponse.status; // ステータスを更新

        logInfo(`Batch job ${jobInfo.batchId} status: ${jobInfo.status}`);

        if (jobInfo.status === "completed") {
          logInfo(`Batch job ${jobInfo.batchId} completed. Fetching results.`);
          const resultsContent = await getOpenAIBatchJobResults(statusResponse.output_file_id!, this.env); // output_file_id は completed 時には存在するはず
          
          if (resultsContent) {
            const results: BatchResultItem[] = resultsContent.split('\n')
                .filter(line => line.trim() !== '')
                .map(line => JSON.parse(line));

            if (results && results.length > 0) {
                const embeddingsToUpdate = results.map(r => ({
                    articleId: JSON.parse(r.custom_id).articleId, // custom_id をパースして articleId を取得
                    embedding: r.embedding
                }));
                await this.updateArticleEmbeddingsInD1(embeddingsToUpdate, this.env);
                logInfo(`Updated D1 with embeddings for batch job ${jobInfo.batchId}.`);
            } else {
                logWarning(`Batch job ${jobInfo.batchId} completed but no results found after parsing.`, { jobId: jobInfo.batchId });
            }
          } else {
            logWarning(`Batch job ${jobInfo.batchId} completed but no results content received.`, { jobId: jobInfo.batchId });
          }
          completedJobs.push(jobInfo);
        } else if (jobInfo.status === "failed" || jobInfo.status === "cancelled") {
          logError(`Batch job ${jobInfo.batchId} failed or cancelled.`, new Error(`Batch job ${jobInfo.batchId} status: ${jobInfo.status}`), { jobId: jobInfo.batchId, status: jobInfo.status });
          failedJobs.push(jobInfo);
        } else {
          // pending, in_progress, finalizing など
          pendingJobs.push(jobInfo);
        }
      } catch (error) {
        jobInfo.retryCount = (jobInfo.retryCount || 0) + 1;
        const MAX_POLLING_RETRIES = 5; // ポーリングのリトライ回数
        if (jobInfo.retryCount <= MAX_POLLING_RETRIES) {
          logWarning(`Error checking status for batch job ${jobInfo.batchId}. Retrying (${jobInfo.retryCount}/${MAX_POLLING_RETRIES}).`, { error: error, jobId: jobInfo.batchId });
          pendingJobs.push(jobInfo); // リトライのためにキューに戻す
        } else {
          logError(`Max polling retries exceeded for batch job ${jobInfo.batchId}. Skipping.`, error, { jobId: jobInfo.batchId });
          failedJobs.push(jobInfo); // 失敗として扱う
        }
      }
    }

    // 完了または失敗したジョブをストレージから削除し、保留中のジョブを保存
    await this.state.storage.put("batchJobs", pendingJobs);

    if (pendingJobs.length > 0) {
      // 未処理のジョブが残っている場合、次のアラームを設定
      await this.state.storage.setAlarm(Date.now() + 60 * 1000); // 1分後に再度アラームを設定
      logInfo(`Set next alarm for batch job polling. Remaining jobs: ${pendingJobs.length}`);
    } else {
      logInfo("All batch jobs processed. No more alarms scheduled for polling.");
    }
  }

  private async processQueue(): Promise<void> {
    try {
      while (true) {
        let chunks = await this.state.storage.get<BatchChunk[]>("chunks") || [];
        if (chunks.length === 0) {
          logInfo("BatchQueueDO: No more chunks to process. Stopping chunk processing.");
          this.processingPromise = null; // 処理完了
          break;
        }

        const chunkToProcess = chunks.shift(); // キューから最初のチャンクを取得
        if (chunkToProcess) {
          logInfo(`BatchQueueDO: Processing chunk ${chunkToProcess.chunkIndex}`);
          await this.processSingleChunk(chunkToProcess);

          // 処理したチャンクをストレージから削除し、残りを保存
          await this.state.storage.put("chunks", chunks);
          logInfo(`BatchQueueDO: Chunk ${chunkToProcess.chunkIndex} processed. Remaining: ${chunks.length}`);
        }

        // 次のチャンクを処理する前に短い遅延を挟む (レートリミット回避)
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1秒待機
      }
    } catch (error) {
      logError("BatchQueueDO: Error during chunk queue processing", error);
      this.processingPromise = null; // エラー発生時も処理を停止
    }
  }

  private async processSingleChunk(chunk: BatchChunk): Promise<void> {
    const jsonl = prepareBatchInputFileContent(chunk.articles);
    const blob = new Blob([jsonl], { type: "application/jsonl" });
    const filename = `articles_chunk${chunk.chunkIndex}_${Date.now()}.jsonl`;
    const MAX_RETRIES = 3; // 最大リトライ回数

    try {
      logInfo(`Attempting to upload chunk ${chunk.chunkIndex} file: ${filename} (Retry: ${chunk.retryCount || 0})`);
      const uploaded = await uploadOpenAIFile(filename, blob, "batch", this.env);
      if (!uploaded || !uploaded.id) {
        logError(`Chunk ${chunk.chunkIndex} upload returned no file ID.`, new Error('No file ID returned'), { chunkIndex: chunk.chunkIndex, retryCount: chunk.retryCount || 0 });
        // リトライ処理
        await this.handleChunkError(chunk, `Upload failed: No file ID`, MAX_RETRIES);
        return;
      }
      logInfo(`Chunk ${chunk.chunkIndex} uploaded. File ID: ${uploaded.id}`);

      logInfo(`Attempting to create batch job for chunk ${chunk.chunkIndex} with file ID: ${uploaded.id}`);
      const job = await createOpenAIBatchEmbeddingJob(
        uploaded.id,
        this.env
      );
      if (!job || !job.id) {
        logError(`Chunk ${chunk.chunkIndex} batch job creation returned no job ID.`, new Error('No job ID returned'), { chunkIndex: chunk.chunkIndex, retryCount: chunk.retryCount || 0 });
        // リトライ処理
        await this.handleChunkError(chunk, `Batch job creation failed: No job ID`, MAX_RETRIES);
        return;
      }
      logInfo(`Chunk ${chunk.chunkIndex} batch job created. Job ID: ${job.id}`);

      // バッチジョブが作成されたら、ポーリングキューに追加
      let batchJobs = await this.state.storage.get<BatchJobInfo[]>("batchJobs") || [];
      batchJobs.push({ batchId: job.id, inputFileId: uploaded.id, status: "pending", retryCount: 0 });
      await this.state.storage.put("batchJobs", batchJobs);
      logInfo(`Delegated batch job ${job.id} to polling queue from chunk processing.`);

      // アラームが設定されていない場合のみ設定
      if (!await this.state.storage.getAlarm()) {
        await this.state.storage.setAlarm(Date.now() + 60 * 1000); // 1分後にアラームを設定
        logInfo("Set initial alarm for batch job polling from chunk processing.");
      }

    } catch (e) {
      logError(`Failed to process chunk ${chunk.chunkIndex} in BatchQueueDO`, e, { chunkIndex: chunk.chunkIndex, retryCount: chunk.retryCount || 0 });
      // リトライ処理
      await this.handleChunkError(chunk, e, MAX_RETRIES);
    }
  }

  private async handleChunkError(chunk: BatchChunk, error: any, maxRetries: number): Promise<void> {
    chunk.retryCount = (chunk.retryCount || 0) + 1;
    if (chunk.retryCount <= maxRetries) {
      logWarning(`BatchQueueDO: Retrying chunk ${chunk.chunkIndex}. Attempt ${chunk.retryCount}/${maxRetries}.`, { error: error, chunkIndex: chunk.chunkIndex, retryCount: chunk.retryCount });
      // チャンクをキューの先頭に戻す
      let currentChunks = await this.state.storage.get<BatchChunk[]>("chunks") || [];
      currentChunks.unshift(chunk); // 先頭に追加
      await this.state.storage.put("chunks", currentChunks);
    } else {
      logError(`BatchQueueDO: Max retries (${maxRetries}) exceeded for chunk ${chunk.chunkIndex}. Skipping this chunk.`, error, { chunkIndex: chunk.chunkIndex, retryCount: chunk.retryCount });
      // TODO: 最終的なエラー通知 (例: Slack, Sentry)
    }
  }

  private async updateArticleEmbeddingsInD1(
    records: {
      articleId: string;
      embedding: number[];
    }[],
    env: Env
  ): Promise<void> {
    const stmt = env.DB.prepare(`
      UPDATE articles
      SET embedding = ?
      WHERE article_id = ?
    `);
    const batch = records.map((rec) => {
      return stmt.bind(
        JSON.stringify(rec.embedding),
        rec.articleId
      );
    });
    await env.DB.batch(batch);
  }
}
