import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BspTree } from './bspTree.js';
import { FocusBorder } from './windowBorder.js';

const FOCUS_BORDER_WIDTH = 2;
const PANEL_BACKGROUND_STYLE = 'background-color: rgba(19,19,19,0.6);';

const MIN_TILE_PX = 200;
const RESIZE_STEP_PX = 50;
const MIN_WINDOW_SCREEN_FRACTION = 0.25;

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

        let nearWindow = global.display.get_focus_window();
        if (nearWindow === window) nearWindow = null;

        tree.insert(window, nearWindow);
        this._trackWindow(window, workspace, monitorIndex);
        this._layoutTree(tree, workspace, monitorIndex);
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

        const targets = [];
        if (horizontal) {
            const node = tree.findResizeTarget(window, 'row', horizontal === 'E');
            if (node) targets.push({ node, axis: 'row' });
        }
        if (vertical) {
            const node = tree.findResizeTarget(window, 'col', vertical === 'S');
            if (node) targets.push({ node, axis: 'col' });
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
            for (const { node, axis } of targets) {
                const nodeRect = tree.rectOf(node);
                if (!nodeRect) continue;
                let ratio = axis === 'row'
                    ? ((horizontal === 'E' ? rect.x + rect.width + halfGap : rect.x - halfGap) - nodeRect.x) / nodeRect.width
                    : ((vertical === 'S' ? rect.y + rect.height + halfGap : rect.y - halfGap) - nodeRect.y) / nodeRect.height;
                // Keep both sides above a sane pixel floor -- ratio alone doesn't
                // know the container's absolute size, so a plain 5-95% clamp
                // still lets a split shrink a window below what it (or its
                // client, e.g. a terminal's minimum column count) can actually
                // honor, which desyncs the tree's ratio from the real on-screen
                // rect once Mutter/the client clamps it back up.
                const containerPx = axis === 'row' ? nodeRect.width : nodeRect.height;
                const minRatio = Math.min(0.45, MIN_TILE_PX / containerPx);
                ratio = Math.min(1 - minRatio, Math.max(minRatio, ratio));
                tree.setRatio(node, ratio);
            }
            this._grabbedWindow = window;
            this._layoutTree(tree, state.workspace, state.monitorIndex);
            this._grabbedWindow = null;
        });

        this._activeGrab = { window, sizeChangedId };
    }

    _onGrabEnd(window) {
        if (this._activeGrab && this._activeGrab.window === window) {
            window.disconnect(this._activeGrab.sizeChangedId);
            this._activeGrab = null;
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

        // Floor is 25% of the screen's own width/height, not 25% of this
        // node's (possibly already-subdivided) container -- so a window
        // never ends up narrower/shorter than a quarter of the monitor,
        // regardless of how deep in the tree its divider sits. _layoutTree
        // shaves a full inner-gap off the container's share to get the
        // window's actual rendered frame size, so that has to be added back
        // into the floor here -- otherwise the ratio-space floor is met but
        // the on-screen window still lands short of it by one gap.
        const wa = state.workspace.get_work_area_for_monitor(state.monitorIndex);
        const screenPx = isRow ? wa.width : wa.height;
        const containerPx = isRow ? nodeRect.width : nodeRect.height;
        const innerGap = this._settings.get_uint('inner-gaps');
        const minRatio = Math.min(0.45, (MIN_WINDOW_SCREEN_FRACTION * screenPx + innerGap) / containerPx);
        const step = RESIZE_STEP_PX / containerPx;
        const ratio = tree.ratioOf(node) + (grow ? step : -step);

        tree.setRatio(node, Math.min(1 - minRatio, Math.max(minRatio, ratio)));
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
            window.move_resize_frame(
                false,
                Math.round(r.x + inner / 2),
                Math.round(r.y + inner / 2),
                Math.max(1, Math.round(r.width - inner)),
                Math.max(1, Math.round(r.height - inner))
            );
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
