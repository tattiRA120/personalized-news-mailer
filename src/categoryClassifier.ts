// src/categoryClassifier.ts

import { ARTICLE_CATEGORIES } from './config';
import { logInfo, logWarning } from './logger';
import { Env } from '.'; // Env 型をインポート
import { getCategoryKeywords, EnvWithKeywordsKV } from './keywordManager'; // getCategoryKeywords と EnvWithKeywordsKV をインポート

interface NewsArticle {
    title: string;
    link: string;
    summary?: string; // Add summary field
    // Add other fields as needed
    category?: string; // Add category field
    llmResponse?: string; // Add field to store LLM response for debugging
}

/**
 * 記事のタイトルとキーワードに基づいてカテゴリーを分類する（ハイブリッドアプローチ）
 * @param article 分類する記事オブジェクト
 * @param env Workers AI バインディングを含む環境変数
 * @returns カテゴリー情報が付与された記事オブジェクト
 */
export async function classifyArticle(article: NewsArticle, env: Env): Promise<NewsArticle> {
    const title = article.title.toLowerCase(); // タイトルを小文字に変換してマッチング
    const summary = article.summary ? article.summary.toLowerCase() : ''; // サマリーを小文字に変換してマッチング (存在する場合)

    // --- ルールベースの分類 (Rule-based Classification) ---
    // 特定のキーワードがタイトルに含まれる場合に強制的に分類
    if (title.includes('速報') || title.includes('緊急')) {
        // より詳細な分類が必要な場合は、ここでさらにロジックを追加
        // 例: summaryに「国際」関連のキーワードがあれば「国際」、なければ「国内」
        if (summary.includes('国際') || summary.includes('海外')) {
            logInfo(`Article "${article.title}" classified by rule as '国際' (breaking news).`, { articleTitle: article.title, category: '国際' });
            return { ...article, category: '国際' };
        } else {
            logInfo(`Article "${article.title}" classified by rule as '国内' (breaking news).`, { articleTitle: article.title, category: '国内' });
            return { ...article, category: '国内' };
        }
    }
    if (title.includes('株価') || title.includes('為替') || title.includes('日銀') || title.includes('決算')) {
        logInfo(`Article "${article.title}" classified by rule as '経済'.`, { articleTitle: article.title, category: '経済' });
        return { ...article, category: '経済' };
    }
    if (title.includes('ai') || title.includes('人工知能') || title.includes('chatgpt') || title.includes('メタバース') || title.includes('web3')) {
        logInfo(`Article "${article.title}" classified by rule as 'テクノロジー'.`, { articleTitle: article.title, category: 'テクノロジー' });
        return { ...article, category: 'テクノロジー' };
    }
    if (title.includes('選挙') || title.includes('国会') || title.includes('首相') || title.includes('政党')) {
        logInfo(`Article "${article.title}" classified by rule as '政治'.`, { articleTitle: article.title, category: '政治' });
        return { ...article, category: '政治' };
    }
    if (title.includes('オリンピック') || title.includes('W杯') || title.includes('プロ野球') || title.includes('Jリーグ')) {
        logInfo(`Article "${article.title}" classified by rule as 'スポーツ'.`, { articleTitle: article.title, category: 'スポーツ' });
        return { ...article, category: 'スポーツ' };
    }
    // 他の強力なルールをここに追加

    // --- キーワードマッチング (Keyword Matching) ---
    let bestMatchCategory: string = 'その他';
    let maxMatchCount: number = 0;
    const matchedCategories: string[] = [];

    const categoryKeywords = await getCategoryKeywords(env as EnvWithKeywordsKV); // KVからキーワード辞書を取得

    for (const category of ARTICLE_CATEGORIES) {
        if (category === 'その他') continue; // 'その他' カテゴリーはキーワードマッチングの対象外

        const keywords = categoryKeywords[category]; // KVから取得したキーワード辞書を使用
        if (!keywords) continue;

        let currentMatchCount = 0;
        for (const keyword of keywords) {
            const lowerKeyword = keyword.toLowerCase();
            // キーワードがタイトルまたはサマリーに含まれているか判定
            if (title.includes(lowerKeyword) || summary.includes(lowerKeyword)) {
                currentMatchCount++;
            }
        }

        // より多くのキーワードにマッチしたカテゴリーを優先
        if (currentMatchCount > maxMatchCount) {
            maxMatchCount = currentMatchCount;
            bestMatchCategory = category;
            matchedCategories.length = 0; // リセット
            matchedCategories.push(category);
        } else if (currentMatchCount > 0 && currentMatchCount === maxMatchCount) {
             // 同じ数のキーワードにマッチした場合
             matchedCategories.push(category);
        }
    }

    // マッチするキーワードが閾値（例: 1）以下の場合、または複数のカテゴリーにマッチした場合にLLMを使用
    // TODO: 閾値はconfig等で設定可能にする
    const keywordMatchThreshold = 1;
    if (maxMatchCount <= keywordMatchThreshold || matchedCategories.length > 1) {
        logInfo(`Article "${article.title}" requires LLM classification (keyword match count: ${maxMatchCount}, matched categories: ${matchedCategories.join(', ')}).`, { articleTitle: article.title });

        // TODO: LLMの利用回数を制限するロジックを追加

        try {
            // Cloudflare Workers AI を使用してカテゴリーを判定
            const prompt = `以下の記事タイトルを、指定されたカテゴリーの中から最も適切なものに分類してください。カテゴリーは一つだけ選んでください。\n\nカテゴリーリスト:\n${ARTICLE_CATEGORIES.filter(cat => cat !== 'その他').map(cat => `- ${cat}`).join('\n')}\n\n記事タイトル: ${article.title}\n\n**重要:** 回答は必ず上記のカテゴリーリストの中から、日本語のカテゴリー名のみを返してください。**他のテキスト、説明、番号、記号、句読点、または記事タイトルの一部を一切含めないでください。**`;

            const response = await env.AI.run(
                '@cf/meta/llama-3.2-1b-instruct', // 選択したモデル
                { prompt: prompt }
            );

            // LLMの応答からカテゴリー名を抽出するロジック
            // Cloudflare Workers AIのテキスト生成モデルの応答は 'response' プロパティに含まれる
            // 型定義との不一致を解消するため、any 型にキャスト
            const llmResponseText = (response as any).response.trim();
            // LLMの応答から不要な文字をさらに厳密に取り除く
            article.llmResponse = llmResponseText; // LLMの応答を保存（デバッグ用）

            let matchedLlmCategory: string | null = null;
            let maxMatchLength = 0;

            // LLMの応答がARTICLE_CATEGORIESのいずれかのカテゴリ名と部分的に一致するかを確認
            for (const category of ARTICLE_CATEGORIES) {
                // LLMの応答がカテゴリ名を完全に含む場合を優先
                if (llmResponseText === category) {
                    matchedLlmCategory = category;
                    break;
                }
                // 部分一致の場合（例: LLMが「政治に関するニュース」と返した場合に「政治」を抽出）
                if (llmResponseText.includes(category) && category.length > maxMatchLength) {
                    matchedLlmCategory = category;
                    maxMatchLength = category.length;
                }
            }

            if (matchedLlmCategory) {
                bestMatchCategory = matchedLlmCategory; // LLMの分類結果を優先
                logInfo(`Article "${article.title}" classified by LLM as '${bestMatchCategory}'.`, { articleTitle: article.title, category: bestMatchCategory });
            } else {
                logWarning(`LLM returned an invalid category "${llmResponseText}" for article "${article.title}". Falling back to keyword match or 'その他'.`, { articleTitle: article.title, llmCategory: llmResponseText });
                // LLMが無効なカテゴリーを返した場合のフォールバック
                if (maxMatchCount > 0) {
                    // キーワードマッチがあった場合は、最もマッチしたカテゴリーを使用
                    bestMatchCategory = matchedCategories[0]; // 最初のマッチカテゴリーを使用（改善の余地あり）
                    logInfo(`Falling back to keyword match category '${bestMatchCategory}'.`, { articleTitle: article.title, category: bestMatchCategory });
                } else {
                    // キーワードマッチがない場合は 'その他'
                    bestMatchCategory = 'その他';
                    logInfo(`Falling back to 'その他' category.`, { articleTitle: article.title });
                }
            }

        } catch (error: any) { // エラー型をanyにキャストして簡易的に対応
            logWarning(`Error during LLM classification for article "${article.title}": ${error}`, { articleTitle: article.title, error: error });
            article.llmResponse = `Error: ${error.message || String(error)}`; // エラー情報を保存 (String(error)でunknown型にも対応)
            // LLM呼び出しでエラーが発生した場合のフォールバック
            if (maxMatchCount > 0) {
                // キーワードマッチがあった場合は、最もマッチしたカテゴリーを使用
                bestMatchCategory = matchedCategories[0]; // 最初のマッチカテゴリーを使用（改善の余地あり）
                logInfo(`Falling back to keyword match category '${bestMatchCategory}' due to LLM error.`, { articleTitle: article.title, category: bestMatchCategory });
            } else {
                // キーワードマッチがない場合は 'その他'
                bestMatchCategory = 'その他';
                logInfo(`Falling back to 'その他' category due to LLM error.`, { articleTitle: article.title });
            }
        }

    } else {
        // キーワードマッチングで単一のカテゴリーに明確に分類された場合
        logInfo(`Article "${article.title}" classified by keyword match as '${bestMatchCategory}' (matched ${maxMatchCount} keywords).`, { articleTitle: article.title, category: bestMatchCategory, matchCount: maxMatchCount });
    }


    // TODO: RSS フィードのカテゴリー情報も考慮に入れるロジックを追加

    return {
        ...article,
        category: bestMatchCategory,
        llmResponse: article.llmResponse, // LLMの応答を返すオブジェクトに含める
    };
}

/**
 * 記事リスト全体をカテゴリー分類する（ハイブリッドアプローチ）
 * @param articles 分類する記事オブジェクトのリスト
 * @param env Workers AI バインディングを含む環境変数
 * @returns カテゴリー情報が付与された記事オブジェクトのリスト
 */
export async function classifyArticles(articles: NewsArticle[], env: Env): Promise<NewsArticle[]> {
    logInfo(`Starting article classification for ${articles.length} articles using hybrid approach.`);
    const classifiedArticles: NewsArticle[] = [];
    for (const article of articles) {
        classifiedArticles.push(await classifyArticle(article, env));
    }
    logInfo(`Finished article classification.`);
    return classifiedArticles;
}
