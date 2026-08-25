import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WorkspaceIndicator } from './workspaceIndicator.js';

// Owns one WorkspaceIndicator per monitor, plus a lightweight background
// bar behind it on every non-primary monitor (the primary monitor already
// has a real GNOME panel to sit in). Not a full secondary-panel clone --
// no Activities-equivalent/clock/tray, just a strip matching the primary
// panel's own transparent styling, spanning the monitor's full width, with
// the indicator inside it. Registered with affectsStruts so tiling
// respects it the same way it already respects the real panel.
export class IndicatorManager {
    constructor(virtualWorkspaceManager, panelStyle) {
        this._vws = virtualWorkspaceManager;
        this._panelStyle = panelStyle;
        this._indicators = new Map();   // monitorIndex -> WorkspaceIndicator (for .update())
        this._chromeActors = new Map(); // monitorIndex -> the actor registered with addChrome (non-primary only)
        this.rebuild();
    }

    // Full destroy-and-recreate rather than incremental diffing -- monitor
    // INDICES can be reassigned to a different physical monitor across a
    // monitors-changed reconfigure (e.g. two monitors swapping which is
    // primary) with no addition/removal for an index-diff to catch, so a
    // full rebuild is the only way to guarantee an indicator never ends up
    // attached to the wrong monitor's position. Matches the same
    // nuclear-reset philosophy _rebuildAllTrees already uses for
    // monitors-changed elsewhere in this codebase.
    rebuild() {
        this.destroyAll();

        const monitors = Main.layoutManager.monitors;
        const primaryIndex = Main.layoutManager.primaryIndex;
        for (let i = 0; i < monitors.length; i++)
            this._createIndicator(i, i === primaryIndex, monitors[i]);
    }

    update(monitorIndex) {
        this._indicators.get(monitorIndex)?.update();
    }

    _createIndicator(monitorIndex, isPrimary, monitorRect) {
        const indicator = new WorkspaceIndicator(monitorIndex, this._vws);
        this._indicators.set(monitorIndex, indicator);

        if (isPrimary) {
            Main.panel._leftBox.insert_child_at_index(indicator, 0);
            return;
        }

        const bar = new St.BoxLayout({
            style: this._panelStyle,
            x: monitorRect.x,
            y: monitorRect.y,
            width: monitorRect.width,
            height: Main.panel.height,
        });
        bar.add_child(indicator);
        Main.layoutManager.addChrome(bar, { affectsStruts: true, trackFullscreen: true });
        this._chromeActors.set(monitorIndex, bar);
    }

    destroyAll() {
        for (const indicator of this._indicators.values()) {
            if (indicator.get_parent() === Main.panel._leftBox)
                Main.panel._leftBox.remove_child(indicator);
        }
        this._indicators.clear();

        for (const bar of this._chromeActors.values()) {
            Main.layoutManager.removeChrome(bar);
            bar.destroy(); // also destroys the indicator child added to it
        }
        this._chromeActors.clear();
    }
}
