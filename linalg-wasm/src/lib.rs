use ndarray::{ArrayView, ArrayView2, Array2};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// A macro to provide `println!(..)`-style syntax for `console.log` logging.
macro_rules! log {
    ( $( $t:tt )* ) => {
        web_sys::console::log_1(&format!( $( $t )* ).into());
    }
}

mod utils {
    pub fn set_panic_hook() {
        // When the `console_error_panic_hook` feature is enabled, we can call the
        // `set_panic_hook` function at least once during initialization, and then
        // we will get better error messages if our code ever panics.
        //
        // For more details see
        // https://github.com/rustwasm/console_error_panic_hook#readme
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();
    }
}

#[derive(Serialize, Deserialize)]
pub struct BanditModel {
    pub a_inv: Vec<f64>, // Flattened d x d matrix
    pub b: Vec<f64>,     // d x 1 vector
    pub dimension: usize,
}

#[derive(Serialize, Deserialize)]
pub struct Article {
    #[serde(rename = "articleId")]
    pub article_id: String,
    pub embedding: Vec<f64>,
}

#[derive(Serialize, Deserialize)]
pub struct UcbResult {
    #[serde(rename = "articleId")]
    pub article_id: String,
    pub ucb: f64,
}

#[wasm_bindgen]
pub fn get_ucb_values_bulk(
    model_js: JsValue,
    articles_js: JsValue,
    user_ctr: f64,
) -> Result<JsValue, JsValue> {
    utils::set_panic_hook();

    let model: BanditModel = serde_wasm_bindgen::from_value(model_js)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let articles: Vec<Article> = serde_wasm_bindgen::from_value(articles_js)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let d = model.dimension;
    if d == 0 {
        return Err(JsValue::from_str("Bandit model dimension cannot be zero."));
    }

    let a_inv = ArrayView2::from_shape((d, d), &model.a_inv)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let b = ArrayView::from(&model.b);

    // Dynamically adjust alpha based on user CTR
    let base_alpha = 0.5;
    let alpha = base_alpha + (1.0 - user_ctr) * 0.5;

    let hat_theta = a_inv.dot(&b);

    let mut ucb_results: Vec<UcbResult> = Vec::with_capacity(articles.len());

    for article in articles {
        if article.embedding.len() != d {
            // Skip articles with mismatched embedding dimensions
            log!("Skipping article {} due to embedding dimension mismatch.", article.article_id);
            continue;
        }
        let x = ArrayView::from(&article.embedding);

        let term1 = x.dot(&hat_theta);
        
        // x_T_A_inv = x^T * A_inv
        let x_t_a_inv = x.dot(&a_inv);
        
        // term2_sqrt = x^T * A_inv * x
        let term2_sqrt = x_t_a_inv.dot(&x);
        
        let term2 = alpha * term2_sqrt.abs().sqrt();

        ucb_results.push(UcbResult {
            article_id: article.article_id,
            ucb: term1 + term2,
        });
    }

    Ok(serde_wasm_bindgen::to_value(&ucb_results)?)
}

#[wasm_bindgen]
pub fn update_bandit_model(
    model_js: JsValue,
    embedding: &[f64],
    reward: f64,
) -> Result<JsValue, JsValue> {
    utils::set_panic_hook();

    let mut model: BanditModel = serde_wasm_bindgen::from_value(model_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize BanditModel: {}", e)))?;

    let d = model.dimension;

    // 1) reject zero-dimension early
    if d == 0 {
        return Err(JsValue::from_str("Bandit model dimension cannot be zero."));
    }

    // 2) basic length checks for a_inv and b
    if model.a_inv.len() != d * d {
        return Err(JsValue::from_str(&format!(
            "Bandit model A_inv length mismatch: expected {}, got {}",
            d * d,
            model.a_inv.len()
        )));
    }

    if model.b.len() != d {
        return Err(JsValue::from_str(&format!(
            "Bandit model b length mismatch: expected {}, got {}",
            d,
            model.b.len()
        )));
    }

    // 3) check finite elements in a_inv and b and embedding
    if model.a_inv.iter().any(|&v| !v.is_finite()) {
        return Err(JsValue::from_str("Bandit model A_inv contains non-finite values (NaN/Inf)."));
    }
    if model.b.iter().any(|&v| !v.is_finite()) {
        return Err(JsValue::from_str("Bandit model b contains non-finite values (NaN/Inf)."));
    }
    if embedding.iter().any(|&v| !v.is_finite()) {
        return Err(JsValue::from_str("Embedding contains non-finite values (NaN/Inf)."));
    }

    if embedding.len() != d {
        return Err(JsValue::from_str("Embedding dimension mismatch."));
    }

    let x = ArrayView::from(embedding);
    let mut a_inv = Array2::from_shape_vec((d, d), model.a_inv)
        .map_err(|e| JsValue::from_str(&format!("A_inv shape error: {}", e)))?;
    let mut b = ArrayView::from(&model.b).to_owned();

    // Sherman-Morrison computation
    let a_inv_x = a_inv.dot(&x);
    let x_t_a_inv_x = x.dot(&a_inv_x);
    let denominator = 1.0 + x_t_a_inv_x;

    // 4) robust near-zero check
    const EPS: f64 = 1e-12;
    if !denominator.is_finite() {
        return Err(JsValue::from_str("Denominator is non-finite (NaN/Inf) in Sherman-Morrison update."));
    }
    if denominator.abs() < EPS {
        return Err(JsValue::from_str("Denominator too small in Sherman-Morrison update (numerical instability)."));
    }

    // 5) compute numerator safely (shapes already validated)
    let numerator_matrix = a_inv_x
        .insert_axis(ndarray::Axis(1))
        .dot(&x.insert_axis(ndarray::Axis(0)).dot(&a_inv));

    // 6) subtract, then update b
    a_inv = a_inv - numerator_matrix / denominator;

    let x_scaled = x.to_owned() * reward;
    // ensure shapes match before addition
    if b.len() != x_scaled.len() {
        return Err(JsValue::from_str("Shape mismatch when updating b."));
    }
    b = b + x_scaled;

    // finalize
    model.a_inv = a_inv.into_raw_vec();
    model.b = b.into_raw_vec();

    Ok(serde_wasm_bindgen::to_value(&model).map_err(|e| JsValue::from_str(&e.to_string()))?)
}

#[wasm_bindgen]
pub fn cosine_similarity(
    vec1_js: JsValue,
    vec2_js: JsValue,
) -> Result<f64, JsValue> {
    utils::set_panic_hook();

    let vec1: Vec<f64> = serde_wasm_bindgen::from_value(vec1_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize vec1: {}", e)))?;
    let vec2: Vec<f64> = serde_wasm_bindgen::from_value(vec2_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize vec2: {}", e)))?;

    if vec1.len() != vec2.len() {
        return Err(JsValue::from_str("Vector dimensions mismatch."));
    }
    if vec1.is_empty() {
        return Err(JsValue::from_str("Vectors cannot be empty."));
    }

    let dot_product: f64 = vec1.iter().zip(vec2.iter()).map(|(&a, &b)| a * b).sum();
    let magnitude1: f64 = vec1.iter().map(|&a| a * a).sum::<f64>().sqrt();
    let magnitude2: f64 = vec2.iter().map(|&b| b * b).sum::<f64>().sqrt();

    if magnitude1 == 0.0 || magnitude2 == 0.0 {
        return Ok(0.0); // Avoid division by zero, return 0 similarity for zero vectors
    }

    Ok(dot_product / (magnitude1 * magnitude2))
}

#[wasm_bindgen]
pub fn cosine_similarity_bulk(
    vec1s_js: JsValue,
    vec2s_js: JsValue,
) -> Result<JsValue, JsValue> {
    utils::set_panic_hook();

    let vec1s: Vec<Vec<f64>> = serde_wasm_bindgen::from_value(vec1s_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize vec1s: {}", e)))?;
    let vec2s: Vec<Vec<f64>> = serde_wasm_bindgen::from_value(vec2s_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize vec2s: {}", e)))?;

    if vec1s.len() != vec2s.len() {
        return Err(JsValue::from_str("Input vector arrays must have the same length."));
    }

    let mut results = Vec::with_capacity(vec1s.len());

    for i in 0..vec1s.len() {
        let vec1 = &vec1s[i];
        let vec2 = &vec2s[i];

        if vec1.len() != vec2.len() {
            results.push(0.0); // 次元が異なる場合は類似度0
            continue;
        }
        if vec1.is_empty() {
            results.push(0.0); // 空のベクトルの場合は類似度0
            continue;
        }

        let dot_product: f64 = vec1.iter().zip(vec2.iter()).map(|(&a, &b)| a * b).sum();
        let magnitude1: f64 = vec1.iter().map(|&a| a * a).sum::<f64>().sqrt();
        let magnitude2: f64 = vec2.iter().map(|&b| b * b).sum::<f64>().sqrt();

        if magnitude1 == 0.0 || magnitude2 == 0.0 {
            results.push(0.0); // ゼロベクトルの場合は類似度0
        } else {
            results.push(dot_product / (magnitude1 * magnitude2));
        }
    }

    Ok(serde_wasm_bindgen::to_value(&results)?)
}

#[wasm_bindgen]
pub fn calculate_similarity_matrix(
    vectors_js: JsValue,
) -> Result<JsValue, JsValue> {
    utils::set_panic_hook();

    let vectors: Vec<Vec<f64>> = serde_wasm_bindgen::from_value(vectors_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize vectors: {}", e)))?;

    let n = vectors.len();
    let mut similarity_matrix = vec![vec![0.0; n]; n];

    for i in 0..n {
        for j in i..n { // 対称行列なので、半分だけ計算してコピー
            let vec1 = &vectors[i];
            let vec2 = &vectors[j];

            if vec1.len() != vec2.len() || vec1.is_empty() {
                similarity_matrix[i][j] = 0.0;
                similarity_matrix[j][i] = 0.0;
                continue;
            }

            let dot_product: f64 = vec1.iter().zip(vec2.iter()).map(|(&a, &b)| a * b).sum();
            let magnitude1: f64 = vec1.iter().map(|&a| a * a).sum::<f64>().sqrt();
            let magnitude2: f64 = vec2.iter().map(|&b| b * b).sum::<f64>().sqrt();

            if magnitude1 == 0.0 || magnitude2 == 0.0 {
                similarity_matrix[i][j] = 0.0;
                similarity_matrix[j][i] = 0.0;
            } else {
                let similarity = dot_product / (magnitude1 * magnitude2);
                similarity_matrix[i][j] = similarity;
                similarity_matrix[j][i] = similarity; // 対称性を利用
            }
        }
    }


    Ok(serde_wasm_bindgen::to_value(&similarity_matrix)?)
}

#[wasm_bindgen]
pub fn cosine_similarity_one_to_many(
    target_vec_js: JsValue,
    candidate_vecs_js: JsValue,
) -> Result<JsValue, JsValue> {
    utils::set_panic_hook();

    let target_vec: Vec<f64> = serde_wasm_bindgen::from_value(target_vec_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize target_vec: {}", e)))?;
    let candidates: Vec<Vec<f64>> = serde_wasm_bindgen::from_value(candidate_vecs_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize candidate_vecs: {}", e)))?;

    if target_vec.is_empty() {
         return Err(JsValue::from_str("Target vector is empty."));
    }

    let mut results = Vec::with_capacity(candidates.len());
    
    // Pre-calculate target vector magnitude
    let target_mag_sq: f64 = target_vec.iter().map(|&a| a * a).sum();
    let target_mag = target_mag_sq.sqrt();

    if target_mag == 0.0 {
         // If target vector is zero, all similarities are 0
         results.resize(candidates.len(), 0.0);
         return Ok(serde_wasm_bindgen::to_value(&results)?);
    }

    for candidate in candidates {
        if candidate.len() != target_vec.len() {
             results.push(0.0); // Dimension mismatch
             continue;
        }

        let mut dot_product = 0.0;
        let mut cand_mag_sq = 0.0;

        for (a, b) in target_vec.iter().zip(candidate.iter()) {
            dot_product += a * b;
            cand_mag_sq += b * b;
        }

        let cand_mag = cand_mag_sq.sqrt();
        
        if cand_mag == 0.0 {
            results.push(0.0);
        } else {
            results.push(dot_product / (target_mag * cand_mag));
        }
    }

    Ok(serde_wasm_bindgen::to_value(&results)?)
}
