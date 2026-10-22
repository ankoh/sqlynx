// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { Dataflow, Node } from "../dataflow.js";
import type { IFramebuffer } from "./utils.js";
import { webglBuffer, webglProgram } from "./utils.js";

function shaderSource() {
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
    uniform sampler2D source;
    uniform vec2 resolution;
    uniform float densityScaler;
    uniform float quantizationStep;
    uniform vec4 channelMask;
    uniform vec4 color;
    uniform float globalAlpha;

    in vec2 uv;
    out vec4 outColor;

    float sample_density(vec2 uv) {
      float d = dot(texture(source, uv), channelMask) * densityScaler;
      d = min(1.0, max(0.0, d));
      d = floor(d / quantizationStep);
      return d;
    }

    void main() {
      // Run the Sobel operator.
      float v = sample_density(uv);
      float v11 = sample_density(uv + vec2(-1, -1) / resolution);
      float v12 = sample_density(uv + vec2(-1,  0) / resolution);
      float v13 = sample_density(uv + vec2(-1, +1) / resolution);
      float v21 = sample_density(uv + vec2( 0, -1) / resolution);
      float v23 = sample_density(uv + vec2( 0, +1) / resolution);
      float v31 = sample_density(uv + vec2(+1, -1) / resolution);
      float v32 = sample_density(uv + vec2(+1,  0) / resolution);
      float v33 = sample_density(uv + vec2(+1, +1) / resolution);
      float gx = v11 + v12 * 2.0 + v13 - v31 - v32 * 2.0 - v33;
      float gy = v11 + v21 * 2.0 + v31 - v13 - v23 * 2.0 - v33;
      // Derive alpha value from the result.
      float alpha = length(vec2(gx, gy)) * 0.2;
      alpha = min(1.0, max(0.0, alpha));
      outColor = color * alpha * globalAlpha;
    }
  `;
    return { vertex, fragment };
}

type PaintContoursCommand = (
    input: IFramebuffer,
    densityScaler: number,
    quantizationStep: number,
    globalAlpha: number,
    channelMask: number[],
    color: number[],
) => void;

export function paintContoursCommand(df: Dataflow, gl: Node<WebGL2RenderingContext>): Node<PaintContoursCommand> {
    let { vertex, fragment } = shaderSource();
    let program = df.statefulDerive([gl, vertex, fragment], webglProgram);
    let attr = df.statefulDerive([gl, [-1, -1, -1, 1, 1, -1, 1, 1], "f32"], webglBuffer);

    return df.derive(
        [gl, program, attr],
        (gl, program, attr) => (input, densityScaler, quantizationStep, globalAlpha, channelMask, color) => {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.enableVertexAttribArray(0);
            gl.bindBuffer(gl.ARRAY_BUFFER, attr);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);

            gl.bindTexture(gl.TEXTURE_2D, input.texture);

            gl.useProgram(program.program);
            gl.uniform1i(program.uniforms.source, 0);
            gl.uniform2f(program.uniforms.resolution, input.width, input.height);
            gl.uniform1f(program.uniforms.densityScaler, densityScaler);
            gl.uniform1f(program.uniforms.quantizationStep, quantizationStep);
            gl.uniform1f(program.uniforms.globalAlpha, globalAlpha);
            gl.uniform4fv(program.uniforms.channelMask, channelMask);
            gl.uniform4fv(program.uniforms.color, color);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.useProgram(null);

            gl.bindTexture(gl.TEXTURE_2D, null);

            gl.disableVertexAttribArray(0);
        },
    );
}
