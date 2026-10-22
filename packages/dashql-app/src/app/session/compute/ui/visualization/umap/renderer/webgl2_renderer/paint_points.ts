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
    uniform mat4 colorMatrix;
    uniform float pointAlpha;
    uniform float globalAlpha;
    uniform int isDarkMode;
    in vec2 uv;
    out vec4 outColor;

    /* Combine alphas with symmetric blending equation f(a, b) = a + b - ab. */
    float combine_alphas(vec4 alphas) {
      float r = alphas.x + alphas.y - alphas.x * alphas.y;
      r = r + alphas.z - r * alphas.z;
      r = r + alphas.w - r * alphas.w;
      return r;
    }

    void main() {
      vec4 count = texture(source, uv);
      vec4 alphas = pointAlpha >= 0.999
        ? vec4(count.x > 0.0 ? 1.0 : 0.0, count.y > 0.0 ? 1.0 : 0.0, count.z > 0.0 ? 1.0 : 0.0, count.w > 0.0 ? 1.0 : 0.0)
        : vec4(1.0) - pow(vec4(1.0 - pointAlpha), count);
      float a = combine_alphas(alphas);
      if (a <= 0.0) { discard; }
      alphas *= a / (alphas.x + alphas.y + alphas.z + alphas.w);

      vec3 c1 = colorMatrix[0].rgb * alphas.x;
      vec3 c2 = colorMatrix[1].rgb * alphas.y;
      vec3 c3 = colorMatrix[2].rgb * alphas.z;
      vec3 c4 = colorMatrix[3].rgb * alphas.w;
      vec3 c;
      if (isDarkMode == 0) {
        c = vec3(1.0) - a + c1 + c2 + c3 + c4;
      } else {
        c = c1 + c2 + c3 + c4;
      }
      outColor = vec4(c, 1.0) * a * globalAlpha;
    }
  `;
    return { vertex, fragment };
}

type PaintPointsCommand = (
    input: IFramebuffer,
    pointAlpha: number,
    globalAlpha: number,
    colorMatrix: number[],
    colorScheme: "light" | "dark",
) => void;

export function paintPointsCommand(df: Dataflow, gl: Node<WebGL2RenderingContext>): Node<PaintPointsCommand> {
    let { vertex, fragment } = shaderSource();
    let program = df.statefulDerive([gl, vertex, fragment], webglProgram);
    let attr = df.statefulDerive([gl, [-1, -1, -1, 1, 1, -1, 1, 1], "f32"], webglBuffer);

    return df.derive(
        [gl, program, attr],
        (gl, program, attr) => (input, pointAlpha, globalAlpha, colorMatrix, colorScheme) => {
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
            gl.uniform1f(program.uniforms.pointAlpha, pointAlpha);
            gl.uniform1f(program.uniforms.globalAlpha, globalAlpha);
            gl.uniform1i(program.uniforms.isDarkMode, colorScheme == "dark" ? 1 : 0);
            gl.uniformMatrix4fv(program.uniforms.colorMatrix, false, colorMatrix);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.useProgram(null);

            gl.bindTexture(gl.TEXTURE_2D, null);

            gl.disableVertexAttribArray(0);
        },
    );
}
