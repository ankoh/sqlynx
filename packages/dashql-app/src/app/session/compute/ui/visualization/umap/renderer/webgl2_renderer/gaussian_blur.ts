// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { Dataflow, Node } from "../dataflow.js";
import type { IFramebuffer } from "./utils.js";
import { webglBuffer, webglProgram } from "./utils.js";

export function gaussianBlurPixelRadius(radius: number): number {
    return Math.ceil(radius * 3);
}

function shaderSource(radius: number) {
    let d = gaussianBlurPixelRadius(radius);
    let weights: number[] = [];
    for (let i = -d; i <= d; i++) {
        weights.push(Math.exp((-i * i) / radius / radius / 2));
    }
    let wsum = weights.reduce((a, b) => a + b, 0);
    weights = weights.map((x) => x / wsum);
    let m = linearSamplesForPointWeights(weights);
    let gaussianLineBlurList = m.map(([i, w]) => [i - d, w]);

    let vertex = `#version 300 es
    precision highp float;
    layout(location=0) in vec2 xy;
    out vec2 uv;
    void main() {
      gl_Position = vec4(xy, 0, 1);
      uv = (xy + 1.0) / 2.0;
    }
  `;
    let fragment = `#version 300 es
    precision highp float;
    uniform sampler2D image;
    uniform vec2 resolution;
    uniform vec2 direction;
    in vec2 uv;
    out vec4 outColor;

    void main() {
      vec4 color = vec4(0.0);
      ${gaussianLineBlurList
            .map(([i, w]) => {
                return `color += texture(image, uv + direction * vec2(${i.toFixed(10)}) / resolution) * ${w.toFixed(10)};`;
            })
            .join("\n")}
      outColor = color;
    }
  `;
    return { vertex, fragment };
}

type GaussianBlurCommand = (texture: WebGLTexture, destination: IFramebuffer, tmp: IFramebuffer) => void;

export function gaussianBlurCommand(
    df: Dataflow,
    gl: Node<WebGL2RenderingContext>,
    radius: Node<number>,
): Node<GaussianBlurCommand> {
    let source = df.derive([radius], shaderSource);
    let program = df.statefulDerive(
        [gl, df.derive([source], (x) => x.vertex), df.derive([source], (x) => x.fragment)],
        webglProgram,
    );
    let attr = df.statefulDerive([gl, [-1, -1, -1, 1, 1, -1, 1, 1], "f32"], webglBuffer);
    return df.derive([gl, attr, program, radius], (gl, attr, program, radius) => (texture, destination, tmp) => {
        let { width, height } = destination;
        gl.disable(gl.BLEND);
        gl.enableVertexAttribArray(0);
        gl.bindBuffer(gl.ARRAY_BUFFER, attr);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        gl.useProgram(program.program);
        gl.uniform2f(program.uniforms.resolution, width, height);
        gl.uniform1i(program.uniforms.image, 0);

        // texture => tmp.framebuffer, [0, 1]
        gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform2f(program.uniforms.direction, 0, 1);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // destination.texture => tmp.framebuffer, [1, 0]
        gl.bindFramebuffer(gl.FRAMEBUFFER, destination.framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, tmp.texture);
        gl.uniform2f(program.uniforms.direction, 1, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.disableVertexAttribArray(0);
    });
}

/** Converts a list of point sample weights to linear sample locations and weights.
 * The idea is that with linear texture sampling, we can sample two pixels with
 * one texture2D operation.
 *
 * The input should be a list of weights w0, w1, w2, ..., for pixels 0, 1, 2, ...
 * The function returns a list of tuples, each tuple is a [location, weight] pair.
 * The location is a fractional number such as 0.2, 1.3, which can be used as locations
 * for linear sampling.
 *
 * Example:
 * - Input: [2, 3, 4, 12]
 * - Output: [[0.6, 5], [2.75..., 16]]
 *
 * Assume the input pixels are x0, x1, x2, x3,
 * the result of this would be 2 x0 + 3 x1 + 4 x2 + 12 x3
 *
 * This is equal to linear sample at 0.6, weight 5, plus linear sample at 2.75, weight 16.
 * Verify that:
 * (0.4 x0 + 0.6 x1) * 5 + (0.25 x2 + 0.75 x3) * 16 == 2 x0 + 3 x1 + 4 x2 + 12 x3
 */
function linearSamplesForPointWeights(weights: number[]): [number, number][] {
    let result: [number, number][] = [];
    for (let i = 0; i < weights.length; i += 2) {
        if (i + 1 < weights.length) {
            let w1 = weights[i];
            let w2 = weights[i + 1];
            let t = 1 - w1 / (w1 + w2);
            if (t >= 0 && t <= 1) {
                let w = w1 + w2;
                if (w != 0) {
                    result.push([i + t, w]);
                }
            } else {
                result.push([i, weights[i]]);
                result.push([i + 1, weights[i + 1]]);
            }
        } else {
            result.push([i, weights[i]]);
        }
    }
    return result;
}
