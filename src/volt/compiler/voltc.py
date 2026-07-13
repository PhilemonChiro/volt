"""
Volt Compiler — Main Entry Point

Orchestrates the 7-pass compilation pipeline:
  .volt source → Parse → Resolve → Check → Validate → Analyze → Transform → Generate C

Usage: python voltc.py input.volt [-o output.c] [--show-tree] [--show-analysis]
"""

import sys
import re as _re
from pathlib import Path

# Add compiler dir to path
sys.path.insert(0, str(Path(__file__).parent))


def _read_chip_from_toml(filename: str) -> str | None:
    """Read chip target from volt.toml in the same directory as the source file."""
    try:
        base = Path(filename).parent if filename != "main.volt" else Path(".")
        toml_path = base / "volt.toml"
        if not toml_path.exists():
            return None
        text = toml_path.read_text()
        # Simple TOML parsing — just look for chip = "esp32"
        match = _re.search(r'^\s*chip\s*=\s*"([^"]+)"', text, _re.MULTILINE)
        return match.group(1) if match else None
    except Exception:
        return None

from .parser import parse
from .resolver import resolve
from .checker import check_types
from .analyzer import analyze
from .transformer import transform
from .codegen import generate
from .errors import CompilerErrors
from .ast_nodes import Region


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


def compile_volt(
    source: str,
    filename: str = "main.volt",
    progress=None,
) -> tuple[str | None, CompilerErrors]:
    """
    Compile Volt source to C code.

    Returns (c_code, errors). c_code is None if there are errors.

    Args:
        source: Volt source text.
        filename: source filename (used for #line directives + volt.toml lookup).
        progress: optional callback(phase: str, pct: int) called after each pass.
                  Phases: include, parse, resolve, check, hardware, analyze,
                  transform, codegen. pct climbs 5 → 100.
    """
    def _emit(phase, pct):
        if progress is not None:
            try:
                progress(phase, pct)
            except Exception:
                pass  # progress is advisory; never break compilation on it

    errors = CompilerErrors()

    # Preprocess: resolve include statements
    source = _resolve_includes(source, filename, errors)
    errors.set_source(source)
    _emit("include", 5)

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
    _emit("parse", 30)

    # Chip resolution: volt.toml is the source of truth.
    # chip in .volt file is accepted for backward compat but deprecated.
    toml_chip = _read_chip_from_toml(filename)
    if toml_chip:
        if program.chip and program.chip.target != toml_chip:
            errors.warning(
                program.chip.region, "DEPRECATION",
                f"`chip {program.chip.target}` in source conflicts with "
                f"`chip = \"{toml_chip}\"` in volt.toml. Using volt.toml.",
            )
        from .ast_nodes import ChipDecl
        from .ast_nodes import Region as _Region
        program.chip = ChipDecl(target=toml_chip, region=_Region(0, 0, 0, 0))
    elif program.chip:
        # chip in source only — warn about deprecation
        errors.warning(
            program.chip.region, "DEPRECATION",
            f"Move `chip {program.chip.target}` to volt.toml: chip = \"{program.chip.target}\"",
            hint="The chip declaration will move to volt.toml in a future version.",
        )

    # Pass 2: Resolve names
    scope = resolve(program, errors)
    if errors.has_errors:
        return None, errors
    _emit("resolve", 45)

    # Pass 3: Type check
    check_types(program, scope, errors)
    if errors.has_errors:
        return None, errors
    _emit("check", 60)

    _emit("hardware", 70)

    # Pass 4 + 5: Analyze — hardware validation (pin ranges, strapping pins,
    # bus conflicts) now runs as analyze()'s first step, so every entry point
    # (including programmatic ones) gets it. Calling validate_hardware here too
    # would duplicate every hardware warning, so it lives only in analyze().
    analyze(program, scope, errors)
    if errors.has_errors:
        return None, errors
    _emit("analyze", 80)

    # Pass 6: Transform (lift vars, inline yields, desugar)
    program = transform(program)
    _emit("transform", 88)

    # Pass 7: Generate C
    c_code = generate(program, filename)
    _emit("codegen", 100)

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
