export function decodeHtmlEntities(text: string): string {
    if (!text) return text;

    const entities: { [key: string]: string } = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
        '&nbsp;': ' ',
    };

    return text.replace(/&([a-z0-9]+|#[0-9]{1,6}|#x[0-9a-fA-F]{1,6});/ig, (match, entity) => {
        // Handle named entities
        if (entities[match]) {
            return entities[match];
        }

        // Handle numeric entities
        if (entity.startsWith('#')) {
            if (entity.startsWith('#x')) {
                return String.fromCharCode(parseInt(entity.substring(2), 16));
            } else {
                return String.fromCharCode(parseInt(entity.substring(1), 10));
            }
        }

        return match;
    });
}
