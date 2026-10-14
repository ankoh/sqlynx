/// Yield through a browser task so pending rendering and animations can advance.
export function yieldToBrowser(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}
