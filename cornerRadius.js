import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Shell from 'gi://Shell';

// Fallback used until an app's real corner radius has been measured, and
// for apps where measurement fails (e.g. no CSD alpha, screenshot error).
export const DEFAULT_CORNER_RADIUS = 12;

const _measuredRadius = new Map(); // wm_class -> px
const _probing = new Set();        // wm_class currently being measured

export function getCornerRadius(wmClass) {
    return _measuredRadius.get(wmClass) ?? DEFAULT_CORNER_RADIUS;
}

// CSD corner rounding is baked into the client's own buffer as alpha
// transparency -- there's no compositor-side property to just read, and
// different toolkits/themes draw different radii (e.g. this machine's Yaru
// theme gives Ptyxis a visibly smaller corner than Firefox's). So we measure
// it once per app by screenshotting the focused window and finding where its
// alpha channel's rounded cut flattens into the straight edge, then cache by
// WM_CLASS. `onMeasured` fires once, only on a successful new measurement
// (never for cache hits or failures -- those silently keep DEFAULT_CORNER_RADIUS).
//
// Uses the in-process Shell.Screenshot class rather than the
// org.gnome.Shell.Screenshot D-Bus service. That service is the
// portal-facing API meant for external sandboxed apps and gates callers
// through the desktop-portal permission model -- calling it from inside the
// shell process itself gets rejected ("ScreenshotWindow is not allowed").
// Shell.Screenshot is the same underlying capability without that gate,
// since the extension already runs with full shell privilege, and it can
// write straight into memory instead of a temp file on disk.
export function probeCornerRadius(win, onMeasured) {
    const wmClass = win.get_wm_class();
    if (!wmClass || _measuredRadius.has(wmClass) || _probing.has(wmClass))
        return;

    _probing.add(wmClass);
    const stream = Gio.MemoryOutputStream.new_resizable();
    const screenshot = new Shell.Screenshot();

    screenshot.screenshot_window(true, false, stream, (_source, res) => {
        let radius = null;
        try {
            const [success] = screenshot.screenshot_window_finish(res);
            stream.close(null);
            if (success)
                radius = measureFromBytes(stream.steal_as_bytes());
        } catch (e) {
            logError(e, 'bsptile: corner radius probe failed');
        }

        _probing.delete(wmClass);
        if (radius !== null) {
            _measuredRadius.set(wmClass, radius);
            onMeasured(radius);
        } else {
            // Don't keep re-probing an app that can't be measured.
            _measuredRadius.set(wmClass, DEFAULT_CORNER_RADIUS);
        }
    });
}

// Finds the corner radius baked into a screenshotted window's alpha channel.
// Anchors on the image's center cross-hairs (guaranteed clear of any corner
// curve or drop shadow) to locate the window's real top/left edges, then
// walks down from the top-left corner counting rows until the cut's leading
// edge reaches that left edge -- that row count is the radius.
function measureFromBytes(bytes) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(
        Gio.MemoryInputStream.new_from_bytes(bytes), null);
    if (!pixbuf.get_has_alpha())
        return null;

    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const stride = pixbuf.get_rowstride();
    const channels = pixbuf.get_n_channels();
    const pixels = pixbuf.get_pixels();
    const alphaAt = (x, y) => pixels[y * stride + x * channels + 3];

    const midX = Math.floor(width / 2);
    const midY = Math.floor(height / 2);
    const maxScan = Math.min(60, midX, midY);
    const plateau = alphaAt(midX, midY);
    if (plateau < 32)
        return null; // window itself is essentially transparent; can't measure
    const threshold = plateau * 0.5;

    let topEdgeY = -1;
    for (let y = 0; y < midY; y++) {
        if (alphaAt(midX, y) >= threshold) { topEdgeY = y; break; }
    }
    let leftEdgeX = -1;
    for (let x = 0; x < midX; x++) {
        if (alphaAt(x, midY) >= threshold) { leftEdgeX = x; break; }
    }
    if (topEdgeY < 0 || leftEdgeX < 0)
        return null;

    for (let dy = 0; dy <= maxScan; dy++) {
        const y = topEdgeY + dy;
        let x = 0;
        while (x <= leftEdgeX + 1 && alphaAt(x, y) < threshold) x++;
        if (x <= leftEdgeX + 1)
            return dy;
    }
    return null;
}
