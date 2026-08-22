import * as THREE from "three";
import { NETWORK_STYLE } from "./network-style";

// Per-dock available counts, same GBFS *_available figures the modal shows
// (disabled bikes/docks already excluded). null = no live data for the dock.
export interface BikeResourceCounts {
  classicBikes: number;
  ebikes: number;
  docks: number;
}

const DEG2RAD = Math.PI / 180;

// Bike View dock markers, idea 1 (replacing the disc): one flat scoreboard slab
// per dock, its top face a canvas texture with the three counts in the modal's
// resource colors. The slabs lie flat on the map and yaw with the camera
// bearing so the text's up always points to screen-up. One mesh + one texture
// per dock — a draw call and a canvas each, deliberately unoptimized for now.
//
// TRAIN_LAYER / PUCK_DEPTH_OFFSET are passed in rather than imported so this
// module doesn't import network-layer back (which imports it).
export class BikeScoreboards {
  readonly group = new THREE.Group();
  private readonly geometry: THREE.BoxGeometry;
  private readonly sideMaterial: THREE.MeshBasicMaterial;
  private readonly topMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly textures: THREE.CanvasTexture[] = [];
  private lastBearing = Number.NaN;

  constructor(
    placements: { x: number; z: number }[],
    counts: (BikeResourceCounts | null)[],
    centerY: number,
    depthOffset: [number, number],
    outlineLayer: number,
  ) {
    const sb = NETWORK_STYLE.bikeView.bikeStation.scoreboard;
    this.geometry = new THREE.BoxGeometry(sb.width, sb.thickness, sb.depth);
    this.sideMaterial = new THREE.MeshBasicMaterial({ color: sb.side });
    this.sideMaterial.polygonOffset = true;
    [
      this.sideMaterial.polygonOffsetFactor,
      this.sideMaterial.polygonOffsetUnits,
    ] = depthOffset;
    placements.forEach((p, i) => {
      const tex = new THREE.CanvasTexture(drawBoard(counts[i] ?? null));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const top = new THREE.MeshBasicMaterial({ map: tex });
      top.polygonOffset = true;
      [top.polygonOffsetFactor, top.polygonOffsetUnits] = depthOffset;
      const side = this.sideMaterial;
      // BoxGeometry material slots: [+x, -x, +y(top), -y, +z, -z].
      const mesh = new THREE.Mesh(this.geometry, [
        side,
        side,
        top,
        side,
        side,
        side,
      ]);
      mesh.position.set(p.x, centerY, p.z);
      mesh.layers.enable(outlineLayer);
      this.group.add(mesh);
      this.textures.push(tex);
      this.topMaterials.push(top);
    });
  }

  // Yaw every slab so the texture's up edge points along the camera bearing
  // (screen-up on the ground). The top face's texture-up sits at local -Z
  // (north) unrotated, and makeRotationY(θ) turns bearings down by θ, so
  // θ = -bearing lands north on the bearing direction.
  setBearing(bearingDeg: number): void {
    if (bearingDeg === this.lastBearing) return;
    this.lastBearing = bearingDeg;
    const yaw = -bearingDeg * DEG2RAD;
    for (const child of this.group.children) child.rotation.y = yaw;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const t of this.textures) t.dispose();
    for (const m of this.topMaterials) m.dispose();
    this.sideMaterial.dispose();
    this.geometry.dispose();
  }
}

// The board face: three glowing counts on a near-black plate with faint column
// dividers — the modal's tron look, flattened onto the map. A zero renders in
// warning red like the modal's zero dot; a null (no live data) as a dim dash.
function drawBoard(counts: BikeResourceCounts | null): HTMLCanvasElement {
  const sb = NETWORK_STYLE.bikeView.bikeStation.scoreboard;
  const w = 256;
  const h = Math.round((w * sb.depth) / sb.width);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = sb.background;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
  ctx.beginPath();
  ctx.moveTo(w / 3, 10);
  ctx.lineTo(w / 3, h - 10);
  ctx.moveTo((2 * w) / 3, 10);
  ctx.lineTo((2 * w) / 3, h - 10);
  ctx.stroke();

  const cols = [
    { value: counts?.classicBikes, color: sb.colors.classic },
    { value: counts?.ebikes, color: sb.colors.ebikes },
    { value: counts?.docks, color: sb.colors.docks },
  ];
  ctx.font = "700 52px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  cols.forEach((c, i) => {
    const x = (w / 6) * (2 * i + 1);
    const y = h / 2 + 2;
    if (c.value == null) {
      ctx.fillStyle = "#4a545f";
      ctx.fillText("–", x, y);
      return;
    }
    const color = c.value === 0 ? sb.colors.zero : c.color;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.fillText(String(c.value), x, y);
    ctx.shadowBlur = 0;
  });
  return canvas;
}
