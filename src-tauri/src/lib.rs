mod commands;
mod local_service;

pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        // The updater, and the only thing in Nova that reaches the network. It
        // fetches from the one endpoint compiled into `tauri.conf.json` and
        // verifies every artifact against the public key beside it before
        // anything is written to disk, so an unsigned or tampered update is
        // refused here rather than trusted and run. `process` is what restarts
        // Nova into an installed update; the capability file grants it nothing
        // but `restart`.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // One instance for the life of the process, created before the window
        // opens. It holds the developer backend's session and nothing else;
        // dropping it with the process is the whole of its cleanup.
        .manage(local_service::LocalService::new())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::local_service_request
        ])
        .run(tauri::generate_context!())?;

    Ok(())
}
