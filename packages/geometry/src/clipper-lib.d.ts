// clipper-lib ships no types. We use a thin slice of its API (integer polygon offset +
// union); declare just enough for the silhouette bake. Coordinates are integer {X,Y}.
declare module "clipper-lib" {
  export interface IntPoint {
    X: number;
    Y: number;
  }
  type Path = IntPoint[];
  type Paths = Path[];

  export interface PolyNode {
    Contour(): Path;
    Childs(): PolyNode[];
    IsHole(): boolean;
  }
  class PolyTree {
    Childs(): PolyNode[];
  }
  class Clipper {
    constructor(initOptions?: number);
    AddPaths(paths: Paths, polyType: number, closed: boolean): boolean;
    Execute(
      clipType: number,
      solution: PolyTree,
      subjFillType: number,
      clipFillType: number,
    ): boolean;
  }
  class ClipperOffset {
    constructor(miterLimit?: number, arcTolerance?: number);
    AddPath(path: Path, joinType: number, endType: number): void;
    Execute(solution: Paths, delta: number): void;
  }
  const ClipperLib: {
    Clipper: typeof Clipper;
    ClipperOffset: typeof ClipperOffset;
    PolyTree: typeof PolyTree;
    ClipType: { ctUnion: number };
    PolyType: { ptSubject: number };
    PolyFillType: { pftNonZero: number };
    JoinType: { jtRound: number };
    EndType: { etOpenRound: number };
  };
  export default ClipperLib;
}
