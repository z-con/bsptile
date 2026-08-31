import St from 'gi://St';
import GObject from 'gi://GObject';
import { WINDOW_CORNER_RADIUS } from './cornerEffect.js';

// A plain rectangle tracking the focused window's frame rect, drawn just
// outside it. St.Widget's normal theme-node painting already renders CSS
// border/border-radius, so no custom Cairo drawing is needed for this.
export const FocusBorder = GObject.registerClass(
class FocusBorder extends St.Widget {
    _init(borderWidth) {
        super._init({ reactive: false, can_focus: false });
        this._borderWidth = borderWidth;
        this._windowCornerRadius = WINDOW_CORNER_RADIUS;
        this._updateStyle();
        this.hide();
    }

    // The border rect is drawn borderWidth px larger than the window on
    // every edge (see followRect), so its own radius needs to be the
    // window's radius plus that offset -- otherwise the ring traces a
    // tighter curve than the window underneath and looks uneven/mismatched
    // at the corners instead of a uniform-width outline. Every window is
    // forced to the same WINDOW_CORNER_RADIUS by cornerEffect.js, so in
    // practice this is always called with that one constant -- kept as a
    // setter rather than hardcoded so the border widget itself doesn't need
    // to know about that constant or import cornerEffect.js.
    setCornerRadius(windowCornerRadius) {
        if (windowCornerRadius === this._windowCornerRadius)
            return;
        this._windowCornerRadius = windowCornerRadius;
        this._updateStyle();
    }

    _updateStyle() {
        const bw = this._borderWidth;
        // The ring is drawn bw px larger than the window on every edge (see
        // followRect), so a plain bw-wide stroke's inner edge lands exactly
        // on the window's real edge -- no inset needed now that every
        // window's actual corner is forced to windowCornerRadius by
        // cornerEffect.js rather than measured per app. (An earlier,
        // now-removed approach tried to compensate for each app's own,
        // possibly-halo-fringed native rendering with a per-app inset
        // margin here; that whole mechanism is gone along with
        // cornerRadius.js's alpha probe -- see extension.js.)
        this.set_style(
            `border: ${bw}px solid -st-accent-color; border-radius: ${this._windowCornerRadius + bw}px; background-color: transparent;`
        );
    }

    followRect(rect) {
        const bw = this._borderWidth;
        this.set_position(rect.x - bw, rect.y - bw);
        this.set_size(rect.width + 2 * bw, rect.height + 2 * bw);
    }
});
