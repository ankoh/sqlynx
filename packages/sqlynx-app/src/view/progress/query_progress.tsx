import * as React from 'react';
import { CenteredRectangleWaveSpinner } from '../../view/spinners';

interface Props {}

export const QueryProgress: React.FC<Props> = (props: Props) => {
    return <CenteredRectangleWaveSpinner active={true} />;
};
