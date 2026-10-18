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

/// A dot under the pointer. x and y are client coordinates of the dot, radius is the size of its disc in CSS pixels.
export interface DotHover {
    index: number;
    x: number;
    y: number;
    radius: number;
}

const VERTEX_SHADER = `
    attribute float aSize;
    attribute float aAlpha;
    uniform float uPixelRatio;
    /// Distance at which a point has its nominal size
    uniform float uScale;
    varying float vAlpha;
    void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio * uScale / -mv.z;
        // Points in the back are dimmer, which gives the cloud its depth
        float depth = clamp(1.0 - (-mv.z - 2.0) / 3.2, 0.3, 1.0);
        vAlpha = aAlpha * depth;
    }
`;

const FRAGMENT_SHADER = `
    varying float vAlpha;
    void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        // A solid disc with a soft rim and a faint halo, so that big points stay crisp and small ones stay round
        float disc = 1.0 - smoothstep(0.32, 0.5, d);
        float halo = 0.25 * (1.0 - smoothstep(0.0, 0.5, d));
        // The rim is a little cooler than the center, which gives the dots some volume
        vec3 color = mix(vec3(1.0), vec3(0.8, 0.88, 1.0), smoothstep(0.1, 0.5, d));
        gl_FragColor = vec4(color, vAlpha * max(disc, halo));
    }
`;

/// Highlighted points are drawn on top in the accent color and are not dimmed by depth
const HIGHLIGHT_VERTEX_SHADER = `
    attribute float aEmphasis;
    uniform float uPixelRatio;
    uniform float uScale;
    /// Nominal size of the points that are highlighted
    uniform float uBaseSize;
    varying float vEmphasis;
    void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = aEmphasis > 0.5 ? max(15.0, uBaseSize * 1.7 + 4.0) : max(6.0, uBaseSize * 1.3);
        gl_PointSize = size * uPixelRatio * uScale / -mv.z;
        vEmphasis = aEmphasis;
    }
`;

const HIGHLIGHT_FRAGMENT_SHADER = `
    varying float vEmphasis;
    void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        vec3 accent = vec3(1.0, 0.78, 0.35);
        if (vEmphasis > 0.5) {
            // A bright core with a ring, so that the point is easy to find in the cloud
            float ring = smoothstep(0.34, 0.4, d) * (1.0 - smoothstep(0.44, 0.5, d));
            float core = 1.0 - smoothstep(0.1, 0.2, d);
            gl_FragColor = vec4(mix(accent, vec3(1.0), core), max(core, ring * 0.9));
        } else {
            gl_FragColor = vec4(accent, 0.95 * smoothstep(0.5, 0.2, d));
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

/// Small white dots that slowly turn around a center point, like the pairing screen of the Apple Watch. The rotation axis
/// is tilted and drifts a little, which makes the motion wobble.
///
/// The dots are made up until `setPoints` replaces them with the indexed scripts. `setHighlight` marks some of those.
export class PointCloud {
    private readonly renderer: THREE.WebGLRenderer;
    private readonly scene = new THREE.Scene();
    private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20);
    /// Rotates both point sets together
    private readonly root = new THREE.Group();
    private readonly cloud: THREE.Points;
    private readonly material: THREE.ShaderMaterial;
    private readonly demoGeometry: THREE.BufferGeometry;
    private dataGeometry: THREE.BufferGeometry | null = null;
    private readonly highlights: THREE.Points;
    private readonly highlightMaterial: THREE.ShaderMaterial;
    private highlightGeometry: THREE.BufferGeometry | null = null;
    /// Positions of both point sets as drawn (inside `root`), kept for highlights and picking
    private demoPositions = new Float32Array(0);
    private dataPositions: Float32Array | null = null;
    /// The made up dots are shown, as long as `setPoints` was not called
    private showingDemo = true;
    /// Nominal size of the indexed points, depends on how many there are
    private dataSize = DEMO_POINT_SIZE;
    /// The pointer in client coordinates. The dot under it is reported to the hover listener.
    private pointer: { x: number; y: number } | null = null;
    private hoveredDot = -1;
    private rotationPaused = false;
    /// 1 while the cloud turns, eases to 0 when it is held
    private rotationSpeed = 1;
    private hoverListener: ((hover: DotHover | null) => void) | null = null;
    private readonly pickVector = new THREE.Vector3();
    private readonly resizeObserver: ResizeObserver;
    private readonly clock = new THREE.Clock(false);
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
            uniforms: { uPixelRatio: { value: 1 }, uScale: { value: 1 } },
        });
        this.cloud = new THREE.Points(this.demoGeometry, this.material);
        this.highlightMaterial = new THREE.ShaderMaterial({
            vertexShader: HIGHLIGHT_VERTEX_SHADER,
            fragmentShader: HIGHLIGHT_FRAGMENT_SHADER,
            transparent: true,
            depthWrite: false,
            depthTest: false,
            uniforms: { uPixelRatio: { value: 1 }, uScale: { value: 1 }, uBaseSize: { value: DEMO_POINT_SIZE } },
        });
        this.highlights = new THREE.Points(new THREE.BufferGeometry(), this.highlightMaterial);
        this.highlights.renderOrder = 1;
        this.highlights.visible = false;
        this.root.add(this.cloud, this.highlights);
        // Start tilted, so that the first frame already looks lively
        this.root.rotation.set(0.5, 0, 0.3);
        this.scene.add(this.root);

        this.resizeObserver = new ResizeObserver(this.resize);
        this.resizeObserver.observe(this.container);
        this.resize();
        this.renderOnce();
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
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
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(count).fill(size), 1));
        geometry.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(count).fill(pointAlpha(count)), 1));
        this.dataGeometry = geometry;
        this.dataPositions = positions;
        this.dataSize = size;
        this.highlightMaterial.uniforms.uBaseSize.value = size;
        this.cloud.geometry = geometry;
        this.renderOnce();
    }

    /// Back to the made up dots
    clearPoints(): void {
        this.dataGeometry?.dispose();
        this.dataGeometry = null;
        this.dataPositions = null;
        this.showingDemo = true;
        this.dataSize = DEMO_POINT_SIZE;
        this.highlightMaterial.uniforms.uBaseSize.value = DEMO_POINT_SIZE;
        this.setHighlight([], []);
        this.cloud.geometry = this.demoGeometry;
        this.cloud.visible = true;
        this.renderOnce();
    }

    /// Hold the rotation, so that hovered points stay where they are
    setRotationPaused(paused: boolean): void {
        this.rotationPaused = paused;
    }

    /// Mark points by their index, in the coords of `setPoints` or in the made up dots. The hovered ones are emphasized.
    setHighlight(candidates: readonly number[], hovered: readonly number[]): void {
        const coords = this.showingDemo ? this.demoPositions : this.dataPositions ?? new Float32Array(0);
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

    /// Receives the dot under the pointer on every frame while there is one, and null once there is none
    setHoverListener(listener: ((hover: DotHover | null) => void) | null): void {
        this.hoverListener = listener;
    }

    /// Where the pointer is, in client coordinates, or null when it left
    setPointer(pointer: { x: number; y: number } | null): void {
        this.pointer = pointer;
        if (pointer == null) this.setDotHover(-1);
    }

    private setDotHover(index: number): void {
        if (index === this.hoveredDot) return;
        this.hoveredDot = index;
        // What lights up is up to the listener, it knows which dots belong together
        if (index < 0) this.hoverListener?.(null);
    }

    /// The dot closest to the pointer, measured in the radius of its disc
    private pickDot(): DotHover | null {
        const pointer = this.pointer;
        if (pointer == null) return null;
        const rect = this.container.getBoundingClientRect();
        const positions = this.showingDemo ? this.demoPositions : this.dataPositions;
        if (positions == null) return null;
        const scale = this.camera.position.z;
        const vector = this.pickVector;
        this.camera.updateMatrixWorld();
        let best: DotHover | null = null;
        let bestScore = 1;
        for (let i = 0; i * 3 < positions.length; ++i) {
            vector.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
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
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
        geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
        return geometry;
    }

    private readonly resize = (): void => {
        const width = Math.max(1, this.container.clientWidth);
        const height = Math.max(1, this.container.clientHeight);
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        this.renderer.setPixelRatio(pixelRatio);
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        // Keep the cloud in view on narrow screens
        this.camera.position.z = width / height < 1 ? 4.4 / Math.max(0.55, width / height) : 4.4;
        this.camera.updateProjectionMatrix();
        for (const material of [this.material, this.highlightMaterial]) {
            material.uniforms.uPixelRatio.value = pixelRatio;
            material.uniforms.uScale.value = this.camera.position.z;
        }
        this.renderOnce();
    };

    private renderOnce(): void {
        this.renderer.render(this.scene, this.camera);
    }

    private readonly handleVisibilityChange = (): void => {
        if (document.hidden) this.pause();
        else if (this.running) this.resume();
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
        const t = this.clock.elapsedTime;
        // A tilted axis that drifts slowly: the cloud does not turn like a record on a player
        this.axis.set(0.32 + Math.sin(t * 0.11) * 0.22, 1, 0.18 + Math.cos(t * 0.07) * 0.2).normalize();
        // Hovering a dot holds the cloud, so that the dot does not run away from the pointer
        const held = this.rotationPaused || this.hoveredDot >= 0;
        this.rotationSpeed += ((held ? 0 : 1) - this.rotationSpeed) * (1 - Math.exp(-dt * ROTATION_EASING));
        this.root.rotateOnWorldAxis(this.axis, dt * ROTATION_SPEED * this.rotationSpeed);
        this.root.updateMatrixWorld();
        const hover = this.pickDot();
        this.setDotHover(hover?.index ?? -1);
        if (hover != null) this.hoverListener?.(hover);
        this.renderOnce();
        this.animationFrame = requestAnimationFrame(this.frame);
    };
}

