# Proposal: `try { ... } or <policy>` block-form error handling

**Status:** Draft (revision 2 — post-review)
**Author:** Philemon Chiro
**Date:** 2026-05-21

## Motivation

The existing `or retry/skip/restart` clauses work well at the call site:

```volt
wifi.connect("home", "pw") or retry
```

But they don't compose as programs grow. A boot sequence with five
operations becomes five repeated `or` clauses — each one a separate
policy decision instead of a single boundary-level intent:

```volt
wifi.connect("home", "pw") or retry
mqtt.connect("broker.local") or retry
storage.load("config") or retry
ota.verify_signature() or retry
display.init() or retry
```

What the author actually means is: *"this whole block is one logical
operation; if any step fails, retry the lot."* That sentence has no
direct expression in Volt today.

## Non-goals

This proposal is **not** introducing exceptions. There is no unwind,
no `catch` binding, no propagation across function boundaries, no
`finally`, no transactional rollback. We are lifting the existing
expression-level `or` policy to statement-block scope — nothing more.

## Grammar

One new statement form. Reuses the existing `or` and `else` keywords
and the three existing policies (`retry`, `skip`, `restart`).

```
try_block:   "try" "{" stmt+ "}" or_clause
or_clause:   "or" (bounded_retry | "retry" | "skip" | "restart")
bounded_retry: "retry" INT "times" "else" terminal_policy
terminal_policy: "skip" | "restart" | "fail"
```

`try_block` is a `stmt` — it can appear anywhere a normal statement
can (task bodies, `every` blocks, state-machine `enter` blocks,
`setup`, functions), subject to the [Restrictions](#restrictions) below.

**Bounded retry requires an explicit exhaustion policy.** This is the
single biggest revision from r1 of this proposal. Silent fall-through
on exhaustion is exactly the pattern the distillation log has caught
elsewhere (R32 GPIO codegen, R34 global type mismatch, R38 zero-duration
`every`) — silent fallbacks look fine in the spec and burn users in
the field six months later. The verbosity of `else <policy>` is the
feature: it forces the author to answer *"what happens when this gives
up?"* once, at the call site, where they have context.

`or retry` (unbounded) is valid alone — there is no exhaustion to
specify. The runtime cost is the same: a label and a counter that
never trips.

### `fail` policy

This proposal introduces a fourth policy, available **only as a
terminal in `else <terminal_policy>`**, not as a top-level `or`
clause:

> `fail` — log the error and halt this task (do not restart the device).

Rationale: a bounded boot sequence that exhausts retries on a
non-critical subsystem (e.g., a missing optional sensor) shouldn't
reboot, but also shouldn't silently continue with broken state.
`else fail` ends the task cleanly. Other tasks keep running.

`fail` is deliberately not a top-level `or` clause — it can only
appear as an exhaustion handler, where the meaning is unambiguous.

## Examples

### 1. Boot sequence — boot-critical, reboot on exhaustion

```volt
setup {
    try {
        ota.verify_signature()
        storage.load("device_id")
        wifi.connect("home", "pw")
    } or retry 5 times else restart
}
```

### 2. Per-iteration pipeline — drop a bad cycle, keep the task running

```volt
every 30s {
    try {
        let t = bme.temperature()
        let h = bme.humidity()
        mqtt.publish("env/temp", t)
        mqtt.publish("env/hum", h)
    } or skip
}
```

`or skip` alone (no retry) is the "give up immediately, fall through
past the block, continue the task" form. The whole block is bypassed
on the first failure.

### 3. Optional subsystem — stop the task without rebooting

```volt
task camera {
    try {
        camera.init()
        camera.set_resolution(1080)
        camera.start_stream()
    } or retry 3 times else fail
    // Task ends here on exhaustion. Other tasks keep running.
}
```

### 4. Unbounded retry — no exhaustion to handle

```volt
setup {
    try {
        wifi.connect("home", "pw")
        mqtt.connect("broker.local")
    } or retry
}
```

Use unbounded retry only when "this absolutely must succeed before
proceeding" — typically network bring-up in `setup`. Avoid in
`every` bodies because a stuck retry monopolises the task.

## Idempotency: the body re-runs verbatim on retry

**`or retry` re-executes every statement in the body. Side effects
repeat.** Read the body as describing one *attempt* at the operation,
not one logical commit. The author is responsible for ensuring each
statement is safe to re-run.

The dangerous shape:

```volt
try {
    storage.save("boot_count", boot_count + 1)   // ⚠ runs each attempt
    wifi.connect("home", "pw")
    mqtt.connect("broker.local")
} or retry 3 times else restart
```

If `mqtt.connect()` fails, the block restarts. `storage.save()` runs
again. `boot_count` increments twice. Three retries → potentially four
increments. The author wrote *"retry boot"* and got *"corrupt the boot
counter."*

### Safe patterns inside `try`

- **Hardware init** — `wifi.connect`, `mqtt.connect`, `display.init`,
  most device `init()` calls — these check current state and no-op if
  already connected/initialised. Idempotent.
- **Reads** — `bme.temperature()`, `storage.load(...)` — idempotent
  by construction.
- **`storage.save` of a constant or pre-computed value** — idempotent.

### Unsafe patterns inside `try`

- **Assignments to mutable global state** — `boot_count += 1`,
  `counter = counter + 1`.
- **Channel sends** — `q.send(x)` enqueues each time; retry triples the
  enqueue.
- **`storage.save` of a computed value** — same data written, but
  flash wear scales with retries.
- **Anything with cumulative external side effects** — sending an MQTT
  message, posting an HTTP request, advancing a sequence number.

### Compiler enforcement

The checker SHOULD emit a warning when it detects an assignment to
mutable state (non-channel, non-storage-of-constant) inside a `try`
body with a `retry` policy. False positives are acceptable here —
better a noisy warning than a silent corruption. The exact heuristic
is left to the implementation, but it must at minimum cover:

- Assignments to `var` declarations in an outer scope.
- Compound-assignment operators (`+=`, `-=`, etc.) on any non-local.
- Channel `.send()` calls.

Hardware writes (`pin.write`, `led.toggle`) are intentionally not
warned — the user typically *wants* the retry to re-apply the
hardware state.

## Restrictions

`try` blocks are **forbidden** in the following contexts:

1. **Critical tasks (`every <d> strict { }`)** — runs from a hardware
   timer ISR. Retry loops with unbounded iteration count can blow the
   WCET budget; even bounded retries add label/counter overhead the
   ISR can't afford. Detected by the analyzer (Round 41 already
   forbids `sleep`/`wifi` in critical tasks; this extends that pass).

2. **`enter` / `exit` blocks of state machines, when the policy is
   unbounded `or retry`** — would hang the state machine in the
   middle of a transition. Bounded retry is fine because exhaustion
   is guaranteed.

3. **Anywhere a parent `try` already wraps the same operation** —
   nested `try` with overlapping bodies is legal (see [Composability](
   #composability-rule) below); restriction is on *redundant* nesting
   where the inner is the entire body of the outer with no other
   statements. Emit a warning, not an error.

## Composability rule

Inner `or` wins; outer `try` is the catch-all for anything not handled
inline. This lets users tune individual operations without losing the
block-level safety net:

```volt
try {
    wifi.connect("home", "pw") or retry 3 times else skip
    mqtt.connect("broker.local")                            // outer policy
    sensor.read()
} or retry 5 times else restart
```

**Inner exhaustion propagates to the outer.** If the inner
`wifi.connect() or retry 3 times else skip` exhausts, the `else skip`
fires — the call's error is consumed, the outer `try` sees success at
that line, and execution proceeds. If the inner had been
`else fail`, the inner exhaustion is fatal to the task and the outer
`try` never gets a chance to retry — `fail` halts before the outer
sees anything.

Nested `try` blocks (different bodies) follow the same rule:
innermost applies first, exhaustion propagates outward through the
inner's terminal policy.

## Yield × retry × counter lifetime

This is the interaction the proposal's first revision missed.

```volt
every 30s {
    try {
        wifi.connect()        // may yield internally
        sleep(2s)             // definitely yields
        mqtt.connect()
    } or retry 3 times else restart
}
```

The transformer (`transformer.py:39-80`) lifts any variable whose
liveness crosses a yield point into the task's context struct. The
retry counter `_try_attempts_N` lives across `sleep(2s)` and across
`wifi.connect()`'s internal yields — therefore it **must lift to the
context struct**.

A context-struct counter persists across `every` iterations by
default. The author's intent on "retry budget resets each 30 s tick"
must be encoded explicitly: the counter is **reset on entry to the
try block from outside**, not on entry via the retry path.

This requires **two labels** in the codegen, not one:

```c
// try { A; B; C } or retry N times else <terminal>
_try_N_enter:                                  // entry from outside
    ctx->_try_attempts_N = 0;
_try_N_start:                                  // entry from a retry
    err = stmt_A(); if (err) goto _try_N_check;
    err = stmt_B(); if (err) goto _try_N_check;
    err = stmt_C(); if (err) goto _try_N_check;
    goto _try_N_end;                           // success path
_try_N_check:
    if (++ctx->_try_attempts_N < N) goto _try_N_start;
    // exhaustion: dispatch to the terminal policy
    <emit code for `skip` | `restart` | `fail`>
_try_N_end:
```

Where `<emit code for ...>` is:

- **`skip`** — `goto _try_N_end` (fall through past the block).
- **`restart`** — `goto _task_restart_label` (reuses the existing
  task-restart primitive).
- **`fail`** — log + `return` from the protothread. Other tasks
  unaffected.

For unbounded `or retry`, the counter and `_try_N_check` collapse to
an unconditional `goto _try_N_start`. The `_try_N_enter` label is
unnecessary in that case.

## What counts as a failure

The same trigger as the existing expression-level `or`: any builtin
that returns `error_t != VOLT_OK`. No new error model.

For user-defined functions: a function that returns `error_t` can be
the failure trigger for a `try` block, identical to today's behaviour
for the expression form.

A statement that does not return `error_t` (e.g., a pure assignment,
a hardware write returning `void`) is **never** a trigger. This
means:

```volt
try { x = x + 1 } or retry   // ⚠ warning: try body has no error-returning
                              // statements; `or retry` is dead code
```

Empty body is a **syntax error**:

```volt
try { } or retry              // ✗ error: try body must contain at least one statement
```

## Block `try` has no value

The expression-level `or <default>` form (`let n = parse(s) or 0`)
returns the default value when the expression errors. Block `try`
has no value — it cannot be used as an expression, only as a
statement. There is no `let result = try { ... } or skip` form.

If a block-level "compute or default" is ever needed, that's a
separate proposal for an `or default` expression form on `do`/`begin`
blocks — out of scope here.

## `try` becomes a reserved keyword

A grep of `examples/`, `tests/`, and `src/` confirms `try` is not
currently used as a Volt identifier (Python `try:` in test files
doesn't count — those are not Volt source). The single occurrence in
`grammar.lark` is in a comment explaining `timeout` block semantics
in English, not a token reference.

Implementation must:

1. Add `try` to the lexer's reserved-word list.
2. Emit a clear migration error if a user variable named `try` is
   declared: `error: 'try' is reserved for try/or blocks; rename
   the variable (e.g., 'attempt', 'try_n')`.

## Migration / compatibility

Pure addition. No existing syntax changes, no behavior changes for
existing programs. The grep above confirms zero collisions in the
current repo and examples.

## Test plan

Per the project's distillation protocol, the implementation must add
tests at every applicable level:

- **`test_parser.py`** — `try` block parses as a statement; nested
  inside `every`, `setup`, state-machine `enter`, functions, and other
  `try` blocks. Bounded retry without `else <terminal>` is a parse
  error. Empty body is a parse error. `else fail` parses only as a
  terminal of bounded retry, not as a top-level policy.
- **`test_resolver.py`** — variables declared inside `try` are scoped
  to the block.
- **`test_checker.py`** — non-`error_t`-returning expressions inside
  a `try` produce a "dead policy" warning; the whole block's type is
  `void`; using `try` as an expression is an error.
- **`test_analyzer.py`** — retry blocks count as a yield point if
  the body contains yields; ISR-safety check forbids `try` in critical
  tasks; unbounded retry forbidden in state-machine `enter`/`exit`
  blocks; mutable-state-inside-try-with-retry warning fires.
- **`test_transformer.py`** — counter lifts to context struct when
  body contains yields; entry-from-outside vs entry-from-retry label
  pair emitted correctly.
- **`test_codegen / test_coverage.py`** — generated C has the two-label
  layout from the [Yield × retry](#yield--retry--counter-lifetime)
  section; `else restart` reuses the existing task-restart label;
  `else fail` emits log + return.
- **`test_robustness_brutal.py`** — `try` with deeply nested blocks,
  mixed inner/outer policies, inner exhaustion triggering outer,
  100 statements in one body, retry counter overflow guard.
- **`test_endtoend.py`** — at least one example program that uses
  `try` survives parse → resolve → check → analyze → transform →
  codegen and the C output compiles against the framework headers.

## Implementation order

1. Add `try` to `grammar.lark` as a reserved keyword + the `try_block`
   production. Migration error in the lexer/parser for existing
   identifiers named `try`.
2. AST: `TryBlock` node with `body: list[Stmt]`, `policy: str`,
   `retry_limit: int | None`, `terminal: str | None`.
3. Resolver: treat body as a normal block scope.
4. Checker: dead-policy warning, expression-context error.
5. Analyzer: critical-task restriction, state-machine `enter`
   restriction, mutable-state-inside-try warning.
6. Transformer: lift retry counter to context struct when body
   yields. Emit the two-label entry pattern.
7. Codegen: emit the C layout per the [Yield × retry](
   #yield--retry--counter-lifetime) section.
8. Update the formatter to handle the new node.
9. Add the test cases listed above.
10. Land one realistic example under `examples/` using
    `try { } or retry N times else restart` for boot init.
