import { Logger } from './logger';
import { sendEmail as sendEmailWithGmail, GmailClientEnv } from './gmailClient';
import { Env } from './types/bindings';
import { getOgpImageUrl } from './utils/ogpScraper';
import { getRssImageUrl } from './utils/rssImageExtractor';
import { NEWS_RSS_URLS, NEWS_SOURCE_LOGOS } from './config';
import { NewsEmail, NewsArticleWithImage } from './components/NewsEmail';

interface EmailRecipient {
    email: string;
    name?: string;
}

export interface NewsArticle {
    articleId: string
    title: string;
    link: string;
    sourceName: string;
    summary?: string;
}

export async function generateNewsEmail(articles: NewsArticle[], userId: string, env: Env): Promise<string> {
    const logger = new Logger(env);
    logger.info(`Generating email content for user ${userId}`, { userId, articleCount: articles.length });

    const preparedArticles: NewsArticleWithImage[] = [];

    if (articles.length === 0) {
        logger.info(`No articles to include in email for user ${userId}.`, { userId });
    } else {
        for (const article of articles) {
            let imageUrl: string | undefined;

            // 1. まずOGP画像をスクレイピング
            // GIGAZINEはスクレイピングが許可されていないため、OGPスクレイピングをスキップ
            if (article.sourceName !== 'GIGAZINE') {
                try {
                    imageUrl = await getOgpImageUrl(article.link, env);
                } catch (e) {
                    logger.warn(`Failed to get OGP image for ${article.link}`, e);
                }
            } else {
                logger.info(`Skipping OGP scraping for GIGAZINE article due to policy: ${article.link}`, { url: article.link, sourceName: article.sourceName });
            }

            // 2. OGP画像が取得できなかった場合、RSSフィードから画像URLを抽出
            if (!imageUrl) {
                const rssFeedUrl = NEWS_RSS_URLS.find(url => article.link.startsWith(url.split('/rss')[0]) || article.link.startsWith(url.split('/feed')[0]) || article.link.startsWith(url.split('/data/rss')[0]));
                if (rssFeedUrl) {
                    try {
                        imageUrl = await getRssImageUrl(rssFeedUrl, article.link, env);
                    } catch (e) {
                        logger.warn(`Failed to get RSS image for ${article.link}`, e);
                    }
                }
            }

            // 3. どちらからも取得できなかった場合、ソースロゴまたは汎用デフォルト画像
            if (!imageUrl) {
                imageUrl = NEWS_SOURCE_LOGOS[article.sourceName] || NEWS_SOURCE_LOGOS['DEFAULT'];
                logger.info(`Using source logo or default image for article: ${imageUrl}`, { url: article.link, sourceName: article.sourceName, imageUrl });
            }

            const trackingLink = `${env.WORKER_BASE_URL}/track-click?userId=${userId}&articleId=${encodeURIComponent(article.articleId)}&redirectUrl=${encodeURIComponent(article.link)}`;

            preparedArticles.push({
                articleId: article.articleId,
                title: article.title,
                link: article.link,
                summary: article.summary,
                imageUrl,
                trackingLink
            });
        }
        logger.info(`Included ${articles.length} articles in email content for user ${userId}.`, { userId, articleCount: articles.length });
    }

    try {
        const element = <NewsEmail articles={preparedArticles} userId={userId} workerBaseUrl={env.WORKER_BASE_URL ?? ''} />;
        return '<!DOCTYPE html>' + element.toString();
    } catch (error) {
        logger.error(`Error generating email content for user ${userId}:`, error, { userId });
        // エラーが発生した場合、空のコンテンツまたはエラーメッセージを含むコンテンツを返す
        return `<p>ニュースメールコンテンツの生成中にエラーが発生しました。</p>`;
    }
}

export async function sendNewsEmail(
    env: GmailClientEnv,
    toEmail: string,
    userId: string,
    articles: NewsArticle[],
    sender: EmailRecipient
): Promise<Response> {
    const logger = new Logger(env);
    logger.info(`Attempting to send email to ${toEmail} from ${sender.email} for user ${userId} via Gmail API.`, { userId, email: toEmail, senderEmail: sender.email });
    const subject = 'あなたのパーソナライズドニュース';

    // Note: HTML generation now uses JSX but returns a string
    const htmlContent = await generateNewsEmail(articles, userId, env);

    const params = {
        to: toEmail, // Gmail APIではtoは単一のメールアドレス文字列
        subject: subject,
        htmlContent: htmlContent,
        from: sender.email, // Gmail APIではfromは認証に使用するGmailアドレス
    };

    try {
        // Pass userId and env to the Gmail sendEmail function
        const response = await sendEmailWithGmail(userId, params, env);
        if (response.ok) {
            logger.info(`Email successfully sent to ${toEmail} for user ${userId} via Gmail API.`, { userId, email: toEmail });
        } else {
            // Error details are logged in gmailClient.ts
            logger.error(`Failed to send email to ${toEmail} for user ${userId} via Gmail API: ${response.statusText}`, null, { userId, email: toEmail, status: response.status, statusText: response.statusText });
        }
        return response;
    } catch (error) {
        logger.error(`Exception when sending email to ${toEmail} for user ${userId} via Gmail API:`, error, { userId, email: toEmail });
        // エラーが発生した場合は、エラーを含む Response オブジェクトを生成して返す
        return new Response(`Error sending email: ${error}`, { status: 500 });
    }
}
