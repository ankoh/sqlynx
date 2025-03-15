import getPkceImport from 'oauth-pkce';
export const getPkce = getPkceImport as unknown as typeof getPkceImport.default;

export interface PKCEChallenge {
    /// The PKCE challenge
    value: string;
    /// The PKCE challenge verifier
    verifier: string;
}

// Generate PKCE challenge
export function generatePKCEChallenge(): Promise<PKCEChallenge> {
    return new Promise<PKCEChallenge>((resolve, reject) => {
        getPkce(42, (error: any, { verifier, challenge }: any) => {
            if (error != null) {
                reject(error);
            } else {
                resolve({ value: challenge, verifier });
            }
        });
    });
}
