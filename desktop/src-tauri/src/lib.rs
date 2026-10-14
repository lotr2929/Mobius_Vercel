// Mobius desktop shell, version 2: the live Mobius pages in a native window, with a door to local tools (MCP).
// The page can ask the shell who it is (shell_info) and, through the commands below, list and call the tools of the MCP servers
// named in mcp.json on this computer. Each command is listed in build.rs and in capabilities/default.json.
mod mcp;

use serde::Serialize;
use serde_json::Value;
use tauri::{Manager, State};

#[derive(Serialize)]
struct ShellInfo {
    name: &'static str,
    version: &'static str,
    // Bump when a command is added or changed in a way the pages must know about.
    api: u32,
    platform: &'static str,
    mcp: bool,
}

#[tauri::command]
fn shell_info() -> ShellInfo {
    ShellInfo { name: "mobius-desktop", version: env!("CARGO_PKG_VERSION"), api: 2, platform: std::env::consts::OS, mcp: true }
}

#[tauri::command]
async fn mcp_status(state: State<'_, mcp::Mcp>) -> Result<Vec<mcp::ServerStatus>, String> {
    Ok(state.status().await)
}

#[tauri::command]
async fn mcp_tools(state: State<'_, mcp::Mcp>) -> Result<Vec<mcp::ToolInfo>, String> {
    Ok(state.tools().await)
}

#[tauri::command]
async fn mcp_call(state: State<'_, mcp::Mcp>, name: String, arguments: Value) -> Result<String, String> {
    state.call(&name, arguments).await
}

#[tauri::command]
fn mcp_config_path(state: State<'_, mcp::Mcp>) -> String {
    state.config_path.to_string_lossy().to_string()
}

const EMPTY_CONFIG: &str = "{\n  \"servers\": {}\n}\n";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;
            let file = dir.join("mcp.json");
            if !file.exists() {
                std::fs::write(&file, EMPTY_CONFIG)?;
            }
            let cfg: mcp::Config = std::fs::read_to_string(&file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            app.manage(mcp::Mcp::new(cfg, file));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![shell_info, mcp_status, mcp_tools, mcp_call, mcp_config_path])
        .run(tauri::generate_context!())
        .expect("error while running the Mobius desktop shell");
}
