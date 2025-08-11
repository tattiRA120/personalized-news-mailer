import { initLogger } from '../logger';
import { Env } from '../index';

interface DecodedUrlResult {
    status: boolean;
    decoded_url?: string;
    message?: string;
}

// Google News の URL から Base64 文字列を抽出する。
function getBase64Str(sourceUrl: string): { status: boolean; base64_str?: string; message?: string } {
    try {
        const url = new URL(sourceUrl);
        const path = url.pathname.split("/");

        if (
            url.hostname === "news.google.com" &&
            path.length > 1 &&
            ["articles", "read", "rss"].includes(path[path.length - 2])
        ) {
            const base64_str = path[path.length - 1];
            return { status: true, base64_str: base64_str };
        }
        const message = "Invalid Google News URL format.";
        return { status: false, message: message };
    } catch (e: any) {
        return { status: false, message: `Error in getBase64Str: ${e.message}` };
    }
}

export async function decodeGoogleNewsUrl(sourceUrl: string, env: Env): Promise<DecodedUrlResult> {
    const { logError, logInfo } = initLogger(env);
    logInfo(`decodeGoogleNewsUrl: 処理開始。source_url: ${sourceUrl}`);

    const base64Response = getBase64Str(sourceUrl);
    if (!base64Response.status || !base64Response.base64_str) {
        logError(`decodeGoogleNewsUrl: getBase64Str でエラー: ${base64Response.message}`);
        return base64Response;
    }

    // Oracle Cloud上のデコードサービスを呼び出す
    const decoderApiUrl = env.GOOGLE_NEWS_DECODER_API_URL;
    if (!decoderApiUrl) {
        const message = "GOOGLE_NEWS_DECODER_API_URL is not set in environment variables.";
        logError(message);
        return { status: false, message: message };
    }

    try {
        logInfo(`decodeGoogleNewsUrl: デコードサービスを呼び出し中: ${decoderApiUrl}`);
        const response = await fetch(decoderApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ source_url: sourceUrl }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`デコードサービスからのHTTPエラー: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const result: DecodedUrlResult = await response.json();
        logInfo(`decodeGoogleNewsUrl: デコードサービスからの結果: ${JSON.stringify(result)}`);

        if (!result.status || !result.decoded_url) {
            logError(`decodeGoogleNewsUrl: デコードサービスからのエラー: ${result.message}`);
            return { status: false, message: result.message || "Unknown error from decoder service." };
        }

        return { status: true, decoded_url: result.decoded_url };

    } catch (e: any) {
        logError(`decodeGoogleNewsUrl: デコードサービス呼び出し中にエラーが発生: ${e.message}`, e);
        return { status: false, message: `デコードサービス呼び出し中にエラーが発生: ${e.message}` };
    }
}
