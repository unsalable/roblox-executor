use serde::Serialize;
use tauri::{AppHandle, State};

use crate::local_service::LocalService;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: String,
    version: String,
    tauri_version: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let package = app.package_info();

    AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
        tauri_version: tauri::VERSION.to_string(),
    }
}

/// The whole surface of the local developer service: one raw protocol message
/// in, one raw protocol message out.
///
/// Raw text rather than a typed argument on purpose. The size limit, the
/// malformed-message refusal and the protocol-version check are the service's
/// own rules, checked by the service and unit-tested there; a typed argument
/// would hand those three decisions to serde before the service ever saw the
/// message, and two of them would come back as an untyped rejected promise.
///
/// It never returns `Err`: every refusal is a well-formed response envelope
/// carrying a stable code, so the frontend always has something it can present.
/// The command is synchronous because every operation is a short state read or
/// write under one mutex — nothing here waits on anything.
#[tauri::command]
pub fn local_service_request(service: State<'_, LocalService>, message: String) -> String {
    service.handle(&message)
}
