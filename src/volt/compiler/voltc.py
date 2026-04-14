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
from .ast_nodes import Region


import re as _re

def _resolve_includes(source: str, filename: str, errors) -> str:
    """Resolve include "file.volt" directives by inlining file contents."""
    base_dir = Path(filename).parent if filename != "main.volt" else Path(".")
    project_root = base_dir.resolve()
    seen = {str(Path(filename).resolve())}
    max_depth = 10

    def resolve(src: str, base: Path, depth: int) -> str:
        if depth > max_depth:
            return src
        lines = src.split('\n')
        result = []
        for line in lines:
            match = _re.match(r'^\s*include\s+"([^"]+)"\s*$', line)
            if match:
                inc_raw = match.group(1)
                inc_path = base / inc_raw
                resolved = str(inc_path.resolve())

                # Security: reject absolute paths and traversal outside project
                if inc_raw.startswith('/') or inc_raw.startswith('\\'):
                    from .ast_nodes import Region
                    errors.error(Region(1, 1, 1, 1), "INCLUDE ERROR",
                                 f"Absolute include paths are not allowed: {inc_raw}")
                    result.append(line)
                    continue
                if not resolved.startswith(str(project_root)):
                    from .ast_nodes import Region
                    errors.error(Region(1, 1, 1, 1), "INCLUDE ERROR",
                                 f"Include path escapes project directory: {inc_raw}",
                                 hint="Includes must resolve within the project folder.")
                    result.append(line)
                    continue

                if resolved in seen:
                    result.append(f"// include cycle skipped: {inc_raw}")
                    continue
                seen.add(resolved)
                try:
                    inc_source = inc_path.read_text()
                    inc_source = resolve(inc_source, inc_path.parent, depth + 1)
                    result.append(f"// --- included from {inc_raw} ---")
                    result.append(inc_source)
                    result.append(f"// --- end {inc_raw} ---")
                except FileNotFoundError:
                    from .ast_nodes import Region
                    errors.error(Region(1, 1, 1, 1), "INCLUDE ERROR",
                                 f"File not found: {inc_path}")
                    result.append(line)
            else:
                result.append(line)
        return '\n'.join(result)

    return resolve(source, base_dir, 0)


def compile_volt(source: str, filename: str = "main.volt") -> tuple[str | None, CompilerErrors]:
    """
    Compile Volt source to C code.
    Returns (c_code, errors). c_code is None if there are errors.
    """
    errors = CompilerErrors()

    # Preprocess: resolve include statements
    source = _resolve_includes(source, filename, errors)
    errors.set_source(source)

    # Pass 1: Parse
    try:
        program = parse(source)
    except Exception as e:
        errors.error(
            Region(1, 1, 1, 1),
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


def sync_project_toml(volt_file: Path, source: str):
    """Sync chip from .volt source into volt.toml in the same directory."""
    chip = None
    for line in source.splitlines():
        stripped = line.strip()
        if stripped.startswith("chip "):
            chip = stripped[5:].strip()
            break
    if not chip:
        return

    toml_path = volt_file.parent / "volt.toml"
    if not toml_path.exists():
        return

    try:
        content = toml_path.read_text()
        lines = content.splitlines()
        found = False
        for i, line in enumerate(lines):
            if line.strip().startswith("chip") and "=" in line:
                lines[i] = f'chip = "{chip}"'
                found = True
                break
        if not found:
            # Add after [project] line
            for i, line in enumerate(lines):
                if line.strip() == "[project]":
                    lines.insert(i + 1, f'chip = "{chip}"')
                    found = True
                    break
        if found:
            toml_path.write_text("\n".join(lines) + "\n")
    except Exception:
        pass


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

    # Sync volt.toml chip field from source
    sync_project_toml(input_file, source)

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
