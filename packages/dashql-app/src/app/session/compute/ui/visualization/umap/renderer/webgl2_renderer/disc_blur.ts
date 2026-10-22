// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { Dataflow, Node } from "../dataflow.js";
import type { IFramebuffer } from "./utils.js";
import { webglBuffer, webglProgram } from "./utils.js";

function discBlurShader(weights: ReturnType<typeof circleConvolutionWeights>) {
    let squareMaxSize = weights.squareMaxSize;
    let samples = weights.samples;
    let vertex = `#version 300 es
    precision highp float;
    layout(location=0) in vec2 xy;
    out vec2 uv;
    void main() {
      gl_Position = vec4(xy, 0, 1);
      uv = (xy + 1.0) / 2.0;
    }
  `;
    let fragment1 = `#version 300 es
    precision highp float;
    uniform sampler2D image;
    uniform vec2 resolution;
    uniform vec2 direction;
    in vec2 uv;
    out vec4 outColor;
    void main() {
      vec4 color = vec4(0.0);
      const int count = ${squareMaxSize};
      int i = -count;
      while(i + 1 <= count) {
        color += texture(image, uv + direction * (float(i) + 0.5) / resolution) * 2.0;
        i += 2;
      }
      if (i <= count) {
        color += texture(image, uv + direction * float(count) / resolution);
      }
      outColor = color;
    }
  `;
    let fragment2 = `#version 300 es
    precision highp float;
    uniform sampler2D image;
    uniform sampler2D imageBox;
    uniform vec2 resolution;
    uniform float scaler;
    in vec2 uv;
    out vec4 outColor;

    void main() {
      vec4 color = texture(imageBox, uv);
      if (color != vec4(0.0)) {
        ${samples.map(({ x, y, w }) => `color -= texture(image, uv + vec2(${x.toFixed(8)}, ${y.toFixed(8)}) / resolution) * (${w.toFixed(8)})`).join(";")};
      }
      outColor = color * scaler;
    }
  `;
    return { vertex, fragment1, fragment2 };
}

type DiscBlurCommand = (texture: WebGLTexture, destination: IFramebuffer, tmp: IFramebuffer) => void;

export function discBlurCommand(
    df: Dataflow,
    gl: Node<WebGL2RenderingContext>,
    radius: Node<number>,
): Node<DiscBlurCommand> {
    let weights = df.derive([radius], circleConvolutionWeights);
    let source = df.derive([weights], discBlurShader);
    let program1 = df.statefulDerive(
        [gl, df.derive([source], (x) => x.vertex), df.derive([source], (x) => x.fragment1)],
        webglProgram,
    );
    let program2 = df.statefulDerive(
        [gl, df.derive([source], (x) => x.vertex), df.derive([source], (x) => x.fragment2)],
        webglProgram,
    );
    let attr = df.statefulDerive([gl, [-1, -1, -1, 1, 1, -1, 1, 1], "f32"], webglBuffer);
    return df.derive(
        [gl, attr, program1, program2, radius, weights],
        (gl, attr, program1, program2, radius, weights) => (texture, destination, tmp) => {
            let { width, height } = destination;
            gl.disable(gl.BLEND);
            gl.enableVertexAttribArray(0);
            gl.bindBuffer(gl.ARRAY_BUFFER, attr);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);

            gl.useProgram(program1.program);
            gl.uniform2f(program1.uniforms.resolution, width, height);
            gl.uniform1i(program1.uniforms.image, 0);

            // texture => destination.framebuffer, [0, 1]
            gl.bindFramebuffer(gl.FRAMEBUFFER, destination.framebuffer);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.uniform2f(program1.uniforms.direction, 0, 1);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            // destination.texture => tmp.framebuffer, [1, 0]
            gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.framebuffer);
            gl.bindTexture(gl.TEXTURE_2D, destination.texture);
            gl.uniform2f(program1.uniforms.direction, 1, 0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            // program2: texture, tmp.texture => destinatino.framebuffer
            gl.bindFramebuffer(gl.FRAMEBUFFER, destination.framebuffer);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, tmp.texture);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);

            gl.useProgram(program2.program);
            gl.uniform2f(program2.uniforms.resolution, width, height);
            gl.uniform1i(program2.uniforms.image, 0);
            gl.uniform1i(program2.uniforms.imageBox, 1);
            let scaler = (1.0 / weights.totalWeight) * radius * radius * Math.PI;
            gl.uniform1f(program2.uniforms.scaler, scaler);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            gl.useProgram(null);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.disableVertexAttribArray(0);
        },
    );
}

/** Returns the alpha value of a circle's pixel at (px, py).
 * The circle is centered at the center of pixel (0, 0) with the given radius.
 * The alpha value should approximate the amount of overlap between the target pixel and the circle.
 */
function circleAlpha(radius: number, px: number, py: number): number {
    let d = Math.sqrt(px * px + py * py);
    if (d < radius - Math.sqrt(2) / 2) {
        return 1;
    }
    if (d > radius + Math.sqrt(2) / 2) {
        return 0;
    }
    let divs = 2;
    let count = 0;
    for (let i = 0; i < divs; i++) {
        for (let j = 0; j < divs; j++) {
            let sx = px + (i + 0.5) / divs - 0.5;
            let sy = py + (j + 0.5) / divs - 0.5;
            let d = Math.sqrt(sx * sx + sy * sy);
            if (d < radius) {
                count += 1;
            }
        }
    }
    return count / divs / divs;
}

function circleConvolutionWeights(radius: number): {
    squareMaxSize: number;
    squareWeight: number;
    samples: { x: number; y: number; w: number }[];
    totalWeight: number;
} {
    let size = Math.floor(radius + 0.5);
    let squareMaxSize = size;
    let squareWeight = circleAlpha(radius, 0, 0);
    let samples0: { x: number; y: number; w: number }[] = [];
    for (let x = -size; x <= size; x++) {
        for (let y = -size; y <= size; y++) {
            let w = squareWeight - circleAlpha(radius, x, y);
            if (w <= 0) {
                continue;
            }
            if (samples0.length > 0 && x == samples0[samples0.length - 1].x && y == samples0[samples0.length - 1].y + 1) {
                let w1 = samples0[samples0.length - 1].w;
                let w2 = w;
                samples0[samples0.length - 1].y += 1 - w1 / (w1 + w2);
                samples0[samples0.length - 1].w = w1 + w2;
            } else {
                samples0.push({ x, y, w });
            }
        }
    }
    samples0 = samples0.sort((a, b) => (a.y != b.y ? a.y - b.y : a.x - b.x));
    let samples: { x: number; y: number; w: number }[] = [];
    for (let { x, y, w } of samples0) {
        if (samples.length > 0 && y == samples[samples.length - 1].y && x == samples[samples.length - 1].x + 1) {
            let w1 = samples[samples.length - 1].w;
            let w2 = w;
            samples[samples.length - 1].x += 1 - w1 / (w1 + w2);
            samples[samples.length - 1].w = w1 + w2;
        } else {
            samples.push({ x, y, w });
        }
    }
    let totalWeight = -samples.reduce((a, b) => a + b.w, 0);
    totalWeight += squareWeight * (1 + squareMaxSize * 2) * (1 + squareMaxSize * 2);
    return { squareMaxSize, squareWeight, samples: samples, totalWeight: totalWeight };
}
