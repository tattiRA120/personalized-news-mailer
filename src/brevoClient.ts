// Brevo (Sendinblue) API を使用してメールを送信するクライアント
import { logError } from './logger'; // Import logging helpers

interface SendEmailParams {
  to: { email: string; name?: string }[];
  subject: string;
  htmlContent: string;
  sender?: { email: string; name?: string };
  replyTo?: { email: string; name?: string };
  headers?: { [key: string]: string };
  params?: { [key: string]: any };
}

export async function sendEmail(apiKey: string, params: SendEmailParams): Promise<Response> {
  const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

  const headers = {
    'Content-Type': 'application/json',
    'api-key': apiKey,
  };

  const body = JSON.stringify(params);

  try {
    const response = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: headers,
      body: body,
    });

    if (!response.ok) {
        const errorText = await response.text();
        logError(`Brevo API returned an error: ${response.statusText}`, null, { status: response.status, statusText: response.statusText, errorText, emailParams: params });
    } else {
        // 成功時もログを残す場合は logInfo を使用
        // logInfo('Email sent successfully via Brevo.', { emailParams: params });
    }


    // Brevo API の応答をそのまま返す
    return response;

  } catch (error) {
    logError('Exception when sending email with Brevo:', error, { emailParams: params });
    // エラーが発生した場合は、エラーを含む Response オブジェクトを生成して返す
    return new Response(`Error sending email: ${error}`, { status: 500 });
  }
}
