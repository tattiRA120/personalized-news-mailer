import { useState, useEffect, useRef } from 'hono/jsx'

export default function EducationSwipeClient({ userId, initialArticles, feedbackSuccess, feedbackArticleId }: any) {
    const [articles, setArticles] = useState(() => {
        const list = Array.isArray(initialArticles) ? initialArticles : []
        return list.filter((a: any) => a.articleId !== feedbackArticleId)
    })
    const [learnedCount, setLearnedCount] = useState(0)
    const [currentLevel, setCurrentLevel] = useState(1)
    const [toastMsg, setToastMsg] = useState('')
    const [showLevelUp, setShowLevelUp] = useState(false)
    const containerRef = useRef<HTMLDivElement | null>(null)

    const LEVELS = [0, 10, 30, 60, 100, 150, 200, 300, 500]

    const calculateLevel = (count: number) => {
        for (let i = LEVELS.length - 1; i >= 0; i--) {
            if (count >= LEVELS[i]) return i + 1;
        }
        return 1;
    }

    const getNextLevelThreshold = (level: number) => {
        return LEVELS[level] || LEVELS[LEVELS.length - 1] * 2;
    }

    const showToast = (msg: string) => {
        setToastMsg(msg)
        setTimeout(() => setToastMsg(''), 3000)
    }

    useEffect(() => {
        if (feedbackSuccess && feedbackArticleId) {
            showToast('フィードバックを記録しました！')
        }

        fetch(`/api/user-stats?userId=${encodeURIComponent(userId)}`)
            .then(res => res.ok ? res.json() : null)
            .then((data: any) => {
                if (data) {
                    const count = data.educationCount || 0
                    setLearnedCount(count)
                    setCurrentLevel(calculateLevel(count))
                }
            })
            .catch(e => console.error('Failed to load stats', e))
    }, [userId])

    useEffect(() => {
        if (!containerRef.current || articles.length === 0) return;
        const cardsInDom = containerRef.current.querySelectorAll('.card');
        if (cardsInDom.length === 0) return;

        const topCard = cardsInDom[cardsInDom.length - 1] as HTMLElement;
        if (!topCard) return;

        let isDragging = false;
        let startX = 0;
        let currentX = 0;

        const onStart = (x: number) => {
            isDragging = true;
            startX = x;
            topCard.style.transition = 'none';
        };

        const onMove = (x: number) => {
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

        const touchStart = (e: any) => onStart(e.touches[0].clientX);
        const touchMove = (e: any) => onMove(e.touches[0].clientX);
        const touchEnd = onEnd;
        const mouseDown = (e: any) => { onStart(e.clientX); e.preventDefault(); };
        const mouseMove = (e: any) => onMove(e.clientX);
        const mouseUp = onEnd;

        topCard.addEventListener('touchstart', touchStart);
        topCard.addEventListener('touchmove', touchMove);
        topCard.addEventListener('touchend', touchEnd);
        topCard.addEventListener('mousedown', mouseDown);
        document.addEventListener('mousemove', mouseMove);
        document.addEventListener('mouseup', mouseUp);

        return () => {
            topCard.removeEventListener('touchstart', touchStart);
            topCard.removeEventListener('touchmove', touchMove);
            topCard.removeEventListener('touchend', touchEnd);
            topCard.removeEventListener('mousedown', mouseDown);
            document.removeEventListener('mousemove', mouseMove);
            document.removeEventListener('mouseup', mouseUp);
        }
    }, [articles])

    const updateCardTransform = (card: HTMLElement, x: number) => {
        const rotate = x * 0.1;
        card.style.transform = `translateX(${x}px) rotate(${rotate}deg)`;

        const likeOverlay = card.querySelector('.status-like') as HTMLElement;
        const nopeOverlay = card.querySelector('.status-nope') as HTMLElement;

        if (likeOverlay && nopeOverlay) {
            if (x > 0) {
                likeOverlay.style.opacity = Math.min(x / 100, 1).toString();
                nopeOverlay.style.opacity = '0';
            } else {
                nopeOverlay.style.opacity = Math.min(Math.abs(x) / 100, 1).toString();
                likeOverlay.style.opacity = '0';
            }
        }
    }

    const handleSwipeEnd = (card: HTMLElement, x: number) => {
        const threshold = 100;
        if (x > threshold) {
            swipeRight(card);
        } else if (x < -threshold) {
            swipeLeft(card);
        } else {
            card.style.transform = '';
            const likeOverlay = card.querySelector('.status-like') as HTMLElement;
            const nopeOverlay = card.querySelector('.status-nope') as HTMLElement;
            if (likeOverlay) likeOverlay.style.opacity = '0';
            if (nopeOverlay) nopeOverlay.style.opacity = '0';
        }
    }

    const processFeedback = async (article: any, feedback: string) => {
        try {
            await fetch('/track-feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId,
                    immediateUpdate: false,
                    feedbackData: [{ articleId: article.articleId, feedback }]
                })
            })
        } catch (e) {
            console.error('Feedback send failed', e);
        }
    }

    const removeTopCard = () => {
        setArticles((prev: any[]) => prev.slice(1));
        setLearnedCount((prev: number) => {
            const nextCount = prev + 1;
            const newLevel = calculateLevel(nextCount);
            if (newLevel > currentLevel) {
                setCurrentLevel(newLevel);
                setShowLevelUp(true);
            }
            return nextCount;
        });
    }

    const swipeRight = async (card: HTMLElement) => {
        card.style.transform = 'translateX(1000px) rotate(30deg)';
        await processFeedback(articles[0], 'interested');
        setTimeout(removeTopCard, 300);
    }

    const swipeLeft = async (card: HTMLElement) => {
        card.style.transform = 'translateX(-1000px) rotate(-30deg)';
        await processFeedback(articles[0], 'not_interested');
        setTimeout(removeTopCard, 300);
    }

    const handleBtnLeft = () => {
        if (!containerRef.current) return;
        const cards = containerRef.current.querySelectorAll('.card');
        if (cards.length > 0) swipeLeft(cards[cards.length - 1] as HTMLElement);
    }

    const handleBtnRight = () => {
        if (!containerRef.current) return;
        const cards = containerRef.current.querySelectorAll('.card');
        if (cards.length > 0) swipeRight(cards[cards.length - 1] as HTMLElement);
    }

    const handleBtnSuper = () => {
        if (articles.length > 0) {
            window.open(articles[0].link, '_blank');
        }
    }

    const prevLevelThreshold = LEVELS[currentLevel - 1] || 0;
    const nextLevelThreshold = getNextLevelThreshold(currentLevel);
    const progressPercent = ((learnedCount - prevLevelThreshold) / (nextLevelThreshold - prevLevelThreshold)) * 100;

    const stack = articles.slice(0, 5).reverse();

    return (
        <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
            <header>
                <div class="header-content">
                    <h1>Mail News AI Trainer</h1>
                    <div class="stats">
                        <span class="level-badge" id="level-badge">Lv.{currentLevel}</span>
                        <span id="learned-count">{learnedCount}</span> 学習済み | Sync: <span id="sync-rate">--</span>%
                    </div>
                </div>
                <div class="progress-container">
                    <div class="progress-bar" id="level-progress" style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}></div>
                </div>
            </header>

            <main id="card-container" ref={containerRef as any}>
                {articles.length === 0 ? (
                    <div id="no-more-cards">
                        <i class="fas fa-check-circle" style={{ fontSize: '48px', color: '#4caf50', marginBottom: '15px' }}></i>
                        <h2>すべての記事をチェックしました！</h2>
                        <p>新しい記事が追加されるまでお待ちください。</p>
                        <button onClick={() => window.location.reload()}>再読み込み</button>
                    </div>
                ) : (
                    stack.map((article: any, index: number) => {
                        const imgUrl = article.imageUrl || `https://via.placeholder.com/400x300?text=${encodeURIComponent(article.sourceName || 'News')}`;
                        return (
                            <div class="card" key={article.articleId}>
                                <div class="card-image" style={{ backgroundImage: `url('${imgUrl}')` }}>
                                    <span class="source-badge">{article.sourceName || 'Unknown Source'}</span>
                                </div>
                                <div class="card-content">
                                    <h2 class="card-title">{article.title}</h2>
                                    <p class="card-summary">{article.summary || '要約はありません。'}</p>
                                    <div class="card-meta">{new Date(article.publishedAt).toLocaleDateString()}</div>
                                </div>
                                <div class="status-overlay status-like" style={{ opacity: 0 }}>LIKE</div>
                                <div class="status-overlay status-nope" style={{ opacity: 0 }}>NOPE</div>
                            </div>
                        )
                    })
                )}
            </main>

            <div class="controls">
                <button id="btn-nope" class="control-btn nope" aria-label="興味なし" onClick={handleBtnLeft}>
                    <i class="fas fa-times"></i>
                </button>
                <button id="btn-super" class="control-btn super" aria-label="詳細を見る" onClick={handleBtnSuper}>
                    <i class="fas fa-external-link-alt"></i>
                </button>
                <button id="btn-like" class="control-btn like" aria-label="興味あり" onClick={handleBtnRight}>
                    <i class="fas fa-heart"></i>
                </button>
            </div>

            {toastMsg && <div id="toast" class="toast">{toastMsg}</div>}

            {showLevelUp && (
                <div class="level-up-modal">
                    <div class="level-up-content">
                        <div class="level-up-icon">🎉</div>
                        <h2>LEVEL UP!</h2>
                        <p>AIトレーナーレベル {currentLevel} になりました！</p>
                        <p class="stats-detail">累計 {learnedCount} 記事を仕分けしました</p>
                        <button onClick={() => setShowLevelUp(false)}>続ける</button>
                    </div>
                </div>
            )}

            <style>{`
            .hidden { display: none !important; }
            `}</style>
        </div>
    )
}
