import Clutter from 'gi://Clutter';

// Drives per-monitor virtual-workspace switching from a 5-button mouse's
// side buttons (the MX Master's included) -- X11/Wayland convention maps
// BTN_SIDE -> button 8 ("back") and BTN_EXTRA -> button 9 ("forward") at
// the libinput/compositor level, no udev/xmodmap remapping needed.
// Captured stage-wide, before any app sees the event -- this takes those
// buttons away from per-app back/forward navigation (e.g. a browser)
// while the feature is on, the same trade the touchpad swipe gesture
// already makes for its own input.
export class MouseButtonSwitcher {
    constructor(virtualWorkspaceManager) {
        this._vws = virtualWorkspaceManager;
        this._id = global.stage.connect('captured-event', this._onEvent.bind(this));
    }

    _onEvent(actor, event) {
        if (event.type() !== Clutter.EventType.BUTTON_PRESS)
            return Clutter.EVENT_PROPAGATE;

        const button = event.get_button();
        if (button !== 8 && button !== 9)
            return Clutter.EVENT_PROPAGATE;

        // The click just happened, so the pointer is still exactly where
        // it landed -- same "which monitor" primitive already used as the
        // empty-desktop fallback for the keybinding path.
        const monitorIndex = global.display.get_current_monitor();
        if (button === 8) this._vws.switchPrev(monitorIndex);
        else this._vws.switchNext(monitorIndex);

        return Clutter.EVENT_STOP;
    }

    destroy() {
        global.stage.disconnect(this._id);
    }
}
