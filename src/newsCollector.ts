import { NEWS_RSS_URLS } from './config';
import { logError, logInfo } from './logger'; // Import logging helpers
import { XMLParser } from 'fast-xml-parser'; // Import XMLParser

interface NewsArticle {
    title: string;
    link: string;
    sourceName: string; // Add sourceName
}

async function fetchRSSFeed(url: string): Promise<string | null> {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            logError(`Failed to fetch RSS feed from ${url}: ${response.statusText}`, null, { url, status: response.status, statusText: response.statusText });
            return null;
        }
        return await response.text();
    } catch (error) {
        logError(`Error fetching RSS feed from ${url}:`, error, { url });
        return null;
    }
}

function parseFeedWithFastXmlParser(xml: string, url: string): NewsArticle[] {
    const articles: NewsArticle[] = [];
    const options = {
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        cdataPropName: "__cdata", // CDATAセクションを自動的に処理
        allowBooleanAttributes: true,
        parseTagValue: true,
        parseAttributeValue: true,
        trimValues: true,
    };
    const parser = new XMLParser(options);
    const jsonObj = parser.parse(xml);

    if (jsonObj.rss && jsonObj.rss.channel && jsonObj.rss.channel.item) {
        // RSSフィード
        const items = Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item];
        for (const item of items) {
            if (item.title && item.link) {
                articles.push({
                    title: item.title.__cdata || item.title, // CDATAがあればそれを使用
                    link: item.link,
                    sourceName: '' // 後でcollectNewsで設定
                });
            }
        }
    } else if (jsonObj.feed && jsonObj.feed.entry) {
        // Atomフィード
        const entries = Array.isArray(jsonObj.feed.entry) ? jsonObj.feed.entry : [jsonObj.feed.entry];
        for (const entry of entries) {
            const title = entry.title ? (entry.title.__cdata || entry.title) : '';
            let link = '';
            if (entry.link) {
                if (Array.isArray(entry.link)) {
                    const alternateLink = entry.link.find((l: any) => l['@_rel'] === 'alternate' && l['@_href']);
                    if (alternateLink) {
                        link = alternateLink['@_href'];
                    }
                } else if (entry.link['@_rel'] === 'alternate' && entry.link['@_href']) {
                    link = entry.link['@_href'];
                } else if (entry.link['@_href']) { // Fallback for simple link
                    link = entry.link['@_href'];
                }
            }

            if (title && link) {
                articles.push({
                    title: title,
                    link: link,
                    sourceName: '' // 後でcollectNewsで設定
                });
            }
        }
    } else {
        logError('Unknown feed format or no items/entries found.', null, { url });
    }

    return articles;
}

export async function collectNews(): Promise<NewsArticle[]> {
    let allArticles: NewsArticle[] = [];

    for (const url of NEWS_RSS_URLS) {
        const xml = await fetchRSSFeed(url);
        if (xml) {
            // Determine source name from URL
            let sourceName = new URL(url).hostname;
            if (sourceName.startsWith('www.')) {
                sourceName = sourceName.substring(4);
            }
            // Special handling for Google News to extract actual source
            if (sourceName.includes('news.google.com')) {
                if (url.includes('reuters.com')) {
                    sourceName = 'Reuters';
                } else if (url.includes('bloomberg.co.jp')) {
                    sourceName = 'Bloomberg';
                } else {
                    sourceName = 'Google News'; // Fallback
                }
            } else if (sourceName.includes('zenn.dev')) {
                sourceName = 'Zenn';
            } else if (sourceName.includes('qiita.com')) {
                sourceName = 'Qiita';
            } else if (sourceName.includes('nhk.or.jp')) {
                sourceName = 'NHK';
            } else if (sourceName.includes('itmedia.co.jp')) {
                sourceName = 'ITmedia';
            } else if (sourceName.includes('impress.co.jp')) {
                if (url.includes('pcw')) {
                    sourceName = 'PC Watch';
                } else if (url.includes('dcw')) {
                    sourceName = 'デジカメ Watch';
                } else if (url.includes('avw')) {
                    sourceName = 'AV Watch';
                } else {
                    sourceName = 'Impress Watch'; // Generic fallback for Impress
                }
            } else if (sourceName.includes('gigazine.net')) {
                sourceName = 'GIGAZINE';
            } else if (sourceName.includes('gizmodo.jp')) {
                sourceName = 'GIZMODO JAPAN';
            } else if (sourceName.includes('gdm.or.jp')) {
                sourceName = 'エルミタージュ秋葉原';
            } else if (sourceName.includes('gazlog.jp')) {
                sourceName = 'ギャズログ';
            } else if (sourceName.includes('northwood.blog.fc2.com')) {
                sourceName = '北森瓦版';
            }


            const articles = parseFeedWithFastXmlParser(xml, url); // Use new parser
            const articlesWithSource = articles.map(article => ({
                ...article,
                sourceName: sourceName
            }));
            allArticles = allArticles.concat(articlesWithSource);
        }
    }

    // Add source name to title for articles, excluding Reuters and Bloomberg from Google News
    allArticles = allArticles.map(article => {
        if (article.sourceName === 'Reuters' || article.sourceName === 'Bloomberg') {
            return article; // Do not modify title for these sources
        }
        return {
            ...article,
            title: `${article.title} - ${article.sourceName}`
        };
    });

    logInfo(`Collected ${allArticles.length} articles from ${NEWS_RSS_URLS.length} sources.`, { articleCount: allArticles.length, sourceCount: NEWS_RSS_URLS.length });
    return allArticles;
}
