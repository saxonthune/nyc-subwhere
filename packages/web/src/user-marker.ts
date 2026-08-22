import * as THREE from "three";
import { NETWORK_STYLE } from "./network-style";
import { trackTopY } from "./track-render";

const DEG2RAD = Math.PI / 180;

// The user's live position in the 3D scene: a blue disc seated at dock height,
// plus a flat arrowhead off the rim that appears once a compass heading
// arrives and turns to the device's bearing (world-aligned, like the dock
// gauges). The layer counterscales the marker each render so it stays legible
// zoomed out but keeps its natural meter size up close.
export class UserMarker {
  readonly group = new THREE.Group();
  private readonly disc: THREE.Mesh;
  private readonly triangle: THREE.Mesh;

  constructor(depthOffset: [number, number], layer: number) {
    const st = NETWORK_STYLE.userMarker;
    const baseY =
      trackTopY() + NETWORK_STYLE.puck.clearanceOverTube - st.height;

    const discGeo = new THREE.CylinderGeometry(
      st.radius,
      st.radius,
      st.height,
      24,
    );
    this.disc = new THREE.Mesh(
      discGeo,
      new THREE.MeshBasicMaterial({ color: st.color }),
    );
    this.disc.position.y = baseY + st.height / 2;

    // Arrowhead pointing north (bearing 0) at rest; setHeading turns it. Shape
    // x = east, y = north; rotateX(-90°) lays it flat with the extrusion up.
    const t = st.triangle;
    const r0 = st.radius + t.standoff;
    const shape = new THREE.Shape();
    shape.moveTo(-t.halfWidth, r0);
    shape.lineTo(t.halfWidth, r0);
    shape.lineTo(0, r0 + t.length);
    shape.closePath();
    const triGeo = new THREE.ExtrudeGeometry(shape, {
      depth: t.height,
      bevelEnabled: false,
    });
    triGeo.rotateX(-Math.PI / 2);
    this.triangle = new THREE.Mesh(
      triGeo,
      new THREE.MeshBasicMaterial({ color: st.color }),
    );
    this.triangle.position.y = baseY;
    this.triangle.visible = false;

    for (const mesh of [this.disc, this.triangle]) {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.polygonOffset = true;
      [mat.polygonOffsetFactor, mat.polygonOffsetUnits] = depthOffset;
      mesh.frustumCulled = false;
      mesh.layers.enable(layer);
      this.group.add(mesh);
    }
  }

  setPosition(x: number, z: number): void {
    this.group.position.set(x, 0, z);
  }

  // Compass bearing in degrees, or null to drop back to the bare disc. A
  // positive Y rotation turns bearings down (see buildSquareStations,
  // network-layer.ts), so pointing the north-built arrow at `deg` negates it.
  setHeading(deg: number | null): void {
    this.triangle.visible = deg != null;
    if (deg != null) this.triangle.rotation.y = -deg * DEG2RAD;
  }

  // Horizontal only: the meshes' Y offsets seat them against the track top, and
  // scaling those would float the marker off the ground.
  setScale(s: number): void {
    this.group.scale.set(s, 1, s);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const mesh of [this.disc, this.triangle]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
