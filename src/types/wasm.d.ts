declare module "*.wasm?url" {
    const value: string;
    export default value;
}

declare module 'wrangler-wasm:*.wasm' {
    const value: WebAssembly.Module;
    export default value;
}

export interface NewsArticle {
    articleId: string;
    title: string;
    link: string;
    publishedAt?: string | number; // Dateオブジェクトまたはタイムスタンプ
    // その他の必要なプロパティがあれば追加
}

export interface NewsArticleWithEmbedding extends NewsArticle {
    embedding: number[];
}

export interface SelectPersonalizedArticlesRequest {
    articles: NewsArticleWithEmbedding[];
    userProfileEmbeddingForSelection: number[];
    userId: string;
    count: number;
    userCTR: number;
    lambda?: number;
    workerBaseUrl: string; // ClickLoggerへのフェッチのために必要
    negativeFeedbackEmbeddings?: number[][]; // 興味なし記事の埋め込みベクトル
}
