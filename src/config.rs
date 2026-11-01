//! Config — port of `src/lib/config.mjs`.
//!
//! The YAML parser is deliberately the same narrow subset as the JS original:
//! comments, nested maps, quoted/plain scalars, integers. That is everything
//! `~/.config/agl/config.yaml` uses (`default_model`, `context_windows`,
//! `endpoints`), and keeping it narrow keeps the dependency list empty for
//! this module.
//!
//! Like the JS version, the user config is re-read from disk on every lookup
//! (no cache), so editing it takes effect without restarting the process.

use std::collections::BTreeMap;
use std::env;
use std::path::PathBuf;

/// A parsed YAML value from the supported subset.
#[derive(Debug, Clone, PartialEq)]
pub enum Yaml {
    Str(String),
    Int(i64),
    Bool(bool),
    Null,
    Map(BTreeMap<String, Yaml>),
}

impl Yaml {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Yaml::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Yaml::Int(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Yaml::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_map(&self) -> Option<&BTreeMap<String, Yaml>> {
        match self {
            Yaml::Map(m) => Some(m),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Yaml> {
        self.as_map().and_then(|m| m.get(key))
    }

    /// Scalar rendered as the JS `String(v)` would render it — used where the
    /// original coerced a scalar to text (e.g. an endpoint URL).
    pub fn to_scalar_string(&self) -> Option<String> {
        match self {
            Yaml::Str(s) => Some(s.clone()),
            Yaml::Int(n) => Some(n.to_string()),
            Yaml::Bool(b) => Some(b.to_string()),
            Yaml::Null | Yaml::Map(_) => None,
        }
    }
}

/// Strip a `#` comment, honouring quotes, exactly as the JS original does:
/// a `#` only starts a comment at the line start or after a space/tab.
fn strip_inline_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut in_quote: Option<u8> = None;
    for (i, &c) in bytes.iter().enumerate() {
        if let Some(q) = in_quote {
            if c == q && (i == 0 || bytes[i - 1] != b'\\') {
                in_quote = None;
            }
            continue;
        }
        if c == b'"' || c == b'\'' {
            in_quote = Some(c);
            continue;
        }
        if c == b'#' && (i == 0 || bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
            return &line[..i];
        }
    }
    line
}

fn unquote(s: &str) -> &str {
    let b = s.as_bytes();
    if b.len() >= 2
        && ((b[0] == b'"' && b[b.len() - 1] == b'"') || (b[0] == b'\'' && b[b.len() - 1] == b'\''))
    {
        return &s[1..s.len() - 1];
    }
    s
}

fn coerce_scalar(raw: &str) -> Yaml {
    let s = unquote(raw);
    match s {
        "true" => return Yaml::Bool(true),
        "false" => return Yaml::Bool(false),
        "null" | "~" => return Yaml::Null,
        _ => {}
    }
    // /^-?\d+$/
    let digits = s.strip_prefix('-').unwrap_or(s);
    if !digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit()) {
        if let Ok(n) = s.parse::<i64>() {
            return Yaml::Int(n);
        }
    }
    Yaml::Str(s.to_string())
}

/// Parse the supported YAML subset into a map.
///
/// Mirrors the JS algorithm: an indent-keyed stack of open maps, a key with an
/// empty value opens a child map, a key with a value stores a scalar. Lines
/// without a colon are skipped (so list items are ignored, as in the original).
pub fn parse_yaml(text: &str) -> Yaml {
    // Build with a path stack of (indent, keys-to-node) and insert at the end,
    // since Rust will not let us hold aliases into a growing tree.
    let mut root: BTreeMap<String, Yaml> = BTreeMap::new();
    // Each entry: (indent, path from root to the open map)
    let mut stack: Vec<(i64, Vec<String>)> = vec![(-1, Vec::new())];

    for raw_line in text.split('\n') {
        let stripped = strip_inline_comment(raw_line);
        if stripped.trim().is_empty() {
            continue;
        }
        let indent = (stripped.len() - stripped.trim_start().len()) as i64;
        let trimmed = stripped.trim();
        let Some(colon) = trimmed.find(':') else {
            continue;
        };
        let key = unquote(trimmed[..colon].trim()).to_string();
        if key.is_empty() {
            continue;
        }
        let rest = trimmed[colon + 1..].trim();

        while stack.len() > 1 && indent <= stack[stack.len() - 1].0 {
            stack.pop();
        }
        let parent_path = stack[stack.len() - 1].1.clone();

        if rest.is_empty() {
            insert_at(&mut root, &parent_path, &key, Yaml::Map(BTreeMap::new()));
            let mut child_path = parent_path;
            child_path.push(key);
            stack.push((indent, child_path));
        } else {
            insert_at(&mut root, &parent_path, &key, coerce_scalar(rest));
        }
    }
    Yaml::Map(root)
}

/// Insert `value` at `path`/`key`, creating missing maps along the way.
fn insert_at(root: &mut BTreeMap<String, Yaml>, path: &[String], key: &str, value: Yaml) {
    let mut cursor = root;
    for seg in path {
        let entry = cursor
            .entry(seg.clone())
            .or_insert_with(|| Yaml::Map(BTreeMap::new()));
        if !matches!(entry, Yaml::Map(_)) {
            *entry = Yaml::Map(BTreeMap::new());
        }
        cursor = match entry {
            Yaml::Map(m) => m,
            _ => unreachable!("just normalized to a map"),
        };
    }
    cursor.insert(key.to_string(), value);
}

/// Path to the user config. `AGL_CONFIG_PATH` overrides it.
pub fn user_config_path() -> PathBuf {
    if let Ok(p) = env::var("AGL_CONFIG_PATH") {
        if !p.trim().is_empty() {
            return PathBuf::from(p.trim());
        }
    }
    let home = env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".config").join("agl").join("config.yaml")
}

/// Read and parse the user config. A missing or unreadable file is an empty
/// map, never an error — AGL has safe defaults for all non-secret config.
pub fn read_user_config() -> Yaml {
    match std::fs::read_to_string(user_config_path()) {
        Ok(text) => parse_yaml(&text),
        Err(_) => Yaml::Map(BTreeMap::new()),
    }
}

/// `default_model`, or `None` when unset/unreadable.
pub fn read_user_default_model() -> Option<String> {
    let cfg = read_user_config();
    let v = cfg.get("default_model")?.to_scalar_string()?;
    let s = v.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// An `endpoints` entry: a bare URL string, or a map with `url` plus optional
/// `api_key` / `ca_file` and the behaviour flags described in `agent::Quirks`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EndpointEntry {
    pub url: String,
    pub api_key: Option<String>,
    pub ca_file: Option<String>,
    pub tool_choice: Option<String>,
    pub stream: Option<bool>,
    pub decisions: Option<bool>,
}

/// The `endpoints` map: provider name → endpoint. Any key here is a dynamic
/// provider that routes through the generic OpenAI-compatible client.
pub fn read_user_endpoints() -> BTreeMap<String, EndpointEntry> {
    let cfg = read_user_config();
    let mut out = BTreeMap::new();
    let Some(eps) = cfg.get("endpoints").and_then(|e| e.as_map()) else {
        return out;
    };
    for (name, v) in eps {
        match v {
            Yaml::Str(url) => {
                out.insert(
                    name.clone(),
                    EndpointEntry {
                        url: url.clone(),
                        ..Default::default()
                    },
                );
            }
            Yaml::Map(m) => {
                let url = m
                    .get("url")
                    .and_then(|u| u.to_scalar_string())
                    .unwrap_or_default();
                out.insert(
                    name.clone(),
                    EndpointEntry {
                        url,
                        api_key: m.get("api_key").and_then(|v| v.to_scalar_string()),
                        ca_file: m.get("ca_file").and_then(|v| v.to_scalar_string()),
                        tool_choice: m.get("tool_choice").and_then(|v| v.to_scalar_string()),
                        stream: m.get("stream").and_then(|v| v.as_bool()),
                        decisions: m.get("decisions").and_then(|v| v.as_bool()),
                    },
                );
            }
            _ => {}
        }
    }
    out
}

/// Read an environment variable, empty treated as unset (JS `||` semantics).
pub fn read_env(name: &str) -> Option<String> {
    match env::var(name) {
        Ok(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_maps_and_scalar_kinds() {
        let y = parse_yaml(
            "default_model: llama-server:default\n\
             context_windows:\n\
            \x20 llama-server:\n\
            \x20   default: 524288\n\
            \x20   gemma-4: 1048576\n\
             flag: true\n\
             nothing: ~\n",
        );
        assert_eq!(
            y.get("default_model").unwrap().as_str(),
            Some("llama-server:default")
        );
        let group = y.get("context_windows").unwrap().get("llama-server").unwrap();
        assert_eq!(group.get("default").unwrap().as_i64(), Some(524_288));
        assert_eq!(group.get("gemma-4").unwrap().as_i64(), Some(1_048_576));
        assert_eq!(y.get("flag").unwrap().as_bool(), Some(true));
        assert_eq!(y.get("nothing").unwrap(), &Yaml::Null);
    }

    #[test]
    fn strips_comments_only_outside_quotes_and_after_space() {
        assert_eq!(strip_inline_comment("a: 1 # trailing"), "a: 1 ");
        assert_eq!(strip_inline_comment("# whole line"), "");
        // A '#' with no preceding space is part of the value, as in JS.
        assert_eq!(strip_inline_comment("url: http://h/p#frag"), "url: http://h/p#frag");
        // Quoted '#' is data.
        assert_eq!(strip_inline_comment("a: \"x # y\""), "a: \"x # y\"");
    }

    #[test]
    fn dedents_back_to_an_outer_map() {
        let y = parse_yaml(
            "a:\n  b:\n    c: 1\nd: 2\n",
        );
        assert_eq!(y.get("a").unwrap().get("b").unwrap().get("c").unwrap().as_i64(), Some(1));
        assert_eq!(y.get("d").unwrap().as_i64(), Some(2));
    }

    #[test]
    fn negative_and_quoted_scalars() {
        let y = parse_yaml("n: -5\nq: \"true\"\ns: 'hi there'\n");
        assert_eq!(y.get("n").unwrap().as_i64(), Some(-5));
        // Quirk kept deliberately: the JS original unquotes BEFORE coercing,
        // so a quoted "true" still becomes a boolean. Verified against
        // src/lib/config.mjs rather than assumed.
        assert_eq!(y.get("q").unwrap().as_bool(), Some(true));
        assert_eq!(y.get("s").unwrap().as_str(), Some("hi there"));
    }
}
