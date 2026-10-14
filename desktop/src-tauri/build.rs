fn main() {
    // Only the commands listed here can ever be called from a page. Each new local ability (MCP, folders) is added here on purpose.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["shell_info", "mcp_status", "mcp_tools", "mcp_call", "mcp_config_path"])),
    )
    .expect("failed to run tauri build");
}
