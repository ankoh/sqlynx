
export interface DetailedError {
    /// The error message
    message: string;
    /// The error details
    details?: Record<string, string>;
}
