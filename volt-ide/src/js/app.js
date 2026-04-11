/**
 * Volt IDE — Full featured, AMD Monaco (proven on WebKitGTK)
 * Monaco loaded globally via require() before this script runs.
 */
var monaco = window.monaco;
var T = window.__TAURI__;

// ---- Volt Language ----
monaco.languages.register({ id: "volt", extensions: [".volt"] });
monaco.languages.setMonarchTokensProvider("volt", {
    keywords: ["chip","hardware","task","func","machine","struct","main","state","initial","enter","exit","on","after","if","else","while","for","match","return","every","strict","let","var","pin","sensor","bus","run"],
    typeKeywords: ["int","float","bool","string","void","Output","Input","Analog","PWM","Touch"],
    builtins: ["wifi","mqtt","http","storage","system","ota","log","true","false"],
    tokenizer: {
        root: [
            [/\d+(?:ms|seconds|s)\b/, "number.duration"],
            [/0x[0-9a-fA-F]+/, "number.hex"], [/\d+\.\d+/, "number.float"], [/\d+/, "number"],
            [/"/, "string", "@string"], [/\/\/.*$/, "comment"], [/->/, "operator.arrow"],
            [/[a-zA-Z_]\w*/, { cases: { "@keywords": "keyword", "@typeKeywords": "type", "@builtins": "variable.predefined", "@default": "identifier" } }],
            [/[{}()\[\]]/, "@brackets"], [/[=!<>+\-*/%&|]+/, "operator"], [/[;,.:]+/, "delimiter"],
        ],
        string: [[/[^"\\]+/, "string"], [/"/, "string", "@pop"]],
    },
});
monaco.languages.setLanguageConfiguration("volt", {
    comments: { lineComment: "//" },
    brackets: [["{","}"],["[","]"],["(",")"]],
    autoClosingPairs: [{ open: "{", close: "}" },{ open: "[", close: "]" },{ open: "(", close: ")" },{ open: '"', close: '"' }],
});

// ---- Theme ----
monaco.editor.defineTheme("volt-dark", {
    base: "vs-dark", inherit: true,
    rules: [
        { token: "keyword", foreground: "c586c0" }, { token: "type", foreground: "4ec9b0" },
        { token: "variable.predefined", foreground: "dcdcaa" }, { token: "string", foreground: "ce9178" },
        { token: "number", foreground: "b5cea8" }, { token: "number.duration", foreground: "ce9178", fontStyle: "bold" },
        { token: "comment", foreground: "6a9955" }, { token: "operator.arrow", foreground: "569cd6", fontStyle: "bold" },
        { token: "identifier", foreground: "9cdcfe" },
    ],
    colors: {
        "editor.background": "#111318", "editor.foreground": "#d4d4d4", "editorCursor.foreground": "#ffffff",
        "editor.lineHighlightBackground": "#1a1d24", "editor.selectionBackground": "#264f7844",
        "editorLineNumber.foreground": "#454a55", "editorLineNumber.activeForeground": "#8a8f9a", "editorGutter.background": "#111318",
    },
});

// ---- Create Editor (immediately, always visible) ----
var editor = monaco.editor.create(document.getElementById("editorContainer"), {
    value: "", language: "volt", theme: "volt-dark", fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    lineHeight: 24, minimap: { enabled: false }, scrollBeyondLastLine: false,
    renderLineHighlight: "all", cursorBlinking: "smooth", cursorWidth: 2,
    automaticLayout: true, padding: { top: 8 }, glyphMargin: true,
    overviewRulerBorder: false, scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
});

editor.onDidChangeCursorPosition(function(e) {
    var el = document.getElementById("statusLine");
    if (el) el.textContent = "Ln " + e.position.lineNumber + ", Col " + e.position.column;
});

// ---- Diagnostics ----
var diagTimer = null;
editor.onDidChangeModelContent(function() { clearTimeout(diagTimer); diagTimer = setTimeout(runDiagnostics, 1500); });

function runDiagnostics() {
    var model = editor.getModel(); if (!model) return;
    var code = model.getValue(); if (code.trim().length < 10) { monaco.editor.setModelMarkers(model, "volt", []); setBadge(0); return; }
    if (!T) return;
    T.core.invoke("check_code", { source: code }).then(function(result) {
        var m = editor.getModel(); if (!m || !Array.isArray(result)) return;
        var markers = [];
        result.forEach(function(err) {
            var line = Math.max(err.line||1, 1), col = Math.max(err.col||1, 1);
            var lm = err.message.match(/at line (\d+)/); if (lm && line<=1) line = parseInt(lm[1]);
            var cm = err.message.match(/column (\d+)/); if (cm && col<=1) col = parseInt(cm[1]);
            line = Math.min(line, m.getLineCount());
            var ll = m.getLineContent(line).length;
            markers.push({ startLineNumber:line, startColumn:col, endLineNumber:line, endColumn:Math.min(col+15,ll+1),
                message:err.message, severity: err.severity==="error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning });
        });
        monaco.editor.setModelMarkers(m, "volt", markers);
        setBadge(markers.length);
    }).catch(function(){});
}
function setBadge(n) { var b=document.getElementById("problemCount"); if(b){b.textContent=n; b.style.display=n>0?"inline":"none";} }

// ---- Window Controls ----
if (T) { T.window.getCurrentWindow().then(function(win) {
    document.getElementById("winMinimize").onclick = function(){win.minimize();};
    document.getElementById("winMaximize").onclick = function(){win.toggleMaximize();};
    document.getElementById("winClose").onclick = function(){win.close();};
    document.getElementById("toolbar").addEventListener("mousedown", function(e) {
        if (e.target.id==="toolbar"||e.target.classList.contains("brand-name")||e.target.classList.contains("toolbar-divider")) win.startDragging();
    });
}); }

// ---- Monitor ----
function log(text, level) {
    var o=document.getElementById("monitorOutput"); if(!o) return;
    var d=document.createElement("div"); d.className="log-"+(level||"info");
    var now=new Date(); d.textContent="["+[now.getHours(),now.getMinutes(),now.getSeconds()].map(function(n){return String(n).padStart(2,"0")}).join(":")+"] "+text.replace(/\x1b\[[0-9;]*m/g,"");
    o.appendChild(d); o.scrollTop=o.scrollHeight;
    while(o.children.length>3000) o.removeChild(o.firstChild);
}
document.getElementById("monitorClearBtn").onclick=function(){document.getElementById("monitorOutput").innerHTML="";};

// ---- Devices ----
var devices=[], selDev=0;
function scanDevices() {
    if(!T) return;
    T.core.invoke("scan_devices").then(function(d){
        devices=d;
        var l=document.getElementById("deviceLabel"), dt=document.getElementById("deviceDot");
        var sc=document.getElementById("statusChip"), sp=document.getElementById("statusPort");
        if(d.length>0){
            if(l)l.textContent=d[0].chip; if(dt)dt.className="device-dot connected";
            if(sc)sc.innerHTML='<span class="status-dot on"></span> '+d[0].chip; if(sp)sp.textContent=d[0].port;
        } else {
            if(l)l.textContent="No device"; if(dt)dt.className="device-dot";
            if(sc)sc.innerHTML='<span class="status-dot"></span> No device'; if(sp)sp.textContent="";
        }
    }).catch(function(){});
}
scanDevices(); setInterval(scanDevices,3000);

// Device dropdown
document.getElementById("deviceSelector").onclick=function(e){e.stopPropagation();document.getElementById("deviceDropdown").classList.toggle("open");};
document.addEventListener("click",function(){document.getElementById("deviceDropdown").classList.remove("open");});

// ---- Events ----
if(T) {
    T.event.listen("serial:data",function(e){log(e.payload.line,"info");});
    T.event.listen("serial:connected",function(e){log("Connected: "+e.payload,"info");document.getElementById("monitorDot").classList.add("live");});
    T.event.listen("serial:disconnected",function(e){log("Disconnected","warn");document.getElementById("monitorDot").classList.remove("live");});
    T.event.listen("serial:error",function(e){log(e.payload,"error");});
    T.event.listen("run:progress",function(e){
        var s=document.getElementById("statusBuild");
        if(e.payload.stage==="error"){if(s)s.textContent="✗";log(e.payload.message,"error");}
        else if(e.payload.stage==="done"){if(s)s.textContent="✓ Done";log(e.payload.message,"info");}
        else{if(s)s.textContent=e.payload.message;log(e.payload.message,"debug");}
    });
    T.event.listen("run:output",function(e){log(e.payload,"debug");});
}

// ---- Project ----
var projectPath=null, voltFile=null;

function loadProject(folder) {
    if(!T) return;
    T.core.invoke("read_file",{path:folder+"/main.volt"}).then(function(content){
        projectPath=folder; voltFile=folder+"/main.volt";
        editor.setValue(content);
        document.getElementById("welcomeOverlay").classList.add("hidden");
        document.title=folder.split("/").pop()+" — Volt IDE";
        log("Opened: "+voltFile,"info");
        setTimeout(runDiagnostics,500);
    }).catch(function(e){log("Cannot open: "+e,"error");});
}

// ---- Toolbar Buttons ----
document.getElementById("runBtn").onclick=function(){
    if(!voltFile||!T||devices.length===0){log("No file or device","warn");return;}
    T.core.invoke("save_file",{path:voltFile,content:editor.getValue()});
    T.core.invoke("run_project",{projectPath:projectPath,voltFile:voltFile,port:devices[0].port,chip:devices[0].chip});
};
document.getElementById("monitorBtn").onclick=function(){
    if(!T||devices.length===0) return;
    T.core.invoke("is_monitoring").then(function(m){
        if(m) T.core.invoke("stop_monitor");
        else T.core.invoke("start_monitor",{port:devices[0].port,baud:devices[0].chip.includes("8266")?74880:115200});
    });
};
document.getElementById("newProjectBtn").onclick=function(){
    var name=prompt("Project name:"); if(!name||!T) return;
    var chip=devices.length>0?devices[0].chip.toLowerCase():"esp32";
    if(chip==="esp"||chip==="espressif")chip="esp32";
    T.core.invoke("create_project",{name:name,chip:chip}).then(function(p){if(p)loadProject(p);});
};
document.getElementById("openProjectBtn").onclick=function(){
    if(!T) return;
    T.core.invoke("browse_volt_file").then(function(r){if(r)loadProject(r.folder);});
};

// Welcome buttons
document.getElementById("welcomeNewBtn").onclick=function(){document.getElementById("newProjectBtn").click();};
document.getElementById("welcomeOpenBtn").onclick=function(){document.getElementById("openProjectBtn").click();};

// Recent projects
if(T) { T.core.invoke("list_projects").then(function(projects){
    var el=document.getElementById("welcomeRecent"); if(!el||projects.length===0) return;
    el.innerHTML='<div class="welcome-recent-title">Recent Projects</div>'+
        projects.slice(0,5).map(function(p){return '<div class="welcome-recent-item" data-path="'+p.path+'">'+p.name+'<span class="welcome-recent-chip">'+p.chip.toUpperCase()+'</span></div>';}).join("");
    el.querySelectorAll(".welcome-recent-item").forEach(function(item){
        item.addEventListener("click",function(){loadProject(item.dataset.path);});
    });
}).catch(function(){}); }
