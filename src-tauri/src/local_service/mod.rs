//! The Nova local service: the real backend behind the Local Service
//! developer backend.
//!
//! It is a service in the only sense that matters here — it runs outside the
//! webview, it owns state the frontend cannot fabricate, it issues the session
//! the frontend must present on every request, and it is the authority on what
//! it can and cannot do. It is **not** a server: it opens no socket, binds no
//! address and listens on no port. The only way to reach it is Tauri's own
//! application IPC, and the only thing that can use that is this application's
//! own window.
//!
//! What it deliberately does not do, and what no future operation here may do:
//! it enumerates no process, opens no process handle, reads or writes no memory
//! outside this process, loads no library into anything, starts no thread in
//! another process, invokes no shell, launches no executable, writes no
//! persistence and contacts no network endpoint. Every operation below answers
//! a question about the service's own session and nothing else.
//!
//! ```text
//! Nova UI → controllers → provider interfaces → Local Service backend
//!                                                 │ Tauri IPC (this process)
//!                                                 ▼
//!                                          LocalService (here)
//! ```

mod protocol;

use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use protocol::{Decoded, ErrorCode, ProtocolError, Request};

/// Bytes of OS entropy behind a session token. The token never leaves this
/// process's memory: it is handed to the frontend once, held there in a closure
/// variable, and is never logged, never shown and never persisted.
const TOKEN_BYTES: usize = 32;

/// Bytes of OS entropy behind a session id. The id is not a secret — it names
/// the session in diagnostics — so it is shorter than the token.
const SESSION_ID_BYTES: usize = 16;

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Fills `buffer` with random bytes, answering whether it could.
type Entropy = dyn Fn(&mut [u8]) -> bool + Send + Sync;

fn os_entropy(buffer: &mut [u8]) -> bool {
    getrandom::fill(buffer).is_ok()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Compares two secrets without leaking which byte differed through timing.
fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

/// A mutex guard that survives a poisoned lock: a panic in one request must not
/// take the service down for every later one.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The one session the service keeps. A handshake replaces it, and everything
/// the previous session held goes with it.
#[derive(Debug)]
struct Session {
    id: String,
    token: String,
    attached: bool,
    opened_at_ms: u64,
    attached_at_ms: Option<u64>,
}

#[derive(Debug, Default)]
struct State {
    session: Option<Session>,
    /// How many sessions this service has issued since the process started.
    /// Reported in diagnostics so a superseded session is visible as one.
    issued: u64,
}

/// The service, as Tauri manages it.
///
/// One instance per application, created before the window opens and dropped
/// with the process. Its whole surface is [`LocalService::handle`]: one raw
/// message in, one raw message out.
pub struct LocalService {
    state: Mutex<State>,
    entropy: Box<Entropy>,
}

impl Default for LocalService {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalService {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State::default()),
            entropy: Box::new(os_entropy),
        }
    }

    /// Builds a service over a given entropy source. Test-only in practice: it
    /// is how the "the OS would not give us randomness" refusal is exercised
    /// without breaking the machine's random device.
    #[cfg(test)]
    fn with_entropy(entropy: Box<Entropy>) -> Self {
        Self {
            state: Mutex::new(State::default()),
            entropy,
        }
    }

    fn random_hex(&self, bytes: usize) -> Option<String> {
        let mut buffer = vec![0u8; bytes];
        if !(self.entropy)(&mut buffer) {
            return None;
        }
        let mut out = String::with_capacity(bytes * 2);
        for byte in buffer {
            out.push(HEX[usize::from(byte >> 4)] as char);
            out.push(HEX[usize::from(byte & 0x0f)] as char);
        }
        Some(out)
    }

    /// Answers one raw message.
    ///
    /// This never panics and never returns an error to the IPC layer: every
    /// refusal is a well-formed response envelope, so the frontend always gets
    /// a structured code it can present rather than a rejected promise.
    pub fn handle(&self, raw: &str) -> String {
        let request = match protocol::decode(raw) {
            Decoded::Request(request) => request,
            Decoded::Rejected { request_id, error } => {
                return protocol::error_response(&request_id, &error);
            }
        };

        // The handshake is the only operation that may arrive without a
        // session, because it is the operation that issues one.
        if request.op == "handshake" {
            return self.handshake(&request);
        }

        let mut state = lock(&self.state);
        if let Err(error) = authenticate(&state, &request) {
            return protocol::error_response(&request.request_id, &error);
        }

        match request.op.as_str() {
            "health" => {
                let payload = health_payload(&state);
                protocol::ok_response(&request.request_id, payload)
            }
            "attach" => match attach(&mut state) {
                Ok(payload) => protocol::ok_response(&request.request_id, payload),
                Err(error) => protocol::error_response(&request.request_id, &error),
            },
            "detach" => {
                detach(&mut state);
                protocol::ok_response(
                    &request.request_id,
                    serde_json::json!({ "attached": false }),
                )
            }
            "shutdown" => {
                state.session = None;
                protocol::ok_response(&request.request_id, serde_json::json!({ "stopped": true }))
            }
            other => protocol::error_response(
                &request.request_id,
                &ProtocolError::with_details(
                    ErrorCode::OperationUnsupported,
                    "The local service does not implement this operation.",
                    format!(
                        "requested {}; supported: {}",
                        other.chars().take(64).collect::<String>(),
                        protocol::OPERATIONS.join(", ")
                    ),
                ),
            ),
        }
    }

    /// Opens a session, replacing whatever one existed.
    ///
    /// Replacing rather than refusing is deliberate: a window that reloads has
    /// no way to hand its old token back, and a service that could be locked
    /// out by its own client would need a second recovery mechanism. The
    /// previous session is not merely forgotten — every request that still
    /// carries it is refused as stale, which is what makes a restart safe.
    fn handshake(&self, request: &Request) -> String {
        let required = match required_capabilities(&request.payload) {
            Ok(required) => required,
            Err(error) => return protocol::error_response(&request.request_id, &error),
        };
        if let Some(unsupported) = required
            .iter()
            .find(|name| name.as_str() != protocol::CAPABILITY_TARGET)
        {
            return protocol::error_response(
                &request.request_id,
                &ProtocolError::with_details(
                    ErrorCode::CapabilityUnsupported,
                    "The local service does not implement a capability this session requires.",
                    format!(
                        "requested {}; supported: {}",
                        unsupported.chars().take(64).collect::<String>(),
                        protocol::CAPABILITY_TARGET
                    ),
                ),
            );
        }

        let (Some(id), Some(token)) = (
            self.random_hex(SESSION_ID_BYTES),
            self.random_hex(TOKEN_BYTES),
        ) else {
            return protocol::error_response(
                &request.request_id,
                &ProtocolError::new(
                    ErrorCode::ServiceUnavailable,
                    "The local service could not open a session.",
                ),
            );
        };

        let opened_at_ms = now_ms();
        let mut state = lock(&self.state);
        state.issued += 1;
        let issued = state.issued;
        state.session = Some(Session {
            id: id.clone(),
            token: token.clone(),
            attached: false,
            opened_at_ms,
            attached_at_ms: None,
        });

        protocol::ok_response(
            &request.request_id,
            serde_json::json!({
                "sessionId": id,
                "token": token,
                "service": {
                    "name": protocol::SERVICE_NAME,
                    "version": protocol::SERVICE_VERSION,
                    "protocol": protocol::PROTOCOL_VERSION,
                },
                "capabilities": capabilities(),
                "openedAt": opened_at_ms,
                "sessionsIssued": issued,
            }),
        )
    }
}

/// What the service implements. Derived one flag at a time from what actually
/// exists below: only the target operations do, and the other three say so
/// rather than being left out.
fn capabilities() -> serde_json::Value {
    serde_json::json!({
        "target": true,
        "debugger": false,
        "profiler": false,
        "execute": false,
    })
}

/// The capability names a handshake requires, or why the list is unreadable.
fn required_capabilities(payload: &serde_json::Value) -> Result<Vec<String>, ProtocolError> {
    let Some(value) = payload.get("capabilities") else {
        return Ok(Vec::new());
    };
    let Some(entries) = value.as_array() else {
        return Err(ProtocolError::new(
            ErrorCode::MessageMalformed,
            "The handshake's required capabilities are not a list.",
        ));
    };
    let mut names = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(name) = entry.as_str() else {
            return Err(ProtocolError::new(
                ErrorCode::MessageMalformed,
                "A required capability is not a name.",
            ));
        };
        names.push(name.to_owned());
    }
    Ok(names)
}

/// Whether this request may act on the session it names.
///
/// The order matters and is the whole of the service's access control: a
/// request with no session is refused before anything is looked up, a request
/// naming a session that is not the active one is stale whether or not the
/// service has any session at all, and only a request naming the active session
/// gets as far as having its token compared.
fn authenticate(state: &State, request: &Request) -> Result<(), ProtocolError> {
    let (Some(session_id), Some(token)) = (request.session_id.as_deref(), request.token.as_deref())
    else {
        return Err(ProtocolError::new(
            ErrorCode::AuthRequired,
            "This operation needs a local service session.",
        ));
    };
    if session_id.is_empty() || token.is_empty() {
        return Err(ProtocolError::new(
            ErrorCode::AuthRequired,
            "This operation needs a local service session.",
        ));
    }

    let Some(active) = state.session.as_ref() else {
        return Err(ProtocolError::new(
            ErrorCode::SessionStale,
            "The local service has no open session; this one has ended.",
        ));
    };
    if session_id != active.id {
        return Err(ProtocolError::new(
            ErrorCode::SessionStale,
            "This session has been replaced by a newer one.",
        ));
    }
    if !constant_time_eq(token, &active.token) {
        return Err(ProtocolError::new(
            ErrorCode::AuthInvalid,
            "The session token was not accepted.",
        ));
    }
    Ok(())
}

/// The service's own state, as the health check reads it. The session id is
/// included because the UI names it; the token never is.
fn health_payload(state: &State) -> serde_json::Value {
    let session = state.session.as_ref();
    serde_json::json!({
        "target": {
            "available": session.is_some(),
            "ready": session.is_some(),
            "version": format!(
                "{} {} ({})",
                protocol::SERVICE_NAME,
                protocol::SERVICE_VERSION,
                protocol::PROTOCOL_VERSION
            ),
        },
        "attached": session.is_some_and(|session| session.attached),
        "capabilities": capabilities(),
        "sessionId": session.map(|session| session.id.clone()),
        "openedAt": session.map(|session| session.opened_at_ms),
        "attachedAt": session.and_then(|session| session.attached_at_ms),
        "sessionsIssued": state.issued,
        "serviceTimeMs": now_ms(),
    })
}

fn attach(state: &mut State) -> Result<serde_json::Value, ProtocolError> {
    // Authentication already proved the session is the active one.
    let Some(session) = state.session.as_mut() else {
        return Err(ProtocolError::new(
            ErrorCode::SessionStale,
            "The local service has no open session; this one has ended.",
        ));
    };
    if session.attached {
        return Err(ProtocolError::new(
            ErrorCode::AlreadyAttached,
            "This session is already attached to the local service.",
        ));
    }
    let attached_at = now_ms();
    session.attached = true;
    session.attached_at_ms = Some(attached_at);
    Ok(serde_json::json!({ "attached": true, "attachedAt": attached_at }))
}

fn detach(state: &mut State) {
    if let Some(session) = state.session.as_mut() {
        session.attached = false;
        session.attached_at_ms = None;
    }
}

#[cfg(test)]
mod tests {
    use super::protocol::{MAX_MESSAGE_BYTES, PROTOCOL_VERSION};
    use super::*;

    /// One open session, as a test holds it.
    struct Handshake {
        session_id: String,
        token: String,
        payload: serde_json::Value,
    }

    fn body(response: &str) -> serde_json::Value {
        serde_json::from_str(response).expect("the service answered with valid json")
    }

    fn payload_of(response: &str) -> serde_json::Value {
        let value = body(response);
        assert_eq!(
            value["ok"], true,
            "expected a successful answer, got {response}"
        );
        value["payload"].clone()
    }

    fn code_of(response: &str) -> String {
        let value = body(response);
        assert_eq!(value["ok"], false, "expected a refusal, got {response}");
        value["error"]["code"]
            .as_str()
            .expect("a refusal carries a code")
            .to_owned()
    }

    fn request(op: &str, session: Option<&Handshake>) -> String {
        let mut message = serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "op": op,
            "requestId": format!("request-{op}"),
        });
        if let Some(session) = session {
            message["sessionId"] = session.session_id.clone().into();
            message["token"] = session.token.clone().into();
        }
        message.to_string()
    }

    fn open(service: &LocalService) -> Handshake {
        let raw = serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "op": "handshake",
            "requestId": "request-handshake",
            "payload": { "client": "nova", "capabilities": ["target"] },
        })
        .to_string();
        let payload = payload_of(&service.handle(&raw));
        Handshake {
            session_id: payload["sessionId"]
                .as_str()
                .expect("the handshake issues a session id")
                .to_owned(),
            token: payload["token"]
                .as_str()
                .expect("the handshake issues a token")
                .to_owned(),
            payload,
        }
    }

    #[test]
    fn a_handshake_opens_a_session_and_reports_what_the_service_can_do() {
        let service = LocalService::new();
        let session = open(&service);

        assert_eq!(session.session_id.len(), SESSION_ID_BYTES * 2);
        assert_eq!(session.token.len(), TOKEN_BYTES * 2);
        assert_eq!(session.payload["service"]["name"], protocol::SERVICE_NAME);
        assert_eq!(session.payload["service"]["protocol"], PROTOCOL_VERSION);
        assert_eq!(session.payload["capabilities"]["target"], true);
        assert_eq!(session.payload["capabilities"]["debugger"], false);
        assert_eq!(session.payload["capabilities"]["profiler"], false);
        assert_eq!(session.payload["capabilities"]["execute"], false);
        assert_eq!(session.payload["sessionsIssued"], 1);
    }

    #[test]
    fn two_handshakes_never_issue_the_same_secret() {
        let service = LocalService::new();
        let first = open(&service);
        let second = open(&service);

        assert_ne!(first.token, second.token);
        assert_ne!(first.session_id, second.session_id);
        assert_eq!(second.payload["sessionsIssued"], 2);
    }

    #[test]
    fn every_operation_but_the_handshake_needs_a_session() {
        let service = LocalService::new();
        for op in ["health", "attach", "detach", "shutdown"] {
            assert_eq!(
                code_of(&service.handle(&request(op, None))),
                ErrorCode::AuthRequired.as_str(),
                "{op}"
            );
        }
    }

    #[test]
    fn an_empty_token_is_no_token() {
        let service = LocalService::new();
        let session = open(&service);
        let raw = serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "op": "health",
            "requestId": "request-health",
            "sessionId": session.session_id,
            "token": "",
        })
        .to_string();
        assert_eq!(
            code_of(&service.handle(&raw)),
            ErrorCode::AuthRequired.as_str()
        );
    }

    #[test]
    fn the_wrong_token_for_the_active_session_is_refused() {
        let service = LocalService::new();
        let session = open(&service);
        let raw = serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "op": "health",
            "requestId": "request-health",
            "sessionId": session.session_id,
            "token": "0".repeat(TOKEN_BYTES * 2),
        })
        .to_string();
        assert_eq!(
            code_of(&service.handle(&raw)),
            ErrorCode::AuthInvalid.as_str()
        );
    }

    #[test]
    fn a_superseded_session_can_no_longer_act() {
        let service = LocalService::new();
        let first = open(&service);
        assert!(
            body(&service.handle(&request("health", Some(&first))))["ok"]
                .as_bool()
                .unwrap_or(false)
        );

        let second = open(&service);
        for op in ["health", "attach", "detach", "shutdown"] {
            assert_eq!(
                code_of(&service.handle(&request(op, Some(&first)))),
                ErrorCode::SessionStale.as_str(),
                "{op}"
            );
        }
        assert_eq!(
            payload_of(&service.handle(&request("health", Some(&second))))["attached"],
            false
        );
    }

    #[test]
    fn shutting_down_invalidates_the_session_it_was_asked_on() {
        let service = LocalService::new();
        let session = open(&service);
        assert_eq!(
            payload_of(&service.handle(&request("shutdown", Some(&session))))["stopped"],
            true
        );
        assert_eq!(
            code_of(&service.handle(&request("health", Some(&session)))),
            ErrorCode::SessionStale.as_str()
        );
    }

    #[test]
    fn a_session_attaches_once_and_says_so_when_asked_twice() {
        let service = LocalService::new();
        let session = open(&service);

        let attached = payload_of(&service.handle(&request("attach", Some(&session))));
        assert_eq!(attached["attached"], true);
        assert!(attached["attachedAt"].as_u64().unwrap_or(0) > 0);

        assert_eq!(
            code_of(&service.handle(&request("attach", Some(&session)))),
            ErrorCode::AlreadyAttached.as_str()
        );

        let health = payload_of(&service.handle(&request("health", Some(&session))));
        assert_eq!(health["attached"], true);
        assert_eq!(health["target"]["available"], true);
        assert_eq!(health["target"]["ready"], true);
    }

    #[test]
    fn detaching_is_safe_to_repeat_and_frees_the_session_to_attach_again() {
        let service = LocalService::new();
        let session = open(&service);
        service.handle(&request("attach", Some(&session)));

        for _ in 0..2 {
            assert_eq!(
                payload_of(&service.handle(&request("detach", Some(&session))))["attached"],
                false
            );
        }
        assert_eq!(
            payload_of(&service.handle(&request("attach", Some(&session))))["attached"],
            true
        );
    }

    #[test]
    fn a_new_session_starts_detached_however_the_last_one_ended() {
        let service = LocalService::new();
        let first = open(&service);
        service.handle(&request("attach", Some(&first)));

        let second = open(&service);
        let health = payload_of(&service.handle(&request("health", Some(&second))));
        assert_eq!(health["attached"], false);
        assert_eq!(health["attachedAt"], serde_json::Value::Null);
    }

    #[test]
    fn a_handshake_requiring_something_the_service_lacks_is_refused_by_name() {
        let service = LocalService::new();
        for capability in ["debugger", "profiler", "execute", "process"] {
            let raw = serde_json::json!({
                "protocol": PROTOCOL_VERSION,
                "op": "handshake",
                "requestId": "request-handshake",
                "payload": { "capabilities": ["target", capability] },
            })
            .to_string();
            let response = service.handle(&raw);
            assert_eq!(
                code_of(&response),
                ErrorCode::CapabilityUnsupported.as_str(),
                "{capability}"
            );
            assert!(
                body(&response)["error"]["details"]
                    .as_str()
                    .unwrap_or_default()
                    .contains(capability),
                "the refusal names the capability that was asked for"
            );
        }
    }

    #[test]
    fn a_refused_handshake_leaves_the_session_that_was_already_open_alone() {
        let service = LocalService::new();
        let session = open(&service);
        let raw = serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "op": "handshake",
            "requestId": "request-handshake",
            "payload": { "capabilities": ["debugger"] },
        })
        .to_string();
        assert_eq!(
            code_of(&service.handle(&raw)),
            ErrorCode::CapabilityUnsupported.as_str()
        );
        assert!(
            body(&service.handle(&request("health", Some(&session))))["ok"]
                .as_bool()
                .unwrap_or(false)
        );
    }

    #[test]
    fn a_capability_list_that_is_not_a_list_of_names_is_malformed() {
        let service = LocalService::new();
        for capabilities in [
            serde_json::json!("target"),
            serde_json::json!({ "target": true }),
            serde_json::json!([1]),
            serde_json::json!([null]),
        ] {
            let raw = serde_json::json!({
                "protocol": PROTOCOL_VERSION,
                "op": "handshake",
                "requestId": "request-handshake",
                "payload": { "capabilities": capabilities },
            })
            .to_string();
            assert_eq!(
                code_of(&service.handle(&raw)),
                ErrorCode::MessageMalformed.as_str()
            );
        }
    }

    #[test]
    fn an_unknown_operation_is_refused_after_the_session_is_checked() {
        let service = LocalService::new();
        let session = open(&service);
        assert_eq!(
            code_of(&service.handle(&request("attach_to_another_process", Some(&session)))),
            ErrorCode::OperationUnsupported.as_str()
        );
        // Without a session the same message never gets as far as the op name.
        assert_eq!(
            code_of(&service.handle(&request("attach_to_another_process", None))),
            ErrorCode::AuthRequired.as_str()
        );
    }

    #[test]
    fn an_oversized_or_malformed_message_is_refused_before_anything_is_touched() {
        let service = LocalService::new();
        let session = open(&service);

        assert_eq!(
            code_of(&service.handle(&"x".repeat(MAX_MESSAGE_BYTES + 1))),
            ErrorCode::MessageTooLarge.as_str()
        );
        assert_eq!(
            code_of(&service.handle("{\"protocol\":")),
            ErrorCode::MessageMalformed.as_str()
        );
        assert_eq!(
            code_of(
                &service.handle(
                    &serde_json::json!({
                        "protocol": "NOVA_LOCAL_SERVICE_V0",
                        "op": "shutdown",
                        "requestId": "request-shutdown",
                        "sessionId": session.session_id,
                        "token": session.token,
                    })
                    .to_string()
                )
            ),
            ErrorCode::ProtocolUnsupported.as_str()
        );
        // None of the three reached the session.
        assert!(
            body(&service.handle(&request("health", Some(&session))))["ok"]
                .as_bool()
                .unwrap_or(false)
        );
    }

    #[test]
    fn the_session_token_is_never_repeated_after_the_handshake_that_issued_it() {
        let service = LocalService::new();
        let session = open(&service);

        for op in ["health", "attach", "detach", "shutdown"] {
            let response = service.handle(&request(op, Some(&session)));
            assert!(
                !response.contains(&session.token),
                "{op} echoed the session token"
            );
        }
        // A refusal must not echo it either.
        let refused = service.handle(&request("attach", Some(&session)));
        assert!(!refused.contains(&session.token));
    }

    #[test]
    fn a_service_that_cannot_get_randomness_refuses_to_open_a_session() {
        let service = LocalService::with_entropy(Box::new(|_| false));
        let raw = serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "op": "handshake",
            "requestId": "request-handshake",
            "payload": { "capabilities": ["target"] },
        })
        .to_string();
        assert_eq!(
            code_of(&service.handle(&raw)),
            ErrorCode::ServiceUnavailable.as_str(),
            "a weak token is never a fallback"
        );
    }

    #[test]
    fn health_reports_the_session_id_and_never_the_token() {
        let service = LocalService::new();
        let session = open(&service);
        let health = payload_of(&service.handle(&request("health", Some(&session))));

        assert_eq!(health["sessionId"], session.session_id);
        assert_eq!(health["capabilities"]["debugger"], false);
        assert!(health["openedAt"].as_u64().unwrap_or(0) > 0);
        assert_eq!(health["sessionsIssued"], 1);
        assert!(!health.to_string().contains(&session.token));
    }

    #[test]
    fn constant_time_eq_matches_string_equality() {
        assert!(constant_time_eq("", ""));
        assert!(constant_time_eq("abcd", "abcd"));
        assert!(!constant_time_eq("abcd", "abce"));
        assert!(!constant_time_eq("abcd", "abc"));
        assert!(!constant_time_eq("abc", "abcd"));
    }
}
