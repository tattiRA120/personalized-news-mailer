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
    const articlesNeedingLlm: { article: NewsArticle; index: number }[] = [];

    // フェーズ1: ルールベースとキーワードマッチングによる初期分類
    for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        const normalizedTitle = normalizeText(article.title).toLowerCase();
        const normalizedSummary = normalizeText(article.summary || '').toLowerCase();
        const combinedText = `${normalizedTitle} ${normalizedSummary}`;

        // 動的に取得したカテゴリーリストを使用
        const currentCategoryList = await getCategoryList(env);
        const categoriesForClassification = currentCategoryList.length > 0 ? currentCategoryList : ['その他'];

        let bestMatchCategory: string | null = null;
        let maxMatchCount: number = 0;
        const matchedCategories: string[] = [];

        // ルールベースの分類
        if (normalizedTitle.includes('速報') || normalizedTitle.includes('緊急')) {
            if (normalizedSummary.includes('国際') || normalizedSummary.includes('海外')) {
                classifiedArticles[i] = { ...article, category: '国際' };
                logInfo(`Article "${article.title}" classified by rule as '国際' (breaking news).`, { articleTitle: article.title, category: '国際' });
                continue; // 次の記事へ
            } else {
                classifiedArticles[i] = { ...article, category: '国内' };
                logInfo(`Article "${article.title}" classified by rule as '国内' (breaking news).`, { articleTitle: article.title, category: '国内' });
                continue; // 次の記事へ
            }
        }

        // キーワードマッチング
        const categoryKeywords = await getCategoryKeywords(env);
        for (const category of categoriesForClassification) {
            if (category === 'その他' && categoriesForClassification.length > 1) continue;

            const keywords = categoryKeywords[category];
            if (!keywords) continue;

            let currentMatchCount = 0;
            for (const keyword of keywords) {
                const lowerKeyword = keyword.toLowerCase();
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

        const keywordMatchThreshold = 1;
        if (bestMatchCategory === null || maxMatchCount <= keywordMatchThreshold || matchedCategories.length > 1) {
            // LLM分類が必要な記事を収集
            articlesNeedingLlm.push({ article: article, index: i });
        } else {
            // キーワードマッチングで分類できた記事
            classifiedArticles[i] = { ...article, category: bestMatchCategory };
            logInfo(`Article "${article.title}" classified by keyword match as '${bestMatchCategory}' (matched ${maxMatchCount} keywords).`, { articleTitle: article.title, category: bestMatchCategory, matchCount: maxMatchCount });
        }
    }

    // フェーズ2: LLMによるバッチ分類
    if (articlesNeedingLlm.length > 0) {
        logInfo(`Attempting LLM batch classification for ${articlesNeedingLlm.length} articles.`);
        const currentCategoryList = await getCategoryList(env); // 最新のカテゴリーリストを再取得

        const prompt = `以下の記事タイトルを、最も適切なカテゴリーに分類してください。各記事の分類結果は、元の記事タイトルの後に「: [カテゴリー名]」の形式で記述し、各行を改行で区切ってください。既存のカテゴリーリストを参考にしても構いませんが、記事の内容に最も合致する新しいカテゴリー名を提案しても構いません。カテゴリーは一つだけ選んでください。\n\n既存のカテゴリーリスト（参考）:\n${currentCategoryList.map(cat => `- ${cat}`).join('\n')}\n\n記事タイトルと分類結果の例:\n記事タイトル1: カテゴリーA\n記事タイトル2: カテゴリーB\n\n分類する記事タイトル:\n${articlesNeedingLlm.map(item => item.article.title).join('\n')}`;

        try {
            const response = await env.AI.run(
                '@cf/meta/llama-3.2-1b-instruct',
                { prompt: prompt }
            );

            const llmResponseText = (response as any).response.trim();
            const llmResults = llmResponseText.split('\n').map((line: string) => {
                const parts = line.split(': ');
                if (parts.length >= 2) {
                    const title = parts[0].trim();
                    const category = parts.slice(1).join(': ').trim();
                    return { title, category };
                }
                return null;
            }).filter(Boolean);

            const categoryKeywords = await getCategoryKeywords(env); // KVからキーワード辞書を再取得

            for (const llmResult of llmResults) {
                const articleIndex = articlesNeedingLlm.findIndex(item => item.article.title === llmResult.title);
                if (articleIndex !== -1) {
                    const originalArticle = articlesNeedingLlm[articleIndex].article;
                    const originalIndex = articlesNeedingLlm[articleIndex].index;

                    let classifiedLlmCategory: string = 'その他';
                    const normalizedLlmResponse = normalizeText(llmResult.category).toLowerCase();
                    const existingNormalizedCategories = currentCategoryList.map(c => normalizeText(c).toLowerCase());

                    if (existingNormalizedCategories.includes(normalizedLlmResponse)) {
                        classifiedLlmCategory = currentCategoryList[existingNormalizedCategories.indexOf(normalizedLlmResponse)];
                        logInfo(`Article "${originalArticle.title}" classified by LLM as existing category '${classifiedLlmCategory}'.`, { articleTitle: originalArticle.title, category: classifiedLlmCategory });
                    } else {
                        const added = await addCategory(llmResult.category, env);
                        if (added) {
                            classifiedLlmCategory = llmResult.category;
                            logInfo(`Article "${originalArticle.title}" classified by LLM as new category '${classifiedLlmCategory}' and added to list.`, { articleTitle: originalArticle.title, category: classifiedLlmCategory });
                        } else {
                            classifiedLlmCategory = llmResult.category;
                            logWarning(`LLM suggested category "${llmResult.category}" for article "${originalArticle.title}" but it could not be added (might already exist).`, { articleTitle: originalArticle.title, llmCategory: llmResult.category });
                        }
                    }
                    classifiedArticles[originalIndex] = { ...originalArticle, category: classifiedLlmCategory, llmResponse: llmResult.category };
                }
            }
        } catch (error: any) {
            logError(`Error during LLM batch classification: ${error}`, { error: error });
            // LLMバッチ分類が失敗した場合、LLM分類が必要だった記事は「その他」にフォールバック
            for (const item of articlesNeedingLlm) {
                if (!classifiedArticles[item.index]) { // まだ分類されていない場合のみ
                    classifiedArticles[item.index] = { ...item.article, category: 'その他', llmResponse: `Error: ${error.message || String(error)}` };
                    logInfo(`Falling back to 'その他' category for article "${item.article.title}" due to LLM batch error.`, { articleTitle: item.article.title });
                }
            }
        }
    }

    // まだ分類されていない記事があれば「その他」に設定（主にエラーケース）
    for (let i = 0; i < articles.length; i++) {
        if (!classifiedArticles[i]) {
            classifiedArticles[i] = { ...articles[i], category: 'その他' };
            logInfo(`Article "${articles[i].title}" defaulted to 'その他' as no classification was made.`, { articleTitle: articles[i].title });
        }
    }

    logInfo(`Finished article classification.`);
    return classifiedArticles.filter(Boolean); // null/undefined を除去
}
