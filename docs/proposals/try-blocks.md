# Proposal: `try { ... } or <policy>` block-form error handling

**Status:** Draft
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

One new statement form. Reuses the existing `or` keyword and the
three existing policies (`retry`, `skip`, `restart`).

```
try_block:   "try" "{" stmt+ "}" or_clause
or_clause:   "or" ("retry" retry_limit? | "skip" | "restart")
retry_limit: INT "times"
```

`try_block` is just another `stmt` — it can appear anywhere a normal
statement can (task bodies, `every` blocks, state machine `enter`
blocks, `setup`, functions).

## Examples

### 1. Boot sequence — retry the whole thing if anything fails

```volt
try {
    wifi.connect("home", "pw")
    mqtt.connect("broker.local")
    storage.load("config")
} or retry 5 times
```

### 2. Per-iteration pipeline — skip a bad cycle, keep the task running

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

### 3. Critical init — give up and reboot

```volt
setup {
    try {
        ota.verify_signature()
        storage.load("device_id")
    } or restart
}
```

## Composability rule

Inner `or` wins; outer `try` is the catch-all for anything not handled
inline. This lets users tune individual operations without losing the
block-level safety net:

```volt
try {
    wifi.connect("home", "pw") or retry 3 times   // local policy
    mqtt.connect("broker.local")                  // falls through to outer
    sensor.read()
} or skip                                         // catch-all
```

Nested `try` blocks follow the same rule: innermost applies first.

## What counts as a failure

The same trigger as the existing expression-level `or`: any builtin
that returns `error_t != VOLT_OK`. No new error model.

For user-defined functions: a function that returns `error_t` can be
the failure trigger for a `try` block, identical to today's behaviour
for the expression form.

## Codegen sketch

`try` blocks compile to labels + counters. No new runtime primitives.

**`try { ... } or retry N times`** — labeled loop with a bounded counter:

```c
int _try_attempts_N = 0;
_try_N_start:
err = stmt_A(); if (err && _try_attempts_N++ < N) goto _try_N_start;
err = stmt_B(); if (err && _try_attempts_N++ < N) goto _try_N_start;
err = stmt_C(); if (err && _try_attempts_N++ < N) goto _try_N_start;
// exhaustion: fall through (= `or skip` semantics)
```

**`try { ... } or retry`** (unbounded) — same shape without the counter.

**`try { ... } or skip`** — labeled `goto _try_N_end` on any non-OK error:

```c
err = stmt_A(); if (err) goto _try_N_end;
err = stmt_B(); if (err) goto _try_N_end;
err = stmt_C(); if (err) goto _try_N_end;
_try_N_end:
```

**`try { ... } or restart`** — branch to the existing task-restart label
that `or restart` already generates today.

## Open design questions

### 1. Retry exhaustion semantics

When `retry N times` runs out, what happens? Options:

- **A. Fall through (= `skip`).** Pragmatic; the program continues with
  partial state. Recommended.
- **B. Treat as fatal (= `restart`).** Strict; bad inputs reboot the
  device, which is fine for safety-critical setup but punishing for
  routine telemetry.
- **C. Require explicit fallthrough policy.** Force the user to write
  `or retry 5 times else skip` / `else restart`. Verbose but unambiguous.

The proposal as drafted picks (A) for simplicity; (C) is the safest
long-term answer if the meaning of (A) ever surprises someone.

### 2. `try` inside `every` — retry budget reset per tick?

When a `try { } or retry 3 times` lives inside `every 30s { }`, does
the 3-attempt budget reset every 30 s, or is it lifetime?

The proposal picks **reset per `every` iteration**. Each tick is its
own logical operation; carrying state across ticks would surprise
users. If lifetime-budgeted retry is needed, declare a counter
variable explicitly.

### 3. Should we add `or fail`?

A fourth policy that means *"log the error and stop this task, but
don't restart the device"* — useful when a background task can't
proceed but the rest of the program should keep running.

This is out of scope for this proposal; the current trio covers the
common cases. Worth tracking as a follow-up.

## Migration / compatibility

Pure addition. No existing syntax changes, no behavior changes for
existing programs. The `try` identifier is currently unreserved; it
becomes a reserved keyword with this proposal. A grep of `examples/`
and `tests/` should confirm zero collisions before merge.

## Test plan

Per the project's distillation protocol, the implementation must add
tests at every applicable level:

- **`test_parser.py`** — `try` block parses as a statement; nesting,
  inside-`every`, inside-state-enter all valid.
- **`test_resolver.py`** — variables declared inside `try` are scoped
  to the block.
- **`test_checker.py`** — non-`error_t`-returning expressions inside a
  `try` are still legal (they just never trigger the policy); the
  whole block's type is `void`.
- **`test_analyzer.py`** — retry blocks count as a yield point if
  the body contains yields; ISR-safety check forbids `try` in critical
  tasks (the policy mechanism allocates a counter, and unbounded
  retry inside an ISR could exceed WCET).
- **`test_codegen / test_coverage.py`** — generated C has the label
  layout above; `or restart` reuses the existing task-restart label.
- **`test_robustness_brutal.py`** — `try` with empty body, deeply
  nested, mixed inner/outer policies.
- **`test_endtoend.py`** — at least one example program that uses
  `try` survives parse → resolve → check → analyze → transform →
  codegen and the C output compiles against the framework headers.

## Implementation order

1. Add `try` to `grammar.lark` and a `TryBlock` AST node.
2. Resolver/checker treat the body as a normal block scope.
3. Codegen emits the label layout sketched above.
4. Update the formatter to handle the new node.
5. Add the test cases listed above.
6. Land one realistic example program under `examples/` that uses
   `try { } or restart` for boot init.
