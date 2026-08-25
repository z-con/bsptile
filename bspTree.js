// A binary space partition tree, one per (workspace, monitor) pair.
// Leaves hold a window. Internal nodes hold an orientation ('row' splits
// left/right, 'col' splits top/bottom), a split ratio, and two children.
// New windows split whichever leaf they land near along its longer axis,
// which is what produces the dwindle/fibonacci-style spiral.

// Hard backstop: a leaf can never be shrunk below this, regardless of what
// SHRINK_LIMIT_FRACTION below would otherwise allow -- keeps a resize (or a
// fresh split via insert()) from decaying a window toward nothing over many
// successive steps, and it's what governs a brand-new leaf that has no
// established size of its own yet to take a percentage of.
const MIN_SPLIT_PX = 380;

// A single split or resize can never take more than this fraction away from
// a leaf's own last known size in one shot -- keeps the limit proportional
// to what a given window actually has right now instead of one global pixel
// number with no relation to it (a small terminal and a maximized editor
// get shrunk by the same fraction, not toward the same absolute floor).
const SHRINK_LIMIT_FRACTION = 0.5;

class BspNode {
    constructor({ window = null, orientation = null, ratio = 0.5, children = null, parent = null } = {}) {
        this.window = window;
        this.orientation = orientation;
        this.ratio = ratio;
        this.children = children;
        this.parent = parent;
    }

    get isLeaf() {
        return this.children === null;
    }
}

export class BspTree {
    constructor() {
        this.root = null;
        this._leaves = new Map(); // Meta.Window -> BspNode
    }

    get isEmpty() {
        return this.root === null;
    }

    has(window) {
        return this._leaves.has(window);
    }

    // Every window currently in this tree, unordered. Used by
    // VirtualWorkspaceManager to park/unpark a whole slot's windows at once.
    get windows() {
        return this._leaves.keys();
    }

    insert(window, nearWindow) {
        const newLeaf = new BspNode({ window });

        if (this.root === null) {
            this.root = newLeaf;
            this._leaves.set(window, newLeaf);
            return;
        }

        let target = nearWindow ? this._leaves.get(nearWindow) : null;
        if (!target) target = this._lastLeaf();
        if (!this._canSplit(target)) target = this._largestLeaf();

        const rect = target.lastRect || { width: 1, height: 1 };
        const orientation = rect.width >= rect.height ? 'row' : 'col';

        const displacedLeaf = new BspNode({ window: target.window, parent: target });
        this._leaves.set(target.window, displacedLeaf);

        target.window = null;
        target.orientation = orientation;
        target.ratio = 0.5;
        target.children = [displacedLeaf, newLeaf];
        newLeaf.parent = target;

        this._leaves.set(window, newLeaf);
    }

    // Exchanges which window two existing leaves hold, without touching the
    // tree's shape or ratios at all -- used for "drag one tiled window onto
    // another to swap their positions" instead of a real insert/remove.
    // Returns false (no-op) if either window isn't actually a leaf here.
    swap(windowA, windowB) {
        const leafA = this._leaves.get(windowA);
        const leafB = this._leaves.get(windowB);
        if (!leafA || !leafB || leafA === leafB) return false;

        leafA.window = windowB;
        leafB.window = windowA;
        this._leaves.set(windowA, leafB);
        this._leaves.set(windowB, leafA);
        return true;
    }

    remove(window) {
        const leaf = this._leaves.get(window);
        if (!leaf) return;
        this._leaves.delete(window);

        const parent = leaf.parent;
        if (!parent) {
            this.root = null;
            return;
        }

        const sibling = parent.children[0] === leaf ? parent.children[1] : parent.children[0];
        sibling.parent = parent.parent;
        if (parent.parent === null) {
            this.root = sibling;
        } else {
            const gp = parent.parent;
            gp.children[gp.children[0] === parent ? 0 : 1] = sibling;
        }
    }

    _lastLeaf() {
        let node = this.root;
        while (!node.isLeaf) node = node.children[1];
        return node;
    }

    // True if splitting this leaf along its longer axis would leave both
    // resulting sides at or above its floor (floorPxFor). No layout info
    // yet (very first insert into a leaf that's never been through
    // computeRects) always allows the split -- there's nothing better to
    // fall back to.
    _canSplit(node) {
        const rect = node.lastRect;
        if (!rect) return true;
        const splitsWidth = rect.width >= rect.height; // mirrors insert()'s orientation choice
        const orientation = splitsWidth ? 'row' : 'col';
        const long = splitsWidth ? rect.width : rect.height;
        return long >= 2 * this.floorPxFor(node, orientation);
    }

    // Pixel floor a resize/split must respect on one side of a split, along
    // `orientation` ('row' = width, 'col' = height).
    //
    // For a leaf: SHRINK_LIMIT_FRACTION of its own last known extent along
    // that axis, floored by the MIN_SPLIT_PX backstop -- so the limit scales
    // with what THIS window actually has, not a single generic number every
    // window is measured against. A leaf with no established size yet
    // (freshly created by insert(), not yet through a computeRects pass)
    // has nothing to take a percentage of, so it just uses the backstop.
    //
    // `side` may instead be a whole subtree, in which case recurse rather
    // than treating it as a single unit, since a subtree's real floor is
    // whatever its own children need: if it splits along the same axis
    // we're measuring, its children's floors stack (each needs its own
    // share of that dimension); if it splits the other axis, its children
    // instead share the full extent along this axis (both span it fully, so
    // whichever needs more sets the subtree's floor).
    //
    // Shared by _canSplit (does insert() dare split this leaf at all),
    // hasCapacity(), and the extension's resize paths (border-drag and the
    // resize keybindings), so none of them can push a window below what a
    // split elsewhere in the tree already committed to respecting.
    floorPxFor(side, orientation) {
        if (side.isLeaf) {
            const rect = side.lastRect;
            if (!rect) return MIN_SPLIT_PX;
            const extent = orientation === 'row' ? rect.width : rect.height;
            return Math.max(extent * (1 - SHRINK_LIMIT_FRACTION), MIN_SPLIT_PX);
        }
        const [a, b] = side.children;
        const floorA = this.floorPxFor(a, orientation);
        const floorB = this.floorPxFor(b, orientation);
        return side.orientation === orientation ? floorA + floorB : Math.max(floorA, floorB);
    }

    // True if at least one leaf could still accept a compliant split --
    // i.e. whether this tree has room for one more tiled window at all.
    // Empty tree trivially has room (insert() just sets the root, no split
    // needed).
    hasCapacity() {
        if (this.root === null) return true;
        for (const leaf of this._leaves.values()) {
            if (this._canSplit(leaf)) return true;
        }
        return false;
    }

    _largestLeaf() {
        let best = null;
        let bestArea = -1;
        const walk = (node) => {
            if (node.isLeaf) {
                const rect = node.lastRect;
                const area = rect ? rect.width * rect.height : Infinity;
                if (area > bestArea) {
                    bestArea = area;
                    best = node;
                }
            } else {
                walk(node.children[0]);
                walk(node.children[1]);
            }
        };
        walk(this.root);
        return best;
    }

    // Walks up from `window`'s leaf to find the ancestor split that a resize
    // on the given (orientation, sideIsFar) edge actually adjusts.
    // orientation: 'row' (E/W edges) or 'col' (N/S edges).
    // sideIsFar: true for the E or S edge, false for the W or N edge.
    // Returns an opaque node handle for ratioOf/rectOf/setRatio, or null if
    // that edge borders the work area rather than a sibling window.
    findResizeTarget(window, orientation, sideIsFar) {
        let node = this._leaves.get(window);
        if (!node) return null;
        while (node.parent) {
            const parent = node.parent;
            const childIndex = parent.children[0] === node ? 0 : 1;
            if (parent.orientation === orientation) {
                const isShared = (childIndex === 0 && sideIsFar) || (childIndex === 1 && !sideIsFar);
                if (isShared) return parent;
            }
            node = parent;
        }
        return null;
    }

    // The node's own bounding rect as of the last computeRects() pass --
    // stable across a single resize drag, since a split's ratio only moves
    // the boundary *inside* it, never its own outer rect.
    rectOf(node) {
        return node.lastRect || null;
    }

    ratioOf(node) {
        return node.ratio;
    }

    setRatio(node, ratio) {
        node.ratio = Math.min(0.95, Math.max(0.05, ratio));
    }

    // Returns Map<Meta.Window, {x,y,width,height}>
    computeRects(rect) {
        const result = new Map();
        if (this.root) this._compute(this.root, rect, result);
        return result;
    }

    _compute(node, rect, result) {
        node.lastRect = rect;
        if (node.isLeaf) {
            result.set(node.window, rect);
            return;
        }
        const [a, b] = node.children;
        const isRow = node.orientation === 'row';
        const available = isRow ? rect.width : rect.height;

        // Enforce both children's recursive pixel floor (floorPxFor) right
        // here, for every split, not just the one a user happens to be
        // dragging -- ratio is "desired" intent, this is what reconciles it
        // against what the subtree on each side can actually support. A
        // split several levels up the tree can therefore never starve a
        // deeply nested subtree below what ITS OWN windows need, without
        // each resize call site having to know or care how deep that
        // subtree goes.
        const floorA = this.floorPxFor(a, node.orientation);
        const floorB = this.floorPxFor(b, node.orientation);

        let aExtent;
        if (floorA + floorB <= available) {
            const desired = Math.round(available * node.ratio);
            aExtent = Math.min(available - floorB, Math.max(floorA, desired));
        } else {
            // The container itself is too small to honor both floors at once
            // (e.g. the monitor shrank, or a gap/panel change ate into the
            // work area) -- hasCapacity() is meant to keep insert() out of
            // this state, but an external resize can still land here after
            // the fact. No split satisfies both floors, so hand out what's
            // left proportional to each side's own floor rather than
            // picking an arbitrary winner.
            aExtent = Math.round(available * (floorA / (floorA + floorB)));
        }

        if (isRow) {
            this._compute(a, { x: rect.x, y: rect.y, width: aExtent, height: rect.height }, result);
            this._compute(b, { x: rect.x + aExtent, y: rect.y, width: rect.width - aExtent, height: rect.height }, result);
        } else {
            this._compute(a, { x: rect.x, y: rect.y, width: rect.width, height: aExtent }, result);
            this._compute(b, { x: rect.x, y: rect.y + aExtent, width: rect.width, height: rect.height - aExtent }, result);
        }
    }
}
