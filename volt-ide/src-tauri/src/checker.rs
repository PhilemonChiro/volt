use serde::Serialize;
use std::process::Command;

#[derive(Serialize, serde::Deserialize)]
pub struct DiagnosticItem {
    pub line: u32,
    pub col: u32,
    pub message: String,
    pub severity: String,
    pub hint: String,
}

/// Run the Volt compiler in check-only mode and return diagnostics
pub fn check_code(source: &str) -> Vec<DiagnosticItem> {
    let volt_src = crate::runner::get_volt_src_path();

    // Write source to a unique temp file (avoid race with multiple windows)
    let pid = std::process::id();
    let tmp = std::env::temp_dir().join(format!("_volt_check_{}.volt", pid));
    std::fs::write(&tmp, source).ok();

    let script = format!(
r#"import sys, json
sys.path.insert(0, '{}')
from volt.compiler.errors import CompilerErrors
from volt.compiler.parser import parse
from volt.compiler.resolver import resolve
from volt.compiler.checker import check_types
from volt.compiler.hardware import validate_hardware
from volt.compiler.analyzer import analyze

source = open('{}').read()
errors = CompilerErrors()
errors.set_source(source)
program = None

# Pass 1: Parse — retry to find multiple syntax errors
import re
from volt.compiler.ast_nodes import Region

def extract_line(ex):
    m = re.search(r'line (\d+)(?:,\s*column (\d+))?', str(ex))
    if m:
        return int(m.group(1)), int(m.group(2) or 1)
    return 1, 1

lines = source.split('\n')
max_retries = 20
for attempt in range(max_retries):
    try:
        program = parse('\n'.join(lines))
        break
    except Exception as e:
        ln, col = extract_line(e)
        msg = str(e).split('\n')[0]
        errors.error(Region(ln, col, ln, col), "SYNTAX ERROR", msg)
        # Comment out the bad line and retry
        if 1 <= ln <= len(lines):
            lines[ln - 1] = '// REMOVED'
        else:
            break

# Pass 2: Resolve names (even if there are parse warnings)
scope = None
if program:
    try:
        scope = resolve(program, errors)
    except Exception:
        pass

# Pass 3: Type check
if program and scope:
    try:
        check_types(program, scope, errors)
    except Exception:
        pass

# Pass 4: Hardware validation
if program:
    chip = None
    if program.chip:
        try:
            from volt.chips import get_chip
            chip = get_chip(program.chip.target)
        except Exception:
            pass
    try:
        validate_hardware(program, scope, errors, chip=chip)
    except Exception:
        pass

# Pass 5: Analyze (task classification, ISR safety)
if program and scope:
    try:
        analyze(program, scope, errors)
    except Exception:
        pass

result = []
for e in errors.errors:
    result.append({{
        'line': e.region.start_line if e.region else 1,
        'col': e.region.start_col if e.region else 1,
        'message': e.message,
        'severity': e.severity,
        'hint': e.hint or ''
    }})
print(json.dumps(result))
"#,
        volt_src.replace("\\", "/"),
        tmp.to_string_lossy().replace("\\", "/"),
    );

    let script_path = std::env::temp_dir().join(format!("_volt_check_{}.py", std::process::id()));
    std::fs::write(&script_path, &script).ok();

    let output = Command::new("python3")
        .arg(&script_path)
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            serde_json::from_str(&stdout).unwrap_or_default()
        }
        Err(_) => Vec::new(),
    }
}

// ============================================================
// Full compilation result — AST + C code + diagnostics
// Used by the ASTStore for panel rendering
// ============================================================

#[derive(Serialize, serde::Deserialize)]
pub struct CompileResult {
    pub diagnostics: Vec<DiagnosticItem>,
    pub c_code: String,
    pub pins: Vec<PinInfo>,
    pub tasks: Vec<TaskInfo>,
    pub machines: Vec<MachineInfo>,
    pub channels: Vec<ChannelInfo>,
    pub enums: Vec<EnumInfo>,
    pub chip: String,
}

#[derive(Serialize, serde::Deserialize)]
pub struct PinInfo {
    pub name: String,
    pub mode: String,
    pub gpio: u32,
}

#[derive(Serialize, serde::Deserialize)]
pub struct TaskInfo {
    pub name: String,
    pub tier: String,
    pub line: u32,
}

#[derive(Serialize, serde::Deserialize)]
pub struct MachineInfo {
    pub name: String,
    pub states: Vec<String>,
    pub line: u32,
}

#[derive(Serialize, serde::Deserialize)]
pub struct ChannelInfo {
    pub name: String,
    pub elem_type: String,
    pub capacity: u32,
}

#[derive(Serialize, serde::Deserialize)]
pub struct EnumInfo {
    pub name: String,
    pub variants: Vec<String>,
}

pub fn compile_full(source: &str) -> CompileResult {
    let volt_src = crate::runner::get_volt_src_path();
    let pid = std::process::id();
    let tmp = std::env::temp_dir().join(format!("_volt_full_{}.volt", pid));
    std::fs::write(&tmp, source).ok();

    let script = format!(
r#"import sys, json
sys.path.insert(0, '{}')
from volt.compiler.voltc import compile_volt

source = open('{}').read()
c_code, errors = compile_volt(source, 'main.volt')

# Re-parse to get AST structure (compile_volt returns C, not AST)
from volt.compiler.parser import parse
from volt.compiler.resolver import resolve
from volt.compiler.errors import CompilerErrors

errs2 = CompilerErrors()
errs2.set_source(source)
try:
    program = parse(source)
    scope = resolve(program, errs2)
except Exception:
    program = None

result = {{
    'diagnostics': [{{
        'line': e.region.start_line if e.region else 1,
        'col': e.region.start_col if e.region else 1,
        'message': e.message,
        'severity': e.severity,
        'hint': e.hint or ''
    }} for e in errors.errors],
    'c_code': c_code or '',
    'pins': [],
    'tasks': [],
    'machines': [],
    'channels': [],
    'enums': [],
    'chip': '',
}}

if program:
    if program.chip:
        result['chip'] = program.chip.target
    if program.hardware:
        result['pins'] = [{{
            'name': p.name, 'mode': p.mode, 'gpio': p.gpio
        }} for p in program.hardware.pins]
    result['tasks'] = [{{
        'name': t.name, 'tier': getattr(t, 'tier', 'background'),
        'line': t.region.start_line
    }} for t in program.tasks]
    result['machines'] = [{{
        'name': m.name,
        'states': [s.name for s in m.states],
        'line': m.region.start_line
    }} for m in program.machines]
    result['channels'] = [{{
        'name': c.name, 'elem_type': c.elem_type, 'capacity': c.capacity
    }} for c in program.channels]
    result['enums'] = [{{
        'name': e.name, 'variants': e.variants
    }} for e in program.enums]

print(json.dumps(result))
"#,
        volt_src.replace("\\", "/"),
        tmp.to_string_lossy().replace("\\", "/"),
    );

    let script_path = std::env::temp_dir().join(format!("_volt_full_{}.py", pid));
    std::fs::write(&script_path, &script).ok();

    let output = std::process::Command::new("python3")
        .arg(&script_path)
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            serde_json::from_str(&stdout).unwrap_or(CompileResult {
                diagnostics: vec![],
                c_code: String::new(),
                pins: vec![],
                tasks: vec![],
                machines: vec![],
                channels: vec![],
                enums: vec![],
                chip: String::new(),
            })
        }
        Err(_) => CompileResult {
            diagnostics: vec![],
            c_code: String::new(),
            pins: vec![],
            tasks: vec![],
            machines: vec![],
            channels: vec![],
            enums: vec![],
            chip: String::new(),
        },
    }
}

#[derive(Serialize, serde::Deserialize)]
pub struct SymbolInfo {
    pub name: String,
    pub kind: String,      // "pin", "var", "func", "task", "machine", "state", "param", "storage", "builtin"
    pub def_line: u32,
    pub def_col: u32,
    pub refs: Vec<SymbolRef>,
}

#[derive(Serialize, serde::Deserialize)]
pub struct SymbolRef {
    pub line: u32,
    pub col: u32,
}

/// Extract all symbol definitions and references from Volt source
pub fn find_symbols(source: &str) -> Vec<SymbolInfo> {
    let volt_src = crate::runner::get_volt_src_path();
    let tmp = std::env::temp_dir().join(format!("_volt_symbols_{}.volt", std::process::id()));
    std::fs::write(&tmp, source).ok();

    let script = format!(
r#"import sys, json
sys.path.insert(0, '{}')
from volt.compiler.parser import parse
from volt.compiler.resolver import resolve
from volt.compiler.errors import CompilerErrors
from volt.compiler.ast_nodes import *

source = open('{}').read()
errors = CompilerErrors()
errors.set_source(source)

try:
    program = parse(source)
except Exception:
    print('[]')
    sys.exit(0)

try:
    scope = resolve(program, errors)
except Exception:
    pass

symbols = {{}}

# Collect declarations from the program AST
if program.hardware:
    for pin in program.hardware.pins:
        symbols[pin.name] = {{
            'name': pin.name,
            'kind': 'pin',
            'def_line': pin.region.start_line,
            'def_col': pin.region.start_col,
            'refs': []
        }}
    for sensor in program.hardware.sensors:
        symbols[sensor.name] = {{
            'name': sensor.name,
            'kind': 'sensor',
            'def_line': sensor.region.start_line,
            'def_col': sensor.region.start_col,
            'refs': []
        }}
    for bus in program.hardware.buses:
        symbols[bus.name] = {{
            'name': bus.name,
            'kind': 'bus',
            'def_line': bus.region.start_line,
            'def_col': bus.region.start_col,
            'refs': []
        }}

for func in program.functions:
    symbols[func.name] = {{
        'name': func.name,
        'kind': 'func',
        'def_line': func.region.start_line,
        'def_col': func.region.start_col,
        'refs': []
    }}
    for param in func.params:
        symbols[param.name] = {{
            'name': param.name,
            'kind': 'param',
            'def_line': param.region.start_line,
            'def_col': param.region.start_col,
            'refs': []
        }}

for task in program.tasks:
    symbols[task.name] = {{
        'name': task.name,
        'kind': 'task',
        'def_line': task.region.start_line,
        'def_col': task.region.start_col,
        'refs': []
    }}

for machine in program.machines:
    symbols[machine.name] = {{
        'name': machine.name,
        'kind': 'machine',
        'def_line': machine.region.start_line,
        'def_col': machine.region.start_col,
        'refs': []
    }}
    for state in machine.states:
        key = machine.name + '.' + state.name
        symbols[key] = {{
            'name': state.name,
            'kind': 'state',
            'def_line': state.region.start_line,
            'def_col': state.region.start_col,
            'refs': []
        }}

for sv in program.storage_vars:
    symbols[sv.name] = {{
        'name': sv.name,
        'kind': 'storage',
        'def_line': sv.region.start_line,
        'def_col': sv.region.start_col,
        'refs': []
    }}

for gv in program.global_vars:
    symbols[gv.name] = {{
        'name': gv.name,
        'kind': 'var',
        'def_line': gv.region.start_line,
        'def_col': gv.region.start_col,
        'refs': []
    }}

# Walk all expressions to find references
def walk_expr(expr):
    if expr is None:
        return
    if isinstance(expr, VarRef):
        name = expr.name
        if name in symbols:
            symbols[name]['refs'].append({{
                'line': expr.region.start_line,
                'col': expr.region.start_col
            }})
    elif isinstance(expr, BinaryExpr):
        walk_expr(expr.left)
        walk_expr(expr.right)
    elif isinstance(expr, UnaryExpr):
        walk_expr(expr.operand)
    elif isinstance(expr, DotAccess):
        walk_expr(expr.obj)
    elif isinstance(expr, FuncCall):
        if expr.name in symbols:
            symbols[expr.name]['refs'].append({{
                'line': expr.region.start_line,
                'col': expr.region.start_col
            }})
        for arg in expr.args:
            walk_expr(arg)
    elif isinstance(expr, MethodCall):
        walk_expr(expr.obj)
        for arg in expr.args:
            walk_expr(arg)
    elif isinstance(expr, AssignExpr):
        walk_expr(expr.target)
        walk_expr(expr.value)

def walk_stmts(stmts):
    for stmt in stmts:
        if stmt is None:
            continue
        if isinstance(stmt, VarDecl):
            if stmt.name not in symbols:
                symbols[stmt.name] = {{
                    'name': stmt.name,
                    'kind': 'var',
                    'def_line': stmt.region.start_line,
                    'def_col': stmt.region.start_col,
                    'refs': []
                }}
            if stmt.value:
                walk_expr(stmt.value)
        elif isinstance(stmt, AssignExpr):
            walk_expr(stmt.target)
            walk_expr(stmt.value)
        elif isinstance(stmt, CompoundAssign):
            walk_expr(stmt.target)
            walk_expr(stmt.value)
        elif isinstance(stmt, ExprStmt):
            walk_expr(stmt.expr)
        elif isinstance(stmt, ReturnStmt):
            walk_expr(stmt.value)
        elif isinstance(stmt, IfStmt):
            walk_expr(stmt.condition)
            walk_stmts(stmt.then_body)
            if isinstance(stmt.else_body, list):
                walk_stmts(stmt.else_body)
            elif isinstance(stmt.else_body, IfStmt):
                walk_stmts([stmt.else_body])
        elif isinstance(stmt, WhileStmt):
            walk_expr(stmt.condition)
            walk_stmts(stmt.body)
        elif isinstance(stmt, ForStmt):
            walk_expr(stmt.start)
            walk_expr(stmt.end)
            walk_stmts(stmt.body)
        elif isinstance(stmt, EveryBlock):
            walk_stmts(stmt.body)
        elif isinstance(stmt, OnBlock):
            walk_expr(stmt.event)
            walk_stmts(stmt.body)
        elif isinstance(stmt, TimeoutBlock):
            walk_stmts(stmt.try_body)
            walk_stmts(stmt.fallback_body)
        elif isinstance(stmt, MatchStmt):
            walk_expr(stmt.expr)

# Walk all bodies
for func in program.functions:
    walk_stmts(func.body)
for task in program.tasks:
    walk_stmts(task.body)
for machine in program.machines:
    for state in machine.states:
        walk_stmts(state.enter_body)
        walk_stmts(state.exit_body)
        walk_stmts(state.body)
if program.setup:
    walk_stmts(program.setup.body)
if program.loop:
    walk_stmts(program.loop.body)

print(json.dumps(list(symbols.values())))
"#,
        volt_src.replace("\\", "/"),
        tmp.to_string_lossy().replace("\\", "/"),
    );

    let script_path = std::env::temp_dir().join(format!("_volt_symbols_{}.py", std::process::id()));
    std::fs::write(&script_path, &script).ok();

    let output = Command::new("python3")
        .arg(&script_path)
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            serde_json::from_str(&stdout).unwrap_or_default()
        }
        Err(_) => Vec::new(),
    }
}
