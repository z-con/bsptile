import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BspTree } from './bspTree.js';
import { FocusBorder } from './windowBorder.js';
import { getCornerRadius, probeCornerRadius } from './cornerRadius.js';
import { VirtualWorkspaceManager } from './virtualWorkspace.js';
import { GestureSwitcher } from './gestureSwitcher.js';
import { MouseButtonSwitcher } from './mouseButtonSwitcher.js';
import { IndicatorManager } from './indicatorManager.js';

// Diagnostic logging for the monitor-hotplug/virtual-workspace machinery --
// grep `journalctl --user -g bsptile-monitor` to follow a live plug/unplug.
// Kept permanently (not gated on a debug setting): this class of bug is
// intermittent and hardware-triggered, so a standing trail is worth far
// more than the near-zero cost of a few log lines around a monitor
// reconfigure, which is not a hot path.
function debugLog(...args) {
    log(`[bsptile-monitor] ${args.join(' ')}`);
}

const FOCUS_BORDER_WIDTH = 2;
// Matches the default terminal (Ptyxis, "Ubuntu" palette, dark) exactly:
// palette Background #300A24 at the profile's opacity=0.6.
const PANEL_BACKGROUND_STYLE = 'background-color: rgba(48,10,36,0.6);';

const RESIZE_STEP_PX = 50;

// Native org.gnome.desktop.wm.keybindings keys this extension takes over
// while per-monitor-workspaces-enabled is on -- cleared (and later
// restored) so the SAME physical keys the user already knows drive our
// per-monitor simulation instead of real (all-monitor) GNOME workspace
// switching, rather than fighting over one accelerator between two actions.
const NATIVE_WORKSPACE_KEYBINDING_KEYS = [
    'switch-to-workspace-left', 'switch-to-workspace-right',
    'switch-to-workspace-up', 'switch-to-workspace-down',
    'move-to-workspace-left', 'move-to-workspace-right',
    'move-to-workspace-up', 'move-to-workspace-down',
];

// GNOME's own org.gnome.shell.keybindings schema binds Super+1..9 to
// switch-to-application-N (jump to the Nth favorite/running app in the
// dash) by default -- the same accelerators our numbered virtual-workspace
// keybindings below use, so these need the same save-clear-restore
// takeover treatment as NATIVE_WORKSPACE_KEYBINDING_KEYS, just in a
// different schema. No native switch-to-application-10 exists (Super+0 is
// unbound by default), and Super+Shift+N isn't bound to anything native.
const NATIVE_APP_SWITCH_KEYBINDING_KEYS =
    Array.from({ length: 9 }, (_, i) => `switch-to-application-${i + 1}`);

// Ubuntu Dock (and upstream dash-to-dock, same schema id) binds its own
// Super+1..9,0 / Super+Shift+1..9,0 / Ctrl+Super+1..9,0 "activate Nth
// pinned app" hotkeys directly via Main.wm.addKeybinding -- entirely
// outside both org.gnome.desktop.wm.keybindings and
// org.gnome.shell.keybindings, so it's a third, independent source of
// conflicting Super+N accelerators (confirmed live: Super+1 was opening
// dash-to-dock's expose-style multi-window scale view instead of
// switching virtual workspace slots). It gates all of those keybindings
// behind this single boolean (see docking.js's KeyboardShortcuts class),
// so toggling it is simpler and more robust than clearing 30 individual
// accelerator arrays.
const DASH_TO_DOCK_SCHEMA_ID = 'org.gnome.shell.extensions.dash-to-dock';

// Slot indices (0-based) for the 10 numbered virtual-workspace keybindings,
// keyed by the gsettings suffix -- digit key "1" is slot 0 ... "9" is slot
// 8, and "0" is slot 9, matching the usual desktop convention of the 0 key
// mapping to the 10th workspace.
const NUMBERED_VWS_SLOTS = Array.from({ length: 10 }, (_, i) => i);

function resizeSidesFromGrabOp(grabOp) {
    let horizontal = null;
    let vertical = null;
    switch (grabOp) {
        case Meta.GrabOp.RESIZING_E: case Meta.GrabOp.RESIZING_NE: case Meta.GrabOp.RESIZING_SE:
            horizontal = 'E'; break;
        case Meta.GrabOp.RESIZING_W: case Meta.GrabOp.RESIZING_NW: case Meta.GrabOp.RESIZING_SW:
            horizontal = 'W'; break;
    }
    switch (grabOp) {
        case Meta.GrabOp.RESIZING_N: case Meta.GrabOp.RESIZING_NE: case Meta.GrabOp.RESIZING_NW:
            vertical = 'N'; break;
        case Meta.GrabOp.RESIZING_S: case Meta.GrabOp.RESIZING_SE: case Meta.GrabOp.RESIZING_SW:
            vertical = 'S'; break;
    }
    return { horizontal, vertical };
}

// Checks that hold regardless of the window's current size state (dialog,
// transient, minimized, ...) -- these windows are never candidates for
// tiling no matter what _forceIntoTiling does to their fullscreen/maximized
// flags.
function isTileableBase(window) {
    if (!window) return false;
    if (window.windowType !== Meta.WindowType.NORMAL) return false;
    if (window.get_transient_for() !== null) return false;
    if (window.is_attached_dialog()) return false;
    if (window.minimized) return false;
    return true;
}

function isTileable(window) {
    return isTileableBase(window) &&
        !window.maximizedHorizontally && !window.maximizedVertically &&
        !window.is_fullscreen();
}

export default class BspTileExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._trees = new Map();        // Meta.Workspace -> Map<monitorIndex, Map<vwsIndex, BspTree>>
        this._windowState = new Map();  // Meta.Window -> { signalIds, workspace, monitorIndex, virtualWorkspaceIndex, hiddenByVirtualWorkspace }
        this._globalSignals = [];       // [{obj, id}]
        this._grabbedWindow = null;     // window currently being live-dragged; skip it in _layoutTree
        this._activeGrab = null;        // { window, sizeChangedId } while a resize grab is in progress
        this._grabInProgressWindow = null; // any window currently under ANY live grab (move or resize) -- see _checkWindowMigration
        this._suppressMigrationChecks = false; // see monitors-changed handler and _checkWindowMigration
        this._panelStyleTimeoutId = null;

        // Per-monitor virtual workspaces (see virtualWorkspace.js): null
        // unless per-monitor-workspaces-enabled is on. _pinnedWorkspace is
        // the one real GNOME workspace all vws bookkeeping is pinned to
        // while the feature is active -- real workspace switching isn't
        // meaningful for tiled windows once it's on.
        this._virtualWorkspaces = null;
        this._pinnedWorkspace = null;
        this._gestureSwitcher = null;
        this._mouseButtonSwitcher = null;
        this._indicatorManager = null;
        this._wmKeybindingsSettings = null;
        this._savedNativeKeybindings = null;
        this._shellKeybindingsSettings = null;
        this._savedNativeAppSwitchKeybindings = null;
        this._dashToDockSettings = null;
        this._savedDashToDockHotKeys = undefined;
        this._nativeSwipeTrackerWasEnabled = undefined;
        this._activitiesButtonWasVisible = undefined;

        this._focusBorder = new FocusBorder(FOCUS_BORDER_WIDTH);
        global.windowGroup.add_child(this._focusBorder);
        this._focusedWindowSignals = []; // [{obj, id}] for whichever window is currently focused

        Main.panel.set_style(PANEL_BACKGROUND_STYLE);

        Main.wm.addKeybinding(
            'tile-focused-window',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => this._tileFocusedWindow()
        );
        Main.wm.addKeybinding(
            'untile-focused-window',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => this._untileFocusedWindow()
        );
        for (const direction of ['left', 'right', 'up', 'down']) {
            Main.wm.addKeybinding(
                `resize-${direction}`,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                () => this._resizeFocused(direction)
            );
        }
        // The 4 virtual-workspace keybindings, native keybinding takeover,
        // gesture takeover, and the indicator are all set up/torn down in
        // _enableVirtualWorkspaces()/_disableVirtualWorkspaces() instead of
        // unconditionally here -- otherwise turning per-monitor-workspaces-
        // enabled off at runtime would leave native GNOME workspace
        // switching permanently dead instead of actually restoring it.

        const start = () => {
            Main.panel.set_style(PANEL_BACKGROUND_STYLE);

            if (this._settings.get_boolean('per-monitor-workspaces-enabled'))
                this._enableVirtualWorkspaces();

            this._connectGlobalSignals();
            this._rebuildAllTrees();
            this._onFocusChanged();

            // On a cold boot, something in the shell's post-startup settling
            // (after 'startup-complete' has already fired) can still clear an
            // inline style applied this early. Reassert it once more shortly
            // after everything else has had a chance to finish.
            this._panelStyleTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                Main.panel.set_style(PANEL_BACKGROUND_STYLE);
                this._panelStyleTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });

            // The shell's own Overview._hideDone() clears Main.panel's inline
            // style to null every time the overview finishes closing, AFTER
            // it emits 'hidden' (confirmed live via Looking Glass: a stack
            // trace on the style-clearing notify showed overview.js's
            // _hideDone calling it a few lines after _changeShownState
            // fires 'hidden'). So reapplying synchronously from a 'hidden'
            // handler loses the race — it runs earlier in the same call
            // stack, before the shell's own reset later in that function.
            // Defer to the next idle iteration so we run after _hideDone
            // has fully unwound.
            const overviewHiddenId = Main.overview.connect('hidden', () => {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    Main.panel.set_style(PANEL_BACKGROUND_STYLE);
                    this._reassertNativeSwipeTrackerDisabled();
                    return GLib.SOURCE_REMOVE;
                });
            });
            this._globalSignals.push({ obj: Main.overview, id: overviewHiddenId });

            // See _reassertActivitiesButtonHidden's own comment -- this is
            // the lock/unlock (e.g. lid-close/resume) reset trigger, a
            // separate signal from Main.overview's 'hidden' above.
            const sessionModeUpdatedId = Main.sessionMode.connect('updated', () => {
                this._reassertActivitiesButtonHidden();
            });
            this._globalSignals.push({ obj: Main.sessionMode, id: sessionModeUpdatedId });
        };

        if (Main.layoutManager._startingUp) {
            const id = Main.layoutManager.connect('startup-complete', () => {
                Main.layoutManager.disconnect(id);
                start();
            });
            this._globalSignals.push({ obj: Main.layoutManager, id });
        } else {
            start();
        }
    }

    disable() {
        if (this._panelStyleTimeoutId) {
            GLib.source_remove(this._panelStyleTimeoutId);
            this._panelStyleTimeoutId = null;
        }

        this._globalSignals.forEach(({ obj, id }) => obj.disconnect(id));
        this._globalSignals = [];

        if (this._activeGrab) {
            this._activeGrab.window.disconnect(this._activeGrab.sizeChangedId);
            this._activeGrab = null;
        }

        this._focusedWindowSignals.forEach(({ obj, id }) => obj.disconnect(id));
        this._focusedWindowSignals = [];
        this._focusBorder.destroy();
        this._focusBorder = null;

        Main.panel.set_style(null);

        Main.wm.removeKeybinding('tile-focused-window');
        Main.wm.removeKeybinding('untile-focused-window');
        for (const direction of ['left', 'right', 'up', 'down'])
            Main.wm.removeKeybinding(`resize-${direction}`);

        for (const [window, state] of this._windowState) {
            state.signalIds.forEach(id => window.disconnect(id));
        }
        this._windowState = null;
        this._trees = null;

        this._disableVirtualWorkspaces();

        this._settings = null;
        this._wmKeybindingsSettings = null;
        this._shellKeybindingsSettings = null;
        this._dashToDockSettings = null;
        this._grabbedWindow = null;
        this._grabInProgressWindow = null;
    }

    _enableVirtualWorkspaces() {
        this._pinnedWorkspace = global.workspaceManager.get_active_workspace();
        this._virtualWorkspaces = new VirtualWorkspaceManager({
            getWindowsInSlot: (monitorIndex, vwsIndex) => {
                const tree = this._treeFor(this._pinnedWorkspace, monitorIndex, vwsIndex, false);
                return tree ? [...tree.windows] : [];
            },
            markHidden: (window, hidden) => {
                const state = this._windowState.get(window);
                if (state) state.hiddenByVirtualWorkspace = hidden;
            },
            onActiveChanged: (monitorIndex) => this._indicatorManager?.update(monitorIndex),
            onSlotDiscarded: (monitorIndex, discardedIndex) =>
                this._onVwsSlotDiscarded(monitorIndex, discardedIndex),
        });

        Main.wm.addKeybinding('virtual-workspace-next', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL, () => this._switchVirtualWorkspace(1));
        Main.wm.addKeybinding('virtual-workspace-prev', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL, () => this._switchVirtualWorkspace(-1));
        Main.wm.addKeybinding('move-window-to-virtual-workspace-next', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL, () => this._moveFocusedWindowToVirtualWorkspace(1));
        Main.wm.addKeybinding('move-window-to-virtual-workspace-prev', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL, () => this._moveFocusedWindowToVirtualWorkspace(-1));

        for (const slot of NUMBERED_VWS_SLOTS) {
            Main.wm.addKeybinding(`switch-to-virtual-workspace-${slot + 1}`, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL, () => this._switchVirtualWorkspaceToIndex(slot));
            Main.wm.addKeybinding(`move-window-to-virtual-workspace-${slot + 1}`, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL, () => this._moveFocusedWindowToVirtualWorkspaceIndex(slot));
        }

        // Take over the native accelerators for the same actions, so the
        // keys the user already knows drive our per-monitor simulation
        // instead of real (all-monitor) GNOME workspace switching. Saved
        // so _disableVirtualWorkspaces() can give stock switching back
        // rather than leaving these keys dead.
        if (!this._wmKeybindingsSettings)
            this._wmKeybindingsSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
        this._savedNativeKeybindings = {};
        for (const key of NATIVE_WORKSPACE_KEYBINDING_KEYS) {
            this._savedNativeKeybindings[key] = this._wmKeybindingsSettings.get_strv(key);
            this._wmKeybindingsSettings.set_strv(key, []);
        }

        // Same takeover for Super+1..9's native switch-to-application-N
        // binding (org.gnome.shell.keybindings) -- see
        // NATIVE_APP_SWITCH_KEYBINDING_KEYS above for why this is a
        // separate schema from the wm-keybindings takeover just above.
        if (!this._shellKeybindingsSettings)
            this._shellKeybindingsSettings = new Gio.Settings({ schema_id: 'org.gnome.shell.keybindings' });
        this._savedNativeAppSwitchKeybindings = {};
        for (const key of NATIVE_APP_SWITCH_KEYBINDING_KEYS) {
            this._savedNativeAppSwitchKeybindings[key] = this._shellKeybindingsSettings.get_strv(key);
            this._shellKeybindingsSettings.set_strv(key, []);
        }

        // Same takeover for Ubuntu Dock/dash-to-dock's independent
        // Super+N hotkeys -- see DASH_TO_DOCK_SCHEMA_ID above. Guarded
        // since that extension might not be installed at all.
        if (!this._dashToDockSettings && Gio.SettingsSchemaSource.get_default().lookup(DASH_TO_DOCK_SCHEMA_ID, true))
            this._dashToDockSettings = new Gio.Settings({ schema_id: DASH_TO_DOCK_SCHEMA_ID });
        if (this._dashToDockSettings) {
            this._savedDashToDockHotKeys = this._dashToDockSettings.get_boolean('hot-keys');
            if (this._savedDashToDockHotKeys)
                this._dashToDockSettings.set_boolean('hot-keys', false);
        }

        // Same idea for the native touchpad swipe-to-switch-workspace
        // gesture: disable GNOME's own handler and drive the simulation
        // from our own gesture recognizer instead (gestureSwitcher.js).
        const nativeSwipeTracker = Main.wm._workspaceAnimation?._swipeTracker;
        if (nativeSwipeTracker) {
            this._nativeSwipeTrackerWasEnabled = nativeSwipeTracker.enabled;
            nativeSwipeTracker.enabled = false;
        }
        this._gestureSwitcher = new GestureSwitcher(this._virtualWorkspaces);
        this._mouseButtonSwitcher = new MouseButtonSwitcher(this._virtualWorkspaces);

        this._indicatorManager = new IndicatorManager(this._virtualWorkspaces, PANEL_BACKGROUND_STYLE);

        // Registering the monitor-2+ bar's strut (affectsStruts: true,
        // inside IndicatorManager) doesn't necessarily update Mutter's
        // work-area calculation synchronously -- _rebuildAllTrees(), called
        // right after this by both callers of _enableVirtualWorkspaces()
        // (start() and the settings-changed handler), can race it and
        // compute geometry against the pre-strut work area. Defer one more
        // relayout pass to the next idle cycle, after Mutter's had a
        // chance to settle, so already-tiled windows on that monitor end
        // up correctly positioned below the bar instead of stuck under it
        // until some unrelated future relayout happens to fix it.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._relayoutAll();
            return GLib.SOURCE_REMOVE;
        });

        // The Activities button sits immediately next to our indicator and
        // does the same thing Super+Space already does -- redundant once
        // our indicator/switching takes over, so hide it while this
        // feature is on.
        const activitiesButton = Main.panel.statusArea['activities'];
        if (activitiesButton) {
            this._activitiesButtonWasVisible = activitiesButton.container.visible;
            activitiesButton.container.hide();
        }
    }

    // GNOME's own WorkspaceAnimationController silently flips its native
    // swipe tracker's `enabled` back to true well after we disabled it in
    // _enableVirtualWorkspaces() -- confirmed live on two separate
    // triggers, a monitors-changed reconfigure and, more disruptively
    // since it happens constantly in normal use, just closing the Overview
    // (Super+Space, a hot corner) -- with no recreation of the tracker
    // object itself, just the flag flipping back. Left alone, the native
    // and GestureSwitcher trackers both fire on the next touchpad swipe,
    // fighting each other. A no-op while vws is off.
    _reassertNativeSwipeTrackerDisabled() {
        if (!this._virtualWorkspaces) return;
        const nativeSwipeTracker = Main.wm._workspaceAnimation?._swipeTracker;
        if (nativeSwipeTracker)
            nativeSwipeTracker.enabled = false;
    }

    // panel.js re-adds every configured panel button -- calling .show()
    // on each unconditionally -- any time Main.sessionMode's 'updated'
    // signal fires, via _updatePanel()/_updateBox()/_addToPanelBox().
    // Confirmed live via a stack trace: unlocking the screen
    // (screenShield.deactivate() -> sessionMode.popMode() -> _sync() ->
    // emits 'updated') re-shows the Activities button we hid in
    // _enableVirtualWorkspaces(), independently of both the Overview-close
    // and monitors-changed reset triggers already handled elsewhere --
    // e.g. a lid-close/resume cycle that locks and unlocks the session.
    // Unlike the panel-style/Overview race, panel.js's own 'updated'
    // handler is registered at shell startup, long before this extension's
    // -- so reasserting synchronously from our own 'updated' handler runs
    // after it in the same dispatch and reliably wins the race, no
    // idle_add defer needed (confirmed live). A no-op while vws is off.
    _reassertActivitiesButtonHidden() {
        if (!this._virtualWorkspaces) return;
        const activitiesButton = Main.panel.statusArea['activities'];
        if (activitiesButton)
            activitiesButton.container.hide();
    }

    _disableVirtualWorkspaces() {
        if (!this._virtualWorkspaces) return;

        const activitiesButton = Main.panel.statusArea['activities'];
        if (activitiesButton && this._activitiesButtonWasVisible !== undefined)
            activitiesButton.container.visible = this._activitiesButtonWasVisible;
        this._activitiesButtonWasVisible = undefined;

        this._indicatorManager?.destroyAll();
        this._indicatorManager = null;

        this._gestureSwitcher?.destroy();
        this._gestureSwitcher = null;

        this._mouseButtonSwitcher?.destroy();
        this._mouseButtonSwitcher = null;

        const nativeSwipeTracker = Main.wm._workspaceAnimation?._swipeTracker;
        if (nativeSwipeTracker && this._nativeSwipeTrackerWasEnabled !== undefined)
            nativeSwipeTracker.enabled = this._nativeSwipeTrackerWasEnabled;
        this._nativeSwipeTrackerWasEnabled = undefined;

        if (this._savedNativeKeybindings) {
            for (const key of NATIVE_WORKSPACE_KEYBINDING_KEYS)
                this._wmKeybindingsSettings.set_strv(key, this._savedNativeKeybindings[key]);
            this._savedNativeKeybindings = null;
        }

        if (this._savedNativeAppSwitchKeybindings) {
            for (const key of NATIVE_APP_SWITCH_KEYBINDING_KEYS)
                this._shellKeybindingsSettings.set_strv(key, this._savedNativeAppSwitchKeybindings[key]);
            this._savedNativeAppSwitchKeybindings = null;
        }

        if (this._dashToDockSettings && this._savedDashToDockHotKeys)
            this._dashToDockSettings.set_boolean('hot-keys', true);
        this._savedDashToDockHotKeys = undefined;

        Main.wm.removeKeybinding('virtual-workspace-next');
        Main.wm.removeKeybinding('virtual-workspace-prev');
        Main.wm.removeKeybinding('move-window-to-virtual-workspace-next');
        Main.wm.removeKeybinding('move-window-to-virtual-workspace-prev');
        for (const slot of NUMBERED_VWS_SLOTS) {
            Main.wm.removeKeybinding(`switch-to-virtual-workspace-${slot + 1}`);
            Main.wm.removeKeybinding(`move-window-to-virtual-workspace-${slot + 1}`);
        }

        this._virtualWorkspaces.destroy();
        this._virtualWorkspaces = null;
        this._pinnedWorkspace = null;
    }

    _connectGlobalSignals() {
        const conn = (obj, sig, fn) =>
            this._globalSignals.push({ obj, id: obj.connect(sig, fn) });

        conn(global.display, 'window-created', (_d, window) => this._onWindowCreated(window));
        conn(global.display, 'grab-op-begin', (_d, window, grabOp) => this._onGrabBegin(window, grabOp));
        conn(global.display, 'grab-op-end', (_d, window) => this._onGrabEnd(window));
        conn(global.display, 'notify::focus-window', () => this._onFocusChanged());
        conn(global.workspaceManager, 'active-workspace-changed', () => this._relayoutAll());
        conn(global.workspaceManager, 'workspace-removed', () => this._rebuildAllTrees());
        conn(Main.layoutManager, 'monitors-changed', () => {
            // Logged by LOGICAL monitor index (the same index space
            // window.get_monitor() uses), not MonitorManager's raw physical-
            // monitor list order -- those two are NOT guaranteed to agree
            // (confirmed live 2026-08-26 they were flatly swapped on this
            // machine), so logging the raw list here would misrepresent
            // what index N actually means for every other log line below.
            const logicalMonitors = global.backend.get_monitor_manager().get_logical_monitors();
            debugLog('monitors-changed fired;', logicalMonitors.length, 'monitor(s):',
                logicalMonitors.map((lm, i) => {
                    try {
                        return `${i}=${lm.get_monitors()[0].get_connector()}`;
                    } catch (e) {
                        return `${i}=<get_connector threw: ${e}>`;
                    }
                }).join(', '));

            // A monitor reconfigure fires 'position-changed' on windows that
            // never actually moved (work areas/struts recalculate system-
            // wide) -- confirmed live 2026-08-26: a window sitting untouched
            // on the laptop's active slot got yanked onto the external
            // monitor's tree mid-plug with no user action at all.
            // _checkWindowMigration reacts to that signal using a raw
            // monitor-index comparison with no defense against exactly this
            // (unlike _rebuildAllTrees below, which already learned not to
            // trust a bare index/connector blip as a real relocation).
            // _rebuildAllTrees is about to comprehensively re-derive every
            // window's correct tree from scratch anyway, so there's nothing
            // for the reactive per-window path to usefully do here --
            // suppress it for the duration of the reconfigure and let it
            // resume once things have actually settled.
            this._suppressMigrationChecks = true;

            try {
                this._rebuildAllTrees();
                this._indicatorManager?.rebuild();
                this._reassertNativeSwipeTrackerDisabled();
            } catch (e) {
                logError(e, '[bsptile-monitor] exception handling monitors-changed');
            }

            // Same race as _enableVirtualWorkspaces' identical idle_add
            // above: Mutter's own work-area recalculation after a monitor
            // reconfigure isn't necessarily done by the time this handler
            // runs, so _rebuildAllTrees just above can lay windows out
            // against a stale/transitional work area (visibly "squished"
            // into a too-small rect) with nothing to correct it until some
            // unrelated future relayout happens to. Defer one more pass to
            // the next idle cycle, after Mutter's had a chance to settle.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                try {
                    this._relayoutAll();
                } catch (e) {
                    logError(e, '[bsptile-monitor] exception in deferred relayout after monitors-changed');
                } finally {
                    this._suppressMigrationChecks = false;
                }
                return GLib.SOURCE_REMOVE;
            });
        });
        conn(this._settings, 'changed::inner-gaps', () => this._relayoutAll());
        conn(this._settings, 'changed::outer-gaps', () => this._relayoutAll());
        conn(this._settings, 'changed::per-monitor-workspaces-enabled', () => {
            if (this._settings.get_boolean('per-monitor-workspaces-enabled'))
                this._enableVirtualWorkspaces();
            else
                this._disableVirtualWorkspaces();
            this._rebuildAllTrees();
        });
    }

    _onWindowCreated(window) {
        if (!isTileableBase(window)) return; // cheap pre-check; size state may still change before first-frame

        const actor = window.get_compositor_private();
        if (!actor) return;

        const firstFrameId = actor.connect('first-frame', () => {
            actor.disconnect(firstFrameId);
            // re-check: app may have become a dialog/minimized by now
            if (!isTileableBase(window)) return;

            // Confirmed live 2026-08-26: window.get_monitor() can still
            // report the WRONG monitor right at 'first-frame' for a window
            // that opened on a just-plugged-in external display -- Mutter
            // hadn't finished associating it with its actual monitor yet.
            // The window renders in the right place; only the *query*
            // lagged. Same class of "queried before it settled" race as the
            // work-area recalculation elsewhere in this file -- defer one
            // more main-loop tick so the answer matches reality before
            // anything downstream (tiling, vws tracking) bakes in the wrong
            // monitor.
            const immediateMonitor = window.get_monitor();
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (!isTileableBase(window)) return GLib.SOURCE_REMOVE; // closed/changed during the deferred tick
                const settledMonitor = window.get_monitor();
                if (settledMonitor !== immediateMonitor) {
                    debugLog('_onWindowCreated:', window.get_title?.() ?? '<window>',
                        '-- get_monitor() at first-frame was', immediateMonitor,
                        'but settled to', settledMonitor, 'one tick later (this is the race being worked around)');
                }

                const opensCoveringScreen = window.is_fullscreen() ||
                    window.maximizedHorizontally || window.maximizedVertically;
                if (opensCoveringScreen) {
                    if (this._settings.get_boolean('deny-fullscreen-on-open'))
                        this._forceIntoTiling(window);
                    return GLib.SOURCE_REMOVE;
                }

                this._insertWindow(window);
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // Strips fullscreen/maximize off a window that opened covering the
    // whole screen, one geometry change at a time, until it's actually
    // tileable. Some apps' fullscreen sits on top of an underlying
    // maximized restore state, so unmake_fullscreen() alone can land on
    // maximized instead of normal -- keep peeling until isTileable is
    // satisfied. Each step is async (Wayland clients settle geometry over a
    // compositor round-trip, same as the size-changed wait
    // _tileFocusedWindow uses for a manual Super+T unmaximize), so this
    // recurses off 'size-changed' rather than doing it all synchronously.
    _forceIntoTiling(window) {
        if (window.is_fullscreen()) {
            const id = window.connect('size-changed', () => {
                window.disconnect(id);
                this._forceIntoTiling(window);
            });
            window.unmake_fullscreen();
            return;
        }
        if (window.maximizedHorizontally || window.maximizedVertically) {
            const id = window.connect('size-changed', () => {
                window.disconnect(id);
                this._forceIntoTiling(window);
            });
            window.unmaximize();
            return;
        }
        if (!isTileable(window)) return; // e.g. closed/minimized itself mid-flight
        this._insertWindow(window);
    }

    // The workspace a window's tree membership is keyed under. With
    // per-monitor virtual workspaces off, that's just its real GNOME
    // workspace. With them on, everything is pinned to the one real
    // workspace active when the feature was turned on -- real workspace
    // switching stops being meaningful for tiled windows at that point.
    _effectiveWorkspace(window) {
        return this._pinnedWorkspace ?? window.get_workspace();
    }

    _activeVwsIndex(monitorIndex) {
        return this._virtualWorkspaces ? this._virtualWorkspaces.activeIndexFor(monitorIndex) : 0;
    }

    // Keeps _trees and _windowState in lockstep with a discard that already
    // happened inside VirtualWorkspaceManager -- fired synchronously from
    // there (see onSlotDiscarded) before anything else can observe the new,
    // renumbered indices. Only ever needs to touch _pinnedWorkspace's slice
    // of _trees: vws pins every tracked window to that one real workspace
    // for as long as the feature is on (see _effectiveWorkspace above), so
    // it's the only workspace key with vws-managed slots under it.
    _onVwsSlotDiscarded(monitorIndex, discardedIndex) {
        const byVws = this._trees.get(this._pinnedWorkspace)?.get(monitorIndex);
        if (byVws) {
            byVws.delete(discardedIndex); // guaranteed empty by the caller
            const shifted = new Map();
            for (const [i, tree] of byVws)
                shifted.set(i > discardedIndex ? i - 1 : i, tree);
            this._trees.get(this._pinnedWorkspace).set(monitorIndex, shifted);
        }

        for (const state of this._windowState.values()) {
            if (state.monitorIndex === monitorIndex && state.virtualWorkspaceIndex > discardedIndex)
                state.virtualWorkspaceIndex -= 1;
        }
    }

    _insertWindow(window) {
        const workspace = this._effectiveWorkspace(window);
        const monitorIndex = window.get_monitor();
        if (!workspace) return;

        const vwsIndex = this._activeVwsIndex(monitorIndex);
        const tree = this._treeFor(workspace, monitorIndex, vwsIndex, true);
        if (tree.has(window)) return;

        // This monitor's tree is already as full as it can get without
        // forcing some window below its real minimum size (that's what was
        // producing the overlap during the stress test). Spill over to the
        // next workspace (or, with virtual workspaces on, the next slot on
        // this monitor) instead of cramming it in.
        if (!tree.hasCapacity()) {
            const target = this._findCapacityTarget(monitorIndex, workspace, vwsIndex);
            const movingRealWorkspace = target.workspace !== workspace;
            const movingVwsSlot = !movingRealWorkspace && target.vwsIndex !== vwsIndex;

            if (movingRealWorkspace) {
                // _insertWindow runs synchronously from the window actor's
                // 'first-frame' signal -- i.e. from inside Mutter's own frame
                // processing for that actor. workspace.activate() forces an
                // immediate restack/animation of actors, which reenters the
                // compositor mid-frame and crashes it (libmutter assertion
                // in invalidate_top_window_actor_for_views: frame_in_progress
                // was still true). Defer the actual switch to the next idle
                // so it runs after this frame's signal dispatch has fully
                // unwound, then finish the insert from there.
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    window.change_workspace(target.workspace);
                    this._finishInsert(window, target.workspace, monitorIndex, target.vwsIndex);
                    target.workspace.activate(global.get_current_time());
                    window.activate(global.get_current_time());

                    // This machine runs focus-mode=mouse (focus-follows-
                    // cursor). The pointer is still wherever it physically
                    // was on the OLD workspace, so shortly after the switch
                    // above, Mutter's own focus-follows-mouse recalculates
                    // focus based on whatever the pointer now sits over on
                    // the newly-visible workspace -- usually nothing, which
                    // silently clobbers the explicit activate() calls above
                    // (confirmed live via a notify::focus-window stack
                    // trace: focus reliably went back to null moments
                    // later, with no Shell JS frames involved at all, i.e.
                    // straight from Mutter's own core pointer-focus logic).
                    // Warping the pointer there first didn't stop it --
                    // apparently a programmatic warp doesn't emit whatever
                    // real crossing/motion event that logic reacts to (a
                    // real click did fix it, confirming this is genuinely
                    // about real pointer-crossing events, not just cursor
                    // position). So instead: let that one-time reset finish
                    // happening, then reassert activation once more right
                    // after it -- same pattern as the panel-style-vs-
                    // Overview._hideDone() race elsewhere in this file.
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                        window.activate(global.get_current_time());
                        return GLib.SOURCE_REMOVE;
                    });
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }

            if (movingVwsSlot) {
                // Same reentrancy hazard as the real-workspace case above --
                // this also runs synchronously from 'first-frame' -- so defer
                // to the next idle even though switching a vws slot doesn't
                // itself touch workspace.activate()/compositor restacking.
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._virtualWorkspaces.switchTo(monitorIndex, target.vwsIndex);
                    this._finishInsert(window, target.workspace, monitorIndex, target.vwsIndex);
                    window.activate(global.get_current_time());
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                        window.activate(global.get_current_time());
                        return GLib.SOURCE_REMOVE;
                    });
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            // else: out of capacity anywhere (shouldn't normally happen given
            // the growCapacity/append_new_workspace fallback above) -- fall
            // through and tile into the original tree anyway, same as before
            // this change.
        }

        this._finishInsert(window, workspace, monitorIndex, vwsIndex);
    }

    _finishInsert(window, workspace, monitorIndex, vwsIndex) {
        const tree = this._treeFor(workspace, monitorIndex, vwsIndex, true);
        if (tree.has(window)) return;

        let nearWindow = global.display.get_focus_window();
        if (nearWindow === window) nearWindow = null;

        tree.insert(window, nearWindow);
        this._trackWindow(window, workspace, monitorIndex, vwsIndex);
        this._layoutTree(tree, workspace, monitorIndex);
        this._virtualWorkspaces?.ensureTrailingSlot(monitorIndex);
    }

    // Looks for somewhere with room for one more compliant split when
    // `fromWorkspace`/`fromVwsIndex`'s own tree is already full. With
    // per-monitor virtual workspaces off, that "somewhere" is the next real
    // GNOME workspace on this monitor (creating one if none has room) --
    // the original behavior. With them on, it's the next virtual-workspace
    // slot on this monitor instead (growing the slot count if none has
    // room), since real GNOME workspace switching isn't meaningful while
    // the feature pins everything to one real workspace.
    _findCapacityTarget(monitorIndex, fromWorkspace, fromVwsIndex) {
        if (this._virtualWorkspaces) {
            const count = this._virtualWorkspaces.countFor(monitorIndex);
            for (let i = fromVwsIndex + 1; i < count; i++) {
                const tree = this._treeFor(fromWorkspace, monitorIndex, i, false);
                if (!tree || tree.hasCapacity()) return { workspace: fromWorkspace, vwsIndex: i };
            }
            const newIndex = this._virtualWorkspaces.growCapacity(monitorIndex);
            return { workspace: fromWorkspace, vwsIndex: newIndex };
        }

        const wm = global.workspaceManager;
        const n = wm.get_n_workspaces();
        for (let i = fromWorkspace.index() + 1; i < n; i++) {
            const ws = wm.get_workspace_by_index(i);
            const tree = this._treeFor(ws, monitorIndex, 0, false);
            if (!tree || tree.hasCapacity()) return { workspace: ws, vwsIndex: 0 };
        }

        const created = wm.append_new_workspace(false, global.get_current_time());
        if (wm.get_n_workspaces() > n) return { workspace: created, vwsIndex: 0 };
        return { workspace: fromWorkspace, vwsIndex: fromVwsIndex };
    }

    // Wires up everything a tiled window needs for as long as it stays
    // tracked: removal on close, migration-detection so a window dragged to
    // another workspace/monitor (via keybinding or drag) moves between trees
    // instead of staying stuck in its original one, and (when per-monitor
    // virtual workspaces are on) minimize-state tracking so a window
    // unparked by something other than bsptile itself gets noticed.
    _trackWindow(window, workspace, monitorIndex, vwsIndex) {
        const signalIds = [
            window.connect('unmanaging', () => this._onWindowRemoved(window)),
            window.connect('workspace-changed', () => this._checkWindowMigration(window)),
            window.connect('position-changed', () => this._checkWindowMigration(window)),
        ];
        if (this._virtualWorkspaces)
            signalIds.push(window.connect('notify::minimized', () => this._onMinimizedChanged(window)));

        const monitorConnector = this._virtualWorkspaces?.connectorFor(monitorIndex) ?? null;
        debugLog('_trackWindow(', window.get_title?.() ?? '<window>', ') -- monitor', monitorIndex,
            'connector', monitorConnector, 'vws slot', vwsIndex,
            '(this._virtualWorkspaces is', this._virtualWorkspaces ? 'live' : 'NULL -- monitorConnector will stick as null', ')');

        this._windowState.set(window, {
            signalIds,
            workspace,
            monitorIndex,
            monitorConnector,
            virtualWorkspaceIndex: vwsIndex,
            hiddenByVirtualWorkspace: false,
        });
    }

    _untrackWindow(window) {
        const state = this._windowState.get(window);
        if (!state) return null;
        state.signalIds.forEach(id => window.disconnect(id));
        this._windowState.delete(window);
        return state;
    }

    // Distinguishes a bsptile-initiated park/unpark (VirtualWorkspaceManager
    // already cleared hiddenByVirtualWorkspace itself right before calling
    // unminimize -- see its unpark()) from the user unminimizing a parked
    // window some other way (dock, Overview, Alt-Tab). The latter is treated
    // as "make this window's slot the active one on its monitor" -- a
    // heuristic, not a guarantee (see README known limitations).
    _onMinimizedChanged(window) {
        if (window.minimized) return; // becoming minimized isn't the interesting transition here
        const state = this._windowState.get(window);
        if (!state) {
            debugLog('_onMinimizedChanged: untracked window', window.get_title?.() ?? '<window>', 'unminimized -- ignoring');
            return;
        }
        if (!state.hiddenByVirtualWorkspace) {
            debugLog('_onMinimizedChanged:', window.get_title?.() ?? '<window>', 'unminimized but hiddenByVirtualWorkspace',
                'was already false -- NOT promoting (this is the "someone else unminimized it and we lost track" case)');
            return;
        }
        debugLog('_onMinimizedChanged:', window.get_title?.() ?? '<window>', 'unminimized -- promoting monitor',
            state.monitorIndex, 'to slot', state.virtualWorkspaceIndex);
        state.hiddenByVirtualWorkspace = false;
        this._virtualWorkspaces?.promoteSlot(state.monitorIndex, state.virtualWorkspaceIndex, window);
    }

    _onWindowRemoved(window) {
        const state = this._untrackWindow(window);
        if (!state) return;

        // Remove from the tree it was actually inserted into, not wherever
        // get_workspace()/get_monitor() say *now* -- avoids leaking a phantom
        // leaf if _checkWindowMigration hasn't caught up yet for some reason.
        const tree = this._treeFor(state.workspace, state.monitorIndex, state.virtualWorkspaceIndex, false);
        if (!tree) return;
        tree.remove(window);
        this._layoutTree(tree, state.workspace, state.monitorIndex);
        this._virtualWorkspaces?.maybeDiscardSlot(state.monitorIndex, state.virtualWorkspaceIndex);
    }

    _checkWindowMigration(window) {
        // While a grab (move OR resize) is live for this window, defer
        // everything to _onGrabEnd. Without this, a cross-monitor drag
        // fires this on every 'position-changed' tick during the live
        // drag -- the instant the pointer crosses onto the destination
        // monitor, the window snaps to that monitor's full tile size
        // right then, mid-drag, before the user has even released the
        // mouse. Applying the whole migration atomically once, after the
        // drag genuinely ends, avoids that jitter.
        if (window === this._grabInProgressWindow) return;

        // See the monitors-changed handler: a reconfigure fires
        // position-changed on windows that never actually moved, and this
        // function has no connector-based defense against mistaking that
        // for a real cross-monitor migration. _rebuildAllTrees is already
        // handling every window comprehensively during that window, so skip.
        if (this._suppressMigrationChecks) {
            debugLog('_checkWindowMigration: suppressed for', window.get_title?.() ?? '<window>',
                '(a monitors-changed reconfigure is in progress)');
            return;
        }

        const state = this._windowState.get(window);
        if (!state) return;

        const newWorkspace = this._effectiveWorkspace(window);
        const newMonitor = window.get_monitor();
        const monitorChanged = newMonitor !== state.monitorIndex;
        if (newWorkspace === state.workspace && !monitorChanged) return;

        const oldTree = this._treeFor(state.workspace, state.monitorIndex, state.virtualWorkspaceIndex, false);
        if (oldTree) {
            oldTree.remove(window);
            this._layoutTree(oldTree, state.workspace, state.monitorIndex);
            this._virtualWorkspaces?.maybeDiscardSlot(state.monitorIndex, state.virtualWorkspaceIndex);
        }

        if (!newWorkspace) {
            // No workspace (e.g. stuck-to-all-workspaces) -- nothing sane to
            // tile it into; drop tracking rather than leave stale state.
            this._untrackWindow(window);
            return;
        }

        // A window dragged/moved to a different physical monitor doesn't
        // carry its old virtual-workspace slot number with it (meaningless
        // on a different monitor's own numbering) -- it lands on the target
        // monitor's own CURRENTLY ACTIVE slot instead, matching i3's
        // "dropped window joins the target output's current workspace"
        // convention.
        const newVwsIndex = monitorChanged ? this._activeVwsIndex(newMonitor) : state.virtualWorkspaceIndex;

        state.workspace = newWorkspace;
        state.monitorIndex = newMonitor;
        state.virtualWorkspaceIndex = newVwsIndex;

        const newTree = this._treeFor(newWorkspace, newMonitor, newVwsIndex, true);
        let nearWindow = global.display.get_focus_window();
        if (nearWindow === window) nearWindow = null;
        newTree.insert(window, nearWindow);
        this._layoutTree(newTree, newWorkspace, newMonitor);
        this._virtualWorkspaces?.ensureTrailingSlot(newMonitor);
    }

    _onGrabBegin(window, grabOp) {
        // Set for every grab type, including a plain move -- _checkWindowMigration
        // checks this to defer any tree/layout changes until the grab ends.
        this._grabInProgressWindow = window;

        const { horizontal, vertical } = resizeSidesFromGrabOp(grabOp);
        if (!horizontal && !vertical) return; // a move, or some other grab op we don't care about

        const state = this._windowState.get(window);
        if (!state) return;
        const tree = this._treeFor(state.workspace, state.monitorIndex, state.virtualWorkspaceIndex, false);
        if (!tree) return;

        // rectOf(node) -- and therefore the valid ratio range derived from it
        // -- is stable for the life of a single drag (a split's ratio only
        // moves the boundary inside its own rect, never the rect itself), so
        // compute both once here instead of recomputing on every
        // 'size-changed' tick during the drag.
        const targets = [];
        if (horizontal) {
            const node = tree.findResizeTarget(window, 'row', horizontal === 'E');
            const target = node && this._makeResizeTarget(tree, node, 'row');
            if (target) targets.push(target);
        }
        if (vertical) {
            const node = tree.findResizeTarget(window, 'col', vertical === 'S');
            const target = node && this._makeResizeTarget(tree, node, 'col');
            if (target) targets.push(target);
        }
        if (targets.length === 0) return; // dragging a work-area edge, not a shared border

        const sizeChangedId = window.connect('size-changed', () => {
            const rect = window.get_frame_rect();
            // The window's real frame rect already has the inner-gap inset baked
            // in, but nodeRect is the gap-less logical container rect, so the
            // dragged edge needs to be projected back into that logical space
            // before it's compared to nodeRect -- otherwise every drag is biased
            // by half a gap in one direction or the other (the "slightly off" bug).
            const halfGap = this._settings.get_uint('inner-gaps') / 2;
            for (const { node, axis, nodeRect } of targets) {
                const ratio = axis === 'row'
                    ? ((horizontal === 'E' ? rect.x + rect.width + halfGap : rect.x - halfGap) - nodeRect.x) / nodeRect.width
                    : ((vertical === 'S' ? rect.y + rect.height + halfGap : rect.y - halfGap) - nodeRect.y) / nodeRect.height;
                // No floor-clamp needed here -- computeRects() now enforces
                // every split's pixel floor centrally (BspTree._compute), so
                // an overshot ratio just means this divider "wants" more
                // than its sibling subtree can currently spare: the layout
                // stays safe, and the divider springs to the real clamp
                // point on its own once room frees up (e.g. a window closes).
                tree.setRatio(node, ratio);
            }
            this._grabbedWindow = window;
            this._layoutTree(tree, state.workspace, state.monitorIndex);
            this._grabbedWindow = null;
        });

        this._activeGrab = { window, sizeChangedId };
    }

    // rectOf(node) is stable for the life of a single drag (a split's ratio
    // only moves the boundary inside its own rect, never the rect itself),
    // so resolve it once here instead of on every 'size-changed' tick during
    // the drag. Returns null if this node has no computed rect yet
    // (shouldn't happen for an already-tiled window, but mirrors the old
    // inline guard).
    _makeResizeTarget(tree, node, axis) {
        const nodeRect = tree.rectOf(node);
        if (!nodeRect) return null;
        return { node, axis, nodeRect };
    }

    _onGrabEnd(window) {
        if (this._grabInProgressWindow === window)
            this._grabInProgressWindow = null;

        if (this._activeGrab && this._activeGrab.window === window) {
            window.disconnect(this._activeGrab.sizeChangedId);
            this._activeGrab = null;

            // While the drag was live, _layoutTree skipped its clamp check
            // on every tick (sizes were expected to be in flux). The sibling
            // leaves it resized as a side effect of the ratio change are
            // done moving now, so run one real pass to catch a sibling that
            // got clamped smaller than the drag's math intended.
            const state = this._windowState.get(window);
            const tree = state && this._treeFor(state.workspace, state.monitorIndex, state.virtualWorkspaceIndex, false);
            if (tree) this._layoutTree(tree, state.workspace, state.monitorIndex);
            return;
        }

        // Not a resize we were tracking -- this was a plain move (or a
        // resize against a work-area edge with no sibling to adjust, which
        // _onGrabBegin already ignored).
        const state = this._windowState.get(window);
        if (!state) return;

        // Dropped onto another tiled window in the SAME tree: swap their
        // positions instead of snapping back to where this one started.
        // Checked before _checkWindowMigration, since a same-tree drop
        // never trips its monitor/workspace-changed check anyway (nothing
        // about tree membership actually changed) -- migration and swap
        // are mutually exclusive outcomes of a single drop.
        const droppedInPlace = window.get_monitor() === state.monitorIndex
            && this._effectiveWorkspace(window) === state.workspace;
        if (droppedInPlace) {
            const tree = this._treeFor(state.workspace, state.monitorIndex, state.virtualWorkspaceIndex, false);
            const target = tree && this._findSwapTarget(window, tree);
            if (target && tree.swap(window, target)) {
                this._layoutTree(tree, state.workspace, state.monitorIndex);
                return;
            }
        }

        // Otherwise: if the window is tiled, it needs to snap back into
        // its slot now that the drag has genuinely ended:
        // _checkWindowMigration's own relayout (fired mid-drag off every
        // 'position-changed' tick) gets overridden on the very next frame
        // by the still-live grab, since the user's pointer is still
        // driving the window's real position -- and if the window never
        // even left its tree (a same-monitor, same-slot reposition, and it
        // wasn't dropped onto a swap target either), _checkWindowMigration
        // doesn't call _layoutTree at all, since it bails out early when
        // nothing about its tree membership changed. Re-running
        // migration-check-and-relayout here, now that the window's
        // position is truly final, is what actually applies the tile in
        // both cases.
        this._checkWindowMigration(window);
        const tree = this._treeFor(state.workspace, state.monitorIndex, state.virtualWorkspaceIndex, false);
        if (tree) this._layoutTree(tree, state.workspace, state.monitorIndex);
    }

    // Finds the tracked window on `tree` whose current on-screen rect
    // contains `window`'s current center point -- i.e. "window was dropped
    // on top of this one". Used by _onGrabEnd to detect a swap-on-drop.
    _findSwapTarget(window, tree) {
        const rect = window.get_frame_rect();
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;

        for (const candidate of tree.windows) {
            if (candidate === window) continue;
            const r = candidate.get_frame_rect();
            if (cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height)
                return candidate;
        }
        return null;
    }

    _tileFocusedWindow() {
        const win = global.display.get_focus_window();
        if (!win || win.windowType !== Meta.WindowType.NORMAL) return;
        if (this._windowState.has(win)) return; // already tiled

        const insertNow = () => {
            if (!isTileable(win)) return; // still not eligible (e.g. fullscreen) -- leave it alone
            this._insertWindow(win);
        };

        if (win.maximizedHorizontally || win.maximizedVertically) {
            const id = win.connect('size-changed', () => {
                win.disconnect(id);
                insertNow();
            });
            win.unmaximize();
        } else {
            insertNow();
        }
    }

    _untileFocusedWindow() {
        const win = global.display.get_focus_window();
        if (!win) return;
        this._onWindowRemoved(win); // same untrack-and-reclaim-space path a close uses
    }

    // Keyboard equivalent of border-drag resizing: nudges the shared divider
    // adjacent to the focused window one step in the given direction.
    // Prefers the divider on that literal edge (e.g. the window's own west
    // edge for 'left'); if that edge borders the work area instead of a
    // sibling, falls back to the opposite edge so the screen-edge side stays
    // fixed and the focused window resizes itself instead.
    _resizeFocused(direction) {
        const win = global.display.get_focus_window();
        if (!win) return;
        const state = this._windowState.get(win);
        if (!state) return; // not tiled

        const tree = this._treeFor(state.workspace, state.monitorIndex, state.virtualWorkspaceIndex, false);
        if (!tree) return;

        const isRow = direction === 'left' || direction === 'right';
        const orientation = isRow ? 'row' : 'col';
        const grow = direction === 'right' || direction === 'down';

        let node = tree.findResizeTarget(win, orientation, grow);
        if (!node) node = tree.findResizeTarget(win, orientation, !grow);
        if (!node) return; // alone on this axis -- nothing to resize against

        const nodeRect = tree.rectOf(node);
        if (!nodeRect) return;

        const containerPx = isRow ? nodeRect.width : nodeRect.height;
        const step = RESIZE_STEP_PX / containerPx;
        const ratio = tree.ratioOf(node) + (grow ? step : -step);

        // No floor-clamp needed here either -- see the matching comment in
        // _onGrabBegin's 'size-changed' handler; computeRects() enforces it.
        tree.setRatio(node, ratio);
        this._layoutTree(tree, state.workspace, state.monitorIndex);
    }

    // Resolves "which monitor" a keybinding (switch/move virtual workspace)
    // applies to -- GNOME keybindings are global accelerator->callback pairs
    // with no per-monitor argument. Prefers the focused window's monitor
    // (matches i3's "currently focused output" convention); falls back to
    // pointer position for an empty desktop.
    _resolveMonitorForKeybinding() {
        const focused = global.display.get_focus_window();
        if (focused) return focused.get_monitor();
        return global.display.get_current_monitor();
    }

    _switchVirtualWorkspace(direction) {
        if (!this._virtualWorkspaces) return;
        const monitorIndex = this._resolveMonitorForKeybinding();
        if (direction > 0) this._virtualWorkspaces.switchNext(monitorIndex);
        else this._virtualWorkspaces.switchPrev(monitorIndex);
    }

    // Super+1..0: jump straight to a specific slot on the focused monitor,
    // if it exists yet -- unlike switchNext/switchPrev this never grows
    // capacity, since "go to workspace 5" on a monitor that only has 3 slots
    // has nothing sensible to jump to.
    _switchVirtualWorkspaceToIndex(requestedIndex) {
        if (!this._virtualWorkspaces) return;
        const monitorIndex = this._resolveMonitorForKeybinding();
        if (requestedIndex >= this._virtualWorkspaces.countFor(monitorIndex)) return;
        this._virtualWorkspaces.switchTo(monitorIndex, requestedIndex);
    }

    _moveFocusedWindowToVirtualWorkspace(direction) {
        if (!this._virtualWorkspaces) return;
        const win = global.display.get_focus_window();
        if (!win) return;
        const state = this._windowState.get(win);
        if (!state) return; // not tiled

        const count = this._virtualWorkspaces.countFor(state.monitorIndex);
        // No wraparound (matches switchNext/switchPrev) -- moving a window
        // past the first/last slot is just a no-op instead of cycling.
        const targetIndex = state.virtualWorkspaceIndex + direction;
        if (targetIndex < 0 || targetIndex >= count) return;

        this._moveWindowToVwsSlot(win, state, targetIndex);
    }

    // Super+Shift+1..0: move the focused window straight to a specific slot
    // on its own monitor. If that slot doesn't exist yet, land on the
    // trailing empty slot instead (the "next available workspace" -- it's
    // always present per VirtualWorkspaceManager's slot invariant, so no
    // growCapacity is needed here).
    _moveFocusedWindowToVirtualWorkspaceIndex(requestedIndex) {
        if (!this._virtualWorkspaces) return;
        const win = global.display.get_focus_window();
        if (!win) return;
        const state = this._windowState.get(win);
        if (!state) return; // not tiled

        const count = this._virtualWorkspaces.countFor(state.monitorIndex);
        const targetIndex = requestedIndex < count ? requestedIndex : count - 1;

        this._moveWindowToVwsSlot(win, state, targetIndex);
    }

    // Shared core of the two methods above: moves an already-tracked tiled
    // window from its current vws slot to `targetIndex` on the same
    // monitor, updating trees/bookkeeping and parking it if it landed
    // somewhere other than the monitor's active slot.
    _moveWindowToVwsSlot(win, state, targetIndex) {
        const monitorIndex = state.monitorIndex;
        const oldIndex = state.virtualWorkspaceIndex;
        if (targetIndex === oldIndex) return;

        const oldTree = this._treeFor(state.workspace, monitorIndex, oldIndex, false);
        if (oldTree) {
            oldTree.remove(win);
            this._layoutTree(oldTree, state.workspace, monitorIndex);
            // Discarding the vacated slot renumbers every slot above it --
            // including targetIndex itself, computed above against the
            // pre-discard count -- so correct for that shift before using
            // it below.
            if (this._virtualWorkspaces.maybeDiscardSlot(monitorIndex, oldIndex) && targetIndex > oldIndex)
                targetIndex -= 1;
        }

        state.virtualWorkspaceIndex = targetIndex;
        const newTree = this._treeFor(state.workspace, monitorIndex, targetIndex, true);
        newTree.insert(win, null);
        this._layoutTree(newTree, state.workspace, monitorIndex);
        this._virtualWorkspaces.ensureTrailingSlot(monitorIndex);

        // The window followed to its new slot -- park it if that slot isn't
        // the monitor's active one, matching how every other window in an
        // inactive slot is kept hidden.
        if (targetIndex !== this._virtualWorkspaces.activeIndexFor(monitorIndex))
            this._virtualWorkspaces.park(win);
    }

    _onFocusChanged() {
        this._focusedWindowSignals.forEach(({ obj, id }) => obj.disconnect(id));
        this._focusedWindowSignals = [];

        const win = global.display.get_focus_window();
        if (!win || win.windowType !== Meta.WindowType.NORMAL) {
            this._focusBorder.hide();
            return;
        }

        this._focusBorder.setCornerRadius(getCornerRadius(win.get_wm_class()));
        probeCornerRadius(win, radius => {
            if (!this._focusBorder || global.display.get_focus_window() !== win)
                return;
            this._focusBorder.setCornerRadius(radius);
            this._focusBorder.followRect(win.get_frame_rect());
        });

        const update = () => {
            const isMaximized = win.maximizedHorizontally && win.maximizedVertically;
            if (win.minimized || win.is_fullscreen() || isMaximized) {
                this._focusBorder.hide();
                return;
            }
            this._focusBorder.followRect(win.get_frame_rect());
            this._focusBorder.show();
        };

        this._focusedWindowSignals = [
            { obj: win, id: win.connect('position-changed', update) },
            { obj: win, id: win.connect('size-changed', update) },
            { obj: win, id: win.connect('unmanaging', () => this._onFocusChanged()) },
        ];

        update();
    }

    _treeFor(workspace, monitorIndex, vwsIndex, create) {
        if (!workspace) return null;
        let byMonitor = this._trees.get(workspace);
        if (!byMonitor) {
            if (!create) return null;
            byMonitor = new Map();
            this._trees.set(workspace, byMonitor);
        }
        let byVws = byMonitor.get(monitorIndex);
        if (!byVws) {
            if (!create) return null;
            byVws = new Map();
            byMonitor.set(monitorIndex, byVws);
        }
        let tree = byVws.get(vwsIndex);
        if (!tree) {
            if (!create) return null;
            tree = new BspTree();
            byVws.set(vwsIndex, tree);
        }
        return tree;
    }

    _layoutTree(tree, workspace, monitorIndex) {
        if (tree.isEmpty) return;

        const outer = this._settings.get_uint('outer-gaps');
        const inner = this._settings.get_uint('inner-gaps');
        const wa = workspace.get_work_area_for_monitor(monitorIndex);

        const rect = {
            x: wa.x + outer,
            y: wa.y + outer,
            width: wa.width - 2 * outer,
            height: wa.height - 2 * outer,
        };
        if (rect.width <= 0 || rect.height <= 0) return;

        const rects = tree.computeRects(rect);
        for (const [window, r] of rects) {
            if (window.maximizedHorizontally || window.maximizedVertically) continue;
            if (window === this._grabbedWindow) continue;
            if (window.minimized) {
                // A window WE parked into an inactive vws slot still needs
                // its geometry kept current -- otherwise it never benefits
                // from the deferred post-monitors-changed relayout pass
                // below (added to fix windows landing against a stale/
                // transitional work area), since that pass iterates every
                // tree via _relayoutAll and would otherwise skip it here
                // forever once minimized. A window the USER minimized
                // themselves (not us) is left alone -- resizing something
                // they chose to hide is surprising and unnecessary since
                // nothing is watching to correct it later anyway.
                const state = this._windowState.get(window);
                if (state?.hiddenByVirtualWorkspace !== true) continue;
            }

            const width = Math.max(1, Math.round(r.width - inner));
            const height = Math.max(1, Math.round(r.height - inner));
            const x = Math.round(r.x + (r.width - width) / 2);
            const y = Math.round(r.y + (r.height - height) / 2);

            // If a client can't actually honor this (a hard minimum content
            // size larger than its tile), Mutter/the client just clamps it
            // bigger than asked -- a minor visual overflow, not tracked or
            // corrected here. BspTree's floors are a flat, deterministic
            // MIN_SPLIT_PX with no per-window learning, so there's nothing
            // async to settle or reconcile after this call.
            window.move_resize_frame(false, x, y, width, height);
        }
    }

    _relayoutAll() {
        // Can race disable() when called from a deferred GLib.idle_add (e.g.
        // the post-monitors-changed settle pass) -- confirmed live 2026-08-26
        // via a logged "this._trees is null" TypeError when the screen
        // locked (session-mode switch to unlock-dialog, back when this
        // extension still lacked "unlock-dialog" in metadata.json's
        // session-modes and so got disabled on every lock) mid-flight.
        if (!this._trees) return;
        for (const [workspace, byMonitor] of this._trees) {
            for (const [monitorIndex, byVws] of byMonitor) {
                for (const tree of byVws.values())
                    this._layoutTree(tree, workspace, monitorIndex);
            }
        }
    }

    _rebuildAllTrees() {
        const previousState = this._windowState;
        for (const [window, state] of previousState)
            state.signalIds.forEach(id => window.disconnect(id));

        this._windowState = new Map();
        this._trees = new Map();

        // When per-monitor virtual workspaces are on, a monitor that just
        // disconnected leaves its windows' *new* get_monitor() pointing at
        // whatever monitor Mutter relocated them to (usually the primary).
        // Naively re-inserting them at that monitor's CURRENTLY ACTIVE slot
        // would dump everyone into one pile and destroy whatever grouping
        // they had, so instead give each distinct (old monitor, old vws
        // slot) combination that just landed on a new monitor its own fresh
        // trailing slot there -- the group stays together and stays
        // reachable by cycling, rather than being lost or scrambled.
        const reflowSlots = new Map(); // newMonitorIndex -> Map<"oldMonitor:oldVws", newVwsIndex>

        // Confirmed live (2026-08-26): comparing old vs. new connector alone
        // is NOT sufficient to detect a genuine disconnect. Plugging in a
        // second monitor can shift the whole arrangement (Mutter places a
        // freshly-connected display at a default position) so a window that
        // never moved suddenly geometrically overlaps a DIFFERENT monitor's
        // rect -- window.get_monitor() then reports a "new" connector for a
        // monitor that's still very much connected, which the old check
        // treated exactly like a real disconnect and parked the window into
        // a fresh hidden slot for no reason. Only trust a connector change
        // as a genuine relocation when the OLD connector has actually
        // dropped out of the current monitor list.
        const currentConnectors = new Set();
        if (this._virtualWorkspaces) {
            // Logical-monitor count, not the raw physical-monitor list's
            // length -- see connectorFor's own comment for why those can
            // differ (in principle; typically equal 1:1 absent mirroring).
            const monitorCount = global.backend.get_monitor_manager().get_logical_monitors().length;
            for (let m = 0; m < monitorCount; m++)
                currentConnectors.add(this._virtualWorkspaces.connectorFor(m));
        }

        for (const window of global.display.list_all_windows()) {
            // isTileableBase (inside isTileable) excludes minimized windows --
            // correct for a window the USER minimized, but a window WE
            // minimized to park it in an inactive vws slot is still fully
            // "ours" and must survive a rebuild. Without this exception it
            // silently drops out of _windowState/_trees entirely on the next
            // monitors-changed (of which there can be several in a row during
            // a flaky hotplug, confirmed live 2026-08-26) -- permanently
            // minimized, its slot then swept up as "empty" by reconcileMonitor
            // right after, with no signal handlers left to ever recover it.
            const oldForAdmission = previousState.get(window);
            const wasParkedByUs = this._virtualWorkspaces && oldForAdmission?.hiddenByVirtualWorkspace === true;
            if (!wasParkedByUs && !isTileable(window)) continue;

            const workspace = this._effectiveWorkspace(window);
            const monitorIndex = window.get_monitor();
            if (!workspace) continue;

            let vwsIndex = this._activeVwsIndex(monitorIndex);

            if (this._virtualWorkspaces) {
                const old = previousState.get(window);
                // Compare physical monitor identity (connector), not raw
                // index -- a monitors-changed reconfigure can reassign
                // indices (e.g. primary swaps, or one monitor's slot shifts
                // down when another disconnects) even for a window whose
                // physical monitor never changed. Only treat this as a real
                // relocation -- and give it a fresh trailing slot -- when
                // the connector itself differs (its old monitor is gone or
                // it's genuinely on a new one); otherwise let it fall
                // through to the current monitor's active slot below, same
                // as any other untouched window.
                const newConnector = this._virtualWorkspaces.connectorFor(monitorIndex);
                // connectorFor() falls back to a synthetic "index:N" identity
                // when Meta.Monitor.get_connector() is unavailable/throws --
                // that fallback is raw-index-based and therefore CAN legitimately
                // differ across a reconfigure for a monitor that never actually
                // moved (see connectorFor's own doc comment). Trusting it here
                // would misfire as a spurious relocation and park windows that
                // never left their monitor, so require a real connector string
                // on both sides before treating this as a genuine relocation.
                const bothRealConnectors = old && !String(old.monitorConnector).startsWith('index:')
                    && !String(newConnector).startsWith('index:');
                const oldMonitorStillConnected = old && currentConnectors.has(old.monitorConnector);
                const looksRelocated = old && old.monitorConnector !== null && old.monitorConnector !== newConnector;
                if (looksRelocated && !bothRealConnectors) {
                    debugLog('IGNORING relocation signal for', window.get_title?.() ?? '<window>',
                        '-- old connector', old.monitorConnector, 'new connector', newConnector,
                        '(at least one is a synthetic index-based fallback, not trustworthy across a reconfigure)');
                }
                if (looksRelocated && bothRealConnectors && oldMonitorStillConnected) {
                    debugLog('IGNORING relocation signal for', window.get_title?.() ?? '<window>',
                        '-- old connector', old.monitorConnector, 'is still connected; get_monitor() just',
                        'shifted due to an arrangement change, this is not a real relocation');
                }
                if (looksRelocated && bothRealConnectors && !oldMonitorStillConnected) {
                    debugLog('relocating', window.get_title?.() ?? '<window>', 'from', old.monitorConnector,
                        'slot', old.virtualWorkspaceIndex, 'to new monitor', newConnector, '(index', monitorIndex + ')');
                    let byOld = reflowSlots.get(monitorIndex);
                    if (!byOld) {
                        byOld = new Map();
                        reflowSlots.set(monitorIndex, byOld);
                    }
                    const oldKey = `${old.monitorConnector}:${old.virtualWorkspaceIndex}`;
                    let newSlot = byOld.get(oldKey);
                    if (newSlot === undefined) {
                        newSlot = this._virtualWorkspaces.growCapacity(monitorIndex);
                        byOld.set(oldKey, newSlot);
                    }
                    vwsIndex = newSlot;
                } else if (wasParkedByUs && old) {
                    // Not relocated (same monitor as before), but this window
                    // was deliberately parked in a specific NON-active slot --
                    // the default `vwsIndex = this._activeVwsIndex(monitorIndex)`
                    // above is only correct for a window that was actually
                    // visible (whose slot, being visible, must already BE the
                    // active one). Collapsing a parked window onto the active
                    // slot here would silently un-park it into whatever's
                    // currently showing. Preserve its real slot instead.
                    debugLog('preserving parked slot for', window.get_title?.() ?? '<window>',
                        '-- staying in slot', old.virtualWorkspaceIndex, 'on', old.monitorConnector,
                        'rather than collapsing onto the active slot', vwsIndex);
                    vwsIndex = old.virtualWorkspaceIndex;
                }
            }

            const tree = this._treeFor(workspace, monitorIndex, vwsIndex, true);
            tree.insert(window, null); // always spiral-fallback during a rebuild
            this._trackWindow(window, workspace, monitorIndex, vwsIndex);

            // Relayout BEFORE any park() below, not after -- primes lastRect
            // on the tree's leaves so the NEXT insert into this same tree
            // gets a real orientation decision instead of bspTree.js's
            // {width:1,height:1} fallback. Matches the order already used
            // by _moveFocusedWindowToVirtualWorkspace. On its own this
            // ordering wasn't sufficient to fix a relocated window showing
            // short/wide after an unplug -- see _layoutTree's own comment
            // on its minimized-window check for the other half of that fix,
            // live-verified together 2026-08-26.
            this._layoutTree(tree, workspace, monitorIndex);

            if (this._virtualWorkspaces && vwsIndex !== this._activeVwsIndex(monitorIndex)) {
                debugLog('parking', window.get_title?.() ?? '<window>', 'on monitor', monitorIndex,
                    '-- landed in slot', vwsIndex, 'but active slot is', this._activeVwsIndex(monitorIndex));
                this._virtualWorkspaces.park(window);
            }
        }

        if (this._virtualWorkspaces) {
            const monitorCount = global.backend.get_monitor_manager().get_logical_monitors().length;
            for (let m = 0; m < monitorCount; m++)
                this._virtualWorkspaces.reconcileMonitor(m);
        }
    }
}
