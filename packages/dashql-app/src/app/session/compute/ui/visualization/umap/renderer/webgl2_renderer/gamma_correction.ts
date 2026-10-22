// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { Dataflow, Node } from "../dataflow.js";
import { webglBuffer, webglProgram } from "./utils.js";

function shaderSource() {
    let vertex = `#version 300 es
    precision highp float;
    uniform vec2 xyScaler;
    layout(location=0) in vec2 xy;
    out vec2 uv;
    void main() {
      gl_Position = vec4(xy * xyScaler, 0, 1);
      uv = (xy + 1.0) / 2.0;
    }
  `;
    let fragment = `#version 300 es
    precision highp float;
    uniform sampler2D source;
    uniform float gamma;
    in vec2 uv;
    out vec4 outColor;
    void main() {
      vec4 color = texture(source, uv);
      color.rgb = pow(color.rgb, vec3(1.0 / gamma));
      outColor = color;
    }
  `;
    return { vertex, fragment };
}

type GammaCorrectionCommand = (input: WebGLTexture, gamma: number, xScaler?: number, yScaler?: number) => void;

export function gammaCorrectionCommand(df: Dataflow, gl: Node<WebGL2RenderingContext>): Node<GammaCorrectionCommand> {
    let { vertex, fragment } = shaderSource();
    let program = df.statefulDerive([gl, vertex, fragment], webglProgram);
    let attr = df.statefulDerive([gl, [-1, -1, -1, 1, 1, -1, 1, 1], "f32"], webglBuffer);

    return df.derive([gl, program, attr], (gl, program, attr) => (input, gamma, xScaler, yScaler) => {
        gl.disable(gl.BLEND);
        gl.enableVertexAttribArray(0);
        gl.bindBuffer(gl.ARRAY_BUFFER, attr);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        gl.bindTexture(gl.TEXTURE_2D, input);

        gl.useProgram(program.program);
        gl.uniform1i(program.uniforms.source, 0);
        gl.uniform2f(program.uniforms.xyScaler, xScaler ?? 1, yScaler ?? 1);
        gl.uniform1f(program.uniforms.gamma, gamma ?? 2.2);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.useProgram(null);

        gl.bindTexture(gl.TEXTURE_2D, null);

        gl.disableVertexAttribArray(0);
    });
}
