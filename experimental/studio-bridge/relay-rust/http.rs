//! A deliberately small, strict HTTP/1.1 reader and writer for the loopback
//! development bridge.
//!
//! The bridge speaks to exactly one kind of client — the Nova Studio plugin
//! using Roblox `HttpService` — over the loopback interface, so this module
//! implements only what that needs and refuses everything else: fixed
//! `Content-Length` bodies (no chunked transfer), a capped head and body, one
//! request per connection and no keep-alive. Being narrow is the point: there
//! is no general-purpose server here to get wrong.

use std::io::{BufRead, BufReader, Read, Write};

#[derive(Debug, PartialEq, Eq)]
pub enum RequestError {
    /// The request line, headers or body were not something we accept.
    Malformed,
    /// The head exceeded the configured cap.
    HeadTooLarge,
    /// The declared body exceeded the configured cap.
    BodyTooLarge,
    /// A feature we deliberately do not implement, such as chunked transfer.
    Unsupported,
    Io,
}

/// The request line and headers, before the body is read.
pub struct Head {
    pub method: String,
    pub path: String,
    /// Header names are lowercased; values are trimmed.
    pub headers: Vec<(String, String)>,
}

pub struct Request {
    pub method: String,
    pub path: String,
    /// Header names are lowercased; values are trimmed.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// Parses the request line and headers of an already-read head block.
pub fn parse_head(head: &str) -> Result<Head, RequestError> {
    let mut lines = head.split("\r\n").filter(|line| !line.is_empty());
    let request_line = lines.next().ok_or(RequestError::Malformed)?;

    let mut parts = request_line.split(' ');
    let method = parts.next().ok_or(RequestError::Malformed)?;
    let path = parts.next().ok_or(RequestError::Malformed)?;
    let version = parts.next().ok_or(RequestError::Malformed)?;
    if parts.next().is_some() || !version.starts_with("HTTP/1.") {
        return Err(RequestError::Malformed);
    }
    if method.is_empty() || !path.starts_with('/') {
        return Err(RequestError::Malformed);
    }

    let mut headers = Vec::new();
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(RequestError::Malformed)?;
        if name.is_empty() || name.trim() != name {
            return Err(RequestError::Malformed);
        }
        headers.push((name.to_ascii_lowercase(), value.trim().to_owned()));
    }

    Ok(Head {
        method: method.to_owned(),
        path: path.to_owned(),
        headers,
    })
}

/// Reads one complete request. A body larger than `max_body` is refused
/// without being read; the caller decides how much of it to drain.
pub fn read_request<R: Read>(
    reader: &mut BufReader<R>,
    max_head: usize,
    max_body: usize,
) -> Result<Request, RequestError> {
    let mut head = String::new();
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).map_err(|_| RequestError::Io)?;
        if read == 0 {
            return Err(RequestError::Malformed);
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if head.len() + line.len() > max_head {
            return Err(RequestError::HeadTooLarge);
        }
        head.push_str(line.trim_end_matches('\n').trim_end_matches('\r'));
        head.push_str("\r\n");
    }

    let Head {
        method,
        path,
        headers,
    } = parse_head(&head)?;

    if headers.iter().any(|(name, _)| name == "transfer-encoding") {
        return Err(RequestError::Unsupported);
    }

    let declared = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map(|(_, value)| value.parse::<u64>().map_err(|_| RequestError::Malformed))
        .transpose()?
        .unwrap_or(0);

    if declared > max_body as u64 {
        return Err(RequestError::BodyTooLarge);
    }

    let mut body = vec![0_u8; declared as usize];
    reader.read_exact(&mut body).map_err(|_| RequestError::Io)?;
    let body = String::from_utf8(body).map_err(|_| RequestError::Malformed)?;

    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        429 => "Too Many Requests",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    }
}

/// Writes a complete response and closes the exchange. Every response is
/// non-cacheable and closes the connection; the bridge never keeps one alive.
pub fn write_response<W: Write>(out: &mut W, status: u16, body: &str) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nConnection: close\r\nCache-Control: no-store\r\n",
        reason(status)
    );
    if status == 204 {
        head.push_str("Content-Length: 0\r\n\r\n");
        out.write_all(head.as_bytes())?;
        return out.flush();
    }
    head.push_str("Content-Type: application/json; charset=utf-8\r\n");
    head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
    out.write_all(head.as_bytes())?;
    out.write_all(body.as_bytes())?;
    out.flush()
}

/// A small JSON error body. Values are fixed strings, so no escaping is needed.
pub fn error_body(code: &str) -> String {
    format!("{{\"transportError\":\"{code}\"}}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(raw: &str) -> Result<Request, RequestError> {
        let mut reader = BufReader::new(raw.as_bytes());
        read_request(&mut reader, 8 * 1024, 1024)
    }

    #[test]
    fn reads_a_well_formed_request() {
        let request = read("POST /nova/rpc HTTP/1.1\r\nHost: 127.0.0.1:52700\r\nContent-Length: 2\r\nX-Nova-Token: abc\r\n\r\n{}")
            .expect("parses");
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/nova/rpc");
        assert_eq!(request.body, "{}");
        assert_eq!(request.header("x-nova-token"), Some("abc"));
        assert_eq!(request.header("host"), Some("127.0.0.1:52700"));
        assert_eq!(request.header("missing"), None);
    }

    #[test]
    fn header_names_are_case_insensitive() {
        let request = read("GET /nova/info HTTP/1.1\r\nHOST: localhost:1\r\n\r\n").expect("parses");
        assert_eq!(request.header("host"), Some("localhost:1"));
    }

    #[test]
    fn a_body_may_be_absent() {
        let request = read("GET /nova/info HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n").expect("parses");
        assert_eq!(request.body, "");
    }

    #[test]
    fn rejects_malformed_requests() {
        for raw in [
            "GARBAGE\r\n\r\n",
            "POST nova/rpc HTTP/1.1\r\n\r\n",
            "POST /nova/rpc HTTP/2\r\n\r\n",
            "POST /nova/rpc HTTP/1.1 extra\r\n\r\n",
            "POST /nova/rpc HTTP/1.1\r\nBadHeader\r\n\r\n",
            "POST /nova/rpc HTTP/1.1\r\nContent-Length: many\r\n\r\n",
        ] {
            assert_eq!(read(raw).err(), Some(RequestError::Malformed), "{raw}");
        }
    }

    #[test]
    fn rejects_chunked_transfer() {
        let raw = "POST /nova/rpc HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert_eq!(read(raw).err(), Some(RequestError::Unsupported));
    }

    #[test]
    fn rejects_an_oversized_body() {
        let raw = "POST /nova/rpc HTTP/1.1\r\nContent-Length: 99999\r\n\r\n";
        assert_eq!(read(raw).err(), Some(RequestError::BodyTooLarge));
    }

    #[test]
    fn rejects_an_oversized_head() {
        let filler = "X-Pad: ".to_owned() + &"a".repeat(9000) + "\r\n";
        let raw = format!("POST /nova/rpc HTTP/1.1\r\n{filler}\r\n");
        let mut reader = BufReader::new(raw.as_bytes());
        assert_eq!(
            read_request(&mut reader, 8 * 1024, 1024).err(),
            Some(RequestError::HeadTooLarge)
        );
    }

    #[test]
    fn writes_a_closing_response() {
        let mut out = Vec::new();
        write_response(&mut out, 200, "{\"ok\":true}").expect("writes");
        let text = String::from_utf8(out).expect("utf-8");
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(text.contains("Connection: close\r\n"));
        assert!(text.contains("Cache-Control: no-store\r\n"));
        assert!(text.contains("Content-Length: 11\r\n"));
        assert!(text.ends_with("\r\n\r\n{\"ok\":true}"));
    }

    #[test]
    fn writes_an_empty_no_content_response() {
        let mut out = Vec::new();
        write_response(&mut out, 204, "").expect("writes");
        let text = String::from_utf8(out).expect("utf-8");
        assert!(text.starts_with("HTTP/1.1 204 No Content\r\n"));
        assert!(!text.contains("Content-Type"));
        assert!(text.ends_with("\r\n\r\n"));
    }

    #[test]
    fn error_bodies_are_fixed_json() {
        assert_eq!(
            error_body("PAYLOAD_TOO_LARGE"),
            "{\"transportError\":\"PAYLOAD_TOO_LARGE\"}"
        );
    }
}
