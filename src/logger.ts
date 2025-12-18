// src/logger.ts
import { Env } from './types/bindings';

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

    /**
     * Logs batch processing operations efficiently.
     * Only logs start, end summary, and errors at appropriate levels.
     * Individual item successes are logged at debug level.
     */
    public async logBatchProcess<T, R = void>(
        operationName: string,
        items: T[],
        processItem: (item: T, index: number) => Promise<R>,
        options?: {
            batchSize?: number;
            onItemSuccess?: (item: T, index: number, result?: R) => void;
            onItemError?: (item: T, index: number, error: any) => void;
        }
    ): Promise<{ successCount: number; errorCount: number; results: R[] }> {
        const totalItems = items.length;
        this.info(`Starting ${operationName} for ${totalItems} items`);

        let successCount = 0;
        let errorCount = 0;
        const errors: Array<{ item: T; index: number; error: any }> = [];
        const results: R[] = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            try {
                const result = await processItem(item, i);
                results.push(result);
                successCount++;
                if (options?.onItemSuccess) {
                    this.debug(`${operationName} succeeded for item ${i + 1}/${totalItems}`, { item, result });
                }
            } catch (error) {
                errorCount++;
                errors.push({ item, index: i, error });
                results.push(undefined as R); // エラーの場合は undefined を追加
                if (options?.onItemError) {
                    this.error(`${operationName} failed for item ${i + 1}/${totalItems}`, error, { item });
                }
            }
        }

        if (errorCount === 0) {
            this.info(`Completed ${operationName}. Success: ${successCount}/${totalItems}`);
        } else {
            this.warn(`Completed ${operationName}. Success: ${successCount}/${totalItems}, Errors: ${errorCount}/${totalItems}`);
            if (errors.length > 0 && this.shouldLog(LogLevel.DEBUG)) {
                this.debug(`${operationName} error details`, { errors });
            }
        }

        return { successCount, errorCount, results };
    }
}
