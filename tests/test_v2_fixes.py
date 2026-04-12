"""
Tests for v2 bug fixes — string buffers, storage types, exit body checking,
atomic events, precedence, sized integers, and new v2 syntax.
"""
import sys
sys.path.insert(0, 'src')

from volt.compiler.voltc import compile_volt

passed = 0
failed = 0
total = 0

def check(name, condition, detail=""):
    global passed, failed, total
    total += 1
    if condition:
        passed += 1
        print(f"  OK: {name}")
    else:
        failed += 1
        print(f"FAIL: {name} — {detail}")

def compile_ok(name, src):
    c, e = compile_volt(src)
    errs = [x for x in e.errors if x.severity == 'error']
    check(name, c is not None and len(errs) == 0,
          f"errors: {[x.message for x in errs]}")
    return c, e

def compile_has(name, src, needle):
    c, e = compile_volt(src)
    check(name, c is not None and needle in c,
          f"'{needle}' not found in output")
    return c

def compile_warns(name, src, needle):
    c, e = compile_volt(src)
    warns = [x for x in e.errors if x.severity == 'warning']
    check(name, any(needle in x.message for x in warns),
          f"expected warning containing '{needle}'")

def compile_err(name, src, needle=""):
    c, e = compile_volt(src)
    errs = [x for x in e.errors if x.severity == 'error']
    if needle:
        check(name, any(needle in x.message for x in errs),
              f"expected error containing '{needle}', got: {[x.message for x in errs]}")
    else:
        check(name, len(errs) > 0, "expected error but compiled OK")

# ============================================================
print("\n=== FIX 1: String buffer count (16 slots, not 4) ===\n")
# ============================================================

compile_has("16 string buffers",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    log("test", "a" + 1 + "b" + 2 + "c" + 3 + "d" + 4 + "e" + 5)
}
""", "_volt_strbuf[16][128]")

# ============================================================
print("\n=== FIX 3: State machine exit_body type-checked ===\n")
# ============================================================

compile_err("exit body type error",
    """chip esp32
hardware {
    pin led: Output = 2
}
machine Test {
    initial state on {
        exit {
            let x = oops_undefined
        }
        after 5s -> off
    }
    state off {
        after 5s -> on
    }
}
""", "oops_undefined")

# ============================================================
print("\n=== FIX 4: Atomic event flags ===\n")
# ============================================================

compile_has("atomic event flags",
    """chip esp32
hardware {
    pin led: Output = 2
}
machine Door {
    initial state locked {
        on unlock_cmd -> unlocked
    }
    state unlocked {
        on lock_cmd -> locked
    }
}
""", "_Atomic bool")

compile_has("atomic event clear",
    """chip esp32
hardware {
    pin led: Output = 2
}
machine Door {
    initial state locked {
        on unlock_cmd -> unlocked
    }
    state unlocked {
        on lock_cmd -> locked
    }
}
""", "__atomic_store_n")

# ============================================================
print("\n=== FIX 6: < > at comparison precedence ===\n")
# ============================================================

c6, _ = compile_ok("comparison compiles",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    let x = 5
    if x < 10 {
        led.on()
    }
    if x > 0 {
        led.off()
    }
}
""")
check("< generates correctly", c6 is not None and "x < 10" in c6, f"got: {c6[:500] if c6 else 'None'}")
check("> generates correctly", c6 is not None and "x > 0" in c6, f"got: {c6[:500] if c6 else 'None'}")

# ============================================================
print("\n=== FIX 7: Sized integers (u8, u16, u32) ===\n")
# ============================================================

compile_has("u8 generates uint8_t",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    var mask: u8 = 0xFF
}
""", "uint8_t")

compile_has("u16 generates uint16_t",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    var val: u16 = 1024
}
""", "uint16_t")

compile_has("u32 generates uint32_t",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    var counter: u32 = 0
}
""", "uint32_t")

compile_ok("u8 bitwise ops type check",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    var mask: u8 = 0xFF
    let result = mask & 0x0F
}
""")

# ============================================================
print("\n=== v2 SYNTAX: setup, loop, task, durations ===\n")
# ============================================================

compile_ok("setup block",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    led.on()
    sleep(1s)
    led.off()
}
""")

compile_has("loop generates while(1)",
    """chip esp32
hardware {
    pin led: Output = 2
}
loop {
    led.toggle()
    sleep(500ms)
}
""", "while (1)")

compile_ok("task without parens",
    """chip rp2040
hardware {
    pin led: Output = 25
}
task blink {
    every 500ms {
        led.toggle()
    }
}
""")

compile_has("short duration 1s = 1000ms",
    """chip esp32
hardware {
    pin led: Output = 2
}
task blink {
    every 1s {
        led.toggle()
    }
}
""", "1000")

compile_has("short duration 5min = 300000ms",
    """chip esp32
hardware {
    pin led: Output = 2
}
task blink {
    every 5min {
        led.toggle()
    }
}
""", "300000")

compile_has("100us preserved in microseconds",
    """chip esp32
hardware {
    pin led: Output = 2
}
task fast {
    every 100us strict {
        led.toggle()
    }
}
""", "fast_isr, 100")

# ============================================================
print("\n=== v2 SYNTAX: bitwise operators ===\n")
# ============================================================

compile_has("bitwise AND",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    let x = 0xFF & 0x0F
}
""", "255 & 15")

compile_has("bitwise OR",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    let x = 0x0F | 0xF0
}
""", "15 | 240")

compile_has("left shift",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    let x = 1 << 4
}
""", "1 << 4")

compile_has("right shift",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    let x = 256 >> 2
}
""", "256 >> 2")

compile_has("bitwise NOT",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    let x = ~0xFF
}
""", "~255")

# ============================================================
print("\n=== v2 SYNTAX: compound assignment ===\n")
# ============================================================

compile_has("+=",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    var x: int = 0
    x += 10
}
""", "+= 10")

compile_has("|=",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    var mask: int = 0
    mask |= 0x04
}
""", "|= 4")

# ============================================================
print("\n=== v2 SYNTAX: block comments ===\n")
# ============================================================

compile_ok("block comment",
    """chip esp32
/* This is a
   multi-line comment */
hardware {
    pin led: Output = 2
}
setup {
    /* inline */ led.on()
}
""")

# ============================================================
print("\n=== v2 SYNTAX: break and continue ===\n")
# ============================================================

compile_has("break in loop",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    var i: int = 0
    while i < 10 {
        if i == 5 {
            break
        }
        i += 1
    }
}
""", "break;")

compile_has("continue in loop",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    var i: int = 0
    while i < 10 {
        i += 1
        if i == 5 {
            continue
        }
    }
}
""", "continue;")

# ============================================================
print("\n=== v2 SYNTAX: binary literals ===\n")
# ============================================================

compile_ok("binary literal 0b1010",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    let x = 0b10100011
}
""")

# ============================================================
print("\n=== v2: RP2040 codegen ===\n")
# ============================================================

compile_has("rp2040 int main",
    """chip rp2040
hardware {
    pin led: Output = 25
}
setup {
    led.on()
}
""", "int main(void)")

compile_has("rp2040 stdio_init_all",
    """chip rp2040
hardware {
    pin led: Output = 25
}
setup {
    led.on()
}
""", "stdio_init_all()")

compile_has("rp2040 pico/stdlib.h",
    """chip rp2040
hardware {
    pin led: Output = 25
}
setup {
    led.on()
}
""", 'pico/stdlib.h')

compile_has("esp32 app_main",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    led.on()
}
""", "void app_main(void)")

# ============================================================
print("\n=== v2: multi-every auto-split ===\n")
# ============================================================

c_multi, _ = compile_ok("multi-every compiles",
    """chip esp32
hardware {
    pin led1: Output = 2
    pin led2: Output = 4
}
task blinker {
    every 1s {
        led1.toggle()
    }
    every 100ms {
        led2.toggle()
    }
}
""")
check("auto-split creates 2 tasks", c_multi is not None and "blinker_2_run" in c_multi)

# ============================================================
print("\n=== v2: tasks auto-start ===\n")
# ============================================================

compile_has("tasks in table without run()",
    """chip esp32
hardware {
    pin led: Output = 2
}
task blink {
    every 500ms {
        led.toggle()
    }
}
""", "volt_run(_tasks, 1)")

# ============================================================
print("\n=== v2: stdatomic.h included ===\n")
# ============================================================

compile_has("stdatomic.h",
    """chip esp32
hardware {
    pin led: Output = 2
}
setup {
    led.on()
}
""", "stdatomic.h")

# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{total} passed, {failed} failed")
print(f"{'='*60}\n")

if failed > 0:
    exit(1)
