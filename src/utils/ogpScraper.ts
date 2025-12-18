import { Logger } from '../logger';
import { Env } from '../types/bindings';

export async function getOgpImageUrl(articleUrl: string, env: Env): Promise<string | undefined> {
    const logger = new Logger(env);
    try {
        // URLがHTTPの場合、HTTPSに変換を試みる
        let fetchUrl = articleUrl;
        if (fetchUrl.startsWith('http://')) {
            fetchUrl = fetchUrl.replace('http://', 'https://');
        }

        const response = await fetch(fetchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' // より一般的なUser-Agent
            }
        });

        if (!response.ok) {
            logger.error(`Failed to fetch article HTML from ${articleUrl}: ${response.statusText}`, null, { url: articleUrl, status: response.status });
            return undefined;
        }

        const html = await response.text();

        // 正規表現でog:imageメタタグを検索
        const ogImageRegex = /<meta\s+property="og:image"\s+content="([^"]+)"/i;
        const match = html.match(ogImageRegex);

        if (match && match[1]) {
            logger.info(`Found OGP image for ${articleUrl}: ${match[1]}`, { url: articleUrl, imageUrl: match[1] });
            return match[1];
        } else {
            logger.info(`No OGP image found for ${articleUrl}.`, { url: articleUrl });
            return undefined;
        }
    } catch (error) {
        logger.error(`Error fetching or parsing OGP image for ${articleUrl}:`, error, { url: articleUrl });
        return undefined;
    }
}
