"""Test: parser produces correct AST from Volt source."""

import sys
import os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from volt.compiler.parser import parse
from volt.compiler.ast_nodes import *

passed = 0
failed = 0

def check(name, condition, detail=""):
    global passed, failed
    if condition:
        print(f"  OK: {name}")
        passed += 1
    else:
        print(f"FAIL: {name} — {detail}")
        failed += 1


# ============================================================
print("\n=== Test 1: Minimal program ===\n")
# ============================================================

prog = parse("chip esp32\n")
check("chip parsed", prog.chip is not None)
check("chip target", prog.chip.target == "esp32", f"got '{prog.chip.target}'")
check("chip has region", prog.chip.region.start_line > 0)


# ============================================================
print("\n=== Test 2: Hardware block ===\n")
# ============================================================

prog = parse("""
hardware {
    pin led: Output = 2
    pin button: Input.PullUp = 0
    pin battery: Analog = 36
}
""")
check("hardware exists", prog.hardware is not None)
check("3 pins", len(prog.hardware.pins) == 3, f"got {len(prog.hardware.pins)}")
check("led name", prog.hardware.pins[0].name == "led")
check("led mode", prog.hardware.pins[0].mode == "Output")
check("led gpio", prog.hardware.pins[0].gpio == 2)
check("button mode", prog.hardware.pins[1].mode == "Input.PullUp")
check("battery mode", prog.hardware.pins[2].mode == "Analog")
check("battery gpio", prog.hardware.pins[2].gpio == 36)


# ============================================================
print("\n=== Test 3: Function ===\n")
# ============================================================

prog = parse("""
func add(a: int, b: int) -> int {
    return a + b
}
""")
check("1 function", len(prog.functions) == 1)
f = prog.functions[0]
check("func name", f.name == "add")
check("2 params", len(f.params) == 2)
check("param a:int", f.params[0].name == "a" and f.params[0].type_name == "int")
check("param b:int", f.params[1].name == "b" and f.params[1].type_name == "int")
check("return type", f.return_type == "int")
check("body has return", len(f.body) == 1 and isinstance(f.body[0], ReturnStmt))
ret = f.body[0]
check("return is binary +", isinstance(ret.value, BinaryExpr) and ret.value.op == "+")


# ============================================================
print("\n=== Test 4: Task with every ===\n")
# ============================================================

prog = parse("""
task blink() {
    every 500ms {
        led.toggle()
    }
}
""")
check("1 task", len(prog.tasks) == 1)
t = prog.tasks[0]
check("task name", t.name == "blink")
check("body has every", len(t.body) == 1 and isinstance(t.body[0], EveryBlock))
every = t.body[0]
check("interval 500ms", every.interval.milliseconds == 500)
check("not strict", every.strict == False)
check("body has method call", len(every.body) == 1 and isinstance(every.body[0], ExprStmt))
call = every.body[0].expr
check("is MethodCall", isinstance(call, MethodCall))
check("method is toggle", call.method == "toggle")
check("obj is led", isinstance(call.obj, VarRef) and call.obj.name == "led")


# ============================================================
print("\n=== Test 5: Variables and expressions ===\n")
# ============================================================

prog = parse("""
main {
    let x = 42
    let pi: float = 3.14
    var count = 0
    count = count + 1
    let flag = !done
    let neg = -5
}
""")
check("main exists", prog.main is not None)
stmts = prog.main.body
check("6 statements", len(stmts) == 6, f"got {len(stmts)}")

# let x = 42
check("x is VarDecl", isinstance(stmts[0], VarDecl))
check("x immutable", stmts[0].mutable == False)
check("x = 42", isinstance(stmts[0].value, IntLiteral) and stmts[0].value.value == 42)

# let pi: float = 3.14
check("pi typed float", stmts[1].type_name == "float")
check("pi = 3.14", isinstance(stmts[1].value, FloatLiteral) and abs(stmts[1].value.value - 3.14) < 0.01)

# var count = 0
check("count mutable", stmts[2].mutable == True)

# count = count + 1
check("assign", isinstance(stmts[3], AssignExpr))
check("assign target", isinstance(stmts[3].target, VarRef) and stmts[3].target.name == "count")
check("assign value is +", isinstance(stmts[3].value, BinaryExpr) and stmts[3].value.op == "+")

# let flag = !done
check("not expr", isinstance(stmts[4].value, UnaryExpr) and stmts[4].value.op == "!")

# let neg = -5
check("neg expr", isinstance(stmts[5].value, UnaryExpr) and stmts[5].value.op == "-")


# ============================================================
print("\n=== Test 6: Control flow ===\n")
# ============================================================

prog = parse("""
main {
    if x > 0 {
        log("positive")
    } else {
        log("non-positive")
    }
    while running {
        tick()
    }
    for i in 0..10 {
        log(i)
    }
}
""")
stmts = prog.main.body
check("3 statements", len(stmts) == 3, f"got {len(stmts)}")
check("if stmt", isinstance(stmts[0], IfStmt))
check("if has else", stmts[0].else_body is not None)
check("while stmt", isinstance(stmts[1], WhileStmt))
check("for stmt", isinstance(stmts[2], ForStmt))
check("for var", stmts[2].var_name == "i")


# ============================================================
print("\n=== Test 7: Durations ===\n")
# ============================================================

prog = parse("""
main {
    let a = 100us
    let b = 500ms
    let c = 1second
    let d = 5seconds
    let e = 1minute
    let f = 10minutes
    let g = 1hour
    let h = 24hours
}
""")
durations = [s.value for s in prog.main.body]
expected = [0, 500, 1000, 5000, 60000, 600000, 3600000, 86400000]
for i, (dur, exp) in enumerate(zip(durations, expected)):
    check(f"duration {dur.original} = {exp}ms",
          isinstance(dur, DurationLiteral) and dur.milliseconds == exp,
          f"got {dur.milliseconds}")


# ============================================================
print("\n=== Test 8: Method calls and chaining ===\n")
# ============================================================

prog = parse("""
main {
    led.toggle()
    wifi.connect("net", "pass")
    a.b.c()
    log(42)
}
""")
stmts = prog.main.body

# led.toggle()
call0 = stmts[0].expr
check("led.toggle is MethodCall", isinstance(call0, MethodCall))
check("obj is led", isinstance(call0.obj, VarRef) and call0.obj.name == "led")
check("method is toggle", call0.method == "toggle")
check("no args", len(call0.args) == 0)

# wifi.connect("net", "pass")
call1 = stmts[1].expr
check("wifi.connect is MethodCall", isinstance(call1, MethodCall))
check("2 string args", len(call1.args) == 2)

# a.b.c()
call2 = stmts[2].expr
check("a.b.c is MethodCall", isinstance(call2, MethodCall))
check("method is c", call2.method == "c")
check("obj is DotAccess", isinstance(call2.obj, DotAccess))

# log(42)
call3 = stmts[3].expr
check("log is FuncCall", isinstance(call3, FuncCall))
check("log name", call3.name == "log")


# ============================================================
print("\n=== Test 9: State machine ===\n")
# ============================================================

prog = parse("""
machine DeviceState {
    state idle {
        on button.press() -> connecting
    }
    state connecting {
        enter {
            led.blink(200ms)
        }
        on wifi.connected() -> running
        after 10seconds -> error
    }
    state running {
        on wifi.disconnected() -> connecting
    }
    state error {
        after 5seconds -> idle
    }
}
""")
check("1 machine", len(prog.machines) == 1)
m = prog.machines[0]
check("machine name", m.name == "DeviceState")
check("4 states", len(m.states) == 4, f"got {len(m.states)}")
check("state names", [s.name for s in m.states] == ["idle", "connecting", "running", "error"])

# connecting state
conn = m.states[1]
check("connecting has enter", len(conn.enter_body) > 0)
check("connecting has on->", len(conn.transitions) == 1)
check("connecting has after->", len(conn.timed_transitions) == 1)
check("after 10seconds", conn.timed_transitions[0].duration.milliseconds == 10000)
check("after -> error", conn.timed_transitions[0].target_state == "error")


# ============================================================
print("\n=== Test 10: Storage ===\n")
# ============================================================

prog = parse("""
storage boot_count: int = 0
storage last_temp: float = 0.0
""")
check("2 storage vars", len(prog.storage_vars) == 2)
check("boot_count", prog.storage_vars[0].name == "boot_count")
check("boot_count type", prog.storage_vars[0].type_name == "int")
check("last_temp", prog.storage_vars[1].name == "last_temp")


# ============================================================
print("\n=== Test 11: Full program ===\n")
# ============================================================

prog = parse("""
chip esp32

hardware {
    pin led: Output = 2
    pin battery: Analog = 36
}

storage boot_count: int = 0

struct Reading {
    temperature: float
    humidity: float
}

func clamp(val: int, lo: int, hi: int) -> int {
    if val < lo {
        return lo
    }
    if val > hi {
        return hi
    }
    return val
}

task blink() {
    every 500ms {
        led.toggle()
    }
}

task monitor() {
    var count = 0
    every 5seconds {
        count = count + 1
        let bat = battery.read()
        mqtt.send_int("volt/bat", clamp(bat, 0, 4095))
    }
}

main {
    wifi.connect("MyNet", "MyPass")
    mqtt.connect("mqtt://broker.local")
    run(blink, monitor)
}
""")
check("chip esp32", prog.chip.target == "esp32")
check("hardware", prog.hardware is not None)
check("2 pins", len(prog.hardware.pins) == 2)
check("1 storage", len(prog.storage_vars) == 1)
check("1 struct", len(prog.structs) == 1)
check("1 function", len(prog.functions) == 1)
check("2 tasks", len(prog.tasks) == 2)
check("main exists", prog.main is not None)
check("main has 3 stmts", len(prog.main.body) == 3)


# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}\n")

if failed > 0:
    exit(1)
