// src/emailGenerator.ts
import { Logger } from './logger';

import { sendEmail as sendEmailWithGmail } from './gmailClient';
import { Env } from './index';

interface EmailRecipient {
    email: string;
    name?: string;
}

import { getOgpImageUrl } from './utils/ogpScraper';
import { getRssImageUrl } from './utils/rssImageExtractor';
import { NEWS_RSS_URLS, NEWS_SOURCE_LOGOS } from './config';

interface NewsArticle {
    articleId: string
    title: string;
    link: string;
    sourceName: string;
    summary?: string;
}

export async function generateNewsEmail(articles: NewsArticle[], userId: string, env: Env): Promise<string> {
    const logger = new Logger(env);
    logger.info(`Generating email content for user ${userId}`, { userId, articleCount: articles.length });
    let htmlContent = '';
    try {
        htmlContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Your Personalized News Update</title>
            <style>
                body { font-family: sans-serif; line-height: 1.6; margin: 0; padding: 20px; background-color: #f4f4f4; }
                .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
                h1 { color: #333; text-align: center; margin-bottom: 20px; }
                .article { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #eee; display: flex; align-items: flex-start; }
                .article:last-child { border-bottom: none; }
                .article-image { width: 120px; height: 120px; object-fit: contain; margin-right: 15px; border-radius: 4px; }
                .article-content { flex-grow: 1; }
                .article h2 { margin-top: 0; margin-bottom: 5px; color: #007bff; font-size: 1.2em; }
                .article a { text-decoration: none; color: #007bff; }
                .article a:hover { text-decoration: underline; }
                .article p { color: #555; font-size: 0.9em; margin-top: 5px; }
                .feedback-buttons { margin-top: 10px; }
                .feedback-buttons a { display: inline-block; padding: 5px 10px; margin-right: 10px; border-radius: 4px; text-decoration: none; color: #fff; font-size: 0.8em; }
                .btn-interested { background-color: #28a745; }
                .btn-not-interested { background-color: #dc3545; }
                .footer { text-align: center; margin-top: 30px; font-size: 0.8em; color: #777; }
                .footer a { color: #007bff; text-decoration: none; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Your Daily News Update</h1>
                <p>こんにちは！あなたのための最新ニュースをお届けします。</p>
    `;

    if (articles.length === 0) {
        htmlContent += `<p>本日の新しい記事は見つかりませんでした。</p>`;
        logger.info(`No articles to include in email for user ${userId}.`, { userId });
    } else {
        for (const article of articles) {
            let imageUrl: string | undefined;
            const finalArticleLink = article.link;

            // 1. まずOGP画像をスクレイピング
            // GIGAZINEはスクレイピングが許可されていないため、OGPスクレイピングをスキップ
            if (article.sourceName !== 'GIGAZINE') {
                imageUrl = await getOgpImageUrl(article.link, env);
            } else {
                logger.info(`Skipping OGP scraping for GIGAZINE article due to policy: ${article.link}`, { url: article.link, sourceName: article.sourceName });
            }

            // 2. OGP画像が取得できなかった場合、RSSフィードから画像URLを抽出
            if (!imageUrl) {
                const rssFeedUrl = NEWS_RSS_URLS.find(url => article.link.startsWith(url.split('/rss')[0]) || article.link.startsWith(url.split('/feed')[0]) || article.link.startsWith(url.split('/data/rss')[0]));
                if (rssFeedUrl) {
                    imageUrl = await getRssImageUrl(rssFeedUrl, article.link, env);
                }
            }

            // 3. どちらからも取得できなかった場合、ソースロゴまたは汎用デフォルト画像
            if (!imageUrl) {
                imageUrl = NEWS_SOURCE_LOGOS[article.sourceName] || NEWS_SOURCE_LOGOS['DEFAULT'];
                logger.info(`Using source logo or default image for article: ${imageUrl}`, { url: article.link, sourceName: article.sourceName, imageUrl });
            }
            const trackingLink = `${env.WORKER_BASE_URL}/track-click?userId=${userId}&articleId=${encodeURIComponent(article.articleId)}&redirectUrl=${encodeURIComponent(article.link)}`;

            htmlContent += `
                <div class="article">
                    <img src="${imageUrl}" alt="Article Image" class="article-image">
                    <div class="article-content">
                        <h2><a href="${trackingLink}">${article.title}</a></h2>
                        <p>${article.summary || ''}</p>
                        <div class="feedback-buttons">
                            <a href="${env.WORKER_BASE_URL}/track-feedback?userId=${userId}&articleId=${encodeURIComponent(article.articleId)}&feedback=interested" class="btn-interested">興味がある</a>
                            <a href="${env.WORKER_BASE_URL}/track-feedback?userId=${userId}&articleId=${encodeURIComponent(article.articleId)}&feedback=not_interested" class="btn-not-interested">興味がない</a>
                        </div>
                    </div>
                </div>
            `;
        }
        logger.info(`Included ${articles.length} articles in email content for user ${userId}.`, { userId, articleCount: articles.length });
    }

    return htmlContent;
    } catch (error) {
        logger.error(`Error generating email content for user ${userId}:`, error, { userId });
        // エラーが発生した場合、空のコンテンツまたはエラーメッセージを含むコンテンツを返す
        return `<p>ニュースメールコンテンツの生成中にエラーが発生しました。</p>`;
    }
}

// Gmail API を使用してニュースメールを送信する
import { GmailClientEnv } from './gmailClient';

export async function sendNewsEmail(
  env: GmailClientEnv,
  toEmail: string,
  userId: string,
  articles: NewsArticle[],
  sender: EmailRecipient // Add sender as an argument
): Promise<Response> {
  const logger = new Logger(env);
  logger.info(`Attempting to send email to ${toEmail} from ${sender.email} for user ${userId} via Gmail API.`, { userId, email: toEmail, senderEmail: sender.email });
  const subject = 'あなたのパーソナライズドニュース';
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
