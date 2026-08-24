// A binary space partition tree, one per (workspace, monitor) pair.
// Leaves hold a window. Internal nodes hold an orientation ('row' splits
// left/right, 'col' splits top/bottom), a split ratio, and two children.
// New windows split whichever leaf they land near along its longer axis,
// which is what produces the dwindle/fibonacci-style spiral.

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

    insert(window, nearWindow) {
        const newLeaf = new BspNode({ window });

        if (this.root === null) {
            this.root = newLeaf;
            this._leaves.set(window, newLeaf);
            return;
        }

        let target = nearWindow ? this._leaves.get(nearWindow) : null;
        if (!target) target = this._lastLeaf();

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
