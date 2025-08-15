import { logError, logInfo, logWarning } from "./logger";
import { uploadOpenAIFile, createOpenAIBatchEmbeddingJob, prepareBatchInputFileContent, getOpenAIBatchJobStatus, getOpenAIBatchJobResults } from "./openaiClient";
import { NewsArticle } from "./newsCollector";
import { Env } from "./index";
import { DurableObject } from 'cloudflare:workers';
import { ClickLogger } from "./clickLogger";

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

  constructor(state: DurableObjectState, env: BatchQueueDOEnv) {
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
          // 初期化時にアラームを設定する場合、ポーリング開始時刻も設定
          const now = Date.now();
          await this.state.storage.put("pollingStartTime", now);
          await this.state.storage.put("currentPollingInterval", 60 * 1000); // 1分
          await this.state.storage.setAlarm(now + 60 * 1000); // 1分後にアラームを設定
          logInfo("Set initial alarm for batch job polling during DO initialization.");
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
        const { batchId, inputFileId, userId } = await request.json<{ batchId: string; inputFileId: string; userId?: string }>();
        if (!batchId || !inputFileId) {
          return new Response("Missing batchId or inputFileId", { status: 400 });
        }

        let batchJobs = await this.state.storage.get<BatchJobInfo[]>("batchJobs") || [];
        batchJobs.push({ batchId, inputFileId, status: "pending", retryCount: 0, userId: userId }); // userIdを保存
        await this.state.storage.put("batchJobs", batchJobs);
        logInfo(`Added batch job ${batchId} to polling queue for user ${userId || 'N/A'}.`);

        // アラームが設定されていない場合のみ設定
        if (!await this.state.storage.getAlarm()) {
          const now = Date.now();
          await this.state.storage.put("pollingStartTime", now);
          await this.state.storage.put("currentPollingInterval", 60 * 1000); // 1分
          await this.state.storage.setAlarm(now + 60 * 1000); // 1分後にアラームを設定
          logInfo("Set initial alarm for batch job polling.");
        }

        return new Response("Polling started for batch job", { status: 200 });
      } catch (error) {
        logError("Failed to start polling in BatchQueueDO", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    } else if (path === "/debug/trigger-alarm" && request.method === "POST") {
      logInfo("BatchQueueDO: Debug alarm trigger request received.");
      await this.alarm(); // 直接 alarm() メソッドを呼び出す
      return new Response("Alarm triggered manually.", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    logInfo("BatchQueueDO: Alarm triggered. Checking batch job statuses.");
    let batchJobs = await this.state.storage.get<BatchJobInfo[]>("batchJobs") || [];
    const completedJobs: BatchJobInfo[] = [];
    const failedJobs: BatchJobInfo[] = [];
    const pendingJobs: BatchJobInfo[] = [];

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
      logInfo(`Polling interval adjusted to ${currentPollingInterval / 1000 / 60} minutes based on elapsed time: ${elapsedMinutes.toFixed(2)} minutes.`);
    } else {
      logWarning("Polling start time not found. Using default 1-minute interval.");
      await this.state.storage.put("pollingStartTime", Date.now()); // 初回アラーム時に設定
      await this.state.storage.put("currentPollingInterval", 60 * 1000); // 1分
    }

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
                const embeddingsToUpdate = results.map(r => {
                    if (r.error) {
                        logWarning(`Batch result item contains an error. Skipping.`, { error: r.error, custom_id: r.custom_id });
                        return null;
                    }

                    const articleId: string = r.custom_id; // custom_id は既に articleId の文字列

                    const embedding = r.response?.body?.data?.[0]?.embedding;

                    if (embedding === undefined || articleId === undefined) {
                        logWarning(`Batch result item missing embedding or articleId after parsing. Skipping.`, { custom_id: r.custom_id, embeddingExists: embedding !== undefined, articleIdExists: articleId !== undefined });
                        return null;
                    }
                    return {
                        articleId: articleId,
                        embedding: embedding
                    };
                }).filter(item => item !== null) as { articleId: string; embedding: number[]; }[];

                if (embeddingsToUpdate.length > 0) {
                    await this.updateArticleEmbeddingsInD1(embeddingsToUpdate, this.env);
                    logInfo(`Updated D1 with embeddings for batch job ${jobInfo.batchId}.`);

                    // ClickLoggerにコールバックを送信
                    const clickLoggerId = this.env.CLICK_LOGGER.idFromName("global-click-logger-hub");
                    const clickLogger = this.env.CLICK_LOGGER.get(clickLoggerId);
                    
                    try {
                        const callbackResponse = await clickLogger.fetch(
                            new Request(`${this.env.WORKER_BASE_URL}/embedding-completed-callback`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ embeddings: embeddingsToUpdate, userId: jobInfo.userId }),
                            })
                        );
                        if (callbackResponse.ok) {
                            logInfo(`Successfully sent embedding completion callback to ClickLogger for batch job ${jobInfo.batchId} (user: ${jobInfo.userId || 'N/A'}).`);
                        } else {
                            logError(`Failed to send embedding completion callback to ClickLogger for batch job ${jobInfo.batchId} (user: ${jobInfo.userId || 'N/A'}): ${callbackResponse.statusText}`, null, { jobId: jobInfo.batchId, status: callbackResponse.status, statusText: callbackResponse.statusText });
                        }
                    } catch (callbackError) {
                        logError(`Error sending embedding completion callback to ClickLogger for batch job ${jobInfo.batchId} (user: ${jobInfo.userId || 'N/A'}).`, callbackError, { jobId: jobInfo.batchId });
                    }

                } else {
                    logWarning(`Batch job ${jobInfo.batchId} completed but no valid embeddings to update after filtering.`, { jobId: jobInfo.batchId });
                }
            } else {
                logWarning(`Batch job ${jobInfo.batchId} completed but no results found after parsing.`, { jobId: jobInfo.batchId });
            }
          } else {
            logWarning(`Batch job ${jobInfo.batchId} completed but no results content received.`, { jobId: jobInfo.batchId });
          }
          completedJobs.push(jobInfo);
        } else if (jobInfo.status === "failed" || jobInfo.status === "cancelled" || jobInfo.status === "cancelling") {
          logError(`Batch job ${jobInfo.batchId} failed, cancelled, or is cancelling.`, new Error(`Batch job ${jobInfo.batchId} status: ${jobInfo.status}`), { jobId: jobInfo.batchId, status: jobInfo.status });
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
      await this.state.storage.setAlarm(Date.now() + currentPollingInterval); // 計算された間隔でアラームを設定
      logInfo(`Set next alarm for batch job polling in ${currentPollingInterval / 1000 / 60} minutes. Remaining jobs: ${pendingJobs.length}`);
    } else {
      logInfo("All batch jobs processed. No more alarms scheduled for polling.");
      // 全てのジョブが完了したら、ポーリング開始時刻と間隔をリセット
      await this.state.storage.delete("pollingStartTime");
      await this.state.storage.delete("currentPollingInterval");
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
        const now = Date.now();
        await this.state.storage.put("pollingStartTime", now);
        await this.state.storage.put("currentPollingInterval", 60 * 1000); // 1分
        await this.state.storage.setAlarm(now + 60 * 1000); // 1分後にアラームを設定
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
    // デバッグ: 更新対象の articleId が存在するか確認
    for (const rec of records) {
      const existingArticle = await env.DB.prepare('SELECT article_id FROM articles WHERE article_id = ?').bind(rec.articleId).first();
      if (!existingArticle) {
        logWarning(`Attempted to update non-existent articleId in D1: ${rec.articleId}`, { articleId: rec.articleId });
      } else {
        logInfo(`ArticleId exists in D1: ${rec.articleId}`, { articleId: rec.articleId });
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
    logInfo(`D1 batch update result for job:`, { batchResult });
  }
}
