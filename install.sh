#!/usr/bin/env bash
# Companion setup script for bsptile.
#
# Applies the parts of this desktop setup that live OUTSIDE the extension
# itself -- plain GNOME/dconf preferences that were tweaked alongside it
# (terminal transparency, focus-follows-cursor, keybindings) -- and enables
# the extension. Safe to re-run; every step just sets a value, it doesn't
# append/toggle, so running this twice leaves you in the same state.
#
# Extension-internal defaults (inner-gaps, outer-gaps, tile-focused-window
# keybinding, panel transparency) are NOT set here -- they live in
# schemas/org.gnome.shell.extensions.bsptile.gschema.xml and extension.js,
# and take effect automatically once the extension is enabled.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="bsptile@zach.local"

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
