import { logError, logInfo, logWarning } from "./logger";
import { uploadOpenAIFile, createOpenAIBatchEmbeddingJob, prepareBatchInputFileContent } from "./openaiClient";
import { NewsArticle } from "./newsCollector";
import { Env } from "./index"; // Envインターフェースをインポート
import { DurableObject } from 'cloudflare:workers'; // DurableObject をインポート

interface BatchChunk {
  chunkIndex: number;
  articles: NewsArticle[];
  retryCount?: number; // リトライ回数を追跡
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
      const storedChunks = await this.state.storage.get<BatchChunk[]>("chunks");
      if (storedChunks && storedChunks.length > 0) {
        logInfo("BatchQueueDO initialized with pending chunks. Resuming processing.");
        this.processQueue();
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
    }

    return new Response("Not found", { status: 404 });
  }

  private async processQueue(): Promise<void> {
    try {
      while (true) {
        let chunks = await this.state.storage.get<BatchChunk[]>("chunks") || [];
        if (chunks.length === 0) {
          logInfo("BatchQueueDO: No more chunks to process. Stopping queue processing.");
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
      logError("BatchQueueDO: Error during queue processing", error);
      this.processingPromise = null; // エラー発生時も処理を停止
    }
  }

  private async processSingleChunk(chunk: BatchChunk): Promise<void> {
    const callbackUrl = this.env.WORKER_BASE_URL
      ? `${this.env.WORKER_BASE_URL}/openai-batch-callback`
      : "https://xxxxx.workers.dev/openai-batch-callback"; // デフォルトURLは適宜変更

    const jsonl = prepareBatchInputFileContent(chunk.articles);
    const blob = new Blob([jsonl], { type: "application/jsonl" });
    const filename = `articles_chunk${chunk.chunkIndex}_${Date.now()}.jsonl`;
    const MAX_RETRIES = 3; // 最大リトライ回数

    try {
      logInfo(`Attempting to upload chunk ${chunk.chunkIndex} file: ${filename} (Retry: ${chunk.retryCount || 0})`);
      const uploaded = await uploadOpenAIFile(filename, blob, "batch", this.env);
      if (!uploaded || !uploaded.id) {
        logError(`Chunk ${chunk.chunkIndex} upload returned no file ID.`, null, { chunkIndex: chunk.chunkIndex, retryCount: chunk.retryCount || 0 });
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
        logError(`Chunk ${chunk.chunkIndex} batch job creation returned no job ID.`, null, { chunkIndex: chunk.chunkIndex, retryCount: chunk.retryCount || 0 });
        // リトライ処理
        await this.handleChunkError(chunk, `Batch job creation failed: No job ID`, MAX_RETRIES);
        return;
      }
      logInfo(`Chunk ${chunk.chunkIndex} batch job created. Job ID: ${job.id}`);
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
}
