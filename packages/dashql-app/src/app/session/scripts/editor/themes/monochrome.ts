import { tags as t } from '@lezer/highlight';
import { createTheme, CreateThemeOptions } from './theme.js';
import { visKeywordTag } from '../dashql_decorations_standalone.js';

export const defaultSettingsMonochromeLight: CreateThemeOptions['settings'] = {
    background: '#f7f7f8',
    foreground: '#7a7a7a',
    selection: '#d8d8dc',
    selectionMatch: '#e3e3e7',
    lineHighlight: '#f7f7f8',
};

export function monochromeLightInit(options?: Partial<CreateThemeOptions>) {
    const { theme = 'light', settings = {}, styles = [] } = options || {};
    return createTheme({
        theme,
        settings: {
            ...defaultSettingsMonochromeLight,
            ...settings,
        },
        styles: [
            { tag: [t.comment, t.quote], color: '#909090' },
            { tag: [t.keyword], color: '#5f5f5f', fontWeight: 'bold' },
            { tag: [visKeywordTag], color: '#767676', fontStyle: 'italic' },
            { tag: [t.propertyName], color: '#767676' },
            { tag: [t.string, t.meta], color: '#818181' },
            { tag: [t.name], color: '#767676' },
            { tag: [t.typeName, t.typeOperator], color: '#7d7d7d' },
            { tag: [t.variableName], color: '#787878' },
            { tag: [t.definition(t.variableName)], color: '#787878' },
            { tag: [t.regexp, t.link], color: '#858585' },
            ...styles,
        ],
    });
}

export const monochromeLight = monochromeLightInit();
