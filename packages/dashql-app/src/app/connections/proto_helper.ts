import * as connection from '@ankoh/dashql-jsonschema/connection.js';

/**
 * Convert Date to ISO 8601 string for JSON schema date-time fields
 */
export function dateToTimestamp(date: Date | null): string | undefined {
    if (!date) return undefined;
    return date.toISOString();
}

/**
 * Convert ISO 8601 string to Date
 */
export function timestampToDate(timestamp: string | undefined): Date | null {
    if (!timestamp) return null;
    return new Date(timestamp);
}
