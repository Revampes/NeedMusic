use std::sync::atomic::{AtomicUsize, Ordering};

/// Concurrency control mechanism to limit simultaneous heavy operations.
/// Uses a simple atomic counter as a semaphore (no async runtime needed for
/// synchronous file I/O operations).
pub struct ConcurrencyGate {
    pub max_concurrent: usize,
    active: AtomicUsize,
}

impl ConcurrencyGate {
    /// Creates a new gate with the specified maximum concurrent operations.
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            max_concurrent,
            active: AtomicUsize::new(0),
        }
    }

    /// Blocks until a permit is available, then returns a guard that
    /// releases the permit on drop.
    pub fn acquire(&self) -> Permit<'_> {
        loop {
            let current = self.active.load(Ordering::SeqCst);
            if current < self.max_concurrent {
                if self
                    .active
                    .compare_exchange(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    return Permit { gate: self };
                }
            }
            // Simple spin-wait; in production, consider std::thread::yield_now()
            std::hint::spin_loop();
        }
    }

    /// Release one permit.
    fn release(&self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

/// RAII guard that releases a concurrency permit on drop.
pub struct Permit<'a> {
    gate: &'a ConcurrencyGate,
}

impl<'a> Drop for Permit<'a> {
    fn drop(&mut self) {
        self.gate.release();
    }
}
