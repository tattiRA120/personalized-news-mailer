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
    async function fetchDissimilarArticles() {
        try {
            // Workerの新しいエンドポイントから記事リストを取得
            const response = await fetch('/get-dissimilar-articles');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const articles = await response.json();
            displayArticles(articles);
            submitButton.disabled = false; // 記事が読み込まれたらボタンを有効化
        } catch (error) {
            console.error('Error fetching dissimilar articles:', error);
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

            const articleContent = document.createElement('div');
            articleContent.className = 'article-content';

            const title = document.createElement('h3');
            title.textContent = article.title;

            const summary = document.createElement('p');
            summary.textContent = article.summary || '';

            articleContent.appendChild(title);
            articleContent.appendChild(summary);

            const interestSelection = document.createElement('div');
            interestSelection.className = 'interest-selection';

            const interestedInput = document.createElement('input');
            interestedInput.type = 'radio';
            interestedInput.id = `interested-${article.articleId}`;
            interestedInput.name = `interest-${article.articleId}`;
            interestedInput.value = 'interested';
            interestedInput.addEventListener('change', checkAllArticlesSelected);
            const interestedLabel = document.createElement('label');
            interestedLabel.htmlFor = `interested-${article.articleId}`;
            interestedLabel.textContent = '興味あり';

            const notInterestedInput = document.createElement('input');
            notInterestedInput.type = 'radio';
            notInterestedInput.id = `not-interested-${article.articleId}`;
            notInterestedInput.name = `interest-${article.articleId}`;
            notInterestedInput.value = 'not_interested';
            notInterestedInput.addEventListener('change', checkAllArticlesSelected);
            const notInterestedLabel = document.createElement('label');
            notInterestedLabel.htmlFor = `not-interested-${article.articleId}`;
            notInterestedLabel.textContent = '興味なし';

            interestSelection.appendChild(interestedInput);
            interestSelection.appendChild(interestedLabel);
            interestSelection.appendChild(notInterestedInput);
            interestSelection.appendChild(notInterestedLabel);

            articleItem.appendChild(articleContent);
            articleItem.appendChild(interestSelection);

            articlesListDiv.appendChild(articleItem);
        });
    }

    // すべての記事が選択されたかチェックする関数
    function checkAllArticlesSelected() {
        const totalArticles = articlesListDiv.querySelectorAll('.article-item').length;
        const selectedArticleGroups = articlesListDiv.querySelectorAll('.article-item .interest-selection input:checked').length;
        submitButton.disabled = totalArticles !== selectedArticleGroups;
    }

    // 選択された記事をWorkerに送信する関数
    async function submitInterestResponses() {
        submitButton.disabled = true;
        submitButton.classList.add('loading');
        messageElement.textContent = '送信中...';
        messageElement.className = '';

        const responses = [];
        articlesListDiv.querySelectorAll('.article-item').forEach(articleItem => {
            const articleId = articleItem.querySelector('input[type="radio"]').name.split('-')[1];
            const selectedInterest = articleItem.querySelector(`input[name="interest-${articleId}"]:checked`);

            if (selectedInterest) {
                responses.push({
                    articleId: articleId,
                    interest: selectedInterest.value,
                });
            }
        });

        if (responses.length === 0) {
            messageElement.textContent = '記事を選択してください。';
            messageElement.className = 'error';
            submitButton.disabled = false;
            submitButton.classList.remove('loading');
            return;
        }

        try {
            const response = await fetch('/submit-interests', { // エンドポイントは既存のものを利用
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    userId: userId,
                    responses: responses, // 記事データの配列を送信
                }),
            });

            const result = await response.json();

            if (response.ok) {
                messageElement.textContent = result.message || '選択結果が送信されました。';
                messageElement.className = '';
            } else {
                throw new Error(result.message || `HTTP error! status: ${response.status}`);
            }
        } catch (error) {
            console.error('Error submitting interest responses:', error);
            messageElement.textContent = `送信に失敗しました: ${error.message}`;
            messageElement.className = 'error';
        } finally {
            submitButton.classList.remove('loading');
            if (messageElement.className === 'error') {
                submitButton.disabled = false;
            } else {
                submitButton.disabled = true;
            }
        }
    }

    submitButton.addEventListener('click', submitInterestResponses);

    fetchDissimilarArticles();
});
