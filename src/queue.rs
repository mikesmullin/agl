use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use crate::agent::resolve_concurrency;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub limit: usize,
    pub held: usize,
    pub waiting: usize,
}

#[derive(Default)]
struct QState {
    held: usize,
    waiters: VecDeque<(u64, Waker)>,
    next_ticket: u64,
}

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

    fn wake_all(&self) {
        let st = self.state.lock().unwrap();
        for (_, w) in &st.waiters {
            w.wake_by_ref();
        }
    }
}

pub struct Permit {
    q: Arc<ModelQueue>,
}

impl Permit {
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
        let front = st.waiters.front().map(|(t, _)| *t) == Some(ticket);
        if st.held < limit && front {
            st.held += 1;
            st.waiters.retain(|(t, _)| *t != ticket);
            return Poll::Ready(Permit { q: this.q.clone() });
        }
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

static QUEUES: Mutex<Option<BTreeMap<String, Arc<ModelQueue>>>> = Mutex::new(None);

fn queue_for(spec: &str) -> Arc<ModelQueue> {
    let mut table = QUEUES.lock().unwrap();
    let map = table.get_or_insert_with(BTreeMap::new);
    map.entry(spec.to_string())
        .or_insert_with(|| Arc::new(ModelQueue::new(spec.to_string())))
        .clone()
}

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
    if taken {
        Some(Permit { q })
    } else {
        None
    }
}

pub fn acquire(spec: &str) -> Acquire {
    Acquire {
        q: queue_for(spec),
        ticket: None,
    }
}

pub fn stats(spec: &str) -> Stats {
    let q = queue_for(spec);
    let st = q.state.lock().unwrap();
    Stats {
        limit: resolve_concurrency(spec).max(1),
        held: st.held,
        waiting: st.waiters.len(),
    }
}
