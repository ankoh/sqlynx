export enum EdgeType {
    // Angle is multiple of 90
    West = 0,
    South = 1,
    East = 2,
    North = 3,
    // dy >= dx
    SouthWest = 4,
    SouthEast = 5,
    NorthEast = 6,
    NorthWest = 7,
    // dx > dy
    WestSouth = 8,
    EastSouth = 9,
    EastNorth = 10,
    WestNorth = 11,
    // dy >= dx && dx < width
    SouthWestSouth = 12,
    SouthEastSouth = 13,
    NorthEastNorth = 14,
    NorthWestNorth = 15,
    // dx > dy && dy < height
    WestSouthWest = 16,
    EastSouthEast = 17,
    EastNorthEast = 18,
    WestNorthWest = 19,
}

export enum NodePort {
    North = 0b0001,
    East = 0b0010,
    South = 0b0100,
    West = 0b1000,
}

export const PORTS_FROM = new Uint8Array([
    NodePort.West,
    NodePort.South,
    NodePort.East,
    NodePort.North,
    NodePort.South,
    NodePort.South,
    NodePort.North,
    NodePort.North,
    NodePort.West,
    NodePort.East,
    NodePort.East,
    NodePort.West,
    NodePort.South,
    NodePort.South,
    NodePort.North,
    NodePort.North,
    NodePort.West,
    NodePort.East,
    NodePort.East,
    NodePort.West,
]);

export const PORTS_TO = new Uint8Array([
    NodePort.East,
    NodePort.North,
    NodePort.West,
    NodePort.South,
    NodePort.East,
    NodePort.West,
    NodePort.West,
    NodePort.East,
    NodePort.North,
    NodePort.North,
    NodePort.South,
    NodePort.South,
    NodePort.North,
    NodePort.North,
    NodePort.South,
    NodePort.South,
    NodePort.East,
    NodePort.West,
    NodePort.West,
    NodePort.East,
]);

export function selectEdgeTypeFromAngle(angle: number): EdgeType {
    const sector = angle / 90; // [-2, 2[
    if (sector == Math.floor(sector)) {
        return (sector + 2) as EdgeType; // [0, 4[
    } else {
        return (Math.floor(sector) + 2 + 4) as EdgeType; // [4, 8[
    }
}

export function selectEdgeType(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    width: number,
    height: number,
): EdgeType {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    let orientation = selectEdgeTypeFromAngle(angle);
    const dxBox = Math.max(Math.abs(dx), width) - width;
    const dyBox = Math.max(Math.abs(dy), height) - height;
    if (orientation >= 4) {
        if (dxBox > dyBox) {
            orientation += 4; // [8, 12[
            if (Math.abs(dy) < height / 2) {
                orientation += 8; // [16, 20[
            }
        } else {
            if (Math.abs(dx) < width / 2) {
                orientation += 8; // [12, 16[
            }
        }
    }
    return orientation;
}

export class EdgePathBuilder {
    path: Float64Array;
    i: number;
    constructor() {
        this.path = new Float64Array(16);
        this.i = 0;
    }
    reset() {
        for (let i = 0; i < 16; ++i) {
            this.path[i] = 0;
        }
        this.i = 0;
    }
    begin(x: number, y: number) {
        this.reset();
        this.path[0] = x;
        this.path[1] = y;
    }
    push(x: number, y: number) {
        this.i += 2;
        this.path[this.i] = x;
        this.path[this.i + 1] = y;
    }
    buildDirect(): string {
        const p = this.path;
        return `M ${p[0]} ${p[1]} L ${p[2]} ${p[3]}`;
    }
    build1Turn(): string {
        const p = this.path;
        return `M ${p[0]} ${p[1]} L ${p[2]} ${p[3]} Q ${p[4]} ${p[5]}, ${p[6]} ${p[7]} L ${p[8]} ${p[9]}`;
    }
    build2Turns(): string {
        const p = this.path;
        return `M ${p[0]} ${p[1]} L ${p[2]} ${p[3]} Q ${p[4]} ${p[5]}, ${p[6]} ${p[7]} L ${p[8]} ${p[9]} Q ${p[10]} ${p[11]}, ${p[12]} ${p[13]} L ${p[14]} ${p[15]}`;
    }
}

export function buildEdgePath(
    builder: EdgePathBuilder,
    type: EdgeType,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    width: number,
    height: number,
    gridSize: number,
    cornerRadius: number,
): string {
    if (toX - fromX == 0 && toY - fromY == 0) {
        return '';
    }

    const r = cornerRadius;
    const diffX = Math.abs(toX - fromX);
    const diffY = Math.abs(toY - fromY);
    let midX = fromX + (toX - fromX) / 2;
    let midY = fromY + (toY - fromY) / 2;
    midX = Math.round(midX / gridSize) * gridSize;
    midY = Math.round(midY / gridSize) * gridSize;

    const midXMinusR = () => midX - Math.min(diffX / 2, r);
    const midXPlusR = () => midX + Math.min(diffX / 2, r);
    const midYMinusR = () => midY - Math.min(diffY / 2, r);
    const midYPlusR = () => midY + Math.min(diffY / 2, r);
    const fromXPlusR = () => fromX + Math.min(diffX / 2, r);
    const fromXMinusR = () => fromX - Math.min(diffX / 2, r);
    const fromYPlusR = () => fromY + Math.min(diffY / 2, r);
    const fromYMinusR = () => fromY - Math.min(diffY / 2, r);
    const toXPlusR = () => toX + Math.min(diffX / 2, r);
    const toXMinusR = () => toX - Math.min(diffX / 2, r);
    const toYPlusR = () => toY + Math.min(diffY / 2, r);
    const toYMinusR = () => toY - Math.min(diffY / 2, r);

    switch (type) {
        // DIRECT

        case EdgeType.North:
            builder.begin(fromX, fromY + height / 2);
            builder.push(toX, toY - height / 2);
            return builder.buildDirect();

        case EdgeType.South:
            builder.begin(fromX, fromY - height / 2);
            builder.push(toX, toY + height / 2);
            return builder.buildDirect();

        case EdgeType.East:
            builder.begin(fromX + height / 2, fromY);
            builder.push(toX - height / 2, toY);
            return builder.buildDirect();

        case EdgeType.West:
            builder.begin(fromX - height / 2, fromY);
            builder.push(toX + height / 2, toY);
            return builder.buildDirect();

        // 1 TURN

        case EdgeType.NorthEast:
            builder.begin(fromX, fromY + height / 2);
            builder.push(fromX, toYMinusR() - r);
            builder.push(fromX, toY);
            builder.push(fromXPlusR(), toY);
            builder.push(toX - width / 2, toY);
            return builder.build1Turn();

        case EdgeType.NorthWest:
            builder.begin(fromX, fromY + height / 2);
            builder.push(fromX, toYMinusR());
            builder.push(fromX, toY);
            builder.push(fromXMinusR(), toY);
            builder.push(toX + width / 2, toY);
            return builder.build1Turn();

        case EdgeType.SouthEast:
            builder.begin(fromX, fromY - height / 2);
            builder.push(fromX, toYPlusR());
            builder.push(fromX, toY);
            builder.push(fromXPlusR(), toY);
            builder.push(toX - width / 2, toY);
            return builder.build1Turn();

        case EdgeType.SouthWest:
            builder.begin(fromX, fromY - height / 2);
            builder.push(fromX, toYPlusR());
            builder.push(fromX, toY);
            builder.push(fromXMinusR(), toY);
            builder.push(toX + width / 2, toY);
            return builder.build1Turn();

        case EdgeType.EastNorth:
            builder.begin(fromX + width / 2, fromY);
            builder.push(toXMinusR(), fromY);
            builder.push(toX, fromY);
            builder.push(toX, fromYPlusR());
            builder.push(toX, toY - height / 2);
            return builder.build1Turn();

        case EdgeType.EastSouth:
            builder.begin(fromX + width / 2, fromY);
            builder.push(toXMinusR(), fromY);
            builder.push(toX, fromY);
            builder.push(toX, fromYMinusR());
            builder.push(toX, toY + height / 2);
            return builder.build1Turn();

        case EdgeType.WestNorth:
            builder.begin(fromX - width / 2, fromY);
            builder.push(toXPlusR(), fromY);
            builder.push(toX, fromY);
            builder.push(toX, fromYPlusR());
            builder.push(toX, toY - height / 2);
            return builder.build1Turn();

        case EdgeType.WestSouth:
            builder.begin(fromX - width / 2, fromY);
            builder.push(toXPlusR(), fromY);
            builder.push(toX, fromY);
            builder.push(toX, fromYMinusR());
            builder.push(toX, toY + height / 2);
            return builder.build1Turn();

        // 2 TURNS

        case EdgeType.EastNorthEast:
            builder.begin(fromX + width / 2, fromY);
            builder.push(midXMinusR(), fromY);
            builder.push(midX, fromY);
            builder.push(midX, fromYPlusR());
            builder.push(midX, toYMinusR());
            builder.push(midX, toY);
            builder.push(midXPlusR(), toY);
            builder.push(toX - width / 2, toY);
            return builder.build2Turns();

        case EdgeType.EastSouthEast:
            builder.begin(fromX + width / 2, fromY);
            builder.push(midXMinusR(), fromY);
            builder.push(midX, fromY);
            builder.push(midX, fromYMinusR());
            builder.push(midX, toYPlusR());
            builder.push(midX, toY);
            builder.push(midXPlusR(), toY);
            builder.push(toX - width / 2, toY);
            return builder.build2Turns();

        case EdgeType.SouthEastSouth:
            builder.begin(fromX, fromY - height / 2);
            builder.push(fromX, midYPlusR());
            builder.push(fromX, midY);
            builder.push(fromXPlusR(), midY);
            builder.push(toXMinusR(), midY);
            builder.push(toX, midY);
            builder.push(toX, midYMinusR());
            builder.push(toX, toY + height / 2);
            return builder.build2Turns();

        case EdgeType.SouthWestSouth:
            builder.begin(fromX, fromY - height / 2);
            builder.push(fromX, midYPlusR());
            builder.push(fromX, midY);
            builder.push(fromXMinusR(), midY);
            builder.push(toXPlusR(), midY);
            builder.push(toX, midY);
            builder.push(toX, midYMinusR());
            builder.push(toX, toY + height / 2);
            return builder.build2Turns();

        case EdgeType.WestNorthWest:
            builder.begin(fromX - width / 2, fromY);
            builder.push(midXPlusR(), fromY);
            builder.push(midX, fromY);
            builder.push(midX, fromYPlusR());
            builder.push(midX, toYMinusR());
            builder.push(midX, toY);
            builder.push(midXMinusR(), toY);
            builder.push(toX + width / 2, toY);
            return builder.build2Turns();

        case EdgeType.WestSouthWest:
            builder.begin(fromX - width / 2, fromY);
            builder.push(midXPlusR(), fromY);
            builder.push(midX, fromY);
            builder.push(midX, fromYMinusR());
            builder.push(midX, toYPlusR());
            builder.push(midX, toY);
            builder.push(midXMinusR(), toY);
            builder.push(toX + width / 2, toY);
            return builder.build2Turns();

        case EdgeType.NorthEastNorth:
            builder.begin(fromX, fromY + height / 2);
            builder.push(fromX, midYMinusR());
            builder.push(fromX, midY);
            builder.push(fromXPlusR(), midY);
            builder.push(toXMinusR(), midY);
            builder.push(toX, midY);
            builder.push(toX, midYPlusR());
            builder.push(toX, toY - height / 2);
            return builder.build2Turns();

        case EdgeType.NorthWestNorth:
            builder.begin(fromX, fromY + height / 2);
            builder.push(fromX, midYMinusR());
            builder.push(fromX, midY);
            builder.push(fromXMinusR(), midY);
            builder.push(toXPlusR(), midY);
            builder.push(toX, midY);
            builder.push(toX, midYPlusR());
            builder.push(toX, toY - height / 2);
            return builder.build2Turns();
    }
}
