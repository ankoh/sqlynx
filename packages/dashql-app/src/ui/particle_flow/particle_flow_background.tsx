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

export const ParticleFlowBackground: React.FC = () => {
    const containerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        const container = containerRef.current;
        if (container == null) {
            return;
        }

        const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        let generation = 0;
        let particleFlow: { dispose(): void; start(): void } | null = null;

        const syncParticleFlow = () => {
            const currentGeneration = ++generation;
            particleFlow?.dispose();
            particleFlow = null;

            if (motionQuery.matches || !supportsWebGL()) {
                return;
            }

            import('./particle_flow.js').then(({ ParticleFlow }) => {
                if (currentGeneration !== generation || motionQuery.matches) {
                    return;
                }
                particleFlow = new ParticleFlow(container);
                particleFlow.start();
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
            particleFlow?.dispose();
        };
    }, []);

    return <div ref={containerRef} className={styles.background} aria-hidden="true" />;
};
