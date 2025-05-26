export const NEWS_RSS_URLS: string[] = [
    // 'https://www.nasa.gov/rss/dyn/breaking_news.rss', NASA Breaking News
    // 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', New York Times World News
    'https://news.google.com/rss/search?q=when:24h+allinurl:reuters.com&ceid=JP:ja&hl=ja&gl=JP' // Reuters News via Google News
];

// You can add other configuration variables here, like API keys (though better to use Workers Secrets for sensitive info)
// export const NEWS_API_KEY: string | undefined = undefined;

export const ARTICLE_CATEGORIES: string[] = [
    '政治',
    '経済',
    'テクノロジー',
    'ビジネス',
    '科学',
    '環境',
    '社会',
    '文化',
    'エンタメ',
    'スポーツ',
    '国際',
    '国内',
    'その他' // どのカテゴリーにも属さない場合
];
