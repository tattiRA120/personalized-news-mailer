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

                <Script src='/app/client.ts' />
            </head>
            <body>{children}</body>
        </html>
    )
})
