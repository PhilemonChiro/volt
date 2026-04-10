"""
Volt Compiler — Main Entry Point

Orchestrates the 7-pass compilation pipeline:
  .volt source → Parse → Resolve → Check → Validate → Analyze → Transform → Generate C

Usage: python voltc.py input.volt [-o output.c] [--show-tree] [--show-analysis]
"""

import sys
from pathlib import Path

# Add compiler dir to path
sys.path.insert(0, str(Path(__file__).parent))

from .parser import parse
from .resolver import resolve
from .checker import check_types
from .hardware import validate_hardware
from .analyzer import analyze
from .transformer import transform
from .codegen import generate
from .errors import CompilerErrors


def compile_volt(source: str, filename: str = "main.volt") -> tuple[str | None, CompilerErrors]:
    """
    Compile Volt source to C code.
    Returns (c_code, errors). c_code is None if there are errors.
    """
    errors = CompilerErrors()
    errors.set_source(source)

    # Pass 1: Parse
    try:
        program = parse(source)
    except Exception as e:
        errors.error(
            __import__('ast_nodes').Region(1, 1, 1, 1),
            "SYNTAX ERROR",
            str(e).split('\n')[0],
        )
        return None, errors

    # Pass 2: Resolve names
    scope = resolve(program, errors)
    if errors.has_errors:
        return None, errors

    # Pass 3: Type check
    check_types(program, scope, errors)
    if errors.has_errors:
        return None, errors

    # Load chip spec (if chip declaration exists)
    chip = None
    if program.chip:
        try:
            from volt.chips import get_chip
            chip = get_chip(program.chip.target)
        except (ValueError, ImportError):
            pass  # fall back to legacy ESP32 validation

    # Pass 4: Hardware validation
    validate_hardware(program, scope, errors, chip=chip)
    # Continue even with hardware warnings (only stop on errors)
    if errors.has_errors:
        return None, errors

    # Pass 5: Analyze (task classification, yield analysis, ISR safety)
    analyze(program, scope, errors)
    if errors.has_errors:
        return None, errors

    # Pass 6: Transform (lift vars, inline yields, desugar)
    program = transform(program)

    # Pass 7: Generate C
    c_code = generate(program, filename)

    return c_code, errors


def main():
    """CLI entry point."""
    if len(sys.argv) < 2:
        print("Usage: voltc <input.volt> [-o output.c]")
        sys.exit(1)

    input_file = Path(sys.argv[1])
    output_file = None

    if "-o" in sys.argv:
        idx = sys.argv.index("-o")
        if idx + 1 < len(sys.argv):
            output_file = Path(sys.argv[idx + 1])

    if not input_file.exists():
        print(f"Error: file not found: {input_file}")
        sys.exit(1)

    source = input_file.read_text()
    c_code, errors = compile_volt(source, str(input_file))

    # Print warnings even on success
    if errors.count > 0:
        print(errors.report(str(input_file)), file=sys.stderr)

    if errors.has_errors:
        print(f"\nCompilation failed with {sum(1 for e in errors.errors if e.severity == 'error')} error(s).",
              file=sys.stderr)
        sys.exit(1)

    if c_code:
        if output_file:
            output_file.write_text(c_code)
            print(f"Generated: {output_file}")
        else:
            print(c_code)


if __name__ == "__main__":
    main()
