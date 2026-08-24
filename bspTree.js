// A binary space partition tree, one per (workspace, monitor) pair.
// Leaves hold a window. Internal nodes hold an orientation ('row' splits
// left/right, 'col' splits top/bottom), a split ratio, and two children.
// New windows split whichever leaf they land near along its longer axis,
// which is what produces the dwindle/fibonacci-style spiral.

// Below this, splitting a leaf would hand at least one side a tile smaller
// than most apps' actual minimum size, so insert() prefers a roomier leaf
// instead when one exists (matters most for the 5th+ window in a deep
// spiral, where the most-recently-split corner runs out of space first
// while the rest of the tree still has plenty of room).
const MIN_SPLIT_PX = 200;

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
        this._minSizes = new Map(); // Meta.Window -> {width, height}, learned from actual applied resizes
    }

    get isEmpty() {
        return this.root === null;
    }

    has(window) {
        return this._leaves.has(window);
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

    // Records a window's real minimum size, learned by the caller comparing
    // a requested move_resize_frame() against what actually landed once the
    // resize settled. Tracks each dimension's max independently -- a later
    // observation with a taller-but-narrower reading (e.g. a stale width
    // sample) must not overwrite a previously-confirmed wider dimension.
    // Returns false (and stores nothing) if this isn't new information, so
    // callers can tell "already knew that" apart from "just learned
    // something" without keeping their own shadow copy.
    learnMinSize(window, size) {
        const prev = this._minSizes.get(window);
        const width = prev ? Math.max(prev.width, size.width) : size.width;
        const height = prev ? Math.max(prev.height, size.height) : size.height;
        if (prev && width === prev.width && height === prev.height) return false;
        this._minSizes.set(window, { width, height });
        return true;
    }

    minSizeOf(window) {
        return this._minSizes.get(window) || null;
    }

    // Only for a window that's actually gone (unmanaged) -- an internal
    // remove()+insert() done to re-home a window still keeps its learned
    // size, since that's the whole reason to re-home it.
    forgetMinSize(window) {
        this._minSizes.delete(window);
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
    // resulting sides at or above the relevant floor. That floor is the
    // window's own learned minimum (along whichever axis the split actually
    // divides) when we have one, else the generic MIN_SPLIT_PX guess. No
    // layout info yet (very first insert into a leaf that's never been
    // through computeRects) always allows the split -- there's nothing
    // better to fall back to.
    _canSplit(node) {
        const rect = node.lastRect;
        if (!rect) return true;
        const splitsWidth = rect.width >= rect.height; // mirrors insert()'s orientation choice
        const long = splitsWidth ? rect.width : rect.height;
        const learned = node.window ? this._minSizes.get(node.window) : null;
        const learnedAlongAxis = learned ? (splitsWidth ? learned.width : learned.height) : 0;
        const floor = Math.max(learnedAlongAxis, MIN_SPLIT_PX);
        return long >= 2 * floor;
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
        if (node.orientation === 'row') {
            const aw = Math.round(rect.width * node.ratio);
            this._compute(a, { x: rect.x, y: rect.y, width: aw, height: rect.height }, result);
            this._compute(b, { x: rect.x + aw, y: rect.y, width: rect.width - aw, height: rect.height }, result);
        } else {
            const ah = Math.round(rect.height * node.ratio);
            this._compute(a, { x: rect.x, y: rect.y, width: rect.width, height: ah }, result);
            this._compute(b, { x: rect.x, y: rect.y + ah, width: rect.width, height: rect.height - ah }, result);
        }
    }
}
