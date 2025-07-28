import { initLogger } from '../logger';
import { Env } from '../index';

export async function getOgpImageUrl(articleUrl: string, env: Env): Promise<string | undefined> {
    const { logError, logInfo } = initLogger(env);
    try {
        const response = await fetch(articleUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' // OGP取得のためのUser-Agent
            }
        });

        if (!response.ok) {
            logError(`Failed to fetch article HTML from ${articleUrl}: ${response.statusText}`, null, { url: articleUrl, status: response.status });
            return undefined;
        }

        const html = await response.text();

        // 正規表現でog:imageメタタグを検索
        const ogImageRegex = /<meta\s+property="og:image"\s+content="([^"]+)"/i;
        const match = html.match(ogImageRegex);

        if (match && match[1]) {
            logInfo(`Found OGP image for ${articleUrl}: ${match[1]}`, { url: articleUrl, imageUrl: match[1] });
            return match[1];
        } else {
            logInfo(`No OGP image found for ${articleUrl}.`, { url: articleUrl });
            return undefined;
        }
    } catch (error) {
        logError(`Error fetching or parsing OGP image for ${articleUrl}:`, error, { url: articleUrl });
        return undefined;
    }
}
