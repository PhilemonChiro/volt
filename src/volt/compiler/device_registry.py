"""
Volt Device Registry — loads device descriptors from JSON files.

Single source of truth for all device types, methods, and signatures.
Used by the checker (type validation) and codegen (C code generation).

Adding a new device = add one JSON file in devices/ + one .c driver file.
No compiler changes needed.
"""

import json
import os
from pathlib import Path


# Type name mapping (JSON → checker type constants)
_TYPE_MAP = {
    "int": "int",
    "float": "float",
    "bool": "bool",
    "string": "string",
    "void": "void",
}


class DeviceInfo:
    """Represents a single device type loaded from JSON."""

    def __init__(self, data: dict):
        self.name = data["name"]
        self.category = data.get("category", "sensor")
        self.interface = data.get("interface", "i2c")
        self.default_address = data.get("default_address", "")
        self.description = data.get("description", "")
        self.c_prefix = data.get("c_prefix", self.name.lower())
        self.c_source = data.get("c_source", "")
        self.methods = {}

        for method_name, method_data in data.get("methods", {}).items():
            params = []
            for p in method_data.get("params", []):
                params.append((p["name"], _TYPE_MAP.get(p["type"], p["type"])))

            self.methods[method_name] = {
                "returns": _TYPE_MAP.get(method_data["returns"], method_data["returns"]),
                "params": params,
                "description": method_data.get("description", ""),
            }


class DeviceRegistry:
    """Loads and provides access to all registered device types."""

    def __init__(self):
        self.devices: dict[str, DeviceInfo] = {}
        self._loaded = False

    def load(self, devices_dir: str = None):
        """Load all device descriptors from the devices/ directory."""
        if self._loaded:
            return

        if devices_dir is None:
            # Search for devices/ directory relative to project root
            candidates = [
                Path(__file__).parent.parent.parent.parent / "devices",
                Path.home() / "dev/volt/devices",
                Path.home() / ".volt/devices",
            ]
            for c in candidates:
                if c.exists():
                    devices_dir = str(c)
                    break

        if devices_dir is None or not os.path.exists(devices_dir):
            self._loaded = True
            return

        # Load all JSON files recursively
        for root, dirs, files in os.walk(devices_dir):
            for fname in files:
                if fname.endswith(".json"):
                    path = os.path.join(root, fname)
                    try:
                        with open(path) as f:
                            data = json.load(f)
                        dev = DeviceInfo(data)
                        self.devices[dev.name] = dev
                    except (json.JSONDecodeError, KeyError) as e:
                        pass  # skip malformed files silently

        self._loaded = True

    def get(self, name: str) -> DeviceInfo | None:
        """Get device info by type name (e.g., 'BME280')."""
        if not self._loaded:
            self.load()
        return self.devices.get(name)

    def get_method_types(self) -> dict:
        """Build METHOD_TYPES dict for the type checker.
        Returns: { "BME280": { "temperature": ("float", []), ... }, ... }
        """
        if not self._loaded:
            self.load()

        result = {}
        for name, dev in self.devices.items():
            methods = {}
            for method_name, method_info in dev.methods.items():
                ret_type = method_info["returns"]
                params = method_info["params"]
                # Convert to checker format: (return_type, [(param_name, param_type)])
                methods[method_name] = (ret_type, params)
            result[name] = methods
        return result

    def get_method_map(self) -> dict:
        """Build METHOD_MAP dict for the code generator.
        Returns: { ("BME280", "temperature"): "bme280_temperature({sensor})", ... }
        """
        if not self._loaded:
            self.load()

        result = {}
        for name, dev in self.devices.items():
            for method_name, method_info in dev.methods.items():
                params = method_info["params"]
                if params:
                    result[(name, method_name)] = f"{dev.c_prefix}_{method_name}({{sensor}}, {{args}})"
                else:
                    result[(name, method_name)] = f"{dev.c_prefix}_{method_name}({{sensor}})"
        return result

    def all_device_names(self) -> list[str]:
        """Return all registered device type names."""
        if not self._loaded:
            self.load()
        return list(self.devices.keys())


# Global singleton — loaded once, shared across compiler passes
_registry = DeviceRegistry()


def get_registry() -> DeviceRegistry:
    """Get the global device registry instance."""
    _registry.load()
    return _registry
