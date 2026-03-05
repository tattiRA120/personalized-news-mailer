import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const articles = sqliteTable('articles', {
    article_id: text('article_id').primaryKey(),
    title: text('title').notNull(),
    url: text('url').notNull().unique(),
    published_at: integer('published_at').notNull(),
    content: text('content'),
    embedding: text('embedding'),
});

export const users = sqliteTable('users', {
    user_id: text('user_id').primaryKey(),
    email: text('email').notNull().unique(),
    interests: text('interests').notNull().default('[]'),
    embedding: text('embedding'),
    mmr_lambda: real('mmr_lambda').default(0.5),
});

export const clickLogs = sqliteTable('click_logs', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    user_id: text('user_id')
        .notNull()
        .references(() => users.user_id),
    article_id: text('article_id')
        .notNull()
        .references(() => articles.article_id),
    timestamp: integer('timestamp').notNull(),
});

export const sentArticles = sqliteTable('sent_articles', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    user_id: text('user_id')
        .notNull()
        .references(() => users.user_id),
    article_id: text('article_id')
        .notNull()
        .references(() => articles.article_id),
    timestamp: integer('timestamp').notNull(),
    embedding: text('embedding'),
    published_at: integer('published_at'),
});

export const educationLogs = sqliteTable('education_logs', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    user_id: text('user_id')
        .notNull()
        .references(() => users.user_id),
    article_id: text('article_id')
        .notNull()
        .references(() => articles.article_id),
    timestamp: integer('timestamp').notNull(),
    action: text('action').notNull(),
    processed: integer('processed').default(0),
});
