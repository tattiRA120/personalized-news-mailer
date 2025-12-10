const userId = new URLSearchParams(window.location.search).get('userId') || 'test-user';
let lambda = 0.5;
let articles = [];
let newArticles = []; // For New Discoveries tab
let newArticlesFeedback = new Map(); // Map<articleId, 'interested' | 'not_interested'>

// DOM Elements
const recommendedTabBtn = document.querySelector('.tab-button[data-tab="recommended"]');
const newDiscoveriesTabBtn = document.querySelector('.tab-button[data-tab="new-discoveries"]');
const recommendedTabContent = document.getElementById('recommended-tab');
const newDiscoveriesTabContent = document.getElementById('new-discoveries-tab');
const articlesList = document.getElementById('articles-list');
const newArticlesList = document.getElementById('new-articles-list');
const scoreValue = document.getElementById('score-value');
const scoreFill = document.getElementById('score-fill');
const submitButton = document.getElementById('submit-button'); // Recommended tab submit
const submitNewFeedbackBtn = document.getElementById('submit-new-feedback'); // New Discoveries tab submit

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
    setupTabs();
    await fetchMMRSettings();
    await fetchPersonalizedArticles(); // Load recommended by default
});

function setupTabs() {
    recommendedTabBtn.addEventListener('click', () => switchTab('recommended'));
    newDiscoveriesTabBtn.addEventListener('click', () => switchTab('new-discoveries'));
}

async function switchTab(tabName) {
    if (tabName === 'recommended') {
        recommendedTabBtn.classList.add('active');
        newDiscoveriesTabBtn.classList.remove('active');
        recommendedTabContent.classList.add('active');
        newDiscoveriesTabContent.classList.remove('active');
    } else {
        recommendedTabBtn.classList.remove('active');
        newDiscoveriesTabBtn.classList.add('active');
        recommendedTabContent.classList.remove('active');
        newDiscoveriesTabContent.classList.add('active');

        if (newArticles.length === 0) {
            await fetchNewArticles();
        }
    }
}

// --- Recommended Tab Logic ---

async function fetchMMRSettings() {
    try {
        const response = await fetch(`/api/mmr-settings?userId=${encodeURIComponent(userId)}`);
        if (response.ok) {
            const data = await response.json();
            lambda = data.lambda;

            const lambdaValue = document.getElementById('lambda-value');
            if (lambdaValue) lambdaValue.textContent = lambda.toFixed(2); // Format to 2 decimal places

            const mmrSettingsDiv = document.getElementById('mmr-settings');
            if (mmrSettingsDiv) {
                const progressFill = mmrSettingsDiv.querySelector('.progress-fill');
                if (progressFill) {
                    progressFill.style.width = `${lambda * 100}%`;
                }
            }
        }
    } catch (error) {
        console.error('Error fetching MMR settings:', error);
    }
}


function updateScoreDisplay(score) {
    if (scoreValue) scoreValue.textContent = `${Math.round(score)}%`;
    if (scoreFill) {
        scoreFill.style.width = `${score}%`;
        if (score < 30) {
            scoreFill.style.backgroundColor = '#ff4d4d'; // Red
        } else if (score < 70) {
            scoreFill.style.backgroundColor = '#ffa600'; // Orange
        } else {
            scoreFill.style.backgroundColor = '#4caf50'; // Green
        }
    }
}

async function fetchPersonalizedArticles() {
    articlesList.innerHTML = '<div class="loading">記事を読み込んでいます...</div>';
    try {
        const response = await fetch(`/get-personalized-articles?userId=${encodeURIComponent(userId)}&lambda=${lambda}`);
        if (!response.ok) throw new Error('Failed to fetch articles');

        const data = await response.json();
        if (Array.isArray(data)) {
            articles = data;
            // Legacy handling: keep existing score or fetch it?
            // Since backend is updated, this case shouldn't happen unless rollback.
        } else {
            articles = data.articles || [];
            if (typeof data.score === 'number') {
                updateScoreDisplay(data.score);
            }
        }

        renderArticles();
    } catch (error) {
        articlesList.innerHTML = `<div class="error">記事の読み込みに失敗しました: ${error.message}</div>`;
    }
}

function renderArticles() {
    articlesList.innerHTML = '';
    if (articles.length === 0) {
        articlesList.innerHTML = '<div class="no-articles">表示できる記事がありません。スライダーを調整するか、「新着・探索」タブを試してください。</div>';
        return;
    }

    articles.forEach(article => {
        const articleItem = createArticleItem(article, 'recommended');
        articlesList.appendChild(articleItem);
    });

    // Reset submit button
    submitButton.disabled = true;
    const textSpan = submitButton.querySelector('.button-text');
    if (textSpan) textSpan.textContent = '選択した記事を送信';
}

// Helper to create article item HTML (Unified UI)
function createArticleItem(article, type) {
    const articleItem = document.createElement('div');
    articleItem.className = 'article-item';
    articleItem.dataset.articleId = article.articleId;

    const articleMainContent = document.createElement('div');
    articleMainContent.className = 'article-main-content';

    const articleContent = document.createElement('div');
    articleContent.className = 'article-content';

    const title = document.createElement('h3');
    const link = document.createElement('a');
    link.href = article.link;
    link.target = '_blank';
    link.textContent = article.title;
    link.style.textDecoration = 'none';
    link.style.color = 'inherit';
    title.appendChild(link);

    const summary = document.createElement('p');
    summary.textContent = article.summary || '要約はありません。';

    const meta = document.createElement('p');
    meta.style.fontSize = '0.8em';
    meta.style.color = '#888';
    meta.style.marginTop = '5px';
    const date = new Date(article.publishedAt);
    const dateStr = !isNaN(date.getTime()) ? date.toLocaleDateString() : '';
    meta.textContent = `${article.sourceName || ''} ${dateStr}`;

    articleContent.appendChild(title);
    articleContent.appendChild(summary);
    articleContent.appendChild(meta);
    articleMainContent.appendChild(articleContent);

    const interestSelection = document.createElement('div');
    interestSelection.className = 'interest-selection';

    // Determine handler based on type
    const handlerName = type === 'recommended' ? 'handleRecommendedChange' : 'handleNewDiscoveryChange';
    const groupName = type === 'recommended' ? `rec-interest-${article.articleId}` : `new-interest-${article.articleId}`;

    // Interested Button
    const interestedLabel = document.createElement('label');
    interestedLabel.className = 'radio-label interested-label';
    interestedLabel.innerHTML = `
        <input type="radio" name="${groupName}" value="interested" onchange="${handlerName}('${article.articleId}', 'interested')">
        <span>興味あり</span>
    `;

    // Not Interested Button
    const notInterestedLabel = document.createElement('label');
    notInterestedLabel.className = 'radio-label not-interested-label';
    notInterestedLabel.innerHTML = `
        <input type="radio" name="${groupName}" value="not_interested" onchange="${handlerName}('${article.articleId}', 'not_interested')">
        <span>興味なし</span>
    `;

    interestSelection.appendChild(interestedLabel);
    interestSelection.appendChild(notInterestedLabel);

    articleItem.appendChild(articleMainContent);
    articleItem.appendChild(interestSelection);

    return articleItem;
}

// Recommended Tab Handler (Batch)
window.handleRecommendedChange = function (articleId, interest) {
    // Just update UI visual state
    const articleItem = document.querySelector(`#articles-list .article-item[data-article-id="${articleId}"]`);
    updateRadioStyles(articleItem);

    // Enable submit button
    submitButton.disabled = false;
};

function updateRadioStyles(articleItem) {
    const radios = articleItem.querySelectorAll('input[type="radio"]');
    radios.forEach(radio => {
        const label = radio.closest('.radio-label');
        if (radio.checked) {
            label.classList.remove('deselected');
        } else {
            label.classList.add('deselected');
        }
    });
}

// Submit Recommended Feedback (Batch)
submitButton.addEventListener('click', async () => {
    submitButton.classList.add('loading');
    submitButton.disabled = true;

    const feedbackPromises = [];
    const selectedArticleIds = [];
    const feedbackData = [];

    articlesList.querySelectorAll('.article-item').forEach(articleItem => {
        const articleId = articleItem.dataset.articleId;
        const selectedInterest = articleItem.querySelector(`input[name="rec-interest-${articleId}"]:checked`);

        if (selectedInterest) {
            feedbackData.push({
                articleId: articleId,
                feedback: selectedInterest.value
            });
            if (selectedInterest.value === 'interested') {
                selectedArticleIds.push(articleId);
            }
        }
    });

    if (feedbackData.length === 0) {
        alert('記事を選択してください。');
        submitButton.classList.remove('loading');
        submitButton.disabled = false;
        return;
    }

    try {
        // Send all feedback in a single batch request
        await fetch('/track-feedback-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, feedbackData, immediateUpdate: true })
        });

        // Update score
        if (selectedArticleIds.length > 0) {
            await fetch('/api/preference-score', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, selectedArticleIds })
            });
        }

        // Reload to refresh recommendations
        window.location.reload();
    } catch (error) {
        console.error('Error submitting feedback:', error);
        alert('送信に失敗しました。');
        submitButton.classList.remove('loading');
        submitButton.disabled = false;
    }
});


// --- New Discoveries Tab Logic ---

async function fetchNewArticles() {
    const newArticlesList = document.getElementById('new-articles-list');
    newArticlesList.innerHTML = '<div class="loading">新しい記事を読み込んでいます...</div>';

    try {
        const response = await fetch(`/get-articles-for-education?userId=${encodeURIComponent(userId)}`);
        if (!response.ok) {
            throw new Error('Failed to fetch new articles');
        }
        const data = await response.json();
        if (Array.isArray(data)) {
            newArticles = data;
        } else {
            newArticles = data.articles || [];
        }
        renderNewArticles();
    } catch (error) {
        console.error('Error fetching new articles:', error);
        newArticlesList.innerHTML = `<div class="error">記事の読み込みに失敗しました: ${error.message}</div>`;
    }
}

function renderNewArticles() {
    newArticlesList.innerHTML = '';
    if (newArticles.length === 0) {
        newArticlesList.innerHTML = '<div class="no-articles">現在、新しい記事はありません。</div>';
        return;
    }

    newArticles.forEach(article => {
        const articleItem = createArticleItem(article, 'new-discovery');
        newArticlesList.appendChild(articleItem);
    });
    updateSubmitButtonState();
}

window.handleNewDiscoveryChange = function (articleId, interest) {
    newArticlesFeedback.set(articleId, interest);

    const articleItem = document.querySelector(`#new-articles-list .article-item[data-article-id="${articleId}"]`);
    updateRadioStyles(articleItem);

    updateSubmitButtonState();
};

function updateSubmitButtonState() {
    submitNewFeedbackBtn.disabled = newArticlesFeedback.size === 0;
    const count = newArticlesFeedback.size;
    const textSpan = submitNewFeedbackBtn.querySelector('.button-text');
    if (textSpan) textSpan.textContent = count > 0 ? `フィードバックを送信 (${count})` : 'フィードバックを送信';
}

submitNewFeedbackBtn.addEventListener('click', async () => {
    if (newArticlesFeedback.size === 0) return;

    submitNewFeedbackBtn.classList.add('loading');
    submitNewFeedbackBtn.disabled = true;

    const feedbackData = [];
    for (const [articleId, feedback] of newArticlesFeedback) {
        const article = newArticles.find(a => a.articleId === articleId);
        if (article) {
            feedbackData.push({ article, feedback });
        }
    }

    try {
        const response = await fetch('/submit-education-feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: userId,
                feedbackData: feedbackData
            })
        });

        if (response.ok) {
            const interestedArticles = feedbackData
                .filter(item => item.feedback === 'interested')
                .map(item => item.article);

            localStorage.setItem('selectedArticles', JSON.stringify(interestedArticles));

            window.location.href = `selected-articles.html?userId=${userId}`;
        } else {
            alert('フィードバックの送信に失敗しました。もう一度お試しください。');
            submitNewFeedbackBtn.classList.remove('loading');
            submitNewFeedbackBtn.disabled = false;
        }
    } catch (error) {
        console.error('Error submitting new feedback:', error);
        alert('エラーが発生しました。もう一度お試しください。');
        submitNewFeedbackBtn.classList.remove('loading');
        submitNewFeedbackBtn.disabled = false;
    }
});
