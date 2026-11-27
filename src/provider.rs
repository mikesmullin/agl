use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::switch::{Decided, Decider, SwitchError, Usage};

pub fn normalize_base(url: &str) -> String {
    let mut u = url.trim().trim_end_matches('/').to_string();
    if u.ends_with("/v1") {
        u.truncate(u.len() - 3);
    }
    u
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
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
            reasoning_content: None,
        }
    }
    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Message {
            role: "tool".to_string(),
            content: Some(Value::String(content.into())),
            tool_calls: None,
            tool_call_id: Some(tool_call_id.into()),
            reasoning_content: None,
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

#[derive(Clone, Debug)]
pub struct Generic {
    endpoint: Endpoint,
    client: reqwest::Client,
}

impl Generic {
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

    fn build_body(&self, req: &InferenceRequest, stream: bool) -> Value {
        let mut body = Map::new();
        body.insert("model".into(), json!(req.model));
        body.insert("messages".into(), json!(req.messages));
        body.insert("stream".into(), json!(stream));
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
        if stream {
            body.insert(
                "stream_options".into(),
                json!({ "include_usage": true }),
            );
        }
        Value::Object(body)
    }

    pub async fn inference(&self, req: &InferenceRequest) -> Result<Completion, ProviderError> {
        let body = self.build_body(req, false);

        let resp = self
            .post("/v1/chat/completions", &body)
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

    pub async fn inference_stream(
        &self,
        req: &InferenceRequest,
        on_delta: &mut dyn FnMut(&str, Channel),
    ) -> Result<Completion, ProviderError> {
        use futures_util::StreamExt;

        let body = self.build_body(req, true);
        let resp = self
            .post("/v1/chat/completions", &body)
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

        let mut asm = StreamAssembler::new();
        let mut buf = String::new();
        let mut stream = resp.bytes_stream();
        while let Some(part) = stream.next().await {
            let bytes = part.map_err(|e| {
                ProviderError::Transport(format!("reading the response stream: {e}"))
            })?;
            buf.push_str(&String::from_utf8_lossy(&bytes));
            asm.feed(&mut buf, on_delta);
        }
        let tail = buf.trim().to_string();
        if !tail.is_empty() {
            asm.handle_line(&tail, on_delta);
        }
        Ok(asm.finish())
    }

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

#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub properties: Value,
    pub required: Vec<String>,
}




#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Content,
    Reasoning,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Content => "content",
            Channel::Reasoning => "reasoning",
        }
    }
}

#[derive(Debug, Default)]
pub struct StreamAssembler {
    content: String,
    reasoning: String,
    tool_calls: std::collections::BTreeMap<u64, ToolCall>,
    finish_reason: Option<String>,
    usage: Option<TokenUsage>,
    pub saw_done: bool,
}

impl StreamAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn handle_line(&mut self, line: &str, on_delta: &mut dyn FnMut(&str, Channel)) {
        let Some(rest) = line.strip_prefix("data:") else {
            return;
        };
        let data = rest.trim();
        if data.is_empty() {
            return;
        }
        if data == "[DONE]" {
            self.saw_done = true;
            return;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else {
            return;
        };

        if let Some(u) = chunk.get("usage") {
            if !u.is_null() {
                if let Ok(parsed) = serde_json::from_value::<TokenUsage>(u.clone()) {
                    self.usage = Some(parsed);
                }
            }
        }

        let Some(choice) = chunk.get("choices").and_then(|c| c.get(0)) else {
            return;
        };
        if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
            if !fr.is_empty() {
                self.finish_reason = Some(fr.to_string());
            }
        }
        let empty = json!({});
        let delta = choice.get("delta").unwrap_or(&empty);

        let rdelta = ["reasoning_content", "reasoning", "reasoning_text", "thinking"]
            .iter()
            .find_map(|k| match delta.get(*k) {
                Some(v) if !v.is_null() => Some(v),
                _ => None,
            });
        if let Some(r) = rdelta.and_then(|v| v.as_str()) {
            if !r.is_empty() {
                self.reasoning.push_str(r);
                on_delta(r, Channel::Reasoning);
            }
        }

        if let Some(c) = delta.get("content").and_then(|v| v.as_str()) {
            if !c.is_empty() {
                self.content.push_str(c);
                on_delta(c, Channel::Content);
            }
        }

        if let Some(tcs) = delta.get("tool_calls").and_then(|v| v.as_array()) {
            for tc in tcs {
                let i = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                let slot = self.tool_calls.entry(i).or_insert_with(|| ToolCall {
                    id: format!("call_{i}"),
                    kind: "function".to_string(),
                    function: FunctionCall {
                        name: String::new(),
                        arguments: String::new(),
                    },
                });
                if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                    if !id.is_empty() {
                        slot.id = id.to_string();
                    }
                }
                if let Some(f) = tc.get("function") {
                    if let Some(n) = f.get("name").and_then(|v| v.as_str()) {
                        if !n.is_empty() {
                            slot.function.name.push_str(n);
                        }
                    }
                    if let Some(a) = f.get("arguments").and_then(|v| v.as_str()) {
                        if !a.is_empty() {
                            slot.function.arguments.push_str(a);
                        }
                    }
                }
            }
        }
    }

    pub fn feed(&mut self, buf: &mut String, on_delta: &mut dyn FnMut(&str, Channel)) {
        while let Some(idx) = buf.find('\n') {
            let line: String = buf[..idx].trim().to_string();
            buf.drain(..=idx);
            self.handle_line(&line, on_delta);
        }
    }

    pub fn finish(self) -> Completion {
        let assembled: Vec<ToolCall> = self.tool_calls.into_values().collect();
        let finish_reason = self.finish_reason.unwrap_or_else(|| {
            if assembled.is_empty() {
                "stop".to_string()
            } else {
                "tool_calls".to_string()
            }
        });
        let message = Message {
            role: "assistant".to_string(),
            content: Some(Value::String(self.content)),
            tool_calls: if assembled.is_empty() {
                None
            } else {
                Some(assembled)
            },
            tool_call_id: None,
            reasoning_content: if self.reasoning.is_empty() {
                None
            } else {
                Some(self.reasoning)
            },
        };
        Completion {
            choices: vec![Choice {
                message,
                finish_reason: Some(finish_reason),
            }],
            usage: self.usage,
        }
    }
}
