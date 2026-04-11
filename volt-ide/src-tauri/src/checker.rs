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
r#"import sys, json, re
sys.path.insert(0, '{}')
from volt.compiler.voltc import compile_volt

source = open('{}').read()
_, errors = compile_volt(source, 'check.volt')
result = []
for e in errors.errors:
    line = e.region.start_line if e.region else 1
    col = e.region.start_col if e.region else 1
    msg = e.message
    # Extract real line number from parser error messages like "at line 15, column 8"
    m = re.search(r'at line (\d+)', msg)
    if m and line <= 1:
        line = int(m.group(1))
    mc = re.search(r'column (\d+)', msg)
    if mc and col <= 1:
        col = int(mc.group(1))
    result.append({{
        'line': line,
        'col': col,
        'message': msg,
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
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();

            if !stderr.is_empty() || stdout.is_empty() {
                // Python error — return it as a diagnostic on line 1
                if !stderr.is_empty() {
                    let msg = stderr.lines().last().unwrap_or("Check failed");
                    return vec![DiagnosticItem {
                        line: 1, col: 1,
                        message: format!("Checker: {}", msg),
                        severity: "warning".to_string(),
                        hint: "".to_string(),
                    }];
                }
                return Vec::new();
            }

            serde_json::from_str(&stdout).unwrap_or_default()
        }
        Err(e) => {
            vec![DiagnosticItem {
                line: 1, col: 1,
                message: format!("Cannot run checker: {}", e),
                severity: "warning".to_string(),
                hint: "".to_string(),
            }]
        }
    }
}
