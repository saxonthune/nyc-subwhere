// ECS-style lighting system (doc02.03). "How brightly does each thing glow" is a
// cross-cutting concern that would otherwise be scattered as emissive/color settings
// across the network layer, the track renderer and the train glow. This module is the
// one System that owns it: NetworkLayer builds geometry and asks the LightingSystem
// for the material (or light) that gives each role — land, water, station — its place
// in the glow hierarchy. The tunables live in NETWORK_STYLE.lighting (the component
// data); the behavior lives here.
//
// The glow hierarchy, brightest first, is realized by a single scene-wide bloom pass
// (train-glow.ts BloomGlow, source "scene"): a luminance threshold keeps only bright
// pixels, so relative brightness alone tiers the roles.
//   trains   — fully self-lit boxes (network-layer), bloom hardest.
//   track    — full-color caret floor (track-render), blooms some.
//   station  — dark puck with a bright emissive, blooms a little.
//   land     — dark grey with a faint cool self-glow, barely blooms ("low glow").
//   water    — dark blue below the threshold: shows near the coast, never glows.

import * as THREE from "three";
import { NETWORK_STYLE } from "./network-style";

// A borough outline in the meter-scaled local frame (X east, Z south), used to bake
// the shoreline distance field the water samples.
export type LandRing = { x: number; z: number }[];

export class LightingSystem {
  // Low ambient + a soft key keep the black Tron base dark, so the emissive/self-lit
  // roles carry the image rather than being washed flat by fill light.
  addLights(scene: THREE.Scene): void {
    const { ambient, key, keyDir } = NETWORK_STYLE.lighting;
    scene.add(new THREE.AmbientLight(0xffffff, ambient));
    const dir = new THREE.DirectionalLight(0xffffff, key);
    dir.position.set(keyDir[0], keyDir[1], keyDir[2]);
    scene.add(dir);
  }

  // The borough land: a dark grey plate with a faint cool emissive, so its tall cliff
  // faces read as softly self-lit rather than pure black in shade — a low glow that
  // sits below the track and trains.
  landMaterial(): THREE.MeshStandardMaterial {
    const { land, lighting } = NETWORK_STYLE;
    return new THREE.MeshStandardMaterial({
      color: land.color,
      emissive: new THREE.Color(lighting.land.emissive),
      emissiveIntensity: lighting.land.emissiveIntensity,
      side: THREE.DoubleSide,
    });
  }

  // The water disc: an unlit dark-blue plane whose opacity is keyed to distance from
  // the nearest coast (a baked shoreline field, `land` in local meters), so blue hugs
  // every shore and fades to the black background — the open ocean reads as an abyss.
  // Unlit and dark, it never crosses the bloom threshold, so water has no glow. The
  // shader maps each fragment's local XZ into the field's region; outside the region
  // (open ocean) there is no land near, so it fades to nothing. Returns the texture so
  // the layer can dispose it.
  waterMaterial(land: LandRing[]): {
    material: THREE.ShaderMaterial;
    texture: THREE.Texture;
  } {
    const { water } = NETWORK_STYLE;
    const field = makeShorelineField(land, water.shoreFalloffM, water.shoreRes);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uShore: { value: field.texture },
        uColor: { value: new THREE.Color(water.color) },
        uMin: { value: new THREE.Vector2(field.minX, field.minZ) },
        uMax: { value: new THREE.Vector2(field.maxX, field.maxZ) },
        uIntensity: { value: water.shoreIntensity },
        // One falloff width in UV units per axis, for the rim fade below.
        uRim: {
          value: new THREE.Vector2(
            water.shoreFalloffM / (field.maxX - field.minX),
            water.shoreFalloffM / (field.maxZ - field.minZ),
          ),
        },
      },
      vertexShader: /* glsl */ `
        varying vec2 vXZ;
        void main() {
          vXZ = position.xz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uShore;
        uniform vec3 uColor;
        uniform vec2 uMin;
        uniform vec2 uMax;
        uniform float uIntensity;
        uniform vec2 uRim;
        varying vec2 vXZ;
        void main() {
          vec2 uv = (vXZ - uMin) / (uMax - uMin);
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          float m = texture2D(uShore, uv).r * uIntensity;
          // Ramp the outermost falloff-width band of the region to zero, so the
          // fade can never end on the region rectangle no matter the intensity.
          vec2 edge = min(uv, 1.0 - uv) / uRim;
          m *= clamp(min(edge.x, edge.y), 0.0, 1.0);
          if (m <= 0.002) discard;
          gl_FragColor = vec4(uColor, clamp(m, 0.0, 1.0));
        }
      `,
    });
    return { material, texture: field.texture };
  }

  // Station pucks: a dark base with a bright emissive so each reads as a glowing
  // cyan-blue node on the line — brighter than the land, dimmer than the trains.
  // transparent so the layer can fade it out with zoom.
  stationMaterial(): THREE.MeshStandardMaterial {
    const { station } = NETWORK_STYLE.lighting;
    return new THREE.MeshStandardMaterial({
      color: station.color,
      emissive: new THREE.Color(station.emissive),
      emissiveIntensity: station.emissiveIntensity,
      transparent: true,
    });
  }
}

// The baked shoreline field: a texture whose red channel is ~1 on land and falls to 0
// over `falloffM` meters seaward, plus the local-meter region it covers so a shader
// can map world XZ into its UVs. Built by rasterizing the borough silhouette and
// blurring it: a Gaussian blur of a filled shape reads ~0.5 right at the boundary and
// decays to 0 about one blur radius outside, which is exactly a coast-hugging taper.
// Land itself is drawn opaque on top of the water, so the high values inside the
// silhouette are hidden and only the seaward tail shows as blue.
type ShorelineField = {
  texture: THREE.Texture;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
};

function makeShorelineField(
  land: LandRing[],
  falloffM: number,
  res: number,
): ShorelineField {
  const pts = land.flat();
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  // Pad the region by 3× the falloff: CSS blur(N) is a Gaussian with σ=N, so at one
  // falloff out the tail still holds ~15% — which shoreIntensity then amplifies into
  // a visible blue wall at the region edge. Three sigmas leaves it truly near zero.
  // Guard the empty-land case with a unit box (the shader just fades to nothing).
  if (!Number.isFinite(minX)) {
    minX = -1;
    minZ = -1;
    maxX = 1;
    maxZ = 1;
  }
  const pad = 3 * falloffM;
  minX -= pad;
  minZ -= pad;
  maxX += pad;
  maxZ += pad;

  const regionW = maxX - minX;
  const regionH = maxZ - minZ;
  // One meters-per-pixel for both axes so the blur is isotropic; the longer axis gets
  // `res` pixels. blurPx is the falloff expressed in pixels.
  const mpp = Math.max(regionW, regionH) / res;
  const w = Math.max(1, Math.round(regionW / mpp));
  const h = Math.max(1, Math.round(regionH / mpp));
  const blurPx = falloffM / mpp;

  const toPx = (x: number, z: number): [number, number] => [
    ((x - minX) / regionW) * w,
    ((z - minZ) / regionH) * h,
  ];

  const sharp = document.createElement("canvas");
  sharp.width = w;
  sharp.height = h;
  const sctx = sharp.getContext("2d");
  if (!sctx) return { texture: new THREE.Texture(), minX, minZ, maxX, maxZ };
  sctx.fillStyle = "#000000";
  sctx.fillRect(0, 0, w, h);
  sctx.fillStyle = "#ffffff";
  for (const ring of land) {
    if (ring.length < 3) continue;
    sctx.beginPath();
    ring.forEach((p, i) => {
      const [px, py] = toPx(p.x, p.z);
      if (i === 0) sctx.moveTo(px, py);
      else sctx.lineTo(px, py);
    });
    sctx.closePath();
    sctx.fill();
  }

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  if (!octx) return { texture: new THREE.Texture(), minX, minZ, maxX, maxZ };
  octx.filter = `blur(${blurPx}px)`;
  octx.drawImage(sharp, 0, 0);

  const tex = new THREE.CanvasTexture(out);
  // Match rasterization row order (row 0 = minZ) to the shader's uv.y = (z-minZ)/H.
  tex.flipY = false;
  tex.needsUpdate = true;
  return { texture: tex, minX, minZ, maxX, maxZ };
}
