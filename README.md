# bsptile

A GNOME Shell extension that adds dynamic, i3/Hyprland-style binary space
partition (BSP/dwindle) auto-tiling to a stock GNOME desktop. Every new
window splits whichever tile it lands next to, which is what produces the
spiral layout. No manual layout picking, no separate tiling compositor --
just GNOME Shell with real auto-tiling bolted on.

Built as a fresh, minimal implementation targeting the current (GNOME 45+,
ES module) extension API, rather than a port of an older tiling extension.

## Features

- **Dynamic auto-tiling** -- new windows automatically split into the
  layout; closing a window returns its space to its sibling.
- **Border-drag resizing** -- drag the shared edge between two tiled
  windows with the mouse and the split ratio updates live.
- **Configurable gaps** -- inner (between tiles) and outer (tiles to
  monitor edge), independently.
- **Focus border** -- a thin outline around whichever window is focused,
  using your GNOME accent color.
- **Slightly transparent top panel.**
- **`Super+T`** -- pull the focused window into the tiled layout, even if
  it's currently maximized (unmaximizes it first).

None of this touches floating windows you don't tile -- a window only
enters the tree via `window-created` or `Super+T`.

## Requirements

- Ubuntu (or any GNOME distro) with **GNOME Shell 45 or newer** (uses the
  ES-module extension API introduced in 45; developed against 50).
- A monitor. Multi-monitor is wired up (trees are keyed per-monitor) but
  only tested on a single-monitor setup.

## Install

```sh
git clone https://github.com/z-con/bsptile.git
cd bsptile
./install.sh
```

`install.sh` is safe to re-run -- it sets values rather than toggling them,
so running it twice leaves you in the same state. It will:

1. Install prerequisite packages via apt if missing (`libglib2.0-bin`,
   `gnome-shell`, `gnome-browser-connector`) -- needs sudo, so run it from
   a real terminal, not piped through something non-interactive.
2. Print links to the Chrome/Firefox "GNOME Shell integration" browser
   add-on -- that piece has to be installed manually from your browser's
   own store, no way around that.
3. Symlink this repo into `~/.local/share/gnome-shell/extensions/` and
   enable it.
4. Apply the rest of the desktop tweaks that go with it but live outside
   the extension itself: Ptyxis terminal transparency (skipped if you're
   not on Ptyxis), focus-follows-cursor, `Super+W` to close the focused
   window, and `Super+Space` for the Activities Overview (GNOME's
   Spotlight-equivalent search).

**If the extension doesn't show as enabled after running the script**, it's
almost always because GNOME Shell hadn't discovered the extensions
directory yet in your current session -- log out and back in, then
re-run `./install.sh`.

## Configuration

Everything extension-specific lives under `org.gnome.shell.extensions.bsptile`:

```sh
gsettings set org.gnome.shell.extensions.bsptile inner-gaps 8
gsettings set org.gnome.shell.extensions.bsptile outer-gaps 8
gsettings set org.gnome.shell.extensions.bsptile tile-focused-window "['<Super>t']"
```

(If you run these against a clone that isn't the one symlinked into
`~/.local/share/gnome-shell/extensions/`, add
`--schemadir /path/to/bsptile/schemas` -- the schema isn't compiled into
the system-wide cache.)

## Uninstall

```sh
gnome-extensions disable bsptile@zach.local
rm ~/.local/share/gnome-shell/extensions/bsptile@zach.local   # just the symlink
```

The gsettings tweaks `install.sh` applied (Ptyxis, focus-mode, keybindings)
aren't reverted automatically -- they're plain GNOME preferences independent
of the extension, so undo them the same way you'd change any other setting.

## Known limitations

- No floating-window toggle -- everything not maximized/transient/dialog
  gets auto-tiled on creation; there's no "detile" action yet.
- Not workspace-migration-aware -- dragging a tiled window to another
  workspace or monitor doesn't move it between trees; it stays tracked
  under wherever it was inserted.
- A deep spiral can ask a window for a size below its actual minimum
  (e.g. a terminal's minimum column count); there's a 200px floor on tile
  size to keep this rare, but it's not airtight.
- Multi-monitor is implemented but not tested beyond a single monitor.

## Repo layout

| File | What it is |
|---|---|
| `extension.js` | Lifecycle: window tracking, tiling, resize-drag, focus border, keybindings |
| `bspTree.js` | The BSP tree itself -- pure logic, no GNOME dependencies |
| `windowBorder.js` | The focus-border widget |
| `metadata.json` | Extension manifest |
| `schemas/` | gsettings schema (gaps, keybinding) |
| `install.sh` | Full setup script, see above |
