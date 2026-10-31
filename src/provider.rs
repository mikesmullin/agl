//! generic — the OpenAI-compatible provider.
//!
//! Port of `js/src/providers/generic.mjs`. One HTTP client for any server
//! that speaks the OpenAI chat-completions / embeddings API, plus the native
//! `POST /v1/systemone` decision endpoint.
//!
//! The `copilot` provider is NOT ported: it is the one genuine exception in
//! the JS tree (GitHub device-flow auth and token exchange rather than just a
//! different base URL), and porting OAuth device flow is a separate job from
//! porting the inference path. See PORT_STATUS.md.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::switch::{Decided, Decider, SwitchError, Usage};

/// Trailing slashes and a trailing `/v1` are stripped, so callers may pass
/// either form of a base URL.
pub fn normalize_base(url: &str) -> String {
    let mut u = url.trim().trim_end_matches('/').to_string();
    if u.ends_with("/v1") {
        u.truncate(u.len() - 3);
    }
    u
}

/// `host:port` becomes `https://host:port`; a full URL is kept, minus a
/// trailing `/v1`. Empty is no proxy.
pub fn normalize_proxy(proxy: Option<&str>) -> String {
    let Some(s) = proxy else {
        return String::new();
    };
    let s = s.trim();
    if s.is_empty() {
        return String::new();
    }
    let has_scheme = s
        .split_once("://")
        .map(|(sch, _)| {
            !sch.is_empty()
                && sch.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && sch
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-')
        })
        .unwrap_or(false);
    let s = if has_scheme {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    let s = s.trim_end_matches('/').to_string();
    if s.to_lowercase().ends_with("/v1") {
        s[..s.len() - 3].to_string()
    } else {
        s
    }
}

/// Where to send a request and how to authenticate.
#[derive(Debug, Clone, Default)]
pub struct Endpoint {
    pub base_url: String,
    pub api_key: Option<String>,
    pub ca_file: Option<String>,
}

#[derive(Debug)]
pub enum ProviderError {
    MissingBaseUrl(String),
    MissingApiKey(String),
    /// The endpoint is not a decision model (501 from /v1/systemone).
    NotADecisionModel(String),
    Http { status: u16, message: String },
    Transport(String),
    Decode(String),
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderError::MissingBaseUrl(m) => write!(f, "{m}"),
            ProviderError::MissingApiKey(m) => write!(f, "{m}"),
            ProviderError::NotADecisionModel(m) => write!(f, "{m}"),
            ProviderError::Http { status, message } => {
                write!(f, "generic (openai-compatible) request error: {status} {message}")
            }
            ProviderError::Transport(m) => write!(f, "{m}"),
            ProviderError::Decode(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for ProviderError {}

/// A chat message in the OpenAI shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl Message {
    pub fn system(text: impl Into<String>) -> Self {
        Self::text("system", text)
    }
    pub fn user(text: impl Into<String>) -> Self {
        Self::text("user", text)
    }
    pub fn assistant(text: impl Into<String>) -> Self {
        Self::text("assistant", text)
    }
    pub fn text(role: &str, text: impl Into<String>) -> Self {
        Message {
            role: role.to_string(),
            content: Some(Value::String(text.into())),
            tool_calls: None,
            tool_call_id: None,
        }
    }
    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Message {
            role: "tool".to_string(),
            content: Some(Value::String(content.into())),
            tool_calls: None,
            tool_call_id: Some(tool_call_id.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type", default = "default_tool_type")]
    pub kind: String,
    pub function: FunctionCall,
}

fn default_tool_type() -> String {
    "function".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    /// A JSON string, as the API returns it.
    #[serde(default)]
    pub arguments: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Choice {
    pub message: Message,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct TokenUsage {
    #[serde(default)]
    pub prompt_tokens: Option<u64>,
    #[serde(default)]
    pub completion_tokens: Option<u64>,
    #[serde(default)]
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Completion {
    #[serde(default)]
    pub choices: Vec<Choice>,
    #[serde(default)]
    pub usage: Option<TokenUsage>,
}

/// One inference request.
#[derive(Debug, Clone, Default)]
pub struct InferenceRequest {
    pub model: String,
    pub messages: Vec<Message>,
    pub tools: Option<Value>,
    pub tool_choice: Option<Value>,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub reasoning_effort: Option<String>,
    pub chat_template_kwargs: Option<Value>,
}

/// The HTTP client. Built once per endpoint; `reqwest::Client` pools
/// connections internally.
#[derive(Clone, Debug)]
pub struct Generic {
    endpoint: Endpoint,
    client: reqwest::Client,
}

impl Generic {
    /// Build a client for an endpoint.
    ///
    /// A custom CA is loaded when `ca_file` points at a readable PEM. As in
    /// the JS original, hostname verification is relaxed for those: reused
    /// llama-server certs often carry a previous VM's IP as their SAN, so the
    /// CA is trusted but the name is not required to match.
    pub fn new(endpoint: Endpoint) -> Result<Self, ProviderError> {
        let base = normalize_base(&endpoint.base_url);
        if base.is_empty() {
            return Err(ProviderError::MissingBaseUrl(
                "No endpoint for the openai-compatible provider — set the `endpoints` map in \
                 ~/.config/agl/config.yaml or export MYCLOUD_BASE_URL / LLAMA_SERVER_BASE_URL / \
                 OPENAI_BASE_URL."
                    .into(),
            ));
        }
        let is_http = base.starts_with("http://");
        let key_missing = endpoint.api_key.as_deref().unwrap_or("").is_empty();
        if key_missing && !is_http {
            return Err(ProviderError::MissingApiKey(format!(
                "No API key for this openai-compatible endpoint ({base}) — export \
                 <PROVIDER>_API_KEY or the endpoint will return 401."
            )));
        }

        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(600));
        if !is_http {
            if let Some(path) = endpoint.ca_file.as_deref() {
                if let Ok(pem) = std::fs::read(path) {
                    if let Ok(cert) = reqwest::Certificate::from_pem(&pem) {
                        builder = builder
                            .add_root_certificate(cert)
                            // See the note above: trust the CA, do not require
                            // the hostname/IP to match.
                            .danger_accept_invalid_hostnames(true);
                    }
                }
            }
        }
        let client = builder
            .build()
            .map_err(|e| ProviderError::Transport(format!("building HTTP client: {e}")))?;

        Ok(Generic {
            endpoint: Endpoint {
                base_url: base,
                ..endpoint
            },
            client,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.endpoint.base_url
    }

    fn post(&self, uri: &str, body: &Value) -> reqwest::RequestBuilder {
        let mut req = self
            .client
            .post(format!("{}{}", self.endpoint.base_url, uri))
            .json(body);
        if let Some(k) = self.endpoint.api_key.as_deref() {
            if !k.is_empty() {
                req = req.bearer_auth(k);
            }
        }
        req
    }

    /// Read a non-2xx body and surface the server's own code/message, which
    /// harnesses match on (`vision_disabled` vs `context_length_exceeded`).
    async fn error_for(resp: reqwest::Response) -> ProviderError {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        let mut detail = String::new();
        if let Ok(parsed) = serde_json::from_str::<Value>(&body) {
            let code = parsed
                .get("error")
                .and_then(|e| e.get("code"))
                .or_else(|| parsed.get("code"));
            let message = parsed
                .get("error")
                .and_then(|e| e.get("message"))
                .or_else(|| parsed.get("message"));
            let parts: Vec<String> = [code, message]
                .iter()
                .filter_map(|v| v.and_then(|x| x.as_str()).map(|s| s.to_string()))
                .collect();
            if !parts.is_empty() {
                detail = format!(" ({})", parts.join(": "));
            }
        } else if !body.is_empty() {
            detail = format!(" ({})", &body[..body.len().min(200)]);
        }
        ProviderError::Http {
            status,
            message: detail,
        }
    }

    /// `POST /v1/chat/completions`.
    pub async fn inference(&self, req: &InferenceRequest) -> Result<Completion, ProviderError> {
        let mut body = Map::new();
        body.insert("model".into(), json!(req.model));
        body.insert("messages".into(), json!(req.messages));
        body.insert("stream".into(), json!(false));
        if let Some(t) = &req.tools {
            if t.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                body.insert("tools".into(), t.clone());
            }
        }
        if let Some(tc) = &req.tool_choice {
            body.insert("tool_choice".into(), tc.clone());
        }
        if let Some(n) = req.max_tokens {
            body.insert("max_tokens".into(), json!(n));
        }
        // Defaults matching the JS original.
        body.insert("temperature".into(), json!(req.temperature.unwrap_or(1.0)));
        body.insert("top_p".into(), json!(req.top_p.unwrap_or(0.95)));
        if let Some(k) = &req.chat_template_kwargs {
            body.insert("chat_template_kwargs".into(), k.clone());
        }
        if let Some(e) = &req.reasoning_effort {
            if !e.is_empty() {
                body.insert("reasoning_effort".into(), json!(e));
            }
        }

        let resp = self
            .post("/v1/chat/completions", &Value::Object(body))
            .send()
            .await
            .map_err(|e| {
                ProviderError::Transport(format!(
                    "Unable to connect to the openai-compatible endpoint at {}/v1/chat/completions: {e}. \
                     Check the `endpoints` map in ~/.config/agl/config.yaml.",
                    self.endpoint.base_url
                ))
            })?;
        if !resp.status().is_success() {
            return Err(Self::error_for(resp).await);
        }
        resp.json::<Completion>()
            .await
            .map_err(|e| ProviderError::Decode(format!("decoding chat completion: {e}")))
    }

    /// `GET /v1/models`.
    pub async fn models(&self) -> Result<Value, ProviderError> {
        let mut req = self
            .client
            .get(format!("{}/v1/models", self.endpoint.base_url))
            .timeout(Duration::from_millis(
                crate::config::read_env("AGL_LIST_MODELS_TIMEOUT_MS")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(4000),
            ));
        if let Some(k) = self.endpoint.api_key.as_deref() {
            if !k.is_empty() {
                req = req.bearer_auth(k);
            }
        }
        let resp = req
            .send()
            .await
            .map_err(|e| ProviderError::Transport(format!("listing models: {e}")))?;
        if !resp.status().is_success() {
            return Err(Self::error_for(resp).await);
        }
        resp.json()
            .await
            .map_err(|e| ProviderError::Decode(format!("decoding models: {e}")))
    }

    /// `POST /v1/embeddings`.
    pub async fn embeddings(&self, model: &str, input: &Value) -> Result<Value, ProviderError> {
        let body = json!({ "model": model, "input": input });
        let resp = self
            .post("/v1/embeddings", &body)
            .send()
            .await
            .map_err(|e| ProviderError::Transport(format!("embeddings: {e}")))?;
        if !resp.status().is_success() {
            return Err(Self::error_for(resp).await);
        }
        resp.json()
            .await
            .map_err(|e| ProviderError::Decode(format!("decoding embeddings: {e}")))
    }

    /// `POST /v1/systemone` — the native typed-decision endpoint.
    ///
    /// Not chat completions: a decision model answers typed questions about a
    /// `state` in one forward pass per question, all questions in one request,
    /// and generates no tokens (`usage.output_tokens` is always 0).
    pub async fn decisions(
        &self,
        model: &str,
        state: &Value,
        questions: &Value,
        files: Option<&[String]>,
    ) -> Result<DecisionResponse, ProviderError> {
        let empty = questions
            .as_object()
            .map(|m| m.is_empty())
            .unwrap_or(true);
        if empty {
            // The server 400s on an empty set; the caller is supposed to treat
            // "no questions" as the end of a run, so fail here rather than
            // spend a round trip learning that.
            return Err(ProviderError::Http {
                status: 400,
                message: " (`questions` is empty — an empty question set ends a run, it is not a request)".into(),
            });
        }
        let mut body = Map::new();
        body.insert("state".into(), state.clone());
        body.insert("questions".into(), questions.clone());
        if !model.is_empty() {
            body.insert("model".into(), json!(model));
        }
        if let Some(f) = files {
            if !f.is_empty() {
                body.insert("files".into(), json!(f));
            }
        }

        let resp = self
            .post("/v1/systemone", &Value::Object(body))
            .send()
            .await
            .map_err(|e| {
                ProviderError::Transport(format!(
                    "Unable to reach the decision endpoint at {}/v1/systemone: {e}",
                    self.endpoint.base_url
                ))
            })?;

        if resp.status().as_u16() == 501 {
            // The server's own "this is not a decision model" signal.
            let err = Self::error_for(resp).await;
            let detail = match &err {
                ProviderError::Http { message, .. } => message.clone(),
                other => other.to_string(),
            };
            return Err(ProviderError::NotADecisionModel(format!(
                "This endpoint is not a decision model (501 from /v1/systemone){detail}. \
                 Point `decision_model` at a server whose /v1/models reports \
                 output_modalities: [\"decisions\"]."
            )));
        }
        if !resp.status().is_success() {
            return Err(Self::error_for(resp).await);
        }
        resp.json::<DecisionResponse>()
            .await
            .map_err(|e| ProviderError::Decode(format!("decoding decision response: {e}")))
    }
}

/// The `/v1/systemone` response.
#[derive(Debug, Clone, Deserialize)]
pub struct DecisionResponse {
    #[serde(default)]
    pub model: Option<String>,
    pub answers: Value,
    #[serde(default)]
    pub usage: Option<DecisionUsage>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct DecisionUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
}

/// Bridges the async provider to the synchronous `Decider` trait that drives
/// the switch loop, so a domain stays plain synchronous code.
pub struct SystemOneDecider {
    client: Generic,
    model: String,
    handle: tokio::runtime::Handle,
}

impl SystemOneDecider {
    pub fn new(client: Generic, model: impl Into<String>, handle: tokio::runtime::Handle) -> Self {
        SystemOneDecider {
            client,
            model: model.into(),
            handle,
        }
    }
}

impl Decider for SystemOneDecider {
    fn decide(&mut self, state: &Value, questions: &Value) -> Result<Decided, SwitchError> {
        let client = self.client.clone();
        let model = self.model.clone();
        let state = state.clone();
        let questions = questions.clone();
        let got = self
            .handle
            .block_on(async move { client.decisions(&model, &state, &questions, None).await })
            .map_err(|e| match e {
                ProviderError::NotADecisionModel(m) => SwitchError::Protocol(m),
                other => SwitchError::Transport(other.to_string()),
            })?;
        let u = got.usage.unwrap_or_default();
        Ok(Decided {
            answers: got.answers,
            usage: Usage {
                input_tokens: u.input_tokens,
                output_tokens: u.output_tokens,
                requests: 1,
            },
        })
    }
}

/// `{ name: (description, parameters, required) }` rendered as the OpenAI
/// `tools` array.
pub fn render_tools(tools: &BTreeMap<String, ToolSpec>) -> Value {
    let arr: Vec<Value> = tools
        .values()
        .map(|t| {
            json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": {
                        "type": "object",
                        "properties": t.properties,
                        "required": t.required,
                    }
                }
            })
        })
        .collect();
    Value::Array(arr)
}

/// A registered tool's schema.
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub properties: Value,
    pub required: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_urls_lose_trailing_slashes_and_v1() {
        assert_eq!(normalize_base("http://h:1234/"), "http://h:1234");
        assert_eq!(normalize_base("http://h:1234/v1"), "http://h:1234");
        assert_eq!(normalize_base("  https://h:1 "), "https://h:1");
        assert_eq!(normalize_base(""), "");
    }

    #[test]
    fn host_port_becomes_https_and_v1_is_stripped() {
        assert_eq!(
            normalize_proxy(Some("host.containers.internal:1234")),
            "https://host.containers.internal:1234"
        );
        assert_eq!(
            normalize_proxy(Some("http://127.0.0.1:1234/v1/")),
            "http://127.0.0.1:1234"
        );
        assert_eq!(normalize_proxy(Some("https://uber.home:1234")), "https://uber.home:1234");
        assert_eq!(normalize_proxy(Some("")), "");
        assert_eq!(normalize_proxy(None), "");
    }

    #[test]
    fn an_empty_base_url_is_refused_with_the_config_hint() {
        let err = Generic::new(Endpoint::default()).unwrap_err();
        assert!(matches!(err, ProviderError::MissingBaseUrl(_)));
        assert!(err.to_string().contains("endpoints"));
    }

    #[test]
    fn https_without_a_key_is_refused_but_http_is_allowed() {
        // A local llama-server usually has no --api-key, so http is fine.
        assert!(Generic::new(Endpoint {
            base_url: "http://127.0.0.1:1234".into(),
            ..Default::default()
        })
        .is_ok());
        let err = Generic::new(Endpoint {
            base_url: "https://api.example.com".into(),
            ..Default::default()
        })
        .unwrap_err();
        assert!(matches!(err, ProviderError::MissingApiKey(_)));
    }

    #[test]
    fn tools_render_in_the_openai_shape() {
        let mut t = BTreeMap::new();
        t.insert(
            "spin".to_string(),
            ToolSpec {
                name: "spin".into(),
                description: "spin it".into(),
                properties: json!({ "n": { "type": "number" } }),
                required: vec!["n".into()],
            },
        );
        let v = render_tools(&t);
        assert_eq!(v[0]["type"], "function");
        assert_eq!(v[0]["function"]["name"], "spin");
        assert_eq!(v[0]["function"]["parameters"]["type"], "object");
        assert_eq!(v[0]["function"]["parameters"]["required"][0], "n");
    }
}
