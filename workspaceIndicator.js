import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

// Matches Ubuntu's default workspace-switcher styling: a row of small
// white dots, with the active one stretched into a pill -- rather than
// text glyphs (no real "pill" unicode character renders reliably across
// fonts), this is a row of plain St.Widget boxes, each just a colored
// rounded rectangle.
const DOT_SIZE = 8;
const PILL_WIDTH = 20;
const GAP = 5;

export const WorkspaceIndicator = GObject.registerClass(
class WorkspaceIndicator extends St.BoxLayout {
    _init(monitorIndex, virtualWorkspaceManager) {
        super._init({
            // Right margin so this doesn't sit flush against the Activities
            // button (or, on a non-primary monitor, whatever it's placed
            // next to) -- padding alone doesn't create space between
            // sibling widgets, only inside this one's own bounds.
            style: `padding: 0 8px; margin-right: 8px; spacing: ${GAP}px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._monitorIndex = monitorIndex;
        this._vws = virtualWorkspaceManager;
        this.update();
    }

    update() {
        const active = this._vws.activeIndexFor(this._monitorIndex);
        const count = this._vws.countFor(this._monitorIndex);

        // Rebuilt from scratch on every update rather than diffed -- this
        // only runs on an actual slot switch (not per-frame), and it's a
        // handful of tiny widgets, so the simplicity is worth more than
        // the marginal cost of a few extra allocations.
        this.destroy_all_children();
        for (let i = 0; i < count; i++) {
            const isActive = i === active;
            const dot = new St.Widget({ y_align: Clutter.ActorAlign.CENTER });
            dot.set_size(isActive ? PILL_WIDTH : DOT_SIZE, DOT_SIZE);
            dot.set_style(
                `background-color: rgba(255, 255, 255, ${isActive ? 1 : 0.5}); ` +
                `border-radius: ${DOT_SIZE / 2}px;`
            );
            this.add_child(dot);
        }
    }
});
