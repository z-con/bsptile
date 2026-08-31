import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

// Every window gets forced to this exact radius (see the comment on
// applyRoundedCorners in extension.js for why). Matches libadwaita/GTK4's
// own default window corner radius at 1x scale, so windows that already
// draw rounded CSD corners natively (Zen/Firefox, GTK4 apps) look
// unchanged, while ones that don't (Ghostty, X11/GTK3 apps) gain one to
// match everything else on the desktop.
export const WINDOW_CORNER_RADIUS = 12;

// GLSL rounded-rect clip: for a fragment at `pos` (actor-local pixels),
// find the nearest point on the "deflated" clip rect (inset by radius on
// every side) and measure distance to it -- inside that inset rect the
// distance is 0 (straight sides/interior), so coverage is 1; near a corner
// it's the distance to that corner's circle center, smoothed over ~1px for
// antialiasing; outside the clip rect entirely, coverage is 0. `straight`
// bypasses the rounding (but not the clip) for maximized/fullscreen
// windows, which should sit flush against the screen edge with square
// corners like every other tiled window's edge.
//
// The clip rect (clipX/Y/W/H) is NOT the same as the actor's own
// width/height -- see the comment on _syncUniforms below for why a window
// actor's buffer is typically padded well past its visible frame, and
// clipping against the raw actor bounds (an earlier version of this file's
// bug, caught live via a visible corner mismatch on Ghostty specifically)
// silently rounds a patch of already-invisible padding instead of the
// window's real edge.
const SHADER_SOURCE = `
uniform sampler2D tex;
uniform float radius;
uniform float width;
uniform float height;
uniform float straight;
uniform float clipX;
uniform float clipY;
uniform float clipW;
uniform float clipH;

float rounded_rect_coverage(vec2 pos, float r) {
    if (pos.x < clipX || pos.x > clipX + clipW || pos.y < clipY || pos.y > clipY + clipH)
        return 0.0;
    if (straight > 0.5 || r <= 0.0)
        return 1.0;
    vec2 lo = vec2(clipX + r, clipY + r);
    vec2 hi = vec2(clipX + clipW - r, clipY + clipH - r);
    vec2 corner_center = clamp(pos, lo, hi);
    float dist = length(pos - corner_center);
    return 1.0 - smoothstep(r - 0.5, r + 0.5, dist);
}

void main(void) {
    vec2 uv = cogl_tex_coord_in[0].xy;
    vec4 c = texture2D(tex, uv);
    vec2 pos = uv * vec2(width, height);
    float coverage = rounded_rect_coverage(pos, radius);
    cogl_color_out = vec4(c.rgb * coverage, c.a * coverage);
}
`;

// Clips a window actor's rendered content to a rounded rectangle. This
// replaces cornerRadius.js's old approach entirely: rather than
// screenshotting each app and reverse-engineering whatever corner radius
// (and, for apps with a soft drop-shadow halo like Zen's GTK4 CSD, however
// much halo bleeds past it) its own rendering happens to use, every
// window is forcibly clipped to the SAME known radius here, and
// windowBorder.js's ring is drawn at that same constant -- the two are
// guaranteed to match because both come from one shared number, not from
// independently measuring one and eyeballing the other.
export const RoundedCornersEffect = GObject.registerClass({
    GTypeName: 'BspTileRoundedCornersEffect',
    Properties: {
        'radius': GObject.ParamSpec.double(
            'radius', 'radius', 'radius',
            GObject.ParamFlags.READWRITE, 0, 512, WINDOW_CORNER_RADIUS),
        'straight': GObject.ParamSpec.boolean(
            'straight', 'straight', 'straight',
            GObject.ParamFlags.READWRITE, false),
    },
}, class RoundedCornersEffect extends Clutter.ShaderEffect {
    // `window` is the Meta.Window this effect is clipping -- needed (see
    // _syncUniforms) to find the real visible frame within the actor's
    // padded buffer. Not a GObject property (just a plain reference held
    // for the life of the effect), so it's pulled out of params before
    // delegating the rest to Clutter.ShaderEffect's own construction.
    _init({ window, ...params }) {
        super._init(params);
        this._window = window;
        this.set_shader_source(SHADER_SOURCE);
        this._syncUniforms();
    }

    get radius() { return this._radius ?? WINDOW_CORNER_RADIUS; }
    set radius(v) {
        if (v === this._radius) return;
        this._radius = v;
        this._setFloatUniform('radius', v);
        this.queue_repaint();
    }

    get straight() { return this._straight ?? false; }
    set straight(v) {
        if (v === this._straight) return;
        this._straight = v;
        // A GLSL `bool` uniform silently fails to update via
        // set_uniform_value with a raw JS boolean (confirmed live) -- use a
        // float in [0,1] instead, same as the shader declares it. Also
        // confirmed live: this needs an explicit queue_repaint() after the
        // uniform write, unlike `radius`/on construction, or the actor
        // keeps showing the last-painted frame until something unrelated
        // forces a repaint.
        this._setFloatUniform('straight', v ? 1.0 : 0.0);
        this.queue_repaint();
    }

    // Clutter.ShaderEffect.set_uniform_value's real GI signature takes a
    // GObject.Value, not a bare number -- confirmed via introspection
    // (PyGObject's help() on this machine's GJS/Clutter build, gjs 1.88.0)
    // after finding live that every set_uniform_value('name', plainJsFloat)
    // call in this file was a silent no-op: the uniform stayed at whatever
    // the shader compiler zero-initializes it to, no matter how many times
    // it was called, synchronously or deferred via GLib.idle_add, with no
    // JS exception or journalctl warning anywhere. There's no GJS override
    // on this version that auto-boxes a plain number into a GValue for this
    // call the way there is for many other GI setters. This silently broke
    // EVERY uniform this effect sets (radius/straight/width/height/clip*),
    // which in turn made the coverage shader treat every fragment as
    // outside the (zero-sized) clip rect -- i.e. every window's content
    // fully transparent. Wrapping the value in a real GObject.Value fixes
    // it (verified live via screenshot before writing this fix).
    _setFloatUniform(name, value) {
        const v = new GObject.Value();
        v.init(GObject.TYPE_FLOAT);
        v.set_float(parseFloat(value));
        this.set_uniform_value(name, v);
    }

    vfunc_set_actor(actor) {
        if (this._sizeSignalId) {
            const old = this.get_actor();
            old?.disconnect(this._sizeSignalId);
            this._sizeSignalId = null;
        }
        super.vfunc_set_actor(actor);
        if (actor) {
            this._sizeSignalId = actor.connect('notify::size', () => this._syncUniforms());
            this._syncUniforms();
        }
    }

    _syncUniforms() {
        const actor = this.get_actor();
        if (!actor) return;
        this._setFloatUniform('width', actor.width);
        this._setFloatUniform('height', actor.height);
        this._setFloatUniform('radius', this.radius);
        this._setFloatUniform('straight', this.straight ? 1.0 : 0.0);

        // A window actor's buffer is padded on every side well past the
        // window's real visible frame -- confirmed live on Ghostty: a
        // 572x685 actor for a 522x635 visible frame, a uniform 25px margin
        // on all four edges (Mutter's invisible resize-grab/shadow
        // allowance). Clipping against the raw actor bounds rounds a curve
        // sitting entirely out in that invisible padding, nowhere near the
        // window's real edge -- which does nothing visible for an app that
        // already draws its own native rounded corners nearby (GTK4/CSD
        // apps happened to still look right, purely by coincidence, before
        // this fix), but leaves a plain, unrounded, unclipped square corner
        // on an app that doesn't (Ghostty). get_buffer_rect() gives the
        // padded buffer's position in the same (stage/global) coordinate
        // space as get_frame_rect() -- their difference is the padding
        // margin, converted here to the actor-local coordinates the shader
        // works in.
        if (this._window) {
            const frame = this._window.get_frame_rect();
            const buffer = this._window.get_buffer_rect();
            this._setFloatUniform('clipX', frame.x - buffer.x);
            this._setFloatUniform('clipY', frame.y - buffer.y);
            this._setFloatUniform('clipW', frame.width);
            this._setFloatUniform('clipH', frame.height);
        } else {
            // No window reference (shouldn't normally happen) -- fall back
            // to clipping against the full actor bounds rather than not
            // clipping at all.
            this._setFloatUniform('clipX', 0);
            this._setFloatUniform('clipY', 0);
            this._setFloatUniform('clipW', actor.width);
            this._setFloatUniform('clipH', actor.height);
        }
        this.queue_repaint();
    }
});
