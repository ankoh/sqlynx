import getPkce from 'oauth-pkce';

export interface PKCEChallenge {
    /// The PKCE challenge
    value: string;
    /// The PKCE challenge verifier
    verifier: string;
}

// Generate PKCE challenge
export function generatePKCEChallenge(): Promise<PKCEChallenge> {
    return new Promise<PKCEChallenge>((resolve, reject) => {
        getPkce(42, (error, { verifier, challenge }) => {
            if (error != null) {
                reject(error);
            } else {
                resolve({ value: challenge, verifier });
            }
        });
    });
}
