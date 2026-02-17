
// scripts/dry-run-algo.ts

// Mock cosine_similarity instead of importing from WASM
function cosine_similarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Mock types
interface Article {
    articleId: string;
    title: string;
    embedding: number[];
}

interface UserProfile {
    embedding: number[];
}

// Generate random embedding
function randomEmbedding(dim: number): number[] {
    return Array.from({ length: dim }, () => Math.random() - 0.5);
}

// Normalize vector
function normalize(vec: number[]): number[] {
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    return vec.map(v => v / norm);
}

// Mock Data
const DIM = 10; // Use small dimension for test
const articles: Article[] = [];
for (let i = 0; i < 50; i++) {
    articles.push({
        articleId: `article-${i}`,
        title: `Article ${i}`,
        embedding: normalize(randomEmbedding(DIM))
    });
}

// Create some "similar" articles intentionally
const baseArticle = articles[0];
for (let i = 0; i < 5; i++) {
    articles.push({
        articleId: `article-sim-${i}`,
        title: `Similar to 0 - ${i}`,
        embedding: baseArticle.embedding.map(v => v + (Math.random() - 0.5) * 0.1) // slightly perturbed
    });
}

const userProfile: UserProfile = {
    embedding: normalize(randomEmbedding(DIM))
};

const recentInterests = [
    normalize(randomEmbedding(DIM)), // Latest
    normalize(randomEmbedding(DIM))  // Older
];

// Re-implement the logic for dry run (Node.js environment)
// This mirrors the logic we implemented in wasmDO.ts
function selectArticles(candidates: Article[], userProf: UserProfile, recent: number[][], count: number) {
    console.log("Starting selection...");

    // 1. Score
    const scored = candidates.map(a => {
        const longTerm = cosine_similarity(a.embedding, userProf.embedding);

        let shortTerm = 0;
        let weightedSum = 0;
        let totalWeight = 0;
        const DECAY = 0.8;
        recent.forEach((r, idx) => {
            const sim = cosine_similarity(a.embedding, r);
            if (sim > 0) {
                const w = Math.pow(DECAY, idx);
                weightedSum += sim * w;
                totalWeight += w;
            }
        });
        shortTerm = totalWeight > 0 ? weightedSum / totalWeight : 0;

        // Mock Exploration
        const exploration = Math.random();

        return { ...a, longTerm, shortTerm, exploration };
    });

    const selectedIds = new Set<string>();
    const selected: any[] = [];
    const pattern = ['A', 'B', 'A', 'B', 'C'];
    let pIdx = 0;

    // Sort
    const sLong = [...scored].sort((a, b) => b.longTerm - a.longTerm);
    const sShort = [...scored].sort((a, b) => b.shortTerm - a.shortTerm);
    const sExplore = [...scored].sort((a, b) => b.exploration - a.exploration);

    let ptrL = 0, ptrS = 0, ptrE = 0;

    const isTooSimilar = (cand: Article) => {
        return selected.some(s => cosine_similarity(cand.embedding, s.embedding) > 0.85); // Threshold 0.85
    };

    while (selected.length < count && selected.length < candidates.length) {
        const turn = pattern[pIdx % 5];
        let chosen = null;
        let bucket = '';

        if (turn === 'A') {
            while (ptrL < sLong.length) {
                const c = sLong[ptrL++];
                if (!selectedIds.has(c.articleId)) {
                    if (!isTooSimilar(c)) {
                        chosen = c; bucket = 'Long'; break;
                    } else {
                        console.log(`Skipped ${c.title} (Long) due to similarity`);
                    }
                }
            }
        } else if (turn === 'B') {
            while (ptrS < sShort.length) {
                const c = sShort[ptrS++];
                if (!selectedIds.has(c.articleId)) {
                    if (!isTooSimilar(c)) {
                        chosen = c; bucket = 'Short'; break;
                    } else {
                        console.log(`Skipped ${c.title} (Short) due to similarity`);
                    }
                }
            }
        } else {
            while (ptrE < sExplore.length) {
                const c = sExplore[ptrE++];
                if (!selectedIds.has(c.articleId)) {
                    if (!isTooSimilar(c)) {
                        chosen = c; bucket = 'Explore'; break;
                    } else {
                        console.log(`Skipped ${c.title} (Explore) due to similarity`);
                    }
                }
            }
        }

        // Fallback: If nothing found in the preferred bucket, try next turn
        // In real implementation we added a fallback to pick ANY

        if (chosen) {
            selected.push(chosen);
            selectedIds.add(chosen.articleId);
            console.log(`Selected ${chosen.title} (${bucket}) - L:${chosen.longTerm.toFixed(2)} S:${chosen.shortTerm.toFixed(2)}`);
        } else {
            console.log(`Skipped turn ${turn} (no suitable candidates found in bucket)`);
        }

        // Safety break if we loop too much without selecting
        if (pIdx > count * 5 && selected.length === 0) break;

        pIdx++;
    }
    return selected;
}

// Run
const result = selectArticles(articles, userProfile, recentInterests, 15);
console.log("\nFinal Selection:", result.map(a => a.title));
console.log("Total Selected:", result.length);
