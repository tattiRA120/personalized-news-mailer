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

export const CATEGORY_KEYWORDS: { [key: string]: string[] } = {
    '政治': ['政治', '選挙', '国会', '内閣', '政党', '法案', '外交', '安全保障'],
    '経済': ['経済', '景気', '金融', '財政', '市場', '投資', '企業', '産業', '雇用', 'インフレ', 'デフレ'],
    'テクノロジー': ['テクノロジー', '技術', '開発', '研究', 'AI', '人工知能', 'IT', 'ソフトウェア', 'ハードウェア', 'インターネット', '通信', '半導体'],
    'ビジネス': ['ビジネス', '経営', '戦略', 'マーケティング', 'スタートアップ', 'M&A', '買収', '合併', '提携', '働き方'],
    '科学': ['科学', '研究', '発見', '宇宙', '物理', '化学', '生物', '医学', '地学', '天文学'],
    '環境': ['環境', '温暖化', '気候変動', '再生可能エネルギー', 'エコ', '汚染', '自然', '災害'],
    '社会': ['社会', '問題', '事件', '事故', '裁判', '教育', '医療', '福祉', '労働', '人権', 'ジェンダー'],
    '文化': ['文化', '芸術', '文学', '音楽', '映画', '美術', '演劇', '歴史', '哲学', '宗教'],
    'エンタメ': ['エンタメ', '芸能', '映画', '音楽', 'テレビ', 'ドラマ', '俳優', '女優', 'アーティスト', 'アイドル', 'K-POP', 'ゲーム', 'アニメ', '漫画'],
    'スポーツ': ['スポーツ', '野球', 'サッカー', 'バスケ', 'テニス', 'ゴルフ', 'オリンピック', '選手', '試合', '大会'],
    '国際': ['国際', '世界', '海外', '外交', '紛争', '条約', '国連', 'EU', 'アメリカ', '中国', '韓国', 'ロシア'],
    '国内': ['国内', '日本', '地域', '都道府県', '地方', '行政'],
    'その他': [] // その他のカテゴリーにはキーワードを設定しない
};
