// The train "glow" is a swappable graphics effect (doc02.03). NetworkLayer owns
// the solid train boxes; how they bloom is delegated to a GlowEffect chosen by
// NETWORK_STYLE.train.glow.mode, so a technique can be retuned or swapped without
// touching the layer. Three techniques ship:
//   - "billboard": a camera-facing additive sprite drawn over each train
//     (depthTest off), so the whole bar glows with no clipping seam.
//   - "halo": the same sprite pushed behind the train so the box occludes its
//     center — only a backlit rim shows.
//   - "bloom": a real post-process pass (bright-pass → separable blur → additive
//     composite) that blooms the bright train boxes into the scene.
// "none" disables the effect. Add a case to createGlow to introduce another.

import * as THREE from "three";
import { NETWORK_STYLE } from "./network-style";

// Per-frame train draw data, index-aligned and packed so a strategy can drive an
// InstancedMesh without per-train allocation. positions/colors are 3 floats each.
export interface GlowTrains {
  count: number;
  positions: Float32Array;
  bearings: Float32Array;
  colors: Float32Array;
}

export interface GlowEffect {
  // Renderer + scene are handed over once the layer's GL context exists.
  onAdd(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void;
  // Grow to hold `capacity` trains (mesh strategies rebuild their InstancedMesh).
  rebuild(capacity: number): void;
  // Push this frame's trains plus the camera direction (toward the viewer, local
  // frame) so a billboard can face the camera.
  update(trains: GlowTrains, camDir: THREE.Vector3): void;
  // Enable/disable the whole effect — the lighting toggle. For the scene bloom this
  // gates the pass that lights land/track/stations, so it is independent of trains.
  setEnabled(enabled: boolean): void;
  // Hide only the train-specific glow when trains are toggled off. For the scene
  // bloom this is a no-op: NetworkLayer hides the train mesh from the scene, so the
  // bloom source already excludes them.
  setTrainGlowVisible(visible: boolean): void;
  // Wrap the scene render. Mesh strategies just call renderScene(); a post-process
  // strategy renders to targets and composites. renderScene() renders the whole
  // three scene; renderTrains() renders only the train boxes (the bloom source),
  // both to the current render target. The silhouette outline (TrainOutlinePass)
  // is not a glow concern: NetworkLayer runs it after this returns, so it always
  // draws over whatever the strategy composited.
  render(renderScene: () => void, renderTrains: () => void): void;
  dispose(): void;
}

export function createGlow(): GlowEffect {
  const { train } = NETWORK_STYLE;
  switch (train.glow.mode) {
    case "billboard":
      return new SpriteGlow({ depthTest: false, behindOffsetM: 0 });
    case "halo":
      return new SpriteGlow({
        depthTest: true,
        behindOffsetM: train.length * 0.6,
      });
    case "bloom":
      return new BloomGlow();
    case "none":
      return new NoGlow();
    default:
      return new BloomGlow();
  }
}

class NoGlow implements GlowEffect {
  onAdd(): void {}
  rebuild(): void {}
  update(): void {}
  setEnabled(): void {}
  setTrainGlowVisible(): void {}
  render(renderScene: () => void): void {
    renderScene();
  }
  dispose(): void {}
}

// Signature note: the mesh strategies below ignore the second (renderTrains)
// callback — their glow is scene geometry, drawn by renderScene itself.

// A camera-facing additive sprite per train. With depthTest off it draws over the
// box (whole bar glows, no clipping); with depthTest on and a behind-offset the box
// occludes its center, leaving a backlit rim. The sprite's long axis follows the
// train's travel direction projected into the billboard plane, so the bloom tracks
// the train's on-screen length.
class SpriteGlow implements GlowEffect {
  private scene?: THREE.Scene;
  private mesh?: THREE.InstancedMesh;
  private readonly texture = makeGlowTexture();
  private enabled = true;
  private trainGlowVisible = true;

  private get visible(): boolean {
    return this.enabled && this.trainGlowVisible;
  }

  constructor(
    private readonly opts: { depthTest: boolean; behindOffsetM: number },
  ) {}

  onAdd(_renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    this.scene = scene;
  }

  rebuild(capacity: number): void {
    if (this.mesh) {
      this.scene?.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    const { train } = NETWORK_STYLE;
    const g = train.glow;
    const geo = new THREE.PlaneGeometry(
      train.length * g.scaleLength,
      train.length * g.scaleCross,
    );
    const mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshBasicMaterial({
        map: this.texture,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: g.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: this.opts.depthTest,
      }),
      capacity,
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.visible = this.visible;
    this.mesh = mesh;
    this.scene?.add(mesh);
  }

  update(trains: GlowTrains, camDir: THREE.Vector3): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const behind = this.opts.behindOffsetM;
    const travel = new THREE.Vector3();
    const ex = new THREE.Vector3();
    const ey = new THREE.Vector3();
    const gm = new THREE.Matrix4();
    const color = new THREE.Color();
    for (let i = 0; i < trains.count; i++) {
      const x = trains.positions[3 * i];
      const y = trains.positions[3 * i + 1];
      const z = trains.positions[3 * i + 2];
      const b = trains.bearings[i];
      travel.set(Math.cos(b), 0, -Math.sin(b));
      // Project travel onto the billboard plane for the long axis; fall back to
      // east if the train points near-straight at the camera.
      ex.copy(travel).addScaledVector(camDir, -travel.dot(camDir));
      if (ex.lengthSq() < 1e-6) {
        ex.set(1, 0, 0).addScaledVector(camDir, -camDir.x);
      }
      ex.normalize();
      ey.crossVectors(camDir, ex).normalize();
      gm.makeBasis(ex, ey, camDir).setPosition(
        x - camDir.x * behind,
        y - camDir.y * behind,
        z - camDir.z * behind,
      );
      mesh.setMatrixAt(i, gm);
      color.setRGB(
        trains.colors[3 * i],
        trains.colors[3 * i + 1],
        trains.colors[3 * i + 2],
      );
      mesh.setColorAt(i, color);
    }
    mesh.count = trains.count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.visible = this.visible;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.mesh) this.mesh.visible = this.visible;
  }

  setTrainGlowVisible(visible: boolean): void {
    this.trainGlowVisible = visible;
    if (this.mesh) this.mesh.visible = this.visible;
  }

  render(renderScene: () => void): void {
    renderScene();
  }

  dispose(): void {
    this.texture.dispose();
    this.mesh?.geometry.dispose();
  }
}

// Post-process bloom. The base scene is rendered to screen unchanged, then re-
// rendered to an offscreen target; a bright-pass keeps only pixels above a
// luminance threshold (the fully-lit train boxes; the dimmer shaded tubes fall
// away), a separable Gaussian blur widens them, and the result is composited back
// additively. Additive-on-black keeps MapLibre's framebuffer intact (the Tron view
// clears to black), so the base render is untouched and the bloom only ever adds.
class BloomGlow implements GlowEffect {
  private renderer?: THREE.WebGLRenderer;
  private rtScene?: THREE.WebGLRenderTarget;
  private rtA?: THREE.WebGLRenderTarget;
  private rtB?: THREE.WebGLRenderTarget;
  private readonly size = new THREE.Vector2();
  private visible = true;

  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.Camera();
  private readonly bright = brightMaterial();
  private readonly blur = blurMaterial();
  private readonly composite = compositeMaterial();

  constructor() {
    this.quadScene.add(this.quad);
  }

  onAdd(renderer: THREE.WebGLRenderer, _scene: THREE.Scene): void {
    this.renderer = renderer;
  }

  rebuild(): void {}
  update(): void {}

  setEnabled(enabled: boolean): void {
    this.visible = enabled;
  }

  // No-op: the bloom source re-renders the scene (or the train layer), so a train
  // hidden by NetworkLayer is already excluded — toggling trains must not gate the
  // whole pass, which also lights land/track/stations.
  setTrainGlowVisible(): void {}

  render(renderScene: () => void, renderTrains: () => void): void {
    const renderer = this.renderer;
    // Base scene straight to the screen — unchanged even if bloom is off/skipped.
    renderScene();
    if (!renderer || !this.visible) return;

    this.ensureTargets(renderer);
    const rtScene = this.rtScene as THREE.WebGLRenderTarget;
    let src = this.rtA as THREE.WebGLRenderTarget;
    let dst = this.rtB as THREE.WebGLRenderTarget;

    // Render ONLY the trains to an offscreen target as the bloom source, so every
    // train blooms regardless of its Route color's luminance and nothing else
    // (stations, tubes) does.
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(rtScene);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderTrains();

    const { threshold, intensity, radius, iterations } =
      NETWORK_STYLE.lighting.bloom;
    this.bright.uniforms.tDiffuse.value = rtScene.texture;
    this.bright.uniforms.threshold.value = threshold;
    this.blit(this.bright, src);

    const texel = new THREE.Vector2(1 / src.width, 1 / src.height);
    for (let i = 0; i < iterations; i++) {
      this.blur.uniforms.tDiffuse.value = src.texture;
      this.blur.uniforms.direction.value.set(texel.x * radius, 0);
      this.blit(this.blur, dst);
      [src, dst] = [dst, src];
      this.blur.uniforms.tDiffuse.value = src.texture;
      this.blur.uniforms.direction.value.set(0, texel.y * radius);
      this.blit(this.blur, dst);
      [src, dst] = [dst, src];
    }

    this.composite.uniforms.tBloom.value = src.texture;
    this.composite.uniforms.intensity.value = intensity;
    renderer.setRenderTarget(null);
    this.blit(this.composite, null);

    renderer.setRenderTarget(null);
    renderer.setClearColor(prevClear, prevAlpha);
  }

  private blit(
    material: THREE.Material,
    target: THREE.WebGLRenderTarget | null,
  ): void {
    const renderer = this.renderer as THREE.WebGLRenderer;
    this.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.quadScene, this.quadCamera);
  }

  private ensureTargets(renderer: THREE.WebGLRenderer): void {
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    if (this.rtScene && this.rtScene.width === w && this.rtScene.height === h) {
      return;
    }
    this.rtScene?.dispose();
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtScene = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
    // Blur at half resolution: cheaper and widens the bloom for free.
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    this.rtA = new THREE.WebGLRenderTarget(hw, hh, { depthBuffer: false });
    this.rtB = new THREE.WebGLRenderTarget(hw, hh, { depthBuffer: false });
  }

  dispose(): void {
    this.rtScene?.dispose();
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.quad.geometry.dispose();
    this.bright.dispose();
    this.blur.dispose();
    this.composite.dispose();
  }
}

// Screen-space cel outline for the trains (NETWORK_STYLE.train.outline). The
// trains alone are rendered to an offscreen mask (alpha 0 background, alpha 1
// where a train covers the pixel); a fullscreen pass then inks every pixel that
// is OUTSIDE the mask but within `widthPx` of it, alpha-blended over the screen.
// NetworkLayer runs this after the glow effect's render, so the rim draws over
// the bloom. Screen-space rather than outline geometry on purpose: the width is
// uniform in pixels at every camera angle, and with no depth test nothing (e.g. a
// station puck the train straddles) can punch holes in the rim.
export class TrainOutlinePass {
  private rtMask?: THREE.WebGLRenderTarget;
  private readonly size = new THREE.Vector2();
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.Camera();
  private readonly ink = outlineMaterial();

  constructor() {
    this.quadScene.add(this.quad);
    this.quad.material = this.ink;
  }

  render(renderer: THREE.WebGLRenderer, renderTrains: () => void): void {
    const { outline } = NETWORK_STYLE.train;
    if (!outline.enabled || outline.widthPx <= 0) return;

    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    if (!this.rtMask || this.rtMask.width !== w || this.rtMask.height !== h) {
      this.rtMask?.dispose();
      this.rtMask = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    }

    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.rtMask);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderTrains();
    renderer.setClearColor(prevClear, prevAlpha);

    const u = this.ink.uniforms;
    u.tMask.value = this.rtMask.texture;
    u.texel.value.set(outline.widthPx / w, outline.widthPx / h);
    u.color.value.set(outline.color);
    renderer.setRenderTarget(null);
    renderer.render(this.quadScene, this.quadCamera);
  }

  dispose(): void {
    this.rtMask?.dispose();
    this.quad.geometry.dispose();
    this.ink.dispose();
  }
}

// Ink where a ring of taps at the outline width (plus a half-width ring, so the
// band fills in solid) finds train coverage the center pixel lacks. `texel` is
// already scaled by widthPx, so a tap direction of length 1 lands at the rim.
function outlineMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    transparent: true,
    uniforms: {
      tMask: { value: null },
      texel: { value: new THREE.Vector2() },
      color: { value: new THREE.Color(0x000000) },
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tMask;
      uniform vec2 texel;
      uniform vec3 color;
      varying vec2 vUv;
      float tap(vec2 dir, float scale) {
        return texture2D(tMask, vUv + dir * texel * scale).a;
      }
      void main() {
        float center = texture2D(tMask, vUv).a;
        float m = 0.0;
        m = max(m, tap(vec2( 1.0,  0.0), 1.0));
        m = max(m, tap(vec2(-1.0,  0.0), 1.0));
        m = max(m, tap(vec2( 0.0,  1.0), 1.0));
        m = max(m, tap(vec2( 0.0, -1.0), 1.0));
        m = max(m, tap(vec2( 0.7071,  0.7071), 1.0));
        m = max(m, tap(vec2(-0.7071,  0.7071), 1.0));
        m = max(m, tap(vec2( 0.7071, -0.7071), 1.0));
        m = max(m, tap(vec2(-0.7071, -0.7071), 1.0));
        m = max(m, tap(vec2( 1.0,  0.0), 0.5));
        m = max(m, tap(vec2(-1.0,  0.0), 0.5));
        m = max(m, tap(vec2( 0.0,  1.0), 0.5));
        m = max(m, tap(vec2( 0.0, -1.0), 0.5));
        gl_FragColor = vec4(color, m * (1.0 - center));
      }
    `,
  });
}

// A fullscreen quad passes clip-space positions straight through; PlaneGeometry(2,2)
// spans [-1,1], so no camera transform is needed.
const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

function brightMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tDiffuse: { value: null },
      threshold: { value: 0.6 },
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float threshold;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tDiffuse, vUv).rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        gl_FragColor = vec4(l > threshold ? c : vec3(0.0), 1.0);
      }
    `,
  });
}

function blurMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tDiffuse: { value: null },
      direction: { value: new THREE.Vector2() },
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec2 direction;
      varying vec2 vUv;
      void main() {
        vec3 sum = vec3(0.0);
        sum += texture2D(tDiffuse, vUv + direction * -4.0).rgb * 0.0162162162;
        sum += texture2D(tDiffuse, vUv + direction * -3.0).rgb * 0.0540540541;
        sum += texture2D(tDiffuse, vUv + direction * -2.0).rgb * 0.1216216216;
        sum += texture2D(tDiffuse, vUv + direction * -1.0).rgb * 0.1945945946;
        sum += texture2D(tDiffuse, vUv).rgb * 0.2270270270;
        sum += texture2D(tDiffuse, vUv + direction * 1.0).rgb * 0.1945945946;
        sum += texture2D(tDiffuse, vUv + direction * 2.0).rgb * 0.1216216216;
        sum += texture2D(tDiffuse, vUv + direction * 3.0).rgb * 0.0540540541;
        sum += texture2D(tDiffuse, vUv + direction * 4.0).rgb * 0.0162162162;
        gl_FragColor = vec4(sum, 1.0);
      }
    `,
  });
}

function compositeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      tBloom: { value: null },
      intensity: { value: 1 },
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tBloom;
      uniform float intensity;
      varying vec2 vUv;
      void main() {
        gl_FragColor = vec4(texture2D(tBloom, vUv).rgb * intensity, 1.0);
      }
    `,
  });
}

// Unit vector from the scene toward the camera, in the meter-scaled local frame
// (+X east, +Y up, +Z south), derived from MapLibre's pitch and bearing. At pitch
// 0 the camera is straight overhead (+Y); tilting it swings the view toward the
// ground direction at the top of the screen, whose compass bearing is `bearing`
// (north = -Z, east = +X). The camera sits opposite the forward look direction.
export function cameraDirLocal(
  pitchDeg: number,
  bearingDeg: number,
): THREE.Vector3 {
  const p = (pitchDeg * Math.PI) / 180;
  const b = (bearingDeg * Math.PI) / 180;
  const sinP = Math.sin(p);
  return new THREE.Vector3(
    -Math.sin(b) * sinP,
    Math.cos(p),
    Math.cos(b) * sinP,
  ).normalize();
}

// A soft round white gradient, opaque at the center and fading to transparent at
// the rim. Tinted per-instance to the Route color and additively blended, it
// becomes each train's glow. White base so the instance color survives the multiply.
function makeGlowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.Texture();
  const r = size / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
