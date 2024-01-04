import React from 'react';

interface Props {
    children: React.ReactElement;
}

export const ConnectorSwitch: React.FC<Props> = (props: Props) => {
    return props.children;
};
