# linalg-wasm

A WebAssembly module for linear algebra operations optimized for Contextual Bandit algorithms.

## Features

- **UCB Value Calculation**: Bulk computation of Upper Confidence Bound values for LinUCB algorithm
- **Model Updates**: Efficient bandit model updates using Sherman-Morrison formula
- **Cosine Similarity**: Fast cosine similarity calculations for vector comparisons
- **Similarity Matrix**: Computation of similarity matrices for multiple vectors

## Installation

```bash
npm install linalg-wasm
```

## Usage

```javascript
import init, {
  get_ucb_values_bulk,
  update_bandit_model,
  cosine_similarity
} from 'linalg-wasm';

async function main() {
  // Initialize the WASM module
  await init();

  // Your code here
}
```

## API

### `get_ucb_values_bulk(model, articles, user_ctr)`

Calculates UCB values for multiple articles.

### `update_bandit_model(model, embedding, reward)`

Updates the bandit model with new reward information.

### `cosine_similarity(vec1, vec2)`

Computes cosine similarity between two vectors.

### `cosine_similarity_bulk(vec1s, vec2s)`

Computes cosine similarities for multiple vector pairs.

### `calculate_similarity_matrix(vectors)`

Computes a similarity matrix for a set of vectors.

### `cosine_similarity_one_to_many(target, candidates)`

Computes similarities between one target vector and multiple candidates.

## License

MIT
