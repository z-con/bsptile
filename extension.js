import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BspTree } from './bspTree.js';
import { FocusBorder } from './windowBorder.js';

const FOCUS_BORDER_WIDTH = 2;
const PANEL_BACKGROUND_STYLE = 'background-color: rgba(19,19,19,0.6);';

const RESIZE_STEP_PX = 50;

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

function isTileable(window) {
    if (!window) return false;
    if (window.windowType !== Meta.WindowType.NORMAL) return false;
    if (window.get_transient_for() !== null) return false;
    if (window.is_attached_dialog()) return false;
    if (window.minimized) return false;
    if (window.maximizedHorizontally || window.maximizedVertically) return false;
    if (window.is_fullscreen()) return false;
    return true;
}

export default class BspTileExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._trees = new Map();        // Meta.Workspace -> Map<monitorIndex, BspTree>
        this._windowState = new Map();  // Meta.Window -> { signalIds, workspace, monitorIndex }
        this._globalSignals = [];       // [{obj, id}]
        this._grabbedWindow = null;     // window currently being live-dragged; skip it in _layoutTree
        this._activeGrab = null;        // { window, sizeChangedId } while a resize grab is in progress
        this._panelStyleTimeoutId = null;

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

        const start = () => {
            Main.panel.set_style(PANEL_BACKGROUND_STYLE);
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
                    return GLib.SOURCE_REMOVE;
                });
            });
            this._globalSignals.push({ obj: Main.overview, id: overviewHiddenId });
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
        this._settings = null;
        this._grabbedWindow = null;
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
        conn(Main.layoutManager, 'monitors-changed', () => this._rebuildAllTrees());
        conn(this._settings, 'changed::inner-gaps', () => this._relayoutAll());
        conn(this._settings, 'changed::outer-gaps', () => this._relayoutAll());
    }

    _onWindowCreated(window) {
        if (!isTileable(window)) return; // cheap pre-check; state may still change before first-frame

        const actor = window.get_compositor_private();
        if (!actor) return;

        const firstFrameId = actor.connect('first-frame', () => {
            actor.disconnect(firstFrameId);
            if (!isTileable(window)) return; // re-check: app may have maximized/minimized itself by now
            this._insertWindow(window);
        });
    }

    _insertWindow(window) {
        const workspace = window.get_workspace();
        const monitorIndex = window.get_monitor();
        if (!workspace) return;

        const tree = this._treeFor(workspace, monitorIndex, true);
        if (tree.has(window)) return;

        // This monitor's tree is already as full as it can get without
        // forcing some window below its real minimum size (that's what was
        // producing the overlap during the stress test). Spill over to the
        // next workspace instead of cramming it in -- try each workspace
        // after this one in turn, then fall back to creating a fresh one.
        if (!tree.hasCapacity()) {
            const target = this._findWorkspaceWithCapacity(monitorIndex, workspace);
            if (target !== workspace) {
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
                    window.change_workspace(target);
                    target.activate(global.get_current_time());
                    this._finishInsert(window, target, monitorIndex);
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            // else: out of workspaces to try (dynamic workspaces disabled
            // and every existing one is full) -- fall through and tile into
            // the original tree anyway, same as before this change.
        }

        this._finishInsert(window, workspace, monitorIndex);
    }

    _finishInsert(window, workspace, monitorIndex) {
        const tree = this._treeFor(workspace, monitorIndex, true);
        if (tree.has(window)) return;

        let nearWindow = global.display.get_focus_window();
        if (nearWindow === window) nearWindow = null;

        tree.insert(window, nearWindow);
        this._trackWindow(window, workspace, monitorIndex);
        this._layoutTree(tree, workspace, monitorIndex);
    }

    // Looks for the first workspace after `fromWorkspace` (same monitor)
    // whose tree still has room for one more compliant split, creating a
    // new workspace at the end if none of the existing ones qualify. Doesn't
    // touch `fromWorkspace` itself -- the caller only gets here because that
    // one is already full. Returns `fromWorkspace` unchanged if dynamic
    // workspaces are off and there's truly nowhere else to put it.
    _findWorkspaceWithCapacity(monitorIndex, fromWorkspace) {
        const wm = global.workspaceManager;
        const n = wm.get_n_workspaces();
        for (let i = fromWorkspace.index() + 1; i < n; i++) {
            const ws = wm.get_workspace_by_index(i);
            const tree = this._treeFor(ws, monitorIndex, false);
            if (!tree || tree.hasCapacity()) return ws;
        }

        const created = wm.append_new_workspace(false, global.get_current_time());
        if (wm.get_n_workspaces() > n) return created;
        return fromWorkspace;
    }

    // Wires up everything a tiled window needs for as long as it stays
    // tracked: removal on close, and migration-detection so a window
    // dragged to another workspace/monitor (via keybinding or drag) moves
    // between trees instead of staying stuck in its original one, invisibly
    // laid out on a workspace it's no longer even on.
    _trackWindow(window, workspace, monitorIndex) {
        const signalIds = [
            window.connect('unmanaging', () => this._onWindowRemoved(window)),
            window.connect('workspace-changed', () => this._checkWindowMigration(window)),
            window.connect('position-changed', () => this._checkWindowMigration(window)),
        ];
        this._windowState.set(window, { signalIds, workspace, monitorIndex });
    }

    _untrackWindow(window) {
        const state = this._windowState.get(window);
        if (!state) return null;
        state.signalIds.forEach(id => window.disconnect(id));
        this._windowState.delete(window);
        return state;
    }

    _onWindowRemoved(window) {
        const state = this._untrackWindow(window);
        if (!state) return;

        // Remove from the tree it was actually inserted into, not wherever
        // get_workspace()/get_monitor() say *now* -- avoids leaking a phantom
        // leaf if _checkWindowMigration hasn't caught up yet for some reason.
        const tree = this._treeFor(state.workspace, state.monitorIndex, false);
        if (!tree) return;
        tree.remove(window);
        this._layoutTree(tree, state.workspace, state.monitorIndex);
    }

    _checkWindowMigration(window) {
        const state = this._windowState.get(window);
        if (!state) return;

        const newWorkspace = window.get_workspace();
        const newMonitor = window.get_monitor();
        if (newWorkspace === state.workspace && newMonitor === state.monitorIndex) return;

        const oldTree = this._treeFor(state.workspace, state.monitorIndex, false);
        if (oldTree) {
            oldTree.remove(window);
            this._layoutTree(oldTree, state.workspace, state.monitorIndex);
        }

        if (!newWorkspace) {
            // No workspace (e.g. stuck-to-all-workspaces) -- nothing sane to
            // tile it into; drop tracking rather than leave stale state.
            this._untrackWindow(window);
            return;
        }

        state.workspace = newWorkspace;
        state.monitorIndex = newMonitor;

        const newTree = this._treeFor(newWorkspace, newMonitor, true);
        let nearWindow = global.display.get_focus_window();
        if (nearWindow === window) nearWindow = null;
        newTree.insert(window, nearWindow);
        this._layoutTree(newTree, newWorkspace, newMonitor);
    }

    _onGrabBegin(window, grabOp) {
        const { horizontal, vertical } = resizeSidesFromGrabOp(grabOp);
        if (!horizontal && !vertical) return; // a move, or some other grab op we don't care about

        const state = this._windowState.get(window);
        if (!state) return;
        const tree = this._treeFor(state.workspace, state.monitorIndex, false);
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
        if (this._activeGrab && this._activeGrab.window === window) {
            window.disconnect(this._activeGrab.sizeChangedId);
            this._activeGrab = null;

            // While the drag was live, _layoutTree skipped its clamp check
            // on every tick (sizes were expected to be in flux). The sibling
            // leaves it resized as a side effect of the ratio change are
            // done moving now, so run one real pass to catch a sibling that
            // got clamped smaller than the drag's math intended.
            const state = this._windowState.get(window);
            const tree = state && this._treeFor(state.workspace, state.monitorIndex, false);
            if (tree) this._layoutTree(tree, state.workspace, state.monitorIndex);
        }
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
            win.unmaximize(Meta.MaximizeFlags.BOTH);
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

        const tree = this._treeFor(state.workspace, state.monitorIndex, false);
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

    _onFocusChanged() {
        this._focusedWindowSignals.forEach(({ obj, id }) => obj.disconnect(id));
        this._focusedWindowSignals = [];

        const win = global.display.get_focus_window();
        if (!win || win.windowType !== Meta.WindowType.NORMAL) {
            this._focusBorder.hide();
            return;
        }

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

    _treeFor(workspace, monitorIndex, create) {
        if (!workspace) return null;
        let byMonitor = this._trees.get(workspace);
        if (!byMonitor) {
            if (!create) return null;
            byMonitor = new Map();
            this._trees.set(workspace, byMonitor);
        }
        let tree = byMonitor.get(monitorIndex);
        if (!tree) {
            if (!create) return null;
            tree = new BspTree();
            byMonitor.set(monitorIndex, tree);
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
            if (window.minimized || window.maximizedHorizontally || window.maximizedVertically)
                continue;
            if (window === this._grabbedWindow) continue;

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
        for (const [workspace, byMonitor] of this._trees) {
            for (const [monitorIndex, tree] of byMonitor)
                this._layoutTree(tree, workspace, monitorIndex);
        }
    }

    _rebuildAllTrees() {
        for (const [window, state] of this._windowState)
            state.signalIds.forEach(id => window.disconnect(id));

        this._windowState = new Map();
        this._trees = new Map();

        for (const window of global.display.list_all_windows()) {
            if (!isTileable(window)) continue;

            const workspace = window.get_workspace();
            const monitorIndex = window.get_monitor();
            if (!workspace) continue;

            const tree = this._treeFor(workspace, monitorIndex, true);
            tree.insert(window, null); // always spiral-fallback during a rebuild
            this._trackWindow(window, workspace, monitorIndex);

            // Relayout immediately -- primes lastRect on the tree's leaves so
            // the NEXT insert into this same tree gets a real orientation
            // decision instead of bspTree.js's {width:1,height:1} fallback.
            this._layoutTree(tree, workspace, monitorIndex);
        }
    }
}
