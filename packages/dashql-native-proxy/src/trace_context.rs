use once_cell::sync::Lazy;
use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::task_local;
use tracing::Span;
use uuid::Uuid;

#[allow(dead_code)]
pub const TRACE_ID_KEY: &str = "trace_id";
#[allow(dead_code)]
pub const SPAN_ID_KEY: &str = "span_id";
#[allow(dead_code)]
pub const PARENT_SPAN_ID_KEY: &str = "parent_span_id";

/// The tracing identifiers attached to a proxied operation
#[derive(Clone, Debug)]
pub struct TraceContext {
    /// The id of the trace, a random UUID for new traces
    pub trace_id: String,
    /// The id of the current span
    pub span_id: String,
    /// The id of the parent span, `None` for a root span
    pub parent_span_id: Option<String>,
}

#[allow(dead_code)]
static NEXT_SPAN_ID: Lazy<AtomicU64> = Lazy::new(|| AtomicU64::new(1));

task_local! {
    static TRACE_CONTEXT: TraceContext;
}

// Thread-local storage for accessing trace context from synchronous code
thread_local! {
    static THREAD_TRACE_CONTEXT: RefCell<Option<TraceContext>> = RefCell::new(None);
}

impl TraceContext {
    #[allow(dead_code)]
    pub fn new_trace() -> Self {
        Self {
            trace_id: Uuid::new_v4().to_string(),
            span_id: NEXT_SPAN_ID.fetch_add(1, Ordering::SeqCst).to_string(),
            parent_span_id: None,
        }
    }

    #[allow(dead_code)]
    pub fn from_headers(
        trace_id: String,
        span_id: String,
        parent_span_id: Option<String>,
    ) -> Self {
        Self {
            trace_id,
            span_id,
            parent_span_id,
        }
    }

    #[allow(dead_code)]
    pub fn create_span(&self, name: &str) -> Span {
        tracing::span!(
            tracing::Level::INFO,
            "traced_operation",
            name = name,
            trace_id = %self.trace_id,
            span_id = %self.span_id,
            parent_span_id = self.parent_span_id.as_deref().unwrap_or("")
        )
    }

    /// Return trace context fields for callers that use the `log` crate.
    /// Returns (trace_id, span_id, parent_span_id) for manual KV addition
    #[allow(dead_code)]
    pub fn trace_fields(&self) -> (&str, &str, &str) {
        (
            &self.trace_id,
            &self.span_id,
            self.parent_span_id.as_deref().unwrap_or(""),
        )
    }
}

#[allow(dead_code)]
pub async fn enter_trace_context<F, Fut, R>(ctx: TraceContext, f: F) -> R
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = R>,
{
    let span = ctx.create_span("traced_operation");

    // Store in thread-local storage
    THREAD_TRACE_CONTEXT.with(|tls| {
        *tls.borrow_mut() = Some(ctx.clone());
    });

    let result = TRACE_CONTEXT.scope(ctx, span.in_scope(|| f())).await;

    // Clear thread-local storage
    THREAD_TRACE_CONTEXT.with(|tls| {
        *tls.borrow_mut() = None;
    });

    result
}

#[allow(dead_code)]
pub fn current_trace_context() -> Option<TraceContext> {
    // Try task_local first (for async contexts)
    if let Ok(ctx) = TRACE_CONTEXT.try_with(|ctx| ctx.clone()) {
        return Some(ctx);
    }

    // Fall back to thread_local (for sync contexts)
    THREAD_TRACE_CONTEXT.with(|tls| tls.borrow().clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_trace_generates_uuid_trace_id() {
        let ctx = TraceContext::new_trace();

        // UUID v4 format: 8-4-4-4-12 hex digits
        assert_eq!(ctx.trace_id.len(), 36);
        assert!(ctx.trace_id.contains('-'));
        assert!(ctx.parent_span_id.is_none());
    }

    #[test]
    fn test_span_ids_increment() {
        let ctx1 = TraceContext::new_trace();
        let ctx2 = TraceContext::new_trace();

        let span1: u64 = ctx1.span_id.parse().unwrap();
        let span2: u64 = ctx2.span_id.parse().unwrap();

        assert!(span2 > span1, "Span IDs should increment");
    }

    #[test]
    fn test_from_headers() {
        let trace_id = "test-trace-123".to_string();
        let span_id = "456".to_string();
        let parent_span_id = Some("789".to_string());

        let ctx = TraceContext::from_headers(
            trace_id.clone(),
            span_id.clone(),
            parent_span_id.clone(),
        );

        assert_eq!(ctx.trace_id, trace_id);
        assert_eq!(ctx.span_id, span_id);
        assert_eq!(ctx.parent_span_id, parent_span_id);
    }

    #[test]
    fn test_trace_fields() {
        let ctx = TraceContext::from_headers(
            "trace-abc".to_string(),
            "123".to_string(),
            Some("456".to_string()),
        );

        let (trace_id, span_id, parent_span_id) = ctx.trace_fields();

        assert_eq!(trace_id, "trace-abc");
        assert_eq!(span_id, "123");
        assert_eq!(parent_span_id, "456");
    }

    #[test]
    fn test_trace_fields_no_parent() {
        let ctx = TraceContext::from_headers(
            "trace-xyz".to_string(),
            "999".to_string(),
            None,
        );

        let (trace_id, span_id, parent_span_id) = ctx.trace_fields();

        assert_eq!(trace_id, "trace-xyz");
        assert_eq!(span_id, "999");
        assert_eq!(parent_span_id, ""); // Empty string when no parent
    }

    #[test]
    fn test_create_span() {
        let ctx = TraceContext::new_trace();
        let span = ctx.create_span("test_operation");

        // Verify span is created (doesn't panic)
        // Note: span may be disabled if no tracing subscriber is set up
        drop(span); // Just verify it was created successfully
    }

    #[tokio::test]
    async fn test_task_local_isolation() {
        let ctx1 = TraceContext::from_headers("trace-1".to_string(), "1".to_string(), None);
        let ctx2 = TraceContext::from_headers("trace-2".to_string(), "2".to_string(), None);

        let handle1 = tokio::spawn(async move {
            enter_trace_context(ctx1.clone(), || async {
                let current = current_trace_context();
                assert!(current.is_some());
                assert_eq!(current.unwrap().trace_id, "trace-1");
            }).await
        });

        let handle2 = tokio::spawn(async move {
            enter_trace_context(ctx2.clone(), || async {
                let current = current_trace_context();
                assert!(current.is_some());
                assert_eq!(current.unwrap().trace_id, "trace-2");
            }).await
        });

        handle1.await.unwrap();
        handle2.await.unwrap();
    }
}
