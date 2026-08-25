import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { SwipeTracker } from 'resource:///org/gnome/shell/ui/swipeTracker.js';

// Drives per-monitor virtual-workspace switching from a touchpad swipe,
// standing in for GNOME's native workspace-switch gesture (which
// extension.js disables while this is active, via
// Main.wm._workspaceAnimation._swipeTracker.enabled = false).
//
// Modeled directly on GNOME's own WorkspaceAnimationController
// (resource:///org/gnome/shell/ui/workspaceAnimation.js, read live off this
// machine's GNOME Shell 50.1): same SwipeTracker construction (attached to
// global.stage, CAPTURE phase, no drag) and the same
// confirmSwipe()/begin/end protocol its own native handler uses --
// 'begin' hands us the monitor index the swipe started on directly, no
// pointer-position guessing needed. Unlike the native version we don't
// drive a live sliding-window animation from 'update' -- there's no second
// real GNOME workspace to visually slide to -- just a 3-point discrete
// swipe (prev / stay / next), decided once from the final snapped point
// on 'end'.
const SWIPE_DISTANCE = 400; // px for one full swipe step; tune if it feels off

export class GestureSwitcher {
    constructor(virtualWorkspaceManager) {
        this._vws = virtualWorkspaceManager;
        this._monitorIndex = null;

        this._tracker = new SwipeTracker(
            global.stage,
            Clutter.Orientation.HORIZONTAL,
            Shell.ActionMode.NORMAL,
            {
                allowDrag: false,
                phase: Clutter.EventPhase.CAPTURE,
                name: 'bsptile virtual workspace swipe tracker',
            }
        );
        this._beginId = this._tracker.connect('begin', this._onBegin.bind(this));
        this._endId = this._tracker.connect('end', this._onEnd.bind(this));

        // Same as the native controller: don't fight the Overview's own
        // gesture handling while it's open.
        this._overviewShowingId = Main.overview.connect('showing', () => {
            this._tracker.enabled = false;
        });
        this._overviewHidingId = Main.overview.connect('hiding', () => {
            this._tracker.enabled = true;
        });
    }

    _onBegin(tracker, monitorIndex) {
        this._monitorIndex = monitorIndex;
        // Three snap points: -1 (prev), 0 (stay), 1 (next) -- same
        // (distance, points, currentProgress, cancelProgress) signature
        // GNOME's own _switchWorkspaceBegin calls confirmSwipe with.
        tracker.confirmSwipe(SWIPE_DISTANCE, [-1, 0, 1], 0, 0);
    }

    _onEnd(tracker, duration, endProgress) {
        // Confirmed backwards live: a swipe landing at progress +1 is the
        // "previous" direction, not "next", by this SwipeTracker's sign
        // convention -- so the mapping is inverted from what the
        // (distance, points, ...) naming would suggest.
        const snapped = Math.round(endProgress);
        if (snapped === 1) this._vws.switchPrev(this._monitorIndex);
        else if (snapped === -1) this._vws.switchNext(this._monitorIndex);
        // snapped === 0: cancelled/returned to start -- nothing to do.
    }

    destroy() {
        this._tracker.disconnect(this._beginId);
        this._tracker.disconnect(this._endId);
        Main.overview.disconnect(this._overviewShowingId);
        Main.overview.disconnect(this._overviewHidingId);
        this._tracker.enabled = false;
        this._tracker = null;
    }
}
