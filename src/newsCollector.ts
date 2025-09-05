import { NEWS_RSS_URLS } from './config';
import { initLogger } from './logger';
import { XMLParser } from 'fast-xml-parser';
import { cleanArticleText, generateContentHash } from './utils/textProcessor';
import { decodeHtmlEntities } from './utils/htmlDecoder';
import { Env } from './index';

// 一般的なUser-Agentのリスト
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/99.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15',
    'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Mobile Safari/537.36',
];

// ランダムなUser-Agentを返すヘルパー関数
function getRandomUserAgent(): string {
    const randomIndex = Math.floor(Math.random() * USER_AGENTS.length);
    return USER_AGENTS[randomIndex];
}

// HTMLタグを除去するヘルパー関数
function stripHtmlTags(html: string): string {
    let strippedText = html.replace(/<[^>]*>/g, ''); // すべてのHTMLタグを除去
    strippedText = strippedText.replace(/&nbsp;/g, ' '); // &nbsp;をスペースに置換
    strippedText = strippedText.replace(/\s+/g, ' ').trim(); // 複数の空白を1つにまとめる
    return strippedText;
}

export interface NewsArticle {
    articleId: string; // Add articleId as ContentHash
    title: string;
    link: string;
    sourceName: string;
    summary?: string; // Add summary field
    content: string; // Add content field
    publishedAt: number; // Add publishedAt as Unix timestamp
}

async function fetchRSSFeed(url: string, env: Env): Promise<string | null> {
    const { logError } = initLogger(env);
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': getRandomUserAgent(), // ランダムなUser-Agentを使用
            },
        });
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

async function parseFeedWithFastXmlParser(xml: string, url: string, env: Env): Promise<NewsArticle[]> {
    const { logError, logInfo } = initLogger(env);
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

    // RSS 2.0 / 0.92 / 0.91
    if ((jsonObj as any).rss && (jsonObj as any).rss.channel) {
        const rssChannel = (jsonObj as any).rss.channel;
        const items = Array.isArray(rssChannel.item) ? rssChannel.item : (rssChannel.item ? [rssChannel.item] : []);
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.title && item.link) {
                let rawSummary = item.description?.__cdata || item.description || '';
                let rawContent = item['content:encoded']?.__cdata || item['content:encoded'] || rawSummary; // content:encodedを優先、なければdescription
                const pubDate = item.pubDate || new Date().toUTCString(); // Fallback to current date
                const title = decodeHtmlEntities(stripHtmlTags((item.title as any).__cdata || item.title));

                let finalSummary = decodeHtmlEntities(stripHtmlTags(String(rawSummary).trim()));
                let finalContent = decodeHtmlEntities(stripHtmlTags(String(rawContent).trim()));

                // summaryとcontentの重複・包含関係を調整
                if (finalContent === finalSummary) {
                    // 両方が完全に同じ場合はcontentを優先し、summaryはcontentの冒頭から生成
                    finalSummary = finalContent.substring(0, Math.min(finalContent.length, 200)); // 例: 冒頭200文字
                } else if (finalContent.startsWith(finalSummary) && finalContent.length > finalSummary.length) {
                    // contentがsummaryを含んでいる場合、summaryはそのまま、contentはそのまま
                    // summaryがcontentの冒頭部分と一致する場合、summaryはそのまま
                } else if (!finalSummary && finalContent) {
                    // summaryがないがcontentがある場合、contentの冒頭からsummaryを生成
                    finalSummary = finalContent.substring(0, Math.min(finalContent.length, 200));
                } else if (!finalContent && finalSummary) {
                    // contentがないがsummaryがある場合、summaryをcontentとして扱う
                    finalContent = finalSummary;
                }

                const articleLink = item.link;
                articles.push({
                    articleId: await generateContentHash(title),
                    title: title,
                    link: articleLink,
                    sourceName: '',
                    summary: finalSummary,
                    content: finalContent,
                    publishedAt: Date.parse(pubDate),
                });
            }
        }
    }
    // Atom 1.0
    else if ((jsonObj as any).feed && (jsonObj as any).feed.entry) {
        const atomFeed = (jsonObj as any).feed;
        const entries = Array.isArray(atomFeed.entry) ? atomFeed.entry : (atomFeed.entry ? [atomFeed.entry] : []);
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const title = entry.title ? ((entry.title as any).__cdata || entry.title) : '';
            let link = '';
            if (entry.link) {
                if (Array.isArray(entry.link)) {
                    const alternateLink = entry.link.find((l: any) => l['@_rel'] === 'alternate' && l['@_href']);
                    if (alternateLink) {
                        link = alternateLink['@_href'];
                    }
                } else if ((entry.link as any)['@_rel'] === 'alternate' && (entry.link as any)['@_href']) {
                    link = (entry.link as any)['@_href'];
                } else if ((entry.link as any)['@_href']) {
                    link = (entry.link as any)['@_href'];
                }
            }
            let rawSummary = entry.summary?.__cdata || entry.summary || '';
            let rawContent = entry.content?.__cdata || entry.content || rawSummary; // contentを優先、なければsummary
            const pubDate = entry.updated || entry.published || new Date().toUTCString(); // Fallback to current date

            if (title && link) {
                const cleanedTitle = decodeHtmlEntities(stripHtmlTags(title));
                let finalSummary = decodeHtmlEntities(stripHtmlTags(String(rawSummary).trim()));
                let finalContent = decodeHtmlEntities(stripHtmlTags(String(rawContent).trim()));

                // summaryとcontentの重複・包含関係を調整
                if (finalContent === finalSummary) {
                    finalSummary = finalContent.substring(0, Math.min(finalContent.length, 200));
                } else if (finalContent.startsWith(finalSummary) && finalContent.length > finalSummary.length) {
                    // contentがsummaryを含んでいる場合、summaryはそのまま
                } else if (!finalSummary && finalContent) {
                    finalSummary = finalContent.substring(0, Math.min(finalContent.length, 200));
                } else if (!finalContent && finalSummary) {
                    finalContent = finalSummary;
                }

                const articleLink = link;
                articles.push({
                    articleId: await generateContentHash(cleanedTitle),
                    title: cleanedTitle,
                    link: articleLink,
                    sourceName: '',
                    summary: finalSummary,
                    content: finalContent,
                    publishedAt: Date.parse(pubDate),
                });
            }
        }
    }
    // RSS 1.0 (RDF)
    else if ((jsonObj as any)['rdf:RDF'] && (jsonObj as any)['rdf:RDF'].item) {
        const rdfFeed = (jsonObj as any)['rdf:RDF'];
        const items = Array.isArray(rdfFeed.item) ? rdfFeed.item : (rdfFeed.item ? [rdfFeed.item] : []);
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const title = (item['dc:title'] as any)?.__cdata || item['dc:title'] || (item.title as any)?.__cdata || item.title;
            const link = item['link'] || item['@_rdf:about']; // linkまたはrdf:aboutを使用
            let rawSummary = item.description?.__cdata || item.description || '';
            let rawContent = item['content:encoded']?.__cdata || item['content:encoded'] || rawSummary; // content:encodedを優先、なければdescription
            const pubDate = item['dc:date'] || item.date || new Date().toUTCString(); // Fallback to current date

            if (title && link) {
                const cleanedTitle = decodeHtmlEntities(stripHtmlTags(title));
                let finalSummary = decodeHtmlEntities(stripHtmlTags(String(rawSummary).trim()));
                let finalContent = decodeHtmlEntities(stripHtmlTags(String(rawContent).trim()));

                // summaryとcontentの重複・包含関係を調整
                if (finalContent === finalSummary) {
                    finalSummary = finalContent.substring(0, Math.min(finalContent.length, 200));
                } else if (finalContent.startsWith(finalSummary) && finalContent.length > finalSummary.length) {
                    // contentがsummaryを含んでいる場合、summaryはそのまま
                } else if (!finalSummary && finalContent) {
                    finalSummary = finalContent.substring(0, Math.min(finalContent.length, 200));
                } else if (!finalContent && finalSummary) {
                    finalContent = finalSummary;
                }

                const articleLink = link;
                articles.push({
                    articleId: await generateContentHash(cleanedTitle),
                    title: cleanedTitle,
                    link: articleLink,
                    sourceName: '',
                    summary: finalSummary,
                    content: finalContent,
                    publishedAt: Date.parse(pubDate),
                });
            }
        }
    }
    else {
        logError('Unknown feed format or no items/entries found.', null, { url });
    }

    return articles;
}

export async function collectNews(env: Env): Promise<NewsArticle[]> {
    const { logError, logInfo } = initLogger(env);
    let allArticles: NewsArticle[] = [];

    for (const url of NEWS_RSS_URLS) {
        const xml = await fetchRSSFeed(url, env);
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
                } else {
                    sourceName = 'Google News'; // Fallback
                }
            } else if (sourceName.includes('assets.wor.jp') && url.includes('bloomberg')) {
                sourceName = 'Bloomberg';
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
            } else if (sourceName.includes('phileweb.com')) {
                sourceName = 'PHILE WEB';
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


            const articles = await parseFeedWithFastXmlParser(xml, url, env); // Use new parser and await it, pass env
            const articlesWithSource = articles.map(article => ({
                ...article,
                sourceName: sourceName
            }));
            allArticles = allArticles.concat(articlesWithSource);
        }
    }

    // Apply text cleaning to title and summary for all articles
    allArticles = allArticles.map(article => ({
        ...article,
        title: cleanArticleText(article.title),
        summary: article.summary ? cleanArticleText(article.summary) : undefined,
    }));

    logInfo(`Collected ${allArticles.length} articles from ${NEWS_RSS_URLS.length} sources.`, { articleCount: allArticles.length, sourceCount: NEWS_RSS_URLS.length });
    return allArticles;
}
