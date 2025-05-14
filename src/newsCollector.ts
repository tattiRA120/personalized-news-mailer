import { NEWS_RSS_URLS } from './config';
import { logError, logInfo } from './logger'; // Import logging helpers

interface NewsArticle {
    title: string;
    link: string;
    // pubDate?: string; // Optional: Add more fields as needed
    // content?: string;
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

function parseRSSFeed(xml: string): NewsArticle[] {
    const articles: NewsArticle[] = [];
    try {
        // Use regex for basic parsing as DOMParser is not available in Workers
        const itemRegex = /<item>.*?<\/item>/gs;
        const titleRegex = /<title>(.*?)<\/title>/s;
        const linkRegex = /<link>(.*?)<\/link>/s;

        let itemMatch;
        while ((itemMatch = itemRegex.exec(xml)) !== null) {
            const itemXml = itemMatch[0];
            const titleMatch = itemXml.match(titleRegex);
            const linkMatch = itemXml.match(linkRegex);

            if (titleMatch && linkMatch && titleMatch[1] && linkMatch[1]) {
                articles.push({
                    title: titleMatch[1].trim(),
                    link: linkMatch[1].trim()
                });
            }
        }
    } catch (error) {
        logError('Error parsing RSS feed with regex:', error);
    }
    return articles;
}

export async function collectNews(): Promise<NewsArticle[]> {
    let allArticles: NewsArticle[] = [];

    for (const url of NEWS_RSS_URLS) {
        const xml = await fetchRSSFeed(url);
        if (xml) {
            const articles = parseRSSFeed(xml);
            allArticles = allArticles.concat(articles);
        }
    }

    logInfo(`Collected ${allArticles.length} articles from ${NEWS_RSS_URLS.length} sources.`, { articleCount: allArticles.length, sourceCount: NEWS_RSS_URLS.length });
    return allArticles;
}
