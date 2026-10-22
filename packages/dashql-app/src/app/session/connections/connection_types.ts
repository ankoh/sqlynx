/**
 * TypeScript-native connection types (replaces protobuf types)
 *
 * These types are used internally in connection state management.
 * For storage/serialization, use JSON schema types from @ankoh/dashql-jsonschema.
 */

/**
 * Detailed error information for connection failures
 */
export interface DetailedError {
    message: string;
    data?: Record<string, string>;
}

export type { AppEventData, OAuthRedirectData, OAuthState } from '../../../oauth_types.js';
