import GLib from 'gi://GLib';

// See the matching debugLog in extension.js -- same marker, same
// journalctl grep, kept as a plain duplicate here rather than a shared
// import to avoid coupling this module's public surface to extension.js
// just for logging.
function debugLog(...args) {
    log(`[bsptile-monitor] ${args.join(' ')}`);
}

// Every monitor starts with exactly one empty slot -- see maybeDiscardSlot/
// ensureTrailingSlot below for how the count grows and shrinks from there.
const INITIAL_SLOT_COUNT = 1;

// Simulates independent per-monitor workspace switching by minimizing/
// unminimizing windows, since Mutter's real global.workspaceManager has
// exactly one active-workspace index shared by every monitor -- there is no
// native way to have two monitors showing different "workspaces"
// simultaneously. Keyed by monitor CONNECTOR name (e.g. "eDP-1", "HDMI-1"),
// not raw monitor index, because Mutter can renumber indices across a
// monitors-changed reconfigure/replug and this bookkeeping needs to survive
// that renumbering intact.
//
// Slot count is fully dynamic, matching GNOME's own dynamic-workspaces UX
// but per monitor: there's always exactly one empty "next" slot past the
// last non-empty one (ensureTrailingSlot), and any empty slot that isn't
// the active one gets discarded, with higher slots renumbered down to keep
// indices contiguous (maybeDiscardSlot).
//
// This class only tracks which slot is active per monitor and which windows
// should be visible/hidden as a result -- it knows nothing about BSP trees
// or layout. extension.js supplies window lists via getWindowsInSlot and
// does its own tree bookkeeping in response, including reacting to
// onSlotDiscarded to keep its own per-slot state renumbered in lockstep.
export class VirtualWorkspaceManager {
    constructor({ getWindowsInSlot, markHidden, onActiveChanged, onSlotDiscarded }) {
        this._getWindowsInSlot = getWindowsInSlot;
        this._markHidden = markHidden;
        this._onActiveChanged = onActiveChanged;
        this._onSlotDiscarded = onSlotDiscarded;
        this._monitors = new Map(); // connector -> { activeIndex, count, lastFocused: Map<vwsIndex, Meta.Window> }
    }

    // Public: extension.js's _rebuildAllTrees also needs physical-monitor
    // identity (not raw index) to tell whether a window actually moved
    // monitors versus just got reindexed by a reconfigure.
    connectorFor(monitorIndex) {
        return this._connectorFor(monitorIndex);
    }

    _connectorFor(monitorIndex) {
        try {
            const monitors = global.backend.get_monitor_manager().get_monitors();
            const m = monitors[monitorIndex];
            if (m && typeof m.get_connector === 'function') return m.get_connector();
            debugLog('connectorFor(', monitorIndex, ') -- no usable Meta.Monitor at that index',
                '(monitors.length=', monitors.length, ') -- falling back to synthetic identity');
        } catch (e) {
            debugLog('connectorFor(', monitorIndex, ') -- get_connector() threw:', String(e),
                '-- falling back to synthetic identity');
        }
        return `index:${monitorIndex}`;
    }

    _stateFor(monitorIndex) {
        const connector = this._connectorFor(monitorIndex);
        let state = this._monitors.get(connector);
        if (!state) {
            state = { activeIndex: 0, count: INITIAL_SLOT_COUNT, lastFocused: new Map() };
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

    _isSlotEmpty(monitorIndex, vwsIndex) {
        return this._getWindowsInSlot(monitorIndex, vwsIndex).length === 0;
    }

    // Grows the slot count for one monitor by one and returns the index of
    // the new slot -- used when every existing slot is full and bsptile
    // needs somewhere new to spill a window into (mirrors how the pre-vws
    // code created a brand new real GNOME workspace in the same situation),
    // and when a disconnected monitor's windows need a fresh home on the
    // monitor they got relocated to (see extension.js's _rebuildAllTrees).
    // A distinct, lower-level primitive from ensureTrailingSlot below --
    // this one always grows, unconditionally. Fires onActiveChanged so the
    // indicator's dot row picks up the new count even though the active
    // index itself didn't move -- WorkspaceIndicator.update() reads count
    // fresh every call, so this doubles as the generic "repaint" signal.
    growCapacity(monitorIndex) {
        const state = this._stateFor(monitorIndex);
        state.count += 1;
        this._onActiveChanged?.(monitorIndex, state.activeIndex);
        return state.count - 1;
    }

    // Keeps exactly one empty "next" slot available past the last
    // non-empty one, matching GNOME's own dynamic-workspace UX -- call
    // after any insert so there's always somewhere fresh to switch into.
    // Idempotent: a no-op if the last slot is already empty.
    ensureTrailingSlot(monitorIndex) {
        const state = this._stateFor(monitorIndex);
        if (!this._isSlotEmpty(monitorIndex, state.count - 1))
            this.growCapacity(monitorIndex);
    }

    // Removes vwsIndex from monitorIndex's slots if it's empty and isn't
    // the active slot, renumbering every higher slot (and this monitor's
    // lastFocused bookkeeping) down by one to keep indices contiguous --
    // required for the indicator's dot row and the modulo arithmetic in
    // switchNext/switchPrev/growCapacity to keep making sense. Fires
    // onSlotDiscarded so extension.js can renumber its own tree/window-state
    // bookkeeping in lockstep before anything else observes the new
    // indices, then onActiveChanged to repaint the indicator with the new
    // count. Returns true if a discard happened.
    maybeDiscardSlot(monitorIndex, vwsIndex) {
        const state = this._stateFor(monitorIndex);
        if (vwsIndex < 0 || vwsIndex >= state.count) return false; // stale index
        if (vwsIndex === state.activeIndex) return false; // never discard the active slot
        if (state.count <= 1) return false; // always keep at least one slot
        if (!this._isSlotEmpty(monitorIndex, vwsIndex)) return false;

        const renumbered = new Map();
        for (const [i, win] of state.lastFocused) {
            if (i < vwsIndex) renumbered.set(i, win);
            else if (i > vwsIndex) renumbered.set(i - 1, win);
            // i === vwsIndex: the discarded slot's own entry, dropped
        }
        state.lastFocused = renumbered;

        state.count -= 1;
        if (state.activeIndex > vwsIndex) state.activeIndex -= 1;

        this._onSlotDiscarded?.(monitorIndex, vwsIndex);
        // Discarding the highest slot can leave the active slot -- if it
        // has a window -- as the new last slot with no reserve past it
        // (e.g. switching back from a just-abandoned empty preview slot to
        // an already-populated one). Restore the trailing-empty invariant
        // before the final repaint below.
        this.ensureTrailingSlot(monitorIndex);
        this._onActiveChanged?.(monitorIndex, state.activeIndex);
        return true;
    }

    // Full sweep used after a nuclear rebuild (monitors-changed) to bring a
    // monitor's slots back in line with the two standing invariants --
    // discard every empty non-active slot, then make sure a trailing empty
    // one exists.
    reconcileMonitor(monitorIndex) {
        const state = this._stateFor(monitorIndex);
        // Safety net, not expected to ever trigger: a prior version of this
        // loop had a genuine infinite-loop bug (fixed in 42753ab) that froze
        // GNOME Shell's main loop solid on every external-monitor unplug,
        // requiring a hard reboot. Cap the retry count so ANY future
        // regression here degrades to a logged bug instead of a repeat of
        // that freeze -- silently leaving a monitor's slots unreconciled is
        // a far better failure mode than hanging the compositor.
        const RETRY_BUDGET = state.count + 50;
        let retries = 0;
        for (let i = state.count - 1; i >= 0; i--) {
            // Discarding the topmost slot has nothing above it to shift
            // down -- maybeDiscardSlot's own ensureTrailingSlot call can
            // immediately manufacture a fresh empty slot back at this same
            // index (when the new last slot is non-empty), and retrying
            // would just discard-and-regrow that same index forever. Only
            // retry when a lower, non-top index shifts a higher slot's
            // (possibly non-empty) content down into it.
            const wasTop = i === state.count - 1;
            if (this.maybeDiscardSlot(monitorIndex, i) && !wasTop) {
                if (++retries > RETRY_BUDGET) {
                    logError(new Error(`bsptile: reconcileMonitor(${monitorIndex}) exceeded its retry budget ` +
                        `(${RETRY_BUDGET}) -- bailing out instead of hanging. This is a bug; slots may be ` +
                        `left unreconciled.`));
                    break;
                }
                i++; // recheck this index -- a higher slot just shifted into it
            }
        }
        this.ensureTrailingSlot(monitorIndex);
    }

    // No wraparound, by design -- the last slot is already always an empty
    // reserve (ensureTrailingSlot), so "next" past it would just be
    // wrapping to slot 0 for no reason.
    switchNext(monitorIndex) {
        const state = this._stateFor(monitorIndex);
        if (state.activeIndex + 1 >= state.count) return;
        this.switchTo(monitorIndex, state.activeIndex + 1);
    }

    switchPrev(monitorIndex) {
        const state = this._stateFor(monitorIndex);
        if (state.activeIndex === 0) return;
        this.switchTo(monitorIndex, state.activeIndex - 1);
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
        debugLog('switchTo(monitor', monitorIndex, ', slot', oldIndex, '->', newIndex, ') called from:',
            new Error().stack.split('\n').slice(1, 4).join(' | '));

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

        // The outgoing slot may now be empty and eligible for discard (e.g.
        // the user was just previewing a blank slot and left it untouched).
        // A discard can renumber every slot above it, including the one we
        // just switched to -- maybeDiscardSlot corrects state.activeIndex
        // itself when that happens and fires onActiveChanged with the
        // corrected value, so only fire it here ourselves when no discard
        // happened.
        if (!this.maybeDiscardSlot(monitorIndex, oldIndex))
            this._onActiveChanged?.(monitorIndex, state.activeIndex);

        const toFocus = state.lastFocused.get(state.activeIndex);
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
