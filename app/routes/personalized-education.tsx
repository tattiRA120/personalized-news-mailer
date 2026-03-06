import { createRoute } from 'honox/factory'
import { getPersonalizedArticlesData, getArticlesForEducationData } from '../../src/services/articleFetchService'
import EducationClient from '../islands/EducationClient'
import { Env } from '../../src/types/bindings'

export default createRoute(async (c) => {
    const userId = c.req.query('userId') || 'test-user';
    const lambdaParam = c.req.query('lambda');
    let lambda = lambdaParam ? parseFloat(lambdaParam) : 0.5;
    if (isNaN(lambda) || lambda < 0 || lambda > 1) {
        lambda = 0.5;
    }

    const env = c.env as Env;
    // SSR Data Fetching
    const [personalizedData, newDiscoveriesData] = await Promise.all([
        getPersonalizedArticlesData(env, userId, lambda),
        getArticlesForEducationData(env, userId)
    ]);

    return c.render(
        <div class="container">
            <h1>パーソナライズド記事選択</h1>
            <p>あなたの興味に基づいて記事を推薦します。興味のある記事を選択し、送信してください。フィードバックに応じて推薦を改善します。</p>
            <EducationClient
                userId={userId}
                initialLambda={lambda}
                initialArticles={personalizedData.articles}
                initialNewArticles={newDiscoveriesData.articles}
                initialScore={personalizedData.score}
            />
        </div>,
        { title: 'パーソナライズド記事選択' }
    )
})
