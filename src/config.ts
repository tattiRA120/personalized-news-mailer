export const NEWS_RSS_URLS: string[] = [
    // マスメディア系
    'https://news.google.com/rss/search?q=when:24h+allinurl:reuters.com&ceid=JP:ja&hl=ja&gl=JP', // Reuters News via Google News
    'https://news.google.com/rss/search?q=when:24h+allinurl:bloomberg.co.jp&hl=ja&gl=JP&ceid=JP:ja', // Bloomberg via Google News
    'https://www.nhk.or.jp/rss/news/cat0.xml', // NHKニュース
    // ネットメディア(テック・ガジェット系)
    'https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml', // ITmedia NEWS
    'https://rss.itmedia.co.jp/rss/2.0/aiplus.xml', // ITmedia AI＋
    'https://rss.itmedia.co.jp/rss/2.0/pcuser.xml', // ITmedia PC USER
    'https://pc.watch.impress.co.jp/data/rss/1.0/pcw/feed.rdf', // PC Watch
    'https://dc.watch.impress.co.jp/data/rss/1.0/dcw/feed.rdf', // デジカメ Watch
    'https://av.watch.impress.co.jp/data/rss/1.0/avw/feed.rdf', // AV Watch
    'https://gigazine.net/news/rss_2.0/', // GIGAZINE
    'https://www.gizmodo.jp/index.xml', // GIZMODO JAPAN（ギズモード・ジャパン）
    'https://www.gdm.or.jp/feed', // エルミタージュ秋葉原
    // ブログ系
    'https://zenn.dev/feed', // Zenn(エンジニア系)
    'https://qiita.com/popular-items/feed.atom', // Qiita(エンジニア系)
    'https://gazlog.jp/feed/', // ギャズログ｜GAZLOG(PCパーツ:リーク系)
    'https://northwood.blog.fc2.com/?xml', // 北森瓦版(PCパーツ:リーク系)
];

export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-large";

// You can add other configuration variables here, like API keys (though better to use Workers Secrets for sensitive info)
// export const NEWS_API_KEY: string | undefined = undefined;

export const CHUNK_SIZE = 1000; // OpenAI Batch API のチャンクサイズ
