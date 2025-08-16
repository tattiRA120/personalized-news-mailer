import { initLogger } from '../logger';
import { Env } from '../index';

interface DecodedUrlResult {
    status: boolean;
    decoded_url?: string;
    message?: string;
    source_url?: string;
}

export async function decodeGoogleNewsUrl(sourceUrls: string[], env: Env): Promise<DecodedUrlResult[]> {
    const { logError, logInfo } = initLogger(env);
    logInfo(`decodeGoogleNewsUrl: 処理開始。source_urls: ${JSON.stringify(sourceUrls)}`);

    // Oracle Cloud上のデコードサービスを呼び出す
    const decoderApiUrl = env.GOOGLE_NEWS_DECODER_API_URL;
    if (!decoderApiUrl) {
        const message = "GOOGLE_NEWS_DECODER_API_URL is not set in environment variables.";
        logError(message);
        // サービスが利用できない場合は、全てのURLに対してエラーを返す
        return sourceUrls.map(url => ({ status: false, message: message, source_url: url }));
    }

    try {
        logInfo(`decodeGoogleNewsUrl: デコードサービスを呼び出し中: ${decoderApiUrl}`);
        const response = await fetch(decoderApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ source_urls: sourceUrls }), // source_urls を送信
        });

        if (!response.ok) {
            const errorText = await response.text();
            const errorMessage = `デコードサービスからのHTTPエラー: ${response.status} ${response.statusText} - ${errorText}`;
            logError(`decodeGoogleNewsUrl: ${errorMessage}`);
            // サービスからのHTTPエラーの場合は、全てのURLに対してエラーを返す
            return sourceUrls.map(url => ({ status: false, message: errorMessage, source_url: url }));
        }

        const results: DecodedUrlResult[] = await response.json(); // 結果はリストで返される
        logInfo(`decodeGoogleNewsUrl: デコードサービスからの結果: ${JSON.stringify(results)}`);

        // 各結果をチェックし、必要に応じてエラーメッセージを追加
        const processedResults = results.map(result => {
            if (!result.status || !result.decoded_url) {
                logError(`decodeGoogleNewsUrl: デコードサービスからのエラー: ${result.message || "Unknown error."} for URL: ${result.source_url}`);
                return { status: false, message: result.message || "Unknown error from decoder service.", source_url: result.source_url };
            }
            return result;
        });

        return processedResults;

    } catch (e: any) {
        const errorMessage = `デコードサービス呼び出し中にエラーが発生: ${e.message}`;
        logError(`decodeGoogleNewsUrl: ${errorMessage}`, e);
        // サービス呼び出し中に例外が発生した場合は、全てのURLに対してエラーを返す
        return sourceUrls.map(url => ({ status: false, message: errorMessage, source_url: url }));
    }
}
