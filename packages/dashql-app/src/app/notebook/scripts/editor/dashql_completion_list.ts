import * as dashql from '@ankoh/dashql-core';

import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { EditorState } from '@codemirror/state';

import { DashQLCompletionNextCandidateVariantEffect, DashQLCompletionPreviousCandidateVariantEffect, DashQLCompletionState, DashQLCompletionStatus, DashQLProcessorPlugin } from './dashql_processor.js';
import { CompletionCandidateType, getCandidateTypeSymbolColor, getCandidateTypeSymbolText } from './dashql_completion_candidate_type.js';

import * as styles from './dashql_completion_list.module.css';
import icons from '@ankoh/dashql-svg-symbols';


// This file contains a CodeMirror plugin for rendering a completion list.
// The rendering itself is virtualized but deliberately does NOT use React.
// We're implementing the view consolidation manually here.
//
// This makes the extension independent and allows separating it as library later.


interface Position {
    /// The top offset (used when rendering below the cursor)
    top: number | null;
    /// The bottom offset (used when rendering above the cursor)
    bottom: number | null;
    /// The left offset
    left: number;
}

interface VirtualCandidate {
    /// The candidate type.
    /// Either the object type of the selected object or the first one.
    candidateType: CompletionCandidateType | null;
    /// The candidate text
    candidateLabel: string;
    /// Is selected?
    isSelected: boolean;
    /// The total catalog objects
    totalObjectCount: number;
    /// The selected catalog object
    selectedCatalogObject: number | null;
}

class CandidateRenderer {
    /// The currently rendered candidate
    rendered: VirtualCandidate | null;

    /// Info element visible?
    infoVisible: boolean;
    /// Selected object count visible?
    objectContainerVisible: boolean;
    /// Selected object index visible?
    objectSelectionVisible: boolean;
    navVisible: boolean;

    /// The entry element
    public readonly rootElement: HTMLDivElement;
    /// The icon element
    readonly iconElement: HTMLSpanElement;
    /// The name element
    readonly nameElement: HTMLSpanElement;
    /// The info element
    readonly infoElement: HTMLDivElement;

    /// The nav container element
    readonly navContainerElement: HTMLDivElement;
    /// The left arrow
    readonly navArrowLeftElement: SVGElement;
    /// The right arrow
    readonly navArrowRightElement: SVGElement;
    /// The container for the object count
    readonly objectContainerElement: HTMLDivElement;
    /// The span for the selected catalog object
    readonly objectSelectedSpan: HTMLSpanElement;
    /// The span for the catalog object count
    readonly objectTotalSpan: HTMLSpanElement;

    constructor(candidate: VirtualCandidate, selectPreviousVariant: () => void, selectNextVariant: () => void) {
        this.rendered = null;
        this.rootElement = document.createElement('div');
        this.iconElement = document.createElement('span');
        this.nameElement = document.createElement('span');
        this.infoElement = document.createElement('div');
        this.infoVisible = true;
        this.objectContainerVisible = true;
        this.objectSelectionVisible = true;
        this.navVisible = true;

        this.navContainerElement = document.createElement('div');
        this.navArrowLeftElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.navArrowRightElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

        const navArrowLeftUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        this.navArrowLeftElement.appendChild(navArrowLeftUse);
        this.navArrowLeftElement.setAttribute('width', '13px');
        this.navArrowLeftElement.setAttribute('height', '13px');
        navArrowLeftUse.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `${icons}#arrow_left_16`);

        const navArrowRightUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        this.navArrowRightElement.appendChild(navArrowRightUse);
        this.navArrowRightElement.setAttribute('width', '13px');
        this.navArrowRightElement.setAttribute('height', '13px');
        navArrowRightUse.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `${icons}#arrow_right_16`);
        this.navArrowLeftElement.setAttribute('role', 'button');
        this.navArrowLeftElement.setAttribute('aria-label', 'Previous catalog object');
        this.navArrowRightElement.setAttribute('role', 'button');
        this.navArrowRightElement.setAttribute('aria-label', 'Next catalog object');
        this.navArrowLeftElement.addEventListener('mousedown', event => {
            event.preventDefault();
            selectPreviousVariant();
        });
        this.navArrowRightElement.addEventListener('mousedown', event => {
            event.preventDefault();
            selectNextVariant();
        });

        this.objectContainerElement = document.createElement('div');
        this.objectSelectedSpan = document.createElement('span');
        this.objectSelectedSpan.classList.add(styles.info_selected_count);
        this.objectTotalSpan = document.createElement('span');

        const objectLogoSVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const objectLogoUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        objectLogoSVG.setAttribute('width', '12px');
        objectLogoSVG.setAttribute('height', '12px');
        objectLogoUse.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `${icons}#versions_16`);
        objectLogoSVG.appendChild(objectLogoUse);

        // Set up containers
        this.rootElement.classList.add(styles.candidate_container);
        this.iconElement.classList.add(styles.candidate_icon);
        this.nameElement.classList.add(styles.candidate_name);
        this.infoElement.classList.add(styles.info_container);
        this.navContainerElement.classList.add(styles.info_nav_container);
        this.navArrowLeftElement.classList.add(styles.info_nav_left);
        this.navArrowRightElement.classList.add(styles.info_nav_right);
        this.objectContainerElement.classList.add(styles.info_object_container);

        this.iconElement.textContent = getCandidateTypeSymbolText(candidate.candidateType ?? 0);
        this.iconElement.style.backgroundColor = getCandidateTypeSymbolColor(candidate.candidateType ?? 0);

        // Wire containers
        this.navContainerElement.appendChild(this.navArrowLeftElement);
        this.navContainerElement.appendChild(this.navArrowRightElement);
        this.objectContainerElement.appendChild(objectLogoSVG);
        this.objectContainerElement.appendChild(this.objectSelectedSpan);
        this.objectContainerElement.appendChild(this.objectTotalSpan);
        this.infoElement.appendChild(this.navContainerElement);
        this.infoElement.appendChild(this.objectContainerElement);
        this.rootElement.appendChild(this.iconElement);
        this.rootElement.appendChild(this.nameElement);
        this.rootElement.appendChild(this.infoElement);

        this.render(candidate);
    }

    // Destroy the node
    public destroy() {
        this.rootElement.remove();
    }

    /// Helper to hide the candidate info (if not already hidden)
    protected hideInfoContainer() {
        if (this.infoVisible) {
            this.infoElement.classList.add(styles.hidden);
            this.infoVisible = false;
        }
    }
    /// Helper to hide the object selection (if not already hidden)
    protected hideSelectedObject() {
        if (this.objectSelectionVisible) {
            this.objectSelectedSpan.classList.add(styles.hidden);
            this.objectSelectionVisible = false;
        }
    }
    /// Helper to hide the object container (if not already hidden)
    protected hideObjectContainer() {
        if (this.objectContainerVisible) {
            this.objectContainerElement.classList.add(styles.hidden);
            this.objectContainerVisible = false;
        }
    }
    /// Helper to show the candidate info (if not already hidden)
    protected showInfoContainer() {
        if (!this.infoVisible) {
            this.infoElement.classList.remove(styles.hidden);
            this.infoVisible = true;
        }
    }
    /// Helper to show the object selection (if not already hidden)
    protected showSelectedObject() {
        if (!this.objectSelectionVisible) {
            this.objectSelectedSpan.classList.remove(styles.hidden);
            this.objectSelectionVisible = true;
        }
    }
    /// Helper to show the object container (if not already hidden)
    protected showObjectContainer() {
        if (!this.objectContainerVisible) {
            this.objectContainerElement.classList.remove(styles.hidden);
            this.objectContainerVisible = true;
        }
    }
    protected hideNavigation() {
        if (!this.navVisible) return;
        this.navContainerElement.classList.add(styles.hidden);
        this.navVisible = false;
    }
    protected showNavigation() {
        if (this.navVisible) return;
        this.navContainerElement.classList.remove(styles.hidden);
        this.navVisible = true;
    }
    public render(candidate: VirtualCandidate) {
        // Is the element selected?
        if (candidate.isSelected != this.rendered?.isSelected) {
            if (candidate.isSelected) {
                this.rootElement.classList.add(styles.selected);
            } else {
                this.rootElement.classList.remove(styles.selected);
            }
        }
        // Does the label differ?
        if (candidate.candidateLabel != this.rendered?.candidateLabel) {
            this.nameElement.textContent = candidate.candidateLabel;
        }
        // Does the object type differ?
        if (candidate.candidateType != this.rendered?.candidateType) {
            this.iconElement.textContent = getCandidateTypeSymbolText(candidate.candidateType ?? 0);
            this.iconElement.style.backgroundColor = getCandidateTypeSymbolColor(candidate.candidateType ?? 0);
        }
        // Is selected and has selectable?
        const anySelectable = candidate.totalObjectCount > 0;
        if (candidate.isSelected && anySelectable) {
            this.showInfoContainer();
        } else {
            this.hideInfoContainer();
        }
        // Update selected object?
        if (candidate.selectedCatalogObject == null) {
            this.hideSelectedObject();
        } else if (candidate.selectedCatalogObject != this.rendered?.selectedCatalogObject) {
            this.showSelectedObject();
            this.objectSelectedSpan.textContent = (candidate.selectedCatalogObject + 1).toString();
        }
        // Update the total object count
        if (candidate.totalObjectCount != this.rendered?.totalObjectCount) {
            this.objectTotalSpan.textContent = candidate.totalObjectCount.toString();
        }
        // Check object totals
        if (candidate.totalObjectCount > 0) {
            this.showObjectContainer();
        } else {
            this.hideObjectContainer();
        }
        if (candidate.totalObjectCount > 1) {
            this.showNavigation();
        } else {
            this.hideNavigation();
        }
        this.rendered = candidate;
    }
}

class CandidateListRenderer {
    /// Is the list shown?
    rootVisible: boolean;
    /// The list position
    rootPosition: Position;

    /// The overlay container
    public readonly rootElement: HTMLDivElement;
    /// The list container
    readonly listContainer: HTMLDivElement;
    /// The list entries
    readonly renderedCandidates: CandidateRenderer[];
    readonly selectPreviousVariant: () => void;
    readonly selectNextVariant: () => void;

    constructor(selectPreviousVariant: () => void, selectNextVariant: () => void) {
        this.rootVisible = true;
        this.rootPosition = { top: null, bottom: null, left: -1 };
        this.selectPreviousVariant = selectPreviousVariant;
        this.selectNextVariant = selectNextVariant;

        this.rootElement = document.createElement('div');
        this.rootElement.className = styles.overlay_container;
        this.rootElement.dataset.dashqlCompletionList = 'true';
        this.listContainer = document.createElement('div');
        this.listContainer.className = styles.list_container;
        this.rootElement.appendChild(this.listContainer);

        this.renderedCandidates = [];

        this.hide();
    }

    public destroy() {
        this.rootElement.remove();
    }

    /// Is hidden?
    public get isHidden() { return !this.rootVisible; }
    /// Hide the list (if shown)
    public hide() {
        if (this.rootVisible) {
            this.rootElement.classList.add(styles.hidden);
            this.rootVisible = false;
        }
    }
    /// Show the list (if hidden)
    public show() {
        if (!this.rootVisible) {
            this.rootElement.classList.remove(styles.hidden);
            this.rootVisible = true;
        }
    }
    /// Update the position
    public updatePosition(position: Position) {
        if (this.rootPosition.top !== position.top || this.rootPosition.bottom !== position.bottom || this.rootPosition.left !== position.left) {
            if (position.bottom !== null) {
                this.rootElement.style.top = '';
                this.rootElement.style.bottom = `${position.bottom}px`;
            } else {
                this.rootElement.style.bottom = '';
                this.rootElement.style.top = `${position.top ?? 0}px`;
            }
            this.rootElement.style.left = `${position.left}px`;
            this.rootPosition = position;
        }
    }
    /// Update the candidates
    public updateCandidates(candidates: VirtualCandidate[]) {
        // Reuse rendered candidates
        const n = Math.min(candidates.length, this.renderedCandidates.length);
        for (let i = 0; i < n; ++i) {
            const rendered = this.renderedCandidates[i];
            rendered.render(candidates[i]);
        }
        // Delete excess rendered
        const dead = this.renderedCandidates.splice(n, this.renderedCandidates.length - n);
        for (let i = 0; i < dead.length; ++i) {
            this.listContainer.removeChild(dead[i].rootElement);
            dead[i].destroy();
        }
        // Create new rendered
        for (let i = n; i < candidates.length; ++i) {
            const entry = new CandidateRenderer(candidates[i], this.selectPreviousVariant, this.selectNextVariant);
            this.listContainer.appendChild(entry.rootElement);
            this.renderedCandidates.push(entry);
        }
    }
}

class CompletionList {
    /// The list renderer
    list: CandidateListRenderer;
    /// The dom that this container is mounted to (if any)
    dom: HTMLElement | null = null;
    /// The rendered completion
    renderedCompletion: DashQLCompletionState | null = null;

    constructor(view: EditorView) {
        this.list = new CandidateListRenderer(
            () => view.dispatch({ effects: DashQLCompletionPreviousCandidateVariantEffect.of(null) }),
            () => view.dispatch({ effects: DashQLCompletionNextCandidateVariantEffect.of(null) }),
        );
    }
    /// Destroy the container
    destroy() {
        this.unmount();
        this.list.destroy();
    }
    /// Unmount a completion list container
    unmount() {
        if (this.dom) {
            this.list.rootElement.remove();
            this.dom = null;
        }
    }
    /// Mount a completion list container
    mount(dom: HTMLElement) {
        if (this.dom == dom) {
            return;
        }
        this.unmount();
        document.body.appendChild(this.list.rootElement);
        this.dom = dom;
    }
    /// Helper to compute a position
    static computePosition(view: EditorView, offset: number): (Position | null) {
        const candidateCoords = view.coordsAtPos(offset);
        if (candidateCoords == null) return null;

        // Estimate box dimensions for overflow checks
        const boxWidth = 50;
        const boxHeight = 240; // max-height from CSS

        // coordsAtPos returns viewport coordinates, which map 1:1 to position:fixed.
        const windowHeight = window.innerHeight;
        const windowWidth = window.innerWidth;

        // Flip to above if there's insufficient space below.
        // Use CSS `bottom` positioning so the list anchors above the cursor line.
        const spaceBelow = windowHeight - (candidateCoords.bottom + 5);
        const spaceAbove = candidateCoords.top - 5;
        const renderAbove = spaceBelow < boxHeight && spaceAbove > spaceBelow;

        // Adjust horizontal position if it would overflow the window
        let left = candidateCoords.left;
        if (left + boxWidth > windowWidth) {
            left = windowWidth - boxWidth;
        }
        left = Math.max(0, left);

        if (renderAbove) {
            // position:fixed bottom = distance from viewport bottom to list's bottom edge.
            // We want the list's bottom edge 5px above the cursor's top.
            const bottom = windowHeight - candidateCoords.top + 5;
            return { top: null, bottom: Math.max(0, bottom), left };
        } else {
            const top = candidateCoords.bottom + 5;
            return { top, bottom: null, left };
        }
    }

    /// Collect the candidates
    collectCandidates(completion: dashql.buffers.completion.Completion, selectedCandidate: number, selectedCatalogObject: number | null): VirtualCandidate[] {
        const out: VirtualCandidate[] = [];
        const tmpCandidate = new dashql.buffers.completion.CompletionCandidate();
        const tmpCatalogObject = new dashql.buffers.completion.CompletionCandidateObject();

        // Collect the candidates
        for (let i = 0; i < completion.candidatesLength(); ++i) {
            const ca = completion.candidates(i, tmpCandidate)!;
            let totalObjects = ca.catalogObjectsLength();
            let candidateType: CompletionCandidateType;
            if (ca.candidateTags()! & dashql.buffers.completion.CandidateTag.IDENTITY) {
                candidateType = CompletionCandidateType.IDENTITY;
            } else if (ca.catalogObjectsLength() > 0) {
                const co = ca.catalogObjects(0, tmpCatalogObject)!;
                candidateType = (co.objectType() as number) as CompletionCandidateType;
            } else {
                candidateType = CompletionCandidateType.KEYWORD;
            }
            out.push({
                candidateLabel: ca.displayText()!,
                candidateType,
                isSelected: false,
                totalObjectCount: totalObjects,
                selectedCatalogObject: null,
            });
        }

        // Mark selected
        if (selectedCandidate < out.length) {
            out[selectedCandidate].isSelected = true;
        }

        // Update the selected candidate
        const ca = completion.candidates(selectedCandidate, tmpCandidate)!;
        if (selectedCatalogObject != null && ca.catalogObjectsLength() > 0) {
            const co = ca.catalogObjects(selectedCatalogObject, tmpCatalogObject)!;
            const o = out[selectedCandidate];
            o.selectedCatalogObject = selectedCatalogObject;
            const ot = co.objectType();
            o.candidateType = (ot == dashql.buffers.completion.CompletionCandidateObjectType.NONE)
                ? null
                : (ot as number) as CompletionCandidateType;
            o.isSelected = true;
            o.totalObjectCount = ca.catalogObjectsLength();
        }
        return out;
    }

    /// Update the completion list
    update(view: EditorView, state: EditorState) {
        const processor = state.field(DashQLProcessorPlugin);

        // Short-circuit noops
        if (this.renderedCompletion === processor.scriptCompletion) {
            return;
        }
        this.renderedCompletion = processor.scriptCompletion;

        // Hide completion?
        if (processor.scriptCompletion?.status !== DashQLCompletionStatus.AVAILABLE
            || processor.scriptCompletion?.passiveHint) {
            if (!this.list.isHidden) {
                view.requestMeasure<(Position | null)>({
                    key: this,
                    read: (_view) => null,
                    write: (_null, _view) => {
                        this.list.hide();
                    }
                });
            }
            return;
        }
        const selectedCandidate = processor.scriptCompletion.candidateId;
        const selectedCatalogObject = processor.scriptCompletion.catalogObjectId ?? null;

        // Invalid candidate?
        const completion = processor.scriptCompletion;
        const completionBuffer = completion.buffer.read();
        if (completion.candidateId >= completionBuffer.candidatesLength()) {
            return;
        }
        // Current candidate
        const candidate = completionBuffer.candidates(completion.candidateId);
        if (candidate == null) {
            return;
        }
        const candidateLoc = candidate.targetLocation()!;
        const candidateLocOffset = candidateLoc.offset();

        // Collect all candidates
        const pending = this.collectCandidates(completionBuffer, selectedCandidate, selectedCatalogObject);

        // Update the container position.
        // Keyed so that a later update (e.g. hiding) supersedes a pending measure.
        // The offset can still outlive the text it points into, the list is hidden then.
        view.requestMeasure<(Position | null)>({
            key: this,
            read: (view) => {
                if (candidateLocOffset > view.state.doc.length) return null;
                return CompletionList.computePosition(view, candidateLocOffset);
            },
            write: (pos: Position | null, _view) => {
                if (pos == null) {
                    this.list.hide();
                    return;
                }
                this.list.show();
                this.list.updatePosition(pos);
                this.list.updateCandidates(pending);
            }
        });
    }
}

export const DashQLCompletionListPlugin = ViewPlugin.fromClass(
    class {
        container: CompletionList;

        constructor(view: EditorView) {
            this.container = new CompletionList(view);
        }
        update(update: ViewUpdate) {
            this.container.mount(update.view.dom);
            this.container.update(update.view, update.state);
        }
        destroy() {
            this.container.destroy();
        }
    }
);
