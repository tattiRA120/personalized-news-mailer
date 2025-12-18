
import { Hono } from 'hono';
import { Env } from '../types/bindings';
import { getLogger } from '../middlewares/logger';
import { createUserProfile, getUserProfile } from '../userProfile';

const app = new Hono<{ Bindings: Env }>();

// --- User Registration Handler ---
app.post('/register', async (c) => {
    const logger = getLogger(c);
    logger.debug('Registration request received');
    let requestBody;
    try {
        requestBody = await c.req.json();
        logger.debug('Registration request body:', requestBody);
    } catch (jsonError) {
        logger.error('Failed to parse registration request body as JSON:', jsonError);
        return new Response('Invalid JSON in request body', { status: 400 });
    }

    try {
        const { email } = requestBody as { email: string };

        if (!email) {
            logger.warn('Registration failed: Missing email in request body.');
            return new Response('Missing email', { status: 400 });
        }

        // Basic email format validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            logger.warn(`Registration failed: Invalid email format for ${email}.`, { email });
            return new Response('Invalid email format', { status: 400 });
        }

        const encoder = new TextEncoder();
        const data = encoder.encode(email);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const userId = Array.from(new Uint8Array(hashBuffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

        const existingUser = await getUserProfile(userId, c.env);
        if (existingUser) {
            logger.warn(`Registration failed: User with email ${email} already exists.`, { email, userId });
            return new Response('User already exists', { status: 409 });
        }

        c.executionCtx.waitUntil(createUserProfile(userId, email, c.env));
        logger.debug(`User registered successfully: ${userId}`, { userId, email });

        if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_REDIRECT_URI) {
            logger.error('Missing Google OAuth environment variables for consent URL generation.', null);
            return new Response('Server configuration error', { status: 500 });
        }

        const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authUrl.searchParams.set('client_id', c.env.GOOGLE_CLIENT_ID);
        authUrl.searchParams.set('redirect_uri', c.env.GOOGLE_REDIRECT_URI);
        authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.send');
        authUrl.searchParams.set('access_type', 'offline');
        authUrl.searchParams.set('prompt', 'consent');
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('state', userId);

        logger.debug(`Generated OAuth consent URL for user ${userId}`, { userId, authUrl: authUrl.toString() });

        return c.json({ message: 'User registered. Please authorize Gmail access.', authUrl: authUrl.toString() }, 201);

    } catch (error) {
        logger.error('Error during user registration:', error, { requestUrl: c.req.url });
        return new Response('Internal Server Error', { status: 500 });
    }
});

// --- OAuth2 Callback Handler ---
app.get('/oauth2callback', async (c) => {
    const logger = getLogger(c);
    logger.debug('OAuth2 callback request received');

    const code = c.req.query('code');
    const userId = c.req.query('state');

    if (!code) {
        logger.warn('OAuth2 callback failed: Missing authorization code.');
        return new Response('Missing authorization code', { status: 400 });
    }

    if (!userId) {
        logger.warn('OAuth2 callback failed: Missing state parameter (userId).');
        return new Response('Missing state parameter', { status: 400 });
    }

    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET || !c.env.GOOGLE_REDIRECT_URI || !c.env['mail-news-gmail-tokens']) {
        logger.error('Missing Google OAuth environment variables or KV binding.', null);
        return new Response('Server configuration error', { status: 500 });
    }

    try {
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                code: code,
                client_id: c.env.GOOGLE_CLIENT_ID,
                client_secret: c.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: c.env.GOOGLE_REDIRECT_URI,
                grant_type: 'authorization_code',
            }).toString(),
        });

        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            logger.error(`Failed to exchange authorization code for tokens: ${tokenResponse.statusText}`, null, { status: tokenResponse.status, statusText: tokenResponse.statusText, errorText });
            return new Response(`Error exchanging code: ${tokenResponse.statusText}`, { status: tokenResponse.status });
        }

        const tokenData: any = await tokenResponse.json();
        const refreshToken = tokenData.refresh_token;

        if (!refreshToken) {
            logger.warn('No refresh token received. Ensure access_type=offline was requested and this is the first authorization.');
        }

        c.executionCtx.waitUntil(c.env['mail-news-gmail-tokens'].put(`refresh_token:${userId}`, refreshToken));
        logger.debug(`Successfully stored refresh token for user ${userId}.`, { userId });

        return new Response('Authorization successful. You can close this window.', { status: 200 });

    } catch (error) {
        logger.error('Error during OAuth2 callback processing:', error, { userId, requestUrl: c.req.url });
        return new Response('Internal Server Error', { status: 500 });
    }
});

export default app;
