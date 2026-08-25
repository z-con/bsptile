import St from 'gi://St';
import GObject from 'gi://GObject';
import { DEFAULT_CORNER_RADIUS } from './cornerRadius.js';

// A plain rectangle tracking the focused window's frame rect, drawn just
// outside it. St.Widget's normal theme-node painting already renders CSS
// border/border-radius, so no custom Cairo drawing is needed for this.
export const FocusBorder = GObject.registerClass(
class FocusBorder extends St.Widget {
    _init(borderWidth) {
        super._init({ reactive: false, can_focus: false });
        this._borderWidth = borderWidth;
        this._windowCornerRadius = DEFAULT_CORNER_RADIUS;
        this._updateStyle();
        this.hide();
    }

    // The border rect is drawn borderWidth px larger than the window on
    // every edge (see followRect), so its own radius needs to be the
    // window's radius plus that offset -- otherwise the ring traces a
    // tighter curve than the window underneath and looks uneven/mismatched
    // at the corners instead of a uniform-width outline. The window's own
    // radius isn't one constant -- different toolkits/themes bake different
    // corner radii into their CSD buffers (see cornerRadius.js) -- so this
    // is set dynamically per focused window rather than assumed.
    setCornerRadius(windowCornerRadius) {
        if (windowCornerRadius === this._windowCornerRadius)
            return;
        this._windowCornerRadius = windowCornerRadius;
        this._updateStyle();
    }

    _updateStyle() {
        const bw = this._borderWidth;
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
