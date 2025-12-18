import type { FC } from 'hono/jsx'

export interface NewsArticleWithImage {
    articleId: string
    title: string
    link: string
    summary?: string
    imageUrl?: string
    trackingLink: string
}

interface NewsEmailProps {
    articles: NewsArticleWithImage[]
    userId: string
    workerBaseUrl: string
}

const css = `
  body { font-family: sans-serif; line-height: 1.6; margin: 0; padding: 20px; background-color: #f4f4f4; }
  .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
  h1 { color: #333; text-align: center; margin-bottom: 20px; }
  .article { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #eee; display: flex; align-items: flex-start; }
  .article:last-child { border-bottom: none; }
  .article-image { width: 120px; height: 120px; object-fit: contain; margin-right: 15px; border-radius: 4px; }
  .article-content { flex-grow: 1; }
  .article h2 { margin-top: 0; margin-bottom: 5px; color: #007bff; font-size: 1.2em; }
  .article a { text-decoration: none; color: #007bff; }
  .article a:hover { text-decoration: underline; }
  .article p { color: #555; font-size: 0.9em; margin-top: 5px; }
  .feedback-buttons { margin-top: 10px; }
  .feedback-buttons a { display: inline-block; padding: 5px 10px; margin-right: 10px; border-radius: 4px; text-decoration: none; color: #fff; font-size: 0.8em; }
  .btn-interested { background-color: #28a745; }
  .btn-not-interested { background-color: #dc3545; }
  .footer { text-align: center; margin-top: 30px; font-size: 0.8em; color: #777; }
  .footer a { color: #007bff; text-decoration: none; }
`

export const NewsEmail: FC<NewsEmailProps> = (props) => {
    return (
        <html lang="en">
            <head>
                <meta charset="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>Your Personalized News Update</title>
                <style dangerouslySetInnerHTML={{ __html: css }} />
            </head>
            <body>
                <div className="container">
                    <h1>Your Daily News Update</h1>
                    <p>こんにちは！あなたのための最新ニュースをお届けします。</p>

                    {props.articles.length === 0 ? (
                        <p>本日の新しい記事は見つかりませんでした。</p>
                    ) : (
                        props.articles.map((article) => (
                            <div className="article" key={article.articleId}>
                                {article.imageUrl && (
                                    <img src={article.imageUrl} alt="Article Image" className="article-image" />
                                )}
                                <div className="article-content">
                                    <h2>
                                        <a href={article.trackingLink}>{article.title}</a>
                                    </h2>
                                    <p>{article.summary || ''}</p>
                                    <div className="feedback-buttons">
                                        <a
                                            href={`${props.workerBaseUrl}/track-feedback?userId=${props.userId}&articleId=${encodeURIComponent(
                                                article.articleId
                                            )}&feedback=interested`}
                                            className="btn-interested"
                                        >
                                            興味がある
                                        </a>
                                        <a
                                            href={`${props.workerBaseUrl}/track-feedback?userId=${props.userId}&articleId=${encodeURIComponent(
                                                article.articleId
                                            )}&feedback=not_interested`}
                                            className="btn-not-interested"
                                        >
                                            興味がない
                                        </a>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </body>
        </html>
    )
}
