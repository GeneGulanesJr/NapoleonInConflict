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
function paint(g: THREE.BufferGeometry, hex: number, keep = false) {
  if (g.index && !keep && g.type !== 'BoxGeometry') g = g.toNonIndexed(); // boxes keep their index (24 verts, flat normals already); keep = indexed for flatShading materials
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3)); g.deleteAttribute('uv'); g.computeVertexNormals();
  return g;
}
const bx = (w: number, h: number, d: number, x: number, y: number, z: number, hex: number) => paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex);
const cy = (r0: number, r1: number, h: number, seg: number, x: number, y: number, z: number, hex: number) => paint(new THREE.CylinderGeometry(r0, r1, h, seg).translate(x, y, z), hex);
const merge = (l: THREE.BufferGeometry[]) => mergeGeometries(l.some(g => !g.index) ? l.map(g => g.index ? g.toNonIndexed() : g) : l)!; // mergeGeometries needs all-or-none indexed
// turned parts for the tin figures: a tapered rod from a (radius r0) to b (r1), a squashed ball, a dome, an upright cylinder from y0 to y1 (sz flattens it front to back)
const UP = new THREE.Vector3(0, 1, 0);
const rod = (a: number[], b: number[], r0: number, r1: number, hex: number, seg = 6) => {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), g = new THREE.CylinderGeometry(r1, r0, d.length(), seg, 1, Math.max(r0, r1) < 0.04); // thin rods need no end caps
  return paint(g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize())).translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), hex, true);
};
const ball = (r: number, x: number, y: number, z: number, hex: number, sx = 1, sy = 1, sz = 1) => paint(new THREE.SphereGeometry(r, r < 0.08 ? 4 : 6, r < 0.08 ? 3 : 4).scale(sx, sy, sz).translate(x, y, z), hex, true);
const dome = (r: number, y: number, hex: number, sy = 1) => paint(new THREE.SphereGeometry(r, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, sy, 1).translate(0, y, 0), hex, true);
const cyl = (r0: number, r1: number, y0: number, y1: number, hex: number, seg = 8, sz = 1) => paint(new THREE.CylinderGeometry(r1, r0, y1 - y0, seg).scale(1, 1, sz).translate(0, (y0 + y1) / 2, 0), hex, true);
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

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
      vFlW = ( modelMatrix * flW ).xyz;`).replace('#include <color_vertex>', THREE.ShaderChunk.color_vertex).replace('vColor.rgb *= instanceColor.rgb;', `#ifdef USE_COLOR
      vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, step( 2.99, color.r + color.g + color.b ) ); // only pure-white paint takes the instance tint (coat, plume, horse coat)
      #else
      vColor.rgb *= instanceColor.rgb;
      #endif`);
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
    } else zoomTarget = Math.max(18, Math.min(760, (Math.abs(cam.dist - zoomTarget) > zoomTarget * 0.3 ? cam.dist : zoomTarget) * factor)); // re-base when something else (intro, fly-to) moved the camera
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
  const far = () => { const t = Math.max(0, Math.min(1, (cam.dist - 90) / 190)); return t * t * (3 - 2 * t); }; // 0 close .. 1 fully zoomed out: figures are 1-2px, so soften them
  const hullU = { uW: { value: 0.1 }, uInk: { value: new THREE.Color(P.ink) } }; // one ink colour and width for every hull
  const outlined: { m: THREE.InstancedMesh; o: THREE.InstancedMesh }[] = [];
  function hullMat(c: [number, number, number]) {
    return new THREE.ShaderMaterial({
      uniforms: { uW: hullU.uW, uC: { value: new THREE.Vector3(...c) }, uInk: hullU.uInk },
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
    let lowY = 0; // lowest ground, so the soil plinth never pokes through valleys
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      let h = heightAt(s, x, z), kd = 0; // kd: detail channel 0 grass, 1 wheat, 2 plough, 3 lane/village/road cobbles, -1 none
      const n = hash(Math.round(x * 0.5) * 31 + Math.round(z * 0.5) * 17);
      const field = Math.sin(x * 0.06 + z * 0.02) * Math.sin(z * 0.05 - x * 0.015) > 0.25;
      const plough = !field && Math.sin(x * 0.04 + 1) * Math.sin(z * 0.045 - 2) > 0.75; // smaller patches than before: big ones read as mud
      if (field) col.copy((Math.floor((x + z) / 2.4) & 1) ? W : W2);
      else if (plough) col.setHex(Math.floor(z / 3.2) & 1 ? 0x7a5a3a : 0xa07a4c); // furrows two cells wide, or vertex colours average them into flat mud
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
      lowY = Math.min(lowY, pos.getY(i));
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
    plinth.position.y = lowY - 0.3 - 5; // top just under the lowest ground (a fixed -1.2 showed the soil as a brown slab wherever valleys dipped below it)
    add(plinth);

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
    houseXZ = houses.flat(); // men walk round these
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
        const a0 = (k / N - 0.25) * Math.PI * 2, a1 = ((k + 1) / N - 0.25) * Math.PI * 2; // from north, clockwise: ring2's draw range is the capture progress
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

  // --- units: painted tin miniatures ------------------------------------------------------------
  // Turned, tapered parts on a green base, like a wargamer's figures. Built standing on y = 0 facing +z (right hand = -x), then moved to their pivot:
  // root (feet) -> body at the hip (lean, sway) -> arms at the shoulder; legs hang from the hip. Pure white paint takes the instance tint.
  const W = 0xffffff, DK = 0x1b1b1f, RED = 0xc23a2e, IRON = 0x4a4c52, BRONZE = 0x8f7a48, OLIVE = 0x5d6838, LEATHER = 0x6a4a2e, HAIR = 0x3a2a1a, BASE = 0x4b5f30;
  const HIP = 0.62, SH = 1.18, HY = 1.05; // hip, shoulder, horse-body pivot heights
  const atHip = (l: THREE.BufferGeometry[]) => merge(l).translate(0, -HIP, 0), atSh = (l: THREE.BufferGeometry[]) => merge(l).translate(0, -SH, 0);
  const belt = (s: number) => [rod([0.17 * s, 1.14, 0.115], [0, 0.92, 0.165], 0.026, 0.026, P.trim, 4), rod([0, 0.92, 0.165], [-0.16 * s, 0.68, 0.075], 0.026, 0.026, P.trim, 4)]; // shoulder to hip, bent at the chest so it hugs the coat
  const bodyG = atHip([
    cyl(0.17, 0.235, 0.6, SH, W, 8, 0.72), cyl(0.215, 0.175, 0.47, 0.64, W, 8, 0.8), // chest, coat skirt
    rod([0.07, 0.62, -0.12], [0.08, 0.38, -0.16], 0.05, 0.04, W, 4), rod([-0.07, 0.62, -0.12], [-0.08, 0.38, -0.16], 0.05, 0.04, W, 4), // coat-tails
    ...belt(1), ...belt(-1), bx(0.07, 0.07, 0.03, 0, 0.92, 0.175, P.brass), // crossbelts and plate
    ball(0.09, 0.23, 1.17, 0, RED, 1.2, 0.55), ball(0.09, -0.23, 1.17, 0, RED, 1.2, 0.55), cyl(0.12, 0.115, 1.16, 1.25, RED), cyl(0.07, 0.07, 1.24, 1.3, DK, 6), // epaulettes, collar, stock
    ball(0.15, 0, 1.39, 0.015, P.skin, 1, 1.05), ball(0.145, 0, 1.41, -0.03, HAIR),
    bx(0.04, 0.04, 0.02, 0.055, 1.41, 0.155, DK), bx(0.04, 0.04, 0.02, -0.055, 1.41, 0.155, DK), bx(0.11, 0.03, 0.03, 0, 1.335, 0.15, HAIR), // eyes, moustache
  ]);
  const packG = atHip([bx(0.34, 0.34, 0.14, 0, 0.98, -0.22, LEATHER), rod([-0.2, 1.21, -0.22], [0.2, 1.21, -0.22], 0.065, 0.065, 0x8a8576), bx(0.24, 0.13, 0.08, 0, 0.66, -0.2, DK)]); // foot only: knapsack, greatcoat roll, cartridge box
  const legG = (x: number) => merge([rod([x, HIP, 0], [x, 0.3, 0.01], 0.1, 0.082, P.pants), rod([x, 0.32, 0.01], [x, 0.05, 0], 0.084, 0.072, DK), bx(0.11, 0.06, 0.21, x, 0.03, 0.04, DK)]).translate(0, -HIP, 0); // trousers, gaiters, shoe
  const arm = (s: number[], e: number[], h: number[]) => [rod(s, e, 0.07, 0.064, W), rod(e, h, 0.064, 0.058, W), rod(mix(e, h, 0.72), h, 0.07, 0.068, RED), ball(0.058, h[0], h[1], h[2], P.skin)];
  const musket = (b: number[], m: number[]) => [rod(b, mix(b, m, 0.32), 0.055, 0.032, P.wood, 5), rod(mix(b, m, 0.3), m, 0.022, 0.022, IRON, 4), rod(m, mix(b, m, 1.28), 0.013, 0.006, P.steel, 4)]; // stock, barrel, bayonet
  // carry: musket upright against the left shoulder (a forest of bayonets above the shakos); aim: levelled from the right shoulder; ride: sabre at the shoulder, reins in the left hand
  const armsCarryG = atSh([...arm([0.24, 1.17, 0], [0.28, 0.95, 0.06], [0.3, 0.74, 0.12]), ...arm([-0.24, 1.17, 0], [-0.28, 0.95, 0.02], [-0.29, 0.73, 0.05]), ...musket([0.32, 0.6, 0.15], [0.31, 1.92, 0.06])]);
  const armsAimG = atSh([...arm([-0.24, 1.17, 0], [-0.32, 1.0, 0.1], [-0.15, 1.12, 0.36]), ...arm([0.24, 1.17, 0], [0.22, 1.02, 0.3], [-0.07, 1.17, 0.68]), ...musket([-0.13, 1.14, 0.08], [-0.09, 1.24, 1.4])]);
  const HAND = [-0.2, 1.0, 0.33], BLADE = [-0.23, 1.95, 0.16];
  const armsRideG = atSh([...arm([-0.24, 1.17, 0], [-0.29, 0.96, 0.12], HAND), ...arm([0.24, 1.17, 0], [0.27, 0.96, 0.12], [0.12, 0.93, 0.36]), bx(0.12, 0.03, 0.06, HAND[0], 1.05, HAND[2] + 0.01, P.brass), rod(HAND, BLADE, 0.024, 0.01, P.steel, 4)]);
  // the lance lies along the sabre line, so it shares the arms' matrix and couches with them; white pennant takes the nation colour
  const lanceG = atSh([rod(mix(HAND, BLADE, -0.95), mix(HAND, BLADE, 2.4), 0.03, 0.024, P.wood, 4), rod(mix(HAND, BLADE, 2.4), mix(HAND, BLADE, 2.62), 0.035, 0.004, P.steel, 4), bx(0.02, 0.18, 0.38, -0.27, 3.0, -0.27, W)]);
  // headgear rides on the body's matrix
  const peak = (r: number, y: number) => paint(new THREE.CylinderGeometry(r, r, 0.02, 8, 1, false, -Math.PI / 2, Math.PI).rotateX(0.25).translate(0, y, 0.02), DK, true);
  const shakoG = atHip([cyl(0.138, 0.168, 1.47, 1.8, DK), peak(0.17, 1.49), bx(0.1, 0.12, 0.02, 0, 1.62, 0.158, P.brass), rod([0, 1.78, 0.11], [0, 2.07, 0.14], 0.045, 0.022, W, 5)]); // French bell-top + plume
  const belgicG = atHip([cyl(0.138, 0.14, 1.47, 1.72, DK), bx(0.3, 0.38, 0.03, 0, 1.74, 0.13, DK), peak(0.17, 1.49), bx(0.11, 0.13, 0.02, 0, 1.62, 0.16, P.brass), rod([0.11, 1.74, 0.14], [0.12, 1.93, 0.15], 0.04, 0.03, W, 5)]); // British false-front shako
  const bearG = atHip([cyl(0.15, 0.2, 1.46, 1.98, DK, 7), dome(0.2, 1.98, DK, 0.5), bx(0.13, 0.12, 0.02, 0, 1.58, 0.165, P.brass), rod([0.13, 1.62, 0.07], [0.16, 2.06, 0.07], 0.045, 0.03, RED, 5), bx(0.12, 0.12, 0.03, 0, 1.98, -0.19, RED)]);
  const cuirG = atHip([cyl(0.182, 0.25, 0.62, SH - 0.02, P.steel, 8, 0.76), dome(0.16, 1.47, P.steel), cyl(0.15, 0.15, 1.44, 1.51, DK), peak(0.16, 1.47), bx(0.05, 0.13, 0.32, 0, 1.66, -0.02, P.brass),
    rod([0, 1.68, -0.15], [0, 1.22, -0.3], 0.045, 0.075, DK, 5), rod([0.03, 1.7, 0.1], [0.05, 1.98, 0.08], 0.035, 0.025, RED, 5)]); // breastplate, helmet, fur turban, crest, horsehair tail, plume
  const capG = atHip([cyl(0.138, 0.12, 1.47, 1.66, DK), paint(new THREE.BoxGeometry(0.3, 0.1, 0.3).rotateY(Math.PI / 4).translate(0, 1.72, 0), RED), peak(0.17, 1.49), bx(0.1, 0.1, 0.02, 0, 1.56, 0.145, P.brass), rod([0.1, 1.76, 0.08], [0.12, 2.0, 0.08], 0.04, 0.025, P.trim, 5)]); // lancer czapka
  const bicG = atHip([cyl(0.152, 0.145, 1.46, 1.6, DK), paint(new THREE.CylinderGeometry(0.33, 0.33, 0.24, 10, 1, false, -Math.PI / 2, Math.PI).rotateX(-Math.PI / 2).scale(1, 0.62, 1).translate(0, 1.5, 0), DK, true), ball(0.045, 0.12, 1.6, 0.13, 0xe9e4d6)]); // bicorne worn en bataille: crown, crescent, cockade
  const skirG = atHip([ball(0.095, 0.23, 1.175, 0, 0x4a8a3a, 1.2, 0.6), ball(0.095, -0.23, 1.175, 0, 0x4a8a3a, 1.2, 0.6), bx(0.26, 0.035, 0.03, 0, 1.57, 0.165, 0xe8c030)]); // light-company epaulettes and shako cord
  // horse: white parts take a coat per horse (bay, chestnut, black, grey); legs swing in pairs from shoulder and hip
  const HD = 0x2a2a2a;
  const horseG = merge([
    rod([0, 1.04, -0.62], [0, 1.08, 0.56], 0.28, 0.3, W, 8), ball(0.3, 0, 1.06, 0.56, W, 0.95), ball(0.3, 0, 1.1, -0.6, W, 0.95, 1, 1.05), // barrel, chest, rump
    rod([0, 1.18, 0.62], [0, 1.72, 0.98], 0.2, 0.12, W), rod([0, 1.8, 0.96], [0, 1.5, 1.38], 0.12, 0.075, W), // neck, head
    rod([0.06, 1.84, 0.94], [0.08, 1.97, 0.9], 0.035, 0.01, W, 4), rod([-0.06, 1.84, 0.94], [-0.08, 1.97, 0.9], 0.035, 0.01, W, 4), bx(0.03, 0.04, 0.04, 0.085, 1.72, 1.12, HD), bx(0.03, 0.04, 0.04, -0.085, 1.72, 1.12, HD), // ears, eyes
    rod([0, 1.29, 0.48], [0, 1.83, 0.86], 0.06, 0.05, HD, 4), rod([0, 1.15, -0.86], [0, 0.5, -1.02], 0.08, 0.035, HD, 5), // mane, tail
    bx(0.56, 0.05, 0.86, 0, 1.39, -0.08, 0x7a2a2a), paint(new THREE.BoxGeometry(0.04, 0.34, 0.86).rotateZ(-0.25).translate(0.3, 1.22, -0.08), 0x7a2a2a), paint(new THREE.BoxGeometry(0.04, 0.34, 0.86).rotateZ(0.25).translate(-0.3, 1.22, -0.08), 0x7a2a2a), bx(0.36, 0.08, 0.42, 0, 1.42, 0, LEATHER), rod([-0.22, 1.45, -0.3], [0.22, 1.45, -0.3], 0.065, 0.065, 0x2a3a6a), rod([0, 1.6, 1.22], [0, 1.4, 0.4], 0.012, 0.012, DK, 3), // shabraque, saddle, valise, reins
    rod([0.34, 1.3, 0.05], [0.36, 0.9, 0.08], 0.012, 0.012, DK, 3), rod([-0.34, 1.3, 0.05], [-0.36, 0.9, 0.08], 0.012, 0.012, DK, 3), // stirrup leathers
  ]).translate(0, -HY, 0);
  const hleg = (x: number, knee: number, r: number, a: number) => merge([rod([x, 0, 0], [x, -0.44, knee], r, 0.06, W, 5), rod([x, -0.44, knee], [x, -0.88, 0], 0.05, 0.045, W, 5), rod([x, -0.88, 0], [x, -0.98, 0.01], 0.06, 0.065, HD, 5)]).rotateX(a);
  const legsFG = merge([hleg(0.16, 0.05, 0.085, 0.2), hleg(-0.16, 0.05, 0.085, -0.2)]), legsHG = merge([hleg(0.16, -0.12, 0.11, 0.2), hleg(-0.16, -0.12, 0.11, -0.2)]);
  // field gun: bronze barrel on an olive Gribeauval carriage, spoked wheels, rammer and shot pile
  const spokes = (sx: number) => [0, 1, 2, 3, 4, 5].map((k) => rod([sx, 0.78, 0], [sx, 0.78 + Math.cos(k * 1.047) * 0.72, Math.sin(k * 1.047) * 0.72], 0.025, 0.025, OLIVE, 3));
  const gunG = merge([
    rod([0, 0.98, -0.45], [0, 1.04, 1.6], 0.24, 0.16, BRONZE, 8), rod([0, 1.04, 1.5], [0, 1.045, 1.66], 0.2, 0.2, BRONZE, 8), ball(0.1, 0, 0.97, -0.55, BRONZE),
    bx(0.09, 0.42, 1.5, 0.27, 0.82, 0.05, OLIVE), bx(0.09, 0.42, 1.5, -0.27, 0.82, 0.05, OLIVE), rod([0, 0.78, -0.5], [0, 0.12, -2.1], 0.14, 0.11, OLIVE, 4), rod([-0.72, 0.78, 0], [0.72, 0.78, 0], 0.07, 0.07, IRON),
    ...[0.68, -0.68].flatMap((sx) => [paint(new THREE.TorusGeometry(0.76, 0.07, 4, 12).rotateY(Math.PI / 2).translate(sx, 0.78, 0), IRON, true), rod([sx - 0.08, 0.78, 0], [sx + 0.08, 0.78, 0], 0.13, 0.13, OLIVE, 8), ...spokes(sx)]),
    rod([0.9, 0.05, -1.1], [0.9, 0.05, 0.7], 0.03, 0.03, P.wood, 4), rod([0.9, 0.05, 0.7], [0.9, 0.05, 0.92], 0.07, 0.07, 0x3a3a3a), // rammer and sponge
    ...[[-0.9, 0.11, -0.5], [-0.72, 0.11, -0.3], [-1.08, 0.11, -0.3], [-0.9, 0.11, -0.1], [-0.9, 0.28, -0.3]].map(([x, y, z]) => ball(0.11, x, y, z, DK)),
  ]);
  // enamel paint: the scene's 3 toon steps plus a bright glint where a facet faces the sun (ramp stored /GL, colour scaled back up by GL)
  const GL = 1.35, figRamp = new THREE.DataTexture(new Uint8Array([0.47, 0.47, 0.47, 0.47, 0.75, 0.75, 1, 1, GL, GL].map((v) => Math.round((v / GL) * 255))), 10, 1, THREE.RedFormat);
  figRamp.minFilter = figRamp.magFilter = THREE.NearestFilter; figRamp.needsUpdate = true;
  const fig = (g: THREE.BufferGeometry, n: number, center: [number, number, number] | null, shadow = false) => mkI(g, n, Object.assign(toon({ vertexColors: true, gradientMap: figRamp, color: new THREE.Color(GL, GL, GL) }), { flatShading: true }) /* faceted from indexed parts: ~half the vertices */, center, shadow);
  const body = fig(bodyG, 5000, [0, 0.35, 0]), legL = fig(legG(0.095), 5000, [0, -0.3, 0]), legR = fig(legG(-0.095), 5000, [0, -0.3, 0]);
  const armsCarry = fig(armsCarryG, 5000, [0, -0.2, 0.05]), armsAim = fig(armsAimG, 3000, [0, -0.05, 0.4]), armsRide = fig(armsRideG, 1600, [0, -0.1, 0.2]);
  const packM = fig(packG, 5000, [0, 0.35, 0]), baseM = fig(cyl(0.31, 0.29, 0, 0.05, BASE, 10), 5000, [0, 0, 0]);
  // one invisible box casts the whole soldier's shadow (cheaper than every part casting); slightly inside the silhouette so it never darkens the figure
  const shadowP = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 1.8, 0.28).translate(0, 0.9 - HIP, 0), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), 5000);
  shadowP.instanceMatrix = body.instanceMatrix; shadowP.count = 0; shadowP.frustumCulled = false; shadowP.castShadow = true; shadowP.receiveShadow = false; scene.add(shadowP);
  const hat = [0, 1.05, 0] as [number, number, number];
  const shakoM = fig(shakoG, 5000, hat), belgM = fig(belgicG, 3000, hat), bearM = fig(bearG, 1500, hat), cuirM = fig(cuirG, 1500, [0, 0.5, 0]), capM = fig(capG, 1500, hat), bicM = fig(bicG, 200, hat);
  const skirM = fig(skirG, 2500, null), lanceM = fig(lanceG, 1500, null);
  // one standard per infantry regiment (pole + finial, waving banner in the nation's colour, gold eagle)
  const flagM = mkI(merge([bx(0.07, 3.6, 0.07, 0, 1.8, 0, P.wood), bx(0.18, 0.2, 0.18, 0, 3.7, 0, P.brass)]), 400, toon({ vertexColors: true }), [0, 1.8, 0], false);
  const bannerM = mkI(paint(new THREE.BoxGeometry(1.0, 0.75, 0.05).translate(0.55, 3.1, 0), 0xffffff), 400, toon({ color: 0xffffff }), null, false);
  const eagleM = mkI(paint(new THREE.BoxGeometry(0.32, 0.32, 0.07).translate(0.55, 3.1, 0), P.brass), 400, toon({ vertexColors: true }), null, false);
  const horses = fig(horseG, 1500, [0, 0.1, 0.2], true), legsF = fig(legsFG, 1500, [0, -0.5, 0]), legsH = fig(legsHG, 1500, [0, -0.5, 0]); // legs cast no shadow: the body's is enough
  const hbaseM = fig(cyl(0.55, 0.53, 0, 0.05, BASE, 12, 1.9), 1500, [0, 0, 0]);
  const HORSE_COL = [0x7a5236, 0x9a6638, 0x34302c, 0xa8a49a].map((h) => new THREE.Color(h));
  const guns = fig(gunG, 300, [0, 0.8, 0], true);
  // figure rig: rootAt places the feet; joint hangs a child (hip, shoulder, horse legs) off a parent matrix with its own pitch (+ = forward) and roll
  const E = new THREE.Euler(0, 0, 0, 'YXZ'), Q = new THREE.Quaternion(), V = new THREE.Vector3(), SV = new THREE.Vector3();
  const mRoot = new THREE.Matrix4(), mBody = new THREE.Matrix4(), mHorse = new THREE.Matrix4(), mPart = new THREE.Matrix4();
  const rootAt = (m: THREE.Matrix4, x: number, y: number, z: number, yaw: number, sc: number) => m.compose(V.set(x, y, z), Q.setFromEuler(E.set(0, yaw, 0)), SV.setScalar(sc));
  const joint = (out: THREE.Matrix4, parent: THREE.Matrix4, x: number, y: number, z: number, pitch: number, roll = 0) => out.compose(V.set(x, y, z), Q.setFromEuler(E.set(pitch, 0, roll)), SV.setScalar(1)).premultiply(parent);

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

  // per regiment: smoothed centre and facing, its speed, and per man MS floats: x, z, facing, vx, vz, gait phase
  const MS = 6;
  type Vis = { x: number; z: number; f: number; m: Float32Array; form: string; rs: number; n?: number; side: number; kind: number; seenT?: number };
  const GHOST = 30; // fog of war: seconds an enemy's plate lingers where it was last seen
  // crowd: last frame's men (and the houses) in a flat grid, counting-sorted by cell, so each man only looks at his neighbours to shoulder them apart
  const CG = 2.4, CMAX = 9000, cX = new Float32Array(CMAX), cZ = new Float32Array(CMAX), cR = new Float32Array(CMAX), cU = new Int32Array(CMAX), cI = new Int32Array(CMAX), cS = new Int8Array(CMAX), cCell = new Int32Array(CMAX), cOrd = new Int32Array(CMAX);
  let cN = 0, cW = 1, cStart = new Int32Array(2), cFill = new Int32Array(1), houseXZ: number[] = [];
  const cellOf = (x: number) => Math.max(0, Math.min(cW - 1, Math.floor((x + mapSize / 2) / CG) + 1));
  const figR = (kind: number, i: number) => (kind === 2 ? (i & 1 ? 0.5 : 1.6) : kind === 1 ? 1 : 0.5) * FS; // man, horse, gun
  function buildCrowd() {
    cN = 0;
    const add = (x: number, z: number, r: number, u: number, i: number, s: number) => { if (cN < CMAX) { cX[cN] = x; cZ[cN] = z; cR[cN] = r; cU[cN] = u; cI[cN] = i; cS[cN++] = s; } };
    for (let h = 0; h < houseXZ.length; h += 2) add(houseXZ[h], houseXZ[h + 1], 1.7, -1, h, -1);
    for (const [id, v] of vis) if (v.form !== '' && v.n) for (let i = 0; i < v.n; i++) { const o = i * MS; if (v.m[o] === v.m[o]) add(v.m[o], v.m[o + 1], figR(v.kind, i), id, i, v.side); }
    cW = Math.ceil(mapSize / CG) + 2; const cells = cW * cW;
    if (cStart.length < cells + 1) { cStart = new Int32Array(cells + 1); cFill = new Int32Array(cells); } else cStart.fill(0);
    for (let k = 0; k < cN; k++) { cCell[k] = cellOf(cZ[k]) * cW + cellOf(cX[k]); cStart[cCell[k] + 1]++; }
    for (let c = 0; c < cells; c++) cStart[c + 1] += cStart[c];
    cFill.set(cStart.subarray(0, cells));
    for (let k = 0; k < cN; k++) cOrd[cFill[cCell[k]]++] = k;
  }
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
  let hoverId = -1, showAll = false; // full name plates only for these (plus selected / in trouble); everyone else gets a pip

  // coloured bases: a ribbon round each regiment's footprint on the ground, blue yours, red the enemy's (coats stay historical, and French and Prussian coats are both blue)
  const BASE_Q = 8000, basePos = new Float32Array(BASE_Q * 18), baseCol = new Float32Array(BASE_Q * 18), baseGeo = new THREE.BufferGeometry();
  baseGeo.setAttribute('position', new THREE.BufferAttribute(basePos, 3).setUsage(THREE.DynamicDrawUsage)); baseGeo.setAttribute('color', new THREE.BufferAttribute(baseCol, 3).setUsage(THREE.DynamicDrawUsage));
  const baseMesh = new THREE.Mesh(baseGeo, new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })); // unlit, so it reads at dusk too
  baseMesh.frustumCulled = false; scene.add(baseMesh);
  const BASE_COL = { mine: new THREE.Color(0x4f86ff), foe: new THREE.Color(0xe8463a), routed: new THREE.Color(0x8d8a82) };
  let nb = 0;
  function baseSeg(ax: number, az: number, bx: number, bz: number, th: number, c: THREE.Color) {
    if (nb >= BASE_Q) return;
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1, ox = ((-dz / L) * th) / 2, oz = ((dx / L) * th) / 2;
    const ya = heightAt(scn, ax, az) + 0.2, yb = heightAt(scn, bx, bz) + 0.2, o = nb++ * 18;
    basePos.set([ax + ox, ya, az + oz, bx + ox, yb, bz + oz, bx - ox, yb, bz - oz, ax + ox, ya, az + oz, bx - ox, yb, bz - oz, ax - ox, ya, az - oz], o);
    for (let q = 0; q < 18; q += 3) { baseCol[o + q] = c.r; baseCol[o + q + 1] = c.g; baseCol[o + q + 2] = c.b; }
  }
  /** b = [x0, x1, z0, z1] in the regiment's own frame; edges are cut into ~3-unit pieces so the ribbon hugs the ground */
  function baseRing(cx: number, cz: number, sin: number, cos: number, b: number[], th: number, c: THREE.Color) {
    const P = [[b[0], b[2]], [b[1], b[2]], [b[1], b[3]], [b[0], b[3]]];
    for (let e = 0; e < 4; e++) {
      let [ax, az] = P[e], [bx, bz] = P[(e + 1) % 4];
      const L = Math.hypot(bx - ax, bz - az) || 1, ux = (((bx - ax) / L) * th) / 2, uz = (((bz - az) / L) * th) / 2;
      ax -= ux; az -= uz; bx += ux; bz += uz; // overlap at the corners
      const k = Math.max(1, Math.ceil((L + th) / 3));
      for (let i = 0; i < k; i++) {
        const t0 = i / k, t1 = (i + 1) / k, lx0 = ax + (bx - ax) * t0, lz0 = az + (bz - az) * t0, lx1 = ax + (bx - ax) * t1, lz1 = az + (bz - az) * t1;
        baseSeg(cx + lx0 * cos + lz0 * sin, cz - lx0 * sin + lz0 * cos, cx + lx1 * cos + lz1 * sin, cz - lx1 * sin + lz1 * cos, th, c);
      }
    }
  }
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
      } else if (e.k === 'charge') { kick(0.1); if (e.stun) popText(e.x, e.z, 'STUNNED!', e.side === viewer); }
      else if (e.k === 'falter') popText(e.x, e.z, 'CHARGE FALTERS!', e.side === viewer);
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
      const p = z.p ?? (z.owner === 0 ? 1 : z.owner === 1 ? -1 : 0); // capture progress -1 (Coalition) .. 1 (French); the backdrop's raw zones have none
      (o.ring2.material as THREE.MeshBasicMaterial).color.setHex(p > 0 ? 0x6f9bff : 0xff6a5c);
      o.ring2.geometry.setDrawRange(0, Math.round(Math.abs(p) * 28) * 6); // the dashes fill clockwise from north as a side takes hold (28 dashes of 6 vertices)
      (o.flag.material as THREE.MeshToonMaterial).color.setHex(c);
    }

    // units
    let nf = 0, nh = 0, ng = 0, nc = 0, nlc = 0, ncp = 0, nsk = 0, nbr = 0, nfl = 0, ncm = 0, nbs = 0, nac = 0, naa = 0, nar = 0, nsh = 0, nbg = 0, npk = 0;
    const live = new Set<number>();
    const seenSet = state.fog ? new Set<number>(state.seen?.[viewer] ?? []) : null; // fog of war: enemies you cannot see are not drawn
    const k = 1 - Math.exp(-10 * dt);
    const sl = [0, 0], farT = far(), byId = new Map<number, any>(state.units.map((q: any) => [q.id, q])); // farT: zoomed out the men grow a little so ranks read as solid blocks, not speckle
    buildCrowd();
    // cull regiments that are clearly off-screen (no figures placed; smoothing and bookkeeping still run). Not on the first frame or after a camera jump.
    const still = camReady && Math.hypot(cam.x - lastCam.x, cam.z - lastCam.z) < 20 && Math.abs(cam.dist / lastCam.d - 1) < 0.2 && Math.abs(cam.yaw - lastCam.y) < 0.1 && Math.abs(tl.v - lastCam.t) < 0.1;
    if (still) frustum.setFromProjectionMatrix(fMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const cw = hudW, ch = hudH; // plates live in HUD pixels
    nb = 0; const bTh = Math.max(0.45, ((cam.dist * ZOOM_K) / bh) * 1.5); // base ribbon: at least ~1.5 buffer pixels wide at any zoom
    for (const u of state.units) {
      live.add(u.id);
      if (seenSet && u.side !== viewer && !seenSet.has(u.id)) { // fog of war: not drawn, but its plate lingers faintly where it was last seen
        const hp = plateMap.get(u.id), lv = vis.get(u.id), ago = state.t - (lv?.seenT ?? -1e9);
        if (hp && lv && ago < GHOST) {
          v3.set(lv.x, heightAt(scn, lv.x, lv.z) + 4.5 * FS, lv.z).project(camera);
          const ok = v3.z < 1 && Math.abs(v3.x) < 1.1 && Math.abs(v3.y) < 1.1;
          hp.el.style.display = ok ? '' : 'none';
          if (ok) hp.el.style.transform = `translate(${Math.round(((v3.x + 1) / 2) * cw)}px,${Math.round(((1 - v3.y) / 2) * ch)}px) translate(-50%,-100%)`;
          if (hp.ls !== 'ghost') { hp.el.className = 'plate pip ghost'; hp.ls = 'ghost'; }
          hp.el.style.opacity = String(Math.round((1 - ago / GHOST) * 10) / 10);
        } else if (hp) hp.el.style.display = 'none';
        continue;
      }
      let v = vis.get(u.id);
      if (v && state.t - (v.seenT ?? state.t) > 0.5) { v = undefined; plateMap.get(u.id)?.el.style.removeProperty('opacity'); } // back in sight after a while: place it afresh instead of sliding from where it was last seen
      if (!v) { v = { x: u.x, z: u.z, f: u.facing, m: new Float32Array(0), form: '', rs: 0, side: u.side, kind: 0 }; vis.set(u.id, v); }
      v.seenT = state.t;
      const px0 = v.x, pz0 = v.z;
      v.x += (u.x - v.x) * k; v.z += (u.z - v.z) * k;
      v.rs += (Math.hypot(v.x - px0, v.z - pz0) / Math.max(dt, 1e-3) - v.rs) * Math.min(1, dt * 4); // how fast the regiment itself is going
      let df = u.facing - v.f; df = Math.atan2(Math.sin(df), Math.cos(df)); v.f += Math.max(-4 * dt, Math.min(4 * dt, df * (1 - Math.exp(-8 * dt)))); // never faster than 4 rad/s
      const T = tu.types[u.type];
      const isArt = u.type === 'artillery', isCav = T.cav;
      const nGun = isArt ? Math.max(1, Math.ceil(u.men / 54)) : 0;
      const n = isArt ? nGun * 2 : Math.max(1, Math.min(u.garrison != null ? 10 : 1e9, Math.ceil(u.men / T.perFig))); // a garrison shows a handful of men at the walls
      if (v.n && n < v.n) for (let q = 0; q < Math.min(3, v.n - n); q++) spawn(3, v.x + (Math.random() - 0.5) * 10, heightAt(scn, v.x, v.z) + 0.6, v.z + (Math.random() - 0.5) * 5, 0.5, 2.6); // men falling
      v.n = n; v.side = u.side; v.kind = isArt ? 2 : isCav ? 1 : 0;
      if (v.m.length < n * MS) { const o = new Float32Array(n * MS + 40 * MS).fill(NaN); o.set(v.m); v.m = o; } // NaN = a new man, placed straight on his slot
      // footprint ~25*FS plus 15 for shadows thrown into view and the one-frame-old camera; men snap back to their slots when it returns (form = '')
      const cull = still && !frustum.intersectsSphere(cullS.set(v3.set(v.x, heightAt(scn, v.x, v.z), v.z), 25 * FS + 15));
      const tf = u.facing, st = Math.sin(tf), ct = Math.cos(tf); // slots follow the order's facing at once; the men take their time getting there
      tmpC.setHex(u.routed ? 0x8d8a82 : NAT[u.nat] ?? 0x888888);
      if (u.hurt < 0.18 && !u.routed) tmpC.lerp(WHITE, 0.6); // hit flash
      plumeC.setHex(u.type === 'skirmisher' ? 0x4a8a3a : PLUME[u.nat] ?? 0xe9e4d6);
      const charging = u.chase != null || u.eng != null, inFight = u.fired < (T.reload || 6) * 1.5;
      const foe = u.eng != null ? byId.get(u.eng) : null, foeA = foe ? Math.atan2(foe.x - v.x, foe.z - v.z) : 0; // melee: the ranks break into a scrum facing the enemy
      // one tin figure, standing at (x, y, z) facing yaw, or sitting in a horse's saddle; mv = this man is on the move, s = his step (sin of his own gait phase)
      const addFig = (fi: number, x: number, y: number, z: number, yaw: number, sc0: number, mount: THREE.Matrix4 | null, mv: boolean, s: number) => {
        const h1 = hash(u.id * 13 + fi * 7), h2 = hash(u.id * 5 + fi * 3), h3 = hash(u.id * 3 + fi * 11), rider = mount != null, walk = mv && !rider;
        if (mount) mRoot.compose(V.set(0, 1.44 - HY - HIP * 1.1, -0.02), Q.identity(), SV.setScalar(1.1)).premultiply(mount);
        else { const sc = sc0 * grow * (0.95 + h1 * 0.1); rootAt(mRoot, x, y + (walk && Math.abs(s) > 0.55 ? 0.1 * sc : 0), z, yaw, sc); baseM.setMatrixAt(nbs++, mRoot); } // toy hop on each step
        const lf = u.fired - h3 * 0.2, kick = lf >= 0 && lf < 0.25 ? 1 - lf / 0.25 : 0; // the volley ripples down the line
        const aim = !rider && !u.routed && u.type !== 'commander' && (charging || inFight && (u.type === 'skirmisher' ? (u.fired + h3 * 5) % 5 < 1.6 : u.fired < 0.8 || u.reload < 0.8));
        const jab = foe ? Math.max(0, Math.sin(clock * 7 + h2 * 6.28)) : 0; // bayonet thrusts and sabre cuts in melee
        const lean = rider ? 0 : u.routed ? 0.4 : walk ? (charging ? 0.24 : 0.08) : foe ? 0.12 + jab * 0.12 : 0;
        joint(mBody, mRoot, 0, HIP, 0, lean - kick * 0.12, walk ? s * 0.07 : Math.sin(clock * 0.9 + h1 * 40) * 0.025); // marching sway, or a slow idle shift of weight
        tmpC2.copy(tmpC).multiplyScalar(0.94 + h3 * 0.12); body.setMatrixAt(nf, mBody); body.setColorAt(nf, tmpC2);
        if (!rider && u.type !== 'commander') packM.setMatrixAt(npk++, mBody);
        const stride = walk ? s * (charging || u.routed ? 0.75 : 0.5) : 0;
        joint(mPart, mRoot, 0, HIP, 0, rider ? -0.6 : stride, rider ? 0.5 : 0); legL.setMatrixAt(nf, mPart);
        joint(mPart, mRoot, 0, HIP, 0, rider ? -0.6 : -stride, rider ? -0.5 : 0); legR.setMatrixAt(nf++, mPart);
        // arms: sabre and reins for riders and generals, musket levelled when firing or charging, else shouldered (swinging on the march, thrown up in a rout)
        const ride = rider || u.type === 'commander', am = ride ? armsRide : aim ? armsAim : armsCarry, ai = ride ? nar++ : aim ? naa++ : nac++;
        const ap = ride ? (foe ? 0.4 + Math.sin(clock * 8 + h2 * 6.28) * 0.8 : charging && mv ? (u.type === 'lancer' ? 1.5 : 1.2) + s * 0.08 : 0)
          : aim ? (charging ? 0.3 + jab * 0.3 : 0) - kick * 0.35 : u.routed ? -0.6 + s * 0.5 : walk ? s * 0.08 : 0;
        joint(mPart, mBody, 0, SH - HIP, 0, ap); am.setMatrixAt(ai, mPart); am.setColorAt(ai, tmpC2);
        if (u.type === 'lancer') { lanceM.setMatrixAt(nlc, mPart); lanceM.setColorAt(nlc++, tmpC); }
        if (u.type === 'cuirassier') cuirM.setMatrixAt(nc++, mBody);
        else if (u.type === 'guard') bearM.setMatrixAt(nbr++, mBody);
        else if (u.type === 'commander') bicM.setMatrixAt(ncm++, mBody);
        else if (u.type === 'lancer' && u.nat === 'pr') capM.setMatrixAt(ncp++, mBody);
        else if (u.nat === 'gb') { belgM.setMatrixAt(nbg, mBody); belgM.setColorAt(nbg++, plumeC); }
        else { shakoM.setMatrixAt(nsh, mBody); shakoM.setColorAt(nsh++, plumeC); }
        if (u.type === 'skirmisher') skirM.setMatrixAt(nsk++, mBody);
      };
      const fb = [1e9, -1e9, 1e9, -1e9]; // the figures' footprint in the regiment's frame, for its base
      const snapAll = v.form === '', top = v.rs * 1.2 + T.speed * 1.1, gait = (u.routed ? 13 : charging ? 11 : 8) / T.speed;
      // zoomed out: every 2nd/3rd man is drawn, bigger, so ranks still read as men (not barcode, not a slab); guns keep their crew
      const thin = isArt ? 1 : cam.dist > 440 ? 3 : cam.dist > 260 ? 2 : 1, grow = thin === 3 ? 1.7 : thin === 2 ? 1.45 : 1 + 0.3 * farT;
      for (let i = 0; i < (cull ? 0 : n); i++) {
        if (thin > 1 && i % thin) continue;
        if (isArt) {
          const g = i >> 1, lx = (g - (nGun - 1) / 2) * 4.2 + (i & 1 ? 1.4 : -1.4), lz = i & 1 ? -2.4 : 0;
          sl[0] = lx; sl[1] = lz;
        } else slots(u, n, i, sl);
        const hm = hash(u.id * 17 + i * 29);
        if (u.type === 'skirmisher' && !u.routed) { sl[0] += Math.sin(clock * 0.25 + hm * 30) * 1.2; sl[1] += Math.cos(clock * 0.21 + hm * 17) * 0.8; } // skirmishers drift about their posts
        sl[0] *= FS; sl[1] *= FS; // everything is laid out FS times wider
        let tx = v.x + sl[0] * ct + sl[1] * st, tz = v.z - sl[0] * st + sl[1] * ct, face = tf;
        if (foe) { // close up to the contact line (never past it), a little ragged along the front
          const pull = Math.max(0, Math.min(1.6 * FS, Math.hypot(foe.x - u.x, foe.z - u.z) / 2 - 0.8 * FS)), lat = (hm - 0.5) * 1.2 * FS;
          tx += Math.sin(foeA) * pull + Math.cos(foeA) * lat; tz += Math.cos(foeA) * pull - Math.sin(foeA) * lat; face = foeA + (hm - 0.5) * 0.6;
        }
        // each man walks to his slot: his own top speed and reaction, easing in on arrival, so wheels, formation changes and gaps in the ranks play out man by man
        const m = v.m, o = i * MS;
        if (snapAll || m[o] !== m[o] || Math.hypot(tx - m[o], tz - m[o + 1]) > 40 * FS) { m[o] = tx; m[o + 1] = tz; m[o + 2] = face; m[o + 3] = m[o + 4] = 0; m[o + 5] = hm * 6.28; }
        else {
          const dx = tx - m[o], dz = tz - m[o + 1], d = Math.hypot(dx, dz), want = d > 1e-3 ? Math.min(top * (0.85 + 0.3 * hm), d * 2.5) / d : 0, a = Math.min(1, dt * (2.5 + 3 * hm));
          m[o + 3] += (dx * want - m[o + 3]) * a; m[o + 4] += (dz * want - m[o + 4]) * a;
          m[o] += m[o + 3] * dt; m[o + 1] += m[o + 4] * dt;
          // shoulder apart from other men (a bayonet's length from the enemy, so a melee forms a fighting line) and slide round houses
          const rI = figR(v.kind, i), c0 = cellOf(m[o]), c1 = cellOf(m[o + 1]);
          let qx = 0, qz = 0, ne = 1e9, nex = 0, nez = 0;
          for (let r = Math.max(0, c1 - 1); r <= Math.min(cW - 1, c1 + 1); r++) for (let c = Math.max(0, c0 - 1); c <= Math.min(cW - 1, c0 + 1); c++) {
            for (let e = cStart[r * cW + c], e1 = cStart[r * cW + c + 1]; e < e1; e++) {
              const q = cOrd[e];
              if (cU[q] === u.id && cI[q] === i) continue;
              const ex = m[o] - cX[q], ez = m[o + 1] - cZ[q], foeQ = cS[q] >= 0 && cS[q] !== u.side, min = rI + cR[q] + (foeQ ? 0.5 * FS : 0), d2 = ex * ex + ez * ez;
              if (foeQ && d2 < ne) { ne = d2; nex = -ex; nez = -ez; }
              if (d2 >= min * min || d2 < 1e-8) continue;
              const dd = Math.sqrt(d2), p = ((min - dd) * (cU[q] < 0 ? 1 : 0.5)) / dd; // houses don't give way; men share the shove
              qx += ex * p; qz += ez * p;
            }
          }
          const kq = Math.min(1, dt * 10); m[o] += qx * kq; m[o + 1] += qz * kq;
          if (foe) { const over = (m[o] - (u.x + foe.x) / 2) * Math.sin(foeA) + (m[o + 1] - (u.z + foe.z) / 2) * Math.cos(foeA) + 0.6 * FS; if (over > 0) { m[o] -= Math.sin(foeA) * over; m[o + 1] -= Math.cos(foeA) * over; } } // each side keeps to its own half of the melee
          if (foe && ne < 9 * FS * FS) face = Math.atan2(nex, nez); // pair off with the nearest foe
          const sp = Math.hypot(m[o + 3], m[o + 4]), head = d > 1.5 * FS && sp > 0.3 ? Math.atan2(m[o + 3], m[o + 4]) : face; // march where he's going; shuffle the last steps facing the front
          let dh = head - m[o + 2]; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); m[o + 2] += Math.max(-6 * dt, Math.min(6 * dt, dh));
          m[o + 5] += dt * gait * Math.max(0.6, Math.min(1.8, sp)); // his own gait phase, faster when he hurries
        }
        const wx = m[o], wz = m[o + 1], yaw = m[o + 2], mv = Math.hypot(m[o + 3], m[o + 4]) > 0.25, s = Math.sin(m[o + 5]);
        const lx = (wx - v.x) * ct - (wz - v.z) * st, lz = (wx - v.x) * st + (wz - v.z) * ct;
        fb[0] = Math.min(fb[0], lx); fb[1] = Math.max(fb[1], lx); fb[2] = Math.min(fb[2], lz); fb[3] = Math.max(fb[3], lz);
        const y = heightAt(scn, wx, wz);
        if ((u.routed || isCav && mv) && Math.random() < dt * (u.routed ? 0.12 : 0.05)) spawn(3, wx, y + 0.5, wz, 0.5, 2.4);
        if (isArt) {
          if (!(i & 1)) { // the gun leaps back when it fires, then is run up again
            const back = u.fired < 0.08 ? u.fired / 0.08 : Math.max(0, 1 - (u.fired - 0.08) / 1.4);
            rootAt(mRoot, wx, y, wz, yaw, 1.3 * FS); joint(mPart, mRoot, 0, 0, -0.7 * back, u.fired < 0.3 ? -0.08 * (1 - u.fired / 0.3) : 0); guns.setMatrixAt(ng++, mPart);
          } else if (nf < 4990) addFig(i, wx, y, wz, yaw, 1.7 * FS, null, mv, s);
        } else if (isCav) {
          if (nh < 1490 && nf < 4990) { // gallop: the body rocks, front and hind legs reach and gather in turn
            const hp = m[o + 5] * 1.4, hs = Math.sin(hp), gal = mv ? (charging ? 1 : 0.55) : 0;
            rootAt(mRoot, wx, y, wz, yaw, 1.4 * FS * grow); hbaseM.setMatrixAt(nh, mRoot);
            joint(mHorse, mRoot, 0, HY + gal * Math.abs(Math.cos(hp)) * 0.14, 0, gal ? gal * hs * 0.12 : Math.sin(clock * 0.7 + i) * 0.02);
            const hc = HORSE_COL[Math.floor(hash(u.id * 7 + i) * 4)];
            horses.setMatrixAt(nh, mHorse); horses.setColorAt(nh, hc); legsF.setColorAt(nh, hc); legsH.setColorAt(nh, hc);
            joint(mPart, mHorse, 0, 0.98 - HY, 0.55, -gal * hs * 0.6); legsF.setMatrixAt(nh, mPart);
            joint(mPart, mHorse, 0, 1.0 - HY, -0.55, gal * Math.sin(hp + 2.2) * 0.55); legsH.setMatrixAt(nh++, mPart);
            addFig(i, 0, 0, 0, 0, 0, mHorse, mv, hs);
          }
        } else if (nf < 4990) addFig(i, wx, y, wz, yaw, 1.7 * FS, null, mv, s);
      }
      v.form = cull || thin > 1 ? '' : u.form; // '' = every man snaps to his slot when the camera comes back in
      if (fb[0] < 1e9) { const mg = (isCav ? 1.4 : 0.9) * FS; baseRing(v.x, v.z, st, ct, [fb[0] - mg, fb[1] + mg, fb[2] - mg, fb[3] + mg], bTh, u.routed ? BASE_COL.routed : u.side === viewer ? BASE_COL.mine : BASE_COL.foe); }
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
        el.style.setProperty('--side', u.side === viewer ? '#4f86ff' : '#e8463a'); // yours vs the enemy's, matching the bases
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
      const full = showAll || selected.has(u.id) || u.id === hoverId || u.routed || u.eng != null || u.stun > 0 || u.morale < u.maxMorale * 0.4; // in trouble: routed, in melee, stunned or shaken
      const cls = `plate${full ? '' : ' pip'}${selected.has(u.id) ? ' sel' : ''}${u.routed ? ' routed' : u.stun > 0 ? ' stun' : u.shaken > 0 ? ' shaken' : u.morale < u.maxMorale * 0.3 ? ' waver' : ''}`;
      if (cls !== p.ls) { p.el.className = cls; p.ls = cls; }
    }
    horses.count = legsF.count = legsH.count = hbaseM.count = nh; guns.count = ng; cuirM.count = nc; lanceM.count = nlc; capM.count = ncp; skirM.count = nsk; baseM.count = nbs; packM.count = npk;
    body.count = legL.count = legR.count = shadowP.count = nf; armsCarry.count = nac; armsAim.count = naa; armsRide.count = nar; shakoM.count = nsh; belgM.count = nbg; bearM.count = nbr; bicM.count = ncm; flagM.count = bannerM.count = eagleM.count = nfl;
    const figs = [body, packM, legL, legR, armsCarry, armsAim, armsRide, baseM, shakoM, belgM, bearM, cuirM, capM, bicM, skirM, lanceM, horses, legsF, legsH, hbaseM, guns];
    // upload only the live [0, count) slice; clear first so ranges never pile up across frames (hull twins share these attributes)
    const upl = (a: THREE.BufferAttribute, n: number, sz: number) => { a.clearUpdateRanges(); if (n > 0) { a.addUpdateRange(0, n * sz); a.needsUpdate = true; } };
    for (const m of [...figs, flagM, bannerM, eagleM]) upl(m.instanceMatrix, m.count, 16);
    for (const m of [...figs, bannerM]) if (m.instanceColor) upl(m.instanceColor, m.count, 3);
    baseGeo.setDrawRange(0, nb * 6); upl(baseGeo.attributes.position as THREE.BufferAttribute, nb * 6, 3); upl(baseGeo.attributes.color as THREE.BufferAttribute, nb * 6, 3);
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
  let hs = 2, hudW = 640, hudH = 360; // hs = CSS px per HUD pixel, derived from the world pixel size in resize()
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
    hullU.uW.value = px * 0.95 * (1 - far()); // 1 buffer pixel of ink close up, thinning to none zoomed out: a 1px outline of any colour outweighs a 2-3px soldier and greys him
    for (const q of outlined) q.o.count = q.m.count;

    const savedBg = scene.background, savedFog = scene.fog;
    if (silhouette) {
      scene.overrideMaterial = silMat; scene.background = silBg; scene.fog = null; fxMesh.visible = craters.visible = false;
      for (const o of terrain) o.visible = false;
      for (const q of outlined) q.o.visible = false;
      shadowP.visible = baseMesh.visible = false; // overrideMaterial would paint the invisible shadow box solid; bases aren't part of the silhouette
    }
    renderer.setRenderTarget(rt); renderer.render(scene, camera);
    if (silhouette) {
      scene.overrideMaterial = null; scene.background = savedBg; scene.fog = savedFog; fxMesh.visible = craters.visible = true;
      for (const o of terrain) o.visible = true;
      for (const q of outlined) q.o.visible = true;
      shadowP.visible = baseMesh.visible = true;
    }
    camReady = true; lastCam.x = cam.x; lastCam.z = cam.z; lastCam.d = cam.dist; lastCam.y = cam.yaw; lastCam.t = tl.v;

    renderer.setRenderTarget(null); renderer.render(postScene, postCam);
  }

  function resize() {
    const w = host.clientWidth || innerWidth, h = host.clientHeight || innerHeight;
    dpr = devicePixelRatio || 1; const W = w * dpr, H = h * dpr; // pick S in physical pixels so each buffer pixel covers whole screen pixels at any OS display scaling
    S = upscale(quality, H);
    hs = Math.max(2, Math.min(S, Math.floor(W / 640))) / dpr; // one HUD pixel = one world pixel (S), but never under 2 screen px (legible) or wider than the 640-wide layout allows; whole physical px at any OS scaling
    const sm = quality >= 2 ? 4096 : 2048;
    if (sun.shadow.mapSize.x !== sm) { sun.shadow.mapSize.set(sm, sm); sun.shadow.map?.dispose(); (sun.shadow as any).map = null; } // finer shadows at High and Native
    bw = Math.ceil(W / S); bh = Math.ceil(H / S);
    hudW = (bw * S) / dpr / hs; hudH = (bh * S) / dpr / hs;
    renderer.setSize(bw, bh, false); rt.setSize(bw, bh); post.uniforms.res.value.set(bw, bh);
    canvas.style.width = (bw * S) / dpr + 'px'; canvas.style.height = (bh * S) / dpr + 'px';
    const rs = document.documentElement.style; rs.setProperty('--S', String(hs)); rs.setProperty('--u', hs + 'px'); const wide = hudW >= 760; rs.setProperty('--lbl', wide ? 'inline' : 'none'); rs.setProperty('--tp', wide ? '166px' : '6px'); rs.setProperty('--bw', String(Math.ceil(hudW))); rs.setProperty('--bh', String(Math.ceil(hudH))); // HUD and plates are laid out in HUD pixels, scaled by hs
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
  const setHover = (id: number | null) => { hoverId = id ?? -1; }, setShowAll = (on: boolean) => { showAll = on; };
  const setDragLine = (d: typeof dragLine) => { dragLine = d; };
  function setReticle(x: number | null, z = 0, r = 10, color = 0xffffff) {
    if (x == null) { reticle.visible = false; return; }
    reticle.visible = true; reticle.position.set(x, heightAt(scn, x, z) + 1, z); reticle.scale.setScalar(r);
    (reticle.material as THREE.MeshBasicMaterial).color.setHex(color);
  }

  return { dom: canvas, cam, shake, setDusk, setSilhouette, setTopDown, rotate90, cycleQuality, get quality() { return QUALITY[quality].split(':')[0]; }, get guide() { return guideOn(); }, setScenario, sync, render, resize, flyTo, zoomBy, kick, pan, setWeather, ground, toScreen, pickUnit, unitsIn, setSelection, setReticle, setRefillHint, setDragLine, setHover, setShowAll, selected, get mapSize() { return mapSize; }, stopCam: () => camAnim?.pause() };
}
export type View = ReturnType<typeof createView>;
