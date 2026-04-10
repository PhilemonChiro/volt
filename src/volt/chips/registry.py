"""
Volt Chip Registry — Auto-discovers and registers chip specifications.

Usage:
    from volt.chips import get_chip, all_chips

    chip = get_chip("esp32")    # returns ESP32 ChipSpec instance
    chip = get_chip("esp8266")  # returns ESP8266 ChipSpec instance
    names = all_chips()         # ["esp32", "esp8266", ...]
"""

_chips: dict[str, type] = {}


def register(cls):
    """Decorator. Each chip module uses @register on its ChipSpec subclass."""
    instance = cls()
    _chips[instance.name] = cls
    for alias in getattr(instance, 'aliases', []):
        _chips[alias.lower()] = cls
    return cls


def get_chip(name: str):
    """Look up a chip by name. Returns a new ChipSpec instance.
    Raises ValueError if chip is not found."""
    key = name.lower().replace("-", "").replace("_", "")
    if key not in _chips:
        available = ", ".join(sorted(all_chips()))
        raise ValueError(
            f"Unknown chip '{name}'. Available chips: {available}"
        )
    return _chips[key]()


def all_chips() -> list[str]:
    """All registered chip names (deduplicated, sorted)."""
    seen = set()
    names = []
    for cls in _chips.values():
        n = cls().name
        if n not in seen:
            seen.add(n)
            names.append(n)
    return sorted(names)


# Auto-import all chip modules so @register runs
def _discover():
    import importlib
    import pkgutil
    import volt.chips as pkg
    for _, modname, _ in pkgutil.iter_modules(pkg.__path__):
        if modname not in ("base", "registry", "__init__"):
            importlib.import_module(f"volt.chips.{modname}")

_discover()
