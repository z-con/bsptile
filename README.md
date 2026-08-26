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
- **Swap on drop** -- drag a tiled window and drop it on top of another
  tiled window in the same tree and the two swap positions, instead of
  snapping back to where the dragged one started.
- **Configurable gaps** -- inner (between tiles) and outer (tiles to
  monitor edge), independently.
- **Focus border** -- a thin outline around whichever window is focused,
  using your GNOME accent color.
- **Slightly transparent top panel.**
- **Deny fullscreen/maximize on open** (on by default) -- if a newly-opened
  window comes up fullscreen or maximized (covering the whole screen
  unmanaged, which is what several apps do by default, e.g. GNOME Settings),
  it's forced out of that state and tiled into the layout instead. Disable
  with: `gsettings set org.gnome.shell.extensions.bsptile deny-fullscreen-on-open false`.
- **`Super+T`** -- pull the focused window into the tiled layout, even if
  it's currently maximized (unmaximizes it first).
- **`Super+Shift+T`** -- untile the focused window, leaving it floating
  exactly where it was; its sibling reclaims the space.
- **`Ctrl+Super+Arrow keys`** -- move the shared divider adjacent to the
  focused window a step in that direction (keyboard equivalent of
  border-drag resizing). If that edge borders the screen instead of a
  sibling, the opposite divider moves instead, so the screen-edge side
  stays put and the focused window resizes itself.
- **Workspace/monitor migration** -- drag a tiled window to another
  workspace or monitor (or move it via keybinding) and it moves between
  trees instead of staying stuck in its original one.
- **Per-monitor virtual workspaces** (off by default) -- give each monitor
  its own independent, switchable set of workspaces (i3/KDE-style), instead
  of GNOME's one workspace list shared by every monitor. Enable with:
  `gsettings set org.gnome.shell.extensions.bsptile per-monitor-workspaces-enabled true`.
  Once on:
  - Each monitor starts with a single empty slot. Slots grow and shrink
    dynamically to match GNOME's own `dynamic-workspaces` behavior, just
    per monitor instead of shared across all of them: as soon as a slot
    gets a window, a fresh empty slot appears past it so there's always
    somewhere new to switch into, and any empty slot that isn't the one
    you're currently looking at gets silently discarded (with the rest
    renumbered), so idle slots never pile up.
  - GNOME is pinned to a single real workspace (`install.sh` sets
    `dynamic-workspaces false` / `num-workspaces 1`), and the extension
    **takes over GNOME's own native workspace-switching keybindings and
    touchpad swipe gesture** -- `Super+Page_Down`/`Page_Up`,
    `Super+Alt+Right`/`Left`, `Ctrl+Alt+Right`/`Left`/`Up`/`Down`, the
    `Shift`-prefixed move-window variants, and a horizontal 3-finger
    touchpad swipe -- so the switching you already know drives this
    per-monitor simulation instead of real (all-monitor) GNOME switching.
    Disabling the feature restores every one of those to stock GNOME
    behavior. A 5-button mouse's side buttons (button 8/"back", button
    9/"forward") do the same, captured stage-wide -- this takes those
    buttons away from per-app back/forward navigation (e.g. a browser)
    while the feature is on.
  - A small dot row (`● ● ○ ○`) shows each monitor's own active slot: in
    the real top panel on the primary monitor, and as a small corner
    overlay on every other monitor (no full secondary panel exists yet).
    The Activities button is hidden while this is on (redundant with
    `Super+Space` and sat right next to the indicator).

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
   the extension itself: focus-follows-cursor, `Super+W` to close the
   focused window, `Super+Space` for the Activities Overview (GNOME's
   Spotlight-equivalent search), disabling GNOME's own built-in
   `Super+Left`/`Super+Right` half-screen tiling (it fights with bsptile),
   and three terminal/app shortcuts: `Super+Return` opens a terminal
   (Ghostty), `Shift+Super+Return` opens a new Firefox window, and
   `Ctrl+Super+Return` opens a terminal running `claude` in `~/Claude`.
   Terminal-emulator config itself (Ghostty's opacity/blur/palette) isn't
   set here -- it lives in the [omakit](https://github.com/z-con/omakit)
   dotfiles bundle alongside the rest of this machine's setup.

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
gsettings set org.gnome.shell.extensions.bsptile resize-left "['<Control><Super>Left']"
gsettings set org.gnome.shell.extensions.bsptile per-monitor-workspaces-enabled true
gsettings set org.gnome.shell.extensions.bsptile deny-fullscreen-on-open false
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

- Multi-monitor is implemented -- trees are keyed per-monitor, and moving a
  tiled window to a different monitor migrates it into that monitor's tree
  -- but only code-reviewed, not physically tested on real multi-monitor
  hardware (this machine has one monitor). Per-monitor virtual workspaces
  inherit the same caveat, with substantially more state to get wrong:
  monitor-unplug reflow, minimize-based parking, and monitor identity
  tracking across a `monitors-changed` reconfigure are all unverified on
  real hardware.
- Per-monitor virtual workspaces simulate independence by minimizing/
  unminimizing windows, since Mutter has no native per-monitor workspace
  concept. If you unminimize a parked window some other way than bsptile's
  own switch keybindings/gesture (a dock, the Overview, Alt-Tab), it's
  treated as "make this window's slot the active one on its monitor" -- a
  heuristic that covers the common case, not a guarantee. Real GNOME
  workspace switching stops being meaningful for tiled windows while this
  feature is on -- everything is pinned to the one real workspace that was
  active when it was enabled -- which is exactly why the feature takes over
  the switching keybindings/gesture rather than leaving them pointed at a
  workspace list nothing else uses.
- Virtual workspace slots grow/shrink dynamically, discarding empty
  non-active slots and renumbering the rest to stay contiguous. This
  renumbering has to keep the tiling trees, per-window slot bookkeeping,
  and the indicator all in lockstep -- code-reviewed and exercised live on
  a single-monitor setup, but the cross-monitor discard/renumber paths
  (e.g. a window dragged to another monitor emptying its old slot) are
  unverified on real multi-monitor hardware.
- The touchpad swipe takeover (`gestureSwitcher.js`) reaches into GNOME
  Shell's undocumented internals (`Main.wm._workspaceAnimation._swipeTracker`)
  to disable the native gesture, and builds its own `SwipeTracker` instance
  the same way GNOME's own code does. Neither of those is stable, versioned
  extension API -- this is the piece of the extension most likely to break
  on a future GNOME Shell upgrade. If a swipe stops doing anything after an
  update, that's the first place to look; the keybinding takeover (stable
  `Main.wm.addKeybinding` API) isn't affected by the same risk.
- A deep spiral prefers redistributing new windows into whichever leaf has
  the most room once a split would drop below ~200px on its short axis, so
  tile sizes plateau instead of shrinking indefinitely -- but it's a
  heuristic, not a hard guarantee. A window can still end up smaller than
  its actual minimum size (e.g. a terminal's minimum column count) if every
  leaf is already cramped; the resize path has an equivalent floor to keep
  its ratio from drifting out of sync with reality when that happens.

`Super+T` tiles the focused window and `Super+Shift+T` untiles it (leaving
it exactly where it was, as a floating window), so there's no scenario
where a window is stuck one way or the other.

## Repo layout

| File | What it is |
|---|---|
| `extension.js` | Lifecycle: window tracking, tiling, resize-drag, focus border, keybindings |
| `bspTree.js` | The BSP tree itself -- pure logic, no GNOME dependencies |
| `virtualWorkspace.js` | Per-monitor virtual workspace bookkeeping (minimize-based parking) |
| `gestureSwitcher.js` | Touchpad swipe -> per-monitor virtual workspace switching |
| `mouseButtonSwitcher.js` | Mouse side buttons (8/9) -> per-monitor virtual workspace switching |
| `workspaceIndicator.js` | The per-monitor dot-row indicator widget |
| `indicatorManager.js` | Creates/destroys one indicator per monitor |
| `windowBorder.js` | The focus-border widget |
| `metadata.json` | Extension manifest |
| `schemas/` | gsettings schema (gaps, keybinding) |
| `install.sh` | Full setup script, see above |
