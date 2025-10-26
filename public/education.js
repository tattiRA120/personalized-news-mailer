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

    // 現在の好みスコアを取得する関数
    async function fetchCurrentPreferenceScore() {
        try {
            const response = await fetch(`/api/preference-score?userId=${encodeURIComponent(userId)}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const { score } = await response.json();
            displayPreferenceScore(score);
        } catch (error) {
            console.error('Error fetching current preference score:', error);
            // エラーの場合は0%を表示
            displayPreferenceScore(0);
        }
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
            submitButton.disabled = false; // 記事が読み込まれたらボタンを常に有効化
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

            const interestedLabel = document.createElement('label');
            interestedLabel.htmlFor = `interested-${article.articleId}`;
            interestedLabel.className = 'radio-label interested-label';
            interestedLabel.innerHTML = `
                <input type="radio" id="interested-${article.articleId}" name="interest-${article.articleId}" value="interested">
                <span>興味あり</span>
            `;
            interestedLabel.querySelector('input').addEventListener('change', handleInterestChange);

            const notInterestedLabel = document.createElement('label');
            notInterestedLabel.htmlFor = `not-interested-${article.articleId}`;
            notInterestedLabel.className = 'radio-label not-interested-label';
            notInterestedLabel.innerHTML = `
                <input type="radio" id="not-interested-${article.articleId}" name="interest-${article.articleId}" value="not_interested">
                <span>興味なし</span>
            `;
            notInterestedLabel.querySelector('input').addEventListener('change', handleInterestChange);

            interestSelection.appendChild(interestedLabel);
            interestSelection.appendChild(notInterestedLabel);

            const articleMainContent = document.createElement('div');
            articleMainContent.className = 'article-main-content';
            articleMainContent.appendChild(articleContent);

            articleItem.appendChild(articleMainContent);
            articleItem.appendChild(interestSelection);

            articlesListDiv.appendChild(articleItem);
        });
    }

    // 興味選択が変更されたときのハンドラ
    function handleInterestChange(event) {
        const selectedRadio = event.target;
        const radioGroupName = selectedRadio.name;
        const articleItem = selectedRadio.closest('.article-item');

        // 同じグループのすべてのラジオボタンのラベルを取得
        const allRadiosInGroup = articleItem.querySelectorAll(`input[name="${radioGroupName}"]`);
        allRadiosInGroup.forEach(radio => {
            const label = radio.closest('.radio-label');
            if (radio.checked) {
                // 選択されたボタンはデフォルトの色を維持
                label.classList.remove('deselected');
            } else {
                // 選択されていないボタンはグレーにする
                label.classList.add('deselected');
            }
        });
    }

    // 選択された記事をWorkerに送信する関数
    async function submitInterestResponses() {
        submitButton.disabled = true;
        submitButton.classList.add('loading');
        messageElement.textContent = '送信中...';
        messageElement.className = '';

        const feedbackPromises = [];
        articlesListDiv.querySelectorAll('.article-item').forEach(articleItem => {
            const articleId = articleItem.querySelector('input[type="radio"]').name.split('-')[1];
            const selectedInterest = articleItem.querySelector(`input[name="interest-${articleId}"]:checked`);
            if (selectedInterest) {
                const feedbackUrl = `/track-feedback?userId=${userId}&articleId=${encodeURIComponent(articleId)}&feedback=${selectedInterest.value}`;
                feedbackPromises.push(fetch(feedbackUrl, { method: 'GET' }));
            }
        });

        if (feedbackPromises.length === 0) {
            messageElement.textContent = '記事を選択してください。';
            messageElement.className = 'error';
            submitButton.disabled = false;
            submitButton.classList.remove('loading');
            return;
        }

        try {
            const responses = await Promise.all(feedbackPromises);
            const allOk = responses.every(res => res.ok);

            if (allOk) {
                messageElement.textContent = '選択結果が送信されました。';
                messageElement.className = '';

                // 選択された記事IDを取得してスコア計算APIを呼び出す
                const selectedArticleIds = [];
                articlesListDiv.querySelectorAll('.article-item').forEach(articleItem => {
                    const articleId = articleItem.querySelector('input[type="radio"]').name.split('-')[1];
                    const selectedInterest = articleItem.querySelector(`input[name="interest-${articleId}"]:checked`);
                    if (selectedInterest) {
                        selectedArticleIds.push(articleId);
                    }
                });

                if (selectedArticleIds.length > 0) {
                    try {
                        const scoreResponse = await fetch('/api/preference-score', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                userId: userId,
                                selectedArticleIds: selectedArticleIds
                            })
                        });

                        if (scoreResponse.ok) {
                            const { score } = await scoreResponse.json();
                            displayPreferenceScore(score);
                        } else {
                            console.warn('Failed to calculate preference score:', scoreResponse.statusText);
                        }
                    } catch (scoreError) {
                        console.error('Error calculating preference score:', scoreError);
                    }
                }

                // ページをリロードして更新されたスコアを表示
                setTimeout(() => {
                    window.location.reload();
                }, 1000); // 1秒後にリロード
            } else {
                const failedResponses = responses.filter(res => !res.ok);
                const errorMessages = await Promise.all(failedResponses.map(res => res.text()));
                throw new Error(`一部のフィードバックの送信に失敗しました: ${errorMessages.join(', ')}`);
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

    // 好みスコアを表示する関数
    function displayPreferenceScore(score) {
        const scoreElement = document.getElementById('preference-score');
        const progressFill = scoreElement.querySelector('.progress-fill');
        const scoreText = scoreElement.querySelector('.score-text');

        // スコアを0-100の範囲に制限
        const clampedScore = Math.max(0, Math.min(100, score));

        // プログレスバーの幅を更新
        progressFill.style.width = `${clampedScore}%`;

        // スコアテキストを更新
        scoreText.textContent = `${clampedScore.toFixed(1)}%`;

        // スコア表示エリアを表示
        scoreElement.style.display = 'block';

        // スコアに応じて色を変更（オプション）
        if (clampedScore >= 70) {
            scoreText.style.color = '#28a745'; // 緑
        } else if (clampedScore >= 40) {
            scoreText.style.color = '#ffc107'; // 黄色
        } else {
            scoreText.style.color = '#dc3545'; // 赤
        }
    }

    fetchDissimilarArticles();
    fetchCurrentPreferenceScore();
});
