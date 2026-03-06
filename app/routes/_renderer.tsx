/// <reference types="vite/client" />
import { jsxRenderer } from 'hono/jsx-renderer'
import { Script, HasIslands } from 'honox/server'
import '../styles/global.css'

export default jsxRenderer(({ children, title }) => {
    return (
        <html lang='ja'>
            <head>
                <meta charset='UTF-8' />
                <meta name='viewport' content='width=device-width, initial-scale=1.0' />
                <title>{title || 'Personalized Education'}</title>

                {import.meta.env.PROD ? (
                    <HasIslands>
                        <script type='module' src='/static/client.js'></script>
                    </HasIslands>
                ) : (
                    <script type='module' src='/app/client.ts'></script>
                )}
            </head>
            <body>{children}</body>
        </html>
    )
})
