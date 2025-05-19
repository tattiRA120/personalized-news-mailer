// src/emailGenerator.ts
import { logError, logInfo } from './logger'; // Import logging helpers

import { sendEmail as sendEmailWithBrevo } from './brevoClient';

interface EmailRecipient {
    email: string;
    name?: string;
}

interface NewsArticle {
    title: string;
    link: string;
    // Add other fields as needed
    summary?: string;
}

export function generateNewsEmail(articles: NewsArticle[], userId: string): string {
    logInfo(`Generating email content for user ${userId}`, { userId, articleCount: articles.length });
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
                body { font-family: sans-serif; line-height: 1.6; margin: 0; padding: 20px; }
                .container { max-width: 600px; margin: 0 auto; }
                h1 { color: #333; }
                .article { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #eee; }
                .article h2 { margin-top: 0; color: #007bff; }
                .article a { text-decoration: none; color: #007bff; }
                .article a:hover { text-decoration: underline; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Your Daily News Update</h1>
                <p>こんにちは！あなたのための最新ニュースをお届けします。</p>
    `;

    if (articles.length === 0) {
        htmlContent += `<p>No new articles found for you today.</p>`;
        logInfo(`No articles to include in email for user ${userId}.`, { userId });
    } else {
        articles.forEach(article => {
            // クリックトラッキング用の情報を記事リンクに追加
            const trackingLink = `${article.link}?userId=${userId}&articleId=${encodeURIComponent(article.link)}`;

            htmlContent += `
                <div class="article">
                    <h2><a href="${trackingLink}">${article.title}</a></h2>
                    <p>${article.summary || ''}</p>
                </div>
            `;
        });
        logInfo(`Included ${articles.length} articles in email content for user ${userId}.`, { userId, articleCount: articles.length });
    }

    htmlContent += `
                <p>このメールは自動送信されています。</p>
                <p><a href="#">配信停止はこちら</a> (現在はダミーリンクです)</p>
            </div>
        </body>
        </html>
    `;

    return htmlContent;
    } catch (error) {
        logError(`Error generating email content for user ${userId}:`, error, { userId });
        // エラーが発生した場合、空のコンテンツまたはエラーメッセージを含むコンテンツを返す
        return `<p>Error generating news email content.</p>`;
    }
}

// Brevo を使用してニュースメールを送信する
export async function sendNewsEmail(
  brevoApiKey: string,
  toEmail: string,
  userId: string,
  articles: NewsArticle[],
  sender: EmailRecipient // Add sender as an argument
): Promise<Response> {
  logInfo(`Attempting to send email to ${toEmail} from ${sender.email} for user ${userId}.`, { userId, email: toEmail, senderEmail: sender.email });
  const subject = 'あなたのパーソナライズドニュース';
  const htmlContent = generateNewsEmail(articles, userId);

  const params = {
    to: [{ email: toEmail }],
    subject: subject,
    htmlContent: htmlContent,
    sender: sender, // Add sender to params
    // Brevo の replyTo などの設定が必要であればここに追加
  };

  try {
      const response = await sendEmailWithBrevo(brevoApiKey, params);
      if (response.ok) {
          logInfo(`Email successfully sent to ${toEmail} for user ${userId}.`, { userId, email: toEmail });
      } else {
          // Error details are logged in brevoClient.ts, no need to read body again here
          logError(`Failed to send email to ${toEmail} for user ${userId}: ${response.statusText}`, null, { userId, email: toEmail, status: response.status, statusText: response.statusText });
      }
      return response;
  } catch (error) {
      logError(`Exception when sending email to ${toEmail} for user ${userId}:`, error, { userId, email: toEmail });
      // エラーが発生した場合は、エラーを含む Response オブジェクトを生成して返す
      return new Response(`Error sending email: ${error}`, { status: 500 });
  }
}

// TODO: Integrate a proper templating engine if needed
