export function cleanArticleText(text: string): string {
    if (!text || typeof text !== 'string') {
        return '';
    }

    // [object Object] の除去
    let cleanedText = text.replace(/\[object Object\]/g, '');

    // 全角記号の半角化
    // 参考: https://qiita.com/hrkt/items/a4063229b1422120d72a
    cleanedText = cleanedText.replace(/[！-～]/g, function(s) {
        return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    });

    // 全角スペースを半角スペースに変換
    cleanedText = cleanedText.replace(/　/g, ' ');

    // タイトルの重複除去 (例: "タイトル - ソース. タイトル ソース" -> "タイトル - ソース")
    // ロイターやBloombergの形式に対応
    const parts = cleanedText.split('. ');
    if (parts.length >= 2) {
        const firstPart = parts[0].trim();
        const secondPart = parts[1].trim();
        if (secondPart.startsWith(firstPart)) {
            cleanedText = firstPart;
        } else {
            // "タイトル - ソース. タイトル ソース" のような形式で、ソース部分が異なる場合も考慮
            const sourceMatch = firstPart.match(/ - (ロイター|Bloomberg\.co\.jp|Bloomberg|NHK|ITmedia|PC Watch|デジカメ Watch|AV Watch|GIGAZINE|GIZMODO JAPAN|エルミタージュ秋葉原|Zenn|Qiita|ギャズログ|北森瓦版)$/);
            if (sourceMatch) {
                const titleWithoutSource = firstPart.substring(0, firstPart.length - sourceMatch[0].length).trim();
                if (secondPart.startsWith(titleWithoutSource)) {
                    cleanedText = firstPart;
                }
            }
        }
    }

    // 連続する空白を1つにまとめ、前後の空白をトリム
    cleanedText = cleanedText.replace(/\s+/g, ' ').trim();

    return cleanedText;
}
