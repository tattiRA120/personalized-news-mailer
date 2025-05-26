// src/keywordManager.ts

import { logInfo, logError, logWarning } from './logger';

interface CategoryKeywords {
    [key: string]: string[];
}

// カテゴリーリストの型定義
export type CategoryList = string[];

// デフォルトのカテゴリーキーワード辞書 (空にする)
const DEFAULT_CATEGORY_KEYWORDS: CategoryKeywords = {};

// KV Namespace の型定義
export interface EnvWithKeywordsKV {
    CATEGORY_KEYWORDS_KV: KVNamespace;
    CATEGORY_LIST_KV: KVNamespace; // 新しいカテゴリーリスト用KV
}

const KEYWORDS_KV_KEY = 'category_keywords';
const CATEGORY_LIST_KV_KEY = 'category_list';

/**
 * KVからカテゴリーキーワード辞書を読み込む
 * @param env KV Namespace バインディングを含む環境変数
 * @returns カテゴリーキーワード辞書
 */
export async function getCategoryKeywords(env: EnvWithKeywordsKV): Promise<CategoryKeywords> {
    try {
        const cachedKeywords = await env.CATEGORY_KEYWORDS_KV.get(KEYWORDS_KV_KEY, { type: 'json' });
        if (cachedKeywords) {
            logInfo('Loaded category keywords from KV.');
            return cachedKeywords as CategoryKeywords;
        }
    } catch (error) {
        logError('Error loading category keywords from KV.', error);
    }

    // KVに存在しない場合、またはエラーが発生した場合は空のキーワード辞書を返す
    logInfo('Category keywords not found in KV or failed to load. Initializing with empty keywords.');
    const emptyKeywords: CategoryKeywords = {};
    // カテゴリーリストも空で初期化されるため、ここではキーワード辞書も空で初期化
    await saveCategoryKeywords(emptyKeywords, env);
    return emptyKeywords;
}

/**
 * カテゴリーキーワード辞書をKVに保存する
 * @param keywords 保存するカテゴリーキーワード辞書
 * @param env KV Namespace バインディングを含む環境変数
 */
export async function saveCategoryKeywords(keywords: CategoryKeywords, env: EnvWithKeywordsKV): Promise<void> {
    try {
        await env.CATEGORY_KEYWORDS_KV.put(KEYWORDS_KV_KEY, JSON.stringify(keywords));
        logInfo('Saved category keywords to KV.');
    } catch (error) {
        logError('Error saving category keywords to KV.', error);
    }
}

/**
 * KVからカテゴリーリストを読み込む
 * @param env KV Namespace バインディングを含む環境変数
 * @returns カテゴリーリスト
 */
export async function getCategoryList(env: EnvWithKeywordsKV): Promise<CategoryList> {
    try {
        const cachedList = await env.CATEGORY_LIST_KV.get(CATEGORY_LIST_KV_KEY, { type: 'json' });
        if (cachedList) {
            logInfo('Loaded category list from KV.');
            return cachedList as CategoryList;
        }
    } catch (error) {
        logError('Error loading category list from KV.', error);
    }

    // KVに存在しない場合、またはエラーが発生した場合は空のリストを返す
    logInfo('Category list not found in KV or failed to load. Initializing with empty list.');
    const emptyList: CategoryList = [];
    await saveCategoryList(emptyList, env);
    return emptyList;
}

/**
 * カテゴリーリストをKVに保存する
 * @param categoryList 保存するカテゴリーリスト
 * @param env KV Namespace バインディングを含む環境変数
 */
export async function saveCategoryList(categoryList: CategoryList, env: EnvWithKeywordsKV): Promise<void> {
    try {
        await env.CATEGORY_LIST_KV.put(CATEGORY_LIST_KV_KEY, JSON.stringify(categoryList));
        logInfo('Saved category list to KV.');
    } catch (error) {
        logError('Error saving category list to KV.', error);
    }
}

/**
 * カテゴリーリストに新しいカテゴリーを追加する
 * @param newCategory 追加する新しいカテゴリー
 * @param env KV Namespace バインディングを含む環境変数
 * @returns カテゴリーが追加されたかどうか
 */
export async function addCategory(newCategory: string, env: EnvWithKeywordsKV): Promise<boolean> {
    const currentList = await getCategoryList(env);
    const normalizedNewCategory = normalizeText(newCategory).toLowerCase();

    if (!currentList.map(c => normalizeText(c).toLowerCase()).includes(normalizedNewCategory)) {
        currentList.push(newCategory);
        await saveCategoryList(currentList, env);
        logInfo(`Added new category: '${newCategory}' to the list.`);
        return true;
    }
    logInfo(`Category '${newCategory}' already exists in the list.`);
    return false;
}

/**
 * カテゴリーキーワード辞書を更新する（新しいキーワードを追加）
 * @param category 更新対象のカテゴリー
 * @param newKeywords 追加する新しいキーワードの配列
 * @param env KV Namespace バインディングを含む環境変数
 */
export async function updateCategoryKeywords(category: string, newKeywords: string[], env: EnvWithKeywordsKV): Promise<void> {
    // カテゴリーリストに存在するかどうかを確認するロジックは、getCategoryList を使用するように変更
    const currentCategoryList = await getCategoryList(env);
    if (!currentCategoryList.map(c => normalizeText(c).toLowerCase()).includes(normalizeText(category).toLowerCase())) {
        logWarning(`Attempted to update keywords for non-existent category: ${category}. Adding category first.`);
        await addCategory(category, env); // カテゴリーが存在しない場合は追加
    }

    const currentKeywords = await getCategoryKeywords(env);
    const existingKeywords = new Set(currentKeywords[category] || []);
    let updated = false;

    newKeywords.forEach(kw => {
        const lowerKw = kw.toLowerCase();
        if (!existingKeywords.has(lowerKw)) {
            existingKeywords.add(lowerKw);
            updated = true;
        }
    });

    if (updated) {
        currentKeywords[category] = Array.from(existingKeywords);
        await saveCategoryKeywords(currentKeywords, env);
        logInfo(`Updated keywords for category '${category}'. Added ${newKeywords.length} new keywords.`);
    } else {
        logInfo(`No new keywords to add for category '${category}'.`);
    }
}

/**
 * 全角英数字を半角に変換するヘルパー関数
 * @param str 変換する文字列
 * @returns 半角に変換された文字列
 */
export function normalizeText(str: string): string {
    if (!str) return '';
    return str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(s) {
        return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    });
}

/**
 * 記事のタイトルとサマリーからキーワード候補を抽出する（簡易版）
 * TODO: より高度なキーワード抽出（TF-IDF, N-gram, 形態素解析など）を検討
 * @param text 記事のタイトルまたはサマリー
 * @returns 抽出されたキーワード候補の配列
 */
export function extractKeywordsFromText(text: string): string[] {
    // テキストを正規化し、小文字に変換
    const normalizedText = normalizeText(text).toLowerCase();

    // 日本語の簡易的なキーワード抽出
    // 現状はスペース区切りで単語を抽出し、短い単語や一般的な単語を除外
    const words = normalizedText.split(/[\s.,;!?"'()\[\]{}<>“”‘’—\-ー、。「」『』（）？！]/).filter(Boolean);
    const stopWords = new Set([
        'の', 'に', 'を', 'が', 'は', 'と', 'へ', 'から', 'まで', 'で', 'も', 'や', 'など', 'こと', 'もの', 'ため',
        'れる', 'する', 'いる', 'ある', 'なる', 'よう', 'これ', 'それ', 'あれ', 'この', 'その', 'あの', 'です', 'ます',
        'だ', 'である', 'ました', 'でしょう', 'だろう', 'ません', 'ない'
    ]);

    // 短すぎる単語やストップワードを除外
    const filteredWords = words.filter(word => word.length > 1 && !stopWords.has(word));

    // 重複を排除して返す
    return Array.from(new Set(filteredWords));
}
