import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ForceLayout } from '@inkwright/core';
import { clusterExtent, prefersReducedMotion, ringTexture, type DisplayGraph, type GraphRenderer, type GraphTheme, type RGB } from './scene.ts';

/**
 * The graph in 3D with three.js: notes as ink drops (a point sprite shader with a wobbly edge and
 * ink pooled at the rim), links as fine ink threads, notebooks as floating-ink ring clouds in their
 * cover colours, the selected note as the jade stone-eye, and depth fog in the desk colour.
 */

const NODE_VS = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute float seed;
  attribute vec3 tint;
  uniform float scale;
  uniform float fogDensity;
  varying vec3 vTint;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float depth = -mv.z;
    float fog = 1.0 - exp(-fogDensity * fogDensity * depth * depth);
    vTint = tint;
    vSeed = seed;
    vAlpha = alpha * (1.0 - fog * 0.86);
    gl_PointSize = max(2.0, size * scale / depth);
    gl_Position = projectionMatrix * mv;
  }
`;

const NODE_FS = /* glsl */ `
  uniform vec3 desk;
  uniform float dark;
  varying vec3 vTint;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float a = atan(p.y, p.x);
    float r = length(p);
    // A drop of ink is never a perfect circle.
    float edge = 0.86 + 0.06 * sin(a * 3.0 + vSeed * 6.28) + 0.035 * sin(a * 7.0 + vSeed * 17.0);
    float body = 1.0 - smoothstep(edge - 0.08, edge, r);
    if (body <= 0.001 || vAlpha <= 0.001) discard;
    // Ink pools at the rim as it dries; the middle stays a touch lighter.
    float rim = smoothstep(edge - 0.32, edge - 0.04, r);
    vec3 pooled = mix(vTint, vTint * (dark > 0.5 ? 1.18 : 0.68), rim);
    vec3 col = mix(mix(pooled, desk, 0.12 * (1.0 - rim)), pooled, 0.85);
    gl_FragColor = vec4(col, body * vAlpha);
  }
`;

const EYE_FS = /* glsl */ `
  uniform vec3 ring;
  uniform vec3 core;
  uniform float pulse;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    float halo = (1.0 - smoothstep(0.62, 1.0, r)) * 0.22 * pulse;
    float band = smoothstep(0.38, 0.44, r) * (1.0 - smoothstep(0.58, 0.64, r));
    float centre = 1.0 - smoothstep(0.3, 0.36, r);
    vec3 col = mix(ring, core, centre);
    float a = max(band, centre * 0.92);
    if (a < halo) { col = ring; a = halo; }
    if (a < 0.01) discard;
    gl_FragColor = vec4(col, a);
  }
`;

const v3 = (c: RGB) => new THREE.Color(c[0], c[1], c[2]);

// Colours come straight from the app's CSS (sRGB); draw them exactly as given, no conversions.
THREE.ColorManagement.enabled = false;

export class Graph3D implements GraphRenderer {
  readonly kind = '3d' as const;
  frames = 0;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private nodes: THREE.Points | null = null;
  private edges: THREE.LineSegments | null = null;
  private eye: THREE.Points;
  private clouds: THREE.Sprite[] = [];
  private g: DisplayGraph | null = null;
  private layout: ForceLayout | null = null;
  private alpha: Float32Array = new Float32Array(0);
  private target: Float32Array = new Float32Array(0);
  private selected = -1;
  private hovered = -1;
  private raf = 0;
  private theme: GraphTheme;
  private reduced = prefersReducedMotion();
  private tween: { from: THREE.Vector3; to: THREE.Vector3; camFrom: THREE.Vector3; camTo: THREE.Vector3; t0: number; ms: number } | null = null;
  private interacting = false;
  private idleSince = performance.now();
  private labelIds: string[] = [];
  private labels: HTMLDivElement;
  private labelEls = new Map<string, HTMLDivElement>();

  constructor(private host: HTMLElement, theme: GraphTheme) {
    this.theme = theme;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.domElement.className = 'graph-canvas';
    host.appendChild(this.renderer.domElement);
    this.labels = document.createElement('div');
    this.labels.className = 'graph-labels';
    host.appendChild(this.labels);
    this.camera = new THREE.PerspectiveCamera(48, 1, 1, 6000);
    this.camera.position.set(0, 0, 320);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !this.reduced;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.9;
    this.controls.minDistance = 20;
    this.controls.maxDistance = 3000;
    this.controls.autoRotate = !this.reduced && !theme.flat;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener('start', () => { this.interacting = true; this.tween = null; this.controls.autoRotate = false; });
    this.controls.addEventListener('end', () => { this.interacting = false; this.idleSince = performance.now(); });

    const eyeGeo = new THREE.BufferGeometry();
    eyeGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    eyeGeo.setAttribute('size', new THREE.Float32BufferAttribute([1], 1));
    eyeGeo.setAttribute('alpha', new THREE.Float32BufferAttribute([1], 1));
    eyeGeo.setAttribute('seed', new THREE.Float32BufferAttribute([0], 1));
    eyeGeo.setAttribute('tint', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    this.eye = new THREE.Points(eyeGeo, new THREE.ShaderMaterial({
      vertexShader: NODE_VS, fragmentShader: EYE_FS, transparent: true, depthWrite: false, depthTest: false,
      uniforms: { scale: { value: 1 }, fogDensity: { value: 0 }, ring: { value: v3(theme.eye) }, core: { value: v3(theme.eyeCore) }, pulse: { value: 1 } },
    }));
    this.eye.visible = false;
    this.eye.renderOrder = 10;
    this.scene.add(this.eye);
    this.applyTheme();
    this.resize();
    const loop = () => { this.raf = requestAnimationFrame(loop); this.frame(); };
    this.raf = requestAnimationFrame(loop);
  }

  private applyTheme() {
    const t = this.theme;
    this.scene.background = v3(t.desk);
    const eyeMat = this.eye.material as THREE.ShaderMaterial;
    eyeMat.uniforms.ring!.value = v3(t.eye);
    eyeMat.uniforms.core!.value = v3(t.eyeCore);
    if (this.nodes) {
      const m = this.nodes.material as THREE.ShaderMaterial;
      m.uniforms.desk!.value = v3(t.desk);
      m.uniforms.dark!.value = t.dark ? 1 : 0;
    }
  }

  setTheme(t: GraphTheme): void {
    this.theme = t;
    this.applyTheme();
    if (this.g && this.layout) this.setGraph(this.g, this.layout);
  }

  setGraph(g: DisplayGraph, layout: ForceLayout): void {
    this.g = g;
    this.layout = layout;
    const n = g.nodes.length;
    const prev = this.alpha;
    this.alpha = new Float32Array(n);
    if (this.target.length !== n) this.target = new Float32Array(n).fill(1);
    if (prev.length === n) this.alpha.set(prev);
    for (const o of [this.nodes, this.edges]) if (o) { this.scene.remove(o); o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
    for (const c of this.clouds) { this.scene.remove(c); c.material.map?.dispose(); c.material.dispose(); }
    this.clouds = [];

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(g.nodes.map((d) => d.size * 2.9)), 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.setAttribute('seed', new THREE.BufferAttribute(new Float32Array(g.nodes.map((d, i) => ((d.id.charCodeAt(d.id.length - 1) * 31 + i * 7) % 97) / 97)), 1));
    geo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(g.nodes.flatMap((d) => d.color)), 3));
    this.nodes = new THREE.Points(geo, new THREE.ShaderMaterial({
      vertexShader: NODE_VS, fragmentShader: NODE_FS, transparent: true, depthWrite: false,
      uniforms: { scale: { value: 1 }, fogDensity: { value: 0.002 }, desk: { value: v3(this.theme.desk) }, dark: { value: this.theme.dark ? 1 : 0 } },
    }));
    this.nodes.frustumCulled = false;
    this.nodes.renderOrder = 2;
    this.scene.add(this.nodes);

    const m = g.edges.length;
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m * 6), 3));
    eg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(m * 8), 4));
    this.edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    this.edges.frustumCulled = false;
    this.edges.renderOrder = 1;
    this.scene.add(this.edges);

    g.clusters.forEach((c, k) => {
      const tex = new THREE.CanvasTexture(ringTexture(c.color, 256, k * 7919 + c.id.length));
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: this.theme.dark ? 0.55 : 0.75, fog: false }));
      sp.renderOrder = 0;
      this.clouds.push(sp);
      this.scene.add(sp);
    });
    this.sync();
  }

  setTargets(alpha: Float32Array, instant = false): void {
    this.target = alpha;
    if (instant || this.reduced) this.alpha = Float32Array.from(alpha);
  }

  setSelected(id: string | null): void { this.selected = id == null ? -1 : (this.g?.index.get(id) ?? -1); }
  setHovered(id: string | null): void { this.hovered = id == null ? -1 : (this.g?.index.get(id) ?? -1); }
  setLabels(ids: readonly string[]): void { this.labelIds = [...ids]; }

  private nodePos(i: number): THREE.Vector3 {
    const l = this.layout!;
    return new THREE.Vector3(l.x[i]!, l.y[i]!, l.z[i]!);
  }

  focus(id: string, animate: boolean): void {
    const i = this.g?.index.get(id);
    if (i == null || !this.layout) return;
    const to = this.nodePos(i);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const camTo = to.clone().add(dir.multiplyScalar(Math.max(130, Math.min(240, this.camera.position.distanceTo(this.controls.target)))));
    this.controls.autoRotate = false;
    if (!animate || this.reduced) {
      this.controls.target.copy(to);
      this.camera.position.copy(camTo);
      this.controls.update();
      return;
    }
    this.tween = { from: this.controls.target.clone(), to, camFrom: this.camera.position.clone(), camTo, t0: performance.now(), ms: 700 };
  }

  fit(animate: boolean): void {
    if (!this.layout || !this.g) return;
    let r = 30;
    for (let i = 0; i < this.g.nodes.length; i++) if (this.target[i]! > 0.05) r = Math.max(r, Math.hypot(this.layout.x[i]!, this.layout.y[i]!, this.layout.z[i]!));
    const dist = (r * 0.9) / Math.sin((this.camera.fov * Math.PI) / 360);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const camTo = dir.multiplyScalar(dist);
    if (!animate || this.reduced) { this.controls.target.set(0, 0, 0); this.camera.position.copy(camTo); this.controls.update(); return; }
    this.tween = { from: this.controls.target.clone(), to: new THREE.Vector3(), camFrom: this.camera.position.clone(), camTo, t0: performance.now(), ms: 800 };
  }

  private project(i: number): { x: number; y: number; z: number } | null {
    const p = this.nodePos(i).project(this.camera);
    if (p.z > 1 || p.z < -1) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height, z: p.z };
  }

  pick(clientX: number, clientY: number): string | null {
    if (!this.g || !this.layout) return null;
    let best = -1;
    let bestD = Infinity;
    const scale = this.pointScale();
    for (let i = 0; i < this.g.nodes.length; i++) {
      if (this.alpha[i]! < 0.25 || this.target[i]! < 0.25) continue;
      const p = this.project(i);
      if (!p) continue;
      const depth = this.camera.position.distanceTo(this.nodePos(i));
      const radius = Math.max(9, (this.g.nodes[i]!.size * 2.9 * scale) / depth / 2 / (window.devicePixelRatio || 1) + 4);
      const d = Math.hypot(p.x - clientX, p.y - clientY);
      if (d < radius && d - radius * 0.25 < bestD) { bestD = d; best = i; }
    }
    return best >= 0 ? this.g.nodes[best]!.id : null;
  }

  screenPos(id: string): { x: number; y: number } | null {
    const i = this.g?.index.get(id);
    return i == null ? null : this.project(i);
  }

  private pointScale() {
    const h = this.renderer.domElement.height;
    return h / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Copies layout positions and eased opacities into the GPU buffers. */
  private sync() {
    const g = this.g, l = this.layout;
    if (!g || !l || !this.nodes || !this.edges) return;
    const pos = this.nodes.geometry.getAttribute('position') as THREE.BufferAttribute;
    const al = this.nodes.geometry.getAttribute('alpha') as THREE.BufferAttribute;
    const P = pos.array as Float32Array, A = al.array as Float32Array;
    let moving = false;
    for (let i = 0; i < g.nodes.length; i++) {
      P[i * 3] = l.x[i]!; P[i * 3 + 1] = l.y[i]!; P[i * 3 + 2] = l.z[i]!;
      const a = this.alpha[i]!, t = this.target[i]!;
      if (Math.abs(a - t) > 0.004) { this.alpha[i] = a + (t - a) * 0.12; moving = true; } else this.alpha[i] = t;
      A[i] = this.alpha[i]! * (i === this.hovered ? 1 : 0.94);
    }
    pos.needsUpdate = true;
    al.needsUpdate = true;
    const epos = this.edges.geometry.getAttribute('position') as THREE.BufferAttribute;
    const ecol = this.edges.geometry.getAttribute('color') as THREE.BufferAttribute;
    const E = epos.array as Float32Array, C = ecol.array as Float32Array;
    g.edges.forEach((e, k) => {
      E[k * 6] = l.x[e.s]!; E[k * 6 + 1] = l.y[e.s]!; E[k * 6 + 2] = l.z[e.s]!;
      E[k * 6 + 3] = l.x[e.t]!; E[k * 6 + 4] = l.y[e.t]!; E[k * 6 + 5] = l.z[e.t]!;
      const touch = this.selected >= 0 && (e.s === this.selected || e.t === this.selected);
      const a = e.alpha * Math.min(this.alpha[e.s]!, this.alpha[e.t]!) * (touch ? 1.7 : this.selected >= 0 ? 0.55 : 1);
      const c = touch && e.kind === 'link' ? this.theme.iron : e.color;
      for (let j = 0; j < 2; j++) { C[k * 8 + j * 4] = c[0]; C[k * 8 + j * 4 + 1] = c[1]; C[k * 8 + j * 4 + 2] = c[2]; C[k * 8 + j * 4 + 3] = Math.min(1, a); }
    });
    epos.needsUpdate = true;
    ecol.needsUpdate = true;
    g.clusters.forEach((c, k) => {
      const sp = this.clouds[k];
      if (!sp) return;
      const vis = c.members.filter((i) => this.alpha[i]! > 0.05);
      sp.visible = vis.length > 0;
      if (!vis.length) return;
      const ext = clusterExtent(l, vis);
      sp.position.set(ext.x, ext.y, ext.z);
      sp.scale.setScalar(ext.r * 2.7 + 30);
    });
    if (this.selected >= 0 && this.alpha[this.selected]! > 0.05) {
      this.eye.visible = true;
      const ep = this.eye.geometry.getAttribute('position') as THREE.BufferAttribute;
      ep.setXYZ(0, l.x[this.selected]!, l.y[this.selected]!, l.z[this.selected]!);
      ep.needsUpdate = true;
      const es = this.eye.geometry.getAttribute('size') as THREE.BufferAttribute;
      es.setX(0, g.nodes[this.selected]!.size * 2.9 * 2.3);
      es.needsUpdate = true;
    } else this.eye.visible = false;
    return moving;
  }

  private frame() {
    const l = this.layout;
    if (l && !l.settled && !this.reduced) l.tick();
    if (this.tween) {
      const k = Math.min(1, (performance.now() - this.tween.t0) / this.tween.ms);
      const e = 1 - Math.pow(1 - k, 3);
      this.controls.target.lerpVectors(this.tween.from, this.tween.to, e);
      this.camera.position.lerpVectors(this.tween.camFrom, this.tween.camTo, e);
      if (k >= 1) this.tween = null;
    }
    // Drift again after a while left alone.
    if (!this.reduced && !this.theme.flat && !this.interacting && !this.tween && this.selected < 0 && performance.now() - this.idleSince > 6000) this.controls.autoRotate = true;
    this.controls.update();
    this.sync();
    const scale = this.pointScale();
    const dist = this.camera.position.distanceTo(this.controls.target);
    for (const o of [this.nodes, this.eye]) {
      if (!o) continue;
      const u = (o.material as THREE.ShaderMaterial).uniforms;
      u.scale!.value = scale;
      if (u.fogDensity && o === this.nodes) u.fogDensity.value = 0.75 / Math.max(120, dist * 1.4);
    }
    if (!this.reduced) (this.eye.material as THREE.ShaderMaterial).uniforms.pulse!.value = 0.75 + 0.25 * Math.sin(performance.now() / 600);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
    this.frames++;
  }

  private placeLabels() {
    const g = this.g;
    if (!g) return;
    const want = new Set(this.labelIds);
    for (const [id, el] of this.labelEls) if (!want.has(id)) { el.remove(); this.labelEls.delete(id); }
    const hostRect = this.host.getBoundingClientRect();
    for (const id of this.labelIds) {
      const i = g.index.get(id);
      if (i == null) continue;
      let el = this.labelEls.get(id);
      if (!el) {
        el = document.createElement('div');
        const n = g.nodes[i]!;
        el.className = `graph-label is-${n.kind}`;
        el.textContent = n.label;
        this.labels.appendChild(el);
        this.labelEls.set(id, el);
      }
      const p = this.project(i);
      const a = this.alpha[i]!;
      if (!p || a < 0.2) { el.style.opacity = '0'; continue; }
      el.style.opacity = String(Math.min(1, a) * (1 - Math.max(0, p.z - 0.985) * 40));
      el.style.transform = `translate(${p.x - hostRect.left}px, ${p.y - hostRect.top + g.nodes[i]!.size * 1.4 + 8}px) translate(-50%, 0)`;
      el.classList.toggle('is-selected', i === this.selected);
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => { (x as THREE.SpriteMaterial).map?.dispose(); x.dispose(); });
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.labels.remove();
  }
}

/** Whether WebGL works here at all (headless browsers without SwiftShader, locked-down devices). */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
