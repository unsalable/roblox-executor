//! The local development bridge: a loopback-only HTTP relay between Nova's
//! frontend and a Roblox Studio plugin.
//!
//! Rust owns the socket and nothing else. It never parses, interprets or stores
//! bridge messages — it moves opaque strings — so the whole protocol (handshake,
//! pairing, authentication, heartbeat, execution correlation) lives in the
//! frontend, where it is unit-tested without any networking. What Rust does own
//! is the security of the listener itself:
//!
//! * it binds `127.0.0.1` only, never `0.0.0.0`;
//! * it answers three exact routes and rejects everything else;
//! * it refuses requests carrying an `Origin` header or a foreign `Host`, so a
//!   web page in the user's browser cannot drive the bridge;
//! * it gates the poll channel — the one that carries script source toward the
//!   plugin — on the session token the frontend issues after pairing;
//! * it caps the head, the body and the number of connections in flight.
//!
//! No process is inspected or attached to, and nothing outside this loopback
//! listener is contacted.

mod http;

use std::collections::{HashMap, VecDeque};
use std::io::{BufReader, Read};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Kept in step with `PROTOCOL_VERSION` in `src/features/bridge/protocol.ts`.
const PROTOCOL_VERSION: &str = "NOVA_STUDIO_BRIDGE_V1";

const MAX_HEAD_BYTES: usize = 8 * 1024;
/// Matches `MAX_MESSAGE_BYTES` on the frontend.
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024 + 64 * 1024;
const MAX_IN_FLIGHT: usize = 16;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a request may wait for the frontend to answer it.
const RPC_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a poll is held open before answering "nothing yet".
const POLL_TIMEOUT: Duration = Duration::from_secs(20);
/// How much of an over-sized body to absorb before refusing it, and for how long.
/// Generous enough that a client sending a genuinely too-large message still
/// gets to read the 413 instead of a connection reset, but bounded so a hostile
/// client cannot hold a connection thread open.
const DRAIN_LIMIT: u64 = 8 * 1024 * 1024;
const DRAIN_TIMEOUT: Duration = Duration::from_millis(2000);

pub const EVENT_DELIVERY: &str = "nova://bridge/delivery";
pub const EVENT_POLL: &str = "nova://bridge/poll";
pub const EVENT_ERROR: &str = "nova://bridge/error";

/// Where the relay reports what arrived. The frontend is the only real
/// implementation; tests use their own so the server can run without Tauri.
pub trait EventSink: Send + Sync {
    fn delivery(&self, delivery_id: u64, body: String, token: Option<String>);
    fn poll(&self, token: Option<String>);
    fn error(&self, message: String);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryEvent {
    delivery_id: u64,
    body: String,
    token: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PollEvent {
    token: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    message: String,
}

/// Forwards relay events to the webview as Tauri events.
struct WebviewSink(AppHandle);

impl WebviewSink {
    fn emit<P: Serialize + Clone>(&self, event: &str, payload: P) {
        if let Err(error) = self.0.emit(event, payload) {
            eprintln!("nova bridge: could not emit {event}: {error}");
        }
    }
}

impl EventSink for WebviewSink {
    fn delivery(&self, delivery_id: u64, body: String, token: Option<String>) {
        self.emit(
            EVENT_DELIVERY,
            DeliveryEvent {
                delivery_id,
                body,
                token,
            },
        );
    }

    fn poll(&self, token: Option<String>) {
        self.emit(EVENT_POLL, PollEvent { token });
    }

    fn error(&self, message: String) {
        self.emit(EVENT_ERROR, ErrorEvent { message });
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStarted {
    pub address: String,
    pub port: u16,
    pub protocol: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub listening: bool,
    pub address: Option<String>,
    pub protocol: String,
}

/// Locks a mutex, recovering the data if another thread panicked while holding it.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Length-independent comparison, so a token cannot be guessed byte by byte.
fn constant_time_eq(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (a, b) in left.iter().zip(right) {
        difference |= a ^ b;
    }
    difference == 0
}

struct Timeouts {
    rpc: Duration,
    poll: Duration,
}

struct Shared {
    sink: Arc<dyn EventSink>,
    port: u16,
    timeouts: Timeouts,
    /// Messages queued for the plugin's next authenticated poll.
    queue: Mutex<VecDeque<String>>,
    queue_signal: Condvar,
    /// The session token the frontend issued, or None before pairing.
    token: Mutex<Option<String>>,
    /// Requests waiting for the frontend to answer them.
    pending: Mutex<HashMap<u64, mpsc::Sender<String>>>,
    next_delivery: AtomicU64,
    stopping: AtomicBool,
    in_flight: AtomicUsize,
}

impl Shared {
    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }
}

pub struct Bridge {
    shared: Arc<Shared>,
    address: SocketAddr,
}

#[derive(Default)]
pub struct BridgeState(Mutex<Option<Bridge>>);

/// Decrements the in-flight counter however the connection thread ends.
struct InFlightGuard(Arc<Shared>);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Absorbs a little of whatever the client is still sending, so a refusal is
/// not lost to a connection reset. Bounded in both bytes and time, so a client
/// that sends nothing is answered at once instead of holding the thread.
fn drain_briefly(reader: &mut BufReader<TcpStream>) {
    let _ = reader.get_ref().set_read_timeout(Some(DRAIN_TIMEOUT));
    let deadline = Instant::now() + DRAIN_TIMEOUT;
    let mut scratch = [0_u8; 8 * 1024];
    let mut drained: u64 = 0;
    while drained < DRAIN_LIMIT && Instant::now() < deadline {
        match reader.read(&mut scratch) {
            Ok(0) => break,
            Ok(read) => drained += read as u64,
            Err(_) => break,
        }
    }
}

fn handle_connection(stream: TcpStream, shared: Arc<Shared>) {
    let _guard = InFlightGuard(Arc::clone(&shared));
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let _ = stream.set_nodelay(true);

    let mut out = match stream.try_clone() {
        Ok(handle) => handle,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);

    let request = match http::read_request(&mut reader, MAX_HEAD_BYTES, MAX_BODY_BYTES) {
        Ok(request) => request,
        Err(error) => {
            let (status, code) = match error {
                http::RequestError::HeadTooLarge | http::RequestError::BodyTooLarge => {
                    drain_briefly(&mut reader);
                    (413, "PAYLOAD_TOO_LARGE")
                }
                http::RequestError::Unsupported => (501, "UNSUPPORTED"),
                _ => (400, "MALFORMED_REQUEST"),
            };
            let _ = http::write_response(&mut out, status, &http::error_body(code));
            return;
        }
    };

    // A browser page sends Origin on any cross-origin request; a local tool
    // never does. With the Host check this keeps the bridge out of reach of web
    // content running on this machine.
    if request.header("origin").is_some() {
        let _ = http::write_response(&mut out, 403, &http::error_body("ORIGIN_NOT_ALLOWED"));
        return;
    }
    let host_ok = request.header("host").is_some_and(|host| {
        let (name, port) = match host.rsplit_once(':') {
            Some((name, port)) => (name, port),
            None => (host, ""),
        };
        (name == "127.0.0.1" || name == "localhost" || name == "[::1]")
            && (port.is_empty() || port == shared.port.to_string())
    });
    if !host_ok {
        let _ = http::write_response(&mut out, 403, &http::error_body("HOST_NOT_ALLOWED"));
        return;
    }

    let token = request.header("x-nova-token").map(str::to_owned);

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/nova/info") => {
            let body = format!(
                "{{\"service\":\"nova-studio-bridge\",\"protocol\":\"{PROTOCOL_VERSION}\",\"port\":{}}}",
                shared.port
            );
            let _ = http::write_response(&mut out, 200, &body);
        }

        ("POST", "/nova/rpc") => {
            let json = request
                .header("content-type")
                .is_some_and(|value| value.starts_with("application/json"));
            if !json {
                let _ = http::write_response(&mut out, 415, &http::error_body("EXPECTED_JSON"));
                return;
            }

            let (sender, receiver) = mpsc::channel();
            let delivery_id = shared.next_delivery.fetch_add(1, Ordering::SeqCst);
            lock(&shared.pending).insert(delivery_id, sender);
            shared.sink.delivery(delivery_id, request.body, token);

            let answer = receiver.recv_timeout(shared.timeouts.rpc);
            lock(&shared.pending).remove(&delivery_id);
            match answer {
                Ok(body) => {
                    let _ = http::write_response(&mut out, 200, &body);
                }
                Err(_) => {
                    let _ = http::write_response(
                        &mut out,
                        504,
                        &http::error_body("NOVA_DID_NOT_ANSWER"),
                    );
                }
            }
        }

        ("POST", "/nova/poll") => {
            let authorized = match (&*lock(&shared.token), &token) {
                (Some(expected), Some(presented)) => constant_time_eq(expected, presented),
                _ => false,
            };
            if !authorized {
                let _ = http::write_response(&mut out, 401, &http::error_body("NOT_PAIRED"));
                return;
            }
            shared.sink.poll(token);

            let mut queue = lock(&shared.queue);
            let deadline = Instant::now() + shared.timeouts.poll;
            loop {
                if shared.stopping() {
                    drop(queue);
                    let _ =
                        http::write_response(&mut out, 503, &http::error_body("BRIDGE_STOPPED"));
                    return;
                }
                if let Some(message) = queue.pop_front() {
                    drop(queue);
                    let _ = http::write_response(&mut out, 200, &message);
                    return;
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    drop(queue);
                    let _ = http::write_response(&mut out, 204, "");
                    return;
                }
                let (next, _) = shared
                    .queue_signal
                    .wait_timeout(queue, remaining)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                queue = next;
            }
        }

        ("GET", _) | ("POST", _) => {
            let _ = http::write_response(&mut out, 404, &http::error_body("UNKNOWN_ROUTE"));
        }
        _ => {
            let _ = http::write_response(&mut out, 405, &http::error_body("METHOD_NOT_ALLOWED"));
        }
    }
}

fn serve(listener: TcpListener, shared: Arc<Shared>) {
    for stream in listener.incoming() {
        if shared.stopping() {
            break;
        }
        match stream {
            Ok(stream) => {
                if shared.in_flight.load(Ordering::SeqCst) >= MAX_IN_FLIGHT {
                    let mut stream = stream;
                    let _ = http::write_response(
                        &mut stream,
                        429,
                        &http::error_body("TOO_MANY_CONNECTIONS"),
                    );
                    continue;
                }
                shared.in_flight.fetch_add(1, Ordering::SeqCst);
                let connection = Arc::clone(&shared);
                if let Err(error) = thread::Builder::new()
                    .name("nova-bridge-connection".into())
                    .spawn(move || handle_connection(stream, connection))
                {
                    shared.in_flight.fetch_sub(1, Ordering::SeqCst);
                    eprintln!("nova bridge: could not start a connection thread: {error}");
                }
            }
            Err(error) => {
                if shared.stopping() {
                    break;
                }
                shared.sink.error(error.to_string());
            }
        }
    }
}

impl Bridge {
    fn start_with(sink: Arc<dyn EventSink>, port: u16, timeouts: Timeouts) -> Result<Self, String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .map_err(|error| format!("Could not bind 127.0.0.1:{port}: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("Could not read the bound address: {error}"))?;

        let shared = Arc::new(Shared {
            sink,
            port: address.port(),
            timeouts,
            queue: Mutex::new(VecDeque::new()),
            queue_signal: Condvar::new(),
            token: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_delivery: AtomicU64::new(1),
            stopping: AtomicBool::new(false),
            in_flight: AtomicUsize::new(0),
        });

        let worker = Arc::clone(&shared);
        thread::Builder::new()
            .name("nova-bridge".into())
            .spawn(move || serve(listener, worker))
            .map_err(|error| format!("Could not start the bridge thread: {error}"))?;

        Ok(Bridge { shared, address })
    }

    pub fn start(sink: Arc<dyn EventSink>, port: u16) -> Result<Self, String> {
        Bridge::start_with(
            sink,
            port,
            Timeouts {
                rpc: RPC_TIMEOUT,
                poll: POLL_TIMEOUT,
            },
        )
    }

    pub fn push(&self, message: String) {
        lock(&self.shared.queue).push_back(message);
        self.shared.queue_signal.notify_one();
    }

    pub fn clear_queue(&self) {
        lock(&self.shared.queue).clear();
    }

    pub fn set_token(&self, token: Option<String>) {
        *lock(&self.shared.token) = token;
    }

    pub fn respond(&self, delivery_id: u64, body: String) {
        let sender = lock(&self.shared.pending).remove(&delivery_id);
        if let Some(sender) = sender {
            let _ = sender.send(body);
        }
    }

    pub fn stop(&self) {
        self.shared.stopping.store(true, Ordering::SeqCst);
        // Release everything parked: polls waiting for a message and requests
        // waiting for the frontend to answer.
        lock(&self.shared.queue).clear();
        self.shared.queue_signal.notify_all();
        lock(&self.shared.pending).clear();
        *lock(&self.shared.token) = None;
        // Unblock the accept loop, which then sees the stop flag and exits.
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(250));
    }
}

#[tauri::command]
pub fn bridge_start(
    app: AppHandle,
    state: State<'_, BridgeState>,
    port: u16,
) -> Result<BridgeStarted, String> {
    let mut current = lock(&state.0);
    if let Some(bridge) = current.as_ref() {
        if bridge.address.port() == port {
            // The caller is a frontend that has just started: whatever session
            // the previous one had is gone, so the relay must not keep honouring
            // its token or deliver messages queued for it.
            bridge.set_token(None);
            bridge.clear_queue();
            return Ok(BridgeStarted {
                address: bridge.address.to_string(),
                port: bridge.address.port(),
                protocol: PROTOCOL_VERSION.to_owned(),
            });
        }
        bridge.stop();
        *current = None;
    }

    let bridge = Bridge::start(Arc::new(WebviewSink(app)), port)?;
    let started = BridgeStarted {
        address: bridge.address.to_string(),
        port: bridge.address.port(),
        protocol: PROTOCOL_VERSION.to_owned(),
    };
    *current = Some(bridge);
    Ok(started)
}

#[tauri::command]
pub fn bridge_stop(state: State<'_, BridgeState>) {
    let mut current = lock(&state.0);
    if let Some(bridge) = current.take() {
        bridge.stop();
    }
}

#[tauri::command]
pub fn bridge_status(state: State<'_, BridgeState>) -> BridgeStatus {
    let current = lock(&state.0);
    BridgeStatus {
        listening: current.is_some(),
        address: current.as_ref().map(|bridge| bridge.address.to_string()),
        protocol: PROTOCOL_VERSION.to_owned(),
    }
}

#[tauri::command]
pub fn bridge_push(state: State<'_, BridgeState>, message: String) {
    if let Some(bridge) = lock(&state.0).as_ref() {
        bridge.push(message);
    }
}

#[tauri::command]
pub fn bridge_clear_queue(state: State<'_, BridgeState>) {
    if let Some(bridge) = lock(&state.0).as_ref() {
        bridge.clear_queue();
    }
}

#[tauri::command]
pub fn bridge_set_token(state: State<'_, BridgeState>, token: Option<String>) {
    if let Some(bridge) = lock(&state.0).as_ref() {
        bridge.set_token(token);
    }
}

#[tauri::command]
pub fn bridge_respond(state: State<'_, BridgeState>, delivery_id: u64, body: String) {
    if let Some(bridge) = lock(&state.0).as_ref() {
        bridge.respond(delivery_id, body);
    }
}

/// Called when the application exits, so no listener outlives the window.
pub fn shutdown(state: &BridgeState) {
    let mut current = lock(&state.0);
    if let Some(bridge) = current.take() {
        bridge.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Records what the relay reported, standing in for the frontend.
    #[derive(Default)]
    struct RecordingSink {
        deliveries: Mutex<Vec<(u64, String, Option<String>)>>,
        polls: Mutex<Vec<Option<String>>>,
    }

    impl EventSink for RecordingSink {
        fn delivery(&self, delivery_id: u64, body: String, token: Option<String>) {
            lock(&self.deliveries).push((delivery_id, body, token));
        }
        fn poll(&self, token: Option<String>) {
            lock(&self.polls).push(token);
        }
        fn error(&self, _message: String) {}
    }

    struct Harness {
        bridge: Bridge,
        sink: Arc<RecordingSink>,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.bridge.stop();
        }
    }

    fn harness() -> Harness {
        let sink = Arc::new(RecordingSink::default());
        let bridge = Bridge::start_with(
            Arc::clone(&sink) as Arc<dyn EventSink>,
            0,
            Timeouts {
                rpc: Duration::from_millis(300),
                poll: Duration::from_millis(300),
            },
        )
        .expect("the bridge binds an ephemeral loopback port");
        Harness { bridge, sink }
    }

    /// Sends a raw request and returns the whole response text.
    fn request(address: SocketAddr, raw: &str) -> String {
        let mut stream = TcpStream::connect(address).expect("connects");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("sets a read timeout");
        stream.write_all(raw.as_bytes()).expect("writes");
        // read_to_end keeps what arrived even if the peer resets afterwards,
        // which read_to_string would discard.
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        String::from_utf8_lossy(&response).into_owned()
    }

    fn post(address: SocketAddr, path: &str, headers: &str, body: &str) -> String {
        request(
            address,
            &format!(
                "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\n\r\n{body}",
                address.port(),
                body.len()
            ),
        )
    }

    fn status_of(response: &str) -> &str {
        response.lines().next().unwrap_or_default()
    }

    #[test]
    fn binds_loopback_only() {
        let harness = harness();
        assert!(
            harness.bridge.address.ip().is_loopback(),
            "the bridge must never be reachable from the network"
        );
    }

    #[test]
    fn answers_the_discovery_route() {
        let harness = harness();
        let address = harness.bridge.address;
        let response = request(
            address,
            &format!(
                "GET /nova/info HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
                address.port()
            ),
        );
        assert!(status_of(&response).starts_with("HTTP/1.1 200"));
        assert!(response.contains(PROTOCOL_VERSION));
    }

    #[test]
    fn refuses_requests_from_web_pages() {
        let harness = harness();
        let address = harness.bridge.address;
        let response = post(
            address,
            "/nova/rpc",
            "Origin: https://example.com\r\n",
            "{}",
        );
        assert!(
            status_of(&response).starts_with("HTTP/1.1 403"),
            "{response}"
        );
        assert!(response.contains("ORIGIN_NOT_ALLOWED"));
        assert!(
            lock(&harness.sink.deliveries).is_empty(),
            "it never reached the frontend"
        );
    }

    #[test]
    fn refuses_a_foreign_host_header() {
        let harness = harness();
        let response = request(
            harness.bridge.address,
            "POST /nova/rpc HTTP/1.1\r\nHost: nova.example.com\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
        );
        assert!(
            status_of(&response).starts_with("HTTP/1.1 403"),
            "{response}"
        );
        assert!(response.contains("HOST_NOT_ALLOWED"));
    }

    #[test]
    fn refuses_unknown_routes_and_methods() {
        let harness = harness();
        let address = harness.bridge.address;
        assert!(status_of(&post(address, "/nova/other", "", "{}")).starts_with("HTTP/1.1 404"));

        let put = request(
            address,
            &format!(
                "PUT /nova/rpc HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
                address.port()
            ),
        );
        assert!(status_of(&put).starts_with("HTTP/1.1 405"), "{put}");
    }

    #[test]
    fn requires_json_on_the_request_route() {
        let harness = harness();
        let address = harness.bridge.address;
        let response = request(
            address,
            &format!(
                "POST /nova/rpc HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\n{{}}",
                address.port()
            ),
        );
        assert!(
            status_of(&response).starts_with("HTTP/1.1 415"),
            "{response}"
        );
    }

    #[test]
    fn relays_a_request_and_the_frontend_reply() {
        let harness = harness();
        let address = harness.bridge.address;

        let caller = thread::spawn(move || post(address, "/nova/rpc", "", "{\"type\":\"hello\"}"));

        // Wait for the relay to report the delivery, then answer it.
        let deadline = Instant::now() + Duration::from_secs(5);
        let delivery = loop {
            if let Some(entry) = lock(&harness.sink.deliveries).first().cloned() {
                break entry;
            }
            assert!(Instant::now() < deadline, "the delivery never arrived");
            thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(delivery.1, "{\"type\":\"hello\"}");
        harness
            .bridge
            .respond(delivery.0, "{\"type\":\"hello_ack\"}".to_owned());

        let response = caller.join().expect("the caller finishes");
        assert!(
            status_of(&response).starts_with("HTTP/1.1 200"),
            "{response}"
        );
        assert!(response.ends_with("{\"type\":\"hello_ack\"}"));
    }

    #[test]
    fn a_request_the_frontend_ignores_times_out() {
        let harness = harness();
        let response = post(harness.bridge.address, "/nova/rpc", "", "{}");
        assert!(
            status_of(&response).starts_with("HTTP/1.1 504"),
            "{response}"
        );
        assert!(response.contains("NOVA_DID_NOT_ANSWER"));
    }

    #[test]
    fn polling_needs_the_session_token() {
        let harness = harness();
        let address = harness.bridge.address;

        // Before pairing there is no token, so nothing may poll.
        assert!(status_of(&post(address, "/nova/poll", "", "{}")).starts_with("HTTP/1.1 401"));

        harness.bridge.set_token(Some("the-real-token".to_owned()));
        let wrong = post(address, "/nova/poll", "X-Nova-Token: guessed\r\n", "{}");
        assert!(status_of(&wrong).starts_with("HTTP/1.1 401"), "{wrong}");

        harness.bridge.push("{\"type\":\"ping\"}".to_owned());
        let right = post(
            address,
            "/nova/poll",
            "X-Nova-Token: the-real-token\r\n",
            "{}",
        );
        assert!(status_of(&right).starts_with("HTTP/1.1 200"), "{right}");
        assert!(right.ends_with("{\"type\":\"ping\"}"));
        assert_eq!(
            lock(&harness.sink.polls).len(),
            1,
            "only the authorized poll is reported"
        );
    }

    #[test]
    fn a_held_poll_ends_with_no_content() {
        let harness = harness();
        harness.bridge.set_token(Some("token".to_owned()));
        let response = post(
            harness.bridge.address,
            "/nova/poll",
            "X-Nova-Token: token\r\n",
            "{}",
        );
        assert!(
            status_of(&response).starts_with("HTTP/1.1 204"),
            "{response}"
        );
    }

    #[test]
    fn queued_messages_are_dropped_when_a_session_ends() {
        let harness = harness();
        harness.bridge.set_token(Some("token".to_owned()));
        harness
            .bridge
            .push("{\"type\":\"execute_request\"}".to_owned());
        harness.bridge.clear_queue();

        let response = post(
            harness.bridge.address,
            "/nova/poll",
            "X-Nova-Token: token\r\n",
            "{}",
        );
        assert!(
            status_of(&response).starts_with("HTTP/1.1 204"),
            "{response}"
        );
    }

    #[test]
    fn an_oversized_body_is_refused() {
        let harness = harness();
        let address = harness.bridge.address;
        let response = request(
            address,
            &format!(
                "POST /nova/rpc HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                address.port(),
                MAX_BODY_BYTES + 1
            ),
        );
        assert!(
            status_of(&response).starts_with("HTTP/1.1 413"),
            "{response}"
        );
    }

    #[test]
    fn stopping_releases_the_port() {
        let sink = Arc::new(RecordingSink::default());
        let bridge = Bridge::start(Arc::clone(&sink) as Arc<dyn EventSink>, 0).expect("starts");
        let address = bridge.address;
        bridge.stop();

        // The listener is gone, so the same port can be bound again.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match TcpListener::bind(address) {
                Ok(_) => break,
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "the port was never released: {error}"
                    );
                    thread::sleep(Duration::from_millis(20));
                }
            }
        }
    }

    #[test]
    fn constant_time_eq_matches_string_equality() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
        assert!(constant_time_eq("", ""));
    }
}
