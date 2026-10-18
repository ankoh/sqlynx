import * as THREE from 'three';

import { pointAlpha, pointSize, shapeCoords } from './point_cloud_shape.js';

const POINT_COUNT = 1000;
/// Radians per second around the rotation axis
const ROTATION_SPEED = 0.07;
/// How close the pointer has to be to a small dot, in CSS pixels. Bigger dots are picked on their whole disc.
const PICK_RADIUS = 12;
/// Nominal size of the made up dots, which vary a little
const DEMO_POINT_SIZE = 2.2;
/// Per second, how fast the rotation eases to a halt and back
const ROTATION_EASING = 6;
/// How far the dots wander off their place in scene units, and how fast the flow field that moves them changes
const DRIFT_AMPLITUDE = 0.014;
const DRIFT_SPEED = 0.35;
/// Seconds a dot needs to fly to a new place, and up to how much later some of them start
const MORPH_DURATION = 1.4;
const MORPH_STAGGER = 0.45;
/// How far the dots swing outward halfway through their flight, relative to their distance from the center
const MORPH_BULGE = 0.12;
/// Radians the cloud leans toward the pointer when it is at the edge of the container
const PARALLAX_TILT = 0.12;
/// Per second, how fast the lean follows the pointer
const PARALLAX_EASING = 3;
/// Dots within this distance of the pointer grow, in CSS pixels
const LENS_RADIUS = 110;
/// Scene units per second that the ripple of a search travels
const RIPPLE_SPEED = 1.6;

/// A dot under the pointer. x and y are client coordinates of the dot, radius is the size of its disc in CSS pixels.
export interface DotHover {
    index: number;
    x: number;
    y: number;
    radius: number;
}

/// Dots on their way from where the previous dots were drawn to their own place
interface Morph {
    attribute: THREE.BufferAttribute;
    from: Float32Array;
    to: Float32Array;
    /// Seconds each dot waits before it starts
    delays: Float32Array;
    start: number;
}

/// A slow flow field that both point sets go through. Neighbors move together, so the cloud breathes
/// instead of jittering. `drifted` computes the same on the CPU for picking.
const DRIFT_GLSL = `
    uniform float uTime;
    vec3 drift(vec3 p) {
        float t = uTime * ${DRIFT_SPEED.toFixed(4)};
        return ${DRIFT_AMPLITUDE.toFixed(4)} * vec3(
            sin(t + p.y * 4.1 + p.z * 2.3),
            sin(t * 0.83 + p.z * 3.7 + p.x * 2.9),
            sin(t * 1.17 + p.x * 4.3 + p.y * 3.1));
    }
`;

function drifted(x: number, y: number, z: number, time: number, out: THREE.Vector3): THREE.Vector3 {
    const t = time * DRIFT_SPEED;
    return out.set(
        x + DRIFT_AMPLITUDE * Math.sin(t + y * 4.1 + z * 2.3),
        y + DRIFT_AMPLITUDE * Math.sin(t * 0.83 + z * 3.7 + x * 2.9),
        z + DRIFT_AMPLITUDE * Math.sin(t * 1.17 + x * 4.3 + y * 3.1),
    );
}

/// The dots are small beads, lit from the top left. They have a cool rim and a highlight.
const BEAD_GLSL = `
    /// The normal of a sphere seen from the front, at a point of its disc. y is up.
    vec3 beadNormal(vec2 p, float radius) {
        vec2 n = p / radius;
        float len = length(n);
        if (len > 1.0) n /= len;
        return vec3(n, sqrt(max(1.0 - dot(n, n), 0.0)));
    }
    vec3 beadColor(vec3 normal) {
        vec3 light = normalize(vec3(-0.45, 0.55, 0.7));
        float diffuse = max(dot(normal, light), 0.0);
        float rim = pow(1.0 - normal.z, 3.0);
        return mix(vec3(0.10, 0.12, 0.15), vec3(0.34, 0.40, 0.48), 0.8 * diffuse) + vec3(0.30, 0.38, 0.50) * 0.5 * rim;
    }
    float beadSpecular(vec3 normal) {
        vec3 light = normalize(vec3(-0.45, 0.55, 0.7));
        return pow(max(dot(reflect(-light, normal), vec3(0.0, 0.0, 1.0)), 0.0), 28.0);
    }
`;

const VERTEX_SHADER = `
    ${DRIFT_GLSL}
    attribute float aSize;
    attribute float aAlpha;
    /// Random per point, offsets its twinkle
    attribute float aPhase;
    /// 1 if the point matches the cross-filters of the rows, only read while uHasSelection is 1
    attribute float aSelected;
    uniform float uPixelRatio;
    /// Distance at which a point has its nominal size, the camera is that far from the center of the cloud
    uniform float uScale;
    uniform float uHasSelection;
    /// The pointer in normalized device coordinates, half the size of the canvas in CSS pixels, and how much the lens
    /// around the pointer shows
    uniform vec2 uPointer;
    uniform vec2 uHalfSize;
    uniform float uLens;
    /// Where and when the ripple of the last search started
    uniform vec3 uRippleOrigin;
    uniform float uRippleStart;
    /// 1 if the points are beads with shading and a shadow, the made up dots are flat
    uniform float uBeads;
    varying float vAlpha;
    varying float vSelected;
    /// Size of the point in device pixels, edges are antialiased over a fixed number of pixels
    varying float vPixels;
    /// 0 in front of the center of the cloud, 1 far behind it, where points are out of focus and fade into the haze
    varying float vFar;
    /// How much the ripple lights the point up
    varying float vWave;
    /// How much of a shadow the point casts around it
    varying float vHalo;
    void main() {
        vec4 mv = modelViewMatrix * vec4(position + drift(position), 1.0);
        gl_Position = projectionMatrix * mv;
        float selected = uHasSelection > 0.5 ? aSelected : 0.0;
        vFar = clamp((-mv.z - uScale) / 1.6, 0.0, 1.0);
        // Out of focus points are bigger and blurred
        float size = aSize * (1.0 + 0.4 * selected) * (1.0 + 0.6 * vFar * vFar);
        // Points near the pointer grow a little, like under a lens
        vec2 ndc = gl_Position.xy / gl_Position.w;
        float lens = uLens * (1.0 - smoothstep(0.0, ${LENS_RADIUS.toFixed(1)}, length((ndc - uPointer) * uHalfSize)));
        size *= 1.0 + 0.5 * lens;
        // The ripple runs outward from the best hit and fades
        float age = uTime - uRippleStart;
        float front = (length(position - uRippleOrigin) - age * ${RIPPLE_SPEED.toFixed(2)}) / 0.16;
        vWave = exp(-front * front) * exp(-age * 0.9);
        size *= 1.0 + 0.9 * vWave;
        float pixels = size * uPixelRatio * uScale / -mv.z;
        // Dots that are big on screen cast a soft shadow, the point grows to make room for it and the bead keeps its size
        vHalo = uBeads * smoothstep(7.0, 14.0, pixels / uPixelRatio) * (1.0 - vFar);
        gl_PointSize = pixels / (1.0 - 0.3 * vHalo);
        vPixels = gl_PointSize;
        vSelected = selected;
        // Points in the back are dimmer, which gives the cloud its depth
        float depth = clamp(1.0 - (-mv.z - uScale + 2.4) / 3.2, 0.3, 1.0);
        // Beads that are see-through lose their shading, the haze and the blur show their depth instead
        depth = mix(depth, 0.65 + 0.35 * depth, uBeads);
        // While there is a selection, the selected points are bright and the others fade
        float alpha = uHasSelection > 0.5 ? mix(aAlpha * 0.15, max(aAlpha, 0.9), selected) : aAlpha;
        // Every point twinkles slowly at its own pace
        alpha *= 0.85 + 0.15 * sin(uTime * 0.6 + aPhase * 6.2832);
        alpha *= depth;
        alpha = mix(alpha, max(alpha, 0.85), 0.7 * lens);
        vAlpha = max(alpha, 0.95 * vWave);
    }
`;

const FRAGMENT_SHADER = `
    varying float vAlpha;
    varying float vSelected;
    varying float vPixels;
    varying float vFar;
    varying float vWave;
    varying float vHalo;
    uniform float uBeads;
    ${BEAD_GLSL}
    void main() {
        // From the center of the point to its edge, y up
        vec2 c = (gl_PointCoord - 0.5) * vec2(2.0, -2.0);
        float r = length(c);
        if (r > 1.0) discard;
        // One device pixel in these units
        float aa = 2.0 / max(vPixels, 1.0);
        // The bead fills the point, unless there is a shadow around it
        float radius = 1.0 - 0.3 * vHalo;
        // An edge about a pixel wide, whatever the size of the point. Out of focus points are soft.
        float soft = mix(1.25 * aa, 0.9 * radius, vFar * vFar);
        float body = 1.0 - smoothstep(radius - soft, radius - 0.25 * aa, r);
        vec3 normal = beadNormal(c, radius);
        // Dots of a few pixels are too small for the shading, they stay flat
        float detail = uBeads * smoothstep(3.0, 8.0, vPixels) * (1.0 - vFar);
        vec3 color = mix(vec3(0.16, 0.19, 0.23), beadColor(normal), detail);
        // Far points take on the cool grey of the haze
        color = mix(color, vec3(0.48, 0.55, 0.64), 0.5 * vFar);
        // Selected points get a blue rim, the accent of the highlights stays for the search candidates
        color = mix(color, vec3(0.04, 0.41, 0.85), vSelected * smoothstep(0.2, 1.0, 1.0 - normal.z));
        color = mix(color, vec3(0.9, 0.55, 0.05), vWave);
        color += vec3(0.7 * detail * (1.0 - vWave) * beadSpecular(normal));
        // The shadow fades out toward the edge of the point
        float outside = clamp((r - radius) / max(1.0 - radius, 0.001), 0.0, 1.0);
        float shadow = vHalo * 0.16 * (1.0 - outside) * (1.0 - outside);
        color = mix(vec3(0.16, 0.19, 0.24), color, body);
        gl_FragColor = vec4(color, vAlpha * max(body, shadow));
    }
`;

/// Highlighted points are drawn on top in the accent color and are not dimmed by depth
const HIGHLIGHT_VERTEX_SHADER = `
    ${DRIFT_GLSL}
    attribute float aEmphasis;
    uniform float uPixelRatio;
    uniform float uScale;
    /// Nominal size of the points that are highlighted
    uniform float uBaseSize;
    varying float vEmphasis;
    varying float vPixels;
    void main() {
        vec4 mv = modelViewMatrix * vec4(position + drift(position), 1.0);
        gl_Position = projectionMatrix * mv;
        float size = aEmphasis > 0.5 ? max(15.0, uBaseSize * 1.7 + 4.0) : max(6.0, uBaseSize * 1.3);
        gl_PointSize = size * uPixelRatio * uScale / -mv.z;
        vPixels = gl_PointSize;
        vEmphasis = aEmphasis;
    }
`;

const HIGHLIGHT_FRAGMENT_SHADER = `
    varying float vEmphasis;
    varying float vPixels;
    void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        // One device pixel in the units of gl_PointCoord
        float aa = 1.0 / max(vPixels, 1.0);
        vec3 accent = vec3(0.9, 0.55, 0.05);
        if (vEmphasis > 0.5) {
            // A bright core with a ring, so that the point is easy to find in the cloud
            float ring = smoothstep(0.34 - aa, 0.34, d) * (1.0 - smoothstep(0.46 - aa, 0.46, d));
            float core = 1.0 - smoothstep(0.16 - aa, 0.16, d);
            gl_FragColor = vec4(mix(accent, vec3(1.0), core), max(core, ring * 0.9));
        } else {
            gl_FragColor = vec4(accent, 0.95 * (1.0 - smoothstep(0.5 - 1.25 * aa, 0.5 - 0.25 * aa, d)));
        }
    }
`;

/// A deterministic generator, so that every visit shows the same cloud
function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomPhases(count: number, seed: number): Float32Array {
    const random = mulberry32(seed);
    const phases = new Float32Array(count);
    for (let i = 0; i < count; ++i) phases[i] = random();
    return phases;
}

/// Ease in and out, so that the dots leave and arrive slowly
function easeInOutCubic(p: number): number {
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

/// Small dark beads that slowly turn around a center point, like the pairing screen of the Apple Watch. The rotation axis
/// is tilted and drifts a little, which makes the motion wobble. Every dot also drifts and twinkles a little on its own,
/// the cloud leans toward the pointer and the dots near it grow.
///
/// The dots are made up until `setPoints` replaces them with the indexed scripts, they fly from where the previous dots
/// were. `setHighlight` marks some of those, `setSelection` fades all others and `ripple` sends a wave through the cloud.
export class PointCloud {
    private readonly renderer: THREE.WebGLRenderer;
    private readonly scene = new THREE.Scene();
    private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20);
    /// Leans toward the pointer
    private readonly tilt = new THREE.Group();
    /// Rotates all point sets together
    private readonly root = new THREE.Group();
    private readonly cloud: THREE.Points;
    private readonly material: THREE.ShaderMaterial;
    private readonly demoGeometry: THREE.BufferGeometry;
    private dataGeometry: THREE.BufferGeometry | null = null;
    private readonly highlights: THREE.Points;
    private readonly highlightMaterial: THREE.ShaderMaterial;
    private highlightGeometry: THREE.BufferGeometry | null = null;
    /// Positions of both point sets at rest (inside `root`), kept for highlights and picking. The drawn positions differ
    /// while the dots fly to their place.
    private demoPositions = new Float32Array(0);
    private dataPositions: Float32Array | null = null;
    private morph: Morph | null = null;
    /// The made up dots are shown, as long as `setPoints` was not called
    private showingDemo = true;
    /// Nominal size of the indexed points, depends on how many there are
    private dataSize = DEMO_POINT_SIZE;
    /// A bit per indexed point that matches the cross-filters, null if nothing is filtered
    private selection: Uint32Array | null = null;
    /// The pointer in client coordinates. The dot under it is reported to the hover listener.
    private pointer: { x: number; y: number } | null = null;
    private hoveredDot = -1;
    /// The pointer anywhere in the window, from -1 to 1 across the container. The cloud leans toward it.
    private readonly parallax = { x: 0, y: 0 };
    /// 1 while the pointer is over the cloud, the lens fades in and out
    private lens = 0;
    private rotationPaused = false;
    /// 1 while the cloud turns, eases to 0 when it is held
    private rotationSpeed = 1;
    private hoverListener: ((hover: DotHover | null) => void) | null = null;
    private readonly pickVector = new THREE.Vector3();
    private readonly resizeObserver: ResizeObserver;
    /// The container in device pixels, when the browser reports it
    private devicePixels: { width: number; height: number } | null = null;
    /// The size of the canvas and its pixels per CSS pixel, as of the last resize
    private canvas = { width: 1, height: 1, scale: 1 };
    /// How much of the bottom of the container is covered, in CSS pixels. The cloud is centered in the space above.
    private bottomInset = 0;
    private readonly clock = new THREE.Clock(false);
    /// Seconds the animation ran, without the time the page was hidden
    private time = 0;
    private readonly axis = new THREE.Vector3();
    private animationFrame = 0;
    private disposed = false;
    private running = false;

    constructor(private readonly container: HTMLElement) {
        this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.domElement.setAttribute('aria-hidden', 'true');
        this.container.append(this.renderer.domElement);
        this.camera.position.set(0, 0, 4.4);

        this.demoGeometry = this.createGeometry();
        this.material = new THREE.ShaderMaterial({
            vertexShader: VERTEX_SHADER,
            fragmentShader: FRAGMENT_SHADER,
            transparent: true,
            depthWrite: false,
            uniforms: {
                uTime: { value: 0 },
                uPixelRatio: { value: 1 },
                uScale: { value: 1 },
                uHasSelection: { value: 0 },
                uPointer: { value: new THREE.Vector2() },
                uHalfSize: { value: new THREE.Vector2(1, 1) },
                uLens: { value: 0 },
                uRippleOrigin: { value: new THREE.Vector3() },
                uRippleStart: { value: -1000 },
                uBeads: { value: 0 },
            },
        });
        this.cloud = new THREE.Points(this.demoGeometry, this.material);
        this.highlightMaterial = new THREE.ShaderMaterial({
            vertexShader: HIGHLIGHT_VERTEX_SHADER,
            fragmentShader: HIGHLIGHT_FRAGMENT_SHADER,
            transparent: true,
            depthWrite: false,
            depthTest: false,
            uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uScale: { value: 1 }, uBaseSize: { value: DEMO_POINT_SIZE } },
        });
        this.highlights = new THREE.Points(new THREE.BufferGeometry(), this.highlightMaterial);
        this.highlights.renderOrder = 1;
        this.highlights.visible = false;
        // The points move in the shaders, the bounding spheres of the geometries do not know where they are
        for (const object of [this.cloud, this.highlights]) object.frustumCulled = false;
        this.root.add(this.cloud, this.highlights);
        // Start tilted, so that the first frame already looks lively
        this.root.rotation.set(0.5, 0, 0.3);
        this.tilt.add(this.root);
        this.scene.add(this.tilt);
        // The made up dots unfold out of the center
        this.flyIn(this.demoGeometry, this.demoPositions, this.demoPositions.map(v => v * 0.15));

        this.resizeObserver = new ResizeObserver(this.observe);
        try {
            // Reports the size in device pixels, which is the size the canvas has to be to stay sharp
            this.resizeObserver.observe(this.container, { box: 'device-pixel-content-box' });
        } catch {
            this.resizeObserver.observe(this.container);
        }
        this.resize();
        this.renderOnce();
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
        window.addEventListener('pointermove', this.handleWindowPointer, { passive: true });
        document.documentElement.addEventListener('pointerleave', this.handleWindowLeave);
    }

    start(): void {
        if (this.running || this.disposed) return;
        this.running = true;
        this.resume();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.running = false;
        cancelAnimationFrame(this.animationFrame);
        this.resizeObserver.disconnect();
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        window.removeEventListener('pointermove', this.handleWindowPointer);
        document.documentElement.removeEventListener('pointerleave', this.handleWindowLeave);
        this.demoGeometry.dispose();
        this.dataGeometry?.dispose();
        this.highlightGeometry?.dispose();
        this.material.dispose();
        this.highlightMaterial.dispose();
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }

    /// Show indexed embeddings instead of the made up dots. `coords` has 3 values per embedding, none shows nothing.
    setPoints(coords: Float32Array): void {
        const previous = this.drawnPositions();
        this.morph = null;
        this.dataGeometry?.dispose();
        this.dataGeometry = null;
        this.dataPositions = null;
        this.setDotHover(-1);
        this.showingDemo = false;
        this.setHighlight([], []);
        const count = coords.length / 3;
        this.cloud.visible = count > 0;
        if (count === 0) {
            this.renderOnce();
            return;
        }
        // The more scripts, the smaller the points, and the wider the cloud
        const size = pointSize(count);
        const positions = shapeCoords(coords);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
        geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(count).fill(size), 1));
        geometry.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(count).fill(pointAlpha(count)), 1));
        geometry.setAttribute('aPhase', new THREE.BufferAttribute(randomPhases(count, 11), 1));
        geometry.setAttribute('aSelected', new THREE.BufferAttribute(new Float32Array(count), 1));
        this.dataGeometry = geometry;
        this.selection = null;
        this.material.uniforms.uHasSelection.value = 0;
        this.material.uniforms.uBeads.value = 1;
        this.dataPositions = positions;
        this.dataSize = size;
        this.highlightMaterial.uniforms.uBaseSize.value = size;
        this.cloud.geometry = geometry;
        this.flyIn(geometry, positions, previous);
        this.renderOnce();
    }

    /// Back to the made up dots
    clearPoints(): void {
        const previous = this.drawnPositions();
        const wasDemo = this.showingDemo;
        this.dataGeometry?.dispose();
        this.dataGeometry = null;
        this.dataPositions = null;
        this.selection = null;
        this.material.uniforms.uHasSelection.value = 0;
        this.showingDemo = true;
        this.material.uniforms.uBeads.value = 0;
        this.dataSize = DEMO_POINT_SIZE;
        this.highlightMaterial.uniforms.uBaseSize.value = DEMO_POINT_SIZE;
        this.setHighlight([], []);
        this.cloud.geometry = this.demoGeometry;
        this.cloud.visible = true;
        // The made up dots that are already shown keep flying, if they still unfold
        if (!wasDemo) this.flyIn(this.demoGeometry, this.demoPositions, previous);
        this.renderOnce();
    }

    /// Hold the rotation, so that hovered points stay where they are
    setRotationPaused(paused: boolean): void {
        this.rotationPaused = paused;
    }

    /// Mark points by their index, in the coords of `setPoints` or in the made up dots. The hovered ones are emphasized.
    setHighlight(candidates: readonly number[], hovered: readonly number[]): void {
        const coords = this.restingPositions();
        const inside = (i: number) => i >= 0 && i * 3 < coords.length;
        const emphasized = new Set(hovered.filter(inside));
        const indices = [...candidates.filter(i => inside(i) && !emphasized.has(i)), ...emphasized];
        this.highlightGeometry?.dispose();
        this.highlightGeometry = null;
        this.highlights.visible = indices.length > 0;
        if (indices.length > 0) {
            const positions = new Float32Array(indices.length * 3);
            const emphasis = new Float32Array(indices.length);
            indices.forEach((index, i) => {
                for (let d = 0; d < 3; ++d) positions[i * 3 + d] = coords[index * 3 + d];
                emphasis[i] = emphasized.has(index) ? 1 : 0;
            });
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setAttribute('aEmphasis', new THREE.BufferAttribute(emphasis, 1));
            this.highlightGeometry = geometry;
            this.highlights.geometry = geometry;
        }
        this.renderOnce();
    }

    /// Fade the indexed points that are not in `selection`, a bit per point in the coords of `setPoints`. None shows all
    /// points as they are.
    setSelection(selection: Uint32Array | null): void {
        const geometry = this.dataGeometry;
        this.selection = geometry == null ? null : selection;
        this.material.uniforms.uHasSelection.value = this.selection == null ? 0 : 1;
        if (geometry != null) {
            const attribute = geometry.getAttribute('aSelected') as THREE.BufferAttribute;
            const values = attribute.array as Float32Array;
            for (let i = 0; i < values.length; ++i) values[i] = this.isSelected(i) ? 1 : 0;
            attribute.needsUpdate = true;
        }
        // Faded points cannot be hovered
        if (this.hoveredDot >= 0 && !this.isSelected(this.hoveredDot)) this.setDotHover(-1);
        this.renderOnce();
    }

    /// Send a wave through the cloud that starts at a point, by its index in the coords of `setPoints`
    ripple(origin: number): void {
        const coords = this.restingPositions();
        if (origin < 0 || origin * 3 >= coords.length) return;
        (this.material.uniforms.uRippleOrigin.value as THREE.Vector3).fromArray(coords, origin * 3);
        this.material.uniforms.uRippleStart.value = this.time;
    }

    private isSelected(index: number): boolean {
        const selection = this.selection;
        return selection == null || ((selection[index >>> 5] >>> (index & 31)) & 1) === 1;
    }

    /// Receives the dot under the pointer on every frame while there is one, and null once there is none
    setHoverListener(listener: ((hover: DotHover | null) => void) | null): void {
        this.hoverListener = listener;
    }

    /// Where the pointer is, in client coordinates, or null when it left
    setPointer(pointer: { x: number; y: number } | null): void {
        this.pointer = pointer;
        if (pointer == null) this.setDotHover(-1);
    }

    setBottomInset(inset: number): void {
        if (inset === this.bottomInset) return;
        this.bottomInset = inset;
        // The backdrop of the page centers its light on the cloud
        this.container.style.setProperty('--cloud_inset', `${inset}px`);
        this.updateViewOffset();
        this.renderOnce();
    }

    private setDotHover(index: number): void {
        if (index === this.hoveredDot) return;
        this.hoveredDot = index;
        // What lights up is up to the listener, it knows which dots belong together
        if (index < 0) this.hoverListener?.(null);
    }

    /// Where the points of the shown set are at rest
    private restingPositions(): Float32Array {
        return this.showingDemo ? this.demoPositions : this.dataPositions ?? new Float32Array(0);
    }

    /// Where the points of the shown set are drawn right now, none if nothing is shown
    private drawnPositions(): Float32Array | null {
        if (!this.cloud.visible) return null;
        return (this.cloud.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    }

    /// Let the dots of `geometry` fly from the drawn positions `from` to their resting positions `to`. Point i starts
    /// where point i was, so that the same scripts stay in place when a folder is reindexed.
    private flyIn(geometry: THREE.BufferGeometry, to: Float32Array, from: Float32Array | null): void {
        const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
        const fromCount = from == null ? 0 : from.length / 3;
        if (from == null || fromCount === 0) {
            this.morph = null;
            (attribute.array as Float32Array).set(to);
            attribute.needsUpdate = true;
            return;
        }
        const count = to.length / 3;
        const start = new Float32Array(to.length);
        const delays = new Float32Array(count);
        for (let i = 0; i < count; ++i) {
            const source = i % fromCount;
            for (let d = 0; d < 3; ++d) start[i * 3 + d] = from[source * 3 + d];
            delays[i] = Math.random() * MORPH_STAGGER;
        }
        this.morph = { attribute, from: start, to, delays, start: this.time };
        this.updateMorph();
    }

    private updateMorph(): void {
        const morph = this.morph;
        if (morph == null) return;
        const { attribute, from, to, delays } = morph;
        const drawn = attribute.array as Float32Array;
        const elapsed = this.time - morph.start;
        let done = true;
        for (let i = 0; i < delays.length; ++i) {
            const progress = Math.max(0, Math.min(1, (elapsed - delays[i]) / MORPH_DURATION));
            if (progress < 1) done = false;
            const e = easeInOutCubic(progress);
            // Halfway through, the dots swing outward a little, like the cloud takes a breath
            const bulge = 1 + MORPH_BULGE * Math.sin(Math.PI * e);
            for (let d = 0; d < 3; ++d) {
                const k = i * 3 + d;
                drawn[k] = (from[k] + (to[k] - from[k]) * e) * bulge;
            }
        }
        attribute.needsUpdate = true;
        if (done) this.morph = null;
    }

    /// The dot closest to the pointer, measured in the radius of its disc
    private pickDot(rect: DOMRect): DotHover | null {
        const pointer = this.pointer;
        // Dots that are still flying are not picked
        if (pointer == null || this.morph != null) return null;
        const positions = this.showingDemo ? this.demoPositions : this.dataPositions;
        if (positions == null) return null;
        const scale = this.camera.position.z;
        const vector = this.pickVector;
        this.camera.updateMatrixWorld();
        let best: DotHover | null = null;
        let bestScore = 1;
        for (let i = 0; i * 3 < positions.length; ++i) {
            if (!this.showingDemo && !this.isSelected(i)) continue;
            drifted(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], this.time, vector)
                .applyMatrix4(this.root.matrixWorld)
                .applyMatrix4(this.camera.matrixWorldInverse);
            const depth = -vector.z;
            vector.applyMatrix4(this.camera.projectionMatrix);
            const x = rect.left + (vector.x * 0.5 + 0.5) * rect.width;
            const y = rect.top + (-vector.y * 0.5 + 0.5) * rect.height;
            // The size on screen is the nominal size at the distance of the cloud center
            const size = this.showingDemo ? DEMO_POINT_SIZE : this.dataSize;
            const disc = size * 0.5 * scale / depth;
            const score = Math.hypot(x - pointer.x, y - pointer.y) / Math.max(PICK_RADIUS, disc + 4);
            if (score < bestScore) {
                best = { index: i, x, y, radius: disc };
                bestScore = score;
            }
        }
        return best;
    }

    /// Points on a fuzzy shell with a few in the volume, plus a flattened disc of dust around the equator
    private createGeometry(): THREE.BufferGeometry {
        const random = mulberry32(7);
        const positions = new Float32Array(POINT_COUNT * 3);
        const sizes = new Float32Array(POINT_COUNT);
        const alphas = new Float32Array(POINT_COUNT);
        for (let i = 0; i < POINT_COUNT; ++i) {
            // Uniform direction on the sphere
            const u = random() * 2 - 1;
            const phi = random() * Math.PI * 2;
            const s = Math.sqrt(1 - u * u);
            let x = s * Math.cos(phi);
            let y = u;
            let z = s * Math.sin(phi);
            const kind = random();
            let radius: number;
            if (kind < 0.62) {
                radius = 1.55 + (random() - 0.5) * 0.22;
            } else if (kind < 0.82) {
                radius = Math.cbrt(random()) * 1.45;
            } else {
                // Dust disc
                const r = 0.6 + random() * 1.9;
                x = Math.cos(phi) * r;
                z = Math.sin(phi) * r;
                y = (random() - 0.5) * 0.18;
                radius = 1;
            }
            positions[i * 3] = x * radius;
            positions[i * 3 + 1] = y * radius;
            positions[i * 3 + 2] = z * radius;
            sizes[i] = 0.9 + Math.pow(random(), 3) * 2.6;
            alphas[i] = 0.35 + random() * 0.65;
        }
        const geometry = new THREE.BufferGeometry();
        this.demoPositions = positions;
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
        geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
        geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
        geometry.setAttribute('aPhase', new THREE.BufferAttribute(randomPhases(POINT_COUNT, 13), 1));
        return geometry;
    }

    private readonly observe = (entries: ResizeObserverEntry[]): void => {
        const size = entries[entries.length - 1]?.devicePixelContentBoxSize?.[0];
        this.devicePixels = size == null ? null : { width: size.inlineSize, height: size.blockSize };
        this.resize();
    };

    private readonly resize = (): void => {
        let pixelRatio: number;
        let width: number;
        let height: number;
        /// Canvas pixels per CSS pixel
        let scale: number;
        const devicePixels = this.devicePixels;
        if (devicePixels != null && devicePixels.width > 0 && devicePixels.height > 0) {
            // One canvas pixel per device pixel. A canvas of css size * devicePixelRatio is resampled by the browser
            // whenever the ratio is fractional (125% or 150% scaling), which blurs everything.
            const rect = this.container.getBoundingClientRect();
            width = devicePixels.width;
            height = devicePixels.height;
            pixelRatio = rect.width > 0 ? width / rect.width : window.devicePixelRatio || 1;
            scale = pixelRatio;
            this.renderer.setPixelRatio(1);
        } else {
            width = Math.max(1, this.container.clientWidth);
            height = Math.max(1, this.container.clientHeight);
            pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
            // The renderer scales the canvas itself, its size stays in CSS pixels
            scale = 1;
            this.renderer.setPixelRatio(pixelRatio);
        }
        this.renderer.setSize(width, height, false);
        this.canvas = { width, height, scale };
        this.camera.aspect = width / height;
        // Keep the cloud in view on narrow screens
        this.camera.position.z = width / height < 1 ? 4.4 / Math.max(0.55, width / height) : 4.4;
        this.updateViewOffset();
        for (const material of [this.material, this.highlightMaterial]) {
            material.uniforms.uPixelRatio.value = pixelRatio;
            material.uniforms.uScale.value = this.camera.position.z;
        }
        this.renderOnce();
    };

    /// Looking at a window below the center moves the cloud up, into the middle of the space above the inset
    private updateViewOffset(): void {
        const { width, height, scale } = this.canvas;
        this.camera.setViewOffset(width, height, 0, this.bottomInset * 0.5 * scale, width, height);
    }

    private renderOnce(): void {
        this.renderer.render(this.scene, this.camera);
    }

    private readonly handleVisibilityChange = (): void => {
        if (document.hidden) this.pause();
        else if (this.running) this.resume();
    };

    private readonly handleWindowPointer = (e: PointerEvent): void => {
        const rect = this.container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const clamp = (v: number) => Math.max(-1, Math.min(1, v));
        this.parallax.x = clamp(((e.clientX - rect.left) / rect.width) * 2 - 1);
        this.parallax.y = clamp(((e.clientY - rect.top) / rect.height) * 2 - 1);
    };

    private readonly handleWindowLeave = (): void => {
        this.parallax.x = 0;
        this.parallax.y = 0;
    };

    private resume(): void {
        cancelAnimationFrame(this.animationFrame);
        this.clock.start();
        this.animationFrame = requestAnimationFrame(this.frame);
    }

    private pause(): void {
        cancelAnimationFrame(this.animationFrame);
        this.clock.stop();
    }

    private readonly frame = (): void => {
        if (this.disposed || !this.running) return;
        const dt = Math.min(this.clock.getDelta(), 0.1);
        this.time += dt;
        const t = this.time;
        // A tilted axis that drifts slowly: the cloud does not turn like a record on a player
        this.axis.set(0.32 + Math.sin(t * 0.11) * 0.22, 1, 0.18 + Math.cos(t * 0.07) * 0.2).normalize();
        // Hovering a dot holds the cloud, so that the dot does not run away from the pointer
        const held = this.rotationPaused || this.hoveredDot >= 0;
        this.rotationSpeed += ((held ? 0 : 1) - this.rotationSpeed) * (1 - Math.exp(-dt * ROTATION_EASING));
        this.root.rotateOnWorldAxis(this.axis, dt * ROTATION_SPEED * this.rotationSpeed);
        // The cloud leans toward the pointer: its front turns to face it
        const lean = 1 - Math.exp(-dt * PARALLAX_EASING);
        this.tilt.rotation.y += (this.parallax.x * PARALLAX_TILT - this.tilt.rotation.y) * lean;
        this.tilt.rotation.x += (this.parallax.y * PARALLAX_TILT - this.tilt.rotation.x) * lean;
        this.scene.updateMatrixWorld();
        this.updateMorph();
        for (const material of [this.material, this.highlightMaterial]) material.uniforms.uTime.value = t;

        const rect = this.container.getBoundingClientRect();
        const pointer = this.pointer;
        this.lens += ((pointer != null ? 1 : 0) - this.lens) * (1 - Math.exp(-dt * ROTATION_EASING));
        this.material.uniforms.uLens.value = this.lens;
        if (pointer != null && rect.width > 0 && rect.height > 0) {
            (this.material.uniforms.uPointer.value as THREE.Vector2).set(
                ((pointer.x - rect.left) / rect.width) * 2 - 1,
                1 - ((pointer.y - rect.top) / rect.height) * 2,
            );
        }
        (this.material.uniforms.uHalfSize.value as THREE.Vector2).set(rect.width / 2, rect.height / 2);

        const hover = this.pickDot(rect);
        this.setDotHover(hover?.index ?? -1);
        if (hover != null) this.hoverListener?.(hover);
        this.renderOnce();
        this.animationFrame = requestAnimationFrame(this.frame);
    };
}
