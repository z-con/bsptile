import St from 'gi://St';
import GObject from 'gi://GObject';

// A plain rectangle tracking the focused window's frame rect, drawn just
// outside it. St.Widget's normal theme-node painting already renders CSS
// border/border-radius, so no custom Cairo drawing is needed for this.
// GNOME/libadwaita's default CSD window corner radius, measured empirically
// (pixel-scanned a live, unmaximized window's actual rendered corner).
const WINDOW_CORNER_RADIUS = 12;

export const FocusBorder = GObject.registerClass(
class FocusBorder extends St.Widget {
    _init(borderWidth) {
        super._init({ reactive: false, can_focus: false });
        this._borderWidth = borderWidth;
        // The border rect is drawn borderWidth px larger than the window on
        // every edge (see followRect), so its own radius needs to be the
        // window's radius plus that offset -- otherwise the ring traces a
        // tighter curve than the window underneath and looks uneven/mismatched
        // at the corners instead of a uniform-width outline.
        this.set_style(
            `border: ${borderWidth}px solid -st-accent-color; border-radius: ${WINDOW_CORNER_RADIUS + borderWidth}px; background-color: transparent;`
        );
        this.hide();
    }

    followRect(rect) {
        const bw = this._borderWidth;
        this.set_position(rect.x - bw, rect.y - bw);
        this.set_size(rect.width + 2 * bw, rect.height + 2 * bw);
    }
});
