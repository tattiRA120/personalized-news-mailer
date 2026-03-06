import { createRoute } from 'honox/factory'
import { getArticlesForEducationData } from '../../src/services/articleFetchService'
import EducationSwipeClient from '../islands/EducationSwipeClient'
import { Env } from '../../src/types/bindings'
import '../styles/education.css'

export default createRoute(async (c) => {
    const userId = c.req.query('userId') || 'test-user';
    const feedbackSuccess = c.req.query('feedback_success');
    const feedbackArticleId = c.req.query('articleId');

    const env = c.env as Env;
    const newDiscoveriesData = await getArticlesForEducationData(env, userId);

    return c.render(
        <div class="app-container" style={{ width: '100vw', height: '100vh', margin: 0, padding: 0 }}>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet" />
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />

            <EducationSwipeClient
                userId={userId}
                initialArticles={newDiscoveriesData.articles}
                feedbackSuccess={feedbackSuccess}
                feedbackArticleId={feedbackArticleId}
            />
        </div>,
        { title: 'AI教育 - 記事仕分け' }
    )
})
