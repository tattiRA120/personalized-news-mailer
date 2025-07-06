// Gmail API を使用してメールを送信するクライアント
import { logError, logInfo, logWarning } from './logger';

interface EmailRecipient {
    email: string;
    name?: string;
}

interface SendEmailParams {
  to: string; // Gmail APIではtoは単一のメールアドレスまたはカンマ区切り文字列
  subject: string;
  htmlContent: string;
  from: string; // 送信元メールアドレス (認証に使用するGmailアドレス)
}

interface Env {
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    GOOGLE_REDIRECT_URI: string;
    'mail-news-gmail-tokens': KVNamespace;
}

// リフレッシュトークンを使用して新しいアクセストークンを取得し、KVに保存する関数
async function refreshAndStoreAccessToken(userId: string, env: Env): Promise<string | null> {
    logInfo(`Attempting to refresh and store access token for user ${userId}.`, { userId });
    try {
        const refreshToken = await env['mail-news-gmail-tokens'].get(`refresh_token:${userId}`);

        if (!refreshToken) {
            logWarning(`Refresh token not found for user ${userId}.`, { userId });
            return null;
        }

        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: env.GOOGLE_CLIENT_ID,
                client_secret: env.GOOGLE_CLIENT_SECRET,
                refresh_token: refreshToken,
                grant_type: 'refresh_token',
            }).toString(),
        });

        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            if (errorText.includes('"error": "invalid_grant"')) {
                logError(`Failed to refresh access token for user ${userId}: Invalid Grant. Refresh token might be expired or revoked. User needs to re-authorize.`, null, { userId, status: tokenResponse.status, statusText: tokenResponse.statusText, errorText });
                await env['mail-news-gmail-tokens'].delete(`refresh_token:${userId}`);
            } else {
                logError(`Failed to refresh access token for user ${userId}: ${tokenResponse.statusText}`, null, { userId, status: tokenResponse.status, statusText: tokenResponse.statusText, errorText });
            }
            return null;
        }

        const tokenData: any = await tokenResponse.json();
        const newAccessToken = tokenData.access_token;
        const expiresIn = tokenData.expires_in; // 秒単位

        // アクセストークンと有効期限をKVストアに保存
        // 有効期限は現在時刻からの秒数で設定
        await env['mail-news-gmail-tokens'].put(`access_token:${userId}`, newAccessToken, { expirationTtl: expiresIn - 300 }); // 5分前には期限切れとみなす

        logInfo(`Successfully refreshed and stored access token for user ${userId}.`, { userId, expiresIn });
        return newAccessToken;

    } catch (error) {
        logError(`Exception when refreshing and storing access token for user ${userId}:`, error, { userId });
        return null;
    }
}

// アクセストークンを取得する関数 (KVから取得、またはリフレッシュ)
async function getAccessToken(userId: string, env: Env): Promise<string | null> {
    logInfo(`Attempting to get access token for user ${userId}.`, { userId });
    const accessToken = await env['mail-news-gmail-tokens'].get(`access_token:${userId}`);

    if (accessToken) {
        logInfo(`Found valid access token in KV for user ${userId}.`, { userId });
        return accessToken;
    }

    logInfo(`Access token not found or expired in KV for user ${userId}. Attempting to refresh.`, { userId });
    return await refreshAndStoreAccessToken(userId, env);
}

// Base64 エンコード関数 (UTF-8対応、パディングあり)
function base64Encode(str: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(str); // UTF-8 バイト列を取得

  const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  const bytes = new Uint8Array(data);
  const len = bytes.byteLength;
  while (i < len) {
    const byte1 = bytes[i++];
    const byte2 = bytes[i++];
    const byte3 = bytes[i++];

    const enc1 = byte1 >> 2;
    const enc2 = ((byte1 & 3) << 4) | (byte2 >> 4);
    let enc3 = ((byte2 & 15) << 2) | (byte3 >> 6);
    let enc4 = byte3 & 63;

    if (isNaN(byte2)) {
      enc3 = enc4 = 64;
    } else if (isNaN(byte3)) {
      enc4 = 64;
    }

    result += base64Chars[enc1] + base64Chars[enc2] + base64Chars[enc3] + base64Chars[enc4];
  }

  // パディングを追加
  if (len % 3 === 1) {
    result += '==';
  } else if (len % 3 === 2) {
    result += '=';
  }
  return result;
}

// Base64url エンコード関数 (UTF-8対応、パディングなし)
function base64urlEncode(str: string): string {
  const base64 = base64Encode(str); // まず Base64 エンコード
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); // Base64url 形式に変換
}


// Gmail API を使用してメールを送信する関数
export async function sendEmail(userId: string, params: SendEmailParams, env: Env): Promise<Response> {
  logInfo(`Attempting to send email for user ${userId} via Gmail API.`, { userId, emailParams: params });
  const GMAIL_API_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

  try {
    // アクセストークンを取得 (KVから、またはリフレッシュして取得)
    const accessToken = await getAccessToken(userId, env);

    if (!accessToken) {
        logError(`Failed to get or refresh access token for user ${userId}. Cannot send email.`, null, { userId });
        return new Response('Error sending email: Could not obtain access token', { status: 500 });
    }

    // 件名をMIMEエンコード (Base64)
    const subjectEncodedMime = `=?utf-8?B?${base64Encode(params.subject)}?=`;

    // HTML本文をBase64エンコード
    const htmlContentEncodedBase64 = base64Encode(params.htmlContent);

    // MIME形式のメール本文を作成
    const rawEmailContent = [
      `From: ${params.from}`,
      `To: ${params.to}`,
      `Subject: ${subjectEncodedMime}`, // 件名をMIMEエンコード
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64', // HTML本文はBase64エンコードされることを示す
      '',
      htmlContentEncodedBase64, // HTML本文をBase64エンコード
    ].join('\n');

    // MIME形式のメール本文全体を Base64url エンコード
    const base64UrlRawEmail = base64urlEncode(rawEmailContent);

    // Gmail API にメールを送信 (Message リソースとして raw フィールドに Base64url エンコードされた MIME メッセージを含める)
    const sendResponse = await fetch(GMAIL_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json', // リクエストボディは JSON
      },
      body: JSON.stringify({
          raw: base64UrlRawEmail // Base64url エンコードされた MIME メッセージ
      }),
    });

    if (!sendResponse.ok) {
      const errorText = await sendResponse.text();
      logError(`Gmail API returned an error for user ${userId}: ${sendResponse.statusText}`, null, { userId, status: sendResponse.status, statusText: sendResponse.statusText, errorText, emailParams: params });
    } else {
      logInfo(`Email sent successfully for user ${userId} via Gmail API.`, { userId, emailParams: params });
    }

    return sendResponse;

  } catch (error) {
    logError(`Exception when sending email for user ${userId} with Gmail API:`, error, { userId, emailParams: params });
    return new Response(`Error sending email: ${error}`, { status: 500 });
  }
}
