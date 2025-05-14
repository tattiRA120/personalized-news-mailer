// src/logger.ts

interface ErrorLogEntry {
    timestamp: string;
    level: 'info' | 'warn' | 'error';
    message: string;
    details?: any; // Additional error details or context
    stack?: string; // Error stack trace
}

/**
 * Logs an error with structured details.
 * @param message A brief message describing the error.
 * @param error The error object.
 * @param details Additional context or details related to the error.
 */
export function logError(message: string, error: any, details?: any): void {
    const logEntry: ErrorLogEntry = {
        timestamp: new Date().toISOString(),
        level: 'error',
        message: message,
        details: details,
        stack: error instanceof Error ? error.stack : undefined,
    };

    // Output as JSON string for structured logging
    console.error(JSON.stringify(logEntry));

    // TODO: Integrate with external logging service (e.g., Logflare, Sentry)
    // Depending on the service, you might send the logEntry object directly
    // or format it according to their API.
}

/**
 * Logs a warning with structured details.
 * @param message A brief message describing the warning.
 * @param details Additional context or details related to the warning.
 */
export function logWarning(message: string, details?: any): void {
    const logEntry: ErrorLogEntry = {
        timestamp: new Date().toISOString(),
        level: 'warn',
        message: message,
        details: details,
    };

    // Output as JSON string for structured logging
    console.warn(JSON.stringify(logEntry));
}

/**
 * Logs informational messages with structured details.
 * @param message A brief informational message.
 * @param details Additional context or details.
 */
export function logInfo(message: string, details?: any): void {
    const logEntry: ErrorLogEntry = {
        timestamp: new Date().toISOString(),
        level: 'info',
        message: message,
        details: details,
    };

    // Output as JSON string for structured logging
    console.log(JSON.stringify(logEntry));
}
