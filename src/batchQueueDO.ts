import { Logger } from "./logger";
import { uploadOpenAIFile, createOpenAIBatchEmbeddingJob, prepareBatchInputFileContent, getOpenAIBatchJobStatus, getOpenAIBatchJobResults } from "./openaiClient";
import { NewsArticle } from "./newsCollector";
import { Env } from "./types/bindings";
import { DurableObject } from 'cloudflare:workers';
import { ClickLogger } from "./clickLogger";
import { OPENAI_EMBEDDING_DIMENSION } from "./config";
import { Hono } from 'hono';

interface BatchChunk {
  chunkIndex: number;
  articles: NewsArticle[];
  retryCount?: number; // リトライ回数を追跡
  userId?: string;
}

interface BatchJobInfo {
  batchId: string;
  inputFileId: string;
  status: string;
  retryCount: number;
  pollingStartTime?: number; // ポーリング開始時刻 (Unixタイムスタンプ)
  currentPollingInterval?: number; // 現在のポーリング間隔 (ミリ秒)
  userId?: string;
}

interface PendingCallback {
  embeddings: { articleId: string; embedding: number[]; }[];
  userId?: string;
  retryCount: number;
  timestamp: number; // コールバックがペンディングされた時刻
}

interface BatchResultItem {
  id?: string; // リクエストID
  custom_id: string; // JSON.stringify({ articleId: article.articleId }) された文字列
  response?: { // 成功時の応答
    status_code: number;
    body: {
      object: string;
      data: Array<{
        object: string;
        embedding: number[];
        index: number;
      }>;
      model: string;
      usage: {
        prompt_tokens: number;
        total_tokens: number;
      };
    };
  };
  error?: { // エラー時の応答
    code: string;
    message: string;
    param: string;
    type: string;
  };
}

// BatchQueueDO が必要とする Env の拡張
interface BatchQueueDOEnv extends Env {
  CLICK_LOGGER: DurableObjectNamespace<ClickLogger>;
}

export class BatchQueueDO extends DurableObject { // DurableObject を継承
  state: DurableObjectState;
  env: BatchQueueDOEnv;
  private processingPromise: Promise<void> | null = null;
  private logger: Logger;
  private app: Hono<{ Bindings: BatchQueueDOEnv }>;

  constructor(state: DurableObjectState, env: BatchQueueDOEnv) {
    super(state, env); // 親クラスのコンストラクタを呼び出す
    this.state = state;
    this.env = env;
    this.logger = new Logger(env);
    this.app = new Hono<{ Bindings: BatchQueueDOEnv }>();
    this.setupRoutes();
    this.state.blockConcurrencyWhile(async () => {
      // DOが初期化される際に、未処理のチャンクがあれば処理を開始
      const storedChunks = await this.state.storage.get<BatchChunk[]>("chunks") || [];
      const storedBatchJobs = await this.state.storage.get<BatchJobInfo[]>("batchJobs") || [];
      const storedPendingCallbacks = await this.state.storage.get<PendingCallback[]>("pendingCallbacks") || [];

      if (storedChunks.length > 0) {
        this.logger.debug("BatchQueueDO initialized with pending chunks. Resuming chunk processing.");
        this.processQueue();
      }
      if (storedBatchJobs.length > 0) {
        this.logger.debug("BatchQueueDO initialized with pending batch jobs. Resuming polling.");
        // アラームが設定されていない場合は設定
        if (!await this.state.storage.getAlarm()) {
          // 初期化時にアラームを設定する場合、ポーリング開始時刻も設定
          const now = Date.now();
          await this.state.storage.put("pollingStartTime", now);
          await this.state.storage.put("currentPollingInterval", 60 * 1000); // 1分
          await this.state.storage.setAlarm(now + 60 * 1000); // 1分後にアラームを設定
          this.logger.debug("Set initial alarm for batch job polling during DO initialization.");
        }
      }
      if (storedPendingCallbacks.length > 0) {
        this.logger.debug("BatchQueueDO initialized with pending callbacks. Resuming callback processing.");
        // アラームが設定されていない場合は設定
        if (!await this.state.storage.getAlarm()) {
          const now = Date.now();
          await this.state.storage.setAlarm(now + 60 * 1000); // 1分後にアラームを設定
          this.logger.debug("Set initial alarm for pending callback processing during DO initialization.");
        }
      }
    });
  }

  private setupRoutes() {
    this.app.post('/queue-chunks', async (c) => {
      try {
        const { chunks } = await c.req.json<{ chunks: BatchChunk[] }>();
        if (!chunks || chunks.length === 0) {
          return new Response("No chunks provided", { status: 400 });
        }

        const updates: Record<string, BatchChunk> = {};
        for (const chunk of chunks) {
          // Use timestamp + random to ensure unique ordered keys
          const key = `chunk_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          updates[key] = chunk;
        }
        await this.state.storage.put(updates);

        this.logger.debug(`Added ${chunks.length} chunks to queue.`);

        if (!this.processingPromise) {
          this.processingPromise = this.processQueue();
        }

        return new Response("Chunks queued successfully", { status: 200 });
      } catch (error) {
        this.logger.error("Failed to queue chunks in BatchQueueDO", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    });

    this.app.post('/start-polling', async (c) => {
      try {
        const { batchId, inputFileId, userId } = await c.req.json<{ batchId: string; inputFileId: string; userId?: string }>();
        if (!batchId || !inputFileId) {
          return new Response("Missing batchId or inputFileId", { status: 400 });
        }

        let batchJobs = await this.state.storage.get<BatchJobInfo[]>("batchJobs") || [];
        batchJobs.push({ batchId, inputFileId, status: "pending", retryCount: 0, userId: userId });
        await this.state.storage.put("batchJobs", batchJobs);
        this.logger.debug(`Added batch job ${batchId} to polling queue for user ${userId || 'N/A'}.`);

        if (!await this.state.storage.getAlarm()) {
          const now = Date.now();
          await this.state.storage.put("pollingStartTime", now);
          await this.state.storage.put("currentPollingInterval", 60 * 1000);
          await this.state.storage.setAlarm(now + 60 * 1000);
          this.logger.debug("Set initial alarm for batch job polling.");
        }

        return new Response("Polling started for batch job", { status: 200 });
      } catch (error) {
        this.logger.error("Failed to start polling in BatchQueueDO", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    });

    this.app.post('/debug/trigger-alarm', async (c) => {
      this.logger.debug("BatchQueueDO: Debug alarm trigger request received.");
      await this.alarm();
      return new Response("Alarm triggered manually.", { status: 200 });
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request, this.env);
  }

  async alarm() {
    this.logger.debug("BatchQueueDO: Alarm triggered. Checking batch job statuses and pending callbacks.");
    let batchJobs = await this.state.storage.get<BatchJobInfo[]>("batchJobs") || [];
    let pendingCallbacks = await this.state.storage.get<PendingCallback[]>("pendingCallbacks") || [];

    const completedJobs: BatchJobInfo[] = [];
    const failedJobs: BatchJobInfo[] = [];
    const pendingBatchJobs: BatchJobInfo[] = []; // 名前を変更して区別しやすくする
    const pendingCallbacksToProcess: PendingCallback[] = []; // 処理中のコールバック

    // まず、ペンディング中のコールバックを処理
    if (pendingCallbacks.length > 0) {
      this.logger.debug(`Processing ${pendingCallbacks.length} pending callbacks.`);
      const clickLoggerId = this.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
      const clickLogger = this.env.CLICK_LOGGER.get(clickLoggerId);
      const MAX_CALLBACK_RETRIES = 5;
      const INITIAL_RETRY_DELAY_MS = 1000; // 1秒

      for (const callback of pendingCallbacks) {
        try {
          const response = await clickLogger.fetch(
            new Request(`${this.env.WORKER_BASE_URL}/embedding-completed-callback`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ embeddings: callback.embeddings, userId: callback.userId }),
            })
          );
          if (!response.ok) {
            throw new Error(`Callback failed with status ${response.status}: ${response.statusText}`);
          }
          this.logger.debug(`Successfully re-sent pending callback for user ${callback.userId || 'N/A'}.`);
        } catch (e: unknown) {
          callback.retryCount++;
          if (callback.retryCount <= MAX_CALLBACK_RETRIES) {
            const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, callback.retryCount - 1) + Math.random() * 1000; // 指数バックオフ + ジッター
            this.logger.warn(`Retrying pending callback for user ${callback.userId || 'N/A'}, attempt ${callback.retryCount}/${MAX_CALLBACK_RETRIES}. Delaying for ${delay}ms.`, e, { userId: callback.userId, retryCount: callback.retryCount });
            pendingCallbacksToProcess.push(callback); // リトライのためにキューに戻す
          } else {
            const err = e instanceof Error ? e : new Error(String(e));
            this.logger.error(`Max retries exceeded for pending callback for user ${callback.userId || 'N/A'}. Skipping.`, err, { userId: callback.userId, errorName: err.name, errorMessage: err.message });
          }
        }
      }
      await this.state.storage.put("pendingCallbacks", pendingCallbacksToProcess); // 処理後のペンディングコールバックを保存
    }

    // バッチジョブの処理

    const pollingStartTime = await this.state.storage.get<number>("pollingStartTime");
    let currentPollingInterval = await this.state.storage.get<number>("currentPollingInterval") || 60 * 1000; // デフォルト1分

    if (pollingStartTime) {
      const elapsedTime = Date.now() - pollingStartTime; // ミリ秒
      const elapsedMinutes = elapsedTime / (60 * 1000);

      if (elapsedMinutes < 10) {
        currentPollingInterval = 1 * 60 * 1000; // 1分
      } else if (elapsedMinutes < 30) {
        currentPollingInterval = 10 * 60 * 1000; // 10分
      } else if (elapsedMinutes < 60) {
        currentPollingInterval = 30 * 60 * 1000; // 30分
      } else {
        currentPollingInterval = 60 * 60 * 1000; // 1時間
      }
      await this.state.storage.put("currentPollingInterval", currentPollingInterval);
      this.logger.debug(`Polling interval adjusted to ${currentPollingInterval / 1000 / 60} minutes based on elapsed time: ${elapsedMinutes.toFixed(2)} minutes.`);
    } else {
      this.logger.warn("Polling start time not found. Using default 1-minute interval.");
      await this.state.storage.put("pollingStartTime", Date.now()); // 初回アラーム時に設定
      await this.state.storage.put("currentPollingInterval", 60 * 1000); // 1分
    }

    for (const jobInfo of batchJobs) {
      try {
        const statusResponse = await getOpenAIBatchJobStatus(jobInfo.batchId, this.env);

        if (!statusResponse) {
          this.logger.warn(`Batch job ${jobInfo.batchId} status response was null. Retrying.`, { jobId: jobInfo.batchId });
          jobInfo.retryCount = (jobInfo.retryCount || 0) + 1;
          const MAX_POLLING_RETRIES = 5;
          if (jobInfo.retryCount <= MAX_POLLING_RETRIES) {
            pendingBatchJobs.push(jobInfo);
          } else {
            this.logger.error(`Max polling retries exceeded for batch job ${jobInfo.batchId} due to null response. Skipping.`, new Error('Null status response'), { jobId: jobInfo.batchId });
            failedJobs.push(jobInfo);
          }
          continue;
        }

        jobInfo.status = statusResponse.status; // ステータスを更新

        this.logger.debug(`Batch job ${jobInfo.batchId} status: ${jobInfo.status}`);

        if (jobInfo.status === "completed") {
          this.logger.debug(`Batch job ${jobInfo.batchId} completed. Fetching results.`);
          const resultsContent = await getOpenAIBatchJobResults(statusResponse.output_file_id!, this.env); // output_file_id は completed 時には存在するはず

          if (resultsContent) {
            const results: BatchResultItem[] = resultsContent.split('\n')
              .filter(line => line.trim() !== '')
              .map(line => JSON.parse(line));

            if (results && results.length > 0) {
              const embeddingsToUpdate = results.map(r => {
                if (r.error) {
                  this.logger.warn(`Batch result item contains an error. Skipping.`, { error: r.error, custom_id: r.custom_id });
                  return null;
                }

                const articleId: string = r.custom_id; // custom_id は既に articleId の文字列

                const embedding = r.response?.body?.data?.[0]?.embedding;

                if (embedding === undefined || articleId === undefined) {
                  this.logger.warn(`Batch result item missing embedding or articleId after parsing. Skipping.`, { custom_id: r.custom_id, embeddingExists: embedding !== undefined, articleIdExists: articleId !== undefined });
                  return null;
                }
                // OpenAIから受け取った512次元のembeddingに鮮度情報のプレースホルダー(0.0)を追加して513次元にする
                const extendedEmbedding = [...embedding, 0.0];
                return {
                  articleId: articleId,
                  embedding: extendedEmbedding
                };
              }).filter(item => item !== null) as { articleId: string; embedding: number[]; }[];

              if (embeddingsToUpdate.length > 0) {
                await this.updateArticleEmbeddingsInD1(embeddingsToUpdate, this.env);
                this.logger.debug(`Updated D1 with 513-dimensional embeddings for batch job ${jobInfo.batchId}.`);

                // ClickLoggerにコールバックを送信
                const clickLoggerId = this.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
                const clickLogger = this.env.CLICK_LOGGER.get(clickLoggerId);

                // WORKER_BASE_URL が設定されているか確認
                if (!this.env.WORKER_BASE_URL) {
                  this.logger.error(`WORKER_BASE_URL is not set in environment variables. Cannot send embedding completion callback to ClickLogger for batch job ${jobInfo.batchId}.`, null, { jobId: jobInfo.batchId });
                  // このジョブは失敗として扱い、再試行しない
                  failedJobs.push(jobInfo);
                  continue;
                }

                // ClickLoggerにコールバックを送信 (waitUntilで非同期実行)
                this.state.waitUntil((async () => {
                  const MAX_CALLBACK_RETRIES = 5;
                  const INITIAL_RETRY_DELAY_MS = 1000; // 1秒

                  const retryFetch = async (attempt: number = 0): Promise<Response> => {
                    try {
                      const response = await clickLogger.fetch(
                        new Request(`${this.env.WORKER_BASE_URL}/embedding-completed-callback`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ embeddings: embeddingsToUpdate, userId: jobInfo.userId }),
                        })
                      );
                      if (!response.ok) {
                        throw new Error(`Callback failed with status ${response.status}: ${response.statusText}`);
                      }
                      return response;
                    } catch (e) {
                      if (attempt < MAX_CALLBACK_RETRIES) {
                        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000; // 指数バックオフ + ジッター
                        this.logger.warn(`Retrying embedding completion callback for batch job ${jobInfo.batchId} (user: ${jobInfo.userId || 'N/A'}), attempt ${attempt + 1}/${MAX_CALLBACK_RETRIES}. Delaying for ${delay}ms.`, e, { jobId: jobInfo.batchId });
                        await new Promise(resolve => setTimeout(resolve, delay));
                        return retryFetch(attempt + 1);
                      }
                      throw e; // 最大リトライ回数を超えたらエラーを再スロー
                    }
                  };

                  try {
                    await retryFetch();
                    this.logger.debug(`Successfully sent embedding completion callback to ClickLogger for batch job ${jobInfo.batchId} (user: ${jobInfo.userId || 'N/A'}).`);
                  } catch (callbackError: unknown) {
                    const err = callbackError instanceof Error ? callbackError : new Error(String(callbackError));
                    this.logger.error(`Failed to send embedding completion callback to ClickLogger after ${MAX_CALLBACK_RETRIES} retries for batch job ${jobInfo.batchId} (user: ${jobInfo.userId || 'N/A'}).`, err, {
                      jobId: jobInfo.batchId,
                      errorName: err.name,
                      errorMessage: err.message,
                      errorStack: err.stack,
                    });
                    // リトライ後も失敗した場合は、このジョブは失敗として扱い、ペンディングコールバックとして保存
                    this.logger.warn(`Failed to send embedding completion callback to ClickLogger after ${MAX_CALLBACK_RETRIES} retries for batch job ${jobInfo.batchId} (user: ${jobInfo.userId || 'N/A'}). Saving as pending callback.`, err, {
                      jobId: jobInfo.batchId,
                      errorName: err.name,
                      errorMessage: err.message,
                      errorStack: err.stack,
                    });
                    const currentPendingCallbacks = await this.state.storage.get<PendingCallback[]>("pendingCallbacks") || [];
                    currentPendingCallbacks.push({
                      embeddings: embeddingsToUpdate,
                      userId: jobInfo.userId,
                      retryCount: 0, // 新しいペンディングコールバックなのでリトライカウントは0から
                      timestamp: Date.now(),
                    });
                    await this.state.storage.put("pendingCallbacks", currentPendingCallbacks);
                  }
                })());

              } else {
                this.logger.warn(`Batch job ${jobInfo.batchId} completed but no valid embeddings to update after filtering.`, { jobId: jobInfo.batchId });
              }
            } else {
              this.logger.warn(`Batch job ${jobInfo.batchId} completed but no results found after parsing.`, { jobId: jobInfo.batchId });
            }
          } else {
            this.logger.warn(`Batch job ${jobInfo.batchId} completed but no results content received.`, { jobId: jobInfo.batchId });
          }
          completedJobs.push(jobInfo);
        } else if (jobInfo.status === "failed" || jobInfo.status === "cancelled" || jobInfo.status === "cancelling") {
          this.logger.error(`Batch job ${jobInfo.batchId} failed, cancelled, or is cancelling.`, new Error(`Batch job ${jobInfo.batchId} status: ${jobInfo.status}`), { jobId: jobInfo.batchId, status: jobInfo.status });
          failedJobs.push(jobInfo);
        } else {
          // pending, in_progress, finalizing など
          pendingBatchJobs.push(jobInfo);
        }
      } catch (error) {
        jobInfo.retryCount = (jobInfo.retryCount || 0) + 1;
        const MAX_POLLING_RETRIES = 5; // ポーリングのリトライ回数
        if (jobInfo.retryCount <= MAX_POLLING_RETRIES) {
          this.logger.warn(`Error checking status for batch job ${jobInfo.batchId}. Retrying (${jobInfo.retryCount}/${MAX_POLLING_RETRIES}).`, { error: error, jobId: jobInfo.batchId });
          pendingBatchJobs.push(jobInfo); // リトライのためにキューに戻す
        } else {
          this.logger.error(`Max polling retries exceeded for batch job ${jobInfo.batchId}. Skipping.`, error, { jobId: jobInfo.batchId });
          failedJobs.push(jobInfo); // 失敗として扱う
        }
      }
    }

    // 完了または失敗したジョブをストレージから削除し、保留中のジョブを保存
    await this.state.storage.put("batchJobs", pendingBatchJobs);

    // ペンディング中のバッチジョブまたはコールバックがある場合のみアラームを設定
    if (pendingBatchJobs.length > 0 || pendingCallbacksToProcess.length > 0) {
      // 未処理のジョブが残っている場合、次のアラームを設定
      await this.state.storage.setAlarm(Date.now() + currentPollingInterval); // 計算された間隔でアラームを設定
      this.logger.debug(`Set next alarm for batch job polling in ${currentPollingInterval / 1000 / 60} minutes. Remaining batch jobs: ${pendingBatchJobs.length}, pending callbacks: ${pendingCallbacksToProcess.length}`);
    } else {
      this.logger.debug("All batch jobs and pending callbacks processed. No more alarms scheduled for polling.");
      // 全てのジョブが完了したら、ポーリング開始時刻と間隔をリセット
      await this.state.storage.delete("pollingStartTime");
      await this.state.storage.delete("currentPollingInterval");
    }
  }

  private async processQueue(): Promise<void> {
    try {
      while (true) {
        const list = await this.state.storage.list<BatchChunk>({ prefix: "chunk_", limit: 1 });
        if (list.size === 0) {
          this.logger.debug("BatchQueueDO: No more chunks to process. Stopping chunk processing.");
          this.processingPromise = null;
          break;
        }

        const entry = list.entries().next();
        if (entry.done) {
          break;
        }
        const [key, chunkToProcess] = entry.value;

        if (chunkToProcess) {
          this.logger.debug(`BatchQueueDO: Processing chunk ${chunkToProcess.chunkIndex} (Key: ${key})`);
          const success = await this.processSingleChunk(chunkToProcess, key);

          if (success) {
            // Delete the processed chunk only on success
            await this.state.storage.delete(key);
            this.logger.debug(`BatchQueueDO: Chunk ${chunkToProcess.chunkIndex} processed and deleted from storage.`);
          }
          // If failed, processSingleChunk called handleChunkError which optionally updated the chunk (retries) or deleted it (max retries).
        }

        // Delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      this.logger.error("BatchQueueDO: Error during chunk queue processing", error);
      this.processingPromise = null;
    }
  }

  private async processSingleChunk(chunk: BatchChunk, key: string): Promise<boolean> {
    const jsonl = prepareBatchInputFileContent(chunk.articles);
    const blob = new Blob([jsonl], { type: "application/jsonl" });
    const filename = `articles_chunk${chunk.chunkIndex}_${Date.now()}.jsonl`;
    const MAX_RETRIES = 3;

    try {
      this.logger.debug(`Attempting to upload chunk ${chunk.chunkIndex} file: ${filename} (Retry: ${chunk.retryCount || 0})`);
      const uploaded = await uploadOpenAIFile(filename, blob, "batch", this.env);
      if (!uploaded || !uploaded.id) {
        this.logger.error(`Chunk ${chunk.chunkIndex} upload returned no file ID.`, new Error('No file ID returned'), { chunkIndex: chunk.chunkIndex, retryCount: chunk.retryCount || 0 });
        await this.handleChunkError(chunk, `Upload failed: No file ID`, MAX_RETRIES, key);
        return false;
      }
      this.logger.debug(`Chunk ${chunk.chunkIndex} uploaded. File ID: ${uploaded.id}`);

      this.logger.debug(`Attempting to create batch job for chunk ${chunk.chunkIndex} with file ID: ${uploaded.id}`);
      const job = await createOpenAIBatchEmbeddingJob(uploaded.id, this.env);
      if (!job || !job.id) {
        this.logger.error(`Chunk ${chunk.chunkIndex} batch job creation returned no job ID.`, new Error('No job ID returned'), { chunkIndex: chunk.chunkIndex, retryCount: chunk.retryCount || 0 });
        await this.handleChunkError(chunk, `Batch job creation failed: No job ID`, MAX_RETRIES, key);
        return false;
      }
      this.logger.debug(`Chunk ${chunk.chunkIndex} batch job created. Job ID: ${job.id}`);

      // Add to batchJobs
      // Note: We use an array for batchJobs for simplicity.
      // Optimistic concurrency or granular keys/transactions might be needed for high throughput.

      let batchJobs = await this.state.storage.get<BatchJobInfo[]>("batchJobs") || [];
      batchJobs.push({ batchId: job.id, inputFileId: uploaded.id, status: "pending", retryCount: 0 });
      await this.state.storage.put("batchJobs", batchJobs);
      this.logger.debug(`Delegated batch job ${job.id} to polling queue from chunk processing.`);

      if (!await this.state.storage.getAlarm()) {
        const now = Date.now();
        await this.state.storage.put("pollingStartTime", now);
        await this.state.storage.put("currentPollingInterval", 60 * 1000);
        await this.state.storage.setAlarm(now + 60 * 1000);
        this.logger.debug("Set initial alarm for batch job polling from chunk processing.");
      }

      return true;

    } catch (e) {
      this.logger.error(`Failed to process chunk ${chunk.chunkIndex} in BatchQueueDO`, e, { chunkIndex: chunk.chunkIndex, retryCount: chunk.retryCount || 0 });
      await this.handleChunkError(chunk, e, MAX_RETRIES, key);
      return false;
    }
  }



  private async handleChunkError(chunk: BatchChunk, error: any, maxRetries: number, originalKey?: string): Promise<void> {
    chunk.retryCount = (chunk.retryCount || 0) + 1;
    if (chunk.retryCount <= maxRetries) {
      this.logger.warn(`BatchQueueDO: Retrying chunk ${chunk.chunkIndex}. Attempt ${chunk.retryCount}/${maxRetries}.`, { error: error, chunkIndex: chunk.chunkIndex, retryCount: chunk.retryCount });

      this.logger.warn(`BatchQueueDO: Retrying chunk ${chunk.chunkIndex}. Attempt ${chunk.retryCount}/${maxRetries}.`, { error: error, chunkIndex: chunk.chunkIndex, retryCount: chunk.retryCount });

      if (originalKey) {
        await this.state.storage.put(originalKey, chunk);
      }
    } else {
      // ...
    }
  }

  private async updateArticleEmbeddingsInD1(
    records: {
      articleId: string;
      embedding: number[];
    }[],
    env: Env
  ): Promise<void> {
    // デバッグ: 更新対象の articleId が存在するか確認
    for (const rec of records) {
      const existingArticle = await env.DB.prepare('SELECT article_id FROM articles WHERE article_id = ?').bind(rec.articleId).first();
      if (!existingArticle) {
        this.logger.warn(`Attempted to update non-existent articleId in D1: ${rec.articleId}`, { articleId: rec.articleId });
      } else {
        this.logger.debug(`ArticleId exists in D1: ${rec.articleId}`, { articleId: rec.articleId });
      }
    }

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
    const batchResult = await env.DB.batch(batch);
    this.logger.debug(`D1 batch update result for job:`, { batchResult });

    // 更新された行数をチェックし、更新されなかった記事があればエラーログを出力
    for (let i = 0; i < batchResult.length; i++) {
      const result = batchResult[i];
      const articleId = records[i].articleId;
      if (result.success && result.meta?.changes === 0) {
        this.logger.error(`Failed to update embedding for article ${articleId} in D1: Article not found or no changes made.`, null, { articleId });
      } else if (!result.success) {
        this.logger.error(`Failed to update embedding for article ${articleId} in D1: ${result.error}`, null, { articleId, error: result.error });
      }
    }
  }
}
