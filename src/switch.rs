use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const DEFAULT_STEP_LIMIT: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionKind {
    Choice,
    Score,
    Noul,
}

impl QuestionKind {
    pub fn wire(self) -> &'static str {
        match self {
            QuestionKind::Choice => "choice",
            QuestionKind::Score => "score",
            QuestionKind::Noul => "noul",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "choice" => Some(QuestionKind::Choice),
            "score" => Some(QuestionKind::Score),
            "noul" | "bool" | "boolean" => Some(QuestionKind::Noul),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Opt {
    pub key: String,
    pub text: Option<String>,
    pub priority: i64,
}

impl Opt {
    pub fn new(key: impl Into<String>, text: impl Into<String>) -> Self {
        Opt {
            key: key.into(),
            text: Some(text.into()),
            priority: 0,
        }
    }

    pub fn bare(key: impl Into<String>) -> Self {
        Opt {
            key: key.into(),
            text: None,
            priority: 0,
        }
    }

    pub fn priority(mut self, p: i64) -> Self {
        self.priority = p;
        self
    }
}

#[derive(Debug, Clone)]
pub struct Question {
    pub kind: QuestionKind,
    pub instructions: Option<String>,
    pub choices: Vec<(String, Option<String>)>,
    pub levels: Vec<String>,
    pub options: BTreeMap<String, Opt>,
}

impl Question {
    pub fn choice(instructions: impl Into<String>, choices: Vec<(&str, Option<&str>)>) -> Self {
        Question {
            kind: QuestionKind::Choice,
            instructions: Some(instructions.into()),
            choices: choices
                .into_iter()
                .map(|(k, d)| (k.to_string(), d.map(|s| s.to_string())))
                .collect(),
            levels: Vec::new(),
            options: BTreeMap::new(),
        }
    }

    pub fn noul(instructions: impl Into<String>) -> Self {
        Question {
            kind: QuestionKind::Noul,
            instructions: Some(instructions.into()),
            choices: Vec::new(),
            levels: Vec::new(),
            options: BTreeMap::new(),
        }
    }

    pub fn score(instructions: impl Into<String>, levels: Vec<&str>) -> Self {
        Question {
            kind: QuestionKind::Score,
            instructions: Some(instructions.into()),
            choices: Vec::new(),
            levels: levels.into_iter().map(|s| s.to_string()).collect(),
            options: BTreeMap::new(),
        }
    }

    pub fn to_wire(&self) -> Value {
        let mut m = Map::new();
        m.insert("type".into(), json!(self.kind.wire()));
        if let Some(i) = &self.instructions {
            m.insert("instructions".into(), json!(i));
        }
        match self.kind {
            QuestionKind::Choice => {
                let mut c = Map::new();
                for (k, d) in &self.choices {
                    c.insert(k.clone(), d.as_ref().map(|s| json!(s)).unwrap_or(Value::Null));
                }
                m.insert("criteria".into(), Value::Object(c));
            }
            QuestionKind::Score => {
                if !self.levels.is_empty() {
                    m.insert("criteria".into(), json!(self.levels));
                }
            }
            QuestionKind::Noul => {}
        }
        Value::Object(m)
    }
}

pub fn pick(options: Vec<Opt>, instructions: Option<&str>) -> Result<Question, SwitchError> {
    if options.is_empty() {
        return Err(SwitchError::Domain(
            "pick: needs a non-empty array of options".into(),
        ));
    }
    let mut sorted = options;
    sorted.sort_by_key(|o| std::cmp::Reverse(o.priority));

    let mut choices = Vec::new();
    let mut map = BTreeMap::new();
    for o in sorted {
        if o.key.is_empty() {
            return Err(SwitchError::Domain(
                "pick: every option needs a non-empty `key`".into(),
            ));
        }
        if map.contains_key(&o.key) {
            return Err(SwitchError::Domain(format!(
                "pick: duplicate option key \"{}\"",
                o.key
            )));
        }
        choices.push((o.key.clone(), o.text.clone()));
        map.insert(o.key.clone(), o);
    }
    Ok(Question {
        kind: QuestionKind::Choice,
        instructions: instructions.map(|s| s.to_string()),
        choices,
        levels: Vec::new(),
        options: map,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Systemone,
    Trace,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Systemone => "systemone",
            Source::Trace => "trace",
        }
    }
}

#[derive(Debug, Clone)]
pub enum Answer {
    Choice {
        choice: String,
        probabilities: BTreeMap<String, f64>,
        confidence: Option<f64>,
        option: Option<Opt>,
        source: Source,
    },
    Score {
        score: f64,
        legend: BTreeMap<String, String>,
        probabilities: BTreeMap<String, f64>,
        confidence: Option<f64>,
        source: Source,
    },
    Noul {
        noul: f64,
        value: bool,
        bool_threshold: f64,
        source: Source,
    },
}

impl Answer {
    pub fn choice(&self) -> Option<&str> {
        match self {
            Answer::Choice { choice, .. } => Some(choice),
            _ => None,
        }
    }

    pub fn value(&self) -> Option<bool> {
        match self {
            Answer::Noul { value, .. } => Some(*value),
            _ => None,
        }
    }

    pub fn score(&self) -> Option<f64> {
        match self {
            Answer::Score { score, .. } => Some(*score),
            _ => None,
        }
    }

    pub fn probability(&self) -> Option<f64> {
        match self {
            Answer::Choice {
                choice,
                probabilities,
                ..
            } => probabilities.get(choice).copied(),
            Answer::Noul { noul, .. } => Some(*noul),
            Answer::Score { .. } => None,
        }
    }

    pub fn source(&self) -> Source {
        match self {
            Answer::Choice { source, .. }
            | Answer::Score { source, .. }
            | Answer::Noul { source, .. } => *source,
        }
    }

    pub fn to_trace(&self) -> Value {
        match self {
            Answer::Choice {
                choice,
                probabilities,
                confidence,
                ..
            } => {
                let mut m = Map::new();
                m.insert("type".into(), json!("choice"));
                m.insert("choice".into(), json!(choice));
                if !probabilities.is_empty() {
                    m.insert("probabilities".into(), json!(probabilities));
                }
                if let Some(c) = confidence {
                    m.insert("confidence".into(), json!(c));
                }
                Value::Object(m)
            }
            Answer::Score {
                score,
                legend,
                probabilities,
                confidence,
                ..
            } => {
                let mut m = Map::new();
                m.insert("type".into(), json!("score"));
                m.insert("score".into(), json!(score));
                if !legend.is_empty() {
                    m.insert("legend".into(), json!(legend));
                }
                if !probabilities.is_empty() {
                    m.insert("probabilities".into(), json!(probabilities));
                }
                if let Some(c) = confidence {
                    m.insert("confidence".into(), json!(c));
                }
                Value::Object(m)
            }
            Answer::Noul { noul, .. } => json!({ "type": "noul", "noul": noul }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    Done,
    StepLimit,
    Failed,
    Drift,
    TraceExhausted,
}

impl Ended {
    pub fn as_str(self) -> &'static str {
        match self {
            Ended::Done => "done",
            Ended::StepLimit => "step limit",
            Ended::Failed => "failed",
            Ended::Drift => "drift",
            Ended::TraceExhausted => "trace exhausted",
        }
    }
}

#[derive(Debug)]
pub enum SwitchError {
    Domain(String),
    Protocol(String),
    Transport(String),
}

impl std::fmt::Display for SwitchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SwitchError::Domain(m) => write!(f, "switch: {m}"),
            SwitchError::Protocol(m) => write!(f, "switch: {m}"),
            SwitchError::Transport(m) => write!(f, "switch: {m}"),
        }
    }
}

impl std::error::Error for SwitchError {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub requests: u64,
}

pub struct Decided {
    pub answers: Value,
    pub usage: Usage,
}

pub trait Domain {
    fn name(&self) -> &str;

    fn version(&self) -> Option<&str> {
        None
    }

    fn step_limit(&self) -> usize {
        DEFAULT_STEP_LIMIT
    }

    fn initial(&self, input: &Value) -> Value;

    fn questions(&self, state: &Value) -> Result<BTreeMap<String, Question>, SwitchError>;

    fn transition(
        &self,
        state: &Value,
        answers: &BTreeMap<String, Answer>,
    ) -> Result<Value, SwitchError>;

    fn view(&self, state: &Value) -> Value {
        state.clone()
    }
}

pub trait Decider {
    fn decide(&mut self, state: &Value, questions: &Value) -> Result<Decided, SwitchError>;
}

#[derive(Debug)]
pub struct Outcome {
    pub state: Value,
    pub answers: Option<BTreeMap<String, Answer>>,
    pub trace: Vec<Value>,
    pub steps: usize,
    pub ended: Ended,
    pub usage: Usage,
}

pub fn format_trace(trace: &[Value]) -> String {
    let mut s = String::new();
    for row in trace {
        s.push_str(&serde_json::to_string(row).unwrap_or_default());
        s.push('\n');
    }
    s
}

pub fn parse_trace(text: &str) -> Result<Vec<Value>, SwitchError> {
    let mut rows = Vec::new();
    for line in text.split('\n') {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        rows.push(
            serde_json::from_str(t)
                .map_err(|e| SwitchError::Protocol(format!("bad trace line: {e}")))?,
        );
    }
    Ok(rows)
}

fn stable(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let inner: Vec<String> = keys
                .iter()
                .map(|k| format!("{}:{}", json!(k), stable(&m[*k])))
                .collect();
            format!("{{{}}}", inner.join(","))
        }
        Value::Array(a) => {
            let inner: Vec<String> = a.iter().map(stable).collect();
            format!("[{}]", inner.join(","))
        }
        other => other.to_string(),
    }
}

fn f64_map(v: Option<&Value>) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    if let Some(Value::Object(m)) = v {
        for (k, val) in m {
            if let Some(n) = val.as_f64() {
                out.insert(k.clone(), n);
            }
        }
    }
    out
}

fn str_map(v: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(Value::Object(m)) = v {
        for (k, val) in m {
            if let Some(s) = val.as_str() {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
    out
}

fn normalize_answers(
    raw: &Value,
    questions: &BTreeMap<String, Question>,
    source: Source,
    bool_threshold: f64,
) -> Result<BTreeMap<String, Answer>, SwitchError> {
    let mut out = BTreeMap::new();
    for (id, q) in questions {
        let a = raw.get(id).ok_or_else(|| {
            SwitchError::Protocol(format!("endpoint returned no answer for question \"{id}\""))
        })?;
        let answer = match q.kind {
            QuestionKind::Choice => {
                let choice = a
                    .get("choice")
                    .and_then(|c| c.as_str())
                    .ok_or_else(|| {
                        SwitchError::Protocol(format!("answer for \"{id}\" has no `choice`"))
                    })?
                    .to_string();
                Answer::Choice {
                    option: q.options.get(&choice).cloned(),
                    probabilities: f64_map(a.get("probabilities")),
                    confidence: a.get("confidence").and_then(|c| c.as_f64()),
                    choice,
                    source,
                }
            }
            QuestionKind::Score => Answer::Score {
                score: a.get("score").and_then(|s| s.as_f64()).ok_or_else(|| {
                    SwitchError::Protocol(format!("answer for \"{id}\" has no `score`"))
                })?,
                legend: str_map(a.get("legend")),
                probabilities: f64_map(a.get("probabilities")),
                confidence: a.get("confidence").and_then(|c| c.as_f64()),
                source,
            },
            QuestionKind::Noul => {
                let noul = a.get("noul").and_then(|n| n.as_f64()).ok_or_else(|| {
                    SwitchError::Protocol(format!("answer for \"{id}\" has no `noul`"))
                })?;
                Answer::Noul {
                    noul,
                    value: noul >= bool_threshold,
                    bool_threshold,
                    source,
                }
            }
        };
        out.insert(id.clone(), answer);
    }
    Ok(out)
}

pub enum Mode<'a> {
    Run(&'a mut dyn Decider),
    Replay(Vec<Value>),
    Fork {
        trace: Vec<Value>,
        steps: usize,
        decider: &'a mut dyn Decider,
    },
}

type ModeParts<'a> = (Vec<Value>, usize, Option<&'a mut dyn Decider>, String);

pub fn run_switch(
    domain: &dyn Domain,
    input: &Value,
    mode: Mode<'_>,
    describe: Option<&str>,
    bool_threshold: f64,
) -> Result<Outcome, SwitchError> {
    let (recorded, replay_up_to, mut decider, mode_label): ModeParts = match mode {
        Mode::Run(d) => (Vec::new(), 0, Some(d), "run".to_string()),
        Mode::Replay(trace) => {
            let steps: Vec<Value> = trace
                .into_iter()
                .filter(|r| r.get("type").and_then(|t| t.as_str()) == Some("step"))
                .collect();
            let n = steps.len();
            (steps, n, None, "replay".to_string())
        }
        Mode::Fork {
            trace,
            steps,
            decider,
        } => {
            let rows: Vec<Value> = trace
                .into_iter()
                .filter(|r| r.get("type").and_then(|t| t.as_str()) == Some("step"))
                .collect();
            let n = steps.min(rows.len());
            (rows, n, Some(decider), format!("fork:{n}"))
        }
    };

    let mut state = if !recorded.is_empty() {
        recorded[0]
            .get("state")
            .cloned()
            .unwrap_or_else(|| domain.initial(input))
    } else {
        domain.initial(input)
    };

    let mut trace = vec![json!({
        "v": 1,
        "type": "meta",
        "domain": domain.name(),
        "version": domain.version(),
        "decision_model": describe,
        "mode": mode_label,
    })];

    let step_limit = domain.step_limit().max(1);
    let mut steps = 0usize;
    let mut ended = Ended::Done;
    let mut last_answers: Option<BTreeMap<String, Answer>> = None;
    let mut usage = Usage::default();

    loop {
        if steps >= step_limit {
            ended = Ended::StepLimit;
            break;
        }

        let questions = domain.questions(&state)?;
        if questions.is_empty() {
            break;
        }

        let wire = {
            let mut m = Map::new();
            for (id, q) in &questions {
                m.insert(id.clone(), q.to_wire());
            }
            Value::Object(m)
        };
        let view = domain.view(&state);

        let use_recorded = steps < replay_up_to && steps < recorded.len();
        let (answers, source) = if use_recorded {
            let rec = &recorded[steps];
            let rec_q = rec.get("questions").cloned().unwrap_or(Value::Null);
            if stable(&rec_q) != stable(&wire) {
                trace.push(json!({
                    "v": 1,
                    "type": "drift",
                    "step": steps,
                    "expected": rec_q,
                    "actual": wire,
                }));
                ended = Ended::Drift;
                break;
            }
            let raw = rec.get("answers").cloned().unwrap_or(Value::Null);
            (
                normalize_answers(&raw, &questions, Source::Trace, bool_threshold)?,
                Source::Trace,
            )
        } else {
            let Some(d) = decider.as_deref_mut() else {
                ended = Ended::TraceExhausted;
                break;
            };
            let got = d.decide(&view, &wire)?;
            usage.input_tokens += got.usage.input_tokens;
            usage.output_tokens += got.usage.output_tokens;
            usage.requests += 1;
            (
                normalize_answers(&got.answers, &questions, Source::Systemone, bool_threshold)?,
                Source::Systemone,
            )
        };

        let mut rec_answers = Map::new();
        for (id, a) in &answers {
            rec_answers.insert(id.clone(), a.to_trace());
        }
        trace.push(json!({
            "v": 1,
            "type": "step",
            "step": steps,
            "source": source.as_str(),
            "state": state,
            "view": view,
            "questions": wire,
            "answers": Value::Object(rec_answers),
        }));

        steps += 1;

        match domain.transition(&state, &answers) {
            Ok(next) => state = next,
            Err(e) => {
                trace.push(json!({
                    "v": 1, "type": "error", "step": steps - 1, "message": e.to_string(),
                }));
                last_answers = Some(answers);
                ended = Ended::Failed;
                break;
            }
        }
        last_answers = Some(answers);
    }

    trace.push(json!({
        "v": 1, "type": "end", "ended": ended.as_str(), "steps": steps, "state": state,
    }));

    Ok(Outcome {
        state,
        answers: last_answers,
        trace,
        steps,
        ended,
        usage,
    })
}
