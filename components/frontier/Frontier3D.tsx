"use client";

import { useEffect, useRef, useState } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  LineSegments,
  Matrix4,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Cloud } from "@/lib/cloud";
import { num, pct } from "@/lib/format";
import { parseHex, ramp, type Rgb } from "@/lib/scale";
import { readTokens, useReducedMotion, useTheme } from "../hooks";

const TOKENS = [
  "seq-lo",
  "seq-mid",
  "seq-hi",
  "fg",
  "axis",
  "grid",
  "series-2",
  "success",
] as const;
const DISTANCE = 6.4;
/** The box is wider than it is tall or deep, to suit a wide panel. */
const WIDE = 1.45;
const POINT_PX = 3;
const HIGHLIGHT_PX = 13;

const POINT_VERTEX = `
attribute vec3 aColor;
attribute float aSize;
attribute float aKind;
uniform float uPixelRatio;
uniform float uDistance;
varying vec3 vColor;
varying float vKind;
void main() {
  vColor = aColor;
  vKind = aKind;
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * view;
  gl_PointSize = aSize * uPixelRatio * uDistance / -view.z;
}`;

// Round points. A highlighted mix gets a ring in the foreground color so it reads
// against the cloud it sits in.
const POINT_FRAGMENT = `
uniform vec3 uRing;
varying vec3 vColor;
varying float vKind;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  vec3 color = (vKind > 0.5 && d > 0.3) ? uRing : vColor;
  gl_FragColor = vec4(color, 1.0);
}`;

const LINE_VERTEX = `
attribute vec3 aColor;
varying vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const LINE_FRAGMENT = `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

const unit = (hex: string): Rgb => parseHex(hex).map((c) => c / 255) as Rgb;

interface Label {
  key: string;
  text: string;
  at: Vector3;
  strong?: boolean;
  align: "left" | "right" | "center";
}

function axisLabels(cloud: Cloud): Label[] {
  const { volatility, annualReturn, maxDrawdown } = cloud;
  const tick = (key: string, text: string, at: [number, number, number], align: Label["align"]) =>
    ({ key, text, at: new Vector3(at[0] * WIDE, at[1], at[2]), align }) satisfies Label;
  return [
    // volatility runs along the front edge of the floor
    tick("x0", pct(volatility.min, 0), [-1, -1.15, 1], "center"),
    tick("x", "volatility \u2192", [0, -1.17, 1], "center"),
    tick("x1", pct(volatility.max, 0), [0.97, -1.15, 1], "right"),
    // annual return runs up the front-left edge
    tick("y0", pct(annualReturn.min, 0), [-1.04, -0.97, 1], "right"),
    tick("y", "return \u2191", [-1.04, 0, 1], "right"),
    tick("y1", pct(annualReturn.max, 0), [-1.04, 1, 1], "right"),
    // worst fall runs back along the right edge of the floor: deeper falls are further away
    tick("z0", pct(maxDrawdown.max, 0), [1.04, -1.02, 1], "left"),
    tick("z", "worst fall", [1.04, -1.02, 0], "left"),
    tick("z1", pct(maxDrawdown.min, 0), [1.04, -1.02, -1], "left"),
  ];
}

/** Box edges, a floor grid, and a drop line from each highlighted mix to the floor. */
function buildLines(cloud: Cloud, axis: Rgb, grid: Rgb, drop: Rgb) {
  const positions: number[] = [];
  const colors: number[] = [];
  const add = (a: number[], b: number[], color: Rgb) => {
    positions.push(...a, ...b);
    colors.push(...color, ...color);
  };
  for (let step = -1; step <= 1; step += 0.5) {
    add([step, -1, -1], [step, -1, 1], grid);
    add([-1, -1, step], [1, -1, step], grid);
    add([-1, step, -1], [1, step, -1], grid);
    add([step, -1, -1], [step, 1, -1], grid);
  }
  add([-1, -1, 1], [1, -1, 1], axis); // volatility
  add([-1, -1, 1], [-1, 1, 1], axis); // annual return
  add([1, -1, -1], [1, -1, 1], axis); // worst fall
  for (const highlight of cloud.highlights) {
    const i = highlight.index * 3;
    const [x, y, z] = [cloud.positions[i], cloud.positions[i + 1], cloud.positions[i + 2]];
    add([x, y, z], [x, -1, z], drop);
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors) };
}

export default function Frontier3D({
  cloud,
  spin,
  onUnavailable,
}: {
  cloud: Cloud;
  spin: boolean;
  onUnavailable: () => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const [hover, setHover] = useState<{ index: number; x: number; y: number; width: number } | null>(
    null,
  );
  // Mutable view state the render loop reads; changing it must not re-create the scene.
  const view = useRef({
    // Start face-on to the cloud: it is a thin sheet running from low risk and shallow
    // falls (front left) to high risk and deep falls (back right).
    azimuth: 0.72,
    elevation: 0.26,
    dirty: true,
    dragging: false,
    hovering: false,
  });
  const spinning = useRef(false);
  useEffect(() => {
    spinning.current = spin && !reducedMotion;
    view.current.dirty = true;
  }, [spin, reducedMotion]);

  const labels = useRef<Label[]>([]);

  useEffect(() => {
    const host = mount.current;
    const layer = overlay.current;
    if (!host || !layer) return;

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      onUnavailable();
      return;
    }
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(ratio);
    renderer.setClearColor(0x000000, 0);
    const canvas = renderer.domElement;
    canvas.className = "block h-full w-full";
    canvas.setAttribute("aria-hidden", "true");
    host.appendChild(canvas);

    const tokens = readTokens(TOKENS);
    const stops = [unit(tokens["seq-lo"]), unit(tokens["seq-mid"]), unit(tokens["seq-hi"])];
    const fg = unit(tokens.fg);
    const kinds: Record<string, Rgb> = {
      current: unit(tokens["seq-hi"]),
      maxSharpe: unit(tokens.success),
      minVolatility: unit(tokens["series-2"]),
    };

    const colors = new Float32Array(cloud.size * 3);
    const sizes = new Float32Array(cloud.size).fill(POINT_PX);
    const kind = new Float32Array(cloud.size);
    for (let i = 0; i < cloud.size; i++) colors.set(ramp(stops, cloud.shade[i]), i * 3);
    for (const highlight of cloud.highlights) {
      colors.set(kinds[highlight.key], highlight.index * 3);
      sizes[highlight.index] = HIGHLIGHT_PX;
      kind[highlight.index] = 1;
    }

    // The whole cloud, highlights included, is one draw call.
    const pointGeometry = new BufferGeometry();
    pointGeometry.setAttribute("position", new BufferAttribute(cloud.positions, 3));
    pointGeometry.setAttribute("aColor", new BufferAttribute(colors, 3));
    pointGeometry.setAttribute("aSize", new BufferAttribute(sizes, 1));
    pointGeometry.setAttribute("aKind", new BufferAttribute(kind, 1));
    const pointMaterial = new ShaderMaterial({
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      uniforms: {
        uPixelRatio: { value: ratio },
        uDistance: { value: DISTANCE },
        uRing: { value: new Vector3(...fg) },
      },
    });
    const points = new Points(pointGeometry, pointMaterial);
    points.frustumCulled = false;

    const lines = buildLines(cloud, unit(tokens.axis), unit(tokens.grid), fg);
    const lineGeometry = new BufferGeometry();
    lineGeometry.setAttribute("position", new BufferAttribute(lines.positions, 3));
    lineGeometry.setAttribute("aColor", new BufferAttribute(lines.colors, 3));
    const lineMaterial = new ShaderMaterial({
      vertexShader: LINE_VERTEX,
      fragmentShader: LINE_FRAGMENT,
    });
    const frame = new LineSegments(lineGeometry, lineMaterial);
    frame.frustumCulled = false;

    points.scale.set(WIDE, 1, 1);
    frame.scale.set(WIDE, 1, 1);
    const scene = new Scene();
    scene.add(frame, points);
    const camera = new PerspectiveCamera(34, 1, 0.1, 50);

    labels.current = [
      ...axisLabels(cloud),
      ...cloud.highlights.map((highlight): Label => {
        const i = highlight.index * 3;
        return {
          key: highlight.key,
          text: highlight.label,
          at: new Vector3(
            cloud.positions[i] * WIDE,
            cloud.positions[i + 1],
            cloud.positions[i + 2],
          ),
          strong: true,
          align: "left",
        };
      }),
    ];
    layer.replaceChildren(
      ...labels.current.map((label) => {
        const element = document.createElement("span");
        element.textContent = label.text;
        element.className = `absolute left-0 top-0 whitespace-nowrap font-mono text-[10px] leading-none ${
          label.strong ? "bg-surface/85 px-1 py-0.5 text-fg" : "text-muted"
        }`;
        return element;
      }),
    );

    let width = 1;
    let height = 1;
    const projected = new Vector3();
    const matrix = new Matrix4();

    function draw() {
      const state = view.current;
      camera.position.set(
        DISTANCE * Math.cos(state.elevation) * Math.sin(state.azimuth),
        DISTANCE * Math.sin(state.elevation),
        DISTANCE * Math.cos(state.elevation) * Math.cos(state.azimuth),
      );
      camera.lookAt(0, -0.28, 0);
      camera.updateMatrixWorld();
      renderer.render(scene, camera);
      labels.current.forEach((label, i) => {
        const element = layer!.children[i] as HTMLElement;
        projected.copy(label.at).project(camera);
        const x = (projected.x * 0.5 + 0.5) * width;
        const y = (-projected.y * 0.5 + 0.5) * height;
        const shift = label.align === "right" ? "-100%" : label.align === "center" ? "-50%" : "0";
        const nudge = label.strong ? 10 : 0;
        element.style.transform = `translate(${(x + nudge).toFixed(1)}px, ${(y - 5).toFixed(1)}px) translateX(${shift})`;
      });
    }

    let raf = 0;
    let visible = true;
    function loop() {
      const state = view.current;
      if (spinning.current && visible && !state.dragging && !state.hovering) {
        state.azimuth += 0.0022;
        state.dirty = true;
      }
      if (state.dirty) {
        state.dirty = false;
        draw();
      }
      raf = requestAnimationFrame(loop);
    }

    const resize = new ResizeObserver(([entry]) => {
      width = Math.max(1, entry.contentRect.width);
      height = Math.max(1, entry.contentRect.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      // A narrow panel needs the camera further back to keep the box in frame.
      camera.fov = width / height < 1.1 ? 44 : 34;
      camera.updateProjectionMatrix();
      view.current.dirty = true;
    });
    resize.observe(host);
    const watcher = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    watcher.observe(host);

    /** Nearest point to the pointer in screen space, within a few pixels. */
    function pick(clientX: number, clientY: number) {
      const bounds = canvas.getBoundingClientRect();
      const px = clientX - bounds.left;
      const py = clientY - bounds.top;
      matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      const e = matrix.elements;
      let best = -1;
      let bestDistance = 14 * 14;
      for (let i = 0; i < cloud.size; i++) {
        const x = cloud.positions[i * 3] * WIDE;
        const y = cloud.positions[i * 3 + 1];
        const z = cloud.positions[i * 3 + 2];
        const w = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (w <= 0) continue;
        const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * 0.5 + 0.5;
        const sy = 0.5 - ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5;
        const dx = sx * width - px;
        const dy = sy * height - py;
        // Highlights win ties: they are what a reader is most likely aiming at.
        const d = dx * dx + dy * dy - (i >= cloud.size - cloud.highlights.length ? 60 : 0);
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
      setHover(best < 0 ? null : { index: best, x: px, y: py, width });
    }

    let lastX = 0;
    let lastY = 0;
    const down = (event: PointerEvent) => {
      view.current.dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      setHover(null);
    };
    const move = (event: PointerEvent) => {
      const state = view.current;
      if (state.dragging) {
        state.azimuth -= (event.clientX - lastX) * 0.008;
        state.elevation = Math.min(
          1.2,
          Math.max(-0.15, state.elevation + (event.clientY - lastY) * 0.006),
        );
        lastX = event.clientX;
        lastY = event.clientY;
        state.dirty = true;
      } else if (event.pointerType === "mouse") {
        state.hovering = true;
        pick(event.clientX, event.clientY);
      }
    };
    const up = (event: PointerEvent) => {
      view.current.dragging = false;
      if (event.pointerType !== "mouse") pick(event.clientX, event.clientY);
    };
    const leave = () => {
      view.current.hovering = false;
      view.current.dragging = false;
      setHover(null);
    };
    const lost = (event: Event) => {
      event.preventDefault();
      onUnavailable();
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", leave);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("webglcontextlost", lost);

    view.current.dirty = true;
    raf = requestAnimationFrame(loop);
    host.dataset.ready = "true";

    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      watcher.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", leave);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("webglcontextlost", lost);
      pointGeometry.dispose();
      pointMaterial.dispose();
      lineGeometry.dispose();
      lineMaterial.dispose();
      renderer.dispose();
      canvas.remove();
      delete host.dataset.ready;
    };
    // Colors come from theme tokens, so the scene is rebuilt when the theme flips.
  }, [cloud, theme, onUnavailable]);

  function onKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const state = view.current;
    if (event.key === "ArrowLeft") state.azimuth -= 0.12;
    else if (event.key === "ArrowRight") state.azimuth += 0.12;
    else if (event.key === "ArrowUp") state.elevation = Math.min(1.2, state.elevation + 0.08);
    else if (event.key === "ArrowDown") state.elevation = Math.max(-0.15, state.elevation - 0.08);
    else return;
    event.preventDefault();
    state.dirty = true;
  }

  const hovered = hover ? cloud.raw(hover.index) : null;
  const hoveredName = hover
    ? (cloud.highlights.find((h) => h.index === hover.index)?.label ?? "Simulated mix")
    : "";

  return (
    <div
      tabIndex={0}
      role="group"
      aria-label="3D scatter of simulated portfolios: volatility, annual return, and worst fall, colored by Sharpe ratio. Drag or use the arrow keys to rotate. The table below lists the highlighted portfolios."
      onKeyDown={onKey}
      className="relative min-h-[340px] w-full flex-1 cursor-grab touch-pan-y overflow-hidden active:cursor-grabbing sm:min-h-[400px]"
    >
      <div ref={mount} data-frontier="3d" className="absolute inset-0" />
      <div
        ref={overlay}
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      />
      {hover && hovered && (
        <div
          role="status"
          className="pointer-events-none absolute z-10 w-40 border border-border bg-raised p-2 font-mono text-[11px] shadow-lg"
          style={{
            left: Math.max(4, Math.min(hover.x + 14, hover.width - 168)),
            top: Math.max(4, hover.y - 86),
          }}
        >
          <p className="mb-1 text-muted">{hoveredName}</p>
          <p className="flex justify-between gap-2">
            <span className="text-muted">Volatility</span>
            <span className="text-fg">{pct(hovered[0])}</span>
          </p>
          <p className="flex justify-between gap-2">
            <span className="text-muted">Return</span>
            <span className="text-fg">{pct(hovered[1])}</span>
          </p>
          <p className="flex justify-between gap-2">
            <span className="text-muted">Sharpe</span>
            <span className="text-fg">{num(hovered[2])}</span>
          </p>
          <p className="flex justify-between gap-2">
            <span className="text-muted">Worst fall</span>
            <span className="text-fg">{pct(hovered[3])}</span>
          </p>
        </div>
      )}
    </div>
  );
}
