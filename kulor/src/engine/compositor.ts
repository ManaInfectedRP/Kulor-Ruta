// The one renderer in the app. Live preview and export both draw through this class, so what you
// see while grading is by construction what ends up in the file. Works in 16 bit float internally:
// a grade pushing values past white can be pulled back by a later node without clipping.

import type { Grade } from '../core/types';
import { MAX_GRADE_NODES } from '../core/types';
import { buildCurveTexture, CURVE_SIZE, nodeUniforms } from '../core/grade';

const VERTEX = `#version 300 es
in vec2 aCorner;
uniform mat3 uMatrix;
out vec2 vUv;
void main() {
  vUv = vec2(aCorner.x, 1.0 - aCorner.y);
  vec3 p = uMatrix * vec3(aCorner * 2.0 - 1.0, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

const LAYER_FRAGMENT = `#version 300 es
precision highp float;
#define MAX_NODES ${MAX_GRADE_NODES}
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uImage;
uniform sampler2D uCurves;
uniform sampler2D uPlaneU;
uniform sampler2D uPlaneV;
uniform int uIsYuv;
uniform int uPremultiplied;
uniform mat3 uYuvToRgb;
uniform float uOpacity;
uniform int uNodeCount;
uniform vec3 uLift[MAX_NODES];
uniform vec3 uGamma[MAX_NODES];
uniform vec3 uGain[MAX_NODES];
uniform vec3 uOffset[MAX_NODES];
uniform vec4 uTone[MAX_NODES];
uniform vec4 uBalance[MAX_NODES];
uniform vec4 uQualA[MAX_NODES];
uniform vec4 uQualB[MAX_NODES];
uniform vec4 uWinA[MAX_NODES];
uniform vec4 uWinB[MAX_NODES];

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float curve(float v, int node, int channel) {
  float clamped = clamp(v, 0.0, 1.0);
  vec2 at = vec2((clamped * ${(CURVE_SIZE - 1).toFixed(1)} + 0.5) / ${CURVE_SIZE.toFixed(1)},
                 (float(node) + 0.5) / ${MAX_GRADE_NODES.toFixed(1)});
  // Values outside 0..1 pass through with the curve's end offset, so super-whites are kept.
  return texture(uCurves, at)[channel] + (v - clamped);
}

vec3 rgbToHsl(vec3 c) {
  float hi = max(c.r, max(c.g, c.b));
  float lo = min(c.r, min(c.g, c.b));
  float l = (hi + lo) * 0.5;
  float d = hi - lo;
  if (d < 1e-5) return vec3(0.0, 0.0, l);
  float s = d / (1.0 - abs(2.0 * l - 1.0) + 1e-5);
  float h = hi == c.r ? mod((c.g - c.b) / d, 6.0) : hi == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}

float band(float v, float lo, float hi, float soft) {
  return smoothstep(lo - soft, lo + 1e-4, v) * (1.0 - smoothstep(hi - 1e-4, hi + soft, v));
}

float nodeMask(vec3 source, int i) {
  float mask = 1.0;
  bool used = false;
  if (uQualA[i].w > 0.5) {
    used = true;
    vec3 hsl = rgbToHsl(clamp(source, 0.0, 1.0));
    float distance = abs(hsl.x - uQualA[i].x);
    distance = min(distance, 1.0 - distance);
    float soft = uQualA[i].z;
    float hue = 1.0 - smoothstep(uQualA[i].y, uQualA[i].y + soft + 1e-4, distance);
    mask *= hue * band(hsl.y, uQualB[i].x, uQualB[i].y, soft) * band(hsl.z, uQualB[i].z, uQualB[i].w, soft);
  }
  if (uWinB[i].z > 0.5) {
    used = true;
    vec2 p = (vUv - uWinA[i].xy) / max(uWinA[i].zw, vec2(1e-4));
    float d = uWinB[i].y > 0.5 ? max(abs(p.x), abs(p.y)) : length(p);
    mask *= 1.0 - smoothstep(1.0 - uWinB[i].x, 1.0 + uWinB[i].x + 1e-4, d);
  }
  if (!used) return 1.0;
  return uWinB[i].w > 0.5 ? 1.0 - mask : mask;
}

vec3 gradeNode(vec3 input_, int i) {
  vec3 c = input_ + uOffset[i];

  float temperature = uBalance[i].x * 0.3;
  float tint = uBalance[i].y * 0.3;
  c *= vec3(1.0 + temperature, 1.0 - tint, 1.0 - temperature);

  c = c + uLift[i] * (1.0 - c);
  c = c * uGain[i];
  c = sign(c) * pow(abs(c), 1.0 / uGamma[i]);

  c = (c - uTone[i].y) * uTone[i].x + uTone[i].y;

  float luma = dot(c, LUMA);
  c = luma + (c - luma) * uTone[i].z;

  float angle = uTone[i].w;
  if (angle != 0.0) {
    // Rotation about the grey axis.
    vec3 k = vec3(0.57735026);
    c = c * cos(angle) + cross(k, c) * sin(angle) + k * dot(k, c) * (1.0 - cos(angle));
  }

  c = vec3(curve(c.r, i, 3), curve(c.g, i, 3), curve(c.b, i, 3));
  c = vec3(curve(c.r, i, 0), curve(c.g, i, 1), curve(c.b, i, 2));

  return mix(input_, c, nodeMask(input_, i));
}

vec4 source() {
  if (uIsYuv == 0) {
    vec4 s = texture(uImage, vUv);
    // Grading works on the true colour, so a soft text edge does not shift hue when it is graded.
    if (uPremultiplied == 1 && s.a > 0.0) s.rgb /= s.a;
    return s;
  }
  vec3 yuv = vec3(texture(uImage, vUv).r - 16.0 / 255.0,
                  texture(uPlaneU, vUv).r - 128.0 / 255.0,
                  texture(uPlaneV, vUv).r - 128.0 / 255.0);
  return vec4(uYuvToRgb * yuv, 1.0);
}

void main() {
  vec4 image = source();
  vec3 c = image.rgb;
  for (int i = 0; i < uNodeCount; i++) {
    if (uBalance[i].z > 0.5) c = gradeNode(c, i);
  }
  float alpha = image.a * uOpacity;
  outColor = vec4(c * alpha, alpha);
}`;

const PRESENT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uImage;
uniform float uFlip;
void main() {
  vec2 uv = vec2(vUv.x, uFlip > 0.5 ? vUv.y : 1.0 - vUv.y);
  outColor = vec4(clamp(texture(uImage, uv).rgb, 0.0, 1.0), 1.0);
}`;

/** RGB to BT.709 limited range, the inverse of the bt709 entry in YUV_MATRICES. */
const NV12_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uImage;
uniform int uChroma;
void main() {
  vec3 c = clamp(texture(uImage, vUv).rgb, 0.0, 1.0);
  if (uChroma == 0) {
    outColor = vec4(16.0 / 255.0 + dot(c, vec3(0.182586, 0.614231, 0.062007)), 0.0, 0.0, 1.0);
  } else {
    outColor = vec4(128.0 / 255.0 + dot(c, vec3(-0.100644, -0.338572, 0.439216)),
                    128.0 / 255.0 + dot(c, vec3(0.439216, -0.398942, -0.040274)), 0.0, 1.0);
  }
}`;

// Limited range YUV to full range RGB, column major.
const YUV_MATRICES: Record<string, Float32Array> = {
  bt709: new Float32Array([1.164384, 1.164384, 1.164384, 0, -0.213249, 2.112402, 1.792741, -0.532909, 0]),
  smpte170m: new Float32Array([1.164384, 1.164384, 1.164384, 0, -0.391762, 2.017232, 1.596027, -0.812968, 0]),
  bt2020: new Float32Array([1.164384, 1.164384, 1.164384, 0, -0.187326, 2.141772, 1.678674, -0.650424, 0]),
};

export interface DrawParams {
  grade: Grade | null;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  /** The texture holds premultiplied colour, as titles do. */
  premultiplied?: boolean;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(`Shaderfel: ${gl.getShaderInfoLog(shader)}`);
  return shader;
}

function link(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.bindAttribLocation(program, 0, 'aCorner');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(`Länkfel: ${gl.getProgramInfoLog(program)}`);
  return program;
}

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  private readonly layerProgram: WebGLProgram;
  private readonly presentProgram: WebGLProgram;
  private readonly nv12Program: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private readonly images = new Map<string, WebGLTexture>();
  private readonly curves: WebGLTexture;
  private accumFbo!: WebGLFramebuffer;
  private accumTex!: WebGLTexture;
  private readFbo!: WebGLFramebuffer;
  private readTex!: WebGLTexture;
  private scopeFbo!: WebGLFramebuffer;
  private scopeTex!: WebGLTexture;
  private lumaFbo!: WebGLFramebuffer;
  private lumaTex!: WebGLTexture;
  private chromaFbo!: WebGLFramebuffer;
  private chromaTex!: WebGLTexture;
  width = 0;
  height = 0;

  static readonly SCOPE_WIDTH = 320;
  static readonly SCOPE_HEIGHT = 180;

  constructor(private readonly canvas: AnyCanvas, width: number, height: number) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 saknas på den här datorn.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Grafikkortet saknar stöd för flyttalsbuffertar.');
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;

    this.layerProgram = link(gl, LAYER_FRAGMENT);
    this.presentProgram = link(gl, PRESENT_FRAGMENT);
    this.nv12Program = link(gl, NV12_FRAGMENT);

    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);

    this.curves = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.curves);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, CURVE_SIZE, MAX_GRADE_NODES);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.resize(width, height);
  }

  private target(internal: number, w: number, h: number): { fbo: WebGLFramebuffer; tex: WebGLTexture } {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fbo, tex };
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    const gl = this.gl;
    if (this.accumFbo) {
      gl.deleteFramebuffer(this.accumFbo);
      gl.deleteTexture(this.accumTex);
      gl.deleteFramebuffer(this.readFbo);
      gl.deleteTexture(this.readTex);
      gl.deleteFramebuffer(this.scopeFbo);
      gl.deleteTexture(this.scopeTex);
      gl.deleteFramebuffer(this.lumaFbo);
      gl.deleteTexture(this.lumaTex);
      gl.deleteFramebuffer(this.chromaFbo);
      gl.deleteTexture(this.chromaTex);
    }
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    ({ fbo: this.accumFbo, tex: this.accumTex } = this.target(gl.RGBA16F, width, height));
    ({ fbo: this.readFbo, tex: this.readTex } = this.target(gl.RGBA8, width, height));
    ({ fbo: this.scopeFbo, tex: this.scopeTex } = this.target(gl.RGBA8, Compositor.SCOPE_WIDTH, Compositor.SCOPE_HEIGHT));
    ({ fbo: this.lumaFbo, tex: this.lumaTex } = this.target(gl.R8, width, height));
    ({ fbo: this.chromaFbo, tex: this.chromaTex } = this.target(gl.RG8, width >> 1, height >> 1));
  }

  private imageTexture(key: string): WebGLTexture {
    const gl = this.gl;
    let tex = this.images.get(key);
    if (!tex) {
      tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.images.set(key, tex);
    }
    return tex;
  }

  /** premultiply keeps soft edges clean when the texture is filtered, for sources with transparency. */
  uploadElement(key: string, source: TexImageSource, premultiply = false): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture(key));
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  uploadPixels(key: string, rgba: Uint8Array, width: number, height: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture(key));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  /** One frame of tightly packed planar YUV 4:2:0, the format the export decoders deliver. */
  uploadYuv420(key: string, data: Uint8Array, width: number, height: number): void {
    const gl = this.gl;
    const cw = width >> 1;
    const ch = height >> 1;
    const planes: [string, number, number, number][] = [
      [key, width, height, 0],
      [`${key}/u`, cw, ch, width * height],
      [`${key}/v`, cw, ch, width * height + cw * ch],
    ];
    gl.activeTexture(gl.TEXTURE0);
    for (const [name, w, h, offset] of planes) {
      gl.bindTexture(gl.TEXTURE_2D, this.imageTexture(name));
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data, offset);
    }
  }

  hasImage(key: string): boolean {
    return this.images.has(key);
  }

  releaseImage(key: string): void {
    for (const name of [key, `${key}/u`, `${key}/v`]) {
      const tex = this.images.get(name);
      if (tex) this.gl.deleteTexture(tex);
      this.images.delete(name);
    }
  }

  /** Clears the frame to black and starts a new composite. */
  begin(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.layerProgram);
  }

  private u(name: string): WebGLUniformLocation | null {
    let location = this.uniforms.get(name);
    if (location === undefined) {
      location = this.gl.getUniformLocation(this.layerProgram, name);
      this.uniforms.set(name, location);
    }
    return location;
  }

  /** Contain-fit in the project frame, then the clip's own transform. Column major 3x3 in NDC. */
  private matrix(sourceW: number, sourceH: number, d: DrawParams): Float32Array {
    const fit = Math.min(this.width / sourceW, this.height / sourceH);
    const halfW = (sourceW * fit * d.scale) / 2;
    const halfH = (sourceH * fit * d.scale) / 2;
    const a = (d.rotation * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const sx = 2 / this.width;
    const sy = 2 / this.height;
    return new Float32Array([
      halfW * cos * sx, halfW * sin * sy, 0,
      -halfH * sin * sx, halfH * cos * sy, 0,
      d.x * 2, -d.y * 2, 1,
    ]);
  }

  /** yuvMatrix names the source's colour matrix when the image was uploaded with uploadYuv420. */
  drawImage(key: string, sourceW: number, sourceH: number, d: DrawParams, yuvMatrix?: string): void {
    const gl = this.gl;
    const tex = this.images.get(key);
    if (!tex || d.opacity <= 0) return;

    gl.useProgram(this.layerProgram);
    gl.uniform1i(this.u('uIsYuv'), yuvMatrix ? 1 : 0);
    gl.uniform1i(this.u('uPremultiplied'), d.premultiplied ? 1 : 0);
    if (yuvMatrix) {
      gl.uniformMatrix3fv(this.u('uYuvToRgb'), false, YUV_MATRICES[yuvMatrix] ?? YUV_MATRICES.bt709);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.images.get(`${key}/u`)!);
      gl.uniform1i(this.u('uPlaneU'), 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.images.get(`${key}/v`)!);
      gl.uniform1i(this.u('uPlaneV'), 3);
    }
    gl.uniformMatrix3fv(this.u('uMatrix'), false, this.matrix(sourceW, sourceH, d));
    gl.uniform1f(this.u('uOpacity'), d.opacity);

    const nodes = d.grade && !d.grade.bypass ? d.grade.nodes.slice(0, MAX_GRADE_NODES) : [];
    gl.uniform1i(this.u('uNodeCount'), nodes.length);
    if (nodes.length > 0) {
      const u = nodes.map(nodeUniforms);
      const v3 = (name: string, pick: (n: (typeof u)[number]) => number[]) =>
        gl.uniform3fv(this.u(`${name}[0]`), u.flatMap(pick));
      const v4 = (name: string, pick: (n: (typeof u)[number]) => number[]) =>
        gl.uniform4fv(this.u(`${name}[0]`), u.flatMap(pick));
      v3('uLift', (n) => n.lift);
      v3('uGamma', (n) => n.gamma);
      v3('uGain', (n) => n.gain);
      v3('uOffset', (n) => n.offset);
      v4('uTone', (n) => n.tone);
      v4('uBalance', (n) => n.balance);
      v4('uQualA', (n) => n.qualifierA);
      v4('uQualB', (n) => n.qualifierB);
      v4('uWinA', (n) => n.windowA);
      v4('uWinB', (n) => n.windowB);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.curves);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CURVE_SIZE, MAX_GRADE_NODES, gl.RGBA, gl.FLOAT, buildCurveTexture(nodes));
      gl.uniform1i(this.u('uCurves'), 1);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.u('uImage'), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private blit(flip: boolean): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.useProgram(this.presentProgram);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.presentProgram, 'uMatrix'), false, new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]));
    gl.uniform1f(gl.getUniformLocation(this.presentProgram, 'uFlip'), flip ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(this.presentProgram, 'uImage'), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Shows the composite on the canvas. */
  present(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    this.blit(false);
  }

  /** The composite as top-down RGBA8, for the encoder. */
  readPixels(into: Uint8Array): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.readFbo);
    gl.viewport(0, 0, this.width, this.height);
    this.blit(true);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, into);
  }

  /** The composite as top-down BT.709 NV12: full size luma followed by half size interleaved chroma. */
  readNv12(into: Uint8Array): void {
    const gl = this.gl;
    const cw = this.width >> 1;
    const ch = this.height >> 1;
    gl.disable(gl.BLEND);
    gl.useProgram(this.nv12Program);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.nv12Program, 'uMatrix'), false, new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]));
    gl.uniform1i(gl.getUniformLocation(this.nv12Program, 'uImage'), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTex);

    const chroma = gl.getUniformLocation(this.nv12Program, 'uChroma');
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lumaFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.uniform1i(chroma, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RED, gl.UNSIGNED_BYTE, into, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.chromaFbo);
    gl.viewport(0, 0, cw, ch);
    gl.uniform1i(chroma, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, cw, ch, gl.RG, gl.UNSIGNED_BYTE, into, this.width * this.height);
  }

  /** A small top-down copy for the scopes. */
  readScope(into: Uint8Array): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scopeFbo);
    gl.viewport(0, 0, Compositor.SCOPE_WIDTH, Compositor.SCOPE_HEIGHT);
    this.blit(true);
    gl.readPixels(0, 0, Compositor.SCOPE_WIDTH, Compositor.SCOPE_HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, into);
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
