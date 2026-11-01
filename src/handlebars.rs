//! mini-handlebars — port of `src/lib/mini-handlebars.mjs`.
//!
//! Supported: `{{path}}`, `{{#if}}`/`{{#unless}}/{{#each}}/{{#with}}` with
//! `{{else}}` and `{{else if}}`, `{{this}}`, `./`, `../`, `@index`/`@key`/
//! `@first`/`@last`, `{{~ ~}}` whitespace control, and `\{{escaped}}`.
//!
//! Not supported (same as the original): comments, custom helpers, partials,
//! subexpressions, hash arguments, block parameters, raw blocks, HTML
//! escaping.

use serde_json::Value;

const BUILTIN: [&str; 4] = ["if", "unless", "each", "with"];

#[derive(Debug)]
pub struct TemplateError(pub String);

impl std::fmt::Display for TemplateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "mini-handlebars: {}", self.0)
    }
}

impl std::error::Error for TemplateError {}

fn err<T>(msg: impl Into<String>) -> Result<T, TemplateError> {
    Err(TemplateError(msg.into()))
}

// --- tokens -----------------------------------------------------------------

#[derive(Debug, Clone)]
enum Tok {
    Text(String),
    Expr {
        path: String,
        strip_left: bool,
        strip_right: bool,
    },
    Open {
        helper: String,
        arg: String,
        strip_left: bool,
        strip_right: bool,
    },
    Close {
        helper: String,
        strip_left: bool,
        strip_right: bool,
    },
    Else {
        helper: Option<String>,
        arg: String,
        strip_left: bool,
        strip_right: bool,
    },
}

impl Tok {
    fn is_blockish(&self) -> bool {
        matches!(self, Tok::Open { .. } | Tok::Close { .. } | Tok::Else { .. })
    }
    fn strip_left(&self) -> bool {
        match self {
            Tok::Text(_) => false,
            Tok::Expr { strip_left, .. }
            | Tok::Open { strip_left, .. }
            | Tok::Close { strip_left, .. }
            | Tok::Else { strip_left, .. } => *strip_left,
        }
    }
    fn strip_right(&self) -> bool {
        match self {
            Tok::Text(_) => false,
            Tok::Expr { strip_right, .. }
            | Tok::Open { strip_right, .. }
            | Tok::Close { strip_right, .. }
            | Tok::Else { strip_right, .. } => *strip_right,
        }
    }
}

fn tokenize(src: &str) -> Result<Vec<Tok>, TemplateError> {
    let b: Vec<char> = src.chars().collect();
    let n = b.len();
    let mut tokens = Vec::new();
    let mut i = 0usize;
    let mut text_start = 0usize;

    while i < n {
        // \{{...}} → emit the mustache literally, without the backslash.
        if b[i] == '\\' && i + 2 < n && b[i + 1] == '{' && b[i + 2] == '{' {
            if i > text_start {
                tokens.push(Tok::Text(b[text_start..i].iter().collect()));
            }
            let j = i + 1;
            let triple = j + 2 < n && b[j + 2] == '{';
            let closer: &[char] = if triple {
                &['}', '}', '}']
            } else {
                &['}', '}']
            };
            let start = j + if triple { 3 } else { 2 };
            let Some(idx) = find_seq(&b, start, closer) else {
                return err("unclosed escaped mustache");
            };
            let next = idx + closer.len();
            tokens.push(Tok::Text(b[j..next].iter().collect()));
            i = next;
            text_start = i;
            continue;
        }
        if b[i] == '{' && i + 1 < n && b[i + 1] == '{' {
            if i > text_start {
                tokens.push(Tok::Text(b[text_start..i].iter().collect()));
            }
            let (tok, next) = scan_mustache(&b, i)?;
            tokens.push(tok);
            i = next;
            text_start = i;
            continue;
        }
        i += 1;
    }
    if n > text_start {
        tokens.push(Tok::Text(b[text_start..n].iter().collect()));
    }
    Ok(tokens)
}

fn find_seq(b: &[char], from: usize, needle: &[char]) -> Option<usize> {
    if needle.is_empty() || b.len() < needle.len() {
        return None;
    }
    (from..=b.len().saturating_sub(needle.len())).find(|&k| &b[k..k + needle.len()] == needle)
}

fn scan_mustache(b: &[char], i: usize) -> Result<(Tok, usize), TemplateError> {
    let n = b.len();
    let mut j = i + 2;
    let triple = j < n && b[j] == '{';
    if triple {
        j += 1;
    }
    let mut strip_left = false;
    if j < n && b[j] == '~' {
        strip_left = true;
        j += 1;
    }
    let mut k = j;
    let mut strip_right = false;
    let mut end = None;
    let mut close_end = 0usize;

    while k < n {
        let at = |o: usize| -> Option<char> { b.get(k + o).copied() };
        if triple {
            if at(0) == Some('~')
                && at(1) == Some('}')
                && at(2) == Some('}')
                && at(3) == Some('}')
            {
                strip_right = true;
                end = Some(k);
                close_end = k + 4;
                break;
            }
            if at(0) == Some('}') && at(1) == Some('}') && at(2) == Some('}') {
                end = Some(k);
                close_end = k + 3;
                break;
            }
        } else {
            if at(0) == Some('~') && at(1) == Some('}') && at(2) == Some('}') {
                strip_right = true;
                end = Some(k);
                close_end = k + 3;
                break;
            }
            if at(0) == Some('}') && at(1) == Some('}') {
                end = Some(k);
                close_end = k + 2;
                break;
            }
        }
        k += 1;
    }
    let Some(end) = end else {
        return err("unclosed mustache");
    };
    let content: String = b[j..end].iter().collect();
    let tok = parse_tag(&content, strip_left, strip_right)?;
    Ok((tok, close_end))
}

fn parse_tag(content: &str, strip_left: bool, strip_right: bool) -> Result<Tok, TemplateError> {
    let s = content.trim();
    if s.is_empty() {
        return err("empty mustache");
    }
    if let Some(rest) = s.strip_prefix('#') {
        let (helper, arg) = split_helper(rest.trim())?;
        if !BUILTIN.contains(&helper.as_str()) {
            return err(format!("unknown helper '{helper}'"));
        }
        return Ok(Tok::Open {
            helper,
            arg,
            strip_left,
            strip_right,
        });
    }
    if let Some(rest) = s.strip_prefix('/') {
        let helper = rest.trim().to_string();
        if !BUILTIN.contains(&helper.as_str()) {
            return err(format!("unknown helper '{helper}'"));
        }
        return Ok(Tok::Close {
            helper,
            strip_left,
            strip_right,
        });
    }
    if s == "else" || s.starts_with("else ") {
        let rest = s[4..].trim();
        if rest.is_empty() {
            return Ok(Tok::Else {
                helper: None,
                arg: String::new(),
                strip_left,
                strip_right,
            });
        }
        if let Some(a) = rest.strip_prefix("if ") {
            return Ok(Tok::Else {
                helper: Some("if".into()),
                arg: a.trim().to_string(),
                strip_left,
                strip_right,
            });
        }
        if let Some(a) = rest.strip_prefix("unless ") {
            return Ok(Tok::Else {
                helper: Some("unless".into()),
                arg: a.trim().to_string(),
                strip_left,
                strip_right,
            });
        }
        return err(format!("invalid else: {s}"));
    }
    Ok(Tok::Expr {
        path: s.to_string(),
        strip_left,
        strip_right,
    })
}

/// `^([A-Za-z_][\w-]*)(?:\s+([\s\S]+))?$`
fn split_helper(rest: &str) -> Result<(String, String), TemplateError> {
    let mut chars = rest.char_indices();
    let Some((_, first)) = chars.next() else {
        return err(format!("invalid block helper: {rest}"));
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return err(format!("invalid block helper: {rest}"));
    }
    let mut split_at = rest.len();
    for (idx, c) in rest.char_indices().skip(1) {
        if c.is_alphanumeric() || c == '_' || c == '-' {
            continue;
        }
        if c.is_whitespace() {
            split_at = idx;
            break;
        }
        return err(format!("invalid block helper: {rest}"));
    }
    let name = rest[..split_at].to_string();
    let arg = rest[split_at..].trim().to_string();
    Ok((name, arg))
}

// --- whitespace -------------------------------------------------------------

fn line_left_ok(tokens: &[Tok], i: usize) -> bool {
    let mut j = i as isize - 1;
    while j >= 0 {
        match &tokens[j as usize] {
            Tok::Text(v) => {
                // /(?:^|\n)[ \t]*$/
                let tail = v.rsplit('\n').next().unwrap_or("");
                if !tail.chars().all(|c| c == ' ' || c == '\t') {
                    return false;
                }
                if v.contains('\n') {
                    return true;
                }
                if v.len() != tail.len() {
                    return false;
                }
            }
            _ => return false,
        }
        j -= 1;
    }
    true
}

fn line_right_ok(tokens: &[Tok], i: usize) -> bool {
    let mut j = i + 1;
    while j < tokens.len() {
        match &tokens[j] {
            Tok::Text(v) => {
                // /^[ \t]*(?:\n|$)/
                let head: String = v.chars().take_while(|c| *c == ' ' || *c == '\t').collect();
                let after = &v[head.len()..];
                if !(after.is_empty() || after.starts_with('\n')) {
                    return false;
                }
                if v.contains('\n') {
                    return true;
                }
            }
            _ => return false,
        }
        j += 1;
    }
    true
}

/// Standalone block tags eat their indent and trailing newline, as Handlebars
/// does. The tag must be the only non-whitespace on its line.
fn apply_whitespace(mut tokens: Vec<Tok>) -> Vec<Tok> {
    let marks: Vec<usize> = (0..tokens.len())
        .filter(|&i| tokens[i].is_blockish() && line_left_ok(&tokens, i) && line_right_ok(&tokens, i))
        .collect();
    for i in marks {
        if i > 0 {
            if let Tok::Text(v) = &mut tokens[i - 1] {
                *v = v.trim_end_matches([' ', '\t']).to_string();
            }
        }
        if i + 1 < tokens.len() {
            if let Tok::Text(v) = &mut tokens[i + 1] {
                let head: String = v.chars().take_while(|c| *c == ' ' || *c == '\t').collect();
                let mut rest = v[head.len()..].to_string();
                if rest.starts_with('\n') {
                    rest.remove(0);
                }
                *v = rest;
            }
        }
    }
    for i in 0..tokens.len() {
        if matches!(tokens[i], Tok::Text(_)) {
            continue;
        }
        if tokens[i].strip_left() && i > 0 {
            if let Tok::Text(v) = &mut tokens[i - 1] {
                *v = v.trim_end().to_string();
            }
        }
        if tokens[i].strip_right() && i + 1 < tokens.len() {
            if let Tok::Text(v) = &mut tokens[i + 1] {
                *v = v.trim_start().to_string();
            }
        }
    }
    tokens
}

// --- ast --------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Node {
    Text(String),
    Expr(String),
    Block {
        helper: String,
        arg: String,
        body: Vec<Node>,
        inverse: Vec<Node>,
    },
}

struct Parser {
    tokens: Vec<Tok>,
    i: usize,
}

impl Parser {
    fn parse_until(&mut self, close_name: Option<&str>) -> Result<Vec<Node>, TemplateError> {
        let mut nodes = Vec::new();
        while self.i < self.tokens.len() {
            match self.tokens[self.i].clone() {
                Tok::Close { helper, .. } => {
                    if close_name == Some(helper.as_str()) {
                        return Ok(nodes);
                    }
                    return err(format!("unexpected {{{{/{helper}}}}}"));
                }
                Tok::Else { .. } => {
                    if close_name.is_none() {
                        return err("{{else}} at top level");
                    }
                    return Ok(nodes);
                }
                Tok::Text(v) => {
                    self.i += 1;
                    if !v.is_empty() {
                        nodes.push(Node::Text(v));
                    }
                }
                Tok::Expr { path, .. } => {
                    self.i += 1;
                    nodes.push(Node::Expr(path));
                }
                Tok::Open { helper, arg, .. } => {
                    self.i += 1;
                    nodes.push(self.parse_block(&helper, &arg, None)?);
                }
            }
        }
        if let Some(name) = close_name {
            return err(format!("unclosed {{{{#{name}}}}}"));
        }
        Ok(nodes)
    }

    /// `until`: set when this block is an `{{else if}}` nested inside another
    /// helper — wait for that helper's close, and do not consume it.
    fn parse_block(
        &mut self,
        helper: &str,
        arg: &str,
        until: Option<&str>,
    ) -> Result<Node, TemplateError> {
        let consume_close = until.is_none();
        let until_name = until.unwrap_or(helper).to_string();
        let body = self.parse_until(Some(&until_name))?;
        let mut inverse = Vec::new();

        if let Some(Tok::Else {
            helper: eh,
            arg: ea,
            ..
        }) = self.tokens.get(self.i).cloned()
        {
            self.i += 1;
            match eh {
                Some(h) => inverse = vec![self.parse_block(&h, &ea, Some(&until_name))?],
                None => inverse = self.parse_until(Some(&until_name))?,
            }
        }
        if consume_close {
            match self.tokens.get(self.i) {
                Some(Tok::Close { helper: h, .. }) if *h == until_name => self.i += 1,
                _ => return err(format!("unclosed {{{{#{helper}}}}}")),
            }
        }
        Ok(Node::Block {
            helper: helper.to_string(),
            arg: arg.to_string(),
            body,
            inverse,
        })
    }
}

fn parse(src: &str) -> Result<Vec<Node>, TemplateError> {
    let tokens = apply_whitespace(tokenize(src)?);
    let mut p = Parser { tokens, i: 0 };
    p.parse_until(None)
}

// --- paths ------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Seg {
    Parent,
    Current,
    Id(String),
    Literal(String),
}

#[derive(Debug, Clone)]
struct Path {
    data: bool,
    segs: Vec<Seg>,
}

fn parse_path(s: &str) -> Result<Path, TemplateError> {
    let s = s.trim();
    let mut segs = Vec::new();
    if s.is_empty() {
        return Ok(Path { data: false, segs });
    }
    let b: Vec<char> = s.chars().collect();
    let n = b.len();
    let mut data = false;
    let mut i = 0usize;
    if b[0] == '@' {
        data = true;
        i = 1;
    }
    let mut leading = true;
    while i < n {
        if b[i] == '.'
            && i + 1 < n
            && b[i + 1] == '.'
            && (i + 2 >= n || b[i + 2] == '/' || b[i + 2] == '.')
        {
            segs.push(Seg::Parent);
            i += 2;
            if i < n && b[i] == '/' {
                i += 1;
            }
            leading = true;
            continue;
        }
        if b[i] == '.' {
            if leading && segs.is_empty() {
                segs.push(Seg::Current);
            }
            i += 1;
            if i < n && b[i] == '/' {
                i += 1;
            }
            leading = false;
            continue;
        }
        if b[i] == '/' {
            i += 1;
            continue;
        }
        if b[i] == '[' {
            let Some(j) = (i + 1..n).find(|&k| b[k] == ']') else {
                return err(format!("unclosed literal segment in path: {s}"));
            };
            let mut inner: String = b[i + 1..j].iter().collect();
            let ib: Vec<char> = inner.chars().collect();
            if ib.len() >= 2
                && ((ib[0] == '"' && ib[ib.len() - 1] == '"')
                    || (ib[0] == '\'' && ib[ib.len() - 1] == '\''))
            {
                inner = ib[1..ib.len() - 1].iter().collect();
            }
            segs.push(Seg::Literal(inner));
            i = j + 1;
            leading = false;
            continue;
        }
        // /^[A-Za-z0-9_$-]+/
        let start = i;
        while i < n && (b[i].is_ascii_alphanumeric() || b[i] == '_' || b[i] == '$' || b[i] == '-') {
            i += 1;
        }
        if i == start {
            return err(format!("invalid path: {s}"));
        }
        let name: String = b[start..i].iter().collect();
        if leading && name == "this" && segs.is_empty() {
            segs.push(Seg::Current);
        } else {
            segs.push(Seg::Id(name));
        }
        leading = false;
    }
    Ok(Path { data, segs })
}

/// A rendering frame: the context value plus `@`-data for the enclosing block.
#[derive(Debug, Clone)]
struct Frame {
    value: Value,
    data: Value,
}

fn frame(value: Value) -> Frame {
    Frame {
        value,
        data: Value::Object(Default::default()),
    }
}

fn seg_name(s: &Seg) -> &str {
    match s {
        Seg::Id(n) | Seg::Literal(n) => n,
        _ => "",
    }
}

fn get_prop(v: &Value, key: &str) -> Option<Value> {
    match v {
        Value::Object(m) => m.get(key).cloned(),
        Value::Array(a) => {
            // Numeric index, and `length` as JS would give it.
            if key == "length" {
                return Some(Value::from(a.len()));
            }
            key.parse::<usize>().ok().and_then(|i| a.get(i).cloned())
        }
        Value::String(s) => {
            if key == "length" {
                Some(Value::from(s.chars().count()))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn has_prop(v: &Value, key: &str) -> bool {
    match v {
        Value::Object(m) => m.contains_key(key),
        Value::Array(_) | Value::String(_) => get_prop(v, key).is_some(),
        _ => false,
    }
}

fn lookup_data(segs: &[Seg], frames: &[Frame]) -> Option<Value> {
    let mut idx = frames.len() as isize - 1;
    let mut i = 0usize;
    while i < segs.len() && segs[i] == Seg::Parent {
        idx -= 1;
        i += 1;
        if idx < 0 {
            return None;
        }
    }
    while i < segs.len() && segs[i] == Seg::Current {
        i += 1;
    }
    let data = &frames[idx as usize].data;
    if i >= segs.len() {
        return Some(data.clone());
    }
    let mut val = get_prop(data, seg_name(&segs[i]));
    i += 1;
    while i < segs.len() {
        val = get_prop(&val?, seg_name(&segs[i]));
        i += 1;
    }
    val
}

fn lookup(path_str: &str, frames: &[Frame]) -> Option<Value> {
    let parsed = parse_path(path_str).ok()?;
    let segs = &parsed.segs;
    if segs.is_empty() {
        return None;
    }
    if parsed.data {
        return lookup_data(segs, frames);
    }
    let mut frame_idx = frames.len() as isize - 1;
    let mut i = 0usize;
    let mut current_only = false;
    while i < segs.len() {
        match segs[i] {
            Seg::Parent => {
                frame_idx -= 1;
                if frame_idx < 0 {
                    return None;
                }
                i += 1;
            }
            Seg::Current => {
                current_only = true;
                i += 1;
                break;
            }
            _ => break,
        }
    }
    if frame_idx < 0 {
        return None;
    }
    let fi = frame_idx as usize;
    if i >= segs.len() {
        return Some(frames[fi].value.clone());
    }
    let first = &segs[i];
    let key = seg_name(first);
    let mut obj: Option<Value> = if current_only || matches!(first, Seg::Literal(_)) {
        get_prop(&frames[fi].value, key)
    } else {
        // Walk out through enclosing frames, as Handlebars does.
        let mut found = None;
        for f in (0..=fi).rev() {
            if has_prop(&frames[f].value, key) {
                found = get_prop(&frames[f].value, key);
                break;
            }
        }
        found
    };
    i += 1;
    while i < segs.len() {
        obj = get_prop(&obj?, seg_name(&segs[i]));
        i += 1;
    }
    obj
}

fn literal_arg(s: &str) -> Option<Value> {
    match s {
        "true" => return Some(Value::Bool(true)),
        "false" => return Some(Value::Bool(false)),
        "null" | "undefined" => return Some(Value::Null),
        _ => {}
    }
    // /^-?\d+(?:\.\d+)?$/
    let body = s.strip_prefix('-').unwrap_or(s);
    let mut parts = body.split('.');
    let int = parts.next().unwrap_or("");
    let frac = parts.next();
    if parts.next().is_none()
        && !int.is_empty()
        && int.bytes().all(|c| c.is_ascii_digit())
        && frac.map(|f| !f.is_empty() && f.bytes().all(|c| c.is_ascii_digit())).unwrap_or(true)
    {
        if let Ok(n) = s.parse::<f64>() {
            return serde_json::Number::from_f64(n).map(Value::Number);
        }
    }
    let b: Vec<char> = s.chars().collect();
    if b.len() >= 2
        && ((b[0] == '"' && b[b.len() - 1] == '"') || (b[0] == '\'' && b[b.len() - 1] == '\''))
    {
        return Some(Value::String(b[1..b.len() - 1].iter().collect()));
    }
    None
}

fn resolve_arg(arg: &str, frames: &[Frame]) -> Option<Value> {
    let s = arg.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(v) = literal_arg(s) {
        return Some(v);
    }
    lookup(s, frames)
}

/// `String(v)` semantics, with null/false rendering as empty.
fn stringify(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::Bool(true)) => "true".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(other) => other.to_string(),
    }
}

fn is_falsy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => true,
        Some(Value::String(s)) => s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() == Some(0.0),
        Some(Value::Array(a)) => a.is_empty(),
        _ => false,
    }
}

fn is_empty(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => true,
        Some(Value::String(s)) => s.is_empty(),
        Some(Value::Array(a)) => a.is_empty(),
        _ => false,
    }
}

// --- render -----------------------------------------------------------------

fn render(nodes: &[Node], frames: &[Frame]) -> Result<String, TemplateError> {
    let mut out = String::new();
    for node in nodes {
        match node {
            Node::Text(t) => out.push_str(t),
            Node::Expr(p) => out.push_str(&stringify(resolve_arg(p, frames).as_ref())),
            Node::Block { .. } => out.push_str(&render_block(node, frames)?),
        }
    }
    Ok(out)
}

fn render_block(node: &Node, frames: &[Frame]) -> Result<String, TemplateError> {
    let Node::Block {
        helper,
        arg,
        body,
        inverse,
    } = node
    else {
        return Ok(String::new());
    };
    match helper.as_str() {
        "if" => {
            let v = resolve_arg(arg, frames);
            if is_falsy(v.as_ref()) {
                render(inverse, frames)
            } else {
                render(body, frames)
            }
        }
        "unless" => {
            let v = resolve_arg(arg, frames);
            if is_falsy(v.as_ref()) {
                render(body, frames)
            } else {
                render(inverse, frames)
            }
        }
        "with" => {
            let v = resolve_arg(arg, frames);
            if is_empty(v.as_ref()) {
                return render(inverse, frames);
            }
            let mut next = frames.to_vec();
            next.push(Frame {
                value: v.unwrap(),
                data: frames.last().map(|f| f.data.clone()).unwrap_or(Value::Null),
            });
            render(body, &next)
        }
        "each" => render_each(arg, body, inverse, frames),
        other => err(format!("unknown helper '{other}'")),
    }
}

fn each_data(index: usize, key: Value, last: usize) -> Value {
    serde_json::json!({
        "index": index,
        "key": key,
        "first": index == 0,
        "last": index == last,
    })
}

fn render_each(
    arg: &str,
    body: &[Node],
    inverse: &[Node],
    frames: &[Frame],
) -> Result<String, TemplateError> {
    let v = resolve_arg(arg, frames);
    match v {
        Some(Value::Array(items)) => {
            if items.is_empty() {
                return render(inverse, frames);
            }
            let last = items.len() - 1;
            let mut out = String::new();
            for (idx, item) in items.iter().enumerate() {
                let mut next = frames.to_vec();
                next.push(Frame {
                    value: item.clone(),
                    data: each_data(idx, Value::from(idx), last),
                });
                out.push_str(&render(body, &next)?);
            }
            Ok(out)
        }
        Some(Value::Object(map)) => {
            if map.is_empty() {
                return render(inverse, frames);
            }
            let last = map.len() - 1;
            let mut out = String::new();
            for (idx, (k, item)) in map.iter().enumerate() {
                let mut next = frames.to_vec();
                next.push(Frame {
                    value: item.clone(),
                    data: each_data(idx, Value::String(k.clone()), last),
                });
                out.push_str(&render(body, &next)?);
            }
            Ok(out)
        }
        _ => render(inverse, frames),
    }
}

/// Compile and render a template against `locals`.
pub fn compile(template: &str, locals: &Value) -> Result<String, TemplateError> {
    let ast = parse(template)?;
    render(&ast, &[frame(locals.clone())])
}

/// Apply substitution when `locals` is a plain object; otherwise return the
/// template unchanged, so existing `{{...}}` in a prompt is preserved unless
/// the caller opts in.
pub fn apply_locals(template: &str, locals: Option<&Value>) -> String {
    match locals {
        Some(Value::Object(_)) => compile(template, locals.unwrap())
            .unwrap_or_else(|_| template.to_string()),
        _ => template.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn t(src: &str, locals: Value) -> String {
        compile(src, &locals).unwrap()
    }

    #[test]
    fn substitutes_a_simple_path() {
        assert_eq!(t("Hi {{name}}", json!({"name":"Ada"})), "Hi Ada");
        assert_eq!(t("{{a.b.c}}", json!({"a":{"b":{"c":"deep"}}})), "deep");
    }

    #[test]
    fn a_missing_path_renders_empty_not_undefined() {
        assert_eq!(t("[{{nope}}]", json!({})), "[]");
        assert_eq!(t("[{{a.b.c}}]", json!({"a":{}})), "[]");
    }

    #[test]
    fn non_object_locals_leave_the_template_untouched() {
        // The opt-in rule: without an object, {{...}} is preserved.
        assert_eq!(apply_locals("Hi {{name}}", None), "Hi {{name}}");
        assert_eq!(apply_locals("Hi {{name}}", Some(&json!([1, 2]))), "Hi {{name}}");
        assert_eq!(
            apply_locals("Hi {{name}}", Some(&json!({"name":"Ada"}))),
            "Hi Ada"
        );
    }

    #[test]
    fn if_and_unless_with_else() {
        assert_eq!(t("{{#if a}}Y{{else}}N{{/if}}", json!({"a":true})), "Y");
        assert_eq!(t("{{#if a}}Y{{else}}N{{/if}}", json!({"a":false})), "N");
        // JS falsy: 0, "", [] are all falsy.
        assert_eq!(t("{{#if a}}Y{{else}}N{{/if}}", json!({"a":0})), "N");
        assert_eq!(t("{{#if a}}Y{{else}}N{{/if}}", json!({"a":""})), "N");
        assert_eq!(t("{{#if a}}Y{{else}}N{{/if}}", json!({"a":[]})), "N");
        assert_eq!(t("{{#unless a}}Y{{else}}N{{/unless}}", json!({"a":false})), "Y");
    }

    #[test]
    fn else_if_chains() {
        let src = "{{#if a}}A{{else if b}}B{{else}}C{{/if}}";
        assert_eq!(t(src, json!({"a":true})), "A");
        assert_eq!(t(src, json!({"b":true})), "B");
        assert_eq!(t(src, json!({})), "C");
    }

    #[test]
    fn each_over_an_array_with_data_variables() {
        assert_eq!(
            t("{{#each xs}}{{@index}}:{{this}} {{/each}}", json!({"xs":["a","b"]})),
            "0:a 1:b "
        );
        assert_eq!(
            t("{{#each xs}}{{#if @first}}F{{/if}}{{#if @last}}L{{/if}}{{/each}}",
              json!({"xs":[1,2]})),
            "FL"
        );
    }

    #[test]
    fn each_over_an_object_exposes_key() {
        assert_eq!(
            t("{{#each m}}{{@key}}={{this}};{{/each}}", json!({"m":{"a":1,"b":2}})),
            "a=1;b=2;"
        );
    }

    #[test]
    fn each_falls_back_to_else_when_empty() {
        assert_eq!(t("{{#each xs}}x{{else}}none{{/each}}", json!({"xs":[]})), "none");
        assert_eq!(t("{{#each xs}}x{{else}}none{{/each}}", json!({})), "none");
    }

    #[test]
    fn parent_paths_reach_the_enclosing_context() {
        assert_eq!(
            t("{{#each xs}}{{../name}}-{{this}} {{/each}}",
              json!({"name":"n","xs":[1,2]})),
            "n-1 n-2 "
        );
    }

    #[test]
    fn with_narrows_the_context_and_else_covers_empty() {
        assert_eq!(t("{{#with a}}{{b}}{{/with}}", json!({"a":{"b":"x"}})), "x");
        assert_eq!(t("{{#with a}}{{b}}{{else}}E{{/with}}", json!({})), "E");
    }

    #[test]
    fn a_backslash_escapes_a_mustache() {
        assert_eq!(t("\\{{name}}", json!({"name":"Ada"})), "{{name}}");
    }

    #[test]
    fn tilde_trims_surrounding_whitespace() {
        assert_eq!(t("a   {{~name}}", json!({"name":"X"})), "aX");
        assert_eq!(t("{{name~}}   b", json!({"name":"X"})), "Xb");
    }

    #[test]
    fn a_standalone_block_tag_eats_its_own_line() {
        // The {{#if}}/{{/if}} lines disappear entirely, leaving one line.
        let src = "start\n{{#if a}}\nmiddle\n{{/if}}\nend";
        assert_eq!(t(src, json!({"a":true})), "start\nmiddle\nend");
    }

    #[test]
    fn unclosed_and_unknown_constructs_are_errors() {
        assert!(compile("{{#if a}}x", &json!({})).is_err());
        assert!(compile("{{name", &json!({})).is_err());
        assert!(compile("{{#nope a}}x{{/nope}}", &json!({})).is_err());
        assert!(compile("{{}}", &json!({})).is_err());
        assert!(compile("{{else}}", &json!({})).is_err());
    }

    #[test]
    fn literal_segments_allow_awkward_keys() {
        assert_eq!(t("{{[odd key]}}", json!({"odd key":"v"})), "v");
    }

    #[test]
    fn numbers_and_booleans_stringify_like_js() {
        assert_eq!(t("{{n}}|{{b}}|{{f}}", json!({"n":3,"b":true,"f":false})), "3|true|");
    }
}
