// src/categoryClassifier.ts

import { ARTICLE_CATEGORIES, CATEGORY_KEYWORDS } from './config';
import { logInfo, logWarning } from './logger';

interface NewsArticle {
    title: string;
    link: string;
    // Add other fields as needed
    category?: string; // Add category field
}

/**
 * 記事のタイトルとキーワードに基づいてカテゴリーを分類する
 * @param article 分類する記事オブジェクト
 * @returns カテゴリー情報が付与された記事オブジェクト
 */
export function classifyArticle(article: NewsArticle): NewsArticle {
    let bestMatchCategory: string = 'その他';
    let maxMatchCount: number = 0;

    const title = article.title.toLowerCase(); // タイトルを小文字に変換してマッチング

    for (const category of ARTICLE_CATEGORIES) {
        if (category === 'その他') continue; // 'その他' カテゴリーはキーワードマッチングの対象外

        const keywords = CATEGORY_KEYWORDS[category];
        if (!keywords) continue;

        let currentMatchCount = 0;
        for (const keyword of keywords) {
            // キーワードがタイトルに含まれているか判定
            if (title.includes(keyword.toLowerCase())) {
                currentMatchCount++;
            }
        }

        // より多くのキーワードにマッチしたカテゴリーを優先
        if (currentMatchCount > maxMatchCount) {
            maxMatchCount = currentMatchCount;
            bestMatchCategory = category;
        }
    }

    // マッチするキーワードが全くない場合は 'その他' カテゴリーとする
    if (maxMatchCount === 0) {
        logInfo(`Article "${article.title}" classified as 'その他' (no keyword match).`, { articleTitle: article.title });
    } else {
        logInfo(`Article "${article.title}" classified as '${bestMatchCategory}' (matched ${maxMatchCount} keywords).`, { articleTitle: article.title, category: bestMatchCategory, matchCount: maxMatchCount });
    }


    // TODO: RSS フィードのカテゴリー情報も考慮に入れるロジックを追加

    return {
        ...article,
        category: bestMatchCategory,
    };
}

/**
 * 記事リスト全体をカテゴリー分類する
 * @param articles 分類する記事オブジェクトのリスト
 * @returns カテゴリー情報が付与された記事オブジェクトのリスト
 */
export function classifyArticles(articles: NewsArticle[]): NewsArticle[] {
    logInfo(`Starting article classification for ${articles.length} articles.`);
    const classifiedArticles = articles.map(article => classifyArticle(article));
    logInfo(`Finished article classification.`);
    return classifiedArticles;
}
