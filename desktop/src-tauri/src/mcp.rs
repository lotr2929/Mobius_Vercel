// mcp.rs - a small MCP client for the Mobius desktop shell.
//
// MCP servers are separate programs that offer "tools" (list a folder, read a file...). This file starts them on this laptop, talks to them
// over their standard input and output (newline-separated JSON-RPC), and hands the page a short list of tools it may use.
//
// The rules that keep it safe live HERE, not in the page and not in the model:
//   - the servers and their tools come only from mcp.json on this computer (never from a web page);
//   - a tool is offered and callable only if it is named in that server's "allowTools"; an empty list offers nothing;
//   - each call has a time limit, and each answer is cut to a sensible length.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

const START_TIMEOUT: Duration = Duration::from_secs(40);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RESULT_CHARS: usize = 24_000;

fn yes() -> bool { true }

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServerCfg {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    // Only these tools are offered or callable. Empty = none.
    #[serde(default)]
    pub allow_tools: Vec<String>,
    // Tools that change things. Each call shows a box on screen and runs only if Boon clicks Allow.
    #[serde(default)]
    pub confirm_tools: Vec<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

#[derive(Deserialize, Default, Clone, Debug)]
pub struct Config {
    #[serde(default)]
    pub servers: HashMap<String, ServerCfg>,
}

struct Proc {
    #[allow(dead_code)]
    child: Child, // kept so the program is stopped when this is dropped (kill_on_drop)
    stdin: ChildStdin,
    out: BufReader<ChildStdout>,
    next_id: u64,
    tools: Vec<Value>,
}

type Slot = Arc<Mutex<Option<Proc>>>;

pub struct Mcp {
    cfg: Config,
    pub config_path: PathBuf,
    slots: HashMap<String, Slot>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String, // server__tool
    pub server: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub name: String,
    pub enabled: bool,
    pub running: bool,
    pub allowed_tools: Vec<String>,
}

async fn send(p: &mut Proc, msg: Value) -> Result<(), String> {
    let mut line = msg.to_string();
    line.push('\n');
    p.stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    p.stdin.flush().await.map_err(|e| e.to_string())
}

async fn rpc(p: &mut Proc, method: &str, params: Value) -> Result<Value, String> {
    p.next_id += 1;
    let id = p.next_id;
    send(p, json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
    let mut buf = String::new();
    loop {
        buf.clear();
        let n = p.out.read_line(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("the tool server stopped".into());
        }
        let v: Value = match serde_json::from_str(buf.trim()) {
            Ok(v) => v,
            Err(_) => continue, // a stray log line
        };
        if v.get("id") == Some(&json!(id)) && v.get("method").is_none() {
            if let Some(e) = v.get("error") {
                return Err(e.get("message").and_then(|m| m.as_str()).unwrap_or("tool server error").to_string());
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
        // anything else (a notification, a request from the server) is ignored
    }
}

async fn start(name: &str, cfg: &ServerCfg) -> Result<Proc, String> {
    let mut cmd = Command::new(&cfg.command);
    cmd.args(&cfg.args)
        .envs(&cfg.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no black console window
    let mut child = cmd.spawn().map_err(|e| format!("could not start '{name}' ({}): {e}", cfg.command))?;
    let stdin = child.stdin.take().ok_or("no input channel")?;
    let out = BufReader::new(child.stdout.take().ok_or("no output channel")?);
    let mut p = Proc { child, stdin, out, next_id: 0, tools: Vec::new() };

    let init = json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": { "name": "mobius-ai", "version": env!("CARGO_PKG_VERSION") }
    });
    timeout(START_TIMEOUT, rpc(&mut p, "initialize", init))
        .await
        .map_err(|_| format!("'{name}' did not start in time"))??;
    send(&mut p, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await?;
    let listed = timeout(START_TIMEOUT, rpc(&mut p, "tools/list", json!({})))
        .await
        .map_err(|_| format!("'{name}' did not list its tools in time"))??;
    p.tools = listed.get("tools").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    Ok(p)
}

fn text_of(result: &Value) -> (String, bool) {
    let is_err = result.get("isError").and_then(|b| b.as_bool()).unwrap_or(false);
    let mut parts: Vec<String> = Vec::new();
    if let Some(items) = result.get("content").and_then(|c| c.as_array()) {
        for it in items {
            match it.get("type").and_then(|t| t.as_str()) {
                Some("text") => parts.push(it.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string()),
                Some(other) => parts.push(format!("[{other} content not shown]")),
                None => {}
            }
        }
    }
    let mut s = parts.join("\n");
    if s.chars().count() > MAX_RESULT_CHARS {
        s = s.chars().take(MAX_RESULT_CHARS).collect::<String>() + "\n[cut: the result was longer than the limit]";
    }
    (s, is_err)
}

// Shows the exact action on screen and waits for Allow / Deny. No answer in two minutes counts as Deny.
async fn confirm(app: &tauri::AppHandle, server: &str, tool: &str, args: &Value) -> Result<(), String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let mut shown = serde_json::to_string_pretty(args).unwrap_or_default();
    if shown.chars().count() > 1200 {
        shown = shown.chars().take(1200).collect::<String>() + "\n...";
    }
    let msg = format!(
        "The assistant wants to change something on this computer.\n\nTool: {server} / {tool}\n\n{shown}\n\nAllow it?"
    );
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(msg)
        .title("Mobius AI - please confirm")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Deny".into()))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    match timeout(Duration::from_secs(120), rx).await {
        Ok(Ok(true)) => Ok(()),
        Ok(_) => Err("Boon declined this action. Nothing was changed.".into()),
        Err(_) => Err("No answer to the confirmation in time. Nothing was changed.".into()),
    }
}

impl Mcp {
    pub fn new(cfg: Config, config_path: PathBuf) -> Self {
        let slots = cfg.servers.keys().map(|k| (k.clone(), Arc::new(Mutex::new(None)))).collect();
        Mcp { cfg, config_path, slots }
    }

    pub async fn status(&self) -> Vec<ServerStatus> {
        let mut v = Vec::new();
        for (name, cfg) in &self.cfg.servers {
            let running = match self.slots.get(name) {
                Some(s) => s.lock().await.is_some(),
                None => false,
            };
            v.push(ServerStatus { name: name.clone(), enabled: cfg.enabled, running, allowed_tools: cfg.allow_tools.clone() });
        }
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    // Every tool the page may use, across all enabled servers (servers are started on first use).
    pub async fn tools(&self) -> Vec<ToolInfo> {
        let mut out = Vec::new();
        for (name, cfg) in &self.cfg.servers {
            if !cfg.enabled || cfg.allow_tools.is_empty() || name.contains("__") {
                continue;
            }
            let Some(slot) = self.slots.get(name) else { continue };
            let mut guard = slot.lock().await;
            if guard.is_none() {
                match start(name, cfg).await {
                    Ok(p) => *guard = Some(p),
                    Err(_) => continue,
                }
            }
            if let Some(p) = guard.as_ref() {
                for t in &p.tools {
                    let tname = t.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    if !cfg.allow_tools.iter().any(|a| a == tname) {
                        continue;
                    }
                    out.push(ToolInfo {
                        name: format!("{name}__{tname}"),
                        server: name.clone(),
                        description: t.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string(),
                        input_schema: t.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                    });
                }
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    pub async fn call(&self, app: &tauri::AppHandle, full: &str, args: Value) -> Result<String, String> {
        let (server, tool) = full.split_once("__").ok_or("unknown tool")?;
        let cfg = self.cfg.servers.get(server).ok_or("unknown tool server")?;
        if !cfg.enabled || !cfg.allow_tools.iter().any(|a| a == tool) {
            return Err(format!("the tool '{tool}' is not allowed"));
        }
        if cfg.confirm_tools.iter().any(|a| a == tool) {
            confirm(app, server, tool, &args).await?;
        }
        let slot = self.slots.get(server).ok_or("unknown tool server")?;
        let mut guard = slot.lock().await;
        if guard.is_none() {
            *guard = Some(start(server, cfg).await?);
        }
        let p = guard.as_mut().ok_or("tool server not running")?;
        let params = json!({ "name": tool, "arguments": if args.is_object() { args } else { json!({}) } });
        let res = timeout(CALL_TIMEOUT, rpc(p, "tools/call", params)).await;
        match res {
            Ok(Ok(v)) => {
                let (text, is_err) = text_of(&v);
                if is_err { Err(text) } else { Ok(text) }
            }
            Ok(Err(e)) => {
                *guard = None; // restart next time
                Err(e)
            }
            Err(_) => {
                *guard = None;
                Err("the tool took too long".into())
            }
        }
    }
}
