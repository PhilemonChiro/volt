# Volt Distillation Log

Per CLAUDE.md "Distillation Protocol" — Identify → Fix → Test → Audit →
Optimize → Maintain, repeat until 3+ consecutive clean rounds.

| Round | Date       | Focus                                       | Tests added | Issues found | Result |
|-------|------------|---------------------------------------------|-------------|--------------|--------|
| 1–30  | Apr–May 2026 | See git log (`git log --grep="^Round "`) — earlier rounds aren't logged here, only summarised by commit subject. |
| 31    | 2026-05-21 | Brutal driver tests: c_prefix correctness, methods, edge cases, multi-device buses | tests/test_drivers_brutal.py (13 cases) | None — c_prefix fix from v2.0.52 held under brutal test. Note: original "33/36 missing driver.c" finding was inverted; only 3 aliases (dht22, lcd16x2, lcd20x4) lack their own driver.c and that's by design. | CLEAN |
| 32    | 2026-05-21 | GPIO device codegen shape; dht22 metadata; alias→driver mapping check | 4 new init-shape tests + 1 stricter inventory test (17 cases total) | (1) GPIO devices emitted I²C-shaped `init(&_dev, 0, addr)` instead of `init(&_dev, pin, …)`. (2) DHT22 metadata had `interface=i2c`, `c_prefix=dht22` — neither real. DHT11 had no way to pass the type discriminator. Both now share `dht` driver via new `init_args` template (`{pin}, 11` / `{pin}, 22`). (3) Old driver-c inventory test reported aliases as gaps; replaced with c_prefix→driver.c mapping check. | CLEAN — fixed |
