document.addEventListener('DOMContentLoaded', async () => {
    const articlesContainer = document.getElementById('articles-container');
    articlesContainer.innerHTML = '<p>記事を読み込み中...</p>';

    try {
        const response = await fetch('/get-dissimilar-articles');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const articles = await response.json();

        if (articles.length === 0) {
            articlesContainer.innerHTML = '<p>表示する記事がありません。</p>';
            return;
        }

        articlesContainer.innerHTML = ''; // 読み込み中のメッセージをクリア

        articles.forEach(article => {
            const articleElement = document.createElement('div');
            articleElement.className = 'article-card';
            articleElement.innerHTML = `
                <h2><a href="${article.link}" target="_blank" rel="noopener noreferrer">${article.title}</a></h2>
                <p>${article.summary}</p>
                <p class="article-source">出典: ${article.sourceName || '不明'}</p>
            `;
            articlesContainer.appendChild(articleElement);
        });

    } catch (error) {
        console.error('記事の取得中にエラーが発生しました:', error);
        articlesContainer.innerHTML = `<p>記事の読み込みに失敗しました: ${error.message}</p>`;
    }
});
