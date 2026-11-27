use std::collections::BTreeMap;

use agl::agent::{Agent, Factory};
use agl::switch::{
    format_trace, pick, Answer, Domain, Ended, Opt, Question, SwitchError,
};
use serde_json::{json, Value};

const LOGS: [(&str, &str); 3] = [
    ("app.log", "POST /pay 402 gateway_declined card=**** retry=0"),
    ("db.log", "tx 9912 rollback: constraint payments_idempotency_key"),
    ("gateway.log", "issuer response 51: insufficient funds"),
];

struct Triage {
    instructions: String,
}

impl Triage {
    fn unread(state: &Value) -> Vec<&'static str> {
        let read: Vec<&str> = state["read"]
            .as_array()
            .map(|a| a.iter().filter_map(|r| r["log"].as_str()).collect())
            .unwrap_or_default();
        LOGS.iter()
            .map(|(l, _)| *l)
            .filter(|l| !read.contains(l))
            .collect()
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
        8
    }

    fn initial(&self, input: &Value) -> Value {
        json!({ "ticket": input["ticket"], "read": [], "team": Value::Null })
    }

    fn questions(&self, state: &Value) -> Result<BTreeMap<String, Question>, SwitchError> {
        let mut q = BTreeMap::new();
        if !state["team"].is_null() {
            return Ok(q);
        }
        q.insert(
            "enough".to_string(),
            Question::noul("Is there enough evidence to assign a team?"),
        );
        let unread = Self::unread(state);
        if !unread.is_empty() {
            let mut opts: Vec<Opt> = unread
                .iter()
                .map(|l| Opt::new(*l, format!("Read {l}")))
                .collect();
            opts.push(Opt::new("stop", "Stop: enough evidence already").priority(-1));
            q.insert("next".to_string(), pick(opts, Some(&self.instructions))?);
        }
        q.insert(
            "team".to_string(),
            Question::choice(
                "Which team should own this ticket?",
                vec![
                    ("billing", Some("Billing and payments")),
                    ("infra", Some("Infrastructure")),
                    ("app", Some("Application code")),
                ],
            ),
        );
        q.insert(
            "urgency".to_string(),
            Question::score(
                "How urgent is this?",
                vec!["can wait", "this week", "today", "right now"],
            ),
        );
        Ok(q)
    }

    fn transition(
        &self,
        state: &Value,
        answers: &BTreeMap<String, Answer>,
    ) -> Result<Value, SwitchError> {
        let next = answers.get("next");
        let stop = next.is_none()
            || next.and_then(|a| a.choice()) == Some("stop")
            || answers["enough"].value() == Some(true);

        let mut s = state.clone();
        if stop {
            s["team"] = json!(answers["team"].choice().unwrap_or("app"));
            s["urgency"] = json!(answers["urgency"].score().unwrap_or(0.0));
            return Ok(s);
        }
        let log = next.and_then(|a| a.choice()).unwrap_or_default().to_string();
        let text = LOGS
            .iter()
            .find(|(l, _)| *l == log)
            .map(|(_, t)| *t)
            .unwrap_or("");
        s["read"]
            .as_array_mut()
            .ok_or_else(|| SwitchError::Domain("read is not an array".into()))?
            .push(json!({ "log": log, "text": text }));
        Ok(s)
    }

    fn view(&self, state: &Value) -> Value {
        json!({ "ticket": state["ticket"], "read": state["read"] })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let agent = Agent::factory(Factory {
        model: Some("llama-server:default".into()),
        decision_model: Some("systemone:default".into()),
        ..Default::default()
    })?;
    println!(
        "bound decision model: {} @ {}",
        agent.decision_spec.as_deref().unwrap_or("-"),
        agent.decision_base_url().unwrap_or("-")
    );

    let domain = Triage {
        instructions: "Which log should be read next?".into(),
    };
    let input = json!({
        "ticket": "Customer card was declined at checkout and they were charged twice."
    });

    let handle = tokio::runtime::Handle::current();
    let t0 = std::time::Instant::now();
    let out = tokio::task::spawn_blocking({
        let h = handle.clone();
        move || {
            let a = Agent::factory(Factory {
                model: Some("llama-server:default".into()),
                decision_model: Some("systemone:default".into()),
                ..Default::default()
            })?;
            let d = Triage {
                instructions: "Which log should be read next?".into(),
            };
            a.switch(&d, &input, h)
        }
    })
    .await??;

    println!(
        "\nended={} steps={} in {}ms",
        out.ended.as_str(),
        out.steps,
        t0.elapsed().as_millis()
    );
    println!(
        "usage: input_tokens={} output_tokens={} requests={}",
        out.usage.input_tokens, out.usage.output_tokens, out.usage.requests
    );
    println!("final state: {}", serde_json::to_string_pretty(&out.state)?);

    if let Some(answers) = &out.answers {
        println!("\nlast answers:");
        for (id, a) in answers {
            match a {
                Answer::Choice {
                    choice,
                    probabilities,
                    confidence,
                    source,
                    ..
                } => println!(
                    "  {id}: choice={choice} p={:.4} confidence={:.4} source={}",
                    probabilities.get(choice).copied().unwrap_or(0.0),
                    confidence.unwrap_or(0.0),
                    source.as_str()
                ),
                Answer::Score { score, source, .. } => {
                    println!("  {id}: score={score:.4} source={}", source.as_str())
                }
                Answer::Noul {
                    noul, value, source, ..
                } => println!(
                    "  {id}: noul={noul:.4} value={value} source={}",
                    source.as_str()
                ),
            }
        }
    }

    let jsonl = format_trace(&out.trace);
    let replayed = agent.replay(&domain, &jsonl)?;
    println!(
        "\nreplay      : ended={} steps={} requests={}",
        replayed.ended.as_str(),
        replayed.steps,
        replayed.usage.requests
    );
    println!(
        "determinism : state identical to the live run? {}",
        replayed.state == out.state
    );

    let changed = Triage {
        instructions: "Pick a different log, reworded.".into(),
    };
    let drifted = agent.replay(&changed, &jsonl)?;
    let at = drifted
        .trace
        .iter()
        .find(|r| r["type"] == "drift")
        .map(|r| r["step"].to_string())
        .unwrap_or_else(|| "-".into());
    println!(
        "drift       : ended={} (detected at step {at})",
        drifted.ended.as_str()
    );
    assert_eq!(drifted.ended, Ended::Drift);

    Ok(())
}
