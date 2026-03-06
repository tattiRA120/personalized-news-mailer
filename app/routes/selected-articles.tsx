import { createRoute } from 'honox/factory'
import SelectedArticlesClient from '../islands/SelectedArticlesClient'

export default createRoute((c) => {
    return c.render(
        <div class="container">
            <h1>選択した記事</h1>
            <p>以下の記事を選択しました。タイトルをクリックすると記事を開けます。</p>
            <SelectedArticlesClient />
            <p id="message"></p>
        </div>,
        { title: '選択した記事' }
    )
})
