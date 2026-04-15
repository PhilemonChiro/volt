const { execSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Find the Volt compiler source
function getVoltSrcPath() {
    // Dev mode: relative to this project
    const devPath = path.join(__dirname, "..", "..", "..", "src");
    if (fs.existsSync(path.join(devPath, "volt", "compiler", "voltc.py"))) return devPath;
    // Installed: ~/.volt/sdk/src
    const sdkPath = path.join(os.homedir(), ".volt", "sdk", "src");
    if (fs.existsSync(sdkPath)) return sdkPath;
    return devPath;
}

const VOLT_SRC = getVoltSrcPath();

function runPython(script) {
    const tmpScript = path.join(os.tmpdir(), `_volt_${process.pid}_${Date.now()}.py`);
    fs.writeFileSync(tmpScript, script);
    try {
        const result = execSync(`python3 "${tmpScript}"`, {
            timeout: 10000,
            maxBuffer: 1024 * 1024,
        });
        return JSON.parse(result.toString().trim());
    } catch (e) {
        return null;
    } finally {
        try { fs.unlinkSync(tmpScript); } catch (_) {}
    }
}

function compileFull(source) {
    const tmpVolt = path.join(os.tmpdir(), `_volt_full_${process.pid}.volt`);
    fs.writeFileSync(tmpVolt, source);

    const script = `
import sys, json
sys.path.insert(0, '${VOLT_SRC.replace(/\\/g, "/")}')
from volt.compiler.errors import CompilerErrors
from volt.compiler.parser import parse
from volt.compiler.resolver import resolve
from volt.compiler.checker import check_types
from volt.compiler.hardware import validate_hardware
from volt.compiler.analyzer import analyze
from volt.compiler.transformer import transform
from volt.compiler.codegen import generate

source = open('${tmpVolt.replace(/\\/g, "/")}').read()
errors = CompilerErrors()
errors.set_source(source)
program = None
c_code = None

try:
    program = parse(source)
    scope = resolve(program, errors)
    if not errors.has_errors:
        check_types(program, scope, errors)
    if not errors.has_errors:
        validate_hardware(program, scope, errors)
    if not errors.has_errors:
        analyze(program, scope, errors)
    if not errors.has_errors:
        program = transform(program)
        c_code = generate(program, 'main.volt')
except Exception:
    pass

result = {
    'diagnostics': [{
        'line': e.region.start_line if e.region else 1,
        'col': e.region.start_col if e.region else 1,
        'message': e.message,
        'severity': e.severity,
        'hint': e.hint or ''
    } for e in errors.errors],
    'c_code': c_code or '',
    'pins': [],
    'devices': [],
    'buses': [],
    'tasks': [],
    'machines': [],
    'channels': [],
    'enums': [],
    'chip': '',
}

if program:
    if program.chip:
        result['chip'] = program.chip.target
    if program.hardware:
        result['pins'] = [{
            'name': p.name, 'mode': p.mode, 'gpio': p.gpio
        } for p in program.hardware.pins]
        result['devices'] = [{
            'name': s.name, 'type': s.sensor_type, 'bus': s.bus_name, 'address': s.address
        } for s in program.hardware.sensors]
        result['buses'] = [{
            'name': b.name, 'type': b.bus_type
        } for b in program.hardware.buses]
    result['tasks'] = [{
        'name': t.name, 'tier': getattr(t, 'tier', 'background'),
        'line': t.region.start_line
    } for t in program.tasks]
    result['machines'] = [{
        'name': m.name,
        'states': [s.name for s in m.states],
        'line': m.region.start_line
    } for m in program.machines]
    result['channels'] = [{
        'name': c.name, 'elem_type': c.elem_type, 'capacity': c.capacity
    } for c in program.channels]
    result['enums'] = [{
        'name': e.name, 'variants': e.variants
    } for e in program.enums]

print(json.dumps(result))
`;

    return runPython(script) || {
        diagnostics: [], c_code: "", pins: [], devices: [], buses: [],
        tasks: [], machines: [], channels: [], enums: [], chip: "",
    };
}

function checkCode(source) {
    const result = compileFull(source);
    return result ? result.diagnostics : [];
}

function findSymbols(source) {
    // Reuse existing symbol finder logic
    return [];
}

function runPipeline(projectPath, voltFile, port, chip, emit) {
    emit("compile", "Compiling...", 5);
    // TODO: wire build pipeline
    emit("error", "Build pipeline not yet migrated to Electron", 0);
}

module.exports = { compileFull, checkCode, findSymbols, runPipeline };
