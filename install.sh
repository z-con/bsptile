#!/usr/bin/env bash
# Setup script for bsptile.
#
# Clone this repo anywhere, run this script, done. It:
#   1. installs the (minimal) prerequisite packages,
#   2. symlinks this repo into GNOME's extensions directory and enables it,
#   3. applies the rest of the desktop setup that lives outside the
#      extension proper -- plain GNOME/dconf preferences that were tweaked
#      alongside it (terminal transparency, focus-follows-cursor, keybindings).
#
# Safe to re-run: every step sets a value or checks before acting, it
# doesn't append/toggle, so running this twice leaves you in the same state.
#
# Extension-internal defaults (inner-gaps, outer-gaps, tile-focused-window
# keybinding, panel transparency) are NOT set here -- they live in
# schemas/org.gnome.shell.extensions.bsptile.gschema.xml and extension.js,
# and take effect automatically once the extension is enabled.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="bsptile@zach.local"
EXT_LINK="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "==> Checking prerequisites"
if ! command -v gnome-shell >/dev/null; then
    echo "    gnome-shell is not installed -- this extension needs GNOME Shell. Aborting." >&2
    exit 1
fi

MISSING_PKGS=()
command -v glib-compile-schemas >/dev/null || MISSING_PKGS+=(libglib2.0-bin)
command -v gnome-extensions >/dev/null || MISSING_PKGS+=(gnome-shell)

NEED_BROWSER_CONNECTOR=0
dpkg -s gnome-browser-connector >/dev/null 2>&1 || NEED_BROWSER_CONNECTOR=1

if [ "${#MISSING_PKGS[@]}" -gt 0 ] || [ "$NEED_BROWSER_CONNECTOR" -eq 1 ]; then
    echo "    (needs sudo -- run this script from a real terminal, not a"
    echo "     non-interactive session, so the password/fingerprint prompt works)"
    echo "    Refreshing package lists (apt update) -- matters most on a freshly"
    echo "    installed machine, where they may be empty or stale"
    sudo apt update
fi

if [ "${#MISSING_PKGS[@]}" -gt 0 ]; then
    echo "    Installing missing packages: ${MISSING_PKGS[*]}"
    sudo apt install -y "${MISSING_PKGS[@]}"
else
    echo "    All present (libglib2.0-bin, gnome-shell)."
fi

if [ "$NEED_BROWSER_CONNECTOR" -eq 1 ]; then
    echo "    Installing gnome-browser-connector (native host for extensions.gnome.org)"
    sudo apt install -y gnome-browser-connector
fi

echo "    That covers everything installable from the command line. The last piece --"
echo "    the browser-side add-on that lets extensions.gnome.org install extensions --"
echo "    has to be added manually from your browser's own store. Open whichever applies:"
echo "      Chrome/Chromium: https://chromewebstore.google.com/detail/gphhapmejobijbbhgpjhcjognlahblep"
echo "      Firefox:         https://addons.mozilla.org/firefox/addon/gnome-shell-integration/"

echo "==> Installing bsptile into GNOME's extensions directory"
mkdir -p "$(dirname "$EXT_LINK")"
if [ -L "$EXT_LINK" ]; then
    if [ "$(readlink -f "$EXT_LINK")" != "$SCRIPT_DIR" ]; then
        echo "    Existing symlink points elsewhere -- repointing it to $SCRIPT_DIR"
        ln -sfn "$SCRIPT_DIR" "$EXT_LINK"
    fi
elif [ -e "$EXT_LINK" ]; then
    BACKUP="${EXT_LINK}.bak.$(date +%s 2>/dev/null || echo old)"
    echo "    $EXT_LINK already exists and isn't our symlink -- moving it to $BACKUP"
    mv "$EXT_LINK" "$BACKUP"
    ln -s "$SCRIPT_DIR" "$EXT_LINK"
else
    ln -s "$SCRIPT_DIR" "$EXT_LINK"
fi

echo "==> Compiling bsptile's gsettings schema"
glib-compile-schemas "$SCRIPT_DIR/schemas/"

SHELL_VERSION="$(gnome-shell --version | grep -oE '[0-9]+' | head -1)"
if ! grep -q "\"$SHELL_VERSION\"" "$SCRIPT_DIR/metadata.json"; then
    echo "    NOTE: this system is running GNOME Shell $SHELL_VERSION, which isn't in"
    echo "    metadata.json's shell-version list. GNOME will likely refuse to load"
    echo "    the extension. Either add \"$SHELL_VERSION\" to shell-version in"
    echo "    $SCRIPT_DIR/metadata.json, or run:"
    echo "      gsettings set org.gnome.shell disable-extension-version-validation true"
fi

echo "==> Enabling bsptile"
gnome-extensions enable "$UUID" || {
    echo "    Could not enable it yet -- if this is a fresh install GNOME Shell"
    echo "    may not have discovered the extension directory in this session."
    echo "    Log out and back in, then re-run this script."
}

if gsettings list-schemas | grep -q '^org.gnome.Ptyxis$'; then
    echo "==> Ptyxis: transparency + no restored maximized state on new windows"
    PTYXIS_PROFILE=$(gsettings get org.gnome.Ptyxis default-profile-uuid | tr -d "'")
    gsettings set "org.gnome.Ptyxis.Profile:/org/gnome/Ptyxis/Profiles/${PTYXIS_PROFILE}/" opacity 0.6
    gsettings set org.gnome.Ptyxis restore-window-size false
else
    echo "==> Skipping Ptyxis settings (not installed -- this Ubuntu version likely"
    echo "    ships a different default terminal)"
fi

echo "==> Focus follows cursor"
gsettings set org.gnome.desktop.wm.preferences focus-mode 'mouse'
gsettings set org.gnome.mutter focus-change-on-pointer-rest false

echo "==> Super+W closes the focused window (kept <Alt>F4 too)"
gsettings set org.gnome.desktop.wm.keybindings close "['<Alt>F4', '<Super>w']"

echo "==> Super+Space opens the Activities Overview (Spotlight equivalent)"
gsettings set org.gnome.desktop.wm.keybindings switch-input-source "[]"
gsettings set org.gnome.desktop.wm.keybindings switch-input-source-backward "[]"
gsettings set org.gnome.shell.keybindings toggle-overview "['<Super>space']"

echo "==> Disable GNOME's built-in Super+Left/Right half-screen tiling (fights with bsptile)"
gsettings set org.gnome.mutter.keybindings toggle-tiled-left "[]"
gsettings set org.gnome.mutter.keybindings toggle-tiled-right "[]"

echo "==> Super+Return / Shift+Super+Return / Ctrl+Super+Return: terminal, Firefox, Claude Code"
CKB_BASE=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/
CKB_SCHEMA=org.gnome.settings-daemon.plugins.media-keys.custom-keybinding
gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings \
    "['${CKB_BASE}custom0/', '${CKB_BASE}custom1/', '${CKB_BASE}custom2/']"

gsettings set $CKB_SCHEMA:${CKB_BASE}custom0/ name "Open Terminal"
gsettings set $CKB_SCHEMA:${CKB_BASE}custom0/ command "ptyxis --new-window"
gsettings set $CKB_SCHEMA:${CKB_BASE}custom0/ binding "<Super>Return"

gsettings set $CKB_SCHEMA:${CKB_BASE}custom1/ name "Open Firefox window"
gsettings set $CKB_SCHEMA:${CKB_BASE}custom1/ command "firefox --new-window"
gsettings set $CKB_SCHEMA:${CKB_BASE}custom1/ binding "<Shift><Super>Return"

gsettings set $CKB_SCHEMA:${CKB_BASE}custom2/ name "Open Terminal in Claude dir"
gsettings set $CKB_SCHEMA:${CKB_BASE}custom2/ command "ptyxis --new-window -d $HOME/Claude -- claude"
gsettings set $CKB_SCHEMA:${CKB_BASE}custom2/ binding "<Primary><Super>Return"

echo "==> Done."
