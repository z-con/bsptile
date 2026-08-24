import St from 'gi://St';
import GObject from 'gi://GObject';

// A plain rectangle tracking the focused window's frame rect, drawn just
// outside it. St.Widget's normal theme-node painting already renders CSS
// border/border-radius, so no custom Cairo drawing is needed for this.
export const FocusBorder = GObject.registerClass(
class FocusBorder extends St.Widget {
    _init(borderWidth) {
        super._init({ reactive: false, can_focus: false });
        this._borderWidth = borderWidth;
        this.set_style(
            `border: ${borderWidth}px solid -st-accent-color; border-radius: 8px; background-color: transparent;`
        );
        this.hide();
    }

    followRect(rect) {
        const bw = this._borderWidth;
        this.set_position(rect.x - bw, rect.y - bw);
        this.set_size(rect.width + 2 * bw, rect.height + 2 * bw);
    }
});
