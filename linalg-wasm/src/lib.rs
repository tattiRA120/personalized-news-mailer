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
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let d = model.dimension;
    if embedding.len() != d {
        return Err(JsValue::from_str("Embedding dimension mismatch."));
    }

    let x = ArrayView::from(embedding);
    let mut a_inv = Array2::from_shape_vec((d, d), model.a_inv)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let mut b = ArrayView::from(&model.b).to_owned();

    // Sherman-Morrison formula を使用して A_inv を更新
    // A_new_inv = A_old_inv - (A_old_inv * x * x^T * A_old_inv) / (1 + x^T * A_old_inv * x)

    // 1. A_old_inv * x
    let a_inv_x = a_inv.dot(&x); // d x 1 ベクトル

    // 2. x^T * A_old_inv * x
    let x_t_a_inv_x = x.dot(&a_inv_x); // スカラー

    // 3. denominator = 1 + x^T * A_old_inv * x
    let denominator = 1.0 + x_t_a_inv_x;

    if denominator == 0.0 {
        return Err(JsValue::from_str("Denominator is zero in Sherman-Morrison update."));
    }

    // 4. numerator_matrix = (A_old_inv * x) * (x^T * A_old_inv)
    // (d x 1) * (1 x d) = d x d 行列
    let numerator_matrix = a_inv_x.insert_axis(ndarray::Axis(1)).dot(&x.insert_axis(ndarray::Axis(0)).dot(&a_inv));

    // 5. A_new_inv = A_old_inv - numerator_matrix / denominator
    a_inv = a_inv - numerator_matrix / denominator;

    // b = b + reward * x
    let x_scaled = x.to_owned() * reward;
    b = b + x_scaled;

    model.a_inv = a_inv.into_raw_vec();
    model.b = b.into_raw_vec();

    Ok(serde_wasm_bindgen::to_value(&model)?)
}
