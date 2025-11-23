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
const lambdaSlider = document.getElementById('lambda-slider');
const lambdaValue = document.getElementById('lambda-value');
const scoreValue = document.getElementById('score-value');
const scoreFill = document.getElementById('score-fill');
const submitNewFeedbackBtn = document.getElementById('submit-new-feedback');

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
    setupTabs();
    await fetchMMRSettings();
    await fetchPreferenceScore();
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

// --- Recommended Tab Logic (Existing) ---

lambdaSlider.addEventListener('input', (e) => {
    lambda = e.target.value;
    lambdaValue.textContent = lambda;
});

lambdaSlider.addEventListener('change', async () => {
    // Update backend with new lambda
    try {
        await fetch('/api/calculate-mmr-lambda', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, immediate: true })
        });
        // Re-fetch articles with new lambda
        await fetchPersonalizedArticles();
    } catch (error) {
        console.error('Error updating lambda:', error);
    }
});

async function fetchMMRSettings() {
    try {
        const response = await fetch(`/api/mmr-settings?userId=${encodeURIComponent(userId)}`);
        if (response.ok) {
            const data = await response.json();
            lambda = data.lambda;
            lambdaSlider.value = lambda;
            lambdaValue.textContent = lambda;
        }
    } catch (error) {
        console.error('Error fetching MMR settings:', error);
    }
}

async function fetchPreferenceScore() {
    try {
        const response = await fetch(`/api/preference-score?userId=${encodeURIComponent(userId)}`);
        if (response.ok) {
            const data = await response.json();
            updateScoreDisplay(data.score);
        }
    } catch (error) {
        console.error('Error fetching preference score:', error);
    }
}

function updateScoreDisplay(score) {
    scoreValue.textContent = Math.round(score);
    scoreFill.style.width = `${score}%`;

    // Color coding based on score
    if (score < 30) {
        scoreFill.style.backgroundColor = '#ff4d4d'; // Red
    } else if (score < 70) {
        scoreFill.style.backgroundColor = '#ffa600'; // Orange
    } else {
        scoreFill.style.backgroundColor = '#4caf50'; // Green
    }
}

async function fetchPersonalizedArticles() {
    articlesList.innerHTML = '<div class="loading">Loading articles...</div>';
    try {
        const response = await fetch(`/get-personalized-articles?userId=${encodeURIComponent(userId)}&lambda=${lambda}`);
        if (!response.ok) throw new Error('Failed to fetch articles');
        articles = await response.json();
        renderArticles();
    } catch (error) {
        articlesList.innerHTML = `<div class="error">Error loading articles: ${error.message}</div>`;
    }
}

function renderArticles() {
    articlesList.innerHTML = '';
    if (articles.length === 0) {
        articlesList.innerHTML = '<div class="no-articles">No personalized articles found. Try adjusting the slider or use the "New Discoveries" tab.</div>';
        return;
    }

    articles.forEach(article => {
        const card = document.createElement('div');
        card.className = 'article-card';
        card.innerHTML = `
            <div class="article-content">
                <a href="${article.link}" target="_blank" class="article-title">${article.title}</a>
                <p class="article-summary">${article.summary || 'No summary available.'}</p>
                <div class="article-meta">
                    <span class="source">${article.sourceName || 'Unknown Source'}</span>
                    <span class="date">${new Date(article.publishedAt).toLocaleDateString()}</span>
                </div>
            </div>
            <div class="article-actions">
                <label class="radio-label">
                    <input type="radio" name="interest-${article.articleId}" value="interested" onchange="handleInterestChange('${article.articleId}', 'interested')">
                    Interested
                </label>
                <label class="radio-label">
                    <input type="radio" name="interest-${article.articleId}" value="not_interested" onchange="handleInterestChange('${article.articleId}', 'not_interested')">
                    Not Interested
                </label>
            </div>
        `;
        articlesList.appendChild(card);
    });
}

window.handleInterestChange = async function (articleId, interest) {
    // Immediate feedback for Recommended tab
    try {
        const feedbackUrl = `/track-feedback?userId=${userId}&articleId=${encodeURIComponent(articleId)}&feedback=${interest}&immediateUpdate=true`;
        await fetch(feedbackUrl, { method: 'GET' });

        // Visual feedback
        const card = document.querySelector(`input[name="interest-${articleId}"]`).closest('.article-card');
        card.style.opacity = '0.5';
        card.style.pointerEvents = 'none';

        // Update score
        await fetchPreferenceScore();
    } catch (error) {
        console.error('Error submitting feedback:', error);
    }
};

// --- New Discoveries Tab Logic (New) ---

async function fetchNewArticles() {
    newArticlesList.innerHTML = '<div class="loading">Loading new articles...</div>';
    try {
        const response = await fetch('/get-articles-for-education');
        if (!response.ok) throw new Error('Failed to fetch new articles');
        newArticles = await response.json();
        renderNewArticles();
    } catch (error) {
        newArticlesList.innerHTML = `<div class="error">Error loading new articles: ${error.message}</div>`;
    }
}

function renderNewArticles() {
    newArticlesList.innerHTML = '';
    if (newArticles.length === 0) {
        newArticlesList.innerHTML = '<div class="no-articles">No new articles found at the moment.</div>';
        return;
    }

    newArticles.forEach(article => {
        const card = document.createElement('div');
        card.className = 'new-article-card';
        card.dataset.articleId = article.articleId;
        card.innerHTML = `
            <div class="new-article-header">
                <a href="${article.link}" target="_blank" class="new-article-title">${article.title}</a>
            </div>
            <p class="new-article-summary">${article.summary || 'No summary available.'}</p>
            <div class="feedback-actions">
                <button class="feedback-btn interested" onclick="toggleNewFeedback('${article.articleId}', 'interested')">
                    ❤️ Interested
                </button>
                <button class="feedback-btn not-interested" onclick="toggleNewFeedback('${article.articleId}', 'not_interested')">
                    ❌ Not Interested
                </button>
            </div>
        `;
        newArticlesList.appendChild(card);
    });
    updateSubmitButtonState();
}

window.toggleNewFeedback = function (articleId, type) {
    const currentFeedback = newArticlesFeedback.get(articleId);
    const card = document.querySelector(`.new-article-card[data-article-id="${articleId}"]`);
    const interestedBtn = card.querySelector('.feedback-btn.interested');
    const notInterestedBtn = card.querySelector('.feedback-btn.not-interested');

    if (currentFeedback === type) {
        // Toggle off
        newArticlesFeedback.delete(articleId);
        interestedBtn.classList.remove('active');
        notInterestedBtn.classList.remove('active');
    } else {
        // Set new feedback
        newArticlesFeedback.set(articleId, type);
        if (type === 'interested') {
            interestedBtn.classList.add('active');
            notInterestedBtn.classList.remove('active');
        } else {
            interestedBtn.classList.remove('active');
            notInterestedBtn.classList.add('active');
        }
    }
    updateSubmitButtonState();
};

function updateSubmitButtonState() {
    submitNewFeedbackBtn.disabled = newArticlesFeedback.size === 0;
    const count = newArticlesFeedback.size;
    const textSpan = submitNewFeedbackBtn.querySelector('.button-text');
    textSpan.textContent = count > 0 ? `Submit Feedback (${count})` : 'Submit Feedback';
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

            // Store in localStorage to pass to the next page
            localStorage.setItem('selectedArticles', JSON.stringify(interestedArticles));

            window.location.href = `selected-articles.html?userId=${userId}`;
        } else {
            alert('Failed to submit feedback. Please try again.');
            submitNewFeedbackBtn.classList.remove('loading');
            submitNewFeedbackBtn.disabled = false;
        }
    } catch (error) {
        console.error('Error submitting new feedback:', error);
        alert('An error occurred. Please try again.');
        submitNewFeedbackBtn.classList.remove('loading');
        submitNewFeedbackBtn.disabled = false;
    }
});
