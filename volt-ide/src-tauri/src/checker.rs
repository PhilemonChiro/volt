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

    // Write source to a temp file
    let tmp = std::env::temp_dir().join("_volt_check.volt");
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

    let script_path = std::env::temp_dir().join("_volt_check.py");
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
