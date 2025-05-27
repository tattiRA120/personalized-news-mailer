// src/categoryClassifier.ts

import { logInfo, logWarning, logError } from './logger';
import { Env } from '.'; // Env 型をインポート
import { getCategoryKeywords, EnvWithKeywordsKV, getCategoryList, addCategory } from './keywordManager'; // getCategoryKeywords, EnvWithKeywordsKV, getCategoryList, addCategory をインポート

// EnvWithKeywordsKV を拡張して AI バインディングも含むようにする
interface EnvWithAIAndKeywordsKV extends EnvWithKeywordsKV {
    AI: Ai;
}

interface NewsArticle {
    title: string;
    link: string;
    summary?: string;
    category?: string;
    llmResponse?: string;
}

/**
 * 全角英数字を半角に変換するヘルパー関数
 * @param str 変換する文字列
 * @returns 半角に変換された文字列
 */
function normalizeText(str: string): string {
    if (!str) return '';
    return str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(s) {
        return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    });
}

/**
 * 記事のタイトルとキーワードに基づいてカテゴリーを分類する（ハイブリッドアプローチ）
 * @param article 分類する記事オブジェクト
 * @param env Workers AI バインディングとKVバインディングを含む環境変数
 * @returns カテゴリー情報が付与された記事オブジェクト
 */
export async function classifyArticle(article: NewsArticle, env: EnvWithAIAndKeywordsKV): Promise<NewsArticle> {
    // タイトルとサマリーを正規化し、小文字に変換してマッチング
    const normalizedTitle = normalizeText(article.title).toLowerCase();
    const normalizedSummary = normalizeText(article.summary || '').toLowerCase();
    const combinedText = `${normalizedTitle} ${normalizedSummary}`; // タイトルとサマリーを結合

    // 動的に取得したカテゴリーリストを使用
    const currentCategoryList = await getCategoryList(env);
    const categoriesForClassification = currentCategoryList.length > 0 ? currentCategoryList : ['その他']; // カテゴリーがまだない場合は「その他」のみで開始

    // --- ルールベースの分類 (Rule-based Classification) ---
    // 特定のキーワードがタイトルに含まれる場合に強制的に分類
    if (normalizedTitle.includes('速報') || normalizedTitle.includes('緊急')) {
        if (normalizedSummary.includes('国際') || normalizedSummary.includes('海外')) {
            logInfo(`Article "${article.title}" classified by rule as '国際' (breaking news).`, { articleTitle: article.title, category: '国際' });
            return { ...article, category: '国際' };
        } else {
            logInfo(`Article "${article.title}" classified by rule as '国内' (breaking news).`, { articleTitle: article.title, category: '国内' });
            return { ...article, category: '国内' };
        }
    }

    // --- キーワードマッチング (Keyword Matching) ---
    let bestMatchCategory: string | null = null;
    let maxMatchCount: number = 0;
    const matchedCategories: string[] = [];

    const categoryKeywords = await getCategoryKeywords(env); // KVからキーワード辞書を取得

    for (const category of categoriesForClassification) {
        if (category === 'その他' && categoriesForClassification.length > 1) continue; // 他のカテゴリーがある場合は「その他」をスキップ

        const keywords = categoryKeywords[category];
        if (!keywords) continue;

        let currentMatchCount = 0;
        for (const keyword of keywords) {
            const lowerKeyword = keyword.toLowerCase();
            // 結合されたテキストに対してキーワードマッチングを行う
            if (combinedText.includes(lowerKeyword)) {
                currentMatchCount++;
            }
        }

        if (currentMatchCount > maxMatchCount) {
            maxMatchCount = currentMatchCount;
            bestMatchCategory = category;
            matchedCategories.length = 0;
            matchedCategories.push(category);
        } else if (currentMatchCount > 0 && currentMatchCount === maxMatchCount) {
             matchedCategories.push(category);
        }
    }

    const keywordMatchThreshold = 1; // キーワードマッチングの閾値
    // キーワードマッチングで明確な分類ができない場合（マッチしない、または複数カテゴリーにマッチする場合）にLLMを使用
    if (bestMatchCategory === null || maxMatchCount <= keywordMatchThreshold || matchedCategories.length > 1) {
        // LLM分類が必要な場合のみログを出力
        // logInfo(`Article "${article.title}" requires LLM classification (keyword match count: ${maxMatchCount}, matched categories: ${matchedCategories.join(', ')}).`, { articleTitle: article.title });

        try {
            const prompt = `以下の記事タイトルを、最も適切なカテゴリーに分類してください。既存のカテゴリーリストを参考にしても構いませんが、記事の内容に最も合致する新しいカテゴリー名を提案しても構いません。カテゴリーは一つだけ選んでください。\n\n既存のカテゴリーリスト（参考）:\n${currentCategoryList.map(cat => `- ${cat}`).join('\n')}\n\n記事タイトル: ${article.title}\n\n**重要:** 回答は必ず日本語のカテゴリー名のみを返してください。**他のテキスト、説明、番号、記号、句読点、または記事タイトルの一部を一切含めないでください。**`;

            const response = await env.AI.run(
                '@cf/meta/llama-3.2-1b-instruct',
                { prompt: prompt }
            );

            const llmResponseText = (response as any).response.trim();
            article.llmResponse = llmResponseText;

            let classifiedLlmCategory: string = 'その他'; // LLMが分類できなかった場合のデフォルト

            const normalizedLlmResponse = normalizeText(llmResponseText).toLowerCase();
            const existingNormalizedCategories = currentCategoryList.map(c => normalizeText(c).toLowerCase());

            if (existingNormalizedCategories.includes(normalizedLlmResponse)) {
                classifiedLlmCategory = currentCategoryList[existingNormalizedCategories.indexOf(normalizedLlmResponse)];
                // LLMが既存カテゴリーに分類した場合のみログを出力
                // logInfo(`Article "${article.title}" classified by LLM as existing category '${classifiedLlmCategory}'.`, { articleTitle: article.title, category: classifiedLlmCategory });
            } else {
                const added = await addCategory(llmResponseText, env);
                if (added) {
                    classifiedLlmCategory = llmResponseText;
                    // LLMが新しいカテゴリーを提案し、追加した場合のみログを出力
                    // logInfo(`Article "${article.title}" classified by LLM as new category '${classifiedLlmCategory}' and added to list.`, { articleTitle: article.title, category: classifiedLlmCategory });
                } else {
                    classifiedLlmCategory = llmResponseText;
                    logWarning(`LLM suggested category "${llmResponseText}" for article "${article.title}" but it could not be added (might already exist).`, { articleTitle: article.title, llmCategory: llmResponseText });
                }
            }
            bestMatchCategory = classifiedLlmCategory;

        } catch (error: any) {
            logError(`Error during LLM classification for article "${article.title}": ${error}`, { articleTitle: article.title, error: error });
            article.llmResponse = `Error: ${error.message || String(error)}`;
            if (maxMatchCount > 0 && bestMatchCategory !== null) {
                bestMatchCategory = matchedCategories[0];
                logInfo(`Falling back to keyword match category '${bestMatchCategory}' due to LLM error.`, { articleTitle: article.title, category: bestMatchCategory });
            } else {
                bestMatchCategory = 'その他';
                logInfo(`Falling back to 'その他' category due to LLM error.`, { articleTitle: article.title });
            }
        }

    } else {
        // キーワードマッチングで単一のカテゴリーに明確に分類された場合のみログを出力
        // logInfo(`Article "${article.title}" classified by keyword match as '${bestMatchCategory}' (matched ${maxMatchCount} keywords).`, { articleTitle: article.title, category: bestMatchCategory, matchCount: maxMatchCount });
    }

    const finalCategory = bestMatchCategory || 'その他';

    return {
        ...article,
        category: finalCategory,
        llmResponse: article.llmResponse,
    };
}

/**
 * 記事リスト全体をカテゴリー分類する（ハイブリッドアプローチ）
 * @param articles 分類する記事オブジェクトのリスト
 * @param env Workers AI バインディングとKVバインディングを含む環境変数
 * @returns カテゴリー情報が付与された記事オブジェクトのリスト
 */
export async function classifyArticles(articles: NewsArticle[], env: EnvWithAIAndKeywordsKV): Promise<NewsArticle[]> {
    logInfo(`Starting article classification for ${articles.length} articles using hybrid approach.`);
    const classifiedArticles: NewsArticle[] = [];
    for (const article of articles) {
        classifiedArticles.push(await classifyArticle(article, env));
    }
    logInfo(`Finished article classification.`);
    return classifiedArticles;
}
