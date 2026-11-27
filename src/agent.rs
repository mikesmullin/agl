use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::config::{self, EndpointEntry, Yaml};
use crate::handlebars::apply_locals;
use crate::provider::{
    render_tools, Endpoint, Generic, InferenceRequest, Message, ProviderError, SystemOneDecider,
    Channel, ToolCall, ToolSpec,
};
use crate::switch::{self, Answer, Domain, Ended, Mode, Outcome, SwitchError};

pub const FALLBACK_DEFAULT_MODEL: &str = "llama-server:gemma-4-12b-qat";
pub const FALLBACK_CONTEXT_WINDOW: u64 = 32_768;
pub const DEFAULT_MAX_TOOLS: usize = 256;

pub const CANONICAL: [&str; 1] = ["generic"];

pub fn alias_target(name: &str) -> Option<&'static str> {
    match name {
        "llama-server" | "openai" | "systemone" | "meta" | "muse" => Some("generic"),
        _ => None,
    }
}

pub fn resolve_provider_id(name: &str) -> String {
    alias_target(name).map(|s| s.to_string()).unwrap_or_else(|| name.to_string())
}

pub fn known_provider_ids() -> Vec<&'static str> {
    vec![
        "generic",
        "llama-server",
        "openai",
        "systemone",
        "meta",
        "muse",
    ]
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Quirks {
    pub tool_choice: Option<String>,
    pub stream: Option<bool>,
    pub decisions: Option<bool>,
    pub tool_images: Option<bool>,
}

impl Quirks {
    fn from_entry(e: &EndpointEntry) -> Option<Quirks> {
        let q = Quirks {
            tool_choice: e.tool_choice.clone(),
            stream: e.stream,
            decisions: e.decisions,
            tool_images: e.tool_images,
        };
        if q == Quirks::default() {
            None
        } else {
            Some(q)
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Builtin {
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub quirks: Option<Quirks>,
}

fn ferry_tool_images(messages: Vec<Message>) -> Vec<Message> {
    let mut out = Vec::with_capacity(messages.len() + 2);
    for m in messages {
        let is_tool = m.role == "tool";
        let Some(Value::Array(parts)) = m.content.as_ref() else {
            out.push(m);
            continue;
        };
        let has_images = parts
            .iter()
            .any(|p| p.get("type").and_then(Value::as_str) == Some("image_url"));
        if !is_tool || !has_images {
            out.push(m);
            continue;
        }
        let mut text_parts: Vec<Value> = Vec::new();
        let mut images: Vec<Value> = Vec::new();
        for p in parts {
            if p.get("type").and_then(Value::as_str) == Some("image_url") {
                images.push(p.clone());
            } else {
                text_parts.push(p.clone());
            }
        }
        let mut tool_msg = m;
        tool_msg.content = Some(Value::Array(text_parts));
        out.push(tool_msg);
        let mut user_parts = vec![serde_json::json!(
            {"type": "text", "text": "The tool result above carries this image — look at it directly:"}
        )];
        user_parts.extend(images);
        out.push(Message {
            role: "user".into(),
            content: Some(Value::Array(user_parts)),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        });
    }
    out
}

pub fn builtin_endpoint(provider: &str) -> Option<Builtin> {
    match provider {
        "llama-server" => Some(Builtin {
            base_url: Some(
                config::read_env("LLAMA_SERVER_BASE_URL")
                    .unwrap_or_else(|| "http://127.0.0.1:1234".into()),
            ),
            api_key: Some(config::read_env("LLAMA_SERVER_API_KEY").unwrap_or_default()),
            quirks: None,
        }),
        "systemone" => Some(Builtin {
            base_url: Some(
                config::read_env("SYSTEMONE_URL").unwrap_or_else(|| "http://127.0.0.1:1237".into()),
            ),
            api_key: Some(config::read_env("SYSTEMONE_API_KEY").unwrap_or_default()),
            quirks: Some(Quirks {
                decisions: Some(true),
                ..Default::default()
            }),
        }),
        "openai" => Some(Builtin {
            base_url: Some(
                config::read_env("OPENAI_BASE_URL").unwrap_or_else(|| "https://api.openai.com".into()),
            ),
            api_key: None,
            quirks: None,
        }),
        "meta" => Some(Builtin {
            base_url: Some(
                config::read_env("META_BASE_URL").unwrap_or_else(|| "https://api.meta.ai".into()),
            ),
            api_key: Some(
                config::read_env("META_API_KEY")
                    .or_else(|| config::read_env("MUSE_API_KEY"))
                    .unwrap_or_default(),
            ),
            quirks: Some(Quirks {
                tool_choice: Some("auto".into()),
                stream: Some(false),
                decisions: None,
                tool_images: Some(false),
            }),
        }),
        _ => None,
    }
}

fn env_stem(provider: &str) -> String {
    provider.to_uppercase().replace('-', "_")
}

pub fn normalize_gateway_provider(name: &str) -> String {
    match name {
        "github" | "github-copilot" => "copilot".to_string(),
        "muse" => "meta".to_string(),
        other => other.to_string(),
    }
}

pub fn split_provider_model(spec: &str) -> (String, String) {
    let s = spec.trim();
    if let Some(idx) = s.find(':') {
        if idx > 0 {
            return (s[..idx].to_string(), s[idx + 1..].to_string());
        }
    }
    let m = s.to_lowercase();
    let provider = if ["gpt-", "claude", "luna", "terra", "sol", "fable"]
        .iter()
        .any(|k| m.contains(k))
    {
        "copilot"
    } else {
        "generic"
    };
    (provider.to_string(), s.to_string())
}

pub fn resolve_default_model() -> String {
    config::read_user_default_model().unwrap_or_else(|| FALLBACK_DEFAULT_MODEL.to_string())
}

pub fn queue_spec(model: &str) -> String {
    let spec = if model == "default" {
        resolve_default_model()
    } else {
        model.to_string()
    };
    let (raw_provider, m) = split_provider_model(&spec);
    format!("{}:{}", normalize_gateway_provider(&raw_provider), m)
}

fn pick_window(group: &BTreeMap<String, Yaml>, key: &str) -> Option<u64> {
    let n = group.get(key)?.as_i64()?;
    if n > 0 {
        Some(n as u64)
    } else {
        None
    }
}

pub fn resolve_context_window(spec: &str) -> u64 {
    let (provider, model) = split_provider_model(spec);
    let cfg = config::read_user_config();
    let Some(windows) = cfg.get("context_windows").and_then(|w| w.as_map()) else {
        return FALLBACK_CONTEXT_WINDOW;
    };

    let mut groups: Vec<&BTreeMap<String, Yaml>> = Vec::new();
    if let Some(g) = windows.get(&provider).and_then(|g| g.as_map()) {
        groups.push(g);
    }
    let alias = match provider.as_str() {
        "meta" => Some("muse"),
        "muse" => Some("meta"),
        _ => None,
    };
    if let Some(a) = alias {
        if let Some(g) = windows.get(a).and_then(|g| g.as_map()) {
            if !groups.iter().any(|existing| std::ptr::eq(*existing, g)) {
                groups.push(g);
            }
        }
    }
    if groups.is_empty() {
        return FALLBACK_CONTEXT_WINDOW;
    }

    for g in &groups {
        if let Some(n) = pick_window(g, &model) {
            return n;
        }
    }
    if !model.is_empty() {
        let lower = model.to_lowercase();
        for g in &groups {
            for (k, v) in g.iter() {
                if k.to_lowercase() == lower {
                    if let Some(n) = v.as_i64() {
                        if n > 0 {
                            return n as u64;
                        }
                    }
                }
            }
        }
    }
    for g in &groups {
        if let Some(n) = pick_window(g, "default") {
            return n;
        }
    }
    FALLBACK_CONTEXT_WINDOW
}

pub fn resolve_concurrency(spec: &str) -> usize {
    let (provider, model) = split_provider_model(spec);
    let cfg = config::read_user_config();
    let Some(group) = cfg.get("concurrency").and_then(|w| w.as_map()) else {
        return 1;
    };
    let pick = |g: &BTreeMap<String, Yaml>, key: &str| -> Option<usize> {
        let n = g.get(key)?.as_i64()?;
        if n > 0 {
            Some(n as usize)
        } else {
            None
        }
    };
    let mut groups: Vec<&BTreeMap<String, Yaml>> = Vec::new();
    if let Some(g) = group.get(&provider).and_then(|g| g.as_map()) {
        groups.push(g);
    }
    let alias = match provider.as_str() {
        "meta" => Some("muse"),
        "muse" => Some("meta"),
        _ => None,
    };
    if let Some(a) = alias {
        if let Some(g) = group.get(a).and_then(|g| g.as_map()) {
            if !groups.iter().any(|existing| std::ptr::eq(*existing, g)) {
                groups.push(g);
            }
        }
    }
    if groups.is_empty() {
        return 1;
    }
    for g in &groups {
        if let Some(n) = pick(g, &model) {
            return n;
        }
    }
    if !model.is_empty() {
        let lower = model.to_lowercase();
        for g in &groups {
            for (k, v) in g.iter() {
                if k.to_lowercase() == lower {
                    if let Some(n) = v.as_i64() {
                        if n > 0 {
                            return n as usize;
                        }
                    }
                }
            }
        }
    }
    for g in &groups {
        if let Some(n) = pick(g, "default") {
            return n;
        }
    }
    1
}

#[derive(Debug)]
pub enum AgentError {
    UnknownProvider(String),
    BadModelSpec(String),
    NoDecisionModel(String),
    Provider(ProviderError),
    Switch(SwitchError),
    Tool(String),
    MaxTurns(String),
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentError::UnknownProvider(m)
            | AgentError::BadModelSpec(m)
            | AgentError::NoDecisionModel(m)
            | AgentError::Tool(m)
            | AgentError::MaxTurns(m) => write!(f, "{m}"),
            AgentError::Provider(e) => write!(f, "{e}"),
            AgentError::Switch(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for AgentError {}

impl From<ProviderError> for AgentError {
    fn from(e: ProviderError) -> Self {
        AgentError::Provider(e)
    }
}

impl From<SwitchError> for AgentError {
    fn from(e: SwitchError) -> Self {
        AgentError::Switch(e)
    }
}

#[derive(Debug)]
pub enum TurnEvent<'a> {
    Queued { spec: &'a str, position: usize },
    Delta { text: &'a str, channel: Channel },
    ToolCall {
        id: &'a str,
        name: &'a str,
        args: &'a Value,
    },
    ToolResult {
        id: &'a str,
        name: &'a str,
        text: &'a str,
    },
}

pub type ToolHandler = Box<dyn Fn(&Value) -> Result<String, String> + Send + Sync>;

pub struct Tool {
    pub spec: ToolSpec,
    pub handler: ToolHandler,
}

#[derive(Clone, Default)]
pub struct Factory {
    pub model: Option<String>,
    pub decision_model: Option<String>,
    pub system_prompt: Option<String>,
    pub locals: Option<Value>,
    pub tool_choice: Option<Value>,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub reasoning_effort: Option<String>,
    pub max_turns: Option<usize>,
    pub max_tools: Option<usize>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub ca_file: Option<String>,
    pub proxy: Option<String>,
    pub retain_history: Option<bool>,
    pub slot: Option<std::sync::Arc<crate::queue::Permit>>,
    pub parallel_tools: Option<bool>,
    pub message_filter: Option<std::sync::Arc<dyn Fn(Message) -> Message + Send + Sync>>,
}

impl std::fmt::Debug for Factory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Factory")
            .field("model", &self.model)
            .field("decision_model", &self.decision_model)
            .field("system_prompt", &self.system_prompt)
            .field("locals", &self.locals)
            .field("tool_choice", &self.tool_choice)
            .field("max_tokens", &self.max_tokens)
            .field("temperature", &self.temperature)
            .field("reasoning_effort", &self.reasoning_effort)
            .field("max_turns", &self.max_turns)
            .field("max_tools", &self.max_tools)
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key)
            .field("ca_file", &self.ca_file)
            .field("proxy", &self.proxy)
            .field("retain_history", &self.retain_history)
            .field("parallel_tools", &self.parallel_tools)
            .field(
                "message_filter",
                &self.message_filter.as_ref().map(|_| "<message_filter>"),
            )
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct ContextRow {
    pub id: String,
    pub visible: bool,
    pub message: Message,
}

fn is_tool_call_only(m: &Message) -> bool {
    if m.role != "assistant" {
        return false;
    }
    let has_calls = m.tool_calls.as_ref().map(|c| !c.is_empty()).unwrap_or(false);
    if !has_calls {
        return false;
    }
    match &m.content {
        None => true,
        Some(v) => v.as_str().map(|s| s.trim().is_empty()).unwrap_or(false),
    }
}

fn new_ctx_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    format!("ctx_{}", N.fetch_add(1, Ordering::Relaxed))
}

pub struct Agent {
    pub provider: String,
    pub model: String,
    pub bound_spec: String,
    pub client: Generic,
    pub endpoint_quirks: Option<Quirks>,
    pub system_prompt: Option<String>,
    pub context_window_size: u64,
    pub tool_choice: Option<Value>,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub reasoning_effort: Option<String>,
    pub max_turns: usize,
    pub max_tools: usize,
    pub tools: BTreeMap<String, Tool>,
    pub retain_history: bool,
    pub parallel_tools: bool,
    pub message_filter: Option<std::sync::Arc<dyn Fn(Message) -> Message + Send + Sync>>,
    context_window: std::sync::Mutex<Vec<ContextRow>>,
    pub last_usage: std::sync::Mutex<Option<crate::provider::TokenUsage>>,
    slot: Option<std::sync::Arc<crate::queue::Permit>>,

    pub decision_provider: Option<String>,
    pub decision_model: Option<String>,
    pub decision_spec: Option<String>,
    decision_client: Option<Generic>,
}

impl std::fmt::Debug for Agent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Agent")
            .field("provider", &self.provider)
            .field("model", &self.model)
            .field("bound_spec", &self.bound_spec)
            .field("base_url", &self.client.base_url())
            .field("endpoint_quirks", &self.endpoint_quirks)
            .field("context_window_size", &self.context_window_size)
            .field("max_turns", &self.max_turns)
            .field("tools", &self.tools.keys().collect::<Vec<_>>())
            .field("decision_spec", &self.decision_spec)
            .finish()
    }
}

fn endpoint_for(provider: &str, model: &str) -> (Endpoint, Option<Quirks>) {
    let eps = config::read_user_endpoints();
    if let Some(ep) = eps.get(provider) {
        let stem = env_stem(provider);
        let url = apply_locals(&ep.url, Some(&json!({ "model": model })));
        let api_key = match &ep.api_key {
            Some(k) => Some(k.clone()),
            None => config::read_env(&format!("{stem}_API_KEY")),
        };
        let ca_file = ep
            .ca_file
            .clone()
            .or_else(|| config::read_env(&format!("{stem}_CA_FILE")));
        let quirks = Quirks::from_entry(ep)
            .or_else(|| builtin_endpoint(provider).and_then(|b| b.quirks));
        return (
            Endpoint {
                base_url: url.trim().to_string(),
                api_key,
                ca_file,
            },
            quirks,
        );
    }
    if let Some(b) = builtin_endpoint(provider) {
        return (
            Endpoint {
                base_url: b.base_url.unwrap_or_default(),
                api_key: b.api_key,
                ca_file: None,
            },
            b.quirks,
        );
    }
    (Endpoint::default(), None)
}

impl Agent {
    pub fn factory(opts: Factory) -> Result<Self, AgentError> {
        let spec = match &opts.model {
            Some(m) if !m.trim().is_empty() => m.trim().to_string(),
            _ => resolve_default_model(),
        };
        let spec = if spec == "default" {
            resolve_default_model()
        } else {
            spec
        };

        let (raw_provider, model) = split_provider_model(&spec);
        let provider = normalize_gateway_provider(&raw_provider);

        let proxy = crate::provider::normalize_proxy(opts.proxy.as_deref());
        let (endpoint, quirks, model, bound_spec) = if !proxy.is_empty() {
            (
                Endpoint {
                    base_url: opts.base_url.clone().unwrap_or(proxy),
                    api_key: opts.api_key.clone(),
                    ca_file: opts.ca_file.clone(),
                },
                None,
                spec.clone(),
                spec.clone(),
            )
        } else {
            let canonical = resolve_provider_id(&provider);
            if !CANONICAL.contains(&canonical.as_str())
                && !config::read_user_endpoints().contains_key(&provider)
            {
                return Err(AgentError::UnknownProvider(format!(
                    "Unknown AI provider: {provider}. Known: {} — or add it to the \
                     `endpoints` map in {}.",
                    known_provider_ids().join(", "),
                    config::user_config_path().display()
                )));
            }
            let (mut ep, q) = endpoint_for(&provider, &model);
            if let Some(b) = &opts.base_url {
                ep.base_url = b.clone();
            }
            if opts.api_key.is_some() {
                ep.api_key = opts.api_key.clone();
            }
            if opts.ca_file.is_some() {
                ep.ca_file = opts.ca_file.clone();
            }
            let bs = queue_spec(&spec);
            (ep, q, model, bs)
        };

        let client = Generic::new(endpoint)?;
        let system_prompt = opts
            .system_prompt
            .as_ref()
            .map(|p| apply_locals(p, opts.locals.as_ref()));

        let mut agent = Agent {
            provider,
            model,
            context_window_size: resolve_context_window(&bound_spec),
            bound_spec,
            slot: opts.slot,
            client,
            endpoint_quirks: quirks,
            system_prompt,
            tool_choice: opts.tool_choice,
            max_tokens: opts.max_tokens,
            temperature: opts.temperature,
            reasoning_effort: opts.reasoning_effort,
            max_turns: match opts.max_turns.unwrap_or(5) {
                0 => usize::MAX,
                n => n.max(1),
            },
            max_tools: opts.max_tools.unwrap_or(DEFAULT_MAX_TOOLS),
            tools: BTreeMap::new(),
            retain_history: opts.retain_history.unwrap_or(false),
            parallel_tools: opts.parallel_tools.unwrap_or(false),
            message_filter: opts.message_filter,
            context_window: std::sync::Mutex::new(Vec::new()),
            last_usage: std::sync::Mutex::new(None),
            decision_provider: None,
            decision_model: None,
            decision_spec: None,
            decision_client: None,
        };

        if let Some(dm) = &opts.decision_model {
            agent.bind_decision_model(dm)?;
        }
        Ok(agent)
    }

    pub fn bind_decision_model(&mut self, spec: &str) -> Result<(), AgentError> {
        let resolved = spec.trim();
        let idx = resolved.find(':');
        let Some(idx) = idx.filter(|i| *i > 0 && *i < resolved.len() - 1) else {
            return Err(AgentError::BadModelSpec(format!(
                "Invalid decision_model format: {resolved}. Expected \"provider:model\" \
                 (e.g. systemone:default)."
            )));
        };
        let provider = normalize_gateway_provider(&resolved[..idx]);
        let model = resolved[idx + 1..].to_string();

        let canonical = resolve_provider_id(&provider);
        let in_map = config::read_user_endpoints().contains_key(&provider);
        if !CANONICAL.contains(&canonical.as_str()) && !in_map {
            return Err(AgentError::UnknownProvider(format!(
                "Unknown decision provider: {provider}. Known: {} — or add it to the \
                 `endpoints` map in {}.",
                known_provider_ids().join(", "),
                config::user_config_path().display()
            )));
        }

        let (endpoint, _quirks) = endpoint_for(&provider, &model);
        if endpoint.base_url.trim().is_empty() {
            return Err(AgentError::NoDecisionModel(format!(
                "No endpoint for decision provider \"{provider}\" — add it to the `endpoints` \
                 map in {} (e.g. `systemone: http://127.0.0.1:1237`) or set SYSTEMONE_URL.",
                config::user_config_path().display()
            )));
        }
        self.decision_client = Some(Generic::new(endpoint)?);
        self.decision_spec = Some(format!("{provider}:{model}"));
        self.decision_provider = Some(provider);
        self.decision_model = Some(model);
        Ok(())
    }

    pub fn decision_base_url(&self) -> Option<&str> {
        self.decision_client.as_ref().map(|c| c.base_url())
    }

    pub fn tool(
        &mut self,
        name: &str,
        description: &str,
        properties: Value,
        required: Vec<String>,
        handler: impl Fn(&Value) -> Result<String, String> + Send + Sync + 'static,
    ) -> Result<(), AgentError> {
        if name.is_empty() {
            return Err(AgentError::Tool("Tool: name must be non-empty".into()));
        }
        if self.max_tools < 1 {
            return Err(AgentError::Tool("max_tools must be a positive integer".into()));
        }
        if !self.tools.contains_key(name) && self.tools.len() >= self.max_tools {
            return Err(AgentError::Tool(format!(
                "Tool limit exceeded: maximum {} tools allowed",
                self.max_tools
            )));
        }
        self.tools.insert(
            name.to_string(),
            Tool {
                spec: ToolSpec {
                    name: name.to_string(),
                    description: description.to_string(),
                    properties,
                    required,
                },
                handler: Box::new(handler),
            },
        );
        Ok(())
    }

    pub fn render_tools(&self) -> Value {
        let specs: BTreeMap<String, ToolSpec> = self
            .tools
            .iter()
            .map(|(k, v)| (k.clone(), v.spec.clone()))
            .collect();
        render_tools(&specs)
    }

    fn build_request(&self, messages: Vec<Message>) -> InferenceRequest {
        let has_tools = !self.tools.is_empty();
        let mut tool_choice = self.tool_choice.clone();
        if let Some(q) = &self.endpoint_quirks {
            if let Some(tc) = &q.tool_choice {
                if has_tools || tool_choice.is_some() {
                    tool_choice = Some(Value::String(tc.clone()));
                }
            }
        }
        InferenceRequest {
            model: self.model.clone(),
            messages,
            tools: if has_tools {
                Some(self.render_tools())
            } else {
                None
            },
            tool_choice,
            max_tokens: self.max_tokens,
            temperature: self.temperature,
            top_p: None,
            reasoning_effort: self.reasoning_effort.clone(),
            chat_template_kwargs: None,
        }
    }

    pub fn may_stream(&self, requested: bool) -> bool {
        match self.endpoint_quirks.as_ref().and_then(|q| q.stream) {
            Some(false) => false,
            _ => requested,
        }
    }

    async fn run_tools(&self, calls: &[ToolCall]) -> Vec<String> {
        let mut out = Vec::with_capacity(calls.len());
        for call in calls {
            out.push(self.invoke_tool(call));
            tokio::task::yield_now().await;
        }
        out
    }

    fn invoke_tool(&self, call: &ToolCall) -> String {
        let raw = &call.function.arguments;
        let args: Value = if raw.trim().is_empty() {
            json!({})
        } else {
            match serde_json::from_str(raw) {
                Ok(v) => v,
                Err(e) => {
                    return json!({
                        "error": format!("invalid tool arguments (possibly truncated): {e}"),
                        "raw": raw.chars().take(400).collect::<String>(),
                    })
                    .to_string();
                }
            }
        };
        match self.tools.get(&call.function.name) {
            Some(t) => (t.handler)(&args).unwrap_or_else(|e| format!("error: {e}")),
            None => format!(
                "error: unknown tool \"{}\". Known: {}",
                call.function.name,
                self.tools.keys().cloned().collect::<Vec<_>>().join(", ")
            ),
        }
    }


    pub fn push_context(&self, message: Message) -> String {
        let id = new_ctx_id();
        self.context_window.lock().unwrap().push(ContextRow {
            id: id.clone(),
            visible: true,
            message,
        });
        id
    }

    pub fn context_snapshot(&self) -> Vec<ContextRow> {
        self.context_window.lock().unwrap().clone()
    }

    pub fn clear_context(&self) {
        self.context_window.lock().unwrap().clear();
    }

    pub fn context_len(&self) -> usize {
        self.context_window.lock().unwrap().len()
    }

    pub fn messages_for_provider(&self) -> Vec<Message> {
        let mut out: Vec<Message> = Vec::new();
        if let Some(sp) = &self.system_prompt {
            if !sp.is_empty() {
                out.push(Message::system(sp.clone()));
            }
        }
        let rows = self.context_window.lock().unwrap();
        for row in rows.iter() {
            if !row.visible {
                continue;
            }
            let role = row.message.role.as_str();
            if role == "system" || role == "reasoning" {
                continue;
            }
            let msg = row.message.clone();
            if is_tool_call_only(&msg) {
                if let Some(prev) = out.last_mut() {
                    if is_tool_call_only(prev) {
                        let mut merged = prev.tool_calls.clone().unwrap_or_default();
                        merged.extend(msg.tool_calls.clone().unwrap_or_default());
                        prev.tool_calls = Some(merged);
                        continue;
                    }
                }
            }
            out.push(msg);
        }
        out
    }

    fn filtered_messages(&self, messages: Vec<Message>) -> Vec<Message> {
        let filtered = match &self.message_filter {
            Some(filter) => messages.into_iter().map(|m| filter(m)).collect(),
            None => messages,
        };
        if self.endpoint_quirks.as_ref().and_then(|q| q.tool_images) == Some(false) {
            ferry_tool_images(filtered)
        } else {
            filtered
        }
    }

    pub async fn run(&self, prompt: &str) -> Result<String, AgentError> {
        let mut ev = Self::noop_events;
        self.run_inner(Message::user(prompt), false, &mut ev).await
    }

    pub fn noop_events(_e: TurnEvent<'_>) {}

    pub async fn run_stream(
        &self,
        prompt: &str,
        on_delta: &mut dyn FnMut(&str, Channel),
    ) -> Result<String, AgentError> {
        let mut ev = |e: TurnEvent<'_>| {
            if let TurnEvent::Delta { text, channel } = e {
                on_delta(text, channel);
            }
        };
        self.run_inner(Message::user(prompt), true, &mut ev).await
    }

    pub async fn run_events(
        &self,
        prompt: &str,
        stream: bool,
        on_event: &mut dyn FnMut(TurnEvent<'_>),
    ) -> Result<String, AgentError> {
        self.run_inner(Message::user(prompt), stream, on_event).await
    }

    pub async fn run_message(
        &self,
        user: Message,
        stream: bool,
        on_event: &mut dyn FnMut(TurnEvent<'_>),
    ) -> Result<String, AgentError> {
        self.run_inner(user, stream, on_event).await
    }

    async fn run_inner(
        &self,
        user: Message,
        want_stream: bool,
        on_event: &mut dyn FnMut(TurnEvent<'_>),
    ) -> Result<String, AgentError> {
        let streaming = want_stream && self.may_stream(true);
        let retain = self.retain_history;

        let _permit: std::sync::Arc<crate::queue::Permit> = match &self.slot {
            Some(held) if held.spec() == self.bound_spec => held.clone(),
            _ => {
                let st = crate::queue::stats(&self.bound_spec);
                if st.held >= st.limit || st.waiting > 0 {
                    on_event(TurnEvent::Queued {
                        spec: &self.bound_spec,
                        position: st.waiting + 1,
                    });
                }
                std::sync::Arc::new(crate::queue::acquire(&self.bound_spec).await)
            }
        };

        let mut oneshot: Vec<Message> = Vec::new();
        if retain {
            self.push_context(user);
        } else {
            if let Some(sp) = &self.system_prompt {
                oneshot.push(Message::system(sp.clone()));
            }
            oneshot.push(user);
        }

        for _turn in 0..self.max_turns {
            let messages = if retain {
                self.messages_for_provider()
            } else {
                oneshot.clone()
            };
            let messages = self.filtered_messages(messages);
            let req = self.build_request(messages);
            let result = if streaming {
                let mut delta = |text: &str, channel: Channel| {
                    on_event(TurnEvent::Delta { text, channel });
                };
                self.client.inference_stream(&req, &mut delta).await?
            } else {
                self.client.inference(&req).await?
            };
            if let Some(u) = &result.usage {
                *self.last_usage.lock().unwrap() = Some(u.clone());
            }

            let calls: Vec<ToolCall> = result
                .choices
                .iter()
                .filter_map(|c| c.message.tool_calls.clone())
                .flatten()
                .collect();

            if calls.is_empty() {
                if retain {
                    if let Some(first) = result.choices.first() {
                        let m = &first.message;
                        self.push_context(Message {
                            role: "assistant".into(),
                            content: Some(
                                m.content.clone().unwrap_or(Value::String(String::new())),
                            ),
                            tool_calls: m.tool_calls.clone(),
                            tool_call_id: None,
                            reasoning_content: None,
                        });
                    }
                }
                return Ok(result
                    .choices
                    .iter()
                    .rev()
                    .find_map(|c| {
                        c.message
                            .content
                            .as_ref()
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_default());
            }

            for call in &calls {
                let row = Message {
                    role: "assistant".into(),
                    content: Some(Value::String(String::new())),
                    tool_calls: Some(vec![call.clone()]),
                    tool_call_id: None,
                    reasoning_content: None,
                };
                if retain {
                    self.push_context(row);
                } else {
                    oneshot.push(row);
                }
            }

            for call in &calls {
                let args: Value = serde_json::from_str(&call.function.arguments)
                    .unwrap_or_else(|_| json!({}));
                on_event(TurnEvent::ToolCall {
                    id: &call.id,
                    name: &call.function.name,
                    args: &args,
                });
            }

            let results = self.run_tools(&calls).await;
            for (call, content) in calls.iter().zip(results.iter()) {
                on_event(TurnEvent::ToolResult {
                    id: &call.id,
                    name: &call.function.name,
                    text: content,
                });
            }
            for (call, content) in calls.iter().zip(results) {
                let msg = Message::tool_result(call.id.clone(), content);
                if retain {
                    self.push_context(msg);
                } else {
                    oneshot.push(msg);
                }
            }
        }
        Err(AgentError::MaxTurns(format!(
            "agent exceeded max_turns={} without a final answer",
            self.max_turns
        )))
    }

    pub fn switch(
        &self,
        domain: &dyn Domain,
        input: &Value,
        handle: tokio::runtime::Handle,
    ) -> Result<Outcome, AgentError> {
        let client = self.decision_client.clone().ok_or_else(|| {
            AgentError::NoDecisionModel(
                "agent.switch() needs a decision model — set decision_model on Factory \
                 (e.g. \"systemone:default\")."
                    .into(),
            )
        })?;
        let model = self.decision_model.clone().unwrap_or_default();
        let mut decider = SystemOneDecider::new(client, model, handle);
        Ok(switch::run_switch(
            domain,
            input,
            Mode::Run(&mut decider),
            self.decision_spec.as_deref(),
            0.5,
        )?)
    }

    pub fn replay(
        &self,
        domain: &dyn Domain,
        trace_jsonl: &str,
    ) -> Result<Outcome, AgentError> {
        let rows = switch::parse_trace(trace_jsonl)?;
        Ok(switch::run_switch(
            domain,
            &Value::Null,
            Mode::Replay(rows),
            self.decision_spec.as_deref(),
            0.5,
        )?)
    }

    pub fn fork(
        &self,
        domain: &dyn Domain,
        trace_jsonl: &str,
        steps: usize,
        handle: tokio::runtime::Handle,
    ) -> Result<Outcome, AgentError> {
        let client = self.decision_client.clone().ok_or_else(|| {
            AgentError::NoDecisionModel("agent.fork() needs a decision model".into())
        })?;
        let model = self.decision_model.clone().unwrap_or_default();
        let rows = switch::parse_trace(trace_jsonl)?;
        let mut decider = SystemOneDecider::new(client, model, handle);
        Ok(switch::run_switch(
            domain,
            &Value::Null,
            Mode::Fork {
                trace: rows,
                steps,
                decider: &mut decider,
            },
            self.decision_spec.as_deref(),
            0.5,
        )?)
    }
}

pub use crate::switch::Ended as SwitchEnded;
pub use crate::switch::{pick, Opt, Question};

#[allow(unused_imports)]
use Answer as _AnswerUsed;
#[allow(unused_imports)]
use Ended as _EndedUsed;
