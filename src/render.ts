// Three.js view of a battle state. Reads the same state shape whether it comes from the local sim or the server.
// Look = "pixel diorama" (see the style guide): ortho iso camera, ~270-row render target upscaled nearest-neighbour,
// 3-step toon ramp, 1px ink outlines on figures, split-tone/vignette/dither post pass.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { animate } from 'animejs';
import { heightAt, lineDist, featureAt, riverAt } from './sim/world.ts';

// palette (sRGB hex, from the style guide)
const P = { fr: 0x3f6fdc, gb: 0xd8453a, pr: 0x3b4a85, nl: 0xd8872a, br: 0x2a2a2e, trim: 0xe9e4d6, ink: 0x14110d, skin: 0xd8b090, wood: 0x5a4128, brass: 0xd3a64e, steel: 0xb8bcc4,
  grassA: 0x7f9150, grassB: 0x8a9c58, wheat: 0xc9ab5a, wheatB: 0xb99b4c, ridge: 0x8f9456, lane: 0x8a6d4a, road: 0xb3a07a, woodFloor: 0x405836, denseFloor: 0x324a2b, water: 0x4a6f8f, ford: 0x7099b0, plaster: 0xd6c9a8, tile: 0xa4503a, pine: 0x2f4a2b,
  hedge: 0x3c5a2e, hedgeTop: 0x4a6b36, stone: 0x8d8777, cliff: 0x6b573d, plow: 0x6e5036, smoke: 0xf4f1ea, soil: 0x3a2c1f, horse: 0x6b4a34, pants: 0xe0dbcb };
const PLUME: Record<string, number> = { fr: 0xd8453a, gb: 0xe9e4d6, pr: 0xe9e4d6, nl: 0xd8872a, br: 0x1b1b1f };
const NAT: Record<string, number> = { fr: P.fr, gb: P.gb, pr: P.pr, nl: P.nl, br: P.br };
export const SIDE_COLOR = ['#6f9bff', '#ff6a5c'];
const lin = (hex: number) => { const c = new THREE.Color(hex); return { r: c.r, g: c.g, b: c.b }; };
// sr/sg/sb = haze colour (linear); fn/ff = fog start/end relative to the camera distance
const WEATHER: Record<string, any> = {
  clear: { ...rgb(lin(0x8f9fae)), fn: -8, ff: 150, sun: 2.4, hemi: 1.5, rain: 0 },
  rain: { ...rgb(lin(0x7d8995)), fn: -8, ff: 80, sun: 1.9, hemi: 1.7, rain: 0.6 },
  storm: { ...rgb(lin(0x59626c)), fn: -8, ff: 50, sun: 1.2, hemi: 1.2, rain: 1 },
};
function rgb(c: { r: number; g: number; b: number }) { return { sr: c.r, sg: c.g, sb: c.b }; }

const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
// ground detail tile (TTT/OpenKTG style: textures are code): RGBA = grass, wheat, plough, cobbles; each channel a tileable grey pattern, mean forced to 0.5
const DN = 64, DTEX = 0.25; // tile texels, world units per texel (~2 render px at the default zoom)
const ih = (x: number, y: number, s: number) => { let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
export function detailPixels() {
  const px = new Uint8Array(DN * DN * 4), ch = [0, 1, 2, 3].map(() => new Float32Array(DN * DN));
  const vn = (x: number, y: number, p: number, s: number) => { // value noise whose lattice wraps at the tile
    const c = DN / p, gx = x / c, gy = y / c, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), a = (i: number, j: number) => ih((ix + i) % p, (iy + j) % p, s);
    return (a(0, 0) * (1 - u) + a(1, 0) * u) * (1 - v) + (a(0, 1) * (1 - u) + a(1, 1) * u) * v;
  };
  for (let y = 0; y < DN; y++) for (let x = 0; x < DN; x++) {
    const i = y * DN + x;
    ch[0][i] = vn(x, y, 8, 1) * 0.5 + vn(x, y, 16, 2) * 0.3 + vn(x, y, 32, 3) * 0.2 + (ih(x, y, 4) > 0.93 ? 0.4 : 0); // clumps + tuft specks
    const k = x & 3; ch[1][i] = [0.2, 1, 0.65, 0.2][k] * (0.6 + 0.4 * ih(x >> 2, y >> 2, 5)) * (ih(x >> 2, y, 6) > 0.1 ? 1 : 0.3); // stalk rows along y, jittered
    ch[2][i] = 0.5 + 0.5 * Math.sin((y / 16) * Math.PI * 2 + 2 * vn(x, y, 8, 7)) + (ih(x, y, 8) > 0.9 ? 0.5 : 0); // furrows (wobbly) + clods
    let f1 = 99, f2 = 99, id = 0; const cx = x >> 4, cy = y >> 4; // 4x4 voronoi cells => cobbles
    for (let j = -1; j <= 1; j++) for (let k2 = -1; k2 <= 1; k2++) {
      const nx = cx + k2, ny = cy + j, wx = (nx + 4) % 4, wy = (ny + 4) % 4, d = Math.hypot(x - (nx + ih(wx, wy, 9)) * 16, y - (ny + ih(wx, wy, 10)) * 16);
      if (d < f1) { f2 = f1; f1 = d; id = ih(wx, wy, 11); } else if (d < f2) f2 = d;
    }
    ch[3][i] = Math.min(1, (f2 - f1) / 3) * 0.6 + id * 0.4; // dark mortar, per-stone tone
  }
  ch.forEach((c, k) => { let m = 0; for (const v of c) m += v; m = m / c.length - 0.5; for (let i = 0; i < c.length; i++) px[i * 4 + k] = Math.max(0, Math.min(255, Math.round((c[i] - m) * 255))); });
  return px;
}
/** Integer upscale for a window H physical pixels tall. Guide floors (always >= 270 rows); the rest round, so a ~950px window on a 1080p screen gets ~475 rows, not full resolution. */
export const upscale = (quality: number, H: number) => quality === 0 ? Math.max(2, Math.floor(H / 270)) : quality === 1 ? Math.max(2, Math.round(H / 360)) : quality === 2 ? Math.max(1, Math.round(H / 540)) : Math.max(1, Math.ceil(H / 1440));
const TILT = (35 * Math.PI) / 180, ISO = Math.PI / 4, CAM_D = 300, ZOOM_K = 0.36, STOPS = [28, 45, 64, 90, 130, 190, 280, 420];

// flat-coloured geometry helpers (vertex colours, non-indexed so toon steps stay crisp)
function paint(g: THREE.BufferGeometry, hex: number) {
  if (g.index && g.type !== 'BoxGeometry') g = g.toNonIndexed(); // boxes keep their index (24 verts, flat normals already)
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3)); g.deleteAttribute('uv'); g.computeVertexNormals();
  return g;
}
const bx = (w: number, h: number, d: number, x: number, y: number, z: number, hex: number) => paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex);
const cy = (r0: number, r1: number, h: number, seg: number, x: number, y: number, z: number, hex: number) => paint(new THREE.CylinderGeometry(r0, r1, h, seg).translate(x, y, z), hex);
const merge = (l: THREE.BufferGeometry[]) => mergeGeometries(l.some(g => !g.index) ? l.map(g => g.index ? g.toNonIndexed() : g) : l)!; // mergeGeometries needs all-or-none indexed

export function createView(host: HTMLElement) {
  // render quality: 0 Guide (strict 480x270 look, fixed zoom stops, 90-degree turns), 1 Fine (360 rows), 2 High (540+ rows), 3 Native (up to 1440 rows)
  const QUALITY = ['Guide: 270 rows, fixed zoom, 90 degree turns', 'Fine: 360 rows', 'High: 540+ rows', 'Native: full resolution up to 1440p'];
  let quality = 2;
  try { const q = localStorage.getItem('nic-quality'); if (q != null && Number(q) >= 0 && Number(q) <= 3) quality = Number(q); } catch { /* private mode */ }
  const guideOn = () => quality === 0;
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  canvas.style.imageRendering = 'pixelated';
  host.appendChild(canvas);
  const rt = new THREE.WebGLRenderTarget(480, 270, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.HalfFloatType });
  const post = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: rt.texture }, res: { value: new THREE.Vector2(480, 270) }, vig: { value: 0.5 }, warm: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: `precision highp float; varying vec2 vUv; uniform sampler2D tDiffuse; uniform vec2 res; uniform float vig; uniform float warm;
      float bayer(vec2 p){ vec2 q = mod(p, 4.); float x = q.x, y = q.y; float v = mod(x,2.)*8. + mod(y,2.)*4. + floor(x/2.)*2. + floor(y/2.); v = mod(v*7., 16.); return v/16.; }
      void main(){ vec3 c = pow(max(texture2D(tDiffuse, vUv).rgb, 0.), vec3(1./2.2)); float l = dot(c, vec3(.299,.587,.114));
        c = mix(c*vec3(.95,.99,1.05), c*vec3(1.05,1.0,.92), smoothstep(.25,.75,l)*warm);
        vec2 d = vUv-.5; c *= 1. - vig*dot(d,d);
        c += (bayer(floor(vUv*res)) - .5)/48.; c = floor(c*32.+.5)/32.;
        gl_FragColor = vec4(c,1.); }`,
    depthTest: false, depthWrite: false,
  });
  const postScene = new THREE.Scene(), postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post));

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x8f9fae, 1, 2);
  scene.background = new THREE.Color();
  const hemi = new THREE.HemisphereLight(0x8fa4c8, 0x4a4036, 1.1);
  const sun = new THREE.DirectionalLight(0xffd9a0, 2);
  sun.castShadow = true; sun.shadow.mapSize.set(quality >= 2 ? 4096 : 2048, quality >= 2 ? 4096 : 2048); sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.04;
  scene.add(hemi, sun, sun.target);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, CAM_D * 2);

  // 3-step toon ramp shared by everything lit
  const ramp = new THREE.DataTexture(new Uint8Array([120, 190, 255]), 3, 1, THREE.RedFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter; ramp.needsUpdate = true;
  // gunfire flash lights (q1k3 style): fixed pool in shared uniforms, every toon fragment loops all of them, falloff quantized to the toon look
  const FL = 16, flP = Array.from({ length: FL }, () => new THREE.Vector4(0, -999, 0, 1)), flC = Array.from({ length: FL }, () => new THREE.Vector3());
  const flU = { uFlP: { value: flP }, uFlC: { value: flC } };
  const flashHook = (sh: any) => { // one shared function => identical program cache key for every material
    Object.assign(sh.uniforms, flU);
    const pars = 'varying vec3 vFlW;';
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${pars}`).replace('#include <project_vertex>', `#include <project_vertex>
      vec4 flW = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
      flW = instanceMatrix * flW;
      #endif
      vFlW = ( modelMatrix * flW ).xyz;`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${pars}\nuniform vec4 uFlP[16]; uniform vec3 uFlC[16];`).replace('#include <opaque_fragment>', `vec3 flash = vec3( 0.0 );
      for ( int i = 0; i < 16; i ++ ) { float t = clamp( 1.0 - length( uFlP[ i ].xyz - vFlW ) / uFlP[ i ].w, 0.0, 1.0 ); flash += uFlC[ i ] * ( floor( smoothstep( 0.0, 1.0, t ) * 3.0 + 0.5 ) / 3.0 ); }
      outgoingLight += diffuseColor.rgb * flash;
      #include <opaque_fragment>`);
  };
  // terrain-only: modulate vertex colour by the detail tile; nearest + nearest mips so it stays crisp and fades to flat grey (no shimmer) when zoomed out
  const detail = new THREE.DataTexture(detailPixels(), DN, DN, THREE.RGBAFormat);
  detail.wrapS = detail.wrapT = THREE.RepeatWrapping; detail.magFilter = THREE.NearestFilter; detail.minFilter = THREE.NearestMipmapNearestFilter; detail.generateMipmaps = true; detail.needsUpdate = true;
  const terrainHook = (sh: any) => {
    flashHook(sh); sh.uniforms.uDetail = { value: detail };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aKind; varying vec4 vKind;').replace('#include <project_vertex>', '#include <project_vertex>\nvKind = aKind;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec4 vKind; uniform sampler2D uDetail;`).replace('#include <color_fragment>', `#include <color_fragment>
      diffuseColor.rgb *= 1.0 + ( dot( texture2D( uDetail, vFlW.xz / ${(DN * DTEX).toFixed(1)} ), vKind ) - 0.5 * dot( vKind, vec4( 1.0 ) ) ) * 0.25;`); // zero weights (wood, water) => no change
  };
  const toon = (o: THREE.MeshToonMaterialParameters = {}, hook = flashHook) => { const m = new THREE.MeshToonMaterial({ gradientMap: ramp, ...o }); m.onBeforeCompile = hook; return m; };

  // --- tweenable camera + atmosphere (plain objects driven by Anime.js) ---
  // cam.yaw = 0 is the default iso view (45deg); callers rotate relative to it.
  const cam = { x: 0, z: 0, dist: 90, yaw: 0, pitch: TILT };
  const tl = { v: TILT };
  let FS = 1; // tuning.figScale, read when a battle is set up
  let duskOn = false, silhouette = false;
  const shake = { v: 0 };
  const atm = { ...WEATHER.clear, tod: 0 };
  let camAnim: any = null, mapSize = 200, scn: any = null, tu: any = null;
  const sunDay = new THREE.Color(0xffd9a0), sunDusk = new THREE.Color(0xff9a4a);

  function applyAtm() {
    (scene.background as THREE.Color).setRGB(atm.sr, atm.sg, atm.sb);
    const f = scene.fog as THREE.Fog;
    f.color.setRGB(atm.sr, atm.sg, atm.sb); f.near = CAM_D + atm.fn; f.far = CAM_D + atm.ff;
    hemi.intensity = atm.hemi; sun.intensity = atm.sun;
    sun.color.copy(sunDay).lerp(sunDusk, atm.tod);
    post.uniforms.warm.value = 0.6 + 0.4 * (atm.sun > 1 ? 1 : atm.sun);
  }
  applyAtm();

  /** Animate light colour, fog and rain to a weather preset (instant = no tween). */
  function setWeather(w: string, instant = false) {
    const p = WEATHER[w] ?? WEATHER.clear;
    if (instant) { Object.assign(atm, p); applyAtm(); return; }
    animate(atm, { ...p, duration: 4000, ease: 'inOutSine', onUpdate: applyAtm });
  }

  function flyTo(x: number, z: number, dist?: number, ms = 1400) {
    camAnim?.pause();
    camAnim = animate(cam, { x, z, ...(dist ? { dist } : {}), duration: ms, ease: 'inOutQuad' });
    return camAnim;
  }
  function zoomBy(factor: number) {
    camAnim?.pause();
    if (guideOn()) {
      let i = STOPS.reduce((b, s, k) => (Math.abs(s - zoomTarget) < Math.abs(STOPS[b] - zoomTarget) ? k : b), 0);
      i = Math.max(0, Math.min(STOPS.length - 1, i + (factor > 1 ? 1 : -1))); zoomTarget = STOPS[i];
    } else zoomTarget = Math.max(18, Math.min(760, zoomTarget * factor));
    camAnim = animate(cam, { dist: zoomTarget, duration: 260, ease: 'outQuad' });
  }
  let zoomTarget = cam.dist;
  function rotate90(dir: number) {
    camAnim?.pause();
    camAnim = animate(cam, { yaw: Math.round(cam.yaw / (Math.PI / 2)) * (Math.PI / 2) + dir * (Math.PI / 2), duration: 350, ease: 'outQuad' });
  }
  function cycleQuality() {
    quality = (quality + 1) % 4;
    try { localStorage.setItem('nic-quality', String(quality)); } catch { /* ignore */ }
    resize();
    return QUALITY[quality];
  }
  function setDusk(on: boolean) { duskOn = on; }
  function setSilhouette(on: boolean) { silhouette = on; }
  function setTopDown(on: boolean) { animate(tl, { v: on ? (88 * Math.PI) / 180 : TILT, duration: 600, ease: 'inOutQuad' }); }
  function kick(amount: number) {
    if (amount < shake.v) return;
    animate(shake, { v: [amount, 0], duration: 500, ease: 'outExpo' });
  }
  function pan(dx: number, dz: number) {
    camAnim?.pause();
    const y = cam.yaw + ISO, c = Math.cos(y), s = Math.sin(y);
    dz /= Math.sin(tl.v); // iso squashes ground depth; keep W/S as fast as A/D on screen
    cam.x = Math.max(-mapSize / 2, Math.min(mapSize / 2, cam.x + dx * c + dz * s));
    cam.z = Math.max(-mapSize / 2, Math.min(mapSize / 2, cam.z - dx * s + dz * c));
  }

  // --- outlined instanced meshes ---------------------------------------------
  // Each mesh gets an inverted-hull twin sharing its matrices; hull grows 1 buffer pixel from a centre point (no corner gaps on boxes).
  const hullU = { uW: { value: 0.1 } };
  const outlined: { m: THREE.InstancedMesh; o: THREE.InstancedMesh }[] = [];
  function hullMat(c: [number, number, number]) {
    return new THREE.ShaderMaterial({
      uniforms: { uW: hullU.uW, uC: { value: new THREE.Vector3(...c) }, uInk: { value: new THREE.Color(P.ink) } },
      vertexShader: `uniform float uW; uniform vec3 uC; void main(){ float sc = length(instanceMatrix[0].xyz);
        vec3 p = position + normalize(position - uC + vec3(0.,.001,0.)) * (uW / sc); gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.); }`,
      fragmentShader: 'uniform vec3 uInk; void main(){ gl_FragColor = vec4(uInk, 1.); }',
      side: THREE.BackSide,
    });
  }
  function mkI(g: THREE.BufferGeometry, n: number, mat: THREE.Material, center: [number, number, number] | null, shadow = true) {
    const m = new THREE.InstancedMesh(g, mat, n);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.count = 0; m.frustumCulled = false; m.castShadow = shadow; m.receiveShadow = true; scene.add(m);
    if (center) {
      const o = new THREE.InstancedMesh(g, hullMat(center), n);
      o.instanceMatrix = m.instanceMatrix; o.count = 0; o.frustumCulled = false; scene.add(o); outlined.push({ m, o });
    }
    return m;
  }

  // --- static scenery ---------------------------------------------------------
  let terrain: THREE.Object3D[] = [];
  let vlabels: { el: HTMLElement; x: number; z: number }[] = [];
  const FG = 96;
  let fogTex: THREE.DataTexture | null = null, fogMesh: THREE.Mesh | null = null, fogT = 0;
  /** rebuild the veil from where your own units can see (mirrors the sim's sight rule) */
  function updateFog(state: any, viewer: number) {
    if (!fogMesh || !fogTex) return;
    fogMesh.visible = !!state.fog && !silhouette;
    if (!fogMesh.visible || clock - fogT < 0.4) return;
    fogT = clock;
    const wm = state.weather === 'storm' ? tu.sight.storm : state.weather === 'rain' ? tu.sight.rain : 1;
    const mine = state.units.filter((u: any) => u.side === viewer);
    const data = fogTex.image.data as Uint8Array;
    for (let gz = 0; gz < FG; gz++) for (let gx = 0; gx < FG; gx++) {
      const x = ((gx + 0.5) / FG - 0.5) * mapSize, z = ((gz + 0.5) / FG - 0.5) * mapSize;
      let a = 255;
      for (const u of mine) {
        const r = (tu.sight[u.type] ?? 70) * wm, d = Math.hypot(u.x - x, u.z - z);
        if (d < r) a = Math.min(a, d < r * 0.8 ? 0 : ((d - r * 0.8) / (r * 0.2)) * 255);
        if (a === 0) break;
      }
      data[gz * FG + gx] = a;
    }
    fogTex.needsUpdate = true;
  }
  let terrainMesh: THREE.Mesh | null = null;
  const zoneObjs: Record<string, { ring: THREE.Mesh; ring2: THREE.Mesh; flag: THREE.Mesh }> = {};
  function clearScene() {
    for (const o of terrain) {
      scene.remove(o); (o as any).geometry?.dispose?.();
      const i = outlined.findIndex((q) => q.m === o); if (i >= 0) { scene.remove(outlined[i].o); outlined.splice(i, 1); }
    }
    terrain = []; terrainMesh = null; crN = crI = 0; craters.count = 0;
    for (const k in zoneObjs) delete zoneObjs[k];
  }
  const add = (o: THREE.Object3D) => { scene.add(o); terrain.push(o); return o; };
  const STEP = 0.5; // chunky terrain: heights snap to half-unit steps
  const col = new THREE.Color();

  function setScenario(s: any, t: any) {
    clearScene();
    scn = s; tu = t; mapSize = s.map.size; FS = t.figScale ?? 1;
    const segs = Math.min(320, Math.round(mapSize / 1.6)); // ~2 units per cell on the big maps, so roads and fords stay continuous
    const geo = new THREE.PlaneGeometry(mapSize, mapSize, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, colA = new Float32Array(pos.count * 3), kindA = new Float32Array(pos.count * 4);
    const A = new THREE.Color(P.grassA), B = new THREE.Color(P.grassB), W = new THREE.Color(P.wheat), W2 = new THREE.Color(P.wheatB), R = new THREE.Color(P.ridge), CL = new THREE.Color(P.cliff);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      let h = heightAt(s, x, z), kd = 0; // kd: detail channel 0 grass, 1 wheat, 2 plough, 3 lane/village/road cobbles, -1 none
      const n = hash(Math.round(x * 0.5) * 31 + Math.round(z * 0.5) * 17);
      const field = Math.sin(x * 0.06 + z * 0.02) * Math.sin(z * 0.05 - x * 0.015) > 0.25;
      const plough = !field && Math.sin(x * 0.04 + 1) * Math.sin(z * 0.045 - 2) > 0.6;
      if (field) col.copy((Math.floor((x + z) / 2.4) & 1) ? W : W2);
      else if (plough) col.setHex(Math.floor(z / 1.6) & 1 ? P.plow : 0x5a4129);
      else col.copy((Math.floor(x / 2) + Math.floor(z / 2)) & 1 ? A : B);
      col.multiplyScalar(0.94 + n * 0.12);
      col.lerp(R, Math.min(0.6, Math.max(0, Math.floor((h + 0.35 * Math.sin(x * 0.9 + z * 0.5)) / 2) * 2) / 20)); // ridge bands with a zigzag edge, still stepping up to h~12
      const slope = (Math.abs(heightAt(s, x + 1.6, z) - heightAt(s, x, z)) + Math.abs(heightAt(s, x, z + 1.6) - heightAt(s, x, z))) / 1.6;
      if (slope > 0.3) col.lerp(CL, Math.min(0.6, (slope - 0.3) * 2)); // cliff faces
      kd = field ? 1 : plough ? 2 : 0;
      for (const w of s.map.woods ?? []) if (Math.hypot(x - w.x, z - w.z) < w.r) { col.setHex(w.dense ? P.denseFloor : P.woodFloor); kd = -1; }
      for (const v of s.map.villages ?? []) if (Math.hypot(x - v.x, z - v.z) < v.r) { col.setHex(P.lane); kd = 3; }
      for (const l of s.map.lanes ?? []) if (lineDist(l.pts, x, z) < l.w * 0.7) { col.setHex(P.lane); kd = 3; }
      for (const r of s.map.roads ?? []) if (lineDist(r.pts, x, z) < r.w * 0.7) { col.setHex(P.road).multiplyScalar(0.94 + n * 0.12); kd = 3; }
      const wet = riverAt(s, x, z);
      if (wet) { col.setHex(wet.ford ? P.ford : P.water); h -= wet.ford ? 0.3 : 0.6; kd = -1; } // fords: paler, shallower water
      if (kd >= 0) kindA[i * 4 + kd] = 1;
      pos.setY(i, Math.round(h / STEP) * STEP + (hash(Math.round(x * 3) * 17 + Math.round(z * 3) * 29) - 0.5) * 0.18); // faceted, low-poly ground
      colA.set([col.r, col.g, col.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colA, 3));
    geo.setAttribute('aKind', new THREE.BufferAttribute(kindA, 4)); // survives toNonIndexed; the fog veil shares the geometry but ignores it
    terrainMesh = new THREE.Mesh(geo.toNonIndexed(), toon({ vertexColors: true }, terrainHook));
    terrainMesh.geometry.computeVertexNormals();
    terrainMesh.receiveShadow = true;
    fogTex = new THREE.DataTexture(new Uint8Array(FG * FG), FG, FG, THREE.RedFormat);
    fogTex.minFilter = fogTex.magFilter = THREE.LinearFilter; fogTex.needsUpdate = true;
    fogMesh = new THREE.Mesh(terrainMesh.geometry, new THREE.ShaderMaterial({
      uniforms: { map: { value: fogTex }, size: { value: mapSize } }, transparent: true, depthWrite: false,
      vertexShader: 'varying vec2 vXZ; void main(){ vXZ = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position + vec3(0., 0.07, 0.), 1.); }',
      fragmentShader: 'uniform sampler2D map; uniform float size; varying vec2 vXZ; void main(){ float a = texture2D(map, vXZ / size + 0.5).r; gl_FragColor = vec4(0.03, 0.04, 0.07, a * 0.55); }',
    }));
    fogMesh.renderOrder = 1; fogMesh.visible = false; add(fogMesh);
    // raycast target must stay indexed-agnostic; fine as is
    add(terrainMesh);
    // soil plinth under the board
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(mapSize, 10, mapSize), toon({ color: P.soil }));
    plinth.position.y = -6.2; add(plinth);

    // trees: two-tier pines
    const treeSpots: [number, number][] = [];
    for (const w of s.map.woods ?? []) {
      const n = Math.round(w.r * w.r * (w.dense ? 0.2 : 0.13));
      for (let i = 0; i < n; i++) { const a = hash(i + w.x) * 6.28, r = Math.sqrt(hash(i * 3 + w.z)) * w.r; treeSpots.push([w.x + Math.cos(a) * r, w.z + Math.sin(a) * r]); }
    }
    for (let i = 0; i < 70; i++) { const x = (hash(i * 5 + 1) - 0.5) * (mapSize - 20), z = (hash(i * 11 + 2) - 0.5) * (mapSize - 20); if (featureAt(s, x, z).kind === 'open') treeSpots.push([x, z]); } // lone trees
    if (treeSpots.length) {
      const tg = merge([cy(0.15, 0.2, 1, 5, 0, 0.5, 0, P.wood), paint(new THREE.ConeGeometry(1.5, 2.2, 5).translate(0, 2.0, 0), P.pine), paint(new THREE.ConeGeometry(1.05, 1.9, 5).translate(0, 3.3, 0), 0x3b5d30)]);
      const trees = mkI(tg, treeSpots.length, toon({ vertexColors: true }), null);
      const d = new THREE.Object3D();
      treeSpots.forEach(([x, z], i) => { d.position.set(x, heightAt(s, x, z), z); d.rotation.y = hash(i) * 6; d.scale.setScalar(0.65 + hash(i + 9) * 0.5); d.updateMatrix(); trees.setMatrixAt(i, d.matrix); });
      trees.count = treeSpots.length; trees.instanceMatrix.needsUpdate = true; terrain.push(trees);
    }
    // scattered ground detail: grass tufts, rocks, wildflowers (all flat-shaded low poly)
    {
      const tuft = merge([paint(new THREE.ConeGeometry(0.1, 0.55, 3).translate(0, 0.27, 0), 0x6f8a3a), paint(new THREE.ConeGeometry(0.08, 0.42, 3).translate(0.16, 0.2, 0.08), 0x5d7a32), paint(new THREE.ConeGeometry(0.08, 0.38, 3).translate(-0.14, 0.18, -0.06), 0x7f9a44)]);
      const rock = paint(new THREE.IcosahedronGeometry(0.5, 0).scale(1, 0.6, 0.8).translate(0, 0.2, 0), 0x8d8777);
      const bloom = merge([bx(0.08, 0.3, 0.08, 0, 0.15, 0, 0x4a6b36), bx(0.2, 0.1, 0.2, 0, 0.34, 0, 0xe9e4d6)]);
      const kinds: [THREE.BufferGeometry, number, number][] = [[tuft, Math.round((mapSize * mapSize) / 40), 0.9], [rock, Math.round((mapSize * mapSize) / 300), 1.4], [bloom, Math.round((mapSize * mapSize) / 250), 1]]; // density follows the map area
      kinds.forEach(([g, count, sc], ki) => {
        const spots: [number, number][] = [];
        for (let i = 0; i < count * 2 && spots.length < count; i++) {
          const x = (hash(i * 7 + ki * 131 + 3) - 0.5) * (mapSize - 12), z = (hash(i * 13 + ki * 71 + 9) - 0.5) * (mapSize - 12);
          if (featureAt(s, x, z).kind === 'open') spots.push([x, z]);
        }
        if (!spots.length) return;
        const m = mkI(g, spots.length, toon({ vertexColors: true }), null, false);
        const d = new THREE.Object3D();
        spots.forEach(([x, z], i) => { d.position.set(x, heightAt(s, x, z), z); d.rotation.set(0, hash(i + ki) * 6.3, 0); d.scale.setScalar(sc * (0.7 + hash(i * 3 + ki) * 0.8)); d.updateMatrix(); m.setMatrixAt(i, d.matrix); });
        m.count = spots.length; m.instanceMatrix.needsUpdate = true; m.receiveShadow = true; terrain.push(m);
      });
    }
    // houses: plaster box + tile roof, outlined
    const houses: [number, number][] = [];
    for (const v of s.map.villages ?? []) {
      const n = Math.round(v.r * 0.9);
      for (let i = 0; i < n; i++) { const a = hash(i + v.x * 3) * 6.28, r = Math.sqrt(hash(i * 5 + v.z)) * v.r * 0.85; houses.push([v.x + Math.cos(a) * r, v.z + Math.sin(a) * r]); }
    }
    if (houses.length) {
      const hg = merge([bx(3.4, 2.4, 3, 0, 1.2, 0, P.plaster), paint(new THREE.ConeGeometry(2.7, 1.6, 4).rotateY(Math.PI / 4).translate(0, 3.2, 0), P.tile)]);
      const hs = mkI(hg, houses.length, toon({ vertexColors: true }), [0, 1.8, 0]);
      const d = new THREE.Object3D();
      houses.forEach(([x, z], i) => { d.position.set(x, heightAt(s, x, z), z); d.rotation.y = Math.round(hash(i * 7) * 4) * (Math.PI / 2); d.scale.setScalar(0.7); d.updateMatrix(); hs.setMatrixAt(i, d.matrix); });
      hs.count = houses.length; hs.instanceMatrix.needsUpdate = true; terrain.push(hs);
      outlined.find((q) => q.m === hs)!.o.count = houses.length;
    }
    // bridges: plank deck + rails across the river
    const bgs: THREE.BufferGeometry[] = [];
    for (const r of s.map.rivers ?? []) for (const [qx, qz] of r.bridges) {
      let bd = 1e9, ang = 0;
      for (let k = 0; k + 1 < r.pts.length; k++) {
        const [ax, az] = r.pts[k], [cx, cz] = r.pts[k + 1], dx = cx - ax, dz = cz - az, tt = Math.max(0, Math.min(1, ((qx - ax) * dx + (qz - az) * dz) / (dx * dx + dz * dz)));
        const d = Math.hypot(qx - ax - tt * dx, qz - az - tt * dz); if (d < bd) { bd = d; ang = Math.atan2(dx, dz); }
      }
      const len = r.width + 5, y = heightAt(s, qx, qz) + 0.1;
      for (const g of [bx(4.6, 0.35, len, 0, 0.2, 0, P.wood), bx(0.3, 0.8, len, 2.2, 0.7, 0, P.wood), bx(0.3, 0.8, len, -2.2, 0.7, 0, P.wood)]) bgs.push(g.rotateY(ang + Math.PI / 2).translate(qx, y, qz));
    }
    if (bgs.length) { const bm = new THREE.Mesh(merge(bgs), toon({ vertexColors: true })); bm.castShadow = bm.receiveShadow = true; add(bm); }
    // walled farms (outlined, one instance per farm)
    const farms = (s.map.villages ?? []).filter((v: any) => /Hougoumont|La Haye|Papelotte/.test(v.name ?? ''));
    if (farms.length) {
      const wg = merge([bx(15, 1.8, 0.7, 0, 0.9, -5.5, P.stone), bx(0.7, 1.8, 11, 7.5, 0.9, 0, P.stone), bx(0.7, 1.8, 11, -7.5, 0.9, 0, P.stone), bx(5.8, 1.8, 0.7, -4.6, 0.9, 5.5, P.stone), bx(5.8, 1.8, 0.7, 4.6, 0.9, 5.5, P.stone),
        bx(0.9, 2.4, 0.9, -1.6, 1.2, 5.5, P.stone), bx(0.9, 2.4, 0.9, 1.6, 1.2, 5.5, P.stone)]);
      const ws = mkI(wg, farms.length, toon({ vertexColors: true }), [0, 1, 0]);
      const d = new THREE.Object3D();
      farms.forEach((v: any, i: number) => { d.position.set(v.x, heightAt(s, v.x, v.z), v.z); d.scale.setScalar(Math.max(0.6, v.r / 8)); d.updateMatrix(); ws.setMatrixAt(i, d.matrix); });
      ws.count = farms.length; ws.instanceMatrix.needsUpdate = true; terrain.push(ws);
    }
    // hedgerows with gate gaps
    const hgs: THREE.BufferGeometry[] = [];
    for (const hd of s.map.hedges ?? []) for (let k = 0; k + 1 < hd.pts.length; k++) {
      const [ax, az] = hd.pts[k], [cx, cz] = hd.pts[k + 1], L = Math.hypot(cx - ax, cz - az), ang = Math.atan2(cx - ax, cz - az);
      for (let tp = 0, i = 0; tp < L; tp += 6, i++) {
        if (i % 6 === 5) continue; // gate
        const len = Math.min(6, L - tp) - 0.3, m = tp + len / 2 + 0.15, x = ax + Math.sin(ang) * m, z = az + Math.cos(ang) * m, y = heightAt(s, x, z);
        for (const g of [bx(0.9, 1.0, len, 0, 0.5, 0, P.hedge), bx(1.0, 0.3, len, 0, 1.1, 0, P.hedgeTop)]) hgs.push(g.rotateY(ang).translate(x, y, z));
      }
    }
    if (hgs.length) { const hm = new THREE.Mesh(merge(hgs), toon({ vertexColors: true })); hm.castShadow = hm.receiveShadow = true; add(hm); }
    for (const l of vlabels) l.el.remove();
    vlabels = [];
    for (const v of s.map.villages ?? []) if (v.name) { const el = document.createElement('div'); el.className = 'vlabel'; el.textContent = String(v.name).toUpperCase(); plates.appendChild(el); vlabels.push({ el, x: v.x, z: v.z }); }
    // objective zones: dashed terrain-following ring + flag
    for (const z of s.zones) {
      const N = 56, pts: number[] = [], pts2: number[] = [];
      for (let k = 0; k < N; k++) {
        const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2;
        const q = (a: number, r: number): [number, number, number] => { const x = z.x + Math.cos(a) * r, zz = z.z + Math.sin(a) * r; return [x, heightAt(s, x, zz) + 0.45, zz]; };
        const a = q(a0, z.r - 0.8), b = q(a0, z.r), c = q(a1, z.r), d = q(a1, z.r - 0.8);
        (k & 1 ? pts2 : pts).push(...a, ...b, ...c, ...a, ...c, ...d);
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const ring = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
      const g2 = new THREE.BufferGeometry(); g2.setAttribute('position', new THREE.Float32BufferAttribute(pts2, 3));
      const ring2 = new THREE.Mesh(g2, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 7, 5), toon({ color: P.steel }));
      pole.position.set(z.x, heightAt(s, z.x, z.z) + 3.5, z.z);
      const flag = new THREE.Mesh(new THREE.BoxGeometry(3, 1.8, 0.1), toon({ color: 0xcccccc }));
      flag.position.set(z.x + 1.6, heightAt(s, z.x, z.z) + 6, z.z);
      pole.castShadow = flag.castShadow = true;
      add(ring); add(ring2); add(pole); add(flag);
      zoneObjs[z.id] = { ring, ring2, flag };
    }
    cam.x = 0; cam.z = 0;
    setWeather(s.weather ?? 'clear', true);
  }

  // --- units: blocky figures (coat takes the nation colour, kit is fixed colours) ----------------
  // --- soldier: coat takes the nation colour (instance tint); everything else is fixed kit
  const W = 0xffffff, DK = 0x1b1b1f;
  const coatArms = merge([bx(0.56, 0.58, 0.34, 0, 0.93, 0, W), bx(0.5, 0.2, 0.3, 0, 0.62, 0, W), bx(0.13, 0.5, 0.15, 0.35, 0.9, 0.02, W), bx(0.13, 0.5, 0.15, -0.35, 0.9, 0.02, W)]);
  const belt = (rot: number) => paint(new THREE.BoxGeometry(0.07, 0.62, 0.02).rotateZ(rot).translate(0, 0.95, 0.18), P.trim);
  const kitG = merge([
    belt(0.65), belt(-0.65), bx(0.32, 0.06, 0.04, 0, 0.67, 0.18, DK), bx(0.07, 0.07, 0.03, 0, 0.67, 0.2, P.brass), // cross-belts, waist belt, buckle
    bx(0.14, 0.1, 0.16, 0.35, 0.62, 0.02, P.trim), bx(0.14, 0.1, 0.16, -0.35, 0.62, 0.02, P.trim), // cuffs
    bx(0.11, 0.11, 0.12, 0.35, 0.54, 0.04, P.skin), bx(0.11, 0.11, 0.12, -0.35, 0.54, 0.04, P.skin), // hands
    bx(0.32, 0.08, 0.22, 0, 1.23, 0, 0xc23a2e), // collar
    bx(0.24, 0.26, 0.24, 0, 1.38, 0, P.skin), bx(0.04, 0.04, 0.02, 0.06, 1.41, 0.125, DK), bx(0.04, 0.04, 0.02, -0.06, 1.41, 0.125, DK), // head, eyes
    bx(0.27, 0.32, 0.27, 0, 1.66, 0, DK), bx(0.3, 0.05, 0.3, 0, 1.84, 0, DK), bx(0.12, 0.12, 0.02, 0, 1.64, 0.14, P.brass), bx(0.26, 0.03, 0.1, 0, 1.52, 0.17, DK), // shako
    bx(0.36, 0.32, 0.14, 0, 0.98, -0.24, 0x6a4a2e), bx(0.42, 0.1, 0.14, 0, 1.18, -0.25, 0x8a8576), // knapsack and bedroll
    bx(0.05, 0.05, 1.05, 0.3, 1.0, 0.3, P.wood), bx(0.03, 0.03, 0.32, 0.3, 1.0, 0.92, P.steel), // musket and bayonet
    bx(0.09, 0.42, 0.02, 0.15, 0.95, 0.172, P.trim), bx(0.09, 0.42, 0.02, -0.15, 0.95, 0.172, P.trim), // white lapels
    bx(0.16, 0.05, 0.2, 0.3, 1.23, 0, P.trim), bx(0.16, 0.05, 0.2, -0.3, 1.23, 0, P.trim), // epaulettes
    bx(0.2, 0.14, 0.1, -0.2, 0.68, -0.21, DK), bx(0.1, 0.16, 0.1, 0.24, 0.62, -0.19, 0x8a8576), // cartridge box, canteen
    bx(0.22, 0.07, 0.1, 0, 1.5, -0.14, DK), bx(0.05, 0.06, 0.03, 0.08, 1.33, 0.13, 0x3a2a1a), bx(0.05, 0.06, 0.03, -0.08, 1.33, 0.13, 0x3a2a1a), // queue, side-whiskers
  ]);
  // --- horse: white body parts take a coat tint per horse (bay, chestnut, black, grey); mane, tail and hooves stay dark
  const HD = 0x2a2a2a;
  const horseParts: THREE.BufferGeometry[] = [
    bx(0.72, 0.68, 1.5, 0, 1.0, 0, W), bx(0.66, 0.74, 0.5, 0, 1.05, 0.8, W),
    paint(new THREE.BoxGeometry(0.3, 0.75, 0.36).rotateX(-0.55).translate(0, 1.6, 1.15), W),
    paint(new THREE.BoxGeometry(0.24, 0.26, 0.55).rotateX(0.4).translate(0, 1.88, 1.52), W),
    bx(0.06, 0.14, 0.05, 0.08, 2.06, 1.36, HD), bx(0.06, 0.14, 0.05, -0.08, 2.06, 1.36, HD), bx(0.08, 0.5, 0.12, 0, 1.78, 1.0, HD), bx(0.12, 0.6, 0.14, 0, 0.95, -0.82, HD),
    bx(0.76, 0.06, 0.62, 0, 1.36, -0.05, 0x6a2a2a), bx(0.5, 0.1, 0.4, 0, 1.42, -0.05, 0x3a2a1a),
    bx(0.26, 0.04, 0.06, 0, 1.84, 1.64, 0x3a2a1a), bx(0.03, 0.04, 0.02, 0.11, 1.93, 1.6, HD), bx(0.03, 0.04, 0.02, -0.11, 1.93, 1.6, HD), bx(0.06, 0.12, 0.04, 0, 2.02, 1.46, HD), // bridle, eyes, forelock
    bx(0.04, 0.22, 0.1, 0.42, 1.15, -0.05, P.steel), bx(0.04, 0.22, 0.1, -0.42, 1.15, -0.05, P.steel), // stirrups
  ];
  for (const [lx, lz] of [[0.24, 0.65], [-0.24, 0.65], [0.24, -0.6], [-0.24, -0.6]]) horseParts.push(bx(0.17, 0.42, 0.19, lx, 0.55, lz, W), bx(0.13, 0.3, 0.15, lx, 0.17, lz, W), bx(0.15, 0.08, 0.18, lx, 0.04, lz, HD));
  const horseG = merge(horseParts);
  // --- field gun: barrel with muzzle swell, cheeks, trail, spoked wheels
  const gunParts: THREE.BufferGeometry[] = [
    paint(new THREE.CylinderGeometry(0.2, 0.27, 2.3, 8).rotateX(Math.PI / 2).translate(0, 1.0, 0.55), 0x2a2a2e),
    paint(new THREE.CylinderGeometry(0.3, 0.3, 0.16, 8).rotateX(Math.PI / 2).translate(0, 1.0, 1.75), 0x2a2a2e),
    bx(0.12, 0.34, 1.5, 0.25, 0.85, 0.1, P.wood), bx(0.12, 0.34, 1.5, -0.25, 0.85, 0.1, P.wood), bx(0.2, 0.12, 1.5, 0, 0.6, -1.2, P.wood),
  ];
  for (const sx of [0.68, -0.68]) gunParts.push(paint(new THREE.TorusGeometry(0.78, 0.08, 4, 10).rotateY(Math.PI / 2).translate(sx, 0.8, 0), P.wood), bx(0.07, 1.5, 0.07, sx, 0.8, 0, P.wood), bx(0.07, 0.07, 1.5, sx, 0.8, 0, P.wood), bx(0.14, 0.2, 0.2, sx, 0.8, 0, 0x2a2a2e));
  gunParts.push(bx(0.55, 0.4, 0.6, 0, 0.8, -2.0, 0x4a5a34), bx(0.05, 0.05, 1.7, 0.36, 1.32, 0.2, P.wood), bx(0.1, 0.1, 0.12, 0.36, 1.32, 1.1, 0x8a8576));
  for (const [ax, az] of [[-0.9, -0.5], [-0.75, -0.3], [-1.05, -0.3], [-0.9, -0.1]]) gunParts.push(bx(0.2, 0.2, 0.2, ax, 0.12, az, 0x2a2a2e)); // shot pile
  const gunG = merge(gunParts);
  const foot = mkI(coatArms, 5000, toon({ color: 0xffffff }), [0, 0.85, 0], false);
  foot.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(5000 * 3), 3);
  const kit = mkI(kitG, 5000, toon({ vertexColors: true }), [0, 0.85, 0], false);
  // legs hang from the hip so they can swing when the unit marches
  const legG = (x: number) => merge([bx(0.19, 0.2, 0.25, x, -0.44, 0.02, DK), bx(0.18, 0.34, 0.22, x, -0.17, 0, P.pants)]);
  const legL = mkI(legG(0.13), 5000, toon({ vertexColors: true }), [0, -0.27, 0], false);
  const legR = mkI(legG(-0.13), 5000, toon({ vertexColors: true }), [0, -0.27, 0], false);
  // one invisible box casts the whole soldier's shadow (4 meshes of 29+ boxes were too heavy); slightly inside the silhouette so it never darkens the figure
  const shadowP = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 1.8, 0.28).translate(0, 0.9, 0), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), 5000);
  shadowP.instanceMatrix = foot.instanceMatrix; shadowP.count = 0; shadowP.frustumCulled = false; shadowP.castShadow = true; shadowP.receiveShadow = false; scene.add(shadowP);
  // Guard bearskins, and one standard per infantry regiment (pole + finial, waving banner in the nation's colour, gold eagle)
  const bearM = mkI(merge([bx(0.34, 0.6, 0.32, 0, 1.98, 0, DK), bx(0.14, 0.14, 0.02, 0, 1.84, 0.17, P.brass), bx(0.1, 0.36, 0.1, 0.1, 2.42, 0, 0xd8453a)]), 1500, toon({ vertexColors: true }), null, false);
  const flagM = mkI(merge([bx(0.07, 3.6, 0.07, 0, 1.8, 0, P.wood), bx(0.18, 0.2, 0.18, 0, 3.7, 0, P.brass)]), 400, toon({ vertexColors: true }), [0, 1.8, 0], false);
  const bannerM = mkI(paint(new THREE.BoxGeometry(1.0, 0.75, 0.05).translate(0.55, 3.1, 0), 0xffffff), 400, toon({ color: 0xffffff }), null, false);
  const eagleM = mkI(paint(new THREE.BoxGeometry(0.32, 0.32, 0.07).translate(0.55, 3.1, 0), P.brass), 400, toon({ vertexColors: true }), null, false);
  const horses = mkI(horseG, 1500, toon({ vertexColors: true }), [0, 1.0, 0]);
  const HORSE_COL = [0x7a5236, 0x9a6638, 0x34302c, 0xa8a49a].map((h) => new THREE.Color(h));
  const guns = mkI(gunG, 300, toon({ vertexColors: true }), [0, 0.9, 0.3]);
  // gear that rides on the figures: plumes (nation colour), cuirassier helmets + breastplates, lances + pennants
  const plumeM = mkI(paint(new THREE.BoxGeometry(0.14, 0.28, 0.14).translate(0, 1.92, 0), 0xffffff), 5000, toon({ color: 0xffffff }), null, false);
  const cuirM = mkI(merge([bx(0.64, 0.52, 0.42, 0, 0.88, 0, P.steel), bx(0.38, 0.5, 0.36, 0, 1.68, 0, P.steel), bx(0.08, 0.26, 0.42, 0, 2.02, -0.02, 0x1b1b1f), bx(0.04, 0.04, 1.2, -0.42, 1.0, 0.45, P.steel), bx(0.1, 0.06, 0.1, -0.42, 1.0, -0.12, P.brass)]), 1500, toon({ vertexColors: true }), null, false); // plus sabre
  const capM = mkI(merge([bx(0.44, 0.1, 0.44, 0, 1.92, 0, 0xc23a2e), bx(0.3, 0.05, 0.3, 0, 1.62, 0, P.brass)]), 1500, toon({ vertexColors: true }), null, false); // uhlan czapka
  const skirM = mkI(merge([bx(0.18, 0.08, 0.18, 0.31, 1.22, 0, 0x4a8a3a), bx(0.18, 0.08, 0.18, -0.31, 1.22, 0, 0x4a8a3a), bx(0.3, 0.05, 0.04, 0, 1.52, 0.15, 0xe8c030)]), 2500, toon({ vertexColors: true }), null, false); // light-company epaulettes and cord
  const bicM = mkI(merge([bx(0.52, 0.12, 0.3, 0, 1.8, 0, DK), bx(0.1, 0.1, 0.03, 0.2, 1.84, 0.16, 0xd8453a), bx(0.5, 0.07, 0.04, 0, 1.66, 0.15, P.brass)]), 200, toon({ vertexColors: true }), null, false); // commander's bicorne
  const lanceM = mkI(merge([bx(0.05, 2.7, 0.05, 0.42, 1.55, 0.25, P.wood), bx(0.07, 0.2, 0.07, 0.42, 2.95, 0.25, P.steel)]), 1500, toon({ vertexColors: true }), null, false);
  const pennM = mkI(paint(new THREE.BoxGeometry(0.4, 0.22, 0.03).translate(0.64, 2.75, 0.25), 0xffffff), 1500, toon({ color: 0xffffff }), null, false);

  // 2D pixel effect sprites (rows: powder puff, muzzle flash, shell burst, dust kick), one instanced billboard draw
  const FRAMES = [6, 3, 6, 4];
  const sheet = (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const g = c.getContext('2d')!; let ox = 0, oy = 0;
    const bay = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
    const px = (x: number, y: number, col: string) => { g.fillStyle = col; g.fillRect(ox + x, oy + y, 1, 1); };
    const blob = (cx: number, cy: number, r: number, f: number, tones: string[], dither: number) => {
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx * 0.95, dy * 1.05) + (Math.sin(x * 1.7 + f) + Math.cos(y * 1.3 - f)) * 0.7;
        if (d > r) continue;
        if (dither && d > r * 0.72 && bay[y & 3][x & 3] / 16 < ((d - r * 0.72) / (r * 0.28)) * dither) continue;
        const lit = (-dx - dy) / (r * 1.1); px(x, y, lit > 0.25 ? tones[0] : lit > -0.25 ? tones[1] : tones[2]);
      }
    };
    for (let f = 0; f < 6; f++) { ox = f * 32; oy = 0; blob(16, 22 - f * 1.6, 4 + f * 2.3, f, ['#f1ede2', '#d6d1c4', '#a6a399'], f > 3 ? (f - 3) * 0.9 : 0); }
    for (let f = 0; f < 3; f++) {
      ox = f * 32; oy = 32;
      const L = [9, 6, 3][f];
      [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]].forEach(([ax, ay], i) => { const len = i < 4 ? L : L * 0.55; for (let k = 1; k <= len; k++) px(16 + ax * k, 16 + ay * k, k < len * 0.5 ? '#fff3b0' : '#ffb23e'); });
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) if (Math.abs(x) + Math.abs(y) <= 2 - (f > 1 ? 1 : 0)) px(16 + x, 16 + y, '#fffbe0');
    }
    for (let f = 0; f < 6; f++) {
      ox = f * 32; oy = 64;
      const r = [3, 6, 8, 7, 5, 3][f];
      blob(16, 17 - f, r + 2, f * 2, f < 3 ? ['#fff3b0', '#ffb23e', '#e0601f'] : ['#6b5f58', '#4b423d', '#322c29'], f > 3 ? 0.7 : 0);
      if (f < 4) blob(16, 17 - f, r - 2 + (f ? 0 : 1), f, ['#fff9d6', '#ffd45a', '#ffb23e'], 0);
    }
    for (let f = 0; f < 4; f++) {
      ox = f * 32; oy = 96;
      const sp = f * 2.2;
      [[-1, 0], [1, 0], [0, -1], [-0.6, -0.8], [0.6, -0.8]].forEach(([dx, dy], i) => blob(16 + dx * sp * 2, 24 + dy * sp * 1.5 - f * 0.5, 2 + f * 0.4, i, ['#d2bb92', '#b09670', '#8a7452'], f > 2 ? 0.8 : 0));
    }
    return c;
  })();
  const fxTex = new THREE.CanvasTexture(sheet);
  fxTex.magFilter = fxTex.minFilter = THREE.NearestFilter; fxTex.generateMipmaps = false; fxTex.colorSpace = THREE.SRGBColorSpace;
  const FX_MAX = 900, fxAttr = new THREE.InstancedBufferAttribute(new Float32Array(FX_MAX * 3), 3);
  const fxGeo = new THREE.PlaneGeometry(1, 1); fxGeo.setAttribute('aFx', fxAttr);
  const fxMesh = new THREE.InstancedMesh(fxGeo, new THREE.ShaderMaterial({
    uniforms: { map: { value: fxTex } }, side: THREE.DoubleSide,
    vertexShader: `attribute vec3 aFx; varying vec2 vUv;
      void main(){ vec3 c = (modelMatrix * instanceMatrix * vec4(0.,0.,0.,1.)).xyz;
        vec3 r = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), u = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vUv = (vec2(aFx.x, 3. - aFx.y) + uv) / vec2(8., 4.);
        gl_Position = projectionMatrix * viewMatrix * vec4(c + (r * position.x + u * position.y) * aFx.z, 1.); }`,
    fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main(){ vec4 t = texture2D(map, vUv); if (t.a < .5) discard; gl_FragColor = vec4(t.rgb, 1.); }',
  }), FX_MAX);
  fxMesh.count = 0; fxMesh.frustumCulled = false; scene.add(fxMesh);
  type Fx = { row: number; x: number; y: number; z: number; age: number; life: number; size: number; vx: number; vy: number; vz: number };
  const fxs: Fx[] = [];
  const spawn = (row: number, x: number, y: number, z: number, life: number, size: number, vx = 0, vy = 0, vz = 0, delay = 0) => { if (fxs.length < FX_MAX - 300) fxs.push({ row, x, y, z, age: -delay, life, size, vx, vy, vz }); }; // delay: starts hidden, so a volley can ripple

  type Vis = { x: number; z: number; f: number; off: Float32Array; form: string; n?: number };
  const vis = new Map<number, Vis>();
  const dummy = new THREE.Object3D();
  dummy.rotation.order = 'YXZ';
  const WHITE = new THREE.Color(0xffffff);
  // scorch marks left by blasts and destroyed regiments
  const CR_MAX = 200;
  const craters = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 9).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3a2d20, transparent: true, opacity: 0.7 }), CR_MAX);
  craters.count = 0; craters.frustumCulled = false; scene.add(craters);
  let crN = 0, crI = 0;
  function crater(x: number, z: number, r: number) {
    dummy.position.set(x, heightAt(scn, x, z) + 0.35, z); dummy.rotation.set(0, Math.random() * 6, 0); dummy.scale.setScalar(r); dummy.updateMatrix();
    craters.setMatrixAt(crI, dummy.matrix); crI = (crI + 1) % CR_MAX; crN = Math.min(CR_MAX, crN + 1); craters.count = crN; craters.instanceMatrix.needsUpdate = true;
  }
  function popText(x: number, z: number, text: string, ours: boolean) {
    const p = toScreen(x, z); if (!p.ok) return;
    const cr = canvas.getBoundingClientRect(), el = document.createElement('div');
    el.className = `pop big ${ours ? 'ours' : 'foe'}`; el.textContent = text;
    el.style.left = `${Math.round((p.x - cr.left) / hs)}px`; el.style.top = `${Math.round((p.y - cr.top) / hs) - 16}px`;
    plates.appendChild(el);
    animate(el, { translateY: [0, -16], opacity: [1, 0], duration: 1600, ease: 'outQuad', onComplete: () => el.remove() });
  }
  /** floating casualty number: gold for enemy losses, red for ours */
  function popNum(x: number, z: number, n: number, ours: boolean) {
    const p = toScreen(x, z); if (!p.ok) return;
    const cr = canvas.getBoundingClientRect(), el = document.createElement('div');
    el.className = `pop ${ours ? 'ours' : 'foe'}`; el.textContent = `-${n}`;
    el.style.left = `${Math.round((p.x - cr.left) / hs)}px`; el.style.top = `${Math.round((p.y - cr.top) / hs) - 10}px`;
    plates.appendChild(el);
    animate(el, { translateY: [0, -12], opacity: [1, 0], duration: 1100, ease: 'outQuad', onComplete: () => el.remove() });
  }
  const tmpC = new THREE.Color(), tmpC2 = new THREE.Color(), plumeC = new THREE.Color();

  function slots(u: any, n: number, i: number, out: number[]) {
    const kind = u.type;
    if (u.garrison != null) { out[0] = ((i % 5) - 2) * 1.25; out[1] = -Math.floor(i / 5) * 1.2; return; }
    if (u.routed) { out[0] = (hash(i * 3 + u.id) - 0.5) * 16; out[1] = (hash(i * 7 + u.id) - 0.5) * 10; return; } // broken ranks scatter
    if (kind === 'skirmisher') { out[0] = (hash(i * 3 + u.id) - 0.5) * 16; out[1] = (hash(i * 7 + u.id) - 0.5) * 7; return; }
    if (kind === 'lancer' || kind === 'cuirassier') {
      const cols = n > 10 ? Math.ceil(n / 2) : n, r = Math.floor(i / cols), c = i % cols;
      out[0] = (c - (cols - 1) / 2) * 2.4; out[1] = r * -3; return;
    }
    if (u.form === 'column') { const r = Math.floor(i / 3), c = i % 3; out[0] = (c - 1) * 1.5; out[1] = -r * 1.5 + n / 6; return; }
    if (u.form === 'square') {
      const k = Math.max(2, Math.ceil(n / 4) + 1), per = 4 * (k - 1), p = i % per, side = Math.floor(p / (k - 1)), t = (p % (k - 1)) / (k - 1), h = (k - 1) * 0.8;
      const a = -h + 2 * h * t;
      out[0] = side === 0 ? a : side === 1 ? h : side === 2 ? -a : -h;
      out[1] = side === 0 ? h : side === 1 ? -a : side === 2 ? -h : a; return;
    }
    const ranks = n > 24 ? 3 : 2, cols = Math.ceil(n / ranks), r = Math.floor(i / cols), c = i % cols;
    out[0] = (c - (cols - 1) / 2) * 1.3; out[1] = -r * 1.5;
  }

  function putLeg(mesh: THREE.InstancedMesh, idx: number, x: number, y: number, z: number, yaw: number, swing: number, sc: number) {
    dummy.position.set(x, y + 0.54 * sc, z); dummy.rotation.set(swing, yaw, 0); dummy.scale.setScalar(sc); dummy.updateMatrix();
    mesh.setMatrixAt(idx, dummy.matrix); dummy.rotation.set(0, 0, 0);
  }
  function put(mesh: THREE.InstancedMesh, idx: number, x: number, y: number, z: number, rot: number, sc = 1) {
    dummy.position.set(x, y, z); dummy.rotation.set(0, rot, 0); dummy.scale.setScalar(sc); dummy.updateMatrix();
    mesh.setMatrixAt(idx, dummy.matrix);
  }

  const plates = document.createElement('div');
  plates.className = 'plates';
  host.appendChild(plates);
  type Plate = { el: HTMLElement; men: HTMLElement; mor: HTMLElement; name: HTMLElement; lm: number; lmo: number; ls: string; mc: string; lab: string };
  const plateMap = new Map<number, Plate>();
  const selected = new Set<number>();
  const v3 = new THREE.Vector3();
  let rain: THREE.LineSegments | null = null;
  const rainPos = new Float32Array(1400 * 6);
  {
    const g = new THREE.BufferGeometry();
    for (let i = 0; i < 1400; i++) { const x = (Math.random() - 0.5) * 160, y = Math.random() * 60, z = (Math.random() - 0.5) * 160; rainPos.set([x, y, z, x - 0.3, y - 2.2, z], i * 6); }
    g.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xc8d2e0, transparent: true, opacity: 0.45 }));
    rain.frustumCulled = false; rain.visible = false; scene.add(rain);
  }

  // selection / order overlays
  const selRings: THREE.Mesh[] = [];
  const ringGeo = new THREE.RingGeometry(0.88, 1, 24).rotateX(-Math.PI / 2);
  const ringMat = (c: number) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide });
  for (let i = 0; i < 60; i++) { const m = new THREE.Mesh(ringGeo, ringMat(P.brass)); m.visible = false; m.renderOrder = 5; scene.add(m); selRings.push(m); }
  // firing-range rings for selected regiments (thin, so a 95-unit gun ring doesn't become a band)
  const rangeGeo = new THREE.RingGeometry(0.985, 1, 72).rotateX(-Math.PI / 2), rangeRings: THREE.Mesh[] = [];
  for (let i = 0; i < 60; i++) { const m = new THREE.Mesh(rangeGeo, new THREE.MeshBasicMaterial({ color: 0xe9e4d6, transparent: true, opacity: 0.35, depthTest: false, side: THREE.DoubleSide })); m.visible = false; m.renderOrder = 4; scene.add(m); rangeRings.push(m); }
  let refillHint = false, dragLine: { ax: number; az: number; bx: number; bz: number; f: number } | null = null;
  const fxRings: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) { const m = new THREE.Mesh(ringGeo, ringMat(0xff5533)); m.visible = false; m.renderOrder = 5; scene.add(m); fxRings.push(m); }
  const reticle = new THREE.Mesh(ringGeo, ringMat(0xffffff)); reticle.visible = false; reticle.renderOrder = 6; scene.add(reticle);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(120 * 3), 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0x9be37a, transparent: true, opacity: 0.85, depthTest: false }));
  lines.frustumCulled = false; lines.renderOrder = 4; scene.add(lines);

  type Flash = { x: number; y: number; z: number; r: number; c: THREE.Color; age: number; life: number; w: number };
  const flashes: Flash[] = [], FLC = [new THREE.Color('#ffd45a'), new THREE.Color('#ffb23e'), new THREE.Color('#e0601f')];
  // no cap: flashes live 0.12-0.5 s and only the best 16 reach the GPU, so a far volley can't crowd out a near cannon
  const flash = (x: number, y: number, z: number, r: number, c: number, life: number, w: number) => flashes.push({ x, y, z, r, c: FLC[c], age: 0, life, w });
  function lightFlashes(dt: number) {
    const boost = 1 + 0.7 * Math.max(0, 1 - atm.sun / 2) + 0.3 * atm.tod; // read more at dusk and in storms
    for (let i = flashes.length - 1; i >= 0; i--) if ((flashes[i].age += dt) >= flashes[i].life) flashes.splice(i, 1);
    // [fade, nearness, flash]: fast attack, quick decay; ranked by fade * nearness to the camera
    const live = flashes.map((f) => { const u = f.age / f.life, a = u < 0.15 ? u / 0.15 : (1 - u) / 0.85; return [f.w * a * a, 1 / (1 + (Math.hypot(f.x - cam.x, f.z - cam.z) / 70) ** 2), f] as const; }).sort((p, q) => q[0] * q[1] - p[0] * p[1]);
    for (let i = 0; i < FL; i++) {
      const l = live[i]; if (!l) { flC[i].set(0, 0, 0); continue; }
      const [fade, near, f] = l;
      flP[i].set(f.x, f.y, f.z, f.r); flC[i].set(f.c.r, f.c.g, f.c.b).multiplyScalar(fade * boost * (0.6 + 0.4 * near));
    }
  }

  let prevWeather = '';
  let clock = 0;

  function eat(events: any[], viewer: number) {
    const dist2 = (x: number, z: number) => Math.hypot(x - cam.x, z - cam.z);
    for (const e of events) {
      if (e.k === 'shot') {
        const dx = e.tx - e.x, dz = e.tz - e.z, d = Math.hypot(dx, dz) || 1, y = heightAt(scn, e.x, e.z) + 1.6;
        if (e.a || !e.w) spawn(1, e.x + (dx / d) * 2, y, e.z + (dz / d) * 2, 0.15, e.a ? 5 : 3);
        else { // musket volley: flashes ripple down the whole firing line, then a bank of powder smoke rolls out
          const n = Math.max(2, Math.min(9, Math.round(e.w / 3))), px = -dz / d, pz = dx / d;
          for (let i = 0; i < n; i++) {
            const o = (i / (n - 1) - 0.5) * e.w, fx = e.x + px * o + (dx / d) * 1.5, fz = e.z + pz * o + (dz / d) * 1.5;
            spawn(1, fx, y, fz, 0.15, 2.4, 0, 0, 0, i * 0.035 + Math.random() * 0.03);
            if (i % 2 === 0) spawn(0, fx + (dx / d) * 1.5, y + 0.3, fz + (dz / d) * 1.5, 3.5, 3, (dx / d) * 0.6, 0.35, (dz / d) * 0.6, 0.1 + i * 0.035);
          }
        }
        flash(e.x + (dx / d) * 2, y, e.z + (dz / d) * 2, e.a ? 13 : Math.max(7, (e.w ?? 0) / 2 + 4), e.a ? 1 : 0, e.a ? 0.25 : 0.2, e.a ? 0.7 : 0.4);
        if (e.a) { spawn(0, e.x + (dx / d) * 3, y + 0.4, e.z + (dz / d) * 3, 4, 3.6, 0.5, 0.5, 0); kick(Math.max(0, 0.25 - dist2(e.x, e.z) / 400)); }
      } else if (e.k === 'boom') {
        const y = heightAt(scn, e.x, e.z);
        spawn(2, e.x, y + 1.6, e.z, 0.6, 8); flash(e.x, y + 2, e.z, 17, 2, 0.5, 0.9);
        spawn(3, e.x - 1.5, y + 0.6, e.z, 0.5, 3); spawn(3, e.x + 1.5, y + 0.6, e.z + 1, 0.5, 3);
        spawn(0, e.x, y + 1.5, e.z, 6, 5, 0.4, 0.6, 0);
        crater(e.x, e.z, 0.9 + Math.random() * 0.9);
        kick(Math.max(0.2, 1.4 - dist2(e.x, e.z) / 90));
      } else if (e.k === 'dmg') popNum(e.x, e.z, e.n, e.side === viewer);
      else if (e.k === 'flank') popText(e.x, e.z, e.kind === 2 ? (e.side === viewer ? 'REAR ATTACK!' : 'REAR HIT!') : e.side === viewer ? 'FLANKED!' : 'FLANK HIT!', e.side === viewer);
      else if (e.k === 'rank' && e.side === viewer) popText(e.x, e.z, `* ${['', 'SEASONED', 'VETERAN', 'ELITE'][e.vet]}`, false);
      else if (e.k === 'dead') {
        const y = heightAt(scn, e.x, e.z);
        spawn(2, e.x, y + 1.6, e.z, 0.6, 11); flash(e.x, y + 2, e.z, 20, 2, 0.5, 1); spawn(0, e.x, y + 2, e.z, 5, 6.5, 0.4, 0.5, 0);
        for (let i = 0; i < 5; i++) spawn(3, e.x + (Math.random() - 0.5) * 9, y + 0.6, e.z + (Math.random() - 0.5) * 5, 0.5, 3);
        crater(e.x, e.z, 1.8); kick(Math.max(0.15, 0.9 - dist2(e.x, e.z) / 110));
      } else if (e.k === 'charge') kick(0.1);
    }
  }

  function sync(state: any, dt: number, viewer: number, evs: any[]) {
    clock += dt;
    if (state.weather !== prevWeather) { setWeather(state.weather, prevWeather === ''); prevWeather = state.weather; }
    eat(evs, viewer); lightFlashes(dt);
    updateFog(state, viewer);

    // time of day: warm light late in the scenario clock
    if (scn.clock) {
      const hour = parseInt(scn.clock.start) + (state.t / scn.duration) * scn.clock.hours;
      const tod = duskOn ? 1 : Math.max(0, Math.min(1, (hour - 16) / 4.5));
      if (Math.abs(tod - atm.tod) > 0.005) { atm.tod += (tod - atm.tod) * Math.min(1, dt * 1.2); applyAtm(); }
    }

    // zones
    for (const z of state.zones) {
      const o = zoneObjs[z.id]; if (!o) continue;
      const c = z.contested ? ((Math.floor(clock * 3) & 1) ? 0x6f9bff : 0xff6a5c) : z.owner === 0 ? 0x6f9bff : z.owner === 1 ? 0xff6a5c : 0xe9e2cf;
      (o.ring.material as THREE.MeshBasicMaterial).color.setHex(c);
      (o.ring.material as THREE.MeshBasicMaterial).opacity = refillHint && z.owner === viewer ? 0.55 + 0.4 * Math.sin(clock * 6) : 0.95; // pulse: hurt regiments can replenish here
      (o.ring2.material as THREE.MeshBasicMaterial).color.setHex(c);
      (o.flag.material as THREE.MeshToonMaterial).color.setHex(c);
    }

    // units
    let nf = 0, nh = 0, ng = 0, npl = 0, nc = 0, nlc = 0, ncp = 0, nsk = 0, nbr = 0, nfl = 0, ncm = 0;
    const live = new Set<number>();
    const seenSet = state.fog ? new Set<number>(state.seen?.[viewer] ?? []) : null; // fog of war: enemies you cannot see are not drawn
    const k = 1 - Math.exp(-10 * dt);
    const sl = [0, 0];
    // cull regiments that are clearly off-screen (no figures placed; smoothing and bookkeeping still run). Not on the first frame or after a camera jump.
    const still = camReady && Math.hypot(cam.x - lastCam.x, cam.z - lastCam.z) < 20 && Math.abs(cam.dist / lastCam.d - 1) < 0.2 && Math.abs(cam.yaw - lastCam.y) < 0.1 && Math.abs(tl.v - lastCam.t) < 0.1;
    if (still) frustum.setFromProjectionMatrix(fMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const cw = hudW, ch = hudH; // plates live in HUD pixels
    for (const u of state.units) {
      live.add(u.id);
      if (seenSet && u.side !== viewer && !seenSet.has(u.id)) { const hp = plateMap.get(u.id); if (hp) hp.el.style.display = 'none'; vis.delete(u.id); continue; }
      let v = vis.get(u.id);
      if (!v) { v = { x: u.x, z: u.z, f: u.facing, off: new Float32Array(0), form: u.form }; vis.set(u.id, v); }
      v.x += (u.x - v.x) * k; v.z += (u.z - v.z) * k;
      let df = u.facing - v.f; df = Math.atan2(Math.sin(df), Math.cos(df)); v.f += Math.max(-4 * dt, Math.min(4 * dt, df * (1 - Math.exp(-8 * dt)))); // never faster than 4 rad/s
      const T = tu.types[u.type];
      const isArt = u.type === 'artillery', isCav = T.cav;
      const nGun = isArt ? Math.max(1, Math.ceil(u.men / 54)) : 0;
      const n = isArt ? nGun * 2 : Math.max(1, Math.min(u.garrison != null ? 10 : 1e9, Math.ceil(u.men / T.perFig))); // a garrison shows a handful of men at the walls
      if (v.n && n < v.n) for (let q = 0; q < Math.min(3, v.n - n); q++) spawn(3, v.x + (Math.random() - 0.5) * 10, heightAt(scn, v.x, v.z) + 0.6, v.z + (Math.random() - 0.5) * 5, 0.5, 2.6); // men falling
      v.n = n;
      if (v.off.length < n * 2) { const o = new Float32Array(n * 2 + 40); o.set(v.off); v.off = o; v.form = ''; }
      // footprint ~25*FS plus 15 for shadows thrown into view and the one-frame-old camera; stale slot offsets snap when it returns (form = '')
      const cull = still && !frustum.intersectsSphere(cullS.set(v3.set(v.x, heightAt(scn, v.x, v.z), v.z), 25 * FS + 15));
      const sin = Math.sin(v.f), cos = Math.cos(v.f);
      tmpC.setHex(u.routed ? 0x8d8a82 : NAT[u.nat] ?? 0x888888);
      if (u.hurt < 0.18 && !u.routed) tmpC.lerp(WHITE, 0.6); // hit flash
      plumeC.setHex(u.type === 'skirmisher' ? 0x4a8a3a : PLUME[u.nat] ?? 0xe9e4d6);
      const moving = u.mv ?? true;
      const addFig = (x: number, y: number, z: number, sc0: number, fi: number, rider = false) => {
        const sc = sc0 * (0.95 + hash(u.id * 13 + fi * 7) * 0.1), ry = v!.f + (hash(u.id * 5 + fi * 3) - 0.5) * 0.14; // no two soldiers identical
        put(foot, nf, x, y, z, ry, sc); put(kit, nf, x, y, z, ry, sc);
        tmpC2.copy(tmpC).multiplyScalar(0.94 + hash(u.id * 3 + fi * 11) * 0.12); foot.setColorAt(nf, tmpC2);
        const sw = !rider && moving ? Math.sin(clock * (u.routed ? 13 : 8) + fi * 1.7) * 0.55 : 0; // marching stride
        putLeg(legL, nf, x, y, z, ry, sw, sc); putLeg(legR, nf, x, y, z, ry, -sw, sc);
        nf++;
        if (u.type === 'cuirassier') put(cuirM, nc++, x, y, z, ry, sc);
        else if (u.type === 'guard') put(bearM, nbr++, x, y, z, ry, sc);
        else if (u.type === 'commander') put(bicM, ncm++, x, y, z, ry, sc);
        else { put(plumeM, npl, x, y, z, ry, sc); plumeM.setColorAt(npl++, plumeC); }
        if (u.type === 'lancer' && u.nat === 'pr') put(capM, ncp++, x, y, z, ry, sc);
        if (u.type === 'skirmisher') put(skirM, nsk++, x, y, z, ry, sc);
        if (u.type === 'lancer') { put(lanceM, nlc, x, y, z, ry, sc); put(pennM, nlc, x, y, z, ry, sc); pennM.setColorAt(nlc++, tmpC); }
      };
      for (let i = 0; i < (cull ? 0 : n); i++) {
        if (isArt) {
          const g = i >> 1, lx = (g - (nGun - 1) / 2) * 4.2 + (i & 1 ? 1.4 : -1.4), lz = i & 1 ? -2.4 : 0;
          sl[0] = lx; sl[1] = lz;
        } else slots(u, n, i, sl);
        sl[0] *= FS; sl[1] *= FS; // everything is laid out FS times wider
        const ox = v.off[i * 2], oz = v.off[i * 2 + 1];
        const first = v.form === '';
        const nx = first ? sl[0] : ox + (sl[0] - ox) * Math.min(1, 6 * dt), nz = first ? sl[1] : oz + (sl[1] - oz) * Math.min(1, 6 * dt);
        v.off[i * 2] = nx; v.off[i * 2 + 1] = nz;
        const wx = v.x + nx * cos + nz * sin, wz = v.z - nx * sin + nz * cos;
        // stepped hop instead of a smooth bob
        const bob = u.routed || moving && (u.tx != null || u.chase != null) ? (Math.sin(clock * 9 + i) > 0 ? 0.14 : 0) : 0;
        const y = heightAt(scn, wx, wz);
        if ((u.routed || isCav && u.mv) && Math.random() < dt * (u.routed ? 0.12 : 0.05)) spawn(3, wx, y + 0.5, wz, 0.5, 2.4);
        if (isArt) {
          if (!(i & 1)) { put(guns, ng++, wx, y, wz, v.f, 1.3 * FS); }
          else if (nf < 4990) addFig(wx, y + bob, wz, 1.7 * FS, i);
        } else if (isCav) {
          if (nh < 1490 && nf < 4990) {
            put(horses, nh, wx, y + bob, wz, v.f, 1.4 * FS); horses.setColorAt(nh++, HORSE_COL[Math.floor(hash(u.id * 7 + i) * 4)]);
            addFig(wx, y + 1.2 * FS + bob, wz, 1.55 * FS, i, true);
          }
        } else if (nf < 4990) addFig(wx, y + bob, wz, 1.7 * FS, i);
      }
      v.form = cull ? '' : u.form;
      if (!cull && (u.type === 'line' || u.type === 'guard') && !u.routed && nfl < 399) {
        const gy = heightAt(scn, v.x, v.z), sway = Math.sin(clock * 3 + u.id) * 0.35;
        put(flagM, nfl, v.x, gy, v.z, v.f, 1.3 * FS);
        for (const m of [bannerM, eagleM]) put(m, nfl, v.x, gy, v.z, v.f + sway, 1.3 * FS);
        bannerM.setColorAt(nfl++, tmpC);
      }

      // plate (name + bars) in screen space
      let p = plateMap.get(u.id);
      if (!p) {
        const el = document.createElement('div');
        el.className = 'plate';
        el.innerHTML = '<div class="pn"></div><div class="bar men"><i></i></div><div class="bar mor"><i></i></div>';
        plates.appendChild(el);
        p = { el, men: el.querySelector('.men i')!, mor: el.querySelector('.mor i')!, name: el.querySelector('.pn')!, lm: -1, lmo: -1, ls: '', mc: '', lab: '' };
        p.name.textContent = u.name;
        el.style.setProperty('--side', SIDE_COLOR[u.side]);
        plateMap.set(u.id, p);
      }
      const lab = `${u.vet ? '*'.repeat(u.vet) + ' ' : ''}${u.garrison != null ? '[G] ' : ''}${u.name}`;
      if (lab !== p.lab) { p.name.textContent = lab; p.lab = lab; }
      v3.set(v.x, heightAt(scn, v.x, v.z) + 4.5 * FS, v.z).project(camera);
      const vis3 = v3.z < 1 && Math.abs(v3.x) < 1.1 && Math.abs(v3.y) < 1.1;
      p.el.style.display = vis3 ? '' : 'none';
      if (vis3) p.el.style.transform = `translate(${Math.round(((v3.x + 1) / 2) * cw)}px,${Math.round(((1 - v3.y) / 2) * ch)}px) translate(-50%,-100%)`;
      const m = Math.ceil((u.men / u.maxMen) * 10) / 10, mo = Math.max(0, Math.ceil((u.morale / u.maxMorale) * 10) / 10); // ten cells
      const mc = mo > 0.6 ? 'hi' : mo > 0.3 ? 'mid' : 'lo'; if (mc !== p.mc) { p.mor.parentElement!.className = `bar mor ${mc}`; p.mc = mc; }
      if (Math.abs(m - p.lm) > 0.01) { if (p.lm < 0) p.men.style.width = `${Math.round(m * 100)}%`; else animate(p.men, { width: [`${Math.round(p.lm * 100)}%`, `${Math.round(m * 100)}%`], duration: 450, ease: 'outQuad' }); p.lm = m; }
      if (Math.abs(mo - p.lmo) > 0.02) { if (p.lmo < 0) p.mor.style.width = `${Math.round(mo * 100)}%`; else animate(p.mor, { width: [`${Math.round(p.lmo * 100)}%`, `${Math.round(mo * 100)}%`], duration: 450, ease: 'outQuad' }); p.lmo = mo; }
      const cls = `plate${selected.has(u.id) ? ' sel' : ''}${u.routed ? ' routed' : u.morale < u.maxMorale * 0.3 ? ' waver' : ''}${cam.dist > 95 && !selected.has(u.id) ? ' far' : ''}`;
      if (cls !== p.ls) { p.el.className = cls; p.ls = cls; }
    }
    horses.count = nh; guns.count = ng; cuirM.count = nc; lanceM.count = pennM.count = nlc; capM.count = ncp; skirM.count = nsk;
    foot.count = kit.count = legL.count = legR.count = nf; plumeM.count = npl; bearM.count = nbr; bicM.count = ncm; flagM.count = bannerM.count = eagleM.count = nfl;
    shadowP.count = nf;
    // upload only the live [0, count) slice; clear first so ranges never pile up across frames (hull twins share these attributes)
    const upl = (a: THREE.BufferAttribute, n: number, sz: number) => { a.clearUpdateRanges(); if (n > 0) { a.addUpdateRange(0, n * sz); a.needsUpdate = true; } };
    for (const m of [foot, kit, legL, legR, horses, guns, plumeM, cuirM, lanceM, pennM, capM, skirM, bearM, bicM, flagM, bannerM, eagleM]) upl(m.instanceMatrix, m.count, 16);
    for (const m of [foot, plumeM, pennM, horses, bannerM]) if (m.instanceColor) upl(m.instanceColor, m.count, 3);
    for (const [id, p] of plateMap) if (!live.has(id)) { p.el.remove(); plateMap.delete(id); vis.delete(id); }
    for (const l of vlabels) {
      v3.set(l.x, heightAt(scn, l.x, l.z) + 6, l.z).project(camera);
      const ok = v3.z < 1 && Math.abs(v3.x) < 1.1 && Math.abs(v3.y) < 1.1;
      l.el.style.display = ok ? '' : 'none';
      if (ok) l.el.style.transform = `translate(${Math.round(((v3.x + 1) / 2) * cw)}px,${Math.round(((1 - v3.y) / 2) * ch)}px) translate(-50%,-100%)`;
    }

    // pixel sprites: sim smoke puffs + client effects
    let nfx = 0;
    const place = (row: number, frame: number, x: number, y: number, z: number, size: number) => {
      if (nfx >= FX_MAX) return;
      dummy.position.set(x, y, z); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix();
      fxMesh.setMatrixAt(nfx, dummy.matrix); fxAttr.setXYZ(nfx++, frame, row, size);
    };
    for (const s of state.smoke) {
      const a = s.age / tu.smoke.life;
      place(0, Math.min(5, Math.floor(a * 6)), s.x + s.age * 0.35, heightAt(scn, s.x, s.z) + 2.4 + s.age * 0.2, s.z, 2.6 + s.age * 0.2);
    }
    for (let i = fxs.length - 1; i >= 0; i--) {
      const f = fxs[i]; f.age += dt;
      if (f.age >= f.life) { fxs.splice(i, 1); continue; }
      if (f.age < 0) continue; // still waiting for its turn in the ripple
      f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
      place(f.row, Math.min(FRAMES[f.row] - 1, Math.floor((f.age / f.life) * FRAMES[f.row])), f.x, f.y, f.z, f.size);
    }
    fxMesh.count = nfx; upl(fxMesh.instanceMatrix, nfx, 16); upl(fxAttr, nfx, 3);

    // selection rings + order lines
    let nr = 0, nl = 0;
    const lp = lineGeo.attributes.position as THREE.BufferAttribute;
    for (const u of state.units) {
      if (!selected.has(u.id) || nr >= selRings.length) continue;
      const v = vis.get(u.id)!, r = selRings[nr++];
      r.visible = true; r.position.set(v.x, heightAt(scn, v.x, v.z) + 0.6, v.z); r.scale.setScalar((u.type === 'skirmisher' ? 7 : 6) * FS);
      let tx: number | null = u.tx, tz: number | null = u.tz;
      if (u.chase != null) { const t = state.units.find((q: any) => q.id === u.chase); if (t) { tx = t.x; tz = t.z; } }
      if (tx != null && u.queue?.length) { let px = tx, pz = tz as number; for (const q of u.queue) { if (nl >= 58) break; lp.setXYZ(nl * 2, px, heightAt(scn, px, pz) + 1, pz); lp.setXYZ(nl * 2 + 1, q[0], heightAt(scn, q[0], q[1]) + 1, q[1]); nl++; px = q[0]; pz = q[1]; } }
      if (tx != null && tz != null && nl < 59) {
        lp.setXYZ(nl * 2, v.x, heightAt(scn, v.x, v.z) + 1, v.z); lp.setXYZ(nl * 2 + 1, tx, heightAt(scn, tx, tz) + 1, tz); nl++;
      }
    }
    for (let i = nr; i < selRings.length; i++) selRings[i].visible = false;
    let nrr = 0;
    for (const u of state.units) {
      const range = tu.types[u.type]?.range ?? 0;
      if (!selected.has(u.id) || range <= 0 || nrr >= rangeRings.length) continue;
      const v = vis.get(u.id); if (!v) continue;
      const r = rangeRings[nrr++]; r.visible = true; r.position.set(v.x, heightAt(scn, v.x, v.z) + 0.5, v.z); r.scale.setScalar(range + 3 * FS); // range counts edge to edge, so add about a formation's depth
    }
    for (let i = nrr; i < rangeRings.length; i++) rangeRings[i].visible = false;
    if (dragLine && nl < 58) { // right-drag preview: the line the group will form, plus a tick showing which way it will face
      const d = dragLine, mx = (d.ax + d.bx) / 2, mz = (d.az + d.bz) / 2;
      lp.setXYZ(nl * 2, d.ax, heightAt(scn, d.ax, d.az) + 1, d.az); lp.setXYZ(nl * 2 + 1, d.bx, heightAt(scn, d.bx, d.bz) + 1, d.bz); nl++;
      lp.setXYZ(nl * 2, mx, heightAt(scn, mx, mz) + 1, mz); lp.setXYZ(nl * 2 + 1, mx + Math.sin(d.f) * 8, heightAt(scn, mx, mz) + 1, mz + Math.cos(d.f) * 8); nl++;
    }
    lineGeo.setDrawRange(0, nl * 2); lp.needsUpdate = true;
    // incoming ability markers
    fxRings.forEach((m, i) => {
      const f = state.fx[i];
      if (!f) { m.visible = false; return; }
      const ab = tu.abilities[f.kind];
      m.visible = true; m.position.set(f.x, heightAt(scn, f.x, f.z) + 1, f.z); m.scale.setScalar(ab.r);
      (m.material as THREE.MeshBasicMaterial).opacity = f.t < ab.delay ? 0.5 + 0.4 * Math.sin(clock * 10) : 0.95;
    });

    // rain
    if (rain) {
      rain.visible = atm.rain > 0.05;
      (rain.material as THREE.LineBasicMaterial).opacity = 0.5 * atm.rain;
      if (rain.visible) {
        const a = rain.geometry.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < 1400; i++) {
          let y = rainPos[i * 6 + 1] - 55 * dt; if (y < 0) y += 60;
          rainPos[i * 6 + 1] = y; rainPos[i * 6 + 4] = y - 2.2;
        }
        a.needsUpdate = true;
        rain.position.set(cam.x, heightAt(scn, cam.x, cam.z), cam.z);
      }
    }
  }

  // --- camera: ortho iso, snapped to whole buffer pixels so nothing shimmers ---------------------
  const silMat = new THREE.MeshBasicMaterial({ color: 0x14110d }), silBg = new THREE.Color(0xe9e4d6);
  let S = 3, bw = 480, bh = 270, dpr = 1; // S = integer upscale in physical pixels, bw x bh = render buffer
  let hs = 2, hudW = 640, hudH = 360; // the HUD always uses the guide's grid (hs = screen height / 270), whatever the world resolution
  // camera matrices as of the last render(); sync() culls off-screen regiments against them, so a camera jump disables culling for a frame
  let camReady = false; const lastCam = { x: 0, z: 0, d: 90, y: 0, t: 0 }, frustum = new THREE.Frustum(), fMat = new THREE.Matrix4(), cullS = new THREE.Sphere();
  const tg = new THREE.Vector3(), rightV = new THREE.Vector3(), upV = new THREE.Vector3();
  function render() {
    if ((devicePixelRatio || 1) !== dpr) resize(); // window dragged to a monitor with different scaling, or browser zoom
    const H = cam.dist * ZOOM_K, Wd = H * (bw / bh), px = H / bh;
    Object.assign(camera, { left: -Wd / 2, right: Wd / 2, top: H / 2, bottom: -H / 2 }); camera.updateProjectionMatrix();
    tg.set(cam.x, scn ? heightAt(scn, cam.x, cam.z) : 0, cam.z);
    const y = cam.yaw + ISO;
    camera.position.set(tg.x + Math.sin(y) * Math.cos(tl.v) * CAM_D, tg.y + Math.sin(tl.v) * CAM_D, tg.z + Math.cos(y) * Math.cos(tl.v) * CAM_D);
    camera.lookAt(tg); camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements; rightV.set(e[0], e[1], e[2]); upV.set(e[4], e[5], e[6]);
    const a = tg.dot(rightV), b = tg.dot(upV), sh = shake.v;
    const sx = sh > 0.01 ? Math.round((Math.sin(clock * 47) * sh * 0.6) / px) * px : 0, sy = sh > 0.01 ? Math.round((Math.cos(clock * 39) * sh * 0.45) / px) * px : 0; // smooth damped wobble, not per-frame noise
    camera.position.addScaledVector(rightV, Math.round(a / px) * px - a + sx).addScaledVector(upV, Math.round(b / px) * px - b + sy); camera.updateMatrixWorld();

    // sun follows the view; shadow box sized to what is visible, target snapped to shadow texels
    const sr = Math.min(230, 0.5 * Math.max(Wd, 1.8 * H) * 1.1 + 8), cs = sun.shadow.camera;
    if (Math.abs(cs.right - sr) > 0.5) { Object.assign(cs, { left: -sr, right: sr, top: sr, bottom: -sr, near: 1, far: 320 }); cs.updateProjectionMatrix(); }
    const stp = (2 * sr) / sun.shadow.mapSize.x;
    sun.target.position.set(Math.round(tg.x / stp) * stp, tg.y, Math.round(tg.z / stp) * stp); sun.target.updateMatrixWorld();
    sun.position.set(sun.target.position.x - 120, sun.target.position.y + 105, sun.target.position.z + 75);

    const fz = Math.max(1, H / 60), fg = scene.fog as THREE.Fog; fg.near = CAM_D + atm.fn * fz; fg.far = CAM_D + atm.ff * fz; // keep haze constant as you zoom out
    hullU.uW.value = px * 0.95; // 1 buffer pixel
    for (const q of outlined) q.o.count = q.m.count;

    const savedBg = scene.background, savedFog = scene.fog;
    if (silhouette) {
      scene.overrideMaterial = silMat; scene.background = silBg; scene.fog = null; fxMesh.visible = craters.visible = false;
      for (const o of terrain) o.visible = false;
      for (const q of outlined) q.o.visible = false;
      shadowP.visible = false; // overrideMaterial would paint the invisible shadow box solid
    }
    renderer.setRenderTarget(rt); renderer.render(scene, camera);
    if (silhouette) {
      scene.overrideMaterial = null; scene.background = savedBg; scene.fog = savedFog; fxMesh.visible = craters.visible = true;
      for (const o of terrain) o.visible = true;
      for (const q of outlined) q.o.visible = true;
      shadowP.visible = true;
    }
    camReady = true; lastCam.x = cam.x; lastCam.z = cam.z; lastCam.d = cam.dist; lastCam.y = cam.yaw; lastCam.t = tl.v;

    renderer.setRenderTarget(null); renderer.render(postScene, postCam);
  }

  function resize() {
    const w = host.clientWidth || innerWidth, h = host.clientHeight || innerHeight;
    dpr = devicePixelRatio || 1; const W = w * dpr, H = h * dpr; // pick S in physical pixels so each buffer pixel covers whole screen pixels at any OS display scaling
    hs = Math.max(2, Math.round(h / 360)); // HUD grid: 640x360 at 720p, 1080p and 1440p alike (CSS pixels, so browser zoom still enlarges it)
    S = upscale(quality, H);
    const sm = quality >= 2 ? 4096 : 2048;
    if (sun.shadow.mapSize.x !== sm) { sun.shadow.mapSize.set(sm, sm); sun.shadow.map?.dispose(); (sun.shadow as any).map = null; } // finer shadows at High and Native
    bw = Math.ceil(W / S); bh = Math.ceil(H / S);
    hudW = (bw * S) / dpr / hs; hudH = (bh * S) / dpr / hs;
    renderer.setSize(bw, bh, false); rt.setSize(bw, bh); post.uniforms.res.value.set(bw, bh);
    canvas.style.width = (bw * S) / dpr + 'px'; canvas.style.height = (bh * S) / dpr + 'px';
    const rs = document.documentElement.style; rs.setProperty('--S', String(hs)); rs.setProperty('--bw', String(Math.ceil(hudW))); rs.setProperty('--bh', String(Math.ceil(hudH))); // HUD and plates are laid out in HUD pixels, scaled by hs
  }
  resize();
  addEventListener('resize', resize);

  // --- picking helpers (map screen px <-> the canvas, which can overhang the host by < S px) ---------------
  const ray = new THREE.Raycaster();
  function ground(cx: number, cy: number): { x: number; z: number } | null {
    if (!terrainMesh) return null;
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
    const h = ray.intersectObject(terrainMesh)[0];
    return h ? { x: h.point.x, z: h.point.z } : null;
  }
  function toScreen(x: number, z: number) {
    v3.set(x, heightAt(scn, x, z) + 1.5, z).project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: r.left + ((v3.x + 1) / 2) * r.width, y: r.top + ((1 - v3.y) / 2) * r.height, ok: v3.z < 1 };
  }
  function pickUnit(state: any, cx: number, cy: number, filter: (u: any) => boolean, radius = 30) {
    let best: any = null, bd = radius;
    for (const u of state.units) {
      if (!filter(u)) continue;
      const v = vis.get(u.id); const p = toScreen(v?.x ?? u.x, v?.z ?? u.z);
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (p.ok && d < bd) { bd = d; best = u; }
    }
    return best;
  }
  function unitsIn(state: any, x0: number, y0: number, x1: number, y1: number, filter: (u: any) => boolean) {
    const [a, b] = [Math.min(x0, x1), Math.max(x0, x1)], [c, d] = [Math.min(y0, y1), Math.max(y0, y1)];
    return state.units.filter((u: any) => { if (!filter(u)) return false; const p = toScreen(u.x, u.z); return p.ok && p.x >= a && p.x <= b && p.y >= c && p.y <= d; });
  }
  function setSelection(ids: Iterable<number>) { selected.clear(); for (const i of ids) selected.add(i); }
  const setRefillHint = (on: boolean) => { refillHint = on; };
  const setDragLine = (d: typeof dragLine) => { dragLine = d; };
  function setReticle(x: number | null, z = 0, r = 10, color = 0xffffff) {
    if (x == null) { reticle.visible = false; return; }
    reticle.visible = true; reticle.position.set(x, heightAt(scn, x, z) + 1, z); reticle.scale.setScalar(r);
    (reticle.material as THREE.MeshBasicMaterial).color.setHex(color);
  }

  return { dom: canvas, cam, shake, setDusk, setSilhouette, setTopDown, rotate90, cycleQuality, get guide() { return guideOn(); }, setScenario, sync, render, resize, flyTo, zoomBy, kick, pan, setWeather, ground, toScreen, pickUnit, unitsIn, setSelection, setReticle, setRefillHint, setDragLine, selected, get mapSize() { return mapSize; }, stopCam: () => camAnim?.pause() };
}
export type View = ReturnType<typeof createView>;
