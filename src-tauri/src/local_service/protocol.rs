//! The Nova local service wire protocol.
//!
//! This module is pure: it defines the request and response envelopes, the
//! error taxonomy and the limits, and it parses raw text into a validated
//! request. It holds no state, opens nothing and contacts nothing, so every
//! rule below is unit-tested without a Tauri application around it.
//!
//! The frontend's copy of these constants lives in
//! `src/features/backend/backends/localService/protocol.ts`. Nothing at runtime
//! could notice the two drifting apart — a mismatched version would simply
//! refuse every request — so `protocolParity.test.ts` reads this file and
//! compares them.

use serde::{Deserialize, Serialize};

/// Bumped only on an incompatible change; both sides must agree on it exactly.
pub const PROTOCOL_VERSION: &str = "NOVA_LOCAL_SERVICE_V1";

/// Largest message accepted in either direction, in bytes. An oversized message
/// is refused with a structured error rather than truncated or parsed.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// Largest request id accepted, in bytes.
///
/// The id is the one caller-supplied string the service echoes back verbatim,
/// so it is the one with a length of its own: a request that arrives with a
/// 60 KiB id is refused rather than answered with a 60 KiB response. Nova's own
/// ids are UUIDs, so nothing legitimate comes near this.
pub const MAX_REQUEST_ID_BYTES: usize = 128;

/// What the service calls itself where the UI names it.
pub const SERVICE_NAME: &str = "Nova Local Service";

/// The service build, reported in the handshake. Not the application version.
pub const SERVICE_VERSION: &str = "1";

/// The one capability this service implements, and so the only name a handshake
/// may require.
pub const CAPABILITY_TARGET: &str = "target";

/// Every operation the service answers. Anything else is refused by name.
pub const OPERATIONS: [&str; 5] = ["handshake", "health", "attach", "detach", "shutdown"];

/// Structured refusals. Every one of these is reachable, and each is produced by
/// exactly one rule; there is no catch-all code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// The message is larger than [`MAX_MESSAGE_BYTES`].
    MessageTooLarge,
    /// The message is not JSON, or is not a request envelope.
    MessageMalformed,
    /// The message names a protocol version this service does not speak.
    ProtocolUnsupported,
    /// The operation needs a session and the message carries none.
    AuthRequired,
    /// The session named is the active one and the token does not match it.
    AuthInvalid,
    /// The session named is not the active one: it was superseded or closed.
    SessionStale,
    /// The handshake required a capability this service does not implement.
    CapabilityUnsupported,
    /// The operation is not one this service implements.
    OperationUnsupported,
    /// An attach arrived while the session was already attached.
    AlreadyAttached,
    /// The service could not do its part — today, only when the operating
    /// system refuses the randomness a session token is made of.
    ServiceUnavailable,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MessageTooLarge => "MESSAGE_TOO_LARGE",
            Self::MessageMalformed => "MESSAGE_MALFORMED",
            Self::ProtocolUnsupported => "PROTOCOL_UNSUPPORTED",
            Self::AuthRequired => "AUTH_REQUIRED",
            Self::AuthInvalid => "AUTH_INVALID",
            Self::SessionStale => "SESSION_STALE",
            Self::CapabilityUnsupported => "CAPABILITY_UNSUPPORTED",
            Self::OperationUnsupported => "OPERATION_UNSUPPORTED",
            Self::AlreadyAttached => "ALREADY_ATTACHED",
            Self::ServiceUnavailable => "SERVICE_UNAVAILABLE",
        }
    }
}

/// A refusal, as it goes on the wire.
///
/// `details` carries technical context for a developer. It is built from what
/// the service knows about its own state and about the shape of the message —
/// never from a token, and never from a path.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl ProtocolError {
    pub fn new(code: ErrorCode, message: &str) -> Self {
        Self {
            code: code.as_str().to_owned(),
            message: message.to_owned(),
            details: None,
        }
    }

    pub fn with_details(code: ErrorCode, message: &str, details: String) -> Self {
        Self {
            code: code.as_str().to_owned(),
            message: message.to_owned(),
            details: Some(details),
        }
    }
}

/// One request, as the frontend sends it.
///
/// `session_id` and `token` are absent for a handshake and required for
/// everything else. The service decides that, not serde, so a missing field is
/// refused with `AUTH_REQUIRED` rather than `MESSAGE_MALFORMED`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub protocol: String,
    pub op: String,
    pub request_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// How a raw message was read.
#[derive(Debug)]
pub enum Decoded {
    Request(Box<Request>),
    Rejected {
        /// Recovered from the message when possible, so a refusal can still be
        /// correlated with the request that caused it; empty when it could not.
        request_id: String,
        error: ProtocolError,
    },
}

/// Pulls the request id out of a message that failed validation. Truncated,
/// because it is echoed back and nothing else validated it.
fn salvage_request_id(raw: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return String::new();
    };
    value
        .get("requestId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(MAX_REQUEST_ID_BYTES)
        .collect()
}

/// Parses and validates a raw inbound message.
///
/// The order is load-bearing and mirrored on the frontend: size, then JSON,
/// then the envelope shape, then the protocol version. A message that is too
/// large is never parsed, and a version mismatch is reported distinctly from a
/// malformed one so the UI can explain which of the two happened.
pub fn decode(raw: &str) -> Decoded {
    if raw.len() > MAX_MESSAGE_BYTES {
        return Decoded::Rejected {
            request_id: String::new(),
            error: ProtocolError::with_details(
                ErrorCode::MessageTooLarge,
                "The message is larger than the local service accepts.",
                format!("{} bytes; the limit is {MAX_MESSAGE_BYTES}", raw.len()),
            ),
        };
    }

    let request: Request = match serde_json::from_str(raw) {
        Ok(request) => request,
        Err(error) => {
            return Decoded::Rejected {
                request_id: salvage_request_id(raw),
                error: ProtocolError::with_details(
                    ErrorCode::MessageMalformed,
                    "The message is not a local service request.",
                    format!("at line {}, column {}", error.line(), error.column()),
                ),
            };
        }
    };

    if request.request_id.is_empty() {
        return Decoded::Rejected {
            request_id: String::new(),
            error: ProtocolError::new(
                ErrorCode::MessageMalformed,
                "The message carries no request id.",
            ),
        };
    }

    if request.request_id.len() > MAX_REQUEST_ID_BYTES {
        return Decoded::Rejected {
            request_id: String::new(),
            error: ProtocolError::with_details(
                ErrorCode::MessageMalformed,
                "The message's request id is longer than the local service accepts.",
                format!(
                    "{} bytes; the limit is {MAX_REQUEST_ID_BYTES}",
                    request.request_id.len()
                ),
            ),
        };
    }

    if request.protocol != PROTOCOL_VERSION {
        return Decoded::Rejected {
            request_id: request.request_id.clone(),
            error: ProtocolError::with_details(
                ErrorCode::ProtocolUnsupported,
                "The message uses a protocol version this service does not speak.",
                format!(
                    "expected {PROTOCOL_VERSION}, received {}",
                    request.protocol.chars().take(64).collect::<String>()
                ),
            ),
        };
    }

    Decoded::Request(Box::new(request))
}

/// Serializes a successful answer. The payload is already the op's own shape.
pub fn ok_response(request_id: &str, payload: serde_json::Value) -> String {
    serde_json::json!({
        "protocol": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": true,
        "payload": payload,
    })
    .to_string()
}

/// Serializes a refusal.
pub fn error_response(request_id: &str, error: &ProtocolError) -> String {
    serde_json::json!({
        "protocol": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": false,
        "error": error,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(protocol: &str, op: &str) -> String {
        serde_json::json!({
            "protocol": protocol,
            "op": op,
            "requestId": "request-1",
        })
        .to_string()
    }

    fn rejection(raw: &str) -> ProtocolError {
        match decode(raw) {
            Decoded::Rejected { error, .. } => error,
            Decoded::Request(_) => panic!("expected {raw} to be refused"),
        }
    }

    #[test]
    fn a_well_formed_request_is_accepted() {
        let raw = message(PROTOCOL_VERSION, "health");
        match decode(&raw) {
            Decoded::Request(request) => {
                assert_eq!(request.op, "health");
                assert_eq!(request.request_id, "request-1");
                assert_eq!(request.session_id, None);
                assert_eq!(request.token, None);
            }
            Decoded::Rejected { error, .. } => panic!("refused a valid request: {error:?}"),
        }
    }

    #[test]
    fn an_oversized_message_is_refused_without_being_parsed() {
        let raw = "x".repeat(MAX_MESSAGE_BYTES + 1);
        assert_eq!(rejection(&raw).code, ErrorCode::MessageTooLarge.as_str());
    }

    #[test]
    fn a_message_within_the_limit_is_still_read() {
        let padding = MAX_MESSAGE_BYTES - 1024;
        let raw = serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "op": "health",
            "requestId": "request-1",
            "payload": { "pad": "y".repeat(padding) },
        })
        .to_string();
        assert!(raw.len() <= MAX_MESSAGE_BYTES, "{} bytes", raw.len());
        assert!(matches!(decode(&raw), Decoded::Request(_)));
    }

    #[test]
    fn malformed_messages_are_refused_by_shape() {
        for raw in [
            "",
            "{",
            "not json",
            "[]",
            "null",
            "{\"protocol\":1}",
            "{\"op\":\"health\",\"requestId\":\"r\"}",
            "{\"protocol\":\"NOVA_LOCAL_SERVICE_V1\",\"requestId\":\"r\"}",
        ] {
            assert_eq!(
                rejection(raw).code,
                ErrorCode::MessageMalformed.as_str(),
                "{raw}"
            );
        }
    }

    #[test]
    fn an_empty_request_id_is_malformed() {
        let raw = serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "op": "health",
            "requestId": "",
        })
        .to_string();
        assert_eq!(rejection(&raw).code, ErrorCode::MessageMalformed.as_str());
    }

    #[test]
    fn a_request_id_the_service_would_have_to_echo_back_is_bounded() {
        let raw = serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "op": "health",
            "requestId": "x".repeat(MAX_REQUEST_ID_BYTES + 1),
        })
        .to_string();
        assert!(
            raw.len() < MAX_MESSAGE_BYTES,
            "the message itself is not oversized"
        );

        match decode(&raw) {
            Decoded::Rejected { request_id, error } => {
                assert_eq!(error.code, ErrorCode::MessageMalformed.as_str());
                assert_eq!(request_id, "", "an id that long is not echoed back either");
            }
            Decoded::Request(_) => panic!("expected a refusal"),
        }

        // One byte shorter is ordinary.
        let allowed = serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "op": "health",
            "requestId": "x".repeat(MAX_REQUEST_ID_BYTES),
        })
        .to_string();
        assert!(matches!(decode(&allowed), Decoded::Request(_)));
    }

    #[test]
    fn another_protocol_version_is_refused_distinctly() {
        let error = rejection(&message("NOVA_LOCAL_SERVICE_V2", "health"));
        assert_eq!(error.code, ErrorCode::ProtocolUnsupported.as_str());
        assert!(
            error.details.unwrap_or_default().contains("V2"),
            "the refusal names the version it was given"
        );
    }

    #[test]
    fn a_refusal_still_names_the_request_it_answers() {
        let raw = "{\"protocol\":\"NOVA_LOCAL_SERVICE_V1\",\"requestId\":\"request-9\"}";
        match decode(raw) {
            Decoded::Rejected { request_id, .. } => assert_eq!(request_id, "request-9"),
            Decoded::Request(_) => panic!("expected a refusal"),
        }
    }

    #[test]
    fn responses_carry_the_protocol_and_the_request_id() {
        let ok = ok_response("request-1", serde_json::json!({ "attached": true }));
        assert!(ok.contains(PROTOCOL_VERSION));
        assert!(ok.contains("\"requestId\":\"request-1\""));
        assert!(ok.contains("\"ok\":true"));

        let refused = error_response(
            "request-2",
            &ProtocolError::new(ErrorCode::AuthRequired, "No session."),
        );
        assert!(refused.contains("\"ok\":false"));
        assert!(refused.contains("AUTH_REQUIRED"));
        assert!(!refused.contains("\"details\""), "no details, no field");
    }

    #[test]
    fn every_error_code_has_a_distinct_wire_name() {
        let codes = [
            ErrorCode::MessageTooLarge,
            ErrorCode::MessageMalformed,
            ErrorCode::ProtocolUnsupported,
            ErrorCode::AuthRequired,
            ErrorCode::AuthInvalid,
            ErrorCode::SessionStale,
            ErrorCode::CapabilityUnsupported,
            ErrorCode::OperationUnsupported,
            ErrorCode::AlreadyAttached,
            ErrorCode::ServiceUnavailable,
        ];
        let mut seen = std::collections::HashSet::new();
        for code in codes {
            assert!(
                seen.insert(code.as_str()),
                "{} is duplicated",
                code.as_str()
            );
            assert!(!code.as_str().is_empty());
        }
    }
}
