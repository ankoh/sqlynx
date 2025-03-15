use hyper::header::{HeaderValue, HeaderMap};
use std::collections::HashMap;
use std::fmt;
use std::fmt::Display;
use std::sync::Arc;
use std::sync::RwLock;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::status::Status;

#[derive(Debug)]
pub enum HttpError {
    ErrorStatus(reqwest::StatusCode),
    ConnectError(String),
    OtherError(String),
}

impl Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match &self {
            HttpError::ErrorStatus(status) => {
                write!(f, "{}", &status)
            }
            HttpError::ConnectError(e) => {
                write!(f, "{}", e)
            }
            HttpError::OtherError(e) => {
                write!(f, "{}", e)
            },
        }
    }
}

impl From<&reqwest::Error> for HttpError {
    fn from(e: &reqwest::Error) -> HttpError {
        // Is a status?
        if let Some(s) = e.status() {
            return HttpError::ErrorStatus(s);
        }

        // Inpack inner error
        let mut inner: &dyn std::error::Error = &e;
        while let Some(i) = inner.source() {
            inner = i;
        }

        if e.is_connect() {
            return HttpError::ConnectError(inner.to_string());
        } else {
            return HttpError::OtherError(e.to_string());
        }
    }
}

#[derive(Debug)]
pub enum HttpServerStreamEvent {
    RequestFailed(HttpError),
    Header(reqwest::StatusCode, HeaderMap<HeaderValue>),
    BodyChunk(Vec<u8>),
    BodyEnd,
    BodyReadFailed(String),
}

#[derive(Debug, PartialEq)]
pub enum HttpServerStreamBatchEvent {
    StreamFailed,
    StreamFinished,
    FlushAfterClose,
    FlushAfterTimeout,
    FlushAfterBytes,
}

impl HttpServerStreamBatchEvent {
    pub fn to_str(&self) -> &'static str {
        match self {
            HttpServerStreamBatchEvent::StreamFailed => "StreamFailed",
            HttpServerStreamBatchEvent::StreamFinished => "StreamFinished",
            HttpServerStreamBatchEvent::FlushAfterClose => "FlushAfterClose",
            HttpServerStreamBatchEvent::FlushAfterTimeout => "FlushAfterTimeout",
            HttpServerStreamBatchEvent::FlushAfterBytes => "FlushAfterBytes",
        }
    }
}

#[derive(Debug)]
pub struct HttpServerStreamBatch {
    /// The event that emitted the batch
    pub event: HttpServerStreamBatchEvent,
    /// The status
    pub status: Option<reqwest::StatusCode>,
    /// The headers
    pub headers: HeaderMap<HeaderValue>,
    /// The body chunks
    pub body_chunks: Vec<Vec<u8>>,
    /// The total body bytes in the batch
    pub total_body_bytes: usize,
}

impl Default for HttpServerStreamBatch {
    fn default() -> Self {
        Self {
            event: HttpServerStreamBatchEvent::StreamFailed,
            status: None,
            headers: HeaderMap::new(),
            body_chunks: Vec::default(),
            total_body_bytes: 0,
        }
    }
}

pub struct HttpServerStream {
    /// The response queue
    response_sender: tokio::sync::mpsc::Sender<HttpServerStreamEvent>,
    /// The response queue reading
    response_receiver: Mutex<tokio::sync::mpsc::Receiver<HttpServerStreamEvent>>,
}

#[derive(Default)]
pub struct HttpStreamManager {
    /// The next message id
    pub next_stream_id: AtomicUsize,
    /// The server streams
    pub server_streams: RwLock<HashMap<usize, Arc<HttpServerStream>>>,
}

impl HttpStreamManager {
    /// Start a server stream
    #[allow(dead_code)]
    pub fn start_server_stream(
        self: &Arc<Self>,
        client: reqwest::Client,
        request: reqwest::Request,
    ) -> Result<usize, Status> {

        // Allocate an identifier for the stream
        let reg = self.clone();
        let stream_id = reg
            .next_stream_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        // Register the receiver
        const STREAM_CAPACITY: usize = 10;
        let (sender, receiver) = tokio::sync::mpsc::channel(STREAM_CAPACITY);
        let stream_entry = Arc::new(HttpServerStream {
            response_sender: sender,
            response_receiver: Mutex::new(receiver),
        });
        if let Ok(mut streams) = self.server_streams.write() {
            streams.insert(stream_id, stream_entry.clone());
        }

        // Spawn the async reader
        tokio::spawn(async move {
            // Execute a request
            let mut response = match client.execute(request).await {
                Ok(response) => response,
                Err(e) => {
                    let mapped = HttpError::from(&e);
                    let queue_error = stream_entry
                        .response_sender
                        .send(HttpServerStreamEvent::RequestFailed(mapped))
                        .await;
                    if let Err(e) = queue_error {
                        log::warn!("forwarding request error failed: {}", e);
                        return;
                    }
                    return;
                }
            };

            // Send the header
            if let Err(e) = stream_entry
                .response_sender
                .send(HttpServerStreamEvent::Header(response.status(), std::mem::take(response.headers_mut())))
                .await
            {
                log::warn!("writing header resonse to stream failed with error: {}", e);
                return;
            }

            // Poll the result stream
            let mut stream_alive = true;
            while stream_alive {
                // Read the next message from the body stream
                let response = match response.chunk().await {
                    // Received bytes, forward the message as-is to receivers
                    Ok(Some(m)) => {
                        let buffer: Vec<u8> = m.into();
                        log::debug!(
                            "received chunk from server stream {}, bytes={}",
                            stream_id,
                            buffer.len()
                        );
                        HttpServerStreamEvent::BodyChunk(buffer)
                    }
                    // Stream was closed, delete stream and return trailers
                    Ok(None) => {
                        stream_alive = false;
                        log::debug!("reached end of server stream {}", stream_id);
                        HttpServerStreamEvent::BodyEnd
                    }
                    // Stream failed, send error to receivers and close the stream
                    Err(e) => {
                        stream_alive = false;
                        log::warn!("reading from server stream failed with error: {}", e);
                        HttpServerStreamEvent::BodyReadFailed(e.to_string())
                    }
                };

                // Push the response into the queue
                if let Err(e) = stream_entry
                    .response_sender
                    .send(response)
                    .await
                {
                    stream_alive = false;
                    log::warn!("writing resonse to stream failed with error: {}", e);
                }
            }
        });

        // Return initial metadata
        Ok(stream_id)
    }

    /// Read from a server stream
    #[allow(dead_code)]
    pub async fn read_server_stream(
        self: &Arc<Self>,
        stream_id: usize,
        timeout_read_after: Duration,
        flush_batch_after: Duration,
        flush_batch_bytes: usize,
    ) -> Result<HttpServerStreamBatch, Status> {
        let started_at = Instant::now();

        // Try to find the stream.
        // If there is none, the request might have finished already.
        let reg = self.clone();
        let stream = if let Some(streams) = reg.server_streams.read().unwrap().get(&stream_id) {
            streams.clone()
        } else {
            log::debug!("unknown stream id: {}", stream_id);
            return Err(Status::HttpStreamIsUnknown { stream_id });
        };

        // Acquire the receiver lock.
        // There can only be one active reader at a time.
        let mut receiver = stream.response_receiver.lock().await;

        // Receive messages and return them in batches
        let mut batch = HttpServerStreamBatch::default();
        loop {
            // Receive the next message from the reader
            let elapsed_since_start = started_at.elapsed();
            let response = if batch.body_chunks.len() == 0 {
                // Initially, we check the `timeout_read_after` timeout.
                let receive_timeout = timeout_read_after.checked_sub(elapsed_since_start).unwrap_or_default();
                match timeout(receive_timeout, receiver.recv()).await {
                    Ok(Some(response)) =>  {
                        log::debug!("http stream {} received event", stream_id);
                        response
                    },
                    Ok(None) => {
                        log::debug!("http stream {} closed", stream_id);
                        return Err(Status::HttpStreamClosed { stream_id });
                    },
                    Err(_) => {
                        log::debug!("http stream {} read timed out", stream_id);
                        return Err(Status::HttpStreamReadTimedOut { stream_id });
                    }
                }
            } else {
                // After receiving one batch, we check the `flush_batch_after` timeout.
                let receive_timeout = match flush_batch_after.checked_sub(elapsed_since_start) {
                    Some(timeout) => {
                        timeout
                    },
                    None => {
                        batch.event = HttpServerStreamBatchEvent::FlushAfterTimeout;
                        return Ok(batch);
                    }
                };
                match timeout(receive_timeout, receiver.recv()).await {
                    Ok(Some(response)) => {
                        log::debug!("http stream {} returned event", stream_id);
                        response
                    },
                    Ok(None) => {
                        log::debug!("http stream {} closed", stream_id);
                        batch.event = HttpServerStreamBatchEvent::FlushAfterClose;
                        return Ok(batch);
                    },
                    Err(_) => {
                        log::debug!("http stream {} read timed out", stream_id);
                        batch.event = HttpServerStreamBatchEvent::FlushAfterTimeout;
                        return Ok(batch);
                    }
                }
            };

            match response {
                // Request failed?
                HttpServerStreamEvent::RequestFailed(e) => {
                    log::debug!("http stream {} request failed with error: {}", stream_id, e);
                    if let Ok(mut streams) = self.server_streams.write() {
                        streams.remove(&stream_id);
                    }
                    return Err(Status::HttpRequestFailed { stream_id, error: e.to_string() });
                }
                // Received headers
                HttpServerStreamEvent::Header(status, headers) => {
                    log::debug!("http stream {} received header", stream_id);
                    batch.status = Some(status);
                    batch.headers = headers;
                },
                // Return the message
                HttpServerStreamEvent::BodyChunk(m) => {
                    log::debug!("http stream {} received body chunk", stream_id);
                    // Add the message to the current batch and check if we should flush
                    batch.total_body_bytes += m.len();
                    batch.body_chunks.push(m);

                    // Flush if we hit the message size
                    if batch.total_body_bytes > flush_batch_bytes {
                        batch.event = HttpServerStreamBatchEvent::FlushAfterBytes;
                        return Ok(batch);
                    }
                },
                // An error occurred,.
                // Throw away any intermediate messages that we held back.
                HttpServerStreamEvent::BodyReadFailed(e) => {
                    log::debug!("http stream {} failed to read body", stream_id);
                    if let Ok(mut streams) = self.server_streams.write() {
                        streams.remove(&stream_id);
                    }
                    return Err(Status::HttpStreamReadFailed{
                        stream_id,
                        error: e
                    });
                },
                // We reached the end of the stream.
                // Flush the current batch with trailers and an EOS marker.
                HttpServerStreamEvent::BodyEnd => {
                    log::debug!("http stream {} reached end", stream_id);
                    if let Ok(mut streams) = self.server_streams.write() {
                        streams.remove(&stream_id);
                    }
                    batch.event = HttpServerStreamBatchEvent::StreamFinished;
                    return Ok(batch);
                }
            }
        }
    }

    /// Cancellation is done by just dropping everything
    #[allow(dead_code)]
    pub async fn destroy_server_stream(self: &Arc<Self>, stream_id: usize) {
        // XXX We should let reqwest cancel the request
        if let Ok(mut streams) = self.server_streams.write() {
            streams.remove(&stream_id);
        }
    }
}

