// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { Dataflow, Node } from "../dataflow.js";
import type { IFramebuffer } from "./utils.js";
import { webglBuffer, webglProgram } from "./utils.js";

export function gaussianBlurR20PixelRadius(radius: number): number {
    return Math.ceil(radius * 3);
}

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
    uniform sampler2D image;
    uniform vec2 resolution;
    uniform vec2 direction;
    in vec2 uv;
    out vec4 outColor;

    uniform float weight0;
    uniform vec3 distances;
    uniform vec3 weights;

    void main() {
      vec4 color = texture(image, uv) * weight0;
      if (weights.x != 0.0) {
        color += texture(image, uv + direction * vec2(distances.x) / resolution) * weights.x;
        color += texture(image, uv - direction * vec2(distances.x) / resolution) * weights.x;
      }
      if (weights.y != 0.0) {
        color += texture(image, uv + direction * vec2(distances.y) / resolution) * weights.y;
        color += texture(image, uv - direction * vec2(distances.y) / resolution) * weights.y;
      }
      if (weights.z != 0.0) {
        color += texture(image, uv + direction * vec2(distances.z) / resolution) * weights.z;
        color += texture(image, uv - direction * vec2(distances.z) / resolution) * weights.z;
      }
      outColor = color;
    }
  `;
    return { vertex, fragment };
}

type GaussianBlurCommand = (texture: WebGLTexture, destination: IFramebuffer, tmp: IFramebuffer) => void;

export function gaussianBlurR20Command(
    df: Dataflow,
    gl: Node<WebGL2RenderingContext>,
    bandwidth: Node<number>,
): Node<GaussianBlurCommand> {
    // Note: bandwidth is not taken into account yet, this function (as its name suggests) only currently do bandwidth = 20.
    let { vertex, fragment } = shaderSource();
    let program = df.statefulDerive([gl, vertex, fragment], webglProgram);
    let attr = df.statefulDerive([gl, [-1, -1, -1, 1, 1, -1, 1, 1], "f32"], webglBuffer);
    return df.derive([gl, attr, program], (gl, attr, program) => (texture, destination, tmp) => {
        let { width, height } = destination;
        gl.disable(gl.BLEND);
        gl.enableVertexAttribArray(0);
        gl.bindBuffer(gl.ARRAY_BUFFER, attr);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        gl.useProgram(program.program);
        gl.uniform2f(program.uniforms.resolution, width, height);
        gl.uniform1i(program.uniforms.image, 0);

        let src = texture;
        let tmp1 = tmp;
        let tmp2 = destination;

        for (let dir = 0; dir < 2; dir++) {
            gl.uniform2f(program.uniforms.direction, dir, 1 - dir);
            for (let [distances, weights0, weights] of filters20) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, tmp1.framebuffer);
                gl.bindTexture(gl.TEXTURE_2D, src);
                gl.uniform1fv(program.uniforms.weight0, weights0);
                gl.uniform3fv(program.uniforms.distances, distances);
                gl.uniform3fv(program.uniforms.weights, weights);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                src = tmp1.texture;
                // Swap tmp1, tmp2. Since we swap a even number of times, in the end tmp1 == tmp, tmp2 == destination,
                // and the final result be stored in destination.
                let tt = tmp1;
                tmp1 = tmp2;
                tmp2 = tt;
            }
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.disableVertexAttribArray(0);
    });
}

const filters20 = [
    [[1, 2, 3], [0.2288468365182578], [0.18230006506971572, 0.1356122230111784, 0.06766429365997693]],
    [[2, 6, 10], [0.09116254014100238], [0.23317759354726447, 0.18385867277788717, 0.03738246360434722]],
    [[3, 10, 20], [0.2950645715317288], [0.010918865853671198, 0.23773695670296047, 0.10381189167750389]],
    [[4, 16, 30], [0.20085957073474772], [0.14463019087130788, 0.17934533765938643, 0.07559468610193185]],
];
