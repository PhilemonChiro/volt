"""
Compiles every example program in examples/ — ensures they never rot.
"""

import sys
import os
import glob

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from volt.compiler.voltc import compile_volt

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

print("\n=== Example Programs ===\n")

examples_dir = os.path.join(os.path.dirname(__file__), '..', 'examples')
volt_files = sorted(glob.glob(os.path.join(examples_dir, '*/main.volt')))

for path in volt_files:
    name = os.path.basename(os.path.dirname(path))
    with open(path) as f:
        source = f.read()
    c_code, errors = compile_volt(source, 'main.volt')
    errs = [e for e in errors.errors if e.severity == 'error']
    if errs:
        check(f"example/{name}", False, errs[0].message)
    else:
        check(f"example/{name}", c_code is not None and len(c_code) > 100,
              f"generated C too short ({len(c_code) if c_code else 0} chars)")

# Verify non-trivial output sizes
for path in volt_files:
    name = os.path.basename(os.path.dirname(path))
    with open(path) as f:
        source = f.read()
    c_code, errors = compile_volt(source, 'main.volt')
    if c_code:
        check(f"example/{name} has app_main or main",
              "app_main" in c_code or "int main" in c_code)

print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
