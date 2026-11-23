//! Agent — port of `src/agent.mjs` (the inference path and `switch()`).
//!
//! Provider resolution follows the JS original exactly, including the parts
//! that look odd: a deprecated id stays VISIBLE as `agent.provider` so its
//! endpoint defaults and its `context_windows` config group keep resolving,
//! while only module lookup goes through the alias table.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::config::{self, EndpointEntry, Yaml};
use crate::handlebars::apply_locals;
use crate::provider::{
    render_tools, Endpoint, Generic, InferenceRequest, Message, ProviderError, SystemOneDecider,
    Channel, ToolCall, ToolSpec,
};
use crate::switch::{self, Answer, Domain, Ended, Mode, Outcome, SwitchError};

/// Used when the user config is missing or unreadable.
pub const FALLBACK_DEFAULT_MODEL: &str = "llama-server:gemma-4-12b-qat";
/// Used when no `context_windows` entry matches.
pub const FALLBACK_CONTEXT_WINDOW: u64 = 32_768;
/// Default tool-registry cap.
pub const DEFAULT_MAX_TOOLS: usize = 256;

/// The canonical provider ids. `copilot` is deliberately absent from this
/// port — see provider.rs.
pub const CANONICAL: [&str; 1] = ["generic"];

/// Deprecated ids kept as aliases so existing `default_model` values and
/// `provider:model` strings keep resolving.
pub fn alias_target(name: &str) -> Option<&'static str> {
    match name {
        "llama-server" | "openai" | "systemone" | "meta" | "muse" => Some("generic"),
        _ => None,
    }
}

/// Canonical provider id for a possibly-aliased name.
pub fn resolve_provider_id(name: &str) -> String {
    alias_target(name).map(|s| s.to_string()).unwrap_or_else(|| name.to_string())
}

/// Every accepted provider id, for error messages. Order matches the JS.
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

/// Per-endpoint behaviour flags: how a server that *almost* speaks OpenAI is
/// described in config instead of in a bespoke provider module.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Quirks {
    /// Coerce every request's `tool_choice` to this value.
    pub tool_choice: Option<String>,
    /// `Some(false)` → never start a stream.
    pub stream: Option<bool>,
    /// This endpoint serves the native `/v1/systemone` decision API.
    pub decisions: Option<bool>,
}

impl Quirks {
    fn from_entry(e: &EndpointEntry) -> Option<Quirks> {
        let q = Quirks {
            tool_choice: e.tool_choice.clone(),
            stream: e.stream,
            decisions: e.decisions,
        };
        if q == Quirks::default() {
            None
        } else {
            Some(q)
        }
    }
}

/// A built-in endpoint binding for one of the deprecated/collapsed ids.
#[derive(Debug, Clone, Default)]
pub struct Builtin {
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub quirks: Option<Quirks>,
}

/// Built-in endpoint bindings. These are what let `meta:` keep working with
/// no provider module and no config: its wire format was already identical to
/// `generic`, and its only two real differences are quirks.
pub fn builtin_endpoint(provider: &str) -> Option<Builtin> {
    match provider {
        // Local llama.cpp, NOT the remote mycloud VM — so it must not inherit
        // MYCLOUD_BASE_URL.
        "llama-server" => Some(Builtin {
            base_url: Some(
                config::read_env("LLAMA_SERVER_BASE_URL")
                    .unwrap_or_else(|| "http://127.0.0.1:1234".into()),
            ),
            api_key: Some(config::read_env("LLAMA_SERVER_API_KEY").unwrap_or_default()),
            quirks: None,
        }),
        // The System One decision slot. Honours SYSTEMONE_URL, the same env
        // var the inference launcher uses.
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
        // Meta Muse: accepts only tool_choice "auto", and has no streaming path.
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
            }),
        }),
        _ => None,
    }
}

/// `local-proxy` → `LOCAL_PROXY`, for the `<UPPER>_API_KEY` convention.
fn env_stem(provider: &str) -> String {
    provider.to_uppercase().replace('-', "_")
}

/// Normalize alternate SPELLINGS only. Deliberately does NOT collapse
/// `llama-server`/`openai`/`systemone`: those stay visible as `provider`.
pub fn normalize_gateway_provider(name: &str) -> String {
    match name {
        "github" | "github-copilot" => "copilot".to_string(),
        // Canonical id is `meta`; `muse` is a legacy alias.
        "muse" => "meta".to_string(),
        other => other.to_string(),
    }
}

/// Split `provider:model`, applying the same bare-model heuristic as the JS.
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
        // Everything else goes to the OpenAI-compatible client. (The old
        // grok -> xai and catch-all -> lm-studio guesses went away with those
        // providers; both are reachable as `endpoints` entries.)
        "generic"
    };
    (provider.to_string(), s.to_string())
}

/// `default_model` from the user config, else the fallback.
pub fn resolve_default_model() -> String {
    config::read_user_default_model().unwrap_or_else(|| FALLBACK_DEFAULT_MODEL.to_string())
}

fn pick_window(group: &BTreeMap<String, Yaml>, key: &str) -> Option<u64> {
    let n = group.get(key)?.as_i64()?;
    if n > 0 {
        Some(n as u64)
    } else {
        None
    }
}

/// Max context window for a `provider:model` spec, from `context_windows`.
///
/// Looks up the provider's own group first, then the meta/muse alias group,
/// then an exact id, then a case-insensitive id, then the group `default`.
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
    // meta/muse are the same provider under two names.
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

/// Turn concurrency for a `provider:model` spec, from the `concurrency`
/// config group (same shape as `context_windows`). Default is 1 — serial —
/// because the expensive mistake is over-parallelising a local model.
///
/// Lookup mirrors [`resolve_context_window`]: provider group (plus its
/// meta/muse alias) → exact model id → case-insensitive id → group
/// `default` → 1. Re-read from disk on every call, so editing the config
/// changes the limit without a restart (turns already holding a slot keep
/// it; the next acquisition sees the new limit).
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

/// Something observable during a turn.
#[derive(Debug)]
pub enum TurnEvent<'a> {
    /// The turn had to wait for a free slot of its `provider:model` before
    /// inference could start (the turn queue — see [`crate::queue`]).
    /// `position` is its place in line when the wait began (1 = next).
    Queued { spec: &'a str, position: usize },
    /// A streamed fragment of content or reasoning.
    Delta { text: &'a str, channel: Channel },
    /// The model asked for a tool, before it runs.
    ToolCall {
        id: &'a str,
        name: &'a str,
        args: &'a Value,
    },
    /// What the tool returned.
    ToolResult {
        id: &'a str,
        name: &'a str,
        text: &'a str,
    },
}

/// A tool handler: takes the parsed arguments, returns the text the model
/// sees, or an error string that is reported back to it.
pub type ToolHandler = Box<dyn Fn(&Value) -> Result<String, String> + Send + Sync>;

/// A tool the model may call: schema plus the handler.
pub struct Tool {
    pub spec: ToolSpec,
    pub handler: ToolHandler,
}

/// Options for building an `Agent`, the counterpart of `Agent.factory({...})`.
#[derive(Debug, Clone, Default)]
pub struct Factory {
    pub model: Option<String>,
    /// System One (decision) model, e.g. `systemone:default`. Independent of
    /// `model`: one agent can hold both. Required by `switch()`.
    pub decision_model: Option<String>,
    pub system_prompt: Option<String>,
    /// Handlebars-like substitution against `system_prompt`. `None` leaves
    /// any `{{...}}` in the prompt untouched.
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
    /// Keep one conversation across `run()` calls instead of building a fresh
    /// one-shot transcript each time. angela (a multi-turn chat harness) needs
    /// this; JS default is `false`.
    pub retain_history: Option<bool>,
    /// Execute a turn's tool calls concurrently. angela passes `true`.
    /// JS default is `false`.
    pub parallel_tools: Option<bool>,
}

/// One row of the retained context window.
///
/// The JS stores **one row per tool call** — "1 UI row = 1 item = 1 jsonl
/// event" — and merges them back into a single multi-call assistant turn in
/// [`Agent::messages_for_provider`]. That asymmetry is deliberate and is
/// reproduced here: the UI wants rows, the API wants turns.
#[derive(Debug, Clone)]
pub struct ContextRow {
    pub id: String,
    /// `false` hides the row from the provider while keeping it for the UI.
    pub visible: bool,
    pub message: Message,
}

/// An assistant turn that carries tool calls and no meaningful text — the
/// shape the JS merge rule looks for.
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

/// Monotonic id for context rows, mirroring the JS `_newCtxId()`.
fn new_ctx_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    format!("ctx_{}", N.fetch_add(1, Ordering::Relaxed))
}

/// An agent: a bound model, a tool registry, and the two loops.
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
    /// The retained conversation. Behind a mutex so `run()` keeps its `&self`
    /// receiver and an agent can be shared; the lock is never held across an
    /// await.
    context_window: std::sync::Mutex<Vec<ContextRow>>,
    /// Token counts from the most recent provider response.
    pub last_usage: std::sync::Mutex<Option<crate::provider::TokenUsage>>,

    // System One
    pub decision_provider: Option<String>,
    pub decision_model: Option<String>,
    pub decision_spec: Option<String>,
    decision_client: Option<Generic>,
}

// Hand-written because the tool registry holds boxed closures, which cannot
// derive Debug. The handlers are not useful in a debug dump anyway.
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

/// Resolve the endpoint for a provider: an `endpoints` entry wins, else a
/// built-in binding, else nothing.
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
        // A config entry wins over a built-in quirk set for the same name.
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
    /// Build an agent. The counterpart of `Agent.factory({...})`.
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

        // The proxy path routes EVERY provider:model through the generic
        // client with the full model id, so AGL need not know the provider.
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
            let bs = format!("{provider}:{model}");
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
            client,
            endpoint_quirks: quirks,
            system_prompt,
            tool_choice: opts.tool_choice,
            max_tokens: opts.max_tokens,
            temperature: opts.temperature,
            reasoning_effort: opts.reasoning_effort,
            max_turns: opts.max_turns.unwrap_or(5).max(1),
            max_tools: opts.max_tools.unwrap_or(DEFAULT_MAX_TOOLS),
            tools: BTreeMap::new(),
            // JS defaults: both false. angela opts into each explicitly.
            retain_history: opts.retain_history.unwrap_or(false),
            parallel_tools: opts.parallel_tools.unwrap_or(false),
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

    /// Bind the System One (decision) model.
    ///
    /// Kept entirely separate from the generative binding: an agent may hold
    /// both, and `switch()` must never fall back to the generative model.
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

    /// Register a tool. Replacing an existing name is allowed; exceeding
    /// `max_tools` is not.
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

    /// The `tools` array as the API wants it.
    pub fn render_tools(&self) -> Value {
        let specs: BTreeMap<String, ToolSpec> = self
            .tools
            .iter()
            .map(|(k, v)| (k.clone(), v.spec.clone()))
            .collect();
        render_tools(&specs)
    }

    /// Build the request for one turn, applying endpoint quirks.
    fn build_request(&self, messages: Vec<Message>) -> InferenceRequest {
        let has_tools = !self.tools.is_empty();
        let mut tool_choice = self.tool_choice.clone();
        // Endpoint quirks. Meta Muse, for one, rejects every tool_choice
        // except "auto" and has no streaming path.
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

    /// Whether this agent would start a stream, given its quirks.
    pub fn may_stream(&self, requested: bool) -> bool {
        match self.endpoint_quirks.as_ref().and_then(|q| q.stream) {
            Some(false) => false,
            _ => requested,
        }
    }

    /// Execute synchronous tool handlers in order, yielding between calls so
    /// a surrounding cancellation race can stop before the next one starts.
    async fn run_tools(&self, calls: &[ToolCall]) -> Vec<String> {
        let mut out = Vec::with_capacity(calls.len());
        for call in calls {
            // Handlers are synchronous. Yield after each one so the outer
            // cancellation race can observe a stop before another call starts.
            out.push(self.invoke_tool(call));
            tokio::task::yield_now().await;
        }
        out
    }

    /// One tool call → its result text. Unknown tools and bad argument JSON
    /// become tool *results*, never errors, so the model can recover.
    fn invoke_tool(&self, call: &ToolCall) -> String {
        let raw = &call.function.arguments;
        let args: Value = if raw.trim().is_empty() {
            json!({})
        } else {
            match serde_json::from_str(raw) {
                Ok(v) => v,
                Err(e) => {
                    // Truncated tool JSON (finish_reason "length") surfaces as
                    // a tool error the model can see and retry.
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

    // ---- retained context window -------------------------------------

    /// Append a row to the retained conversation. Port of `pushContext`.
    pub fn push_context(&self, message: Message) -> String {
        let id = new_ctx_id();
        self.context_window.lock().unwrap().push(ContextRow {
            id: id.clone(),
            visible: true,
            message,
        });
        id
    }

    /// A copy of the retained rows, for a host that renders or persists them.
    pub fn context_snapshot(&self) -> Vec<ContextRow> {
        self.context_window.lock().unwrap().clone()
    }

    /// Drop the retained conversation (a "new session" on the same agent).
    pub fn clear_context(&self) {
        self.context_window.lock().unwrap().clear();
    }

    pub fn context_len(&self) -> usize {
        self.context_window.lock().unwrap().len()
    }

    /// The provider-facing message list. Port of `messagesForProvider`.
    ///
    /// Drops invisible rows, any stored `system` row (only `system_prompt`
    /// supplies one) and `reasoning` rows, then merges **consecutive**
    /// assistant rows that carry tool calls and no text back into one turn.
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
                        // Merge: the UI kept one row per call, the API wants
                        // one assistant turn carrying all of them.
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

    /// Run a prompt, executing tool calls until the model stops asking.
    ///
    /// The generative loop. Bounded by `max_turns` so a model that keeps
    /// calling tools cannot spin forever.
    pub async fn run(&self, prompt: &str) -> Result<String, AgentError> {
        let mut ev = Self::noop_events;
        self.run_inner(prompt, false, &mut ev).await
    }

    /// Everything a caller may observe while a turn runs.
    ///
    /// Streaming text was the first need; tool activity is the second, and a
    /// host that renders a transcript needs both. One enum rather than a
    /// growing list of callbacks.
    pub fn noop_events(_e: TurnEvent<'_>) {}

    /// Run a prompt with token-by-token streaming.
    ///
    /// `on_delta` fires for every content and reasoning fragment as it
    /// arrives, across *every* turn of the tool loop. The return value is the
    /// same final answer `run()` gives, so a caller can stream for display
    /// and still use the result.
    ///
    /// Honours the endpoint's `stream: false` quirk via [`Agent::may_stream`]:
    /// against a server that cannot stream (Muse, for one) this transparently
    /// falls back to the blocking path and simply never calls `on_delta`.
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
        self.run_inner(prompt, true, &mut ev).await
    }

    /// Run a prompt, observing **everything**: streamed deltas and each tool
    /// call and result as they happen.
    ///
    /// This is what a chat UI needs — a tool call has to appear in the
    /// transcript when it runs, not after the whole turn settles.
    pub async fn run_events(
        &self,
        prompt: &str,
        stream: bool,
        on_event: &mut dyn FnMut(TurnEvent<'_>),
    ) -> Result<String, AgentError> {
        self.run_inner(prompt, stream, on_event).await
    }

    /// The one generative loop. `run` and `run_stream` are thin wrappers so
    /// the tool-calling semantics cannot drift between them.
    async fn run_inner(
        &self,
        prompt: &str,
        want_stream: bool,
        on_event: &mut dyn FnMut(TurnEvent<'_>),
    ) -> Result<String, AgentError> {
        let streaming = want_stream && self.may_stream(true);
        let retain = self.retain_history;

        // The turn queue: one slot per `provider:model` (c=N from the user
        // config), held until the turn ends. When the slot is not free the
        // wait is announced first, so the transcript shows why nothing is
        // streaming yet. The permit releases on every exit path — answer,
        // error, or cancellation — because it is dropped, not returned.
        let st = crate::queue::stats(&self.bound_spec);
        if st.held >= st.limit || st.waiting > 0 {
            on_event(TurnEvent::Queued {
                spec: &self.bound_spec,
                position: st.waiting + 1,
            });
        }
        let _permit = crate::queue::acquire(&self.bound_spec).await;

        // Retained: the prompt joins the persistent window. One-shot: an
        // ephemeral transcript, so a stateless call cannot pollute context.
        let mut oneshot: Vec<Message> = Vec::new();
        if retain {
            self.push_context(Message::user(prompt));
        } else {
            if let Some(sp) = &self.system_prompt {
                oneshot.push(Message::system(sp.clone()));
            }
            oneshot.push(Message::user(prompt));
        }

        for _turn in 0..self.max_turns {
            let messages = if retain {
                self.messages_for_provider()
            } else {
                oneshot.clone()
            };
            let req = self.build_request(messages);
            let result = if streaming {
                let mut delta = |text: &str, channel: Channel| {
                    on_event(TurnEvent::Delta { text, channel });
                };
                self.client.inference_stream(&req, &mut delta).await?
            } else {
                self.client.inference(&req).await?
            };
            // Authoritative context size from the provider's own usage row.
            if let Some(u) = &result.usage {
                *self.last_usage.lock().unwrap() = Some(u.clone());
            }

            // Some gateways set finish_reason to "stop"/"length" while still
            // returning tool_calls, so any non-empty tool_calls is a tool turn.
            let calls: Vec<ToolCall> = result
                .choices
                .iter()
                .filter_map(|c| c.message.tool_calls.clone())
                .flatten()
                .collect();

            if calls.is_empty() {
                // Retain the final assistant turn so the next run() sees it.
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

            // One row per tool call — the JS keeps "1 UI row = 1 item = 1
            // jsonl event", and messages_for_provider merges them back for
            // the API. The one-shot path gets the same per-call rows and no
            // merge, exactly as the JS does.
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

    /// Run a finite-choice decision loop over the System One model.
    ///
    /// Deliberately a sibling of `run()`: it does not touch the generative
    /// loop or `max_turns`.
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

    /// Replay a recorded trace. Needs no endpoint at all.
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

    /// Replay `steps` steps of a trace, then continue with the model.
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

/// Re-exported so callers can `match` on how a run finished.
pub use crate::switch::Ended as SwitchEnded;
/// Re-exported for domain implementors.
pub use crate::switch::{pick, Opt, Question};

#[allow(unused_imports)]
use Answer as _AnswerUsed;
#[allow(unused_imports)]
use Ended as _EndedUsed;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serializes tests that mutate process-wide env/config.
    static ENV: Mutex<()> = Mutex::new(());

    struct Cfg {
        _dir: std::path::PathBuf,
    }

    /// Point AGL_CONFIG_PATH at a temp config for the duration of a test.
    fn with_config(text: &str) -> Cfg {
        let dir = std::env::temp_dir().join(format!("agl-rs-cfg-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(format!(
            "config-{}.yaml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, text).unwrap();
        std::env::set_var("AGL_CONFIG_PATH", &path);
        Cfg { _dir: dir }
    }

    impl Drop for Cfg {
        fn drop(&mut self) {
            std::env::remove_var("AGL_CONFIG_PATH");
        }
    }

    #[test]
    fn the_removed_providers_are_gone_and_the_aliases_remain() {
        assert_eq!(resolve_provider_id("llama-server"), "generic");
        assert_eq!(resolve_provider_id("openai"), "generic");
        assert_eq!(resolve_provider_id("systemone"), "generic");
        assert_eq!(resolve_provider_id("meta"), "generic");
        assert_eq!(resolve_provider_id("muse"), "generic");
        // Removed entirely: no alias, so they resolve to themselves and then
        // fail the CANONICAL check.
        for gone in ["xai", "ollama", "lm-studio", "runpod", "anthropic"] {
            assert!(alias_target(gone).is_none(), "{gone} should not be an alias");
            assert!(!CANONICAL.contains(&gone));
        }
    }

    #[test]
    fn a_bare_model_id_routes_to_copilot_or_generic() {
        assert_eq!(split_provider_model("gpt-4o").0, "copilot");
        assert_eq!(split_provider_model("claude-sonnet").0, "copilot");
        // Previously grok* guessed xai and the catch-all guessed lm-studio.
        assert_eq!(split_provider_model("grok-4.6").0, "generic");
        assert_eq!(split_provider_model("qwen-3.8-27b").0, "generic");
        // An explicit prefix always wins.
        assert_eq!(
            split_provider_model("llama-server:default"),
            ("llama-server".to_string(), "default".to_string())
        );
    }

    #[test]
    fn meta_carries_its_two_quirks_and_muse_normalizes_to_it() {
        let b = builtin_endpoint("meta").unwrap();
        let q = b.quirks.unwrap();
        assert_eq!(q.tool_choice.as_deref(), Some("auto"));
        assert_eq!(q.stream, Some(false));
        assert_eq!(normalize_gateway_provider("muse"), "meta");
    }

    #[test]
    fn systemone_defaults_to_the_documented_port_and_is_a_decision_endpoint() {
        let _g = ENV.lock().unwrap();
        std::env::remove_var("SYSTEMONE_URL");
        let b = builtin_endpoint("systemone").unwrap();
        assert_eq!(b.base_url.as_deref(), Some("http://127.0.0.1:1237"));
        assert_eq!(b.quirks.unwrap().decisions, Some(true));
    }

    #[test]
    fn llama_server_binds_localhost_and_never_inherits_mycloud() {
        let _g = ENV.lock().unwrap();
        std::env::remove_var("LLAMA_SERVER_BASE_URL");
        std::env::set_var("MYCLOUD_BASE_URL", "https://192.0.2.1:1234");
        let b = builtin_endpoint("llama-server").unwrap();
        assert_eq!(b.base_url.as_deref(), Some("http://127.0.0.1:1234"));
        std::env::remove_var("MYCLOUD_BASE_URL");
    }

    #[test]
    fn context_windows_resolve_by_group_then_default_then_fallback() {
        let _g = ENV.lock().unwrap();
        let _cfg = with_config(
            "default_model: llama-server:gemma-4-12b-qat\n\
             context_windows:\n\
            \x20 llama-server:\n\
            \x20   default: 524288\n\
            \x20   gemma-4-12b-qat: 1048576\n\
            \x20 xai:\n\
            \x20   default: 131072\n\
            \x20   grok-4.6: 500000\n",
        );
        assert_eq!(resolve_context_window("llama-server:gemma-4-12b-qat"), 1_048_576);
        // Unknown id under a known provider -> that group's default.
        assert_eq!(resolve_context_window("llama-server:nope"), 524_288);
        // A provider that is no longer built in still resolves its group.
        assert_eq!(resolve_context_window("xai:grok-4.6"), 500_000);
        // Unknown provider entirely -> the global fallback.
        assert_eq!(resolve_context_window("acme:thing"), FALLBACK_CONTEXT_WINDOW);
    }

    #[test]
    fn concurrency_resolves_like_context_windows_and_defaults_to_one() {
        let _g = ENV.lock().unwrap();
        // No config at all -> 1 (serial).
        {
            let _cfg = with_config("default_model: llama-server:default\n");
            assert_eq!(resolve_concurrency("llama-server:default"), 1);
        }
        let _cfg = with_config(
            "concurrency:\n\
            \x20 llama-server:\n\
            \x20   default: 1\n\
            \x20   big: 2\n\
            \x20 openai:\n\
            \x20   default: 4\n",
        );
        // Exact model id wins over the group default.
        assert_eq!(resolve_concurrency("llama-server:big"), 2);
        // Unknown id under a known provider -> the group's default.
        assert_eq!(resolve_concurrency("llama-server:small"), 1);
        // Group default is enough for a whole hosted provider.
        assert_eq!(resolve_concurrency("openai:gpt-5"), 4);
        // Unknown provider entirely -> 1.
        assert_eq!(resolve_concurrency("acme:thing"), 1);
        // Zero / negative in the config never disables the queue.
        let _cfg = with_config("concurrency:\n  llama-server:\n    default: 0\n");
        assert_eq!(resolve_concurrency("llama-server:default"), 1);
    }

    #[test]
    fn default_model_comes_from_the_config_and_is_re_read() {
        let _g = ENV.lock().unwrap();
        {
            let _cfg = with_config("default_model: llama-server:first\n");
            assert_eq!(resolve_default_model(), "llama-server:first");
        }
        {
            let _cfg = with_config("default_model: llama-server:second\n");
            assert_eq!(resolve_default_model(), "llama-server:second");
        }
    }

    #[test]
    fn an_unknown_provider_names_the_accepted_ids() {
        let _g = ENV.lock().unwrap();
        let _cfg = with_config("default_model: llama-server:default\n");
        let err = Agent::factory(Factory {
            model: Some("acme:whatever".into()),
            ..Default::default()
        })
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Unknown AI provider: acme"), "{msg}");
        assert!(msg.contains("generic, llama-server, openai, systemone, meta, muse"), "{msg}");
    }

    #[test]
    fn the_alias_keeps_its_surface_name_so_config_groups_still_resolve() {
        let _g = ENV.lock().unwrap();
        std::env::remove_var("LLAMA_SERVER_BASE_URL");
        let _cfg = with_config(
            "default_model: llama-server:default\n\
             context_windows:\n\
            \x20 llama-server:\n\
            \x20   default: 524288\n",
        );
        let a = Agent::factory(Factory {
            model: Some("llama-server:default".into()),
            ..Default::default()
        })
        .unwrap();
        // The id stays visible even though the module behind it is generic.
        assert_eq!(a.provider, "llama-server");
        assert_eq!(a.model, "default");
        assert_eq!(a.client.base_url(), "http://127.0.0.1:1234");
        assert_eq!(a.context_window_size, 524_288);
    }

    #[test]
    fn the_proxy_path_routes_a_provider_agl_does_not_know() {
        let _g = ENV.lock().unwrap();
        let _cfg = with_config("default_model: llama-server:default\n");
        let a = Agent::factory(Factory {
            model: Some("acme:secret-model".into()),
            proxy: Some("host.containers.internal:1234".into()),
            api_key: Some("k".into()),
            ..Default::default()
        })
        .unwrap();
        // The full provider:model rides the body, so AGL need not know acme.
        assert_eq!(a.model, "acme:secret-model");
        assert_eq!(a.client.base_url(), "https://host.containers.internal:1234");
    }

    #[test]
    fn meta_coerces_tool_choice_and_suppresses_streaming() {
        let _g = ENV.lock().unwrap();
        std::env::set_var("META_API_KEY", "test-key");
        let _cfg = with_config("default_model: llama-server:default\n");
        let mut a = Agent::factory(Factory {
            model: Some("meta:muse-spark-1.2-contributor".into()),
            tool_choice: Some(json!("required")),
            ..Default::default()
        })
        .unwrap();
        a.tool("noop", "does nothing", json!({}), vec![], |_| Ok("x".into()))
            .unwrap();
        let req = a.build_request(vec![Message::user("hi")]);
        assert_eq!(req.tool_choice, Some(json!("auto")));
        assert!(!a.may_stream(true));
        std::env::remove_var("META_API_KEY");
    }

    #[test]
    fn an_endpoint_without_quirks_passes_tool_choice_and_stream_through() {
        let _g = ENV.lock().unwrap();
        std::env::remove_var("LLAMA_SERVER_BASE_URL");
        let _cfg = with_config("default_model: llama-server:default\n");
        let mut a = Agent::factory(Factory {
            model: Some("llama-server:default".into()),
            tool_choice: Some(json!("required")),
            ..Default::default()
        })
        .unwrap();
        a.tool("noop", "does nothing", json!({}), vec![], |_| Ok("x".into()))
            .unwrap();
        assert!(a.endpoint_quirks.is_none());
        let req = a.build_request(vec![Message::user("hi")]);
        assert_eq!(req.tool_choice, Some(json!("required")));
        assert!(a.may_stream(true));
    }

    #[test]
    fn the_tool_registry_caps_at_max_tools_but_allows_replacement() {
        let _g = ENV.lock().unwrap();
        std::env::remove_var("LLAMA_SERVER_BASE_URL");
        let _cfg = with_config("default_model: llama-server:default\n");
        let mut a = Agent::factory(Factory {
            model: Some("llama-server:default".into()),
            max_tools: Some(2),
            ..Default::default()
        })
        .unwrap();
        a.tool("a", "", json!({}), vec![], |_| Ok(String::new())).unwrap();
        a.tool("b", "", json!({}), vec![], |_| Ok(String::new())).unwrap();
        assert!(a
            .tool("c", "", json!({}), vec![], |_| Ok(String::new()))
            .is_err());
        // Replacing an existing name is fine.
        assert!(a
            .tool("a", "", json!({}), vec![], |_| Ok(String::new()))
            .is_ok());
        assert_eq!(a.render_tools().as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_bad_decision_model_spec_is_refused() {
        let _g = ENV.lock().unwrap();
        std::env::remove_var("LLAMA_SERVER_BASE_URL");
        let _cfg = with_config("default_model: llama-server:default\n");
        let err = Agent::factory(Factory {
            model: Some("llama-server:default".into()),
            decision_model: Some("systemone".into()),
            ..Default::default()
        })
        .unwrap_err();
        assert!(err.to_string().contains("Invalid decision_model format"));

        let err = Agent::factory(Factory {
            model: Some("llama-server:default".into()),
            decision_model: Some("nope:x".into()),
            ..Default::default()
        })
        .unwrap_err();
        assert!(err.to_string().contains("Unknown decision provider: nope"));
    }

    #[test]
    fn switch_without_a_decision_model_refuses() {
        let _g = ENV.lock().unwrap();
        std::env::remove_var("LLAMA_SERVER_BASE_URL");
        let _cfg = with_config("default_model: llama-server:default\n");
        let a = Agent::factory(Factory {
            model: Some("llama-server:default".into()),
            ..Default::default()
        })
        .unwrap();

        struct NoQs;
        impl Domain for NoQs {
            fn name(&self) -> &str {
                "t"
            }
            fn initial(&self, _i: &Value) -> Value {
                json!({})
            }
            fn questions(&self, _s: &Value) -> Result<BTreeMap<String, Question>, SwitchError> {
                Ok(BTreeMap::new())
            }
            fn transition(
                &self,
                s: &Value,
                _a: &BTreeMap<String, Answer>,
            ) -> Result<Value, SwitchError> {
                Ok(s.clone())
            }
        }
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = a.switch(&NoQs, &json!({}), rt.handle().clone()).unwrap_err();
        assert!(err.to_string().contains("needs a decision model"));
    }

    #[test]
    fn a_decision_model_binds_the_generic_client_at_the_systemone_port() {
        let _g = ENV.lock().unwrap();
        std::env::remove_var("SYSTEMONE_URL");
        std::env::remove_var("LLAMA_SERVER_BASE_URL");
        let _cfg = with_config("default_model: llama-server:default\n");
        let a = Agent::factory(Factory {
            model: Some("llama-server:default".into()),
            decision_model: Some("systemone:default".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(a.decision_spec.as_deref(), Some("systemone:default"));
        assert_eq!(a.decision_base_url(), Some("http://127.0.0.1:1237"));
        // The generative and decision endpoints are independent.
        assert_eq!(a.client.base_url(), "http://127.0.0.1:1234");
    }
}

#[cfg(test)]
mod context_tests {
    use super::*;
    use crate::provider::{FunctionCall, ToolCall};

    fn agent(retain: bool) -> Agent {
        let mut f = Factory {
            model: Some("llama-server:test".into()),
            system_prompt: Some("SYS".into()),
            retain_history: Some(retain),
            base_url: Some("http://127.0.0.1:1".into()),
            ..Default::default()
        };
        f.retain_history = Some(retain);
        Agent::factory(f).expect("agent")
    }

    fn call(id: &str, name: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            kind: "function".into(),
            function: FunctionCall {
                name: name.into(),
                arguments: "{}".into(),
            },
        }
    }

    fn tool_row(c: ToolCall) -> Message {
        Message {
            role: "assistant".into(),
            content: Some(Value::String(String::new())),
            tool_calls: Some(vec![c]),
            tool_call_id: None,
            reasoning_content: None,
        }
    }

    #[test]
    fn the_system_prompt_leads_and_is_not_stored() {
        let a = agent(true);
        a.push_context(Message::user("hi"));
        let m = a.messages_for_provider();
        assert_eq!(m[0].role, "system");
        assert_eq!(m[0].content.as_ref().unwrap().as_str(), Some("SYS"));
        assert_eq!(m[1].role, "user");
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn a_stored_system_row_is_dropped_so_only_system_prompt_leads() {
        let a = agent(true);
        a.push_context(Message::system("SNEAKY"));
        a.push_context(Message::user("hi"));
        let m = a.messages_for_provider();
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].content.as_ref().unwrap().as_str(), Some("SYS"));
    }

    #[test]
    fn reasoning_rows_are_ui_only() {
        let a = agent(true);
        a.push_context(Message::text("reasoning", "thinking out loud"));
        a.push_context(Message::user("hi"));
        let m = a.messages_for_provider();
        assert_eq!(m.len(), 2);
        assert!(m.iter().all(|x| x.role != "reasoning"));
    }

    #[test]
    fn invisible_rows_are_hidden_from_the_provider() {
        let a = agent(true);
        a.push_context(Message::user("shown"));
        let id = a.push_context(Message::user("hidden"));
        {
            let mut rows = a.context_window.lock().unwrap();
            rows.iter_mut().find(|r| r.id == id).unwrap().visible = false;
        }
        let m = a.messages_for_provider();
        assert_eq!(m.len(), 2);
        assert_eq!(m[1].content.as_ref().unwrap().as_str(), Some("shown"));
        // still present for the UI
        assert_eq!(a.context_snapshot().len(), 2);
    }

    #[test]
    fn consecutive_tool_call_rows_merge_into_one_turn() {
        // The window keeps one row per call; the API gets one assistant turn.
        let a = agent(true);
        a.push_context(Message::user("go"));
        a.push_context(tool_row(call("c1", "alpha")));
        a.push_context(tool_row(call("c2", "beta")));
        let m = a.messages_for_provider();
        assert_eq!(a.context_len(), 3, "window keeps a row per call");
        assert_eq!(m.len(), 3, "system + user + ONE merged assistant turn");
        let merged = m[2].tool_calls.as_ref().unwrap();
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].function.name, "alpha");
        assert_eq!(merged[1].function.name, "beta");
    }

    #[test]
    fn a_tool_result_between_calls_breaks_the_merge() {
        let a = agent(true);
        a.push_context(tool_row(call("c1", "alpha")));
        a.push_context(Message::tool_result("c1", "done"));
        a.push_context(tool_row(call("c2", "beta")));
        let m = a.messages_for_provider();
        // system, assistant(1), tool, assistant(1) — not merged across.
        assert_eq!(m.len(), 4);
        assert_eq!(m[1].tool_calls.as_ref().unwrap().len(), 1);
        assert_eq!(m[3].tool_calls.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn an_assistant_with_text_and_calls_does_not_merge() {
        // The merge rule requires empty content; text means a real turn.
        let a = agent(true);
        let mut spoke = tool_row(call("c1", "alpha"));
        spoke.content = Some(Value::String("I will call a tool".into()));
        a.push_context(spoke);
        a.push_context(tool_row(call("c2", "beta")));
        let m = a.messages_for_provider();
        assert_eq!(m.len(), 3);
        assert_eq!(m[1].tool_calls.as_ref().unwrap().len(), 1);
        assert_eq!(m[2].tool_calls.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn clearing_drops_the_conversation() {
        let a = agent(true);
        a.push_context(Message::user("one"));
        assert_eq!(a.context_len(), 1);
        a.clear_context();
        assert_eq!(a.context_len(), 0);
        assert_eq!(a.messages_for_provider().len(), 1); // system only
    }

    #[test]
    fn one_shot_agents_retain_nothing() {
        let a = agent(false);
        assert!(!a.retain_history);
        assert_eq!(a.context_len(), 0);
    }

    #[test]
    fn rows_get_distinct_ids() {
        let a = agent(true);
        let a1 = a.push_context(Message::user("x"));
        let a2 = a.push_context(Message::user("y"));
        assert_ne!(a1, a2);
    }

    #[test]
    fn cancellation_wins_before_the_next_tool_starts() {
        let mut a = agent(false);
        let signal = std::sync::Arc::new(tokio::sync::Notify::new());
        let trigger = signal.clone();
        a.tool("first", "", json!({}), vec![], move |_| { trigger.notify_one(); Ok("done".into()) }).unwrap();
        let ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = ran.clone();
        a.tool("second", "", json!({}), vec![], move |_| { flag.store(true, std::sync::atomic::Ordering::SeqCst); Ok("done".into()) }).unwrap();
        let calls = vec![call("1", "first"), call("2", "second")];
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let stopped = rt.block_on(async {
            tokio::select! { biased; _ = signal.notified() => true, _ = a.run_tools(&calls) => false }
        });
        assert!(stopped);
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn bad_tool_json_becomes_a_tool_result_not_an_error() {
        let a = agent(false);
        let mut c = call("c1", "nope");
        c.function.arguments = "{\"truncated\":".into();
        let out = a.invoke_tool(&c);
        assert!(out.contains("invalid tool arguments"), "{out}");
        assert!(out.contains("truncated"), "{out}");
    }

    #[test]
    fn an_unknown_tool_reports_the_known_ones() {
        let a = agent(false);
        let out = a.invoke_tool(&call("c1", "ghost"));
        assert!(out.contains("unknown tool"), "{out}");
    }

    #[test]
    fn empty_arguments_parse_as_an_empty_object() {
        let a = agent(false);
        let mut c = call("c1", "ghost");
        c.function.arguments = String::new();
        // Reaches the unknown-tool branch rather than the bad-JSON branch.
        assert!(a.invoke_tool(&c).contains("unknown tool"));
    }
}
