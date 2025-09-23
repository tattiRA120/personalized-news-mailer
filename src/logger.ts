// src/logger.ts
import { Env } from './index';

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    SILENT = 4, // No logs
}

interface LogEntry {
    timestamp: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    details?: any; // Additional context or details
    stack?: string; // Error stack trace
}

// 環境変数からログレベルを取得するヘルパー関数
// デフォルトは INFO レベル
let currentEnv: Env | null = null;

export function setLoggerEnv(env: Env) {
    currentEnv = env;
}

function getCurrentLogLevel(): LogLevel {
    const logLevel = currentEnv?.LOG_LEVEL?.toUpperCase();
    switch (logLevel) {
        case 'DEBUG':
            return LogLevel.DEBUG;
        case 'INFO':
            return LogLevel.INFO;
        case 'WARN':
            return LogLevel.WARN;
        case 'ERROR':
            return LogLevel.ERROR;
        case 'SILENT':
            return LogLevel.SILENT;
        default:
            return LogLevel.INFO; // デフォルトは INFO
    }
}

function shouldLog(level: LogLevel): boolean {
    return level >= getCurrentLogLevel();
}

/**
 * Logs an error with structured details.
 * @param message A brief message describing the error.
 * @param error The error object.
 * @param details Additional context or details related to the error.
 */
export function logError(message: string, error?: any, details?: any): void {
    if (!shouldLog(LogLevel.ERROR)) return;

    const logEntry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: 'error',
        message: message,
        details: details,
        stack: error instanceof Error ? error.stack : undefined,
    };

    console.error(JSON.stringify(logEntry));
}

/**
 * Logs a warning with structured details.
 * @param message A brief message describing the warning.
 * @param error The error object (optional).
 * @param details Additional context or details related to the warning.
 */
export function logWarning(message: string, error?: any, details?: any): void {
    if (!shouldLog(LogLevel.WARN)) return;

    const logEntry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: 'warn',
        message: message,
        details: details,
        stack: error instanceof Error ? error.stack : undefined,
    };

    console.warn(JSON.stringify(logEntry));
}

/**
 * Logs informational messages with structured details.
 * @param message A brief informational message.
 * @param details Additional context or details.
 */
export function logInfo(message: string, details?: any): void {
    if (!shouldLog(LogLevel.INFO)) return;

    const logEntry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: 'info',
        message: message,
        details: details,
    };

    console.log(JSON.stringify(logEntry));
}

/**
 * Logs debug messages with structured details.
 * @param message A brief debug message.
 * @param details Additional context or details.
 */
export function logDebug(message: string, details?: any): void {
    if (!shouldLog(LogLevel.DEBUG)) return;

    const logEntry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: 'debug',
        message: message,
        details: details,
    };

    console.log(JSON.stringify(logEntry));
}

export function initLogger(env: Env) {
    setLoggerEnv(env);
    return {
        logError,
        logWarning,
        logInfo,
        logDebug,
    };
}
