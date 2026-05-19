"""
Formatter tests — verify AST-aware code formatting.

The formatter parses through the real Volt parser, so it automatically
supports all language features. These tests verify formatting correctness
and serve as a regression guard when the DSL is updated.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
from volt.compiler.formatter import format_source

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

def fmt_has(result, text, name):
    check(name, text in result, f"'{text}' not found")

def fmt_not(result, text, name):
    check(name, text not in result, f"'{text}' should NOT appear")


# ============================================================
print("\n=== Indentation ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{
pin led:Output=2
}
task blink{
every 500ms{
var x:int=1
led.toggle()
log("app","tick")
}
}
""")
fmt_has(r, "    pin led: Output = 2", "pin indented 4 spaces")
fmt_has(r, "        var x: int = 1", "nested body indented 8 spaces")
fmt_not(r, "\t", "no tabs in output")


# ============================================================
print("\n=== Spacing around operators ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2}
setup{
var x:int=1+2
var y:float=3.14
if x>0{led.on()}
}
""")
fmt_has(r, "var x: int = 1 + 2", "spaces around = and +")
fmt_has(r, "var y: float = 3.14", "spaces around =")
fmt_has(r, "if x > 0", "space around >")


# ============================================================
print("\n=== Single-line blocks ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2}
task blink{
every 500ms{led.toggle()}
}
""")
fmt_has(r, "every 500ms { led.toggle() }", "short body on one line")


# ============================================================
print("\n=== Hardware block formatting ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2
pin btn:PullUpInput=0
bus i2c0:I2C(sda:21,scl:22)
device bme:BME280 on i2c0 at 0x76}
""")
fmt_has(r, "hardware {", "hardware opening brace on same line")
fmt_has(r, "    pin led: Output = 2", "pin on own line")
fmt_has(r, "    pin btn: PullUpInput = 0", "second pin on own line")
fmt_has(r, "    bus i2c0: I2C(sda: 21, scl: 22)", "bus type uppercase")
fmt_has(r, "    device bme: BME280 on i2c0 at 0x76", "sensor address as hex")
fmt_has(r, "}", "closing brace")


# ============================================================
print("\n=== Enum formatting ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2}
enum Color{red,green,blue}
""")
fmt_has(r, "enum Color { red, green, blue }", "short enum on one line")


# ============================================================
print("\n=== State machine formatting ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2}
machine blinker{
state off{
enter{led.off()}
after 1s->on
}
state on{
enter{led.on()}
after 500ms->off
}
}
""")
fmt_has(r, "machine blinker {", "machine header")
fmt_has(r, "    initial state off {", "first state is initial")
fmt_has(r, "        enter { led.off() }", "enter block inline")
fmt_has(r, "        after 1s -> on", "timed transition")
fmt_has(r, "    state on {", "second state")
fmt_has(r, "        after 500ms -> off", "second timed transition")


# ============================================================
print("\n=== If/else formatting ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2}
setup{
var x:int=5
if x>0{led.on()}else{led.off()}
}
""")
fmt_has(r, "    if x > 0 {", "if on own line")
fmt_has(r, "    } else {", "else on same line as closing brace")


# ============================================================
print("\n=== For loop formatting ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2}
setup{
for i in 0..10 step 2{led.toggle()}
}
""")
fmt_has(r, "for i in 0..10 step 2", "for loop with step")


# ============================================================
print("\n=== Match formatting ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2}
enum Mode{idle,running}
setup{
var m:Mode=Mode.idle
match(m){
.idle->led.off()
.running->led.on()
_->led.toggle()
}
}
""")
fmt_has(r, "    match(m) {", "match statement")
fmt_has(r, "        .idle -> led.off()", "match arm formatted")
fmt_has(r, "        _ -> led.toggle()", "wildcard arm")


# ============================================================
print("\n=== Channel formatting ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2}
channel data:int[16]
""")
fmt_has(r, "channel data: int[16]", "channel with capacity")


# ============================================================
print("\n=== Storage formatting ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2}
storage boot_count:int=0
""")
fmt_has(r, "storage boot_count: int = 0", "storage declaration")


# ============================================================
print("\n=== Shared var formatting ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2}
shared var counter:int=0
""")
fmt_has(r, "shared var counter: int = 0", "shared var")


# ============================================================
print("\n=== Or expressions ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2}
task worker{
every 1s{
led.toggle() or skip
led.on() or retry(3)
led.off() or restart
}
}
""")
fmt_has(r, "led.toggle() or skip", "or skip preserved")
fmt_has(r, "led.on() or retry(3)", "or retry preserved")
fmt_has(r, "led.off() or restart", "or restart preserved")


# ============================================================
print("\n=== Function formatting ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2}
func add(a:int,b:int)->int{return a+b}
""")
fmt_has(r, "func add(a: int, b: int) -> int {", "function header")
fmt_has(r, "    return a + b", "return with spacing")


# ============================================================
print("\n=== Duration preservation ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2}
task blink{
every 500ms{led.toggle()}
}
task slow{
every 2s{led.toggle()}
}
""")
fmt_has(r, "every 500ms", "500ms preserved")
fmt_has(r, "every 2s", "2s preserved")


# ============================================================
print("\n=== Blank lines between top-level items ===\n")
# ============================================================

r = format_source("""
chip esp32
hardware{pin led:Output=2}
task a{every 1s{led.toggle()}}
task b{every 2s{led.toggle()}}
""")
check("blank line between tasks", "\n\n" in r.split("task a")[1].split("task b")[0],
      "should have blank line between task a and task b")


# ============================================================
print("\n=== Cross-chip: RP2040 ===\n")
# ============================================================

r = format_source("""
chip rp2040
hardware{pin led:Output=25}
task blink{every 500ms{led.toggle()}}
""")
fmt_has(r, "chip rp2040", "rp2040 chip preserved")
fmt_has(r, "pin led: Output = 25", "rp2040 pin formatted")


# ============================================================
print("\n=== Fallback on bad syntax ===\n")
# ============================================================

r = format_source("this is { not valid } volt {code}")
check("fallback doesn't crash", r is not None and len(r) > 0)
fmt_has(r, "not valid", "content preserved in fallback")


# ============================================================
print("\n=== Idempotent (format twice = same result) ===\n")
# ============================================================

src = """
chip esp32
hardware{pin led:Output=2}
task blink{every 500ms{led.toggle()}}
setup{var x:int=0
x=x+1
log(\"app\",\"done\")
}
"""
r1 = format_source(src)
r2 = format_source(r1)
check("formatting is idempotent", r1 == r2,
      "formatting same source twice should produce identical output")


# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
