//! switch — a finite-choice decision loop over a System One model.
//!
//! Port of `src/switch.mjs`. The shape comes from osolmaz/switch:
//! your code offers a short list of typed questions, the model picks, your
//! code transitions, and the run ends when there are no questions left.
//!
//! This is the module that most benefits from the port. In JS a question type
//! is a string that is validated at request time; here `QuestionKind` is an
//! enum and `Answer` is a sum type, so a malformed question cannot be built
//! and `match` on an answer is exhaustive. The `bool` alias and the wire name
//! `noul` are reconciled once, in one place.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Default cap on loop steps when a domain does not set one.
pub const DEFAULT_STEP_LIMIT: usize = 20;

/// The three question types the decision endpoint accepts.
///
/// `Noul` is the wire name; `bool` is accepted as an alias on the way in and
/// normalized here, so the rest of the code never sees two spellings.
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

    /// Parse an incoming type name, accepting the `bool`/`boolean` aliases.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "choice" => Some(QuestionKind::Choice),
            "score" => Some(QuestionKind::Score),
            "noul" | "bool" | "boolean" => Some(QuestionKind::Noul),
            _ => None,
        }
    }
}

/// One option of a `pick` question: `key` is what the model answers with,
/// `text` is what it reads, higher `priority` sorts first.
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

/// A question to put to the decision model.
#[derive(Debug, Clone)]
pub struct Question {
    pub kind: QuestionKind,
    pub instructions: Option<String>,
    /// `choice`: option key → description. Insertion order is preserved so a
    /// `pick` priority ordering survives to the wire.
    pub choices: Vec<(String, Option<String>)>,
    /// `score`: level descriptions, lowest first.
    pub levels: Vec<String>,
    /// Full option objects from `pick`, so a transition can get one back.
    /// Never sent to the endpoint.
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

    /// The wire shape, with our private option map stripped.
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

/// Build a `choice` question from a list of options — the counterpart of
/// Switch's `pick`/`picking` helper. Higher `priority` sorts first, so a
/// terminal option goes last with a negative one.
///
/// # Errors
/// An empty list, an empty key, or a duplicate key.
pub fn pick(options: Vec<Opt>, instructions: Option<&str>) -> Result<Question, SwitchError> {
    if options.is_empty() {
        return Err(SwitchError::Domain(
            "pick: needs a non-empty array of options".into(),
        ));
    }
    let mut sorted = options;
    // Stable sort, descending by priority — equal priorities keep their order.
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

/// Where an answer's numbers came from. These are **not** the same kind of
/// evidence, so they do not share a word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// A distribution measured by the decision model.
    Systemone,
    /// Replayed from a recorded run — no model involved.
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

/// An answer from the decision model.
///
/// A sum type rather than one struct with optional fields: a `Choice` cannot
/// be read as if it carried a score, and `match` is exhaustive.
#[derive(Debug, Clone)]
pub enum Answer {
    Choice {
        choice: String,
        /// Probability of each option; sums to 1.
        probabilities: BTreeMap<String, f64>,
        /// The endpoint's 0..1 spread measure — NOT a probability of being
        /// correct.
        confidence: Option<f64>,
        /// The full option object from `pick`, when the question came from one.
        option: Option<Opt>,
        source: Source,
    },
    Score {
        /// Expected level index, weighted by probability; may fall between
        /// two levels.
        score: f64,
        legend: BTreeMap<String, String>,
        probabilities: BTreeMap<String, f64>,
        confidence: Option<f64>,
        source: Source,
    },
    Noul {
        /// The probability that the answer is true. This is all the model
        /// gives; the boolean below is ours.
        noul: f64,
        /// Derived from `noul >= bool_threshold`. The model never said
        /// "true" or "false".
        value: bool,
        bool_threshold: f64,
        source: Source,
    },
}

impl Answer {
    /// The picked key of a `Choice`, else `None`.
    pub fn choice(&self) -> Option<&str> {
        match self {
            Answer::Choice { choice, .. } => Some(choice),
            _ => None,
        }
    }

    /// The derived boolean of a `Noul`, else `None`.
    pub fn value(&self) -> Option<bool> {
        match self {
            Answer::Noul { value, .. } => Some(*value),
            _ => None,
        }
    }

    /// The expected level of a `Score`, else `None`.
    pub fn score(&self) -> Option<f64> {
        match self {
            Answer::Score { score, .. } => Some(*score),
            _ => None,
        }
    }

    /// Probability of the picked option / of true. `None` for a score.
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

    /// Record in the endpoint's own vocabulary, so a trace stays replayable
    /// even if this normalization changes. `source`/`value` are derived, not
    /// data, and are deliberately left out.
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

/// How a run finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// The domain stopped asking questions.
    Done,
    /// Hit `limits.steps`.
    StepLimit,
    /// The transition failed.
    Failed,
    /// A replayed trace no longer matches the domain.
    Drift,
    /// The trace ran out before the domain stopped asking.
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
    /// The domain did something invalid (bad question, bad option list).
    Domain(String),
    /// The endpoint answered, but not usefully.
    Protocol(String),
    /// The decision call itself failed.
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

/// Token accounting across a run. `output_tokens` is always 0 for a decision
/// model — the cost is all prefill.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub requests: u64,
}

/// What one decision request returns.
pub struct Decided {
    pub answers: Value,
    pub usage: Usage,
}

/// The domain contract: state is plain JSON, and three functions drive it.
///
/// `questions` returning an empty map ENDS the run.
pub trait Domain {
    fn name(&self) -> &str;

    fn version(&self) -> Option<&str> {
        None
    }

    fn step_limit(&self) -> usize {
        DEFAULT_STEP_LIMIT
    }

    /// The starting state.
    fn initial(&self, input: &Value) -> Value;

    /// The questions at this state. Empty ends the run.
    fn questions(&self, state: &Value) -> Result<BTreeMap<String, Question>, SwitchError>;

    /// The next state.
    fn transition(
        &self,
        state: &Value,
        answers: &BTreeMap<String, Answer>,
    ) -> Result<Value, SwitchError>;

    /// What the model reads. Defaults to the whole state.
    fn view(&self, state: &Value) -> Value {
        state.clone()
    }
}

/// Anything that can answer a question set — the abstraction that makes
/// replay a swap rather than a special case.
pub trait Decider {
    fn decide(&mut self, state: &Value, questions: &Value) -> Result<Decided, SwitchError>;
}

/// The result of a run or replay.
#[derive(Debug)]
pub struct Outcome {
    pub state: Value,
    pub answers: Option<BTreeMap<String, Answer>>,
    pub trace: Vec<Value>,
    pub steps: usize,
    pub ended: Ended,
    pub usage: Usage,
}

/// Serialize a trace to JSONL.
pub fn format_trace(trace: &[Value]) -> String {
    let mut s = String::new();
    for row in trace {
        s.push_str(&serde_json::to_string(row).unwrap_or_default());
        s.push('\n');
    }
    s
}

/// Parse a JSONL trace, skipping blank lines.
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

/// Canonical JSON with sorted keys, so a recorded question set compares
/// byte-for-byte regardless of map ordering.
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

/// Turn raw endpoint answers into the typed `Answer` enum.
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
                    // Ours, not the model's — hence the explicit threshold.
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

/// How a run gets its answers.
pub enum Mode<'a> {
    /// Live: ask the decider at every step.
    Run(&'a mut dyn Decider),
    /// Replay a trace with no model calls at all.
    Replay(Vec<Value>),
    /// Replay `steps` steps, then go live.
    Fork {
        trace: Vec<Value>,
        steps: usize,
        decider: &'a mut dyn Decider,
    },
}

/// A `Mode` split into the pieces the loop actually drives: the recorded
/// steps, how many of them to replay, a live decider, and a label for the
/// trace's meta row.
type ModeParts<'a> = (Vec<Value>, usize, Option<&'a mut dyn Decider>, String);

/// Run (or replay) a decision loop.
pub fn run_switch(
    domain: &dyn Domain,
    input: &Value,
    mode: Mode<'_>,
    describe: Option<&str>,
    bool_threshold: f64,
) -> Result<Outcome, SwitchError> {
    // Split the mode into (recorded steps, replay-up-to, live decider).
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

    // The starting state: an explicit trace start wins, else domain.initial.
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
        // The contract: no questions means the run is over. The endpoint
        // itself 400s on an empty set, so this must be caught here.
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
            // Re-derive rather than trust: if the domain changed since the
            // trace was written, the recorded answers no longer belong to
            // these questions. Say so instead of answering differently.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A scripted decider: deterministic, counts its calls.
    struct Stub {
        script: Box<dyn FnMut(usize) -> Value>,
        calls: usize,
    }

    impl Decider for Stub {
        fn decide(&mut self, _state: &Value, _questions: &Value) -> Result<Decided, SwitchError> {
            let answers = (self.script)(self.calls);
            self.calls += 1;
            Ok(Decided {
                answers,
                usage: Usage {
                    input_tokens: 10,
                    output_tokens: 0,
                    requests: 1,
                },
            })
        }
    }

    fn stub(f: impl FnMut(usize) -> Value + 'static) -> Stub {
        Stub {
            script: Box::new(f),
            calls: 0,
        }
    }

    /// Reads logs one at a time, then stops — the shape of a triage loop.
    struct Triage {
        instructions: String,
        cap: usize,
    }

    impl Default for Triage {
        fn default() -> Self {
            Triage {
                instructions: "Which?".into(),
                cap: 2,
            }
        }
    }

    impl Domain for Triage {
        fn name(&self) -> &str {
            "triage"
        }
        fn version(&self) -> Option<&str> {
            Some("0.1.0")
        }
        fn step_limit(&self) -> usize {
            6
        }
        fn initial(&self, _input: &Value) -> Value {
            json!({ "seen": 0, "done": false })
        }
        fn questions(&self, state: &Value) -> Result<BTreeMap<String, Question>, SwitchError> {
            let mut q = BTreeMap::new();
            if state["done"].as_bool() == Some(true) {
                return Ok(q);
            }
            q.insert(
                "go".to_string(),
                pick(
                    vec![Opt::bare("more"), Opt::bare("stop")],
                    Some(&self.instructions),
                )?,
            );
            Ok(q)
        }
        fn transition(
            &self,
            state: &Value,
            answers: &BTreeMap<String, Answer>,
        ) -> Result<Value, SwitchError> {
            let seen = state["seen"].as_u64().unwrap_or(0) + 1;
            let stop = answers["go"].choice() == Some("stop") || seen as usize >= self.cap;
            Ok(json!({ "seen": seen, "done": stop }))
        }
    }

    fn choice_answer(c: &str) -> Value {
        json!({ "go": { "type": "choice", "choice": c, "probabilities": { "more": 0.8, "stop": 0.2 }, "confidence": 1.0 } })
    }

    #[test]
    fn pick_builds_criteria_and_sorts_by_priority() {
        let q = pick(
            vec![
                Opt::new("stop", "Stop").priority(-1),
                Opt::new("a", "Read a"),
                Opt::new("urgent", "Urgent").priority(5),
            ],
            Some("Which?"),
        )
        .unwrap();
        let keys: Vec<&String> = q.choices.iter().map(|(k, _)| k).collect();
        assert_eq!(keys, vec!["urgent", "a", "stop"]);
        let wire = q.to_wire();
        assert_eq!(wire["type"], "choice");
        assert_eq!(wire["criteria"]["a"], "Read a");
    }

    #[test]
    fn pick_rejects_empty_missing_key_and_duplicates() {
        assert!(pick(vec![], None).is_err());
        assert!(pick(vec![Opt::bare("")], None).is_err());
        assert!(pick(vec![Opt::bare("a"), Opt::bare("a")], None).is_err());
    }

    #[test]
    fn bool_is_an_alias_for_the_noul_wire_name() {
        assert_eq!(QuestionKind::parse("bool"), Some(QuestionKind::Noul));
        assert_eq!(QuestionKind::parse("boolean"), Some(QuestionKind::Noul));
        assert_eq!(QuestionKind::parse("noul"), Some(QuestionKind::Noul));
        assert_eq!(QuestionKind::parse("freeform"), None);
        assert_eq!(Question::noul("Done?").to_wire()["type"], "noul");
    }

    #[test]
    fn private_options_never_reach_the_wire() {
        let q = pick(vec![Opt::new("a", "A")], None).unwrap();
        assert!(q.options.contains_key("a"));
        let wire = q.to_wire();
        assert!(wire.get("options").is_none());
        assert_eq!(wire["criteria"], json!({ "a": "A" }));
    }

    #[test]
    fn an_empty_question_set_ends_the_run_and_costs_no_request() {
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
        let mut d = stub(|_| json!({}));
        let out = run_switch(&NoQs, &json!({}), Mode::Run(&mut d), None, 0.5).unwrap();
        assert_eq!(out.ended, Ended::Done);
        assert_eq!(out.steps, 0);
        // The endpoint 400s on an empty set, so it must never be asked.
        assert_eq!(out.usage.requests, 0);
    }

    #[test]
    fn steps_until_the_domain_stops_asking_and_accumulates_usage() {
        let mut d = stub(|i| choice_answer(if i < 2 { "more" } else { "stop" }));
        let out = run_switch(
            &Triage { cap: 99, ..Default::default() },
            &json!({}),
            Mode::Run(&mut d),
            None,
            0.5,
        )
        .unwrap();
        assert_eq!(out.ended, Ended::Done);
        assert_eq!(out.steps, 3);
        assert_eq!(
            out.usage,
            Usage {
                input_tokens: 30,
                output_tokens: 0,
                requests: 3
            }
        );
    }

    #[test]
    fn a_runaway_domain_stops_at_the_step_limit() {
        let mut d = stub(|_| choice_answer("more"));
        let out = run_switch(
            &Triage { cap: 9999, ..Default::default() },
            &json!({}),
            Mode::Run(&mut d),
            None,
            0.5,
        )
        .unwrap();
        assert_eq!(out.ended, Ended::StepLimit);
        assert_eq!(out.steps, 6); // Triage::step_limit
    }

    #[test]
    fn a_failing_transition_ends_the_run_as_failed() {
        struct Boom;
        impl Domain for Boom {
            fn name(&self) -> &str {
                "t"
            }
            fn initial(&self, _i: &Value) -> Value {
                json!({})
            }
            fn questions(&self, _s: &Value) -> Result<BTreeMap<String, Question>, SwitchError> {
                let mut q = BTreeMap::new();
                q.insert("go".into(), pick(vec![Opt::bare("a")], None).unwrap());
                Ok(q)
            }
            fn transition(
                &self,
                _s: &Value,
                _a: &BTreeMap<String, Answer>,
            ) -> Result<Value, SwitchError> {
                Err(SwitchError::Domain("boom".into()))
            }
        }
        let mut d = stub(|_| json!({ "go": { "type": "choice", "choice": "a" } }));
        let out = run_switch(&Boom, &json!({}), Mode::Run(&mut d), None, 0.5).unwrap();
        assert_eq!(out.ended, Ended::Failed);
        assert!(out
            .trace
            .iter()
            .any(|r| r["type"] == "error" && r["message"].as_str().unwrap().contains("boom")));
    }

    #[test]
    fn a_missing_answer_is_an_error_not_a_default() {
        let mut d = stub(|_| json!({}));
        let err = run_switch(&Triage::default(), &json!({}), Mode::Run(&mut d), None, 0.5)
            .unwrap_err();
        assert!(err.to_string().contains("no answer for question \"go\""));
    }

    #[test]
    fn noul_keeps_the_raw_probability_and_the_boolean_is_ours() {
        struct Ask;
        impl Domain for Ask {
            fn name(&self) -> &str {
                "t"
            }
            fn initial(&self, _i: &Value) -> Value {
                json!({ "done": false })
            }
            fn questions(&self, s: &Value) -> Result<BTreeMap<String, Question>, SwitchError> {
                let mut q = BTreeMap::new();
                if s["done"].as_bool() == Some(true) {
                    return Ok(q);
                }
                q.insert("ok".into(), Question::noul("Done?"));
                Ok(q)
            }
            fn transition(
                &self,
                _s: &Value,
                _a: &BTreeMap<String, Answer>,
            ) -> Result<Value, SwitchError> {
                Ok(json!({ "done": true }))
            }
        }
        let run = |thr: f64| {
            let mut d = stub(|_| json!({ "ok": { "type": "noul", "noul": 0.42 } }));
            run_switch(&Ask, &json!({}), Mode::Run(&mut d), None, thr).unwrap()
        };
        let a = run(0.5);
        match &a.answers.as_ref().unwrap()["ok"] {
            Answer::Noul { noul, value, .. } => {
                assert_eq!(*noul, 0.42);
                assert!(!*value);
            }
            _ => panic!("expected a noul answer"),
        }
        // Same number, different threshold -> different boolean. The model
        // never said "false"; we decided it did.
        assert_eq!(run(0.4).answers.unwrap()["ok"].value(), Some(true));
    }

    fn record() -> Outcome {
        let mut d = stub(|_| choice_answer("more"));
        run_switch(
            &Triage::default(),
            &json!({}),
            Mode::Run(&mut d),
            Some("systemone:default"),
            0.5,
        )
        .unwrap()
    }

    #[test]
    fn the_trace_is_jsonl_with_meta_steps_and_an_end_row() {
        let out = record();
        let rows = parse_trace(&format_trace(&out.trace)).unwrap();
        assert_eq!(rows[0]["type"], "meta");
        assert_eq!(rows[0]["domain"], "triage");
        assert_eq!(rows[0]["decision_model"], "systemone:default");
        assert_eq!(
            rows.iter().filter(|r| r["type"] == "step").count(),
            out.steps
        );
        assert_eq!(rows.last().unwrap()["type"], "end");
        // Recorded in the endpoint's vocabulary: no derived fields.
        let step0 = rows.iter().find(|r| r["type"] == "step").unwrap();
        assert!(step0["answers"]["go"].get("source").is_none());
        assert_eq!(step0["answers"]["go"]["choice"], "more");
    }

    #[test]
    fn replay_reproduces_the_final_state_with_zero_model_calls() {
        let out = record();
        let again = run_switch(
            &Triage::default(),
            &json!({}),
            Mode::Replay(out.trace.clone()),
            None,
            0.5,
        )
        .unwrap();
        assert_eq!(again.usage.requests, 0);
        assert_eq!(again.state, out.state);
        assert_eq!(again.ended, Ended::Done);
        assert_eq!(
            again.answers.unwrap()["go"].source(),
            Source::Trace
        );
    }

    #[test]
    fn a_changed_domain_is_caught_as_drift() {
        let out = record();
        let drifted = run_switch(
            &Triage {
                instructions: "Reworded question.".into(),
                ..Default::default()
            },
            &json!({}),
            Mode::Replay(out.trace.clone()),
            None,
            0.5,
        )
        .unwrap();
        assert_eq!(drifted.ended, Ended::Drift);
        let row = drifted.trace.iter().find(|r| r["type"] == "drift").unwrap();
        assert_eq!(row["step"], 0);
        assert_eq!(row["expected"]["go"]["instructions"], "Which?");
        assert_eq!(row["actual"]["go"]["instructions"], "Reworded question.");
    }

    #[test]
    fn fork_replays_n_steps_then_goes_back_to_the_model() {
        let out = record();
        assert_eq!(out.steps, 2);
        let mut d = stub(|_| choice_answer("stop"));
        let forked = run_switch(
            &Triage::default(),
            &json!({}),
            Mode::Fork {
                trace: out.trace.clone(),
                steps: 1,
                decider: &mut d,
            },
            None,
            0.5,
        )
        .unwrap();
        let sources: Vec<&str> = forked
            .trace
            .iter()
            .filter(|r| r["type"] == "step")
            .map(|r| r["source"].as_str().unwrap())
            .collect();
        assert_eq!(sources, vec!["trace", "systemone"]);
        assert_eq!(forked.usage.requests, 1);
    }

    #[test]
    fn stable_json_is_key_order_independent() {
        let a: Value = serde_json::from_str(r#"{"b":1,"a":{"d":2,"c":3}}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"a":{"c":3,"d":2},"b":1}"#).unwrap();
        assert_eq!(stable(&a), stable(&b));
    }
}
