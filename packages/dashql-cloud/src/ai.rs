//! The `ai.dashql.app` machine API: an OpenAI-compatible surface over Workers AI.
//!
//! Two endpoints, matching exactly what dashql's `AIClient` needs
//! (`packages/dashql-app/src/platform/ai_client.ts`):
//!   * `GET  /v1/models`           — static allowlist (Workers AI has no /v1/models shim)
//!   * `POST /v1/chat/completions` — non-streaming chat, reshaped to OpenAI's response form
//!
//! Auth is a `Authorization: Bearer <key>` header, verified against the `DASHQL_CLOUD_API_KEYS` KV namespace
//! and charged against a per-key rolling-window quota — both a request count and a **neuron**
//! budget (see [`crate::keys`]). Neurons are charged after inference from the response's token
//! counts via each model's fixed neuron rate ([`Model`]).

use serde::{Deserialize, Serialize};
use worker::send::SendFuture;
use worker::wasm_bindgen::prelude::*;
use worker::*;

use crate::keys::{self, Charge, KeyError, QuotaKind};

/// Re-declaration of the JS `Ai.run` binding *with* the third `options` argument.
///
/// `worker` 0.8's [`Ai`] wrapper only exposes `run(model, input)` (see worker-sys
/// `types/ai.rs`) — it never got the `options` parameter the JS runtime's
/// `env.AI.run(model, input, options)` accepts, and that object is where `{ gateway }` lives
/// (see the open upstream gap, cloudflare/workers-rs#789). So we bind the 3-arg form ourselves
/// on our own extern type (wasm-bindgen won't let us hang a method off the foreign `JsValue`),
/// then `unchecked_ref`-cast the real `Ai` binding — a plain JS object — onto it. `structural`
/// dispatches `.run(...)` by name, so the cast never has to actually be an `AiWithGateway`.
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(extends = ::js_sys::Object)]
    type AiWithGateway;

    #[wasm_bindgen(structural, method, js_name = run)]
    fn run(this: &AiWithGateway, model: &str, input: JsValue, options: JsValue) -> js_sys::Promise;
}

/// The `gateway` options object threaded into `Ai.run`'s third argument: `{ gateway: { id } }`.
/// Serialized to a plain JS object by `serde_wasm_bindgen`. Extend with `skip_cache`/`cache_ttl`
/// (renamed to `skipCache`/`cacheTtl`) here if we ever want per-request cache control.
#[derive(Serialize)]
struct RunOptions<'a> {
    gateway: GatewayOptions<'a>,
}

#[derive(Serialize)]
struct GatewayOptions<'a> {
    id: &'a str,
}

/// Run a Workers AI model through an AI Gateway when `gateway_id` is set, else the plain binding.
///
/// This mirrors `worker::Ai::run` (serialize input, await the promise via a `SendFuture` so the
/// router handler stays `Send`, deserialize the output) but calls our 3-arg [`run_with_options`]
/// so requests flow through the named gateway — giving us its account-wide rate/spend limits,
/// caching, and per-model cost analytics on top of the per-key neuron quota in [`crate::keys`].
async fn run_ai<T, U>(ai: &Ai, model: &str, input: T, gateway_id: Option<&str>) -> Result<U>
where
    T: Serialize,
    U: serde::de::DeserializeOwned,
{
    let Some(gateway_id) = gateway_id else {
        // No gateway configured: fall back to the crate's stock 2-arg binding.
        return ai.run(model, input).await;
    };

    let ai_js: &AiWithGateway = ai.as_ref().unchecked_ref();
    let input = serde_wasm_bindgen::to_value(&input)?;
    let options = serde_wasm_bindgen::to_value(&RunOptions {
        gateway: GatewayOptions { id: gateway_id },
    })?;
    let promise = ai_js.run(model, input, options);
    let output = SendFuture::new(js_sys::futures::JsFuture::from(promise)).await?;
    Ok(serde_wasm_bindgen::from_value(output)?)
}

/// A Workers AI model we expose, with its neuron cost. `GET /v1/models` returns these;
/// `/v1/chat/completions` rejects anything else with 400.
///
/// Rates are Cloudflare's published *neurons per million tokens* (see the pricing page). Because
/// a neuron-micro is `neurons × 1e6`, `tokens × rate` yields neuron-micros exactly, with no
/// division or rounding — see [`Model::neuron_micros`]. Re-check these if CF changes pricing.
pub struct Model {
    pub id: &'static str,
    /// Neurons per million input (prompt) tokens.
    pub neurons_per_m_input: u64,
    /// Neurons per million output (completion) tokens.
    pub neurons_per_m_output: u64,
}

impl Model {
    /// Neuron cost of a request, in *neuron-micros* (neurons × 1e6). Since each rate is
    /// "neurons per 1e6 tokens", `tokens × rate` is already scaled by 1e6 — i.e. neuron-micros.
    fn neuron_micros(&self, prompt_tokens: u64, completion_tokens: u64) -> u64 {
        prompt_tokens
            .saturating_mul(self.neurons_per_m_input)
            .saturating_add(completion_tokens.saturating_mul(self.neurons_per_m_output))
    }
}

/// Gemma 4 26B-A4B is the only model we expose ($0.10 / $0.30 per M input / output tokens).
pub const MODELS: &[Model] = &[
    Model { id: "@cf/google/gemma-4-26b-a4b-it", neurons_per_m_input: 9091, neurons_per_m_output: 27273 },
];

/// Look up an enabled model by id.
fn find_model(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|m| m.id == id)
}

// ---- OpenAI-compatible wire types -----------------------------------------------------

#[derive(Deserialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(default)]
    #[allow(dead_code)]
    stream: bool,
}

#[derive(Deserialize, Serialize, Clone)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct ChatCompletionResponse {
    object: &'static str,
    model: String,
    choices: Vec<Choice>,
    /// Echo Workers AI's token counts back (OpenAI clients expect a `usage` object).
    usage: Usage,
}

#[derive(Serialize)]
struct Choice {
    index: u32,
    message: ChatMessage,
    finish_reason: &'static str,
}

#[derive(Serialize)]
struct ModelList {
    object: &'static str,
    data: Vec<ModelEntry>,
}

#[derive(Serialize)]
struct ModelEntry {
    id: &'static str,
    object: &'static str,
    owned_by: &'static str,
}

// ---- Workers AI binding types ---------------------------------------------------------

/// Input to a Workers AI text-generation model (the `{ messages }` form).
#[derive(Serialize)]
struct WorkersAiInput {
    messages: Vec<ChatMessage>,
}

/// Workers AI text-generation output: `{ "response": "...", "usage": { ... } }`. The `usage`
/// object carries token counts (Cloudflare's documented schema); absent on older models, hence
/// the default of all-zero (which charges 0 neurons rather than failing the request).
///
/// `response` is *usually* a string, but when the model emits valid JSON (e.g. a Vega-Lite spec
/// for a visualize request) some Workers AI models return it already parsed as an object. So we
/// deserialize it as a loose [`serde_json::Value`] and re-flatten to text in [`response_text`];
/// typing it as `String` would fail deserialization with "invalid type: Object, expected a string".
#[derive(Deserialize)]
struct WorkersAiOutput {
    #[serde(default)]
    response: serde_json::Value,
    #[serde(default)]
    usage: Usage,
}

/// Flatten Workers AI's `response` field to the plain string our OpenAI-shaped `content` expects.
/// A JSON string is returned verbatim (no re-quoting); a null/absent response becomes empty; any
/// other JSON value (object/array/number/bool — e.g. a parsed Vega-Lite spec) is re-serialized to
/// compact JSON text, which the client then parses back into the same object.
fn response_text(value: serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s,
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Token accounting returned by Workers AI. Fields match CF's `usage` schema. Deserialized from
/// the binding's output and re-serialized into our OpenAI-shaped response unchanged.
#[derive(Deserialize, Serialize, Default)]
struct Usage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
}

// ---- Router ---------------------------------------------------------------------------

/// Build the API router. The entrypoint in `lib.rs` dispatches `ai.*` (and dev hosts) here.
///
/// Every response (success or error) carries permissive CORS so the browser-hosted dashql
/// web build can call the API directly; `OPTIONS` short-circuits the preflight.
pub fn router() -> Router<'static, ()> {
    Router::new()
        .get_async("/v1/models", |req, ctx| async move {
            with_cors(list_models(req, ctx).await)
        })
        .post_async("/v1/chat/completions", |req, ctx| async move {
            with_cors(chat_completions(req, ctx).await)
        })
        .options("/v1/models", |_req, _ctx| preflight())
        .options("/v1/chat/completions", |_req, _ctx| preflight())
}

/// Attach permissive CORS to a successful response (errors already carry it).
fn with_cors(result: Result<Response>) -> Result<Response> {
    result.and_then(|r| r.with_cors(&permissive_cors()))
}

/// Answer a CORS preflight with the allowed methods/headers.
fn preflight() -> Result<Response> {
    Response::empty()?.with_cors(&permissive_cors())
}

/// Verify the request's API key and charge one request slot of its current-window quota,
/// checking both the request and neuron budgets. Returns the [`Charge`] handle (settle the
/// neuron cost after inference), or an error `Response` (401/429/500) to short-circuit on.
async fn authorize(req: &Request, env: &Env) -> std::result::Result<Charge, Response> {
    match keys::verify_and_charge(req, env).await {
        Ok(charge) => Ok(charge),
        Err(KeyError::Unauthorized) => {
            Err(error_response(401, "unauthorized", "Missing or invalid API key"))
        }
        Err(KeyError::QuotaExceeded { kind, limit, window_secs }) => {
            let window = keys::humanize_window(window_secs);
            let msg = match kind {
                QuotaKind::Requests => format!("Request limit of {limit} per {window} reached"),
                QuotaKind::Neurons => {
                    format!("Neuron budget of {limit} per {window} reached")
                }
            };
            Err(error_response(429, "quota_exceeded", &msg))
        }
        Err(KeyError::Internal(e)) => {
            Err(error_response(500, "internal_error", &format!("Server error: {e}")))
        }
    }
}

async fn list_models(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    // Charges a request slot but no neurons (no inference happens here).
    if let Err(resp) = authorize(&req, &ctx.env).await {
        return Ok(resp);
    }
    let list = ModelList {
        object: "list",
        data: MODELS
            .iter()
            .map(|m| ModelEntry { id: m.id, object: "model", owned_by: "cloudflare" })
            .collect(),
    };
    Response::from_json(&list)
}

async fn chat_completions(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let charge = match authorize(&req, &ctx.env).await {
        Ok(c) => c,
        Err(resp) => return Ok(resp),
    };

    let body: ChatCompletionRequest = match req.json().await {
        Ok(b) => b,
        Err(_) => return Ok(error_response(400, "invalid_request", "Malformed JSON body")),
    };

    let model = match find_model(&body.model) {
        Some(m) => m,
        None => {
            return Ok(error_response(
                400,
                "model_not_found",
                &format!("Model '{}' is not available", body.model),
            ))
        }
    };

    let ai = ctx.env.ai("AI")?;
    let input = WorkersAiInput { messages: body.messages };
    // Route through the AI Gateway named by AI_GATEWAY_ID (if set), so its account-wide
    // rate/spend limits and caching apply on top of the per-key quota. Unset => direct binding.
    let gateway_id = ctx.env.var("AI_GATEWAY_ID").map(|v| v.to_string()).ok();
    let gateway_id = gateway_id.as_deref().filter(|s| !s.is_empty());
    let out: WorkersAiOutput = match run_ai(&ai, model.id, input, gateway_id).await {
        Ok(o) => o,
        Err(e) => {
            return Ok(error_response(
                502,
                "upstream_error",
                &format!("Workers AI error: {e}"),
            ))
        }
    };

    // Settle the neuron cost against the key's window budget. Best-effort: a KV write failure
    // here shouldn't fail a completion the user already paid Cloudflare for, so we only log it.
    let neuron_micros = model.neuron_micros(out.usage.prompt_tokens, out.usage.completion_tokens);
    if let Err(e) = charge.charge_neurons(&ctx.env, neuron_micros).await {
        console_error!("failed to record neuron usage ({neuron_micros} micros): {e}");
    }

    let resp = ChatCompletionResponse {
        object: "chat.completion",
        model: body.model,
        choices: vec![Choice {
            index: 0,
            message: ChatMessage { role: "assistant".to_string(), content: response_text(out.response) },
            finish_reason: "stop",
        }],
        usage: out.usage,
    };
    Response::from_json(&resp)
}

/// Build an OpenAI-style error body (`{ "error": { "message", "type" } }`) with a status.
fn error_response(status: u16, err_type: &str, message: &str) -> Response {
    let body = serde_json::json!({ "error": { "message": message, "type": err_type } });
    Response::from_json(&body)
        .and_then(|r| r.with_status(status).with_cors(&permissive_cors()))
        .unwrap_or_else(|_| Response::error("error", status).unwrap())
}

/// Permissive CORS so a browser-hosted dashql web build can call the API directly.
fn permissive_cors() -> Cors {
    Cors::new()
        .with_origins(["*"])
        .with_methods([Method::Get, Method::Post, Method::Options])
        .with_allowed_headers(["Authorization", "Content-Type"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::NEURON;

    #[test]
    fn every_enabled_model_has_a_rate() {
        // find_model backs the /v1/models list and the /v1/chat/completions gate.
        for m in MODELS {
            assert!(find_model(m.id).is_some());
            assert!(m.neurons_per_m_input > 0 && m.neurons_per_m_output > 0);
        }
        assert!(find_model("@cf/nonexistent").is_none());
    }

    #[test]
    fn response_text_flattens_string_and_object() {
        use serde_json::json;
        // A plain string response passes through verbatim (no re-quoting).
        assert_eq!(response_text(json!("SELECT 1")), "SELECT 1");
        // A null / absent response becomes empty rather than the literal "null".
        assert_eq!(response_text(serde_json::Value::Null), "");
        // A parsed object (e.g. a Vega-Lite spec) is re-serialized to compact JSON the client
        // can parse back — this is the case that previously failed with "expected a string".
        let spec = json!({ "mark": { "type": "bar" }, "encoding": { "x": { "field": "x" } } });
        let text = response_text(spec.clone());
        assert_eq!(serde_json::from_str::<serde_json::Value>(&text).unwrap(), spec);
    }

    #[test]
    fn workers_ai_output_accepts_object_response() {
        // Regression: some Workers AI models return `response` as an already-parsed JSON object
        // for visualize requests. Deserializing into WorkersAiOutput must not fail.
        let raw = r#"{"response":{"mark":"bar"},"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}"#;
        let out: WorkersAiOutput = serde_json::from_str(raw).unwrap();
        assert_eq!(out.usage.prompt_tokens, 10);
        assert_eq!(response_text(out.response), r#"{"mark":"bar"}"#);
    }

    #[test]
    fn neuron_micros_matches_cloudflare_rates() {
        let m = find_model("@cf/google/gemma-4-26b-a4b-it").unwrap();
        // Exactly 1M input + 1M output tokens => the per-million rates, in whole neurons.
        let micros = m.neuron_micros(1_000_000, 1_000_000);
        assert_eq!(micros / NEURON, 9091 + 27273);
        // A million input tokens costs exactly `neurons_per_m_input` neurons (no rounding).
        assert_eq!(m.neuron_micros(1_000_000, 0), 9091 * NEURON);
        // Sub-million counts stay exact in micros: 500k output tokens = half the output rate.
        assert_eq!(m.neuron_micros(0, 500_000), 27273 * NEURON / 2);
        // Zero tokens => zero cost.
        assert_eq!(m.neuron_micros(0, 0), 0);
    }
}
