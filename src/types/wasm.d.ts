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
    recentInterestEmbeddings?: number[][]; // 直近のポジティブフィードバック記事の埋め込みベクトル
    explicitInterestEmbeddings?: number[][]; // ユーザーが明示的に「興味あり」とした記事の埋め込みベクトル
}
