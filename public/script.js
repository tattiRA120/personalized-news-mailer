document.addEventListener('DOMContentLoaded', () => {
    const articlesListDiv = document.getElementById('articles-list');
    const submitButton = document.getElementById('submit-button');
    const messageElement = document.getElementById('message');

    // URLからユーザーIDを取得
    const urlParams = new URLSearchParams(window.location.search);
    const userId = urlParams.get('userId');

    if (!userId) {
        articlesListDiv.innerHTML = '<p class="error">ユーザーIDが見つかりません。正しいリンクからアクセスしてください。</p>';
        submitButton.disabled = true;
        return;
    }

    // 記事リストを取得する関数
    async function fetchArticlesForEducation() {
        try {
            // Workerの新しいエンドポイントから記事リストを取得
            const response = await fetch('/get-articles-for-education');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const articles = await response.json();
            displayArticles(articles);
            submitButton.disabled = false; // 記事が読み込まれたらボタンを有効化
        } catch (error) {
            console.error('Error fetching articles:', error);
            articlesListDiv.innerHTML = '<p class="error">記事の読み込みに失敗しました。</p>';
            messageElement.textContent = '記事の読み込みに失敗しました。';
            messageElement.className = 'error';
        }
    }

    // 記事リストをHTMLに表示する関数
    function displayArticles(articles) {
        articlesListDiv.innerHTML = ''; // 既存のコンテンツをクリア
        if (articles.length === 0) {
            articlesListDiv.innerHTML = '<p>表示できる記事がありません。</p>';
            return;
        }

        articles.forEach(article => {
            const articleItem = document.createElement('div');
            articleItem.className = 'article-item';
            articleItem.dataset.link = article.link; // 記事のリンクをdata属性として追加

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = article.articleId; // 記事IDとして使用
            checkbox.id = `article-${article.articleId}`; // 一意なIDを設定

            const articleContent = document.createElement('div');
            articleContent.className = 'article-content';

            const title = document.createElement('h3');
            title.textContent = article.title;

            const summary = document.createElement('p');
            summary.textContent = article.summary || '';

            articleContent.appendChild(title);
            articleContent.appendChild(summary);

            articleItem.appendChild(checkbox);
            articleItem.appendChild(articleContent);

            articlesListDiv.appendChild(articleItem);
        });
    }

    // 選択された記事をWorkerに送信する関数
    async function submitSelectedArticles() {
        // 送信開始時にボタンを無効化し、ローディングアニメーションを表示
        submitButton.disabled = true;
        submitButton.classList.add('loading');
        messageElement.textContent = '送信中...';
        messageElement.className = ''; // メッセージをリセット

        const selectedArticlesData = [];
        articlesListDiv.querySelectorAll('.article-item input[type="checkbox"]:checked').forEach(checkbox => {
            const articleItem = checkbox.closest('.article-item');
            const titleElement = articleItem.querySelector('h3');
            const summaryElement = articleItem.querySelector('p');
            const articleLink = articleItem.dataset.link; // data属性からリンクを取得

            selectedArticlesData.push({
                articleId: checkbox.value,
                title: titleElement ? titleElement.textContent : '',
                summary: summaryElement ? summaryElement.textContent : '',
                link: articleLink, // リンクも送信データに含める
            });

            // 選択された記事を新しいタブで開く
            if (articleLink) {
                window.open(articleLink, '_blank');
            }
        });

        if (selectedArticlesData.length === 0) {
            messageElement.textContent = '記事を選択してください。';
            messageElement.className = 'error';
            submitButton.disabled = false; // 記事が選択されていない場合はボタンを再度有効化
            submitButton.classList.remove('loading'); // ローディングを停止
            return;
        }

        try {
            // Workerの新しいエンドポイントに選択結果を送信
            const response = await fetch('/submit-interests', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    userId: userId,
                    selectedArticles: selectedArticlesData, // 記事データの配列を送信
                }),
            });

            const result = await response.json();

            if (response.ok) {
                messageElement.textContent = result.message || '選択結果が送信されました。';
                messageElement.className = ''; // 成功時はエラークラスを削除
                // submitButton.disabled = true; // 送信後はボタンを無効化 (成功時は再送信不要のため)
            } else {
                throw new Error(result.message || `HTTP error! status: ${response.status}`);
            }
        } catch (error) {
            console.error('Error submitting selected articles:', error);
            messageElement.textContent = `送信に失敗しました: ${error.message}`;
            messageElement.className = 'error';
        } finally {
            // 処理完了後にローディングアニメーションを停止し、ボタンを有効化
            submitButton.classList.remove('loading');
            // エラー時のみボタンを再有効化。成功時は無効のまま。
            if (messageElement.className === 'error') {
                submitButton.disabled = false;
            } else {
                submitButton.disabled = true; // 成功時はボタンを無効化
            }
        }
    }

    // 送信ボタンのイベントリスナー
    submitButton.addEventListener('click', submitSelectedArticles);

    // ページロード時に記事リストを取得
    fetchArticlesForEducation();
});
