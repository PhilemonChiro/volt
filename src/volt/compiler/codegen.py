"""
Volt Code Generator — Pass 7: AST → C Source

Generates clean, readable C code from the transformed AST.
The output uses the Volt C framework (pin.h, task.h, wifi.h, etc.)
and is ready for compilation with ESP-IDF.

Key features:
- Counter-based yield labels (not __LINE__) for #line directive safety
- Context structs for lifted variables
- Three-tier task generation (background/priority/critical)
- #line directives on user code only (not boilerplate)

Input:  Transformed AST from Pass 6
Output: C source code string
"""

from .ast_nodes import *


# C keywords that Volt names might collide with
C_KEYWORDS = {
    "auto", "break", "case", "char", "const", "continue", "default",
    "do", "double", "else", "enum", "extern", "float", "for", "goto",
    "if", "int", "long", "register", "return", "short", "signed",
    "sizeof", "static", "struct", "switch", "typedef", "union",
    "unsigned", "void", "volatile", "while", "NULL", "bool",
}

# Volt type → C type
TYPE_MAP = {
    "int": "int32_t",
    "i8": "int8_t",
    "i16": "int16_t",
    "i32": "int32_t",
    "u8": "uint8_t",
    "u16": "uint16_t",
    "u32": "uint32_t",
    "float": "float",
    "bool": "bool",
    "string": "const char*",
    "void": "void",
    "Duration": "uint32_t",
    "unknown": "int32_t",
}

# Volt method → C framework function
METHOD_MAP = {
    # Pin methods
    ("Output", "on"):      "pin_write({gpio}, HIGH)",
    ("Output", "off"):     "pin_write({gpio}, LOW)",
    ("Output", "toggle"):  "pin_toggle({gpio})",
    ("Output", "write"):   "pin_write({gpio}, {args})",
    ("Output", "is_on"):   "pin_read({gpio})",
    ("Output", "blink"):      "pin_blink({gpio}, {args})",
    ("Output", "blink_once"): "pin_blink_once({gpio}, {args})",
    ("Input", "read"):     "pin_read({gpio})",
    ("Input.PullUp", "read"):      "pin_read({gpio})",
    ("Input.PullUp", "is_pressed"): "(pin_read({gpio}) == LOW)",
    ("Input.PullDown", "read"):     "pin_read({gpio})",
    ("Analog", "read"):    "pin_read({gpio})",
    ("PWM", "set_pwm"):    "pin_write({gpio}, {args})",
    ("PWM", "write"):      "pin_write({gpio}, {args})",
    # WiFi
    ("WiFi", "connect"):      "wifi_connect({args})",
    ("WiFi", "disconnect"):   "wifi_disconnect()",
    ("WiFi", "is_connected"): "wifi_is_connected()",
    ("WiFi", "get_ip"):       "wifi_get_ip()",
    ("WiFi", "get_rssi"):     "wifi_get_rssi()",
    # MQTT
    ("MQTT", "connect"):      "mqtt_connect({args})",
    ("MQTT", "disconnect"):   "mqtt_disconnect()",
    ("MQTT", "send"):         "mqtt_send({args})",
    ("MQTT", "send_float"):   "mqtt_send_float({args})",
    ("MQTT", "send_int"):     "mqtt_send_int({args})",
    ("MQTT", "on_receive"):   "mqtt_on_receive({args}, NULL)",
    ("MQTT", "is_connected"): "mqtt_is_connected()",
    # HTTP
    ("HTTP", "get"):  "http_get({args}, NULL, 0, NULL)",
    ("HTTP", "post"): "http_post({args}, NULL, NULL, 0, NULL)",
    # Storage
    ("Storage", "save"):       "storage_save_int({args})",
    ("Storage", "load"):       "storage_load_int({args}, 0)",
    ("Storage", "push"):       "storage_push({args})",
    ("Storage", "drain"):      "storage_drain({args})",
    ("Storage", "list_count"): "storage_list_count({args})",
    ("Storage", "list_clear"): "storage_list_clear({args})",
    # System — portable names (implemented per-chip)
    ("System", "restart"):     "system_restart()",
    ("System", "free_heap"):   "system_free_heap()",
    ("System", "uptime"):      "system_uptime()",
    ("System", "id"):          "system_id()",
    # OTA
    ("OTA", "enable"): "ota_enable()",
}

# Builtin function → C function
BUILTIN_MAP = {
    "log":         "log_info({args})",
    "sleep":       None,  # handled specially (yield point)
    "deep_sleep":  "system_deep_sleep({args} * 1000)",
    "light_sleep": "system_light_sleep()",
    "run":         None,  # handled in app_main generation
}


def _collect_var_refs(stmts: list) -> set:
    """Collect all variable names referenced in a statement list (recursive)."""
    names = set()
    for stmt in stmts:
        if stmt is None:
            continue
        if isinstance(stmt, VarDecl) and stmt.value:
            names |= _collect_expr_refs(stmt.value)
        elif isinstance(stmt, AssignExpr):
            if isinstance(stmt.target, VarRef):
                names.add(stmt.target.name)
            names |= _collect_expr_refs(stmt.value)
        elif isinstance(stmt, ExprStmt):
            names |= _collect_expr_refs(stmt.expr)
        elif isinstance(stmt, ReturnStmt) and stmt.value:
            names |= _collect_expr_refs(stmt.value)
        elif isinstance(stmt, IfStmt):
            names |= _collect_expr_refs(stmt.condition)
            names |= _collect_var_refs(stmt.then_body)
            if isinstance(stmt.else_body, list):
                names |= _collect_var_refs(stmt.else_body)
            elif isinstance(stmt.else_body, IfStmt):
                names |= _collect_var_refs([stmt.else_body])
        elif isinstance(stmt, WhileStmt):
            names |= _collect_expr_refs(stmt.condition)
            names |= _collect_var_refs(stmt.body)
        elif isinstance(stmt, ForStmt):
            names |= _collect_var_refs(stmt.body)
        elif isinstance(stmt, EveryBlock):
            names |= _collect_var_refs(stmt.body)
        elif isinstance(stmt, OnBlock):
            names |= _collect_var_refs(stmt.body)
    return names


def _collect_expr_refs(expr) -> set:
    """Collect all variable names from an expression tree."""
    if expr is None:
        return set()
    names = set()
    if isinstance(expr, VarRef):
        names.add(expr.name)
    elif isinstance(expr, BinaryExpr):
        names |= _collect_expr_refs(expr.left)
        names |= _collect_expr_refs(expr.right)
    elif isinstance(expr, UnaryExpr):
        names |= _collect_expr_refs(expr.operand)
    elif isinstance(expr, FuncCall):
        for arg in expr.args:
            names |= _collect_expr_refs(arg)
    elif isinstance(expr, MethodCall):
        names |= _collect_expr_refs(expr.obj)
        for arg in expr.args:
            names |= _collect_expr_refs(arg)
    elif isinstance(expr, AssignExpr):
        if isinstance(expr.target, VarRef):
            names.add(expr.target.name)
        names |= _collect_expr_refs(expr.value)
    return names


class CCodeGen:
    """Generates C source from a Volt AST."""

    def __init__(self, source_file: str = "main.volt"):
        self.source_file = source_file
        self.lines: list[str] = []
        self.indent = 0
        self.pin_map: dict[str, tuple[int, str]] = {}  # name → (gpio, mode)
        self.sensor_map: dict[str, str] = {}  # name → sensor_type
        self.builtin_types: dict[str, str] = {}  # name → type (WiFi, MQTT, etc.)

    def generate(self, program: Program) -> str:
        """Generate complete C source from AST."""

        # Build maps
        self._build_maps(program)
        self._needs_sprintf_buf = False
        self._sprintf_buf_idx = 0

        # Section 1: Header
        self._emit_header(program)

        # Section 2: Forward declarations
        self._emit_forward_decls(program)

        # Section 3: Module-level variables
        self._emit_global_vars(program)

        # Section 4: Context structs (for background tasks with lifted vars)
        self._emit_context_structs(program)

        # Section 4: Storage variables
        self._emit_storage_vars(program)

        # Section 5: User functions (non-yielding)
        self._emit_functions(program)

        # Section 6: Task functions
        self._emit_tasks(program)

        # Section 6b: State machine functions
        self._emit_machines(program)

        # Section 7: app_main
        self._emit_app_main(program)

        return "\n".join(self.lines) + "\n"

    # ============================================================
    # Map building
    # ============================================================

    def _build_maps(self, program: Program):
        if program.hardware:
            for pin in program.hardware.pins:
                self.pin_map[pin.name] = (pin.gpio, pin.mode)
            for sensor in program.hardware.sensors:
                self.sensor_map[sensor.name] = sensor.sensor_type

        # Builtins
        self.builtin_types = {
            "wifi": "WiFi", "mqtt": "MQTT", "http": "HTTP",
            "storage": "Storage", "system": "System", "ota": "OTA",
        }

    # ============================================================
    # Section emitters
    # ============================================================

    def _get_chip_family(self, program: Program) -> str:
        """Return chip family: 'esp32', 'esp8266', 'rp2040', 'stm32', or 'esp32' as default."""
        if program.chip:
            target = program.chip.target.lower()
            if "rp2040" in target or "pico" in target:
                return "rp2040"
            elif "8266" in target:
                return "esp8266"
            elif "stm32" in target:
                return "stm32"
        return "esp32"

    def _emit_header(self, program: Program):
        chip = self._get_chip_family(program)

        self._out("// Generated by Volt compiler — do not edit")
        self._out(f"// Source: {self.source_file}")
        self._out("")
        self._out("#include <stdint.h>")

        # Chip-specific top-level include
        if chip == "rp2040":
            self._out('#include "pico/stdlib.h"')

        self._out("#include <stdbool.h>")
        self._out("#include <string.h>")
        self._out("#include <stdio.h>")
        self._out('#include "volt/volt.h"')

        # Conditional includes based on usage
        if self._uses_wifi(program):
            self._out('#include "volt/wifi.h"')
        if self._uses_mqtt(program):
            self._out('#include "volt/mqtt.h"')
        if self._uses_http(program):
            self._out('#include "volt/http.h"')
        if self._uses_storage(program):
            self._out('#include "volt/storage.h"')
        self._out("")
        # String interpolation buffers (used by string + int concat)
        self._out("static char _volt_strbuf[4][128];")
        self._out("")

    def _emit_forward_decls(self, program: Program):
        self._out("// Forward declarations")
        for task in program.tasks:
            if task.tier == "background":
                self._out(f"static void {task.name}_run(volt_task_t *_vt);")
            elif task.tier == "priority":
                self._out(f"static void {task.name}_run(void *arg);")
            elif task.tier == "critical":
                self._out(f"static void {task.name}_isr(void *arg);")
        for func in program.functions:
            if not func.contains_yield:
                ret = TYPE_MAP.get(func.return_type, "void")
                params = ", ".join(f"{TYPE_MAP.get(p.type_name, 'int32_t')} {_c_name(p.name)}"
                                   for p in func.params)
                self._out(f"static {ret} {_c_name(func.name)}({params or 'void'});")
        for machine in program.machines:
            self._out(f"static void {machine.name}_run(volt_task_t *_vt);")
        self._out("")

    def _emit_context_structs(self, program: Program):
        for task in program.tasks:
            if task.tier == "background" and task.crossing_vars:
                self._out(f"// Context struct for task '{task.name}' (lifted variables)")
                self._out(f"typedef struct {{")
                for var in _find_var_decls_by_name(task.body, task.crossing_vars):
                    c_type = TYPE_MAP.get(var.type_name, "int32_t")
                    self._out(f"    {c_type} {_c_name(var.name)};")
                self._out(f"}} {task.name}_ctx_t;")
                self._out(f"static {task.name}_ctx_t _{task.name}_ctx = {{0}};")
                self._out("")

        # Task state structs for ALL background tasks
        for task in program.tasks:
            if task.tier == "background":
                self._out(f"static volt_task_t _{task.name}_t = {{0}};")
        self._out("")

    def _emit_global_vars(self, program: Program):
        if not program.global_vars:
            return
        self._out("// Module-level variables")
        # Determine which vars are shared across tiers (need volatile)
        volatile_vars = self._find_volatile_vars(program)
        for var in program.global_vars:
            c_type = TYPE_MAP.get(var.type_name, "int32_t")
            vol = "volatile " if var.name in volatile_vars else ""
            init = ""
            if var.value is not None:
                init = f" = {self._emit_expr_str(var.value)}"
            self._out(f"static {vol}{c_type} {_c_name(var.name)}{init};")
        self._out("")

    def _find_volatile_vars(self, program: Program) -> set:
        """Find global vars accessed by tasks in different tiers — need volatile."""
        var_tiers = {}  # var_name → set of tiers
        global_names = {v.name for v in program.global_vars}
        for task in program.tasks:
            refs = _collect_var_refs(task.body)
            for name in refs:
                if name in global_names:
                    if name not in var_tiers:
                        var_tiers[name] = set()
                    var_tiers[name].add(task.tier)
        return {name for name, tiers in var_tiers.items() if len(tiers) > 1 or "critical" in tiers}

    def _emit_storage_vars(self, program: Program):
        if program.storage_vars:
            self._out("// Storage variables (persisted via NVS)")
            for sv in program.storage_vars:
                self._out(f"// storage {sv.name}: {sv.type_name}")
            self._out("")

    def _emit_functions(self, program: Program):
        for func in program.functions:
            if func.contains_yield:
                continue  # yielding functions are inlined, not emitted

            ret = TYPE_MAP.get(func.return_type, "void")
            params = ", ".join(f"{TYPE_MAP.get(p.type_name, 'int32_t')} {_c_name(p.name)}"
                               for p in func.params)
            self._out(f"static {ret} {_c_name(func.name)}({params or 'void'})")
            self._out("{")
            self.indent += 1
            self._emit_stmts(func.body)
            self.indent -= 1
            self._out("}")
            self._out("")

    def _emit_tasks(self, program: Program):
        for task in program.tasks:
            if task.tier == "background":
                self._emit_background_task(task)
            elif task.tier == "priority":
                self._emit_priority_task(task)
            elif task.tier == "critical":
                self._emit_critical_task(task)

    def _emit_background_task(self, task: TaskDecl):
        has_ctx = bool(task.crossing_vars)
        ctx_type = f"{task.name}_ctx_t"

        self._out(f"// Background task: {task.name} (protothread)")
        self._out(f"static void {task.name}_run(volt_task_t *_vt)")
        self._out("{")
        self.indent += 1

        if has_ctx:
            self._out(f"{ctx_type} *ctx = &_{task.name}_ctx;")

        self._out("VOLT_TASK_BEGIN(_vt);")
        self._emit_stmts(task.body, ctx_prefix="ctx->" if has_ctx else None,
                          crossing_vars=task.crossing_vars or [])
        self._out("VOLT_TASK_END(_vt);")

        self.indent -= 1
        self._out("}")
        self._out("")

    def _emit_priority_task(self, task: TaskDecl):
        self._out(f"// Priority task: {task.name} (FreeRTOS)")
        self._out(f"static void {task.name}_run(void *arg)")
        self._out("{")
        self.indent += 1
        # Priority tasks use vTaskDelay, not protothreads
        self._emit_stmts(task.body, use_freertos_delay=True)
        self.indent -= 1
        self._out("}")
        self._out("")

    def _emit_critical_task(self, task: TaskDecl):
        self._out(f"// Critical task: {task.name} (hardware timer ISR)")
        self._out(f"static void IRAM_ATTR {task.name}_isr(void *arg)")
        self._out("{")
        self.indent += 1
        # Critical tasks only contain the body of their every...strict block
        for stmt in task.body:
            if isinstance(stmt, EveryBlock) and stmt.strict:
                self._emit_stmts(stmt.body)
        self.indent -= 1
        self._out("}")
        self._out("")

    # ============================================================
    # State Machine Generation
    # ============================================================

    def _emit_machines(self, program: Program):
        for machine in program.machines:
            self._emit_one_machine(machine)

    def _emit_one_machine(self, machine: MachineDecl):
        name = machine.name
        states = machine.states
        initial = next((s for s in states if s.is_initial), states[0])

        # Collect all event names from transitions
        events = set()
        for s in states:
            for trans in s.transitions:
                if isinstance(trans.event, VarRef):
                    events.add(trans.event.name)
        if events:
            self._out(f"// Event flags for {name} (set by external code, cleared after handling)")
            for ev in sorted(events):
                self._out(f"static volatile bool {ev} = false;")
            self._out("")

        # State enum
        self._out(f"// State machine: {name}")
        self._out(f"typedef enum {{")
        self.indent += 1
        for s in states:
            self._out(f"{name.upper()}_{s.name.upper()},")
        self.indent -= 1
        self._out(f"}} {name}_state_t;")
        self._out("")

        # Context struct
        self._out(f"typedef struct {{")
        self.indent += 1
        self._out(f"{name}_state_t current;")
        self._out(f"uint32_t state_entered_at;")
        for var in machine.variables:
            c_type = TYPE_MAP.get(var.type_name, "int32_t")
            self._out(f"{c_type} {_c_name(var.name)};")
        self.indent -= 1
        self._out(f"}} {name}_ctx_t;")
        self._out("")

        # Static instance
        self._out(f"static {name}_ctx_t _{name}_ctx = {{")
        self.indent += 1
        self._out(f".current = {name.upper()}_{initial.name.upper()},")
        for var in machine.variables:
            val = self._emit_expr_str(var.value) if var.value else "0"
            self._out(f".{_c_name(var.name)} = {val},")
        self.indent -= 1
        self._out(f"}};")
        self._out(f"static volt_task_t _{name}_t = {{0}};")
        self._out("")

        # Transition function
        self._out(f"static void {name}_transition({name}_ctx_t *ctx, {name}_state_t new_state)")
        self._out("{")
        self.indent += 1

        # Machine variable names for ctx-> prefixing
        machine_vars = [v.name for v in machine.variables]

        # Exit actions
        self._out(f"// Exit current state")
        self._out(f"switch (ctx->current) {{")
        self.indent += 1
        for s in states:
            if s.exit_body:
                self._out(f"case {name.upper()}_{s.name.upper()}:")
                self.indent += 1
                self._emit_stmts(s.exit_body, "ctx->", machine_vars)
                self._out("break;")
                self.indent -= 1
        self._out("default: break;")
        self.indent -= 1
        self._out("}")
        self._out("")

        # Enter new state
        self._out(f"ctx->current = new_state;")
        self._out(f"ctx->state_entered_at = volt_tick_ms();")
        self._out("")
        self._out(f"// Enter new state")
        self._out(f"switch (new_state) {{")
        self.indent += 1
        for s in states:
            if s.enter_body:
                self._out(f"case {name.upper()}_{s.name.upper()}:")
                self.indent += 1
                self._emit_stmts(s.enter_body, "ctx->", machine_vars)
                self._out("break;")
                self.indent -= 1
        self._out("default: break;")
        self.indent -= 1
        self._out("}")

        self.indent -= 1
        self._out("}")
        self._out("")

        # Main run function (protothread task)
        self._out(f"// State machine task: {name} (runs as protothread)")
        self._out(f"static void {name}_run(volt_task_t *_vt)")
        self._out("{")
        self.indent += 1
        self._out(f"{name}_ctx_t *ctx = &_{name}_ctx;")
        self._out(f"VOLT_TASK_BEGIN(_vt);")
        self._out("")

        # Enter initial state
        self._out(f"// Enter initial state")
        self._out(f"{name}_transition(ctx, {name.upper()}_{initial.name.upper()});")
        self._out("")

        # Collect machine variable names for ctx-> prefixing
        machine_vars = [v.name for v in machine.variables]

        # Main loop: check timeouts and periodic actions
        self._out(f"for (;;) {{")
        self.indent += 1
        self._out(f"uint32_t _elapsed = volt_tick_ms() - ctx->state_entered_at;")
        self._out("")

        self._out(f"switch (ctx->current) {{")
        self.indent += 1

        for s in states:
            has_content = s.timed_transitions or s.transitions or s.body
            if not has_content:
                continue

            self._out(f"case {name.upper()}_{s.name.upper()}:")
            self.indent += 1

            # Timed transitions (after N -> target)
            for timed in s.timed_transitions:
                ms = timed.duration.milliseconds if isinstance(timed.duration, DurationLiteral) else 0
                guard = ""
                if timed.guard:
                    guard_str = self._emit_expr_str(timed.guard, "ctx->", machine_vars)
                    guard = f" && ({guard_str})"
                self._out(f"if ((int32_t)(_elapsed - {ms}) >= 0{guard}) {{")
                self.indent += 1
                if timed.action:
                    self._emit_stmts(timed.action, "ctx->", machine_vars)
                self._out(f"{name}_transition(ctx, {name.upper()}_{timed.target_state.upper()});")
                self.indent -= 1
                self._out("}")

            # Event transitions
            for trans in s.transitions:
                event_str = self._emit_expr_str(trans.event, "ctx->", machine_vars)
                guard = ""
                if trans.guard:
                    guard_str = self._emit_expr_str(trans.guard, "ctx->", machine_vars)
                    guard = f" && ({guard_str})"
                self._out(f"if ({event_str}{guard}) {{")
                self.indent += 1
                # Clear the event flag so it doesn't fire again
                if isinstance(trans.event, VarRef):
                    self._out(f"{trans.event.name} = false;")
                if trans.action:
                    self._emit_stmts(trans.action, "ctx->", machine_vars)
                self._out(f"{name}_transition(ctx, {name.upper()}_{trans.target_state.upper()});")
                self.indent -= 1
                self._out("}")

            # Body statements (every blocks inside states)
            if s.body:
                for stmt in s.body:
                    self._emit_stmt(stmt, "ctx->", machine_vars)

            self._out("break;")
            self.indent -= 1

        self._out("default: break;")
        self.indent -= 1
        self._out("}")  # switch
        self._out("")

        self._out(f"VOLT_YIELD_LABEL(_vt, 1, 10); // poll every 10ms")

        self.indent -= 1
        self._out("}")  # for
        self._out(f"VOLT_TASK_END(_vt);")

        self.indent -= 1
        self._out("}")
        self._out("")

    def _emit_app_main(self, program: Program):
        chip = self._get_chip_family(program)

        if chip == "rp2040":
            self._out("int main(void)")
        else:
            self._out("void app_main(void)")
        self._out("{")
        self.indent += 1

        # RP2040 needs stdio_init_all() for USB serial
        if chip == "rp2040":
            self._out("stdio_init_all();")

        # Storage init
        if program.storage_vars or self._uses_storage(program):
            self._out("storage_init();")

        self._out("volt_init();")
        self._out("")

        # Pin initialization
        if program.hardware:
            self._out("// Hardware initialization")
            for pin in program.hardware.pins:
                if pin.mode == "Output":
                    self._out(f"pin_set_output({pin.gpio});")
                elif pin.mode == "Input":
                    self._out(f"pin_set_input({pin.gpio});")
                elif pin.mode == "Input.PullUp":
                    self._out(f"pin_set_input_pullup({pin.gpio});")
                elif pin.mode == "Input.PullDown":
                    self._out(f"pin_set_input_pulldown({pin.gpio});")
                elif pin.mode == "Analog":
                    pass  # ADC pins don't need explicit init
                elif pin.mode == "PWM":
                    self._out(f"pin_set_output({pin.gpio}); // PWM")
            self._out("")

        # Storage variable loading
        for sv in program.storage_vars:
            c_type = TYPE_MAP.get(sv.type_name, "int32_t")
            if sv.type_name == "int":
                default = self._emit_expr_str(sv.default_value)
                self._out(f"// load storage: {sv.name}")
            elif sv.type_name == "float":
                default = self._emit_expr_str(sv.default_value)

        # Setup block — runs once before tasks start
        if program.setup:
            self._out("")
            self._out("// Setup")
            self._emit_stmts(program.setup.body, use_freertos_delay=True)

        # Critical tasks (after setup — WiFi/MQTT already initialized)
        for task in program.tasks:
            if task.tier == "critical":
                for stmt in task.body:
                    if isinstance(stmt, EveryBlock) and stmt.strict:
                        ms = stmt.interval.milliseconds if isinstance(stmt.interval, DurationLiteral) else stmt.interval.value if isinstance(stmt.interval, IntLiteral) else 1
                        us = ms * 1000
                        self._out(f'volt_critical_create("{task.name}", {task.name}_isr, {us}, NULL);')

        # Priority tasks (after main block — WiFi/MQTT already initialized)
        for task in program.tasks:
            if task.tier == "priority":
                self._out(f'volt_rt_create("{task.name}", {task.name}_run, 4096, NULL, VOLT_PRIORITY_NORMAL, -1);')

        # Background task table (includes state machines as protothread tasks)
        bg_tasks = [t for t in program.tasks if t.tier == "background"]
        machines = program.machines
        total_bg = len(bg_tasks) + len(machines)

        if total_bg > 0:
            self._out("")
            self._out("// Start background tasks")
            self._out(f"volt_task_entry_t _tasks[] = {{")
            self.indent += 1
            for task in bg_tasks:
                self._out(f"{{ {task.name}_run, &_{task.name}_t }},")
            for machine in machines:
                self._out(f"{{ {machine.name}_run, &_{machine.name}_t }},")
            self.indent -= 1
            self._out("};")
            self._out(f"volt_run(_tasks, {total_bg});")

        # Loop block — super-loop mode (alternative to tasks)
        if program.loop:
            self._out("")
            self._out("// Super-loop")
            self._out("while (1) {")
            self.indent += 1
            self._emit_stmts(program.loop.body, use_freertos_delay=True)
            self.indent -= 1
            self._out("}")

        self.indent -= 1
        self._out("}")
        self._out("")

    # ============================================================
    # Statement emission
    # ============================================================

    def _emit_stmts(self, stmts: list, ctx_prefix: str = None, crossing_vars: list = None,
                     use_freertos_delay: bool = False):
        for stmt in stmts:
            self._emit_stmt(stmt, ctx_prefix, crossing_vars or [], use_freertos_delay)

    def _emit_stmt(self, stmt, ctx_prefix: str = None, crossing_vars: list = None,
                    use_freertos_delay: bool = False):
        if stmt is None:
            return
        cv = crossing_vars or []

        if isinstance(stmt, VarDecl):
            self._line_directive(stmt)
            c_type = TYPE_MAP.get(stmt.type_name, "int32_t")
            val = self._emit_expr_str(stmt.value, ctx_prefix, cv)
            if stmt.name in cv and ctx_prefix:
                # Lifted var: assign to context, don't declare
                self._out(f"{ctx_prefix}{_c_name(stmt.name)} = {val};")
            else:
                self._out(f"{c_type} {_c_name(stmt.name)} = {val};")

        elif isinstance(stmt, AssignExpr):
            self._line_directive(stmt)
            target = self._emit_expr_str(stmt.target, ctx_prefix, cv)
            val = self._emit_expr_str(stmt.value, ctx_prefix, cv)
            self._out(f"{target} = {val};")

        elif isinstance(stmt, CompoundAssign):
            self._line_directive(stmt)
            target = self._emit_expr_str(stmt.target, ctx_prefix, cv)
            val = self._emit_expr_str(stmt.value, ctx_prefix, cv)
            self._out(f"{target} {stmt.op} {val};")

        elif isinstance(stmt, BreakStmt):
            self._out("break;")

        elif isinstance(stmt, ContinueStmt):
            self._out("continue;")

        elif isinstance(stmt, ExprStmt):
            self._line_directive(stmt)
            expr_str = self._emit_expr_str(stmt.expr, ctx_prefix, cv)
            # Sleep — yield in protothreads, blocking delay in main/priority
            if isinstance(stmt.expr, FuncCall) and stmt.expr.name == "sleep":
                ms = self._emit_expr_str(stmt.expr.args[0], ctx_prefix, cv) if stmt.expr.args else "0"
                if use_freertos_delay:
                    self._out(f"volt_delay_ms({ms});")
                else:
                    label = getattr(stmt, '_yield_label', 0)
                    self._out(f"VOLT_YIELD_LABEL(_vt, {label}, {ms});")
            else:
                self._out(f"{expr_str};")

        elif isinstance(stmt, ReturnStmt):
            self._line_directive(stmt)
            if stmt.value:
                val = self._emit_expr_str(stmt.value, ctx_prefix, cv)
                self._out(f"return {val};")
            else:
                self._out("return;")

        elif isinstance(stmt, IfStmt):
            self._line_directive(stmt)
            cond = self._emit_expr_str(stmt.condition, ctx_prefix, cv)
            self._out(f"if ({cond}) {{")
            self.indent += 1
            self._emit_stmts(stmt.then_body, ctx_prefix, cv)
            self.indent -= 1
            if stmt.else_body:
                if isinstance(stmt.else_body, IfStmt):
                    self._out(f"}} else")
                    self._emit_stmt(stmt.else_body, ctx_prefix, cv)
                elif isinstance(stmt.else_body, list):
                    self._out("} else {")
                    self.indent += 1
                    self._emit_stmts(stmt.else_body, ctx_prefix, cv)
                    self.indent -= 1
                    self._out("}")
                else:
                    self._out("}")
            else:
                self._out("}")

        elif isinstance(stmt, WhileStmt):
            self._line_directive(stmt)
            cond = self._emit_expr_str(stmt.condition, ctx_prefix, cv)
            self._out(f"while ({cond}) {{")
            self.indent += 1
            self._emit_stmts(stmt.body, ctx_prefix, cv)
            self.indent -= 1
            self._out("}")

        elif isinstance(stmt, ForStmt):
            self._line_directive(stmt)
            start = self._emit_expr_str(stmt.start, ctx_prefix, cv)
            end = self._emit_expr_str(stmt.end, ctx_prefix, cv)
            var = _c_name(stmt.var_name)
            self._out(f"for (int32_t {var} = {start}; {var} < {end}; {var}++) {{")
            self.indent += 1
            self._emit_stmts(stmt.body, ctx_prefix, cv)
            self.indent -= 1
            self._out("}")

        elif isinstance(stmt, EveryBlock):
            if stmt.strict:
                # Critical: body is emitted directly in the ISR function
                return
            ms = stmt.interval.milliseconds if isinstance(stmt.interval, DurationLiteral) else 0
            self._out(f"for (;;) {{")
            self.indent += 1
            self._emit_stmts(stmt.body, ctx_prefix, cv, use_freertos_delay)
            if use_freertos_delay:
                self._out(f"volt_delay_ms({ms});")
            else:
                label = stmt.yield_label  # set by transformer Pass 6
                self._out(f"VOLT_YIELD_LABEL(_vt, {label}, {ms});")
            self.indent -= 1
            self._out("}")

        elif isinstance(stmt, OnBlock):
            event_str = self._emit_expr_str(stmt.event, ctx_prefix, cv)
            self._out(f"// on {event_str}")
            self._out(f"VOLT_WAIT_LABEL(t, {stmt.yield_label}, {event_str});")
            if stmt.debounce:
                deb_ms = stmt.debounce.milliseconds if isinstance(stmt.debounce, DurationLiteral) else 50
                self._out(f"VOLT_YIELD_LABEL(_vt, {stmt.debounce_label}, {deb_ms}); // debounce")
            self._emit_stmts(stmt.body, ctx_prefix, cv)

    # ============================================================
    # Expression emission
    # ============================================================

    def _emit_expr_str(self, expr, ctx_prefix: str = None, crossing_vars: list = None) -> str:
        if expr is None:
            return "0"
        cv = crossing_vars or []

        if isinstance(expr, IntLiteral):
            return str(expr.value)

        if isinstance(expr, FloatLiteral):
            return f"{expr.value}f"

        if isinstance(expr, BoolLiteral):
            return "true" if expr.value else "false"

        if isinstance(expr, StringLiteral):
            return f'"{expr.value}"'

        if isinstance(expr, DurationLiteral):
            return str(expr.milliseconds)

        if isinstance(expr, VarRef):
            name = _c_name(expr.name)
            if ctx_prefix and expr.name in cv:
                return f"{ctx_prefix}{name}"
            return name

        if isinstance(expr, BinaryExpr):
            # String concatenation: "text" + int → snprintf
            if expr.op == "+" and self._is_string_concat(expr):
                return self._emit_string_concat(expr, ctx_prefix, cv)
            left = self._emit_expr_str(expr.left, ctx_prefix, cv)
            right = self._emit_expr_str(expr.right, ctx_prefix, cv)
            return f"({left} {expr.op} {right})"

        if isinstance(expr, UnaryExpr):
            operand = self._emit_expr_str(expr.operand, ctx_prefix, cv)
            return f"({expr.op}{operand})"

        if isinstance(expr, DotAccess):
            obj = self._emit_expr_str(expr.obj, ctx_prefix, cv)
            return f"{obj}.{expr.field_name}"

        if isinstance(expr, FuncCall):
            args_str = ", ".join(self._emit_expr_str(a, ctx_prefix, cv) for a in expr.args)

            # Builtin functions
            if expr.name == "run":
                return "/* run() handled by task table */"
            if expr.name in BUILTIN_MAP:
                template = BUILTIN_MAP[expr.name]
                if template:
                    return template.format(args=args_str)
                return f"{expr.name}({args_str})"

            # User functions
            return f"{_c_name(expr.name)}({args_str})"

        if isinstance(expr, MethodCall):
            obj_name = expr.obj.name if isinstance(expr.obj, VarRef) else None
            args_str = ", ".join(self._emit_expr_str(a, ctx_prefix, cv) for a in expr.args)

            # Pin methods
            if obj_name and obj_name in self.pin_map:
                gpio, mode = self.pin_map[obj_name]
                key = (mode, expr.method)
                if key in METHOD_MAP:
                    return METHOD_MAP[key].format(gpio=gpio, args=args_str)
                # Fallback for modes with dots (Input.PullUp)
                base_mode = mode.split(".")[0]
                key = (base_mode, expr.method)
                if key in METHOD_MAP:
                    return METHOD_MAP[key].format(gpio=gpio, args=args_str)

            # Builtin object methods (wifi, mqtt, etc.)
            if obj_name and obj_name in self.builtin_types:
                type_name = self.builtin_types[obj_name]
                key = (type_name, expr.method)
                if key in METHOD_MAP:
                    return METHOD_MAP[key].format(args=args_str)

            # Generic method call fallback
            obj_str = self._emit_expr_str(expr.obj, ctx_prefix, cv)
            return f"{obj_str}_{expr.method}({args_str})"

        if isinstance(expr, ArrayLiteral):
            elements = ", ".join(self._emit_expr_str(e, ctx_prefix, cv) for e in expr.elements)
            return f"{{{elements}}}"

        return "/* unknown expr */"

    # ============================================================
    # Helpers
    # ============================================================

    def _out(self, text: str):
        self.lines.append("    " * self.indent + text)

    def _line_directive(self, node):
        if hasattr(node, 'region') and node.region.start_line > 0:
            # Escape quotes in filename to prevent malformed #line directives
            safe_file = self.source_file.replace('\\', '\\\\').replace('"', '\\"')
            self.lines.append(f'#line {node.region.start_line} "{safe_file}"')

    def _all_stmts(self, prog):
        """Collect all statements from tasks + setup + loop."""
        stmts = []
        for t in prog.tasks:
            stmts.extend(t.body)
        if prog.setup:
            stmts.extend(prog.setup.body)
        if prog.loop:
            stmts.extend(prog.loop.body)
        return stmts

    def _uses_wifi(self, prog):
        return any(True for _ in _find_calls(self._all_stmts(prog), "wifi"))

    def _uses_mqtt(self, prog):
        return any(True for _ in _find_calls(self._all_stmts(prog), "mqtt"))

    def _uses_http(self, prog):
        return any(True for _ in _find_calls(self._all_stmts(prog), "http"))

    def _uses_storage(self, prog):
        return bool(prog.storage_vars) or any(True for _ in _find_calls(self._all_stmts(prog), "storage"))

    # ---- String concatenation with non-string types ----

    def _is_string_concat(self, expr) -> bool:
        """Check if this binary + expression involves string concatenation with non-strings."""
        if not isinstance(expr, BinaryExpr) or expr.op != "+":
            return False
        # Flatten the concat chain and check if any part is a string literal
        parts = self._flatten_concat(expr)
        has_string = any(isinstance(p, StringLiteral) for p in parts)
        has_nonstring = any(not isinstance(p, StringLiteral) for p in parts)
        return has_string and has_nonstring

    def _flatten_concat(self, expr) -> list:
        """Flatten a chain of + expressions into a list of leaf expressions."""
        if isinstance(expr, BinaryExpr) and expr.op == "+":
            return self._flatten_concat(expr.left) + self._flatten_concat(expr.right)
        return [expr]

    def _emit_string_concat(self, expr, ctx_prefix, cv) -> str:
        """Generate snprintf for string + int/float/bool concatenation.
        Uses a rotating set of static buffers for nested concat."""
        parts = self._flatten_concat(expr)

        # Build format string and args
        fmt_parts = []
        args = []
        for part in parts:
            if isinstance(part, StringLiteral):
                # Escape % in the string for printf
                fmt_parts.append(part.value.replace("%", "%%"))
            elif isinstance(part, IntLiteral):
                fmt_parts.append("%ld")
                args.append(f"(long){part.value}")
            elif isinstance(part, FloatLiteral):
                fmt_parts.append("%.2f")
                args.append(f"{part.value}f")
            elif isinstance(part, BoolLiteral):
                fmt_parts.append("%s")
                args.append(f'{"true" if part.value else "false"}')
            else:
                # Variable or expression — infer type from context
                c_expr = self._emit_expr_str(part, ctx_prefix, cv)
                # Check if it's a method call that returns bool
                if isinstance(part, MethodCall) and part.method in ("is_connected", "is_on"):
                    fmt_parts.append("%s")
                    args.append(f'({c_expr} ? "true" : "false")')
                elif isinstance(part, MethodCall) and part.method in ("free_heap", "read", "list_count", "uptime", "id"):
                    fmt_parts.append("%ld")
                    args.append(f"(long){c_expr}")
                elif isinstance(part, BinaryExpr):
                    # Nested expression — assume int
                    fmt_parts.append("%ld")
                    args.append(f"(long)({c_expr})")
                else:
                    # Default: assume int for VarRef
                    fmt_parts.append("%ld")
                    args.append(f"(long){c_expr}")

        # Use a static buffer (volt_sprintf_buf) — declared in volt.h or generated
        self._needs_sprintf_buf = True
        buf_idx = getattr(self, '_sprintf_buf_idx', 0)
        self._sprintf_buf_idx = (buf_idx + 1) % 4
        fmt = "".join(fmt_parts)
        args_str = ", ".join(args)
        return f'(snprintf(_volt_strbuf[{buf_idx}], sizeof(_volt_strbuf[{buf_idx}]), "{fmt}", {args_str}), _volt_strbuf[{buf_idx}])'


# ============================================================
# Utilities
# ============================================================

def _c_name(name: str) -> str:
    if name in C_KEYWORDS:
        return f"v_{name}"
    return name


def _find_var_decls_by_name(stmts: list, names: list):
    for stmt in stmts:
        if isinstance(stmt, VarDecl) and stmt.name in names:
            yield stmt
        if isinstance(stmt, EveryBlock):
            yield from _find_var_decls_by_name(stmt.body, names)
        if isinstance(stmt, OnBlock):
            yield from _find_var_decls_by_name(stmt.body, names)


def _find_calls(stmts: list, obj_name: str):
    for stmt in stmts:
        if isinstance(stmt, ExprStmt) and isinstance(stmt.expr, MethodCall):
            if isinstance(stmt.expr.obj, VarRef) and stmt.expr.obj.name == obj_name:
                yield stmt
        if isinstance(stmt, EveryBlock):
            yield from _find_calls(stmt.body, obj_name)
        if isinstance(stmt, OnBlock):
            yield from _find_calls(stmt.body, obj_name)


# ============================================================
# Public API
# ============================================================

def generate(program: Program, source_file: str = "main.volt") -> str:
    """Generate C source code from a transformed Volt AST."""
    gen = CCodeGen(source_file)
    return gen.generate(program)
