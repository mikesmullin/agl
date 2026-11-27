use agl::agent::{Agent, Factory};

async fn ask(a: &Agent, q: &str) -> String {
    a.run(q).await.expect("run")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let model = std::env::var("AGL_MODEL").unwrap_or_else(|_| "llama-server:default".into());

    let keeper = Agent::factory(Factory {
        model: Some(model.clone()),
        system_prompt: Some("Answer in as few words as possible.".into()),
        retain_history: Some(true),
        max_tokens: Some(64),
        ..Default::default()
    })?;

    let t1 = ask(&keeper, "My favourite colour is chartreuse. Reply with just: ok").await;
    println!("turn 1: {t1}");
    let t2 = ask(&keeper, "What is my favourite colour? One word.").await;
    println!("turn 2: {t2}");
    println!("context rows: {}", keeper.context_len());

    let remembered = t2.to_lowercase().contains("chartreuse");
    println!("remembered: {remembered}");

    let forgetful = Agent::factory(Factory {
        model: Some(model),
        system_prompt: Some("Answer in as few words as possible.".into()),
        retain_history: Some(false),
        max_tokens: Some(64),
        ..Default::default()
    })?;
    let _ = ask(&forgetful, "My favourite colour is chartreuse. Reply with just: ok").await;
    let f2 = ask(&forgetful, "What is my favourite colour? One word.").await;
    println!("\none-shot turn 2: {f2}");
    println!("one-shot context rows: {}", forgetful.context_len());

    assert!(remembered, "retained agent forgot the fact: {t2:?}");
    assert_eq!(forgetful.context_len(), 0, "one-shot agent retained rows");
    assert!(
        !f2.to_lowercase().contains("chartreuse"),
        "one-shot agent leaked context: {f2:?}"
    );
    println!("\nOK — retained remembers, one-shot does not.");
    Ok(())
}
