#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = nova_lib::run() {
        eprintln!("Nova failed to start: {error}");
        std::process::exit(1);
    }
}
