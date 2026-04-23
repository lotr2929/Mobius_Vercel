// ── js/webllm.js ──────────────────────────────────────────────────────────────
// WebLLM offline inference — phone / WebGPU devices only.
// NOT loaded by default. Include in index.html when needed:
//   <script src="js/webllm.js"></script>
//
// Provides: window.askLocal(messages, onStatus)
// Called by commands.js when model = 'webllm' and Ollama is unavailable.
// ─────────────────────────────────────────────────────────────────────────────

let webllmEngine = null, webllmReady = false, webllmLoading = false, webllmModel = null;

function selectWebLLMModel() {
    const isMobile = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent);
    const ram = navigator.deviceMemory || 4;
    return (isMobile || ram <= 4)
        ? 'Llama-3.2-1B-Instruct-q4f32_1-MLC'
        : 'Llama-3.2-3B-Instruct-q4f32_1-MLC';
}

async function detectOllama() {
    try {
        const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
        return r.ok;
    } catch { return false; }
}

async function askOllamaLocal(messages) {
    const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    const d = await r.json();
    const m = (d.models || [])[0]?.name || 'qwen2.5-coder:7b';
    const res = await fetch('http://localhost:11434/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, messages })
    });
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('No content from Ollama');
    return { reply: content, modelUsed: 'Ollama ' + m };
}

async function initWebLLM(onProgress) {
    if (webllmReady) return true;
    if (webllmLoading) {
        while (webllmLoading) await new Promise(r => setTimeout(r, 200));
        return webllmReady;
    }
    webllmLoading = true;
    const { CreateMLCEngine } = await import('https://esm.run/@mlc-ai/web-llm');
    webllmModel = selectWebLLMModel();
    try {
        webllmEngine = await CreateMLCEngine(webllmModel, {
            initProgressCallback: info => { if (onProgress) onProgress(info.text || String(info)); }
        });
        webllmReady = true;
        webllmLoading = false;
        return true;
    } catch (err) {
        webllmLoading = false;
        throw err;
    }
}

async function askWebLLMLocal(messages) {
    if (!webllmReady) throw new Error('WebLLM not ready');
    const result = await webllmEngine.chat.completions.create({ messages });
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new Error('No content from WebLLM');
    return { reply: content, modelUsed: 'WebLLM ' + webllmModel };
}

window.promptWebLLMInstall = function() {
    return new Promise(resolve => {
        if (localStorage.getItem('webllm_consent') === '1') { resolve(true); return; }
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:10000;display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:var(--surface);border:1px solid var(--border2);border-radius:2px;padding:24px 28px;max-width:420px;width:90%;font-family:var(--font);color:var(--text);';
        box.innerHTML = `
            <div style="font-size:17px;font-weight:bold;margin-bottom:12px;">Enable Offline AI?</div>
            <div style="font-size:14px;line-height:1.6;margin-bottom:18px;">
                One-time download of a local AI model (~1.5-4.5 GB). Stored in browser cache.
            </div>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
                <button id="wllm-cancel" style="padding:6px 18px;background:transparent;border:1px solid var(--border2);border-radius:1px;color:var(--border2);cursor:pointer;font-family:inherit;font-size:14px;">Cancel</button>
                <button id="wllm-ok" style="padding:6px 18px;background:var(--green);border:none;border-radius:1px;color:#fff;cursor:pointer;font-family:inherit;font-size:14px;">Download &amp; Enable</button>
            </div>`;
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        document.getElementById('wllm-ok').onclick = () => {
            localStorage.setItem('webllm_consent', '1');
            document.body.removeChild(overlay);
            resolve(true);
        };
        document.getElementById('wllm-cancel').onclick = () => {
            document.body.removeChild(overlay);
            resolve(false);
        };
    });
};

window.askLocal = async function(messages, onStatus) {
    const isMobile = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent);
    if (!isMobile) {
        onStatus('Checking for Ollama...');
        if (await detectOllama()) { onStatus('Using Ollama...'); return await askOllamaLocal(messages); }
        onStatus('Ollama not running - trying WebGPU...');
    }
    if (!navigator.gpu) throw new Error(
        isMobile ? 'WebGPU not supported. Try Ask: Groq.' : 'No local AI. Ollama not running and WebGPU not supported.'
    );
    if (!webllmReady && !webllmLoading) {
        const consent = await window.promptWebLLMInstall();
        if (!consent) throw new Error('Offline AI install cancelled.');
    }
    if (!webllmReady) await initWebLLM(msg => onStatus(msg));
    onStatus('Running local AI...');
    return await askWebLLMLocal(messages);
};
