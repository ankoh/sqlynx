// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { dericheConfig } from "./deriche.js";

import type { Vector4 } from "../matrix.js";

export interface KDEConfig {
    kde_causal: Vector4;
    kde_anticausal: Vector4;
    kde_a: Vector4;
}

export function kdeConfig(sigma: number): KDEConfig {
    let config = dericheConfig(sigma);
    return {
        kde_causal: [config.b_causal[0], config.b_causal[1], config.b_causal[2], config.b_causal[3]],
        kde_anticausal: [config.b_anticausal[1], config.b_anticausal[2], config.b_anticausal[3], config.b_anticausal[4]],
        kde_a: [config.a[1], config.a[2], config.a[3], config.a[4]],
    };
}
