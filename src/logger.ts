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
    details?: any;
    stack?: string;
}

export class Logger {
    private env: Env;

    constructor(env: Env) {
        this.env = env;
    }

    private getCurrentLogLevel(): LogLevel {
        const logLevel = this.env.LOG_LEVEL?.toUpperCase();
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
                return LogLevel.INFO;
        }
    }

    private shouldLog(level: LogLevel): boolean {
        return level >= this.getCurrentLogLevel();
    }

    public error(message: string, error?: any, details?: any): void {
        if (!this.shouldLog(LogLevel.ERROR)) return;
        const logEntry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: 'error',
            message: message,
            details: details,
            stack: error instanceof Error ? error.stack : undefined,
        };
        console.error(JSON.stringify(logEntry));
    }

    public warn(message: string, error?: any, details?: any): void {
        if (!this.shouldLog(LogLevel.WARN)) return;
        const logEntry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: 'warn',
            message: message,
            details: details,
            stack: error instanceof Error ? error.stack : undefined,
        };
        console.warn(JSON.stringify(logEntry));
    }

    public info(message: string, details?: any): void {
        if (!this.shouldLog(LogLevel.INFO)) return;
        const logEntry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: message,
            details: details,
        };
        console.log(JSON.stringify(logEntry));
    }

    public debug(message: string, details?: any): void {
        if (!this.shouldLog(LogLevel.DEBUG)) return;
        const logEntry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: 'debug',
            message: message,
            details: details,
        };
        console.log(JSON.stringify(logEntry));
    }
}
