import * as React from 'react';

import * as styles from './umap_info_panel.module.css';

/// A single column value of the selected point.
export interface UmapAttribute {
    name: string;
    value: string | null;
}

interface UmapInfoPanelProps {
    /// The selected point's column values shown in the overlay card. Null when no point is selected.
    attributes: UmapAttribute[] | null;
}

/// The UMAP details overlay, floating above the scatter canvas: the selected point's attributes as a
/// card anchored to the bottom-left. When no point is selected the card stays visible with a muted
/// placeholder. Pointer-transparent except its own content so the canvas underneath stays
/// interactive.
export const UmapInfoPanel: React.FC<UmapInfoPanelProps> = ({ attributes }) => {
    return (
        <div className={styles.overlays}>
            <div className={styles.attribute_card}>
                {attributes != null ? (
                    <div className={styles.attributes_grid}>
                        {attributes.map(attr => (
                            <React.Fragment key={attr.name}>
                                <div className={styles.attribute_key}>{attr.name}</div>
                                <div className={styles.attribute_value}>
                                    {attr.value ?? <span className={styles.attribute_null}>null</span>}
                                </div>
                            </React.Fragment>
                        ))}
                    </div>
                ) : (
                    <div className={styles.attribute_placeholder}>No row selected</div>
                )}
            </div>
        </div>
    );
};
