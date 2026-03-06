import { useState } from 'hono/jsx'

export default function EducationClient({ userId, initialLambda, initialArticles, initialNewArticles, initialScore }: any) {
    const [activeTab, setActiveTab] = useState('recommended')
    const [lambda, setLambda] = useState(initialLambda)
    const [score, setScore] = useState(initialScore)
    const [articles, setArticles] = useState(Array.isArray(initialArticles) ? initialArticles : [])
    const [newArticles, setNewArticles] = useState(Array.isArray(initialNewArticles) ? initialNewArticles : [])

    // For recommended tab
    const [feedbackData, setFeedbackData] = useState<Record<string, string>>({})
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [isResetting, setIsResetting] = useState(false)

    // For new discoveries
    const [newFeedbackData, setNewFeedbackData] = useState<Record<string, string>>({})
    const [isSubmittingNew, setIsSubmittingNew] = useState(false)

    const handleRecommendedChange = (articleId: string, interest: string) => {
        setFeedbackData(prev => ({ ...prev, [articleId]: interest }))
    }

    const handleNewDiscoveryChange = (articleId: string, interest: string) => {
        setNewFeedbackData(prev => ({ ...prev, [articleId]: interest }))
    }

    const submitRecommended = async () => {
        setIsSubmitting(true)
        const feedbackEntries = Object.entries(feedbackData).map(([articleId, feedback]) => ({ articleId, feedback }))
        const selectedArticleIds = feedbackEntries.filter(f => f.feedback === 'interested').map(f => f.articleId)

        if (feedbackEntries.length === 0) {
            alert('記事を選択してください。')
            setIsSubmitting(false)
            return
        }

        try {
            await fetch('/track-feedback-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, feedbackData: feedbackEntries, immediateUpdate: true })
            })

            if (selectedArticleIds.length > 0) {
                const selectedArticles = articles.filter((a: any) => selectedArticleIds.includes(a.articleId))
                localStorage.setItem('selectedArticles', JSON.stringify(selectedArticles))
                window.open(`/selected-articles?userId=${userId}`, '_blank')
            }
            window.location.reload()
        } catch (error) {
            console.error('Error submitting feedback:', error)
            alert('送信に失敗しました。')
            setIsSubmitting(false)
        }
    }

    const submitNewFeedback = async () => {
        if (Object.keys(newFeedbackData).length === 0) return
        setIsSubmittingNew(true)

        const feedbackEntries = Object.entries(newFeedbackData).map(([articleId, feedback]) => {
            const article = newArticles.find((a: any) => a.articleId === articleId)
            return { article, feedback }
        }).filter(f => f.article)

        try {
            const response = await fetch('/submit-education-feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, feedbackData: feedbackEntries })
            })

            if (response.ok) {
                const result = await response.json() as any
                if (result.errors && result.errors > 0) {
                    alert(result.message || `フィードバックを受け付けました。${result.processed}件中${result.learned}件の学習を完了しました。`)
                }
                const interestedArticles = feedbackEntries.filter(item => item.feedback === 'interested').map(item => item.article)
                if (interestedArticles.length > 0) {
                    localStorage.setItem('selectedArticles', JSON.stringify(interestedArticles))
                    window.open(`/selected-articles?userId=${userId}`, '_blank')
                }
                window.location.reload()
            } else {
                alert('フィードバックの送信に失敗しました。')
                setIsSubmittingNew(false)
            }
        } catch (error) {
            console.error('Error submitting new feedback:', error)
            alert('エラーが発生しました。')
            setIsSubmittingNew(false)
        }
    }

    const resetData = async () => {
        if (!confirm('本当に学習データをリセットしますか？この操作は取り消せません。')) return
        setIsResetting(true)
        try {
            const response = await fetch('/api/reset-user-data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId })
            })
            if (response.ok) {
                alert('データをリセットしました。ページを再読み込みします。')
                window.location.reload()
            } else {
                throw new Error('Reset failed')
            }
        } catch (error) {
            console.error('Error resetting data:', error)
            alert('リセットに失敗しました。')
            setIsResetting(false)
        }
    }

    return (
        <div>
            <div class="tabs">
                <button
                    class={`tab-button ${activeTab === 'recommended' ? 'active' : ''}`}
                    onClick={() => setActiveTab('recommended')}
                >
                    おすすめ
                </button>
                <button
                    class={`tab-button ${activeTab === 'new-discoveries' ? 'active' : ''}`}
                    onClick={() => setActiveTab('new-discoveries')}
                >
                    新着・探索
                </button>
            </div>

            {activeTab === 'recommended' && (
                <div id="recommended-tab" class="tab-content active">
                    <div id="mmr-settings" style={{ marginTop: '20px', padding: '15px', backgroundColor: '#f8f9fa', borderRadius: '8px', border: '1px solid #dee2e6' }}>
                        <h3 style={{ margin: '0 0 10px 0', color: '#495057' }}>現在のMMR設定</h3>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                            <div style={{ flex: 1 }}>
                                <div class="progress-bar" style={{ width: '100%', height: '20px', backgroundColor: '#e9ecef', borderRadius: '10px', overflow: 'hidden' }}>
                                    <div class="progress-fill" style={{ height: '100%', background: 'linear-gradient(90deg, #007bff 0%, #28a745 50%, #ffc107 100%)', borderRadius: '10px', transition: 'width 0.3s ease', width: `${lambda * 100}%` }}></div>
                                </div>
                            </div>
                            <div class="lambda-text" style={{ fontSize: '18px', fontWeight: 'bold', color: '#495057', minWidth: '100px', textAlign: 'center' }}>
                                λ: <span id="lambda-value">{lambda.toFixed(2)}</span>
                            </div>
                        </div>
                        <p style={{ margin: '10px 0 0 0', fontSize: '14px', color: '#6c757d' }}>探索性（新しい記事の発見）と類似性（興味のある記事の推薦）のバランス。左（0）は探索重視、右（1）は類似性重視です。（システムが自動調整します）</p>
                    </div>

                    <div id="danger-zone" style={{ marginTop: '40px', padding: '15px', border: '1px solid #dc3545', borderRadius: '8px' }}>
                        <h3 style={{ color: '#dc3545', marginTop: 0 }}>Danger Zone (データリセット)</h3>
                        <p>学習したモデルとプロファイルを初期状態に戻します。これまでのフィードバック学習はリセットされますが、ログは保持されます。</p>
                        <button id="reset-button" onClick={resetData} disabled={isResetting} style={{ backgroundColor: '#dc3545', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '5px', cursor: 'pointer' }}>
                            {isResetting ? 'リセット中...' : '学習データをリセットする'}
                        </button>
                    </div>

                    <div id="alignment-score" style={{ marginTop: '20px', padding: '15px', backgroundColor: '#f8f9fa', borderRadius: '8px', border: '1px solid #dee2e6' }}>
                        <h3 style={{ margin: '0 0 10px 0', color: '#495057' }}>AI予測精度 (Alignment Score)</h3>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                            <div style={{ flex: 1 }}>
                                <div class="progress-bar" style={{ width: '100%', height: '20px', backgroundColor: '#e9ecef', borderRadius: '10px', overflow: 'hidden' }}>
                                    <div class="progress-fill" id="score-fill" style={{ height: '100%', background: score < 60 ? 'linear-gradient(90deg, #dc3545, #ffc107)' : score < 80 ? 'linear-gradient(90deg, #ffc107, #28a745)' : '#28a745', borderRadius: '10px', transition: 'width 0.3s ease', width: `${Math.max(0, Math.min(100, score))}%` }}></div>
                                </div>
                            </div>
                            <div class="score-text" id="score-value" style={{ fontSize: '24px', fontWeight: 'bold', color: '#495057', minWidth: '80px', textAlign: 'center' }}>
                                {(score / 100).toFixed(2)}
                            </div>
                        </div>
                        <p style={{ margin: '10px 0 0 0', fontSize: '14px', color: '#6c757d' }}>あなたの最近のフィードバックと、現在のAIモデル（興味ベクトル）の整合性をAUC (0.5 - 1.0) で示しています。0.5はランダム、1.0は完璧に予測できている状態です。</p>
                    </div>

                    <div id="articles-list">
                        {articles.length === 0 ? (
                            <div class="no-articles">表示できる記事がありません。スライダーを調整するか、「新着・探索」タブを試してください。</div>
                        ) : (
                            articles.map((article: any) => {
                                const checkedVal = feedbackData[article.articleId];
                                return (
                                    <div class="article-item" data-article-id={article.articleId}>
                                        <div class="article-main-content">
                                            <div class="article-content">
                                                <h3 style={{ marginTop: 0 }}><a href={article.link} target="_blank" style={{ textDecoration: 'none', color: '#007bff' }}>{article.title}</a></h3>
                                                <p style={{ margin: '5px 0' }}>{article.summary || '要約はありません。'}</p>
                                                <p style={{ fontSize: '0.8em', color: '#888', marginTop: '5px' }}>
                                                    {article.sourceName || ''} {new Date(article.publishedAt).toLocaleDateString()}
                                                </p>
                                            </div>
                                        </div>
                                        <div class="interest-selection">
                                            <label class={`radio-label interested-label ${checkedVal && checkedVal !== 'interested' ? 'deselected' : ''}`}>
                                                <input type="radio" name={`rec-interest-${article.articleId}`} value="interested" onChange={() => handleRecommendedChange(article.articleId, 'interested')} />
                                                <span>興味あり</span>
                                            </label>
                                            <label class={`radio-label not-interested-label ${checkedVal && checkedVal !== 'not_interested' ? 'deselected' : ''}`}>
                                                <input type="radio" name={`rec-interest-${article.articleId}`} value="not_interested" onChange={() => handleRecommendedChange(article.articleId, 'not_interested')} />
                                                <span>興味なし</span>
                                            </label>
                                        </div>
                                    </div>
                                )
                            })
                        )}
                    </div>

                    <button id="submit-button" class={`submit-button ${isSubmitting ? 'loading' : ''}`} onClick={submitRecommended} disabled={Object.keys(feedbackData).length === 0 || isSubmitting}>
                        <span class="button-text">選択した記事を送信</span>
                        {isSubmitting && <div class="spinner"></div>}
                    </button>
                </div>
            )}

            {activeTab === 'new-discoveries' && (
                <div id="new-discoveries-tab" class="tab-content active">
                    <div id="new-articles-list">
                        {newArticles.length === 0 ? (
                            <div class="no-articles">現在、新しい記事はありません。</div>
                        ) : (
                            newArticles.map((article: any) => {
                                const checkedVal = newFeedbackData[article.articleId];
                                return (
                                    <div class="article-item" data-article-id={article.articleId}>
                                        <div class="article-main-content">
                                            <div class="article-content">
                                                <h3 style={{ marginTop: 0 }}><a href={article.link} target="_blank" style={{ textDecoration: 'none', color: '#007bff' }}>{article.title}</a></h3>
                                                <p style={{ margin: '5px 0' }}>{article.summary || '要約はありません。'}</p>
                                                <p style={{ fontSize: '0.8em', color: '#888', marginTop: '5px' }}>
                                                    {article.sourceName || ''} {new Date(article.publishedAt).toLocaleDateString()}
                                                </p>
                                            </div>
                                        </div>
                                        <div class="interest-selection">
                                            <label class={`radio-label interested-label ${checkedVal && checkedVal !== 'interested' ? 'deselected' : ''}`}>
                                                <input type="radio" name={`new-interest-${article.articleId}`} value="interested" onChange={() => handleNewDiscoveryChange(article.articleId, 'interested')} />
                                                <span>興味あり</span>
                                            </label>
                                            <label class={`radio-label not-interested-label ${checkedVal && checkedVal !== 'not_interested' ? 'deselected' : ''}`}>
                                                <input type="radio" name={`new-interest-${article.articleId}`} value="not_interested" onChange={() => handleNewDiscoveryChange(article.articleId, 'not_interested')} />
                                                <span>興味なし</span>
                                            </label>
                                        </div>
                                    </div>
                                )
                            })
                        )}
                    </div>
                    <button id="submit-new-feedback" class={`submit-button ${isSubmittingNew ? 'loading' : ''}`} onClick={submitNewFeedback} disabled={Object.keys(newFeedbackData).length === 0 || isSubmittingNew}>
                        <span class="button-text">フィードバックを送信 {Object.keys(newFeedbackData).length > 0 ? `(${Object.keys(newFeedbackData).length})` : ''}</span>
                        {isSubmittingNew && <div class="spinner"></div>}
                    </button>
                </div>
            )}
            <style>{`
                .tabs {
                    display: flex;
                    margin-bottom: 20px;
                    border-bottom: 2px solid #eee;
                }
                .tab-button {
                    padding: 10px 20px;
                    background: none;
                    border: none;
                    border-bottom: 2px solid transparent;
                    cursor: pointer;
                    font-size: 16px;
                    font-weight: bold;
                    color: #666;
                    transition: all 0.3s ease;
                }
                .tab-button:hover {
                    color: #333;
                    background-color: #f9f9f9;
                }
                .tab-button.active {
                    color: #007bff;
                    border-bottom-color: #007bff;
                }
                .deselected { opacity: 0.5; }
            `}</style>
        </div>
    )
}
