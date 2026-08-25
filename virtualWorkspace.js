import GLib from 'gi://GLib';

// Simulates independent per-monitor workspace switching by minimizing/
// unminimizing windows, since Mutter's real global.workspaceManager has
// exactly one active-workspace index shared by every monitor -- there is no
// native way to have two monitors showing different "workspaces"
// simultaneously. Keyed by monitor CONNECTOR name (e.g. "eDP-1", "HDMI-1"),
// not raw monitor index, because Mutter can renumber indices across a
// monitors-changed reconfigure/replug and this bookkeeping needs to survive
// that renumbering intact.
//
// This class only tracks which slot is active per monitor and which windows
// should be visible/hidden as a result -- it knows nothing about BSP trees
// or layout. extension.js supplies window lists via getWindowsInSlot and
// does its own tree bookkeeping in response.
export class VirtualWorkspaceManager {
    constructor({ workspacesPerMonitor, getWindowsInSlot, markHidden, onActiveChanged }) {
        this._defaultCount = workspacesPerMonitor;
        this._getWindowsInSlot = getWindowsInSlot;
        this._markHidden = markHidden;
        this._onActiveChanged = onActiveChanged;
        this._monitors = new Map(); // connector -> { activeIndex, count, lastFocused: Map<vwsIndex, Meta.Window> }
    }

    setDefaultWorkspacesPerMonitor(n) {
        this._defaultCount = n;
    }

    _connectorFor(monitorIndex) {
        try {
            const monitors = global.backend.get_monitor_manager().get_monitors();
            const m = monitors[monitorIndex];
            if (m && typeof m.get_connector === 'function') return m.get_connector();
        } catch (e) {
            // fall through to the positional fallback below
        }
        return `index:${monitorIndex}`;
    }

    _stateFor(monitorIndex) {
        const connector = this._connectorFor(monitorIndex);
        let state = this._monitors.get(connector);
        if (!state) {
            state = { activeIndex: 0, count: this._defaultCount, lastFocused: new Map() };
            this._monitors.set(connector, state);
        }
        return state;
    }

    activeIndexFor(monitorIndex) {
        return this._stateFor(monitorIndex).activeIndex;
    }

    countFor(monitorIndex) {
        return this._stateFor(monitorIndex).count;
    }

    // Grows the slot count for one monitor by one and returns the index of
    // the new slot -- used when every existing slot is full and bsptile
    // needs somewhere new to spill a window into (mirrors how the pre-vws
    // code created a brand new real GNOME workspace in the same situation),
    // and when a disconnected monitor's windows need a fresh home on the
    // monitor they got relocated to (see extension.js's _rebuildAllTrees).
    growCapacity(monitorIndex) {
        const state = this._stateFor(monitorIndex);
        state.count += 1;
        return state.count - 1;
    }

    switchNext(monitorIndex) {
        const state = this._stateFor(monitorIndex);
        this.switchTo(monitorIndex, (state.activeIndex + 1) % state.count);
    }

    switchPrev(monitorIndex) {
        const state = this._stateFor(monitorIndex);
        this.switchTo(monitorIndex, (state.activeIndex - 1 + state.count) % state.count);
    }

    // Makes `newIndex` the active slot on `monitorIndex`: parks every window
    // in the outgoing slot, unparks every window in the incoming slot, and
    // reasserts focus on whatever was last focused there. `except` is a
    // window to leave alone in both passes -- used by promoteSlot() for a
    // window that's already visible (the user just unminimized it
    // themselves) so it isn't parked-then-unparked pointlessly.
    switchTo(monitorIndex, newIndex, { except = null } = {}) {
        const state = this._stateFor(monitorIndex);
        const oldIndex = state.activeIndex;
        if (newIndex === oldIndex) return;

        const focused = global.display.get_focus_window();
        if (focused && focused.get_monitor() === monitorIndex)
            state.lastFocused.set(oldIndex, focused);

        for (const win of this._getWindowsInSlot(monitorIndex, oldIndex)) {
            if (win !== except) this.park(win);
        }
        for (const win of this._getWindowsInSlot(monitorIndex, newIndex)) {
            if (win !== except) this.unpark(win);
        }

        state.activeIndex = newIndex;
        this._onActiveChanged?.(monitorIndex, newIndex);

        const toFocus = state.lastFocused.get(newIndex);
        if (toFocus && !toFocus.minimized) {
            const activate = () => toFocus.activate(global.get_current_time());
            activate();
            // Focus-follows-mouse can silently reclaim focus a moment later
            // (same race already worked around in extension.js's
            // _insertWindow) -- reassert once more after it settles.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                if (!toFocus.minimized) activate();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // Called when a window bsptile parked (hiddenByVirtualWorkspace) gets
    // unminimized through some path other than this class's own unpark()
    // (e.g. the user clicked it in a dock or the Overview). Treated as
    // "make this window's slot the active one on its monitor" -- the
    // closest sane behavior achievable with GNOME's real primitives. This
    // is a heuristic, not a guarantee (see README known limitations).
    promoteSlot(monitorIndex, vwsIndex, alreadyVisibleWindow) {
        this.switchTo(monitorIndex, vwsIndex, { except: alreadyVisibleWindow });
    }

    park(win) {
        if (win.minimized) return;
        this._markHidden(win, true);
        win.minimize();
    }

    unpark(win) {
        if (!win.minimized) return;
        // Clear the flag *before* unminimizing so extension.js's
        // notify::minimized listener sees hiddenByVirtualWorkspace already
        // false and knows this transition was caused by us, not the user.
        this._markHidden(win, false);
        win.unminimize();
    }

    destroy() {
        this._monitors.clear();
    }
}
