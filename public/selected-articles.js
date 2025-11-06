document.addEventListener('DOMContentLoaded', () => {
    const articlesListDiv = document.getElementById('articles-list');
    const messageElement = document.getElementById('message');

    // ローカルストレージから選択した記事を取得
    const selectedArticles = JSON.parse(localStorage.getItem('selectedArticles') || '[]');

    if (selectedArticles.length === 0) {
        articlesListDiv.innerHTML = '<p>選択された記事がありません。</p>';
        return;
    }

    // 記事リストをHTMLに表示する関数
    function displayArticles(articles) {
        articlesListDiv.innerHTML = ''; // 既存のコンテンツをクリア

        articles.forEach(article => {
            const articleItem = document.createElement('div');
            articleItem.className = 'article-item';

            const articleContent = document.createElement('div');
            articleContent.className = 'article-content';

            const title = document.createElement('h3');
            title.textContent = article.title;
            title.style.cursor = 'pointer';
            title.style.color = '#007bff';
            title.addEventListener('click', () => {
                window.open(article.link, '_blank');
            });

            const summary = document.createElement('p');
            summary.textContent = article.summary || '';

            articleContent.appendChild(title);
            articleContent.appendChild(summary);

            articleItem.appendChild(articleContent);

            articlesListDiv.appendChild(articleItem);
        });
    }

    // 記事を表示
    displayArticles(selectedArticles);

    // localStorageから選択した記事を削除
    localStorage.removeItem('selectedArticles');
});
