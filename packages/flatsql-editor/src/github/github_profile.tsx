import * as React from 'react';
import { useGitHubAPI } from './github_auth';

interface GitHubProfile {
    id: string;
    login: string;
    name: string;
    avatarUrl: string;
}

interface Props {
    children: React.ReactElement;
}

interface State {
    profile: GitHubProfile | null;
}

const activeProfileCtx = React.createContext<GitHubProfile | null>(null);

const GitHubActiveProfileProvider: React.FC<Props> = (props: Props) => {
    const [state, setState] = React.useState<State>({
        profile: null,
    });
    const isMountedRef = React.useRef<boolean>(true);
    React.useEffect(() => {
        return () => void (isMountedRef.current = false);
    }, []);

    const gh = useGitHubAPI();
    React.useEffect(() => {
        // Clear old profile
        setState(s => ({
            ...s,
            profile: null,
        }));
        // Not authenciated?
        if (!gh.isAuthenticated) return;
        // Fetch new profile
        (async () => {
            const result = (await gh.query(`
                query { 
                    viewer { 
                        login
                        avatarUrl
                        id
                        name
                    }
                }
            `)) as {
                viewer: {
                    login: string;
                    avatarUrl: string;
                    id: string;
                    name: string;
                };
            };
            if (!isMountedRef.current) return;
            if (result?.viewer.login) {
                setState(s => ({
                    ...s,
                    profile: result.viewer,
                }));
            }
        })();
    }, [gh]);

    return <activeProfileCtx.Provider value={state.profile}>{props.children}</activeProfileCtx.Provider>;
};

export const GitHubProfileProvider = (props: Props): React.ReactElement => (
    <GitHubActiveProfileProvider>{props.children}</GitHubActiveProfileProvider>
);

export const useActiveGitHubProfile = (): GitHubProfile | null => React.useContext(activeProfileCtx);
