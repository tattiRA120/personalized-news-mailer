export const NEWS_RSS_URLS: string[] = [
    // マスメディア系
    'https://rss.app/feeds/37zaWxILdtNPMRBD.xml', // Reuters News via RSS.app
    'https://assets.wor.jp/rss/rdf/bloomberg/top.rdf', // Bloomberg via RSS愛好会
    'https://www.nhk.or.jp/rss/news/cat0.xml', // NHKニュース
    // ネットメディア(テック・ガジェット系)
    'https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml', // ITmedia NEWS
    'https://rss.itmedia.co.jp/rss/2.0/aiplus.xml', // ITmedia AI＋
    'https://rss.itmedia.co.jp/rss/2.0/pcuser.xml', // ITmedia PC USER
    'https://pc.watch.impress.co.jp/data/rss/1.0/pcw/feed.rdf', // PC Watch
    'https://dc.watch.impress.co.jp/data/rss/1.0/dcw/feed.rdf', // デジカメ Watch
    'https://av.watch.impress.co.jp/data/rss/1.0/avw/feed.rdf', // AV Watch
    'https://www.phileweb.com/rss.php', // PHILE WEB
    'https://gigazine.net/news/rss_2.0/', // GIGAZINE
    'https://www.gizmodo.jp/index.xml', // GIZMODO JAPAN（ギズモード・ジャパン）
    'https://www.gdm.or.jp/feed', // エルミタージュ秋葉原
    // ブログ系
    'https://zenn.dev/feed', // Zenn(エンジニア系)
    'https://qiita.com/popular-items/feed.atom', // Qiita(エンジニア系)
    'https://gazlog.jp/feed/', // ギャズログ｜GAZLOG(PCパーツ:リーク系)
    'https://northwood.blog.fc2.com/?xml', // 北森瓦版(PCパーツ:リーク系)
];

export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

// You can add other configuration variables here, like API keys (though better to use Workers Secrets for sensitive info)
// export const NEWS_API_KEY: string | undefined = undefined;

export const CHUNK_SIZE = 1000; // OpenAI Batch API のチャンクサイズ

export const NEWS_SOURCE_LOGOS: { [key: string]: string } = {
    'Reuters': 'https://cdn.freebiesupply.com/logos/large/2x/reuters-6-logo-png-transparent.png',
    'Bloomberg': 'https://images.ctfassets.net/lr0atmu04u9z/1PGS2NP94z5RP7L61GzIbm/85665ad1eadfd9c965448ad67097aba0/new_bloomberg_logosvg.png',
    'NHK': 'https://www3.nhk.or.jp/news/img/fb_futa16_600px.png',
    'ITmedia': 'https://is3-ssl.mzstatic.com/image/thumb/Podcasts115/v4/bd/0a/43/bd0a4322-3dce-7ae3-12fa-2625bd554cd1/mza_12590752468951394902.png/500x500bb.jpg',
    'ITmedia AI＋': 'https://is3-ssl.mzstatic.com/image/thumb/Podcasts115/v4/bd/0a/43/bd0a4322-3dce-7ae3-12fa-2625bd554cd1/mza_12590752468951394902.png/500x500bb.jpg',
    'ITmedia PC USER': 'https://is3-ssl.mzstatic.com/image/thumb/Podcasts115/v4/bd/0a/43/bd0a4322-3dce-7ae3-12fa-2625bd554cd1/mza_12590752468951394902.png/500x500bb.jpg',
    'PC Watch': 'https://pc.watch.impress.co.jp/img/common/p01/logo/pcw.1200.png',
    'デジカメ Watch': 'https://dc.watch.impress.co.jp/include/common/p01/images/logo/dcw.1200.png',
    'AV Watch': 'https://av.watch.impress.co.jp/include/common/p01/images/logo/avw.1200.png',
    'PHILE WEB': 'https://scontent-nrt1-2.xx.fbcdn.net/v/t39.30808-1/305078379_515729613891255_1137759068026059747_n.png?stp=dst-png_s200x200&_nc_cat=110&ccb=1-7&_nc_sid=2d3e12&_nc_ohc=DNh8TDmVOwwQ7kNvwEaNiWK&_nc_oc=AdnX383Ev38TgeY8nV7jOL7CWEGCC7m-4sEa7iFsqE8QtyJzO-y-AwC1fXatEATKO_I3wsjKGv7kbVexECT-EH4-&_nc_zt=24&_nc_ht=scontent-nrt1-2.xx&_nc_gid=Sb1PMSi1qBHw_YwWb0Ynzg&oh=00_AfW6QXq-PhGBFtCoAt4x1lhCyvGCXlvNcfC_iDmAbMpeag&oe=68BB22DD',
    'GIGAZINE': 'https://pbs.twimg.com/profile_images/876998955627827204/IuoxMaM2_400x400.jpg',
    'GIZMODO JAPAN': 'https://upload.wikimedia.org/wikipedia/commons/6/69/Gizmodo_Media_Group_Logo.png',
    'エルミタージュ秋葉原': 'https://www.gdm.or.jp/wp-content/themes/hermitage/images/common/logo.png',
    'Zenn': 'https://static.zenn.studio/images/logo-only-dark.png',
    'Qiita': 'https://i.gyazo.com/43ef3dfee7b402b1582db2ce241731f5.png',
    'ギャズログ': 'https://gazlog.jp/wp-content/uploads/2024/02/cropped-Gazlog-favcon-3-1.jpg',
    '北森瓦版': 'https://cdn2.iconfinder.com/data/icons/social-icon-3/512/social_style_3_rss-512.png',
    // 汎用的なデフォルト画像
    'DEFAULT': 'https://cdn2.iconfinder.com/data/icons/social-icon-3/512/social_style_3_rss-512.png',
};
