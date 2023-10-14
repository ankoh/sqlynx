import * as React from 'react';
import { useGitHubAPI } from './github_auth';

interface Props {
    children: React.ReactElement;
}

interface State {
    next: null;
    result: any | null;
}

export const GitHubGistsProvider: React.FC<Props> = (props: Props) => {
    const [state, setState] = React.useState<State>({
        next: null,
        result: null,
    });
    const isMountedRef = React.useRef<boolean>(true);
    React.useEffect(() => {
        return () => void (isMountedRef.current = false);
    }, []);

    const gh = useGitHubAPI();
    React.useEffect(() => {
        // Clear old results
        setState(s => ({
            ...s,
            result: null,
        }));
        // Fetch new results
        (async () => {
            const result = await gh.query(`
                query { 
                    viewer { 
                        gists (orderBy: {field: PUSHED_AT, direction: DESC}, first: 100) {
                            totalCount
                            edges {
                                node {
                                    resourcePath
                                    name
                                    description
                                    pushedAt
                                    stargazerCount
                                    isFork
                                    isPublic
                                    files {
                                        path: encodedName
                                        name
                                        size
                                    }
                                }
                            }
                            pageInfo {
                                endCursor
                                hasNextPage
                            }
                        }
                    }
                }
            `);
            console.log(result);
            if (!isMountedRef.current) return;
            setState(s => ({
                ...s,
                result,
            }));
        })();
    }, [gh, state.next]);

    return props.children;
};
