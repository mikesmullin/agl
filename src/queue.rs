//! Turn queue — the global per-model concurrency limit.
//!
//! Why this exists: local models (`llama-server` on `127.0.0.1:1234`) serve
//! one inference request at a time, so several users chatting can melt a
//! machine that is also trying to be the only inference backend. Every
//! agent-directed turn therefore waits for a free slot of its resolved
//! `provider:model` before it starts, and holds it until the turn ends
//! (final answer, failure, or cancellation).
//!
//! The limit is `concurrency` in the user config — the same
//! `provider -> model id -> n` shape as `context_windows`, re-read from disk
//! on every acquisition so an edit takes effect without a restart:
//!
//! ```yaml
//! concurrency:
//!   llama-server:
//!     default: 1
//!   openai:
//!     default: 4
//! ```
//!
//! Absent config means 1 (serial) — the conservative default, because the
//! expensive mistake is over-parallelising a local model, never under.
//!
//! Fairness is FIFO: a turn that has been waiting longest gets the next
//! free slot, and a newcomer can never barge past it. A cancelled waiter
//! leaves the queue immediately (its future is dropped), so Stop works
//! while queued as well as while running.
//!
//! The queue is keyed by the bound spec (`provider:model`), so two models on
//! the same endpoint still queue independently unless their specs match.

use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use crate::agent::resolve_concurrency;

/// Live counters for one model's queue. Cheap to read; the UI shows
/// "waiting for a slot" from this.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    /// Current limit from the user config.
    pub limit: usize,
    /// Turns holding a slot right now.
    pub held: usize,
    /// Turns waiting for a slot.
    pub waiting: usize,
}

#[derive(Default)]
struct QState {
    held: usize,
    waiters: VecDeque<(u64, Waker)>,
    next_ticket: u64,
}

/// One model's queue. The limit lives outside the state — it is re-read
/// from the config on every attempt, never cached here.
struct ModelQueue {
    spec: String,
    state: Mutex<QState>,
}

impl ModelQueue {
    fn new(spec: String) -> Self {
        ModelQueue {
            spec,
            state: Mutex::new(QState::default()),
        }
    }

    /// Wake every waiter; the FIFO gate in `poll` decides who may take the
    /// slot, so a herd here is harmless at the scales this runs at and
    /// avoids the subtle "front waiter was cancelled, next one sleeps
    /// forever" bug of wake-one.
    fn wake_all(&self) {
        let st = self.state.lock().unwrap();
        for (_, w) in &st.waiters {
            w.wake_by_ref();
        }
    }
}

/// A held slot. Dropping it (turn over, failed, or cancelled) frees the
/// slot and wakes the queue.
pub struct Permit {
    q: Arc<ModelQueue>,
}

impl Permit {
    /// The `provider:model` this slot is accounted under.
    pub fn spec(&self) -> &str {
        &self.q.spec
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        {
            let mut st = self.q.state.lock().unwrap();
            st.held = st.held.saturating_sub(1);
        }
        self.q.wake_all();
    }
}

/// Future resolving to a [`Permit`] once a slot is free.
pub struct Acquire {
    q: Arc<ModelQueue>,
    ticket: Option<u64>,
}

impl Future for Acquire {
    type Output = Permit;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Permit> {
        let this = self.get_mut();
        let mut st = this.q.state.lock().unwrap();
        let limit = resolve_concurrency(&this.q.spec).max(1);
        let ticket = *this.ticket.get_or_insert_with(|| {
            let t = st.next_ticket;
            st.next_ticket += 1;
            st.waiters.push_back((t, cx.waker().clone()));
            t
        });
        // FIFO: only the front of the line may take a free slot, so a fresh
        // arrival can never barge past a sleeper when the limit is raised.
        let front = st.waiters.front().map(|(t, _)| *t) == Some(ticket);
        if st.held < limit && front {
            st.held += 1;
            st.waiters.retain(|(t, _)| *t != ticket);
            return Poll::Ready(Permit { q: this.q.clone() });
        }
        // Still waiting: keep the waker current (the queue moved under us).
        for (t, w) in st.waiters.iter_mut() {
            if *t == ticket {
                if !w.will_wake(cx.waker()) {
                    *w = cx.waker().clone();
                }
                break;
            }
        }
        Poll::Pending
    }
}

impl Drop for Acquire {
    /// Cancelled while queued (Stop pressed before the turn started): leave
    /// the line and wake the next, in case the slot the cancel freed was
    /// the one everyone is waiting on.
    fn drop(&mut self) {
        if let Some(ticket) = self.ticket {
            let wake = {
                let mut st = self.q.state.lock().unwrap();
                let was_front = st.waiters.front().map(|(t, _)| *t) == Some(ticket);
                st.waiters.retain(|(t, _)| *t != ticket);
                was_front
            };
            if wake {
                self.q.wake_all();
            }
        }
    }
}

/// Per-spec queues, process-global: everything through agl shares one table.
static QUEUES: Mutex<Option<BTreeMap<String, Arc<ModelQueue>>>> = Mutex::new(None);

fn queue_for(spec: &str) -> Arc<ModelQueue> {
    let mut table = QUEUES.lock().unwrap();
    let map = table.get_or_insert_with(BTreeMap::new);
    map.entry(spec.to_string())
        .or_insert_with(|| Arc::new(ModelQueue::new(spec.to_string())))
        .clone()
}

/// Take the slot for `spec` **now**, or not at all — the atomic half of
/// starting a turn.
///
/// A caller that decides "this turn may start" and *then* waits for a slot
/// in the ordinary queue has left a window between the two decisions: two
/// starters can both see a free slot and both begin. [`try_acquire`] closes
/// it: the take is one critical section with the start decision that
/// precedes it (the caller holds its own start lock across the call), so a
/// taken slot is owned before anything else may observe the turn as
/// started. Refuses when a slot is not free **or** anybody is already
/// queued — a queued waiter has waited longer and keeps its FIFO place.
pub fn try_acquire(spec: &str) -> Option<Permit> {
    let q = queue_for(spec);
    let taken = {
        let mut st = q.state.lock().unwrap();
        let limit = resolve_concurrency(spec).max(1);
        if st.held < limit && st.waiters.is_empty() {
            st.held += 1;
            true
        } else {
            false
        }
    };
    // `then_some` would build the permit either way — and dropping the
    // refused one would release a slot somebody else holds. Build it only
    // on the take.
    if taken {
        Some(Permit { q })
    } else {
        None
    }
}

/// Wait for a turn slot on `spec` (`provider:model`). The returned future
/// resolves to a [`Permit`] held until dropped.
pub fn acquire(spec: &str) -> Acquire {
    Acquire {
        q: queue_for(spec),
        ticket: None,
    }
}

/// Current counters for `spec`, without taking a slot.
pub fn stats(spec: &str) -> Stats {
    let q = queue_for(spec);
    let st = q.state.lock().unwrap();
    Stats {
        limit: resolve_concurrency(spec).max(1),
        held: st.held,
        waiting: st.waiters.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;
    use std::time::Duration;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
    }

    // Each test uses its own spec: the registry is process-global and the
    // tests run in parallel. The limit defaults to 1 with no config, which
    // is exactly what these tests want.

    #[test]
    fn try_acquire_takes_now_or_not_at_all() {
        // Free: taken on the spot, held counted.
        let p = try_acquire("qtest-try:m").expect("free slot");
        assert_eq!(p.spec(), "qtest-try:m");
        assert_eq!(stats("qtest-try:m").held, 1);
        // Held: refused — no queue, no partial take, and above all no
        // release of the slot somebody else is holding.
        assert!(try_acquire("qtest-try:m").is_none());
        assert_eq!(stats("qtest-try:m").held, 1, "the refusal must not steal the slot");
        // Dropped: the slot is free again.
        drop(p);
        assert!(try_acquire("qtest-try:m").is_some());
    }

    #[test]
    fn try_acquire_never_barges_past_a_waiter() {
        rt().block_on(async {
            let _p = try_acquire("qtest-barge:m").expect("free slot");
            let mut t = tokio::spawn(async { acquire("qtest-barge:m").await });
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert_eq!(stats("qtest-barge:m").waiting, 1);
            // The slot is taken, and even were it free, the waiter is first.
            assert!(try_acquire("qtest-barge:m").is_none());
            drop(_p);
            t.abort();
        });
    }

    #[test]
    fn a_second_turn_waits_until_the_first_releases() {
        rt().block_on(async {
            let p1 = acquire("qtest-wait:m").await;
            assert_eq!(stats("qtest-wait:m"), Stats { limit: 1, held: 1, waiting: 0 });

            let mut t = tokio::spawn(async { acquire("qtest-wait:m").await });
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert_eq!(stats("qtest-wait:m").waiting, 1);
            // Not resolved while the slot is held.
            assert!(tokio::time::timeout(Duration::from_millis(30), &mut t).await.is_err());

            drop(p1);
            let p2 = tokio::time::timeout(Duration::from_secs(2), t)
                .await
                .expect("second turn must acquire after release")
                .unwrap();
            assert_eq!(stats("qtest-wait:m"), Stats { limit: 1, held: 1, waiting: 0 });
            drop(p2);
            assert_eq!(stats("qtest-wait:m"), Stats { limit: 1, held: 0, waiting: 0 });
        });
    }

    #[test]
    fn slots_are_granted_fifo_and_nobody_barges_the_line() {
        rt().block_on(async {
            let p1 = acquire("qtest-fifo:m").await;
            // a2 queues first — it owns the front of the line.
            let mut a2 = Box::pin(acquire("qtest-fifo:m"));
            assert!(a2.as_mut().now_or_never().is_none());
            drop(p1);

            // A newcomer arriving after the slot freed must not barge past
            // the sleeping a2.
            let mut a3 = Box::pin(acquire("qtest-fifo:m"));
            assert!(a3.as_mut().now_or_never().is_none(), "newcomer barged the queue");
            assert_eq!(stats("qtest-fifo:m").waiting, 2);

            let p2 = a2.await; // front of the line gets it
            assert_eq!(stats("qtest-fifo:m").held, 1);
            assert!(a3.as_mut().now_or_never().is_none());
            drop(p2);
            let _p3 = a3.await;
            assert_eq!(stats("qtest-fifo:m").held, 1);
        });
    }

    #[test]
    fn a_cancelled_waiter_leaves_the_line_and_the_next_still_runs() {
        rt().block_on(async {
            let p1 = acquire("qtest-cancel:m").await;
            let mut a2 = Box::pin(acquire("qtest-cancel:m"));
            assert!(a2.as_mut().now_or_never().is_none());
            let mut a3 = Box::pin(acquire("qtest-cancel:m"));
            assert!(a3.as_mut().now_or_never().is_none());
            assert_eq!(stats("qtest-cancel:m").waiting, 2);

            drop(a2); // Stop pressed while queued
            assert_eq!(stats("qtest-cancel:m").waiting, 1);

            drop(p1);
            let _p3 = a3.await; // the line moved up; no lost wakeup
            assert_eq!(stats("qtest-cancel:m").held, 1);
        });
    }
}
