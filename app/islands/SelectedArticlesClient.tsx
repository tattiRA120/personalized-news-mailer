import { useState } from 'hono/jsx'

interface Article {
    articleId: string
    title: string
    link: string
    summary?: string
}

export default function SelectedArticlesClient() {
    const [articles] = useState<Article[]>(() => {
        if (typeof window === 'undefined') return []
        try {
            const stored = localStorage.getItem('selectedArticles')
            const parsed = stored ? JSON.parse(stored) : []
            localStorage.removeItem('selectedArticles')
            return parsed
        } catch {
            return []
        }
    })

    if (articles.length === 0) {
        return <p>選択された記事がありません。</p>
    }

    return (
        <div>
            {articles.map((article) => (
                <div class="article-item" key={article.articleId}>
                    <div class="article-content">
                        <h3
                            style={{ cursor: 'pointer', color: '#007bff' }}
                            onClick={() => window.open(article.link, '_blank')}
                        >
                            {article.title}
                        </h3>
                        <p>{article.summary || ''}</p>
                    </div>
                </div>
            ))}
        </div>
    )
}
