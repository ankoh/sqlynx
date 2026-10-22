// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

export type Matrix3 = [number, number, number, number, number, number, number, number, number];
export type Vector2 = [number, number];
export type Vector3 = [number, number, number];
export type Vector4 = [number, number, number, number];

export function matrix3_zero(): Matrix3 {
    return [0, 0, 0, 0, 0, 0, 0, 0, 0];
}

export function matrix3_identity(): Matrix3 {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function matrix3_matrix_mul_matrix(m1: Matrix3, m2: Matrix3): Matrix3 {
    return [
        m1[0] * m2[0] + m1[3] * m2[1] + m1[6] * m2[2],
        m1[1] * m2[0] + m1[4] * m2[1] + m1[7] * m2[2],
        m1[2] * m2[0] + m1[5] * m2[1] + m1[8] * m2[2],
        m1[0] * m2[3] + m1[3] * m2[4] + m1[6] * m2[5],
        m1[1] * m2[3] + m1[4] * m2[4] + m1[7] * m2[5],
        m1[2] * m2[3] + m1[5] * m2[4] + m1[8] * m2[5],
        m1[0] * m2[6] + m1[3] * m2[7] + m1[6] * m2[8],
        m1[1] * m2[6] + m1[4] * m2[7] + m1[7] * m2[8],
        m1[2] * m2[6] + m1[5] * m2[7] + m1[8] * m2[8],
    ];
}

export function matrix3_matrix_mul_vector(m: Matrix3, v: Vector3): Vector3 {
    return [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
}

export function matrix3_vector_mul_matrix(v: Vector3, m: Matrix3): Vector3 {
    return [
        m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
        m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
        m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
    ];
}

export function matrix3_determinant(m: Matrix3): number {
    return (
        m[0] * m[4] * m[8] -
        m[0] * m[5] * m[7] -
        m[1] * m[3] * m[8] +
        m[1] * m[5] * m[6] +
        m[2] * m[3] * m[7] -
        m[2] * m[4] * m[6]
    );
}

export function matrix3_inverse(m: Matrix3): Matrix3 {
    let det = matrix3_determinant(m);
    return [
        (m[4] * m[8] - m[5] * m[7]) / det,
        (m[2] * m[7] - m[1] * m[8]) / det,
        (m[1] * m[5] - m[2] * m[4]) / det,
        (m[5] * m[6] - m[3] * m[8]) / det,
        (m[0] * m[8] - m[2] * m[6]) / det,
        (m[2] * m[3] - m[0] * m[5]) / det,
        (m[3] * m[7] - m[4] * m[6]) / det,
        (m[1] * m[6] - m[0] * m[7]) / det,
        (m[0] * m[4] - m[1] * m[3]) / det,
    ];
}
