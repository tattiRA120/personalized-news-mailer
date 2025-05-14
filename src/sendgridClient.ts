// src/sendgridClient.ts

export interface EmailRecipient {
    email: string;
    name?: string;
}

interface EmailContent {
    type: string; // e.g., "text/plain", "text/html"
    value: string;
}

interface SendEmailRequest {
    personalizations: Array<{
        to: EmailRecipient[];
        subject?: string;
    }>;
    from: EmailRecipient;
    content: EmailContent[];
    // Add other SendGrid options as needed (e.g., reply_to, attachments, tracking_settings)
}

// Assuming a Worker Secret binding named 'SENDGRID_API_KEY'
// Add this binding to your wrangler.jsonc:
// "vars": { "SENDGRID_API_KEY": "your_sendgrid_api_key" } // Or use secrets

export async function sendEmail(to: EmailRecipient[], from: EmailRecipient, subject: string, htmlContent: string, env: { SENDGRID_API_KEY?: string }): Promise<boolean> {
    if (!env.SENDGRID_API_KEY) {
        console.error('SENDGRID_API_KEY is not set.');
        return false;
    }

    const url = 'https://api.sendgrid.com/v3/mail/send';

    const requestBody: SendEmailRequest = {
        personalizations: [{
            to: to,
            subject: subject,
        }],
        from: from,
        content: [{
            type: 'text/html',
            value: htmlContent,
        }],
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.SENDGRID_API_KEY}`,
            },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Error sending email: ${response.statusText}`, errorText);
            return false;
        }

        console.log('Email sent successfully.');
        return true;

    } catch (error) {
        console.error('Exception when sending email:', error);
        return false;
    }
}
