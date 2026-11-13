//! End-to-end check of the streamed inference path against a live
//! OpenAI-compatible endpoint (default: the llama-server on :1234).
//!
//!   cargo run --example stream_smoke
//!
//! Proves three things the unit tests cannot: the request shape is accepted,
//! deltas arrive incrementally rather than in one lump, and the assembled
//! completion matches the text that was streamed.

use agl::provider::{Channel, Endpoint, Generic, InferenceRequest, Message};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base = std::env::var("AGL_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:1234".into());
    let model = std::env::var("AGL_MODEL").unwrap_or_else(|_| "default".into());
    println!("endpoint: {base}\nmodel:    {model}\n");

    let client = Generic::new(Endpoint {
        base_url: base,
        api_key: None,
        ca_file: None,
    })?;

    let req = InferenceRequest {
        model,
        messages: vec![
            Message::system("You are terse."),
            Message::user("Count from 1 to 5, space separated. No other words."),
        ],
        max_tokens: Some(64),
        ..Default::default()
    };

    let mut chunks = 0usize;
    let mut streamed = String::new();
    let started = std::time::Instant::now();
    let mut first_delta_at = None;

    let completion = {
        let mut on_delta = |text: &str, ch: Channel| {
            if first_delta_at.is_none() {
                first_delta_at = Some(started.elapsed());
            }
            chunks += 1;
            if ch == Channel::Content {
                streamed.push_str(text);
            }
            print!("{text}");
            use std::io::Write;
            let _ = std::io::stdout().flush();
        };
        client.inference_stream(&req, &mut on_delta).await?
    };
    println!("\n");

    let assembled = completion.choices[0]
        .message
        .content
        .as_ref()
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    println!("deltas:        {chunks}");
    println!("first delta:   {:?}", first_delta_at.unwrap_or_default());
    println!("total:         {:?}", started.elapsed());
    println!("finish_reason: {:?}", completion.choices[0].finish_reason);
    println!("usage:         {:?}", completion.usage);
    println!("assembled == streamed: {}", assembled == streamed);

    assert!(chunks > 1, "expected incremental deltas, got {chunks}");
    assert_eq!(assembled, streamed, "assembled text must match the stream");
    println!("\nOK");
    Ok(())
}
