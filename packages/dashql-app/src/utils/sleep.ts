export async function sleep(ms: number) {
    /// Wait for 1 second to simulate initial loading
    await new Promise(resolve => setTimeout(resolve, ms));
}
