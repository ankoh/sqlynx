export function prepareForSessionTreeNavigation(event: KeyboardEvent) {
    event.preventDefault();

    const active = document.activeElement;
    if (active instanceof HTMLButtonElement) {
        active.blur();
    }
}
