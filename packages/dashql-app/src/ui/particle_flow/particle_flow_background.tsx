import * as React from 'react';

import * as styles from './particle_flow_background.module.css';

function supportsWebGL(): boolean {
    try {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('webgl2');
        if (context == null) {
            return false;
        }
        context.getExtension('WEBGL_lose_context')?.loseContext();
        return true;
    } catch {
        return false;
    }
}

/// A WebGL animation that fills a container
export interface BackgroundAnimation {
    start(): void;
    dispose(): void;
}

/// Lazily loads the animation class, so that three.js stays out of the entry chunk
export type BackgroundAnimationLoader = () => Promise<new (container: HTMLElement) => BackgroundAnimation>;

const loadParticleFlow: BackgroundAnimationLoader = async () => (await import('./particle_flow.js')).ParticleFlow;

interface ParticleFlowBackgroundProps {
    /// Other entrypoints (e.g. atlas) show their own animation behind the same transparent layer. Has to be stable.
    load?: BackgroundAnimationLoader;
    /// Called with the running animation, and with null when it is disposed. Lets entrypoints feed their animation.
    onAnimation?: (animation: BackgroundAnimation | null) => void;
}

export const ParticleFlowBackground: React.FC<ParticleFlowBackgroundProps> = (props: ParticleFlowBackgroundProps) => {
    const load = props.load ?? loadParticleFlow;
    const containerRef = React.useRef<HTMLDivElement>(null);
    const onAnimationRef = React.useRef(props.onAnimation);
    onAnimationRef.current = props.onAnimation;

    React.useEffect(() => {
        const container = containerRef.current;
        if (container == null) {
            return;
        }

        const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        let generation = 0;
        let particleFlow: BackgroundAnimation | null = null;

        const syncParticleFlow = () => {
            const currentGeneration = ++generation;
            if (particleFlow != null) onAnimationRef.current?.(null);
            particleFlow?.dispose();
            particleFlow = null;

            if (motionQuery.matches || !supportsWebGL()) {
                return;
            }

            load().then(Animation => {
                if (currentGeneration !== generation || motionQuery.matches) {
                    return;
                }
                particleFlow = new Animation(container);
                particleFlow.start();
                onAnimationRef.current?.(particleFlow);
            }).catch(error => {
                container.replaceChildren();
                console.warn('WebGL particle background could not be initialized.', error);
            });
        };

        motionQuery.addEventListener('change', syncParticleFlow);
        syncParticleFlow();

        return () => {
            generation += 1;
            motionQuery.removeEventListener('change', syncParticleFlow);
            if (particleFlow != null) onAnimationRef.current?.(null);
            particleFlow?.dispose();
        };
    }, [load]);

    return <div ref={containerRef} className={styles.background} aria-hidden="true" />;
};
