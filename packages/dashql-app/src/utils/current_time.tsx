import * as React from 'react';

interface Props {
    refreshRate: number;
    children: (time: Date, updateTime: () => void) => React.ReactElement;
}

export const CurrentTime: React.FC<Props> = (props: Props) => {
    const [currentTime, setCurrentTime] = React.useState<Date>(new Date());
    React.useEffect(() => {
        const timer = setInterval(() => setCurrentTime(new Date()), props.refreshRate);
        return () => clearInterval(timer);
    }, [props.refreshRate]);
    return props.children(currentTime, () => setCurrentTime(new Date()));
};

export function withCurrentTime<
    OUT_PROPS extends { currentTime?: Date; updateCurrentTime: () => void },
    IN_PROPS = Pick<OUT_PROPS, Exclude<keyof OUT_PROPS, 'currentTime' | 'updateCurrentTime'>>,
>(Component: React.ComponentType<OUT_PROPS>, refreshRate: number): React.FunctionComponent<IN_PROPS> {
    // eslint-disable-next-line react/display-name
    return (props: IN_PROPS) => {
        return (
            <CurrentTime refreshRate={refreshRate}>
                {(time, update) => (
                    <Component
                        {...Object.assign({} as OUT_PROPS, props, { currentTime: time, updateCurrentTime: update })}
                    />
                )}
            </CurrentTime>
        );
    };
}
