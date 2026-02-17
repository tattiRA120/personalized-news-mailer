const container = document.getElementById('card-container');
const noMoreCards = document.getElementById('no-more-cards');
const loadingState = document.querySelector('.loading-state');
const learnedCountEl = document.getElementById('learned-count');
const levelProgress = document.getElementById('level-progress');
const headerContent = document.querySelector('.header-content');

let articles = [];
let cards = []; // DOM elements
let learnedCount = 0;
let currentLevel = 1;
const userId = new URLSearchParams(window.location.search).get('userId') || 'test-user';
const feedbackSuccess = new URLSearchParams(window.location.search).get('feedback_success');
const feedbackArticleId = new URLSearchParams(window.location.search).get('articleId');

document.addEventListener('DOMContentLoaded', async () => {
    // Check for level up immediately if just redirected
    if (feedbackSuccess && feedbackArticleId) {
        showToast('フィードバックを記録しました！');
    }

    await loadAttributes();
    await fetchArticles();
});

async function loadAttributes() {
    try {
        const response = await fetch(`/api/user-stats?userId=${encodeURIComponent(userId)}`);
        if (response.ok) {
            const data = await response.json();
            learnedCount = data.educationCount || 0;
            updateStatsUI(false); // Don't animate on initial load
        }
    } catch (e) {
        console.error('Failed to load stats', e);
    }
}

async function fetchArticles() {
    try {
        const response = await fetch(`/get-articles-for-education?userId=${encodeURIComponent(userId)}`);
        if (!response.ok) throw new Error('Failed to fetch');
        const data = await response.json();

        const fetchedArticles = Array.isArray(data) ? data : (data.articles || []);
        articles = fetchedArticles.filter(a => a.articleId !== feedbackArticleId);

        loadingState.classList.add('hidden');

        if (articles.length === 0) {
            noMoreCards.classList.remove('hidden');
        } else {
            initCards();
        }
    } catch (e) {
        console.error(e);
        loadingState.innerHTML = '<p>読み込みエラーが発生しました。</p>';
    }
}

function initCards() {
    renderStack();
}

function renderStack() {
    container.innerHTML = '';
    container.appendChild(loadingState);
    container.appendChild(noMoreCards);

    const stack = articles.slice(0, 5).reverse();

    stack.forEach((article, index) => {
        const card = createCard(article, index);
        container.appendChild(card);
        cards.push(card);
    });

    if (articles.length === 0) {
        noMoreCards.classList.remove('hidden');
    } else {
        setupTopCardInteractions();
    }
}

function createCard(article, index) {
    const el = document.createElement('div');
    el.classList.add('card');
    const imgUrl = article.imageUrl || `https://via.placeholder.com/400x300?text=${encodeURIComponent(article.sourceName || 'News')}`;

    el.innerHTML = `
        <div class="card-image" style="background-image: url('${imgUrl}')">
            <span class="source-badge">${article.sourceName || 'Unknown Source'}</span>
        </div>
        <div class="card-content">
            <h2 class="card-title">${article.title}</h2>
            <p class="card-summary">${article.summary || '要約はありません。'}</p>
            <div class="card-meta">${new Date(article.publishedAt).toLocaleDateString()}</div>
        </div>
        <div class="status-overlay status-like">LIKE</div>
        <div class="status-overlay status-nope">NOPE</div>
    `;
    return el;
}

function setupTopCardInteractions() {
    const cardsInDom = document.querySelectorAll('.card');
    if (cardsInDom.length === 0) return;

    const topCard = cardsInDom[cardsInDom.length - 1];
    if (!topCard) return;

    let isDragging = false;
    let startX = 0;
    let currentX = 0;

    const onStart = (x) => {
        isDragging = true;
        startX = x;
        topCard.style.transition = 'none';
    };

    const onMove = (x) => {
        if (!isDragging) return;
        currentX = x - startX;
        updateCardTransform(topCard, currentX);
    };

    const onEnd = () => {
        if (!isDragging) return;
        isDragging = false;
        topCard.style.transition = 'transform 0.3s ease';
        handleSwipeEnd(topCard, currentX);
        currentX = 0;
    };

    topCard.addEventListener('touchstart', (e) => onStart(e.touches[0].clientX));
    topCard.addEventListener('touchmove', (e) => onMove(e.touches[0].clientX));
    topCard.addEventListener('touchend', onEnd);

    topCard.addEventListener('mousedown', (e) => {
        onStart(e.clientX);
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => onMove(e.clientX));
    document.addEventListener('mouseup', onEnd);
}

function updateCardTransform(card, x) {
    const rotate = x * 0.1;
    card.style.transform = `translateX(${x}px) rotate(${rotate}deg)`;

    const likeOverlay = card.querySelector('.status-like');
    const nopeOverlay = card.querySelector('.status-nope');

    if (x > 0) {
        likeOverlay.style.opacity = Math.min(x / 100, 1);
        nopeOverlay.style.opacity = 0;
    } else {
        nopeOverlay.style.opacity = Math.min(Math.abs(x) / 100, 1);
        likeOverlay.style.opacity = 0;
    }
}

function handleSwipeEnd(card, x) {
    const threshold = 100;
    if (x > threshold) {
        swipeRight(card);
    } else if (x < -threshold) {
        swipeLeft(card);
    } else {
        card.style.transform = '';
        card.querySelector('.status-like').style.opacity = 0;
        card.querySelector('.status-nope').style.opacity = 0;
    }
}

async function swipeRight(card) {
    card.style.transform = 'translateX(1000px) rotate(30deg)';
    await processFeedback(getFullArticleFromCard(card), 'interested');
    removeCard(card);
}

async function swipeLeft(card) {
    card.style.transform = 'translateX(-1000px) rotate(-30deg)';
    await processFeedback(getFullArticleFromCard(card), 'not_interested');
    removeCard(card);
}

function getFullArticleFromCard(card) {
    return articles[0];
}

function removeCard(card) {
    setTimeout(() => {
        card.remove();
        articles.shift();

        if (articles.length === 0) {
            noMoreCards.classList.remove('hidden');
        } else {
            renderStack();
        }

        learnedCount++;
        updateStatsUI(true);
    }, 300);
}

async function processFeedback(article, feedback) {
    try {
        await fetch('/track-feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId,
                immediateUpdate: false,
                feedbackData: [{
                    articleId: article.articleId,
                    feedback: feedback
                }]
            })
        });
    } catch (e) {
        console.error('Feedback send failed', e);
    }
}

document.getElementById('btn-nope').addEventListener('click', () => {
    const cards = document.querySelectorAll('.card');
    if (cards.length > 0) swipeLeft(cards[cards.length - 1]);
});

document.getElementById('btn-like').addEventListener('click', () => {
    const cards = document.querySelectorAll('.card');
    if (cards.length > 0) swipeRight(cards[cards.length - 1]);
});

document.getElementById('btn-super').addEventListener('click', () => {
    if (articles.length > 0) {
        window.open(articles[0].link, '_blank');
    }
});

// --- Level Up Logic ---
const LEVELS = [0, 10, 30, 60, 100, 150, 200, 300, 500];

function calculateLevel(count) {
    for (let i = LEVELS.length - 1; i >= 0; i--) {
        if (count >= LEVELS[i]) return i + 1;
    }
    return 1;
}

function getNextLevelThreshold(level) {
    return LEVELS[level] || LEVELS[LEVELS.length - 1] * 2;
}

function updateStatsUI(animate) {
    const newLevel = calculateLevel(learnedCount);
    const prevLevelThreshold = LEVELS[newLevel - 1] || 0;
    const nextLevelThreshold = getNextLevelThreshold(newLevel);

    // Progress within current level
    const progressPercent = ((learnedCount - prevLevelThreshold) / (nextLevelThreshold - prevLevelThreshold)) * 100;

    learnedCountEl.textContent = learnedCount;
    levelProgress.style.width = `${Math.min(100, Math.max(0, progressPercent))}%`;

    // Check for level up
    if (animate && newLevel > currentLevel) {
        showLevelUpModal(newLevel);
    }

    currentLevel = newLevel;
    updateLevelDisplay();
}

function updateLevelDisplay() {
    // Add or update level badge in header if not exists
    let levelBadge = document.getElementById('level-badge');
    if (!levelBadge) {
        levelBadge = document.createElement('span');
        levelBadge.id = 'level-badge';
        levelBadge.className = 'level-badge';
        document.querySelector('.stats').prepend(levelBadge);
    }
    levelBadge.textContent = `Lv.${currentLevel}`;
}

function showLevelUpModal(level) {
    const modal = document.createElement('div');
    modal.className = 'level-up-modal';
    modal.innerHTML = `
        <div class="level-up-content">
            <div class="level-up-icon">🎉</div>
            <h2>LEVEL UP!</h2>
            <p>AIトレーナーレベル ${level} になりました！</p>
            <p class="stats-detail">累計 ${learnedCount} 記事を仕分けしました</p>
            <button onclick="this.closest('.level-up-modal').remove()">続ける</button>
        </div>
    `;
    document.body.appendChild(modal);

    // Add fanfare sound if possible? (Simulate for now)
    // confetti effect could be added here
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    setTimeout(() => {
        toast.classList.add('hidden');
    }, 3000);
}
