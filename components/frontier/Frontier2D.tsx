"use client";

import { useEffect, useRef, useState } from "react";
import type { Cloud } from "@/lib/cloud";
import { num, pct } from "@/lib/format";
import { linear, parseHex, ramp, ticks } from "@/lib/scale";
import { readTokens, useTheme, useWidth } from "../hooks";

const TOKENS = [
  "seq-lo",
  "seq-mid",
  "seq-hi",
  "fg",
  "muted",
  "axis",
  "grid",
  "series-2",
  "success",
  "surface",
] as const;
const MARGIN = { left: 44, right: 14, top: 10, bottom: 30 };
const HEIGHT = 340;

const css = (rgb: number[]) => `rgb(${rgb.map((c) => Math.round(c)).join(",")})`;

/**
 * The same cloud flattened to risk against return, drawn on a 2D canvas. It is the
 * fallback when WebGL is unavailable, and a choice for anyone who prefers a flat chart.
 */
export default function Frontier2D({ cloud }: { cloud: Cloud }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = useWidth(wrap, 480);
  const theme = useTheme();
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const screen = useRef<Float32Array>(new Float32Array(0));

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * ratio;
    canvas.height = HEIGHT * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, HEIGHT);

    const tokens = readTokens(TOKENS);
    const stops = [tokens["seq-lo"], tokens["seq-mid"], tokens["seq-hi"]].map(parseHex);
    const x = linear(
      [cloud.volatility.min, cloud.volatility.max],
      [MARGIN.left + 8, width - MARGIN.right - 8],
    );
    const y = linear(
      [cloud.annualReturn.min, cloud.annualReturn.max],
      [HEIGHT - MARGIN.bottom - 8, MARGIN.top + 8],
    );

    context.font = "10px ui-monospace, monospace";
    context.lineWidth = 1;
    context.fillStyle = tokens.muted;
    context.strokeStyle = tokens.grid;
    context.textAlign = "right";
    for (const value of ticks(cloud.annualReturn.min, cloud.annualReturn.max, 4)) {
      const py = Math.round(y(value)) + 0.5;
      context.beginPath();
      context.moveTo(MARGIN.left, py);
      context.lineTo(width - MARGIN.right, py);
      context.stroke();
      context.fillText(pct(value, 0), MARGIN.left - 6, py + 3);
    }
    context.textAlign = "center";
    for (const value of ticks(cloud.volatility.min, cloud.volatility.max, 5)) {
      context.fillText(pct(value, 0), x(value), HEIGHT - MARGIN.bottom + 14);
    }
    context.fillText("volatility →", width - MARGIN.right - 34, HEIGHT - 4);
    context.textAlign = "left";
    context.fillText("↑ annual return", MARGIN.left + 4, MARGIN.top + 8);

    const points = new Float32Array(cloud.size * 2);
    const simulated = cloud.size - cloud.highlights.length;
    for (let i = 0; i < cloud.size; i++) {
      const [volatility, annualReturn] = cloud.raw(i);
      points[i * 2] = x(volatility);
      points[i * 2 + 1] = y(annualReturn);
    }
    screen.current = points;
    for (let i = 0; i < simulated; i++) {
      context.fillStyle = css(ramp(stops, cloud.shade[i]));
      context.beginPath();
      context.arc(points[i * 2], points[i * 2 + 1], 1.7, 0, Math.PI * 2);
      context.fill();
    }
    const fills: Record<string, string> = {
      current: tokens["seq-hi"],
      maxSharpe: tokens.success,
      minVolatility: tokens["series-2"],
    };
    for (const highlight of cloud.highlights) {
      const px = points[highlight.index * 2];
      const py = points[highlight.index * 2 + 1];
      context.beginPath();
      context.arc(px, py, 6.5, 0, Math.PI * 2);
      context.fillStyle = tokens.fg;
      context.fill();
      context.beginPath();
      context.arc(px, py, 4, 0, Math.PI * 2);
      context.fillStyle = fills[highlight.key];
      context.fill();
      const onRight = px < width - 130;
      context.textAlign = onRight ? "left" : "right";
      const labelX = px + (onRight ? 11 : -11);
      const textWidth = context.measureText(highlight.label).width;
      context.fillStyle = tokens.surface;
      context.globalAlpha = 0.85;
      context.fillRect(onRight ? labelX - 2 : labelX - textWidth - 2, py - 8, textWidth + 4, 13);
      context.globalAlpha = 1;
      context.fillStyle = tokens.fg;
      context.fillText(highlight.label, labelX, py + 3);
    }
    canvas.dataset.ready = "true";
  }, [cloud, width, theme]);

  function pick(event: React.PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - bounds.left;
    const py = event.clientY - bounds.top;
    const points = screen.current;
    let best = -1;
    let bestDistance = 14 * 14;
    for (let i = 0; i < points.length / 2; i++) {
      const dx = points[i * 2] - px;
      const dy = points[i * 2 + 1] - py;
      const d = dx * dx + dy * dy - (i >= cloud.size - cloud.highlights.length ? 60 : 0);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    setHover(best < 0 ? null : { index: best, x: px, y: py });
  }

  const hovered = hover ? cloud.raw(hover.index) : null;
  const hoveredName = hover
    ? (cloud.highlights.find((h) => h.index === hover.index)?.label ?? "Simulated mix")
    : "";

  return (
    <div ref={wrap} className="relative w-full" style={{ height: HEIGHT }}>
      <canvas
        ref={canvasRef}
        data-frontier="2d"
        role="img"
        aria-label="Scatter of simulated portfolios by volatility and annual return, colored by Sharpe ratio. The table below lists the highlighted portfolios."
        style={{ width, height: HEIGHT }}
        className="block max-w-full touch-pan-y"
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setHover(null)}
      />
      {hover && hovered && (
        <div
          role="status"
          className="pointer-events-none absolute z-10 w-40 border border-border bg-raised p-2 font-mono text-[11px] shadow-lg"
          style={{
            left: Math.max(4, Math.min(hover.x + 14, width - 168)),
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
