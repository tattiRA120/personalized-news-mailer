export function decodeHtmlEntities(text: string): string {
    const entities: { [key: string]: string } = {
        '&amp;': '&',
        '<': '<',
        '>': '>',
        '"': '"',
        '&#39;': "'",
        '&#x2F;': '/',
        '&#45;': '-', // Add this specific entity for the hyphen
        // Add more entities as needed
    };

    let decodedText = text;
    for (const entity in entities) {
        decodedText = decodedText.replace(new RegExp(entity, 'g'), entities[entity]);
    }
    return decodedText;
}
