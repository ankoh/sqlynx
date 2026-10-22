// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { Dataflow, Node } from "../dataflow.js";
import type { Matrix3 } from "../matrix.js";
import { webglProgram } from "./utils.js";

function shaderSource(hasCategory: boolean) {
    let vertex: string;
    if (hasCategory) {
        vertex = `#version 300 es
      precision highp float;
      uniform mat3 matrix;
      layout(location=0) in float x;
      layout(location=1) in float y;
      layout(location=2) in int category;
      out vec4 color;
      void main() {
        gl_Position = vec4(matrix * vec3(x, y, 1), 1);
        if (category == 0) {
          color = vec4(1, 0, 0, 0);
        } else if (category == 1) {
          color = vec4(0, 1, 0, 0);
        } else if (category == 2) {
          color = vec4(0, 0, 1, 0);
        } else if (category == 3) {
          color = vec4(0, 0, 0, 1);
        }
        gl_PointSize = 1.0;
      }
    `;
    } else {
        vertex = `#version 300 es
      precision highp float;
      uniform mat3 matrix;
      layout(location=0) in float x;
      layout(location=1) in float y;
      out vec4 color;
      void main() {
        gl_Position = vec4(matrix * vec3(x, y, 1), 1);
        color = vec4(1, 0, 0, 0);
        gl_PointSize = 1.0;
      }
    `;
    }
    let fragment = `#version 300 es
    precision highp float;
    in vec4 color;
    out vec4 outColor;
    void main() {
      outColor = color;
    }
  `;
    return { vertex, fragment };
}

type FillCountBufferCommand = (matrix: Matrix3) => void;

export function fillCountBufferCommand(
    df: Dataflow,
    gl: Node<WebGL2RenderingContext>,
    x: Node<WebGLBuffer>,
    y: Node<WebGLBuffer>,
    category: Node<WebGLBuffer> | null,
    count: Node<number>,
): Node<FillCountBufferCommand> {
    let hasCategory = category != null;
    let source = shaderSource(hasCategory);
    let program = df.statefulDerive([gl, source.vertex, source.fragment], webglProgram);
    return df.derive([gl, program, x, y, category, count], (gl, program, x, y, category, count) => (matrix) => {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);

        gl.useProgram(program.program);

        gl.enableVertexAttribArray(0);
        gl.bindBuffer(gl.ARRAY_BUFFER, x);
        gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(1);
        gl.bindBuffer(gl.ARRAY_BUFFER, y);
        gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
        if (category != null) {
            gl.enableVertexAttribArray(2);
            gl.bindBuffer(gl.ARRAY_BUFFER, category);
            gl.vertexAttribIPointer(2, 1, gl.BYTE, 0, 0);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        gl.uniformMatrix3fv(program.uniforms.matrix, false, matrix);

        gl.drawArrays(gl.POINTS, 0, count);

        gl.disableVertexAttribArray(0);
        gl.disableVertexAttribArray(1);
        if (category != null) {
            gl.disableVertexAttribArray(2);
        }
        gl.useProgram(null);
    });
}
