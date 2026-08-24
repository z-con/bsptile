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

if [ "${#MISSING_PKGS[@]}" -gt 0 ]; then
    echo "    Installing missing packages: ${MISSING_PKGS[*]}"
    echo "    (needs sudo -- run this script from a real terminal, not a"
    echo "     non-interactive session, so the password/fingerprint prompt works)"
    sudo apt install -y "${MISSING_PKGS[@]}"
else
    echo "    All present (libglib2.0-bin, gnome-shell)."
fi

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

echo "==> Enabling bsptile"
gnome-extensions enable "$UUID" || {
    echo "    Could not enable it yet -- if this is a fresh install GNOME Shell"
    echo "    may not have discovered the extension directory in this session."
    echo "    Log out and back in, then re-run this script."
}

echo "==> Ptyxis: transparency + no restored maximized state on new windows"
PTYXIS_PROFILE=$(gsettings get org.gnome.Ptyxis default-profile-uuid | tr -d "'")
gsettings set "org.gnome.Ptyxis.Profile:/org/gnome/Ptyxis/Profiles/${PTYXIS_PROFILE}/" opacity 0.6
gsettings set org.gnome.Ptyxis restore-window-size false

echo "==> Focus follows cursor"
gsettings set org.gnome.desktop.wm.preferences focus-mode 'mouse'

echo "==> Super+W closes the focused window (kept <Alt>F4 too)"
gsettings set org.gnome.desktop.wm.keybindings close "['<Alt>F4', '<Super>w']"

echo "==> Super+Space opens the Activities Overview (Spotlight equivalent)"
gsettings set org.gnome.desktop.wm.keybindings switch-input-source "[]"
gsettings set org.gnome.desktop.wm.keybindings switch-input-source-backward "[]"
gsettings set org.gnome.shell.keybindings toggle-overview "['<Super>space']"

echo "==> Done."
