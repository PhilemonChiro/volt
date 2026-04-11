const vscode = require('vscode');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const { LanguageClient } = require('vscode-languageclient/node');

// Resolve paths — cross-platform, no hardcoded user paths
const VOLT_ROOT = path.resolve(__dirname, '..');
const VOLT_CLI = path.join(VOLT_ROOT, 'cli', 'volt');
const IS_WINDOWS = process.platform === 'win32';
const PYTHON = process.env.VOLT_PYTHON || (IS_WINDOWS ? 'python' : 'python3');
const LSP_SERVER = path.join(__dirname, 'server', 'volt_lsp.py');
const VOLT_HOME = process.env.VOLT_HOME || path.join(os.homedir(), '.volt');

let lspClient = null;
let sidebarProvider = null;
let monitorProcess = null;
const chipCache = {};  // port -> detected chip name (persists across scans)

// ============================================================
// Run volt commands and capture output
// ============================================================

function getCwd() {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.fileName.endsWith('.volt'))
        return path.dirname(editor.document.fileName);
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0)
        return vscode.workspace.workspaceFolders[0].uri.fsPath;
    return VOLT_ROOT;
}

function runCommand(command, callback) {
    const cwd = getCwd();
    const idfPath = process.env.IDF_PATH || path.join(VOLT_HOME, 'toolchains', 'esp-idf');
    let fullCmd;
    if (IS_WINDOWS) {
        // Windows: use export.bat or call idf.py directly
        const exportBat = path.join(idfPath, 'export.bat');
        fullCmd = `"${exportBat}" && cd /d "${cwd}" && ${PYTHON} "${VOLT_CLI}" ${command}`;
    } else {
        // Linux/macOS: source export.sh
        const exportSh = path.join(idfPath, 'export.sh');
        fullCmd = `source "${exportSh}" > /dev/null 2>&1 && cd "${cwd}" && ${PYTHON} "${VOLT_CLI}" ${command}`;
    }
    const startTime = Date.now();

    if (sidebarProvider) {
        sidebarProvider.sendEvent('commandStart', { command });
    }

    // Stream output line by line using spawn
    const shell = IS_WINDOWS ? 'cmd' : 'bash';
    const shellFlag = IS_WINDOWS ? '/c' : '-c';
    const proc = spawn(shell, [shellFlag, fullCmd], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let allOutput = '';

    function processLine(line) {
        const clean = line.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
        if (!clean) return;
        allOutput += clean + '\n';

        if (!sidebarProvider) return;

        // Parse and send structured events
        // Build: ninja progress [N/M]
        const ninjaMatch = clean.match(/\[(\d+)\/(\d+)\]/);
        if (ninjaMatch) {
            const current = parseInt(ninjaMatch[1]);
            const total = parseInt(ninjaMatch[2]);
            sidebarProvider.sendEvent('buildProgress', { current, total, pct: Math.round(current / total * 100) });
            return;
        }

        // Flash: Writing at... (XX%)
        const flashMatch = clean.match(/Writing at.*\((\d+)\s*%\)/);
        if (flashMatch) {
            sidebarProvider.sendEvent('flashProgress', { pct: parseInt(flashMatch[1]) });
            return;
        }

        // Transpile time
        const transpileMatch = clean.match(/Transpile.*?(\d+ms)/);
        if (transpileMatch) {
            sidebarProvider.sendEvent('stepDone', { step: 'transpile', time: transpileMatch[1] });
            return;
        }

        // Compile time
        const compileMatch = clean.match(/Compile.*?([\d.]+s)/);
        if (compileMatch) {
            sidebarProvider.sendEvent('stepDone', { step: 'compile', time: compileMatch[1] });
            return;
        }

        // Flash size
        const sizeMatch = clean.match(/Flash:.*?([\d.]+%)/);
        if (sizeMatch) {
            sidebarProvider.sendEvent('flashSize', { pct: sizeMatch[1] });
            return;
        }

        // These are handled by collecting multi-line messages below
        // Single-line success
        if (clean.includes('Build successful') || clean.includes('Flashed')) {
            sidebarProvider.sendEvent('success', { text: clean });
            return;
        }
    }

    proc.stdout.on('data', data => {
        data.toString().split('\n').forEach(processLine);
    });

    proc.stderr.on('data', data => {
        data.toString().split('\n').forEach(processLine);
    });

    proc.on('close', code => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (sidebarProvider) {
            // Parse multi-line warning/error blocks from collected output
            const blocks = allOutput.split(/(?=-- (?:HARDWARE WARNING|HARDWARE ERROR|HARDWARE NOTE|TYPE MISMATCH|NAME ERROR|TASK ERROR|STATE MACHINE ERROR|CONCURRENCY) --)/);
            for (const block of blocks) {
                const headerMatch = block.match(/-- ([\w\s]+) -- ([\w.]+):(\d+)/);
                if (!headerMatch) continue;

                const category = headerMatch[1].trim();
                const file = headerMatch[2];
                const line = parseInt(headerMatch[3]);

                // Extract the message (first non-empty line after header)
                const lines = block.split('\n');
                let message = '';
                let hint = '';
                let codeLine = '';
                for (let i = 1; i < lines.length; i++) {
                    const l = lines[i].trim();
                    if (!l) continue;
                    if (l.startsWith('Hint:')) { hint = l.substring(5).trim(); continue; }
                    if (l.match(/^\d+\s*\|/) || l.match(/^\s*\|?\s*\^/)) {
                        if (l.match(/^\d+\s*\|/)) codeLine = l.trim();
                        continue;
                    }
                    if (!message && !l.startsWith('--')) message = l;
                }

                const isError = category.includes('ERROR');
                sidebarProvider.sendEvent(isError ? 'error' : 'warning', {
                    category,
                    file,
                    line,
                    message: message || category,
                    hint,
                    codeLine,
                });
            }

            sidebarProvider.sendEvent('commandEnd', { command, success: code === 0, elapsed });
        }
        if (callback) callback(code !== 0 ? new Error('exit ' + code) : null, allOutput);
    });

    return proc;
}

function scanDevices() {
    const cmd = `${PYTHON} -c "
import json, sys, subprocess
try:
    import serial.tools.list_ports
except ImportError:
    print('[]'); sys.exit(0)

# Known MCU vendor IDs
MCU_VIDS = {0x10C4, 0x1A86, 0x0403, 0x2E8A, 0x0483, 0x303A, 0x2341, 0x239A, 0x1D50}

def detect_from_usb(vid, pid):
    if vid == 0x2E8A: return 'rp2040'
    if vid == 0x0483: return 'stm32'
    if vid == 0x303A: return 'esp32s3'
    return None

devices = []
for p in serial.tools.list_ports.comports():
    desc = (p.description or '').lower()
    vid = p.vid or 0
    is_mcu = vid in MCU_VIDS
    is_mcu = is_mcu or any(c in desc for c in ['cp210', 'ch340', 'ch910', 'ftdi'])
    is_mcu = is_mcu or 'ttyACM' in p.device
    if is_mcu:
        chip = detect_from_usb(vid, p.pid or 0)
        if not chip:
            try:
                r = subprocess.run([sys.executable, '-m', 'esptool', '--port', p.device, 'chip-id'],
                                   capture_output=True, text=True, timeout=8)
                out = r.stdout + r.stderr
                for line in out.splitlines():
                    low = line.lower()
                    if 'detecting chip type' in low or 'chip type:' in low:
                        for c in ['esp32s3','esp32s2','esp32c3','esp32c6','esp32h2','esp32','esp8266']:
                            if c in low.replace('-','').replace(' ',''):
                                chip = c
                                break
                    if chip: break
            except: pass
        devices.append({'port': p.device, 'desc': p.description or '', 'chip': chip or 'unknown'})
print(json.dumps(devices))
"`;

    exec(cmd, { timeout: 15000 }, (err, stdout) => {
        if (sidebarProvider) {
            try {
                const devices = JSON.parse(stdout.trim());
                // Cache chip results so the poller doesn't re-detect
                devices.forEach(d => { chipCache[d.port] = d.chip || 'unknown'; });
                sidebarProvider.sendEvent('deviceList', { devices });
            } catch (e) {
                sidebarProvider.sendEvent('deviceList', { devices: [] });
            }
        }
    });
}

function startMonitor() {
    stopMonitor();

    const port = '/dev/ttyUSB0';
    if (sidebarProvider) {
        sidebarProvider.appendOutput(`\n⟫ Monitoring ${port}...\n`, 'command');
        sidebarProvider.updateState({ monitoring: true });
    }

    monitorProcess = spawn(PYTHON, ['-c', `
import serial, sys
ser = serial.Serial('${port}', 115200, timeout=1)
while True:
    line = ser.readline()
    if line:
        sys.stdout.write(line.decode('utf-8', errors='replace'))
        sys.stdout.flush()
`], { stdio: ['pipe', 'pipe', 'pipe'] });

    monitorProcess.stdout.on('data', (data) => {
        const text = data.toString().replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
        if (sidebarProvider) sidebarProvider.appendOutput(text, 'monitor');
    });

    monitorProcess.stderr.on('data', (data) => {
        if (sidebarProvider) sidebarProvider.appendOutput(data.toString(), 'error');
    });

    monitorProcess.on('close', () => {
        if (sidebarProvider) {
            sidebarProvider.appendOutput('\n— Monitor stopped —\n', 'info');
            sidebarProvider.updateState({ monitoring: false });
        }
        monitorProcess = null;
    });
}

function stopMonitor() {
    if (monitorProcess) {
        monitorProcess.kill();
        monitorProcess = null;
    }
    if (sidebarProvider) sidebarProvider.updateState({ monitoring: false });
}

// ============================================================
// Sidebar Webview Provider
// ============================================================

class VoltSidebarProvider {
    constructor(extensionUri) {
        this._extensionUri = extensionUri;
        this._view = null;
        this._state = { monitoring: false };
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };
        const logoUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'icon_no_bg.png')
        );
        webviewView.webview.html = this._getHtml(logoUri);

        webviewView.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'build':
                    runCommand('build');
                    break;
                case 'flash':
                    stopMonitor();
                    setTimeout(() => runCommand('flash'), 300);
                    break;
                case 'run':
                    stopMonitor();
                    setTimeout(() => {
                        runCommand('build', (err) => {
                            if (!err) {
                                runCommand('flash', (err2) => {
                                    if (!err2) startMonitor();
                                });
                            }
                        });
                    }, 300);
                    break;
                case 'monitor': startMonitor(); break;
                case 'stop': stopMonitor(); break;
                case 'check': runCommand('check'); break;
                case 'devices': scanDevices(); break;
                case 'showGenerated': runCommand('build --show'); break;
                case 'clear': break; // handled in webview
                case 'newProject':
                    vscode.window.showInputBox({ prompt: 'Project name' }).then(name => {
                        if (!name) return;
                        const cwd = getCwd();
                        const projectPath = path.join(cwd, name);
                        runCommand(`new ${name}`);
                        // Open the new project folder in VS Code after creation
                        setTimeout(() => {
                            const uri = vscode.Uri.file(projectPath);
                            vscode.commands.executeCommand('vscode.openFolder', uri, false);
                        }, 1500);
                    });
                    break;
                case 'openFile':
                    if (message.path) {
                        vscode.workspace.openTextDocument(message.path).then(doc => {
                            vscode.window.showTextDocument(doc);
                        });
                    }
                    break;
                case 'openLine':
                    // Click-to-go: open the current .volt file at the specified line
                    const voltFiles = [];
                    const cwdPath = getCwd();
                    const fs = require('fs');
                    try {
                        for (const f of fs.readdirSync(cwdPath)) {
                            if (f.endsWith('.volt')) voltFiles.push(path.join(cwdPath, f));
                        }
                    } catch(e) {}
                    if (voltFiles.length > 0) {
                        vscode.workspace.openTextDocument(voltFiles[0]).then(doc => {
                            const lineNum = Math.max(0, (message.line || 1) - 1);
                            vscode.window.showTextDocument(doc, {
                                selection: new vscode.Range(lineNum, 0, lineNum, 0),
                            });
                        });
                    }
                    break;
            }
        });

        // Send initial file list and scan devices
        this._sendFileList();
        scanDevices();

        // Watch for file changes
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.volt');
        watcher.onDidChange(() => this._sendFileList());
        watcher.onDidCreate(() => this._sendFileList());
        watcher.onDidDelete(() => this._sendFileList());

        // Re-scan when editor changes
        vscode.window.onDidChangeActiveTextEditor(() => this._sendFileList());

        // Re-send data when sidebar becomes visible again
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._sendFileList();
                scanDevices();
            }
        });
    }

    _sendFileList() {
        if (!this._view) return;
        const fs = require('fs');
        const files = [];

        // Search all workspace folders, not just getCwd()
        const searchRoots = [];

        // 1. Workspace folders
        if (vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                searchRoots.push(folder.uri.fsPath);
            }
        }

        // 2. Active editor's directory
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.fileName.endsWith('.volt')) {
            const dir = path.dirname(editor.document.fileName);
            if (!searchRoots.includes(dir)) searchRoots.push(dir);
        }

        // 3. Fallback: home dev directory
        if (searchRoots.length === 0) {
            searchRoots.push(VOLT_ROOT);
        }

        const seen = new Set();

        function scan(dir, prefix, depth) {
            if (depth > 4) return; // don't go too deep
            try {
                for (const entry of fs.readdirSync(dir)) {
                    const full = path.join(dir, entry);
                    if (seen.has(full)) continue;

                    const stat = fs.statSync(full);
                    if (stat.isFile() && entry.endsWith('.volt')) {
                        seen.add(full);
                        files.push({ name: prefix ? `${prefix}/${entry}` : entry, path: full });
                    } else if (stat.isDirectory() &&
                               !entry.startsWith('.') &&
                               !['node_modules', 'build', '__pycache__', '.venv', 'compiler'].includes(entry)) {
                        scan(full, prefix ? `${prefix}/${entry}` : entry, depth + 1);
                    }
                }
            } catch (e) {}
        }

        for (const root of searchRoots) {
            scan(root, '', 0);
        }

        // Sort: files in current dir first, then by name
        files.sort((a, b) => a.name.localeCompare(b.name));

        this._view.webview.postMessage({ type: 'fileList', files });
    }

    sendEvent(eventType, data) {
        if (this._view) {
            this._view.webview.postMessage({ type: eventType, ...data });
        }
    }

    appendOutput(text, kind) {
        if (this._view) {
            this._view.webview.postMessage({ type: 'output', text, kind });
        }
    }

    updateState(newState) {
        this._state = { ...this._state, ...newState };
        if (this._view) {
            this._view.webview.postMessage({ type: 'stateUpdate', state: this._state });
        }
    }

    _getHtml(logoUri) {
        return `<!DOCTYPE html>
<html>
<head>
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
        font-size: 12px;
        padding-bottom: 4px;
    }

    .section {
        border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
    }
    .section-header {
        display: flex;
        align-items: center;
        padding: 6px 12px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--vscode-sideBarSectionHeader-foreground);
        background: var(--vscode-sideBarSectionHeader-background);
        cursor: pointer;
        user-select: none;
    }
    .section-header:hover { opacity: 0.85; }
    .section-header .chevron { margin-right: 4px; font-size: 10px; transition: transform 0.15s; }
    .section-header .chevron.collapsed { transform: rotate(-90deg); }
    .section-body { padding: 4px 0; }
    .section-body.collapsed { display: none; }

    .btn {
        display: flex;
        align-items: center;
        width: calc(100% - 16px);
        margin: 1px 8px;
        padding: 4px 8px;
        border: none;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: transparent;
    }
    .btn:hover { background: var(--vscode-list-hoverBackground); }
    .btn-icon { width: 18px; text-align: center; margin-right: 6px; font-size: 12px; }
    .btn-key { margin-left: auto; font-size: 10px; opacity: 0.35; }
    .btn-primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        padding: 6px 8px;
        margin: 4px 8px;
        font-weight: 500;
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-stop {
        background: #c53030;
        color: white;
        padding: 6px 8px;
        margin: 4px 8px;
    }
    .btn-stop:hover { background: #e53e3e; }
    .btn-pair { display: flex; gap: 4px; padding: 2px 8px; }
    .btn-pair .btn { flex: 1; margin: 0; }

    /* Output area */
    .output-wrap {
        max-height: 300px;
        overflow-y: auto;
        background: var(--vscode-editor-background);
    }
    .output { padding: 8px 10px; }

    /* Build steps */
    .step { display: flex; align-items: center; padding: 3px 0; font-size: 11px; }
    .step-icon { width: 18px; text-align: center; margin-right: 6px; }
    .step-done .step-icon { color: #4ec9b0; }
    .step-fail .step-icon { color: #f44747; }
    .step-run .step-icon { color: var(--vscode-focusBorder); }
    .spinner {
        display: inline-block;
        width: 12px;
        height: 12px;
        border: 2px solid var(--vscode-sideBarSectionHeader-border);
        border-top-color: var(--vscode-focusBorder);
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Progress bar pulse animation when active */
    .progress-bar.active .progress-fill {
        background: linear-gradient(90deg, var(--vscode-focusBorder) 0%, var(--vscode-button-background) 50%, var(--vscode-focusBorder) 100%);
        background-size: 200% 100%;
        animation: shimmer 1.5s ease-in-out infinite;
    }
    @keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
    .step-time { margin-left: auto; font-size: 10px; opacity: 0.5; font-family: var(--vscode-editor-font-family); }

    /* Progress bar */
    .progress-bar { height: 4px; background: var(--vscode-editorWidget-border); border-radius: 2px; margin: 6px 0; overflow: hidden; }
    .progress-fill { height: 100%; background: var(--vscode-focusBorder); border-radius: 2px; transition: width 0.3s; }

    /* Result badge */
    .result { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 3px; font-size: 11px; margin: 4px 0; }
    .result-ok { background: rgba(78,201,176,0.15); color: #4ec9b0; }
    .result-err { background: rgba(244,71,71,0.15); color: #f44747; }
    .result-warn { background: rgba(204,167,0,0.15); color: #cca700; }

    /* Diagnostic cards (warnings/errors) */
    .diag-card {
        margin: 4px 0;
        padding: 6px 8px;
        border-radius: 4px;
        font-size: 11px;
        border-left: 3px solid;
        transition: background 0.1s;
    }
    .diag-card:hover { filter: brightness(1.1); }
    .diag-card.result-warn {
        background: rgba(204,167,0,0.08);
        border-left-color: #cca700;
    }
    .diag-card.result-err {
        background: rgba(244,71,71,0.08);
        border-left-color: #f44747;
    }
    .diag-header {
        display: flex;
        align-items: flex-start;
        gap: 6px;
    }
    .diag-icon { font-size: 12px; flex-shrink: 0; }
    .diag-title {
        flex: 1;
        line-height: 1.4;
        word-break: break-word;
    }
    .diag-loc {
        flex-shrink: 0;
        font-size: 10px;
        opacity: 0.5;
        font-family: var(--vscode-editor-font-family);
        white-space: nowrap;
    }
    .diag-code {
        margin-top: 4px;
        padding: 3px 6px;
        background: rgba(0,0,0,0.15);
        border-radius: 3px;
        font-family: var(--vscode-editor-font-family);
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
        overflow-x: auto;
    }
    .diag-hint {
        margin-top: 3px;
        font-size: 10px;
        color: var(--vscode-terminal-ansiCyan);
        line-height: 1.3;
    }

    /* Log entries */
    .log-entry { display: flex; align-items: baseline; font-size: 11px; font-family: var(--vscode-editor-font-family); padding: 1px 0; line-height: 1.4; }
    .log-time { color: var(--vscode-descriptionForeground); margin-right: 6px; font-size: 10px; min-width: 70px; }
    .log-level { padding: 0 4px; border-radius: 2px; font-size: 9px; font-weight: 600; margin-right: 6px; }
    .log-info { background: rgba(78,201,176,0.2); color: #4ec9b0; }
    .log-warn { background: rgba(204,167,0,0.2); color: #cca700; }
    .log-error { background: rgba(244,71,71,0.2); color: #f44747; }
    .log-debug { background: rgba(150,150,150,0.15); color: var(--vscode-descriptionForeground); }
    .log-msg { color: var(--vscode-foreground); word-break: break-all; }

    /* Device cards */
    .device-card {
        padding: 6px 8px;
        margin: 3px 0;
        border-radius: 4px;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-sideBarSectionHeader-border);
    }
    .device-header {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
    }
    .device-chip {
        font-weight: 600;
        font-size: 12px;
        color: #4ec9b0;
    }
    .device-port {
        font-family: var(--vscode-editor-font-family);
        font-size: 10px;
        opacity: 0.5;
        margin-left: auto;
    }
    .device-desc {
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
        padding: 2px 0 0 14px;
        line-height: 1.3;
    }

    .dot {
        width: 6px; height: 6px; border-radius: 50%;
        display: inline-block; margin-right: 3px;
    }
    .dot-g { background: #4ec9b0; }
    .dot-r { background: #f44747; }
</style>
</head>
<body>

<!-- HEADER -->
<div style="padding:10px 14px 8px;text-align:center;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border)">
    <img src="${logoUri}" width="28" height="28" style="vertical-align:middle;margin-right:6px" />
    <span style="font-size:18px;font-weight:700;letter-spacing:1px;color:var(--vscode-foreground);vertical-align:middle">Volt</span>
    <div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px">Typed Language for Embedded Systems</div>
</div>

<!-- BUILD & DEPLOY -->
<div class="section">
    <div class="section-header" onclick="toggle(this)">
        <span class="chevron">▾</span> Build & Deploy
    </div>
    <div class="section-body">
        <button class="btn btn-primary" onclick="send('run')">
            <span class="btn-icon">▶</span> Run
            <span class="btn-key">⌃⇧R</span>
        </button>
        <div class="btn-pair">
            <button class="btn" onclick="send('build')">
                <span class="btn-icon">⚙</span> Build
            </button>
            <button class="btn" onclick="send('flash')">
                <span class="btn-icon">⚡</span> Flash
            </button>
        </div>
    </div>
</div>

<!-- MONITOR -->
<div class="section">
    <div class="section-header" onclick="toggle(this)">
        <span class="chevron">▾</span> Monitor
        <span style="margin-left:auto"><span class="dot dot-r" id="monDot"></span><span id="monLabel">Off</span></span>
    </div>
    <div class="section-body">
        <button class="btn" id="monStartBtn" onclick="send('monitor')">
            <span class="btn-icon">📡</span> Start Monitor
        </button>
        <button class="btn btn-stop" id="monStopBtn" onclick="send('stop')" style="display:none">
            <span class="btn-icon">⏹</span> Stop Monitor
        </button>
    </div>
</div>

<!-- PLATFORM OUTPUT -->
<div class="section">
    <div class="section-header" onclick="toggle(this)">
        <span class="chevron">▾</span> Platform Output
    </div>
    <div class="section-body">
        <div class="output-wrap" style="max-height:350px">
            <div class="output" id="buildArea">
                <div style="opacity:0.3;font-size:11px">Ready</div>
            </div>
        </div>
    </div>
</div>

<!-- DEVICE OUTPUT (serial data from connected device) -->
<div class="section">
    <div class="section-header" onclick="toggle(this)">
        <span class="chevron">▾</span> Device Output
        <span style="margin-left:auto;cursor:pointer;font-size:10px;opacity:0.4" onclick="event.stopPropagation();document.getElementById('serialArea').innerHTML=''">clear</span>
    </div>
    <div class="section-body">
        <div class="output-wrap" style="max-height:250px">
            <div class="output" id="serialArea">
                <div style="opacity:0.3;font-size:11px">No device connected</div>
            </div>
        </div>
    </div>
</div>

<!-- TOOLS -->
<div class="section">
    <div class="section-header" onclick="toggle(this)">
        <span class="chevron">▾</span> Tools
    </div>
    <div class="section-body">
        <button class="btn" onclick="send('check')">
            <span class="btn-icon">✓</span> Check
            <span class="btn-key">⌃⇧C</span>
        </button>
        <button class="btn" onclick="send('newProject')">
            <span class="btn-icon">+</span> New Project
        </button>
    </div>
</div>

<!-- DEVICES -->
<div class="section">
    <div class="section-header" onclick="toggle(this)">
        <span class="chevron">▾</span> Devices
        <span style="margin-left:auto;cursor:pointer;font-size:10px;opacity:0.4" onclick="event.stopPropagation();send('devices')">scan</span>
    </div>
    <div class="section-body" id="devicesBody">
        <div id="devicesList" style="padding:4px 12px">
            <div style="opacity:0.4;font-size:11px">Click scan to detect</div>
        </div>
    </div>
</div>


<script>
    const vscode = acquireVsCodeApi();
    const LOGO = '${logoUri}';
    function send(cmd) { vscode.postMessage({ command: cmd }); }

    function toggle(header) {
        const body = header.nextElementSibling;
        const chev = header.querySelector('.chevron');
        body.classList.toggle('collapsed');
        chev.classList.toggle('collapsed');
    }

    function clearOutput() {
        document.getElementById('outputArea').innerHTML = '';
    }

    const build = document.getElementById('buildArea');
    const serial = document.getElementById('serialArea');

    function addBuild(html) {
        build.insertAdjacentHTML('beforeend', html);
        build.parentElement.scrollTop = build.parentElement.scrollHeight;
    }
    function addSerial(html) {
        serial.insertAdjacentHTML('beforeend', html);
        serial.parentElement.scrollTop = serial.parentElement.scrollHeight;
    }

    window.addEventListener('message', event => {
        const msg = event.data;

        // ── Build/Flash: Structured Events ──

        if (msg.type === 'commandStart') {
            const icons = { build:'⚙', flash:'⚡', run:'▶', check:'✓', devices:'🔌' };
            build.innerHTML = '<div style="font-weight:600;font-size:12px;padding:2px 0">' +
                (icons[msg.command]||'•') + ' volt ' + msg.command + '</div>';

            if (msg.command === 'build' || msg.command === 'run') {
                addBuild(
                    '<div class="step step-run" id="step-transpile"><span class="step-icon"><span class="spinner"></span></span>Transpile<span class="step-time" id="time-transpile"></span></div>' +
                    '<div class="step" id="step-compile" style="opacity:0.3"><span class="step-icon">○</span>Compile<span class="step-time" id="time-compile"></span></div>' +
                    '<div class="progress-bar active" id="buildBar"><div class="progress-fill" id="buildFill" style="width:5%"></div></div>'
                );
            }
            if (msg.command === 'flash') {
                addBuild('<div style="font-size:11px;padding:4px 0">Flashing to device...</div>' +
                    '<div class="progress-bar" id="flashBar"><div class="progress-fill" id="flashFill" style="width:0%"></div></div>' +
                    '<div style="font-size:10px;opacity:0.5" id="flashPctText">0%</div>');
            }
        }

        if (msg.type === 'stepDone') {
            const el = document.getElementById('step-' + msg.step);
            if (el) {
                el.className = 'step step-done';
                el.querySelector('.step-icon').textContent = '✓';
            }
            const te = document.getElementById('time-' + msg.step);
            if (te) te.textContent = msg.time;

            // Activate next step with spinner
            if (msg.step === 'transpile') {
                const sc = document.getElementById('step-compile');
                if (sc) { sc.style.opacity = '1'; sc.className = 'step step-run'; sc.querySelector('.step-icon').innerHTML = '<span class="spinner"></span>'; }
            }
        }

        if (msg.type === 'buildProgress') {
            const fill = document.getElementById('buildFill');
            if (fill) fill.style.width = msg.pct + '%';
        }

        if (msg.type === 'flashProgress') {
            const fill = document.getElementById('flashFill');
            const text = document.getElementById('flashPctText');
            if (fill) fill.style.width = msg.pct + '%';
            if (text) text.textContent = msg.pct + '%';
        }

        if (msg.type === 'flashSize') {
            addBuild('<div style="font-size:10px;opacity:0.5;padding:2px 0">Flash usage: ' + msg.pct + '</div>');
        }

        if (msg.type === 'warning' || msg.type === 'error') {
            const isErr = msg.type === 'error';
            const cls = isErr ? 'result-err' : 'result-warn';
            const icon = isErr ? '✗' : '⚠';
            const line = msg.line || 0;
            const esc = (s) => (s||'').replace(/</g,'&lt;');

            let html = '<div class="diag-card ' + cls + '" ' +
                (line ? 'onclick="vscode.postMessage({command:\\'openLine\\',line:' + line + '})" style="cursor:pointer"' : '') + '>' +
                '<div class="diag-header">' +
                    '<span class="diag-icon">' + icon + '</span>' +
                    '<span class="diag-title">' + esc(msg.message) + '</span>' +
                    (line ? '<span class="diag-loc">' + esc(msg.file) + ':' + line + ' →</span>' : '') +
                '</div>';

            if (msg.codeLine) {
                html += '<div class="diag-code">' + esc(msg.codeLine) + '</div>';
            }
            if (msg.hint) {
                html += '<div class="diag-hint">💡 ' + esc(msg.hint) + '</div>';
            }

            html += '</div>';
            addBuild(html);
        }

        if (msg.type === 'success') {
            addBuild('<div class="result result-ok">✓ ' + msg.text.replace(/</g,'&lt;') + '</div>');
        }

        if (msg.type === 'commandEnd') {
            const bp = document.getElementById('buildFill');
            const fp = document.getElementById('flashFill');
            const bb = document.getElementById('buildBar');
            if (bp) bp.style.width = '100%';
            if (fp) fp.style.width = '100%';
            if (bb) bb.classList.remove('active'); // stop shimmer

            if (msg.success) {
                addBuild('<div style="font-size:10px;opacity:0.5;padding:4px 0">Completed in ' + msg.elapsed + 's</div>');
            } else {
                const sc = document.getElementById('step-compile');
                if (sc) { sc.className = 'step step-fail'; sc.querySelector('.step-icon').textContent = '✗'; }
            }
        }

        // ── Serial Monitor: Device Output (separate area) ──

        if (msg.type === 'output' && msg.kind === 'monitor') {
            const lines = msg.text.split('\\n');
            lines.forEach(line => {
                const m = line.match(/(\\d{2}:\\d{2}:\\d{2}\\.\\d{3})\\s+\\[(\\w+)\\s*\\]\\s+(\\w+):\\s*(.*)/);
                if (m) {
                    const [_, time, level, tag, message] = m;
                    const lvl = level.trim().toLowerCase();
                    const cls = lvl === 'error' ? 'log-error' : lvl === 'warn' ? 'log-warn' : lvl === 'debug' ? 'log-debug' : 'log-info';
                    addSerial('<div class="log-entry">' +
                        '<span class="log-time">' + time + '</span>' +
                        '<span class="log-level ' + cls + '">' + level.trim() + '</span>' +
                        '<span class="log-msg">' + (message||'').replace(/</g,'&lt;') + '</span></div>');
                } else if (line.trim()) {
                    addSerial('<div class="log-entry"><span class="log-msg">' + line.replace(/</g,'&lt;') + '</span></div>');
                }
            });
        }

        if (msg.type === 'output' && msg.kind === 'info') {
            addSerial('<div style="font-size:11px;opacity:0.5;padding:2px 0;font-style:italic">' + msg.text.replace(/</g,'&lt;') + '</div>');
        }

        // Device list — renders in dedicated Devices section
        if (msg.type === 'deviceList') {
            const list = document.getElementById('devicesList');
            if (msg.devices.length === 0) {
                list.innerHTML = '<div style="opacity:0.4;font-size:11px;padding:4px 0">No devices detected</div>';
            } else {
                let html = '';
                msg.devices.forEach(d => {
                    const chip = (d.chip || 'unknown').toUpperCase();
                    const dotClass = chip !== 'UNKNOWN' ? 'dot-g' : 'dot-y';
                    html += '<div class="device-card">' +
                        '<div class="device-header">' +
                            '<span class="dot ' + dotClass + '"></span>' +
                            '<span class="device-chip">' + chip + '</span>' +
                            '<span class="device-port">' + d.port + '</span>' +
                        '</div>' +
                        '<div class="device-desc">' + d.desc + '</div>' +
                    '</div>';
                });
                list.innerHTML = html;
            }
        }

        if (msg.type === 'stateUpdate') {
            const s = msg.state;
            document.getElementById('monStartBtn').style.display = s.monitoring ? 'none' : 'flex';
            document.getElementById('monStopBtn').style.display = s.monitoring ? 'flex' : 'none';
            document.getElementById('monDot').className = s.monitoring ? 'dot dot-g' : 'dot dot-r';
            document.getElementById('monLabel').textContent = s.monitoring ? 'Live' : 'Off';
        }

        // File list removed — VS Code explorer handles this
    });
</script>
</body>
</html>`;
    }
}

// ============================================================
// LSP Client
// ============================================================

function startLSP(context) {
    const serverOptions = {
        command: PYTHON,
        args: [LSP_SERVER],
        options: { env: process.env },
    };
    const clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'volt' }],
    };
    lspClient = new LanguageClient('volt-lsp', 'Volt Language Server', serverOptions, clientOptions);
    lspClient.start();
    context.subscriptions.push(lspClient);
}

// ============================================================
// Activation
// ============================================================

function activate(context) {
    startLSP(context);

    sidebarProvider = new VoltSidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('volt.sidebar', sidebarProvider)
    );

    // Commands (still needed for keybindings and command palette)
    context.subscriptions.push(
        vscode.commands.registerCommand('volt.build', () => runCommand('build')),
        vscode.commands.registerCommand('volt.flash', () => { stopMonitor(); setTimeout(() => runCommand('flash'), 300); }),
        vscode.commands.registerCommand('volt.run', () => {
            stopMonitor();
            setTimeout(() => {
                runCommand('build', (err) => {
                    if (!err) runCommand('flash', (err2) => { if (!err2) startMonitor(); });
                });
            }, 300);
        }),
        vscode.commands.registerCommand('volt.monitor', () => startMonitor()),
        vscode.commands.registerCommand('volt.stop', () => stopMonitor()),
        vscode.commands.registerCommand('volt.check', () => runCommand('check')),
        vscode.commands.registerCommand('volt.devices', () => runCommand('devices')),
        vscode.commands.registerCommand('volt.format', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'volt') {
                vscode.commands.executeCommand('editor.action.formatDocument');
            }
        }),
    );

    // Document formatter — auto-formats .volt files
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider('volt', {
            provideDocumentFormattingEdits(document) {
                return formatVoltDocument(document);
            }
        })
    );

    // Format on save
    context.subscriptions.push(
        vscode.workspace.onWillSaveTextDocument(event => {
            if (event.document.languageId === 'volt') {
                const config = vscode.workspace.getConfiguration('editor', event.document.uri);
                if (config.get('formatOnSave')) {
                    event.waitUntil(Promise.resolve(formatVoltDocument(event.document)));
                }
            }
        })
    );

    // Device watcher — polls every 3 seconds for USB changes
    // Caches chip type per port to avoid running esptool every poll
    let lastPortList = '';
    const devicePoller = setInterval(() => {
        const cmd = `${PYTHON} -c "
import serial.tools.list_ports, json
ports = []
MCU_VIDS = {0x10C4, 0x1A86, 0x0403, 0x2E8A, 0x0483, 0x303A, 0x2341, 0x239A, 0x1D50}
for p in serial.tools.list_ports.comports():
    desc = (p.description or '').lower()
    vid = p.vid or 0
    is_mcu = vid in MCU_VIDS
    is_mcu = is_mcu or any(c in desc for c in ['cp210', 'ch340', 'ch910', 'ftdi'])
    is_mcu = is_mcu or 'ttyACM' in p.device
    if is_mcu:
        ports.append({'port': p.device, 'desc': p.description or ''})
print(json.dumps(ports))
"`;
        exec(cmd, (err, stdout) => {
            if (err) return;
            const portJson = (stdout || '').trim();
            if (portJson !== lastPortList) {
                lastPortList = portJson;
                try {
                    const ports = JSON.parse(portJson);
                    // Check for new ports that need chip detection
                    const newPorts = ports.filter(p => !(p.port in chipCache));
                    if (newPorts.length > 0) {
                        // Run full scan with esptool for new ports only
                        scanDevices();
                        // Cache results after scan completes (scanDevices updates sidebar)
                        newPorts.forEach(p => { chipCache[p.port] = 'pending'; });
                    } else {
                        // Use cached chip info
                        const devices = ports.map(p => ({
                            port: p.port,
                            desc: p.desc,
                            chip: chipCache[p.port] || 'unknown'
                        }));
                        if (sidebarProvider) {
                            sidebarProvider.sendEvent('deviceList', { devices });
                        }
                    }
                    // Clean cache for disconnected ports
                    const activePorts = new Set(ports.map(p => p.port));
                    Object.keys(chipCache).forEach(k => {
                        if (!activePorts.has(k)) delete chipCache[k];
                    });
                } catch (e) {}
            }
        });
    }, 3000);

    context.subscriptions.push({ dispose: () => clearInterval(devicePoller) });

    console.log('Volt extension activated');
}

// ============================================================
// Volt Code Formatter
// ============================================================

function formatVoltDocument(document) {
    const text = document.getText();
    const formatted = formatVoltCode(text);

    if (formatted === text) return [];

    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length),
    );
    return [vscode.TextEdit.replace(fullRange, formatted)];
}

function formatVoltCode(source) {
    const lines = source.split('\n');
    const result = [];
    let indent = 0;
    const TAB = '    '; // 4 spaces

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();

        // Skip empty lines — preserve one blank line max
        if (line === '') {
            // Don't add multiple blank lines in a row
            if (result.length > 0 && result[result.length - 1].trim() === '') {
                continue;
            }
            result.push('');
            continue;
        }

        // Decrease indent BEFORE the line if it starts with }
        if (line.startsWith('}')) {
            indent = Math.max(0, indent - 1);
        }

        // Write the line with current indentation
        result.push(TAB.repeat(indent) + line);

        // Increase indent AFTER the line if it ends with {
        if (line.endsWith('{')) {
            indent++;
        }
    }

    // Ensure file ends with single newline
    let output = result.join('\n');
    output = output.replace(/\n+$/, '\n');
    if (!output.endsWith('\n')) output += '\n';

    return output;
}

function deactivate() {
    stopMonitor();
    if (lspClient) return lspClient.stop();
}

module.exports = { activate, deactivate };
