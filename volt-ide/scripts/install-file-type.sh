#!/bin/bash
# Register .volt file type with the Volt logo on Linux
# Run once after install: ./scripts/install-file-type.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ASSETS_DIR="$SCRIPT_DIR/../assets"
ICON_SRC="$ASSETS_DIR/volt-logo.svg"
MIME_SRC="$ASSETS_DIR/volt-file.xml"

echo "Installing Volt file type association..."

# 1. Install MIME type (registers .volt extension)
xdg-mime install --novendor "$MIME_SRC" 2>/dev/null
echo "  MIME type: text/x-volt"

# 2. Install icon for the MIME type (SVG works on modern Linux)
for size in 16 24 32 48 64 128 256; do
    dir="$HOME/.local/share/icons/hicolor/${size}x${size}/mimetypes"
    mkdir -p "$dir"
    cp "$ICON_SRC" "$dir/application-x-volt.svg"
done

# Also install scalable
mkdir -p "$HOME/.local/share/icons/hicolor/scalable/mimetypes"
cp "$ICON_SRC" "$HOME/.local/share/icons/hicolor/scalable/mimetypes/application-x-volt.svg"

echo "  Icon: installed to hicolor theme"

# 3. Install app icon
mkdir -p "$HOME/.local/share/icons/hicolor/scalable/apps"
cp "$ICON_SRC" "$HOME/.local/share/icons/hicolor/scalable/apps/volt-ide.svg"
echo "  App icon: volt-ide.svg"

# 4. Update icon cache
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null
echo "  Icon cache: updated"

# 5. Update MIME database
update-mime-database "$HOME/.local/share/mime" 2>/dev/null
echo "  MIME database: updated"

# 6. Set default app for .volt files (optional)
# xdg-mime default volt-ide.desktop text/x-volt

echo ""
echo "Done! .volt files should now show the Volt logo."
echo "You may need to log out and back in, or restart your file manager."
