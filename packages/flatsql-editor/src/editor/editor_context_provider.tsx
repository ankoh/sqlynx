import * as React from 'react';
import { EditorContext } from './editor_context';

type Setter = (ctx: EditorContext) => void;
const editorCtx = React.createContext<EditorContext | null>(null);
const editorCtxSetter = React.createContext<(s: EditorContext) => void>(c => {});

type Props = {
    children: React.ReactElement;
};

export const EditorContextProvider: React.FC<Props> = (props: Props) => {
    const [s, d] = React.useState<EditorContext | null>(null);
    return (
        <editorCtx.Provider value={s}>
            <editorCtxSetter.Provider value={d}>{props.children}</editorCtxSetter.Provider>
        </editorCtx.Provider>
    );
};

export const useEditorContext = (): EditorContext => React.useContext(editorCtx)!;
export const useEditorContextSetter = (): Setter => React.useContext(editorCtxSetter);
