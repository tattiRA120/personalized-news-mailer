import { initLogger } from '../logger';
import { Env } from '../index';

interface DecodingParams {
    status: boolean;
    signature?: string;
    timestamp?: string;
    base64_str?: string;
    message?: string;
}

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
            ["articles", "read", "rss"].includes(path[path.length - 2]) // 'rss' も追加
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

// Google News からデコードに必要な signature と timestamp を取得する。
async function getDecodingParams(base64_str: string, env: Env): Promise<DecodingParams> {
    const { logError, logInfo, logWarning } = initLogger(env);
    const urlsToTry = [
        `https://news.google.com/articles/${base64_str}`,
        `https://news.google.com/rss/articles/${base64_str}`
    ];

    for (const url of urlsToTry) {
        try {
            logInfo(`getDecodingParams: URL を試行: ${url}`);
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP status code not 200: ${response.status} ${response.statusText}`);
            }

            const text = await response.text();
            logInfo(`getDecodingParams: ${url} からのレスポンス取得成功`);

            const signatureMatch = text.match(/data-n-a-sg="([^"]+)"/);
            const timestampMatch = text.match(/data-n-a-ts="([^"]+)"/);

            if (signatureMatch && timestampMatch) {
                const signature = signatureMatch[1];
                const timestamp = timestampMatch[1];
                logInfo(`getDecodingParams: 取得した signature: ${signature}, timestamp: ${timestamp}`);
                return {
                    status: true,
                    signature: signature,
                    timestamp: timestamp,
                    base64_str: base64_str,
                };
            } else {
                logInfo(`getDecodingParams: ${url} からデータ属性を抽出できませんでした。`);
            }
        } catch (e: any) {
            logWarning(`getDecodingParams: ${url} でエラーが発生: ${e.message}`);
        }
    }

    const message = "Failed to extract data attributes from Google News with both articles and RSS URLs.";
    logError(message);
    return { status: false, message: message };
}

// signature と timestamp を用いて、Google News の URL をデコードする。
async function decodeUrl(signature: string, timestamp: string, base64_str: string, env: Env): Promise<DecodedUrlResult> {
    const { logError, logInfo } = initLogger(env);
    try {
        logInfo(`decodeUrl: 処理開始。signature: ${signature}, timestamp: ${timestamp}, base64_str: ${base64_str}`);
        const url = "https://news.google.com/_/DotsSplashUi/data/batchexecute";

        const payload = [
            "Fbv4je",
            `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${base64_str}",${timestamp},"${signature}"]`,
        ];

        const headers = {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        };

        const data = `f.req=${encodeURIComponent(JSON.stringify([[payload]]))}`;
        logInfo(`decodeUrl: POST するデータ: ${data.substring(0, 200)}...`); // Log first 200 chars

        const response = await fetch(url, {
            method: "POST",
            headers: headers,
            body: data,
        });

        if (!response.ok) {
            throw new Error(`HTTP status code not 200: ${response.status} ${response.statusText}`);
        }

        logInfo("decodeUrl: POST リクエスト成功");

        const responseText = await response.text();
        const splitted = responseText.split("\n\n");
        logInfo(`decodeUrl: レスポンステキストの先頭部分: ${splitted[0].substring(0, 200)}...`);

        // Pythonのjson.loads(splitted[1])[:-2]に相当する処理
        // splitted[1]は文字列なので、まずJSONとしてパースし、最後の2要素を削除
        const parsedData = JSON.parse(splitted[1]);
        const trimmedParsedData = parsedData.slice(0, parsedData.length - 2);

        // Pythonのjson.loads(parsed_data[0][2])[1]に相当する処理
        // trimmedParsedData[0][2]は文字列なので、再度JSONとしてパースし、その2番目の要素を取得
        const decodedUrl = JSON.parse(trimmedParsedData[0][2])[1];
        logInfo(`decodeUrl: デコードされた URL: ${decodedUrl}`);

        return { status: true, decoded_url: decodedUrl };
    } catch (e: any) {
        logError(`Error in decodeUrl: ${e.message}`, e);
        return { status: false, message: `Error in decodeUrl: ${e.message}` };
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

    const decodingParamsResponse = await getDecodingParams(base64Response.base64_str!, env);
    if (!decodingParamsResponse.status || !decodingParamsResponse.signature || !decodingParamsResponse.timestamp) {
        logError(`decodeGoogleNewsUrl: getDecodingParams でエラー: ${decodingParamsResponse.message}`);
        return decodingParamsResponse;
    }

    const decodedUrlResponse = await decodeUrl(
        decodingParamsResponse.signature,
        decodingParamsResponse.timestamp,
        decodingParamsResponse.base64_str!,
        env
    );

    logInfo(`decodeGoogleNewsUrl: デコード結果: ${JSON.stringify(decodedUrlResponse)}`);
    return decodedUrlResponse;
}
