import { useEffect, useRef } from "react";

export function BackgroundCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let slips: any[] = [];
    let waves: any[] = [];
    let time = 0;
    let animationFrameId: number;

    function makeSlip() {
      const size = Math.random() * 44 + 26;
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        w: size * (1.8 + Math.random() * 0.7),
        h: size,
        vx: (Math.random() - 0.5) * 0.14,
        vy: -0.06 - Math.random() * 0.12,
        angle: (Math.random() - 0.5) * 0.8,
        spin: (Math.random() - 0.5) * 0.0018,
        alpha: 0.08 + Math.random() * 0.13,
        hue: Math.random() > 0.5 ? "amber" : "green",
      };
    }

    function resizeCanvas() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas!.width = Math.floor(width * ratio);
      canvas!.height = Math.floor(height * ratio);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);

      const slipCount = Math.max(16, Math.floor((width * height) / 52000));
      slips = Array.from({ length: slipCount }, makeSlip);
      waves = Array.from({ length: 6 }, (_, index) => ({
        y: (height / 7) * (index + 1),
        speed: 0.18 + index * 0.035,
        amp: 18 + Math.random() * 22,
        phase: Math.random() * Math.PI * 2,
      }));
    }

    function drawSlip(slip: any) {
      ctx!.save();
      ctx!.translate(slip.x, slip.y);
      ctx!.rotate(slip.angle);

      const tone =
        slip.hue === "amber"
          ? `rgba(238, 184, 83, ${slip.alpha})`
          : `rgba(123, 216, 143, ${slip.alpha})`;

      ctx!.fillStyle = tone;
      ctx!.strokeStyle = `rgba(255, 250, 240, ${slip.alpha * 0.8})`;
      ctx!.lineWidth = 1;
      ctx!.beginPath();
      ctx!.roundRect(-slip.w / 2, -slip.h / 2, slip.w, slip.h, 7);
      ctx!.fill();
      ctx!.stroke();

      ctx!.strokeStyle = `rgba(255, 250, 240, ${slip.alpha * 0.55})`;
      ctx!.beginPath();
      ctx!.moveTo(-slip.w * 0.32, -slip.h * 0.05);
      ctx!.lineTo(slip.w * 0.28, -slip.h * 0.05);
      ctx!.moveTo(-slip.w * 0.32, slip.h * 0.16);
      ctx!.lineTo(slip.w * 0.18, slip.h * 0.16);
      ctx!.stroke();

      ctx!.restore();
    }

    function drawWaves() {
      for (const wave of waves) {
        ctx!.strokeStyle = "rgba(238, 184, 83, 0.055)";
        ctx!.lineWidth = 1;
        ctx!.beginPath();

        for (let x = -40; x <= width + 40; x += 24) {
          const y =
            wave.y +
            Math.sin(x * 0.012 + time * wave.speed + wave.phase) * wave.amp +
            Math.cos(x * 0.005 + time * 0.12) * 8;

          if (x === -40) ctx!.moveTo(x, y);
          else ctx!.lineTo(x, y);
        }

        ctx!.stroke();
      }
    }

    function drawVignette() {
      const glow = ctx!.createRadialGradient(
        width * 0.52,
        height * 0.34,
        0,
        width * 0.52,
        height * 0.34,
        width * 0.65
      );
      glow.addColorStop(0, "rgba(123, 216, 143, 0.08)");
      glow.addColorStop(0.42, "rgba(238, 184, 83, 0.035)");
      glow.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx!.fillStyle = glow;
      ctx!.fillRect(0, 0, width, height);
    }

    function draw() {
      time += 0.012;
      ctx!.clearRect(0, 0, width, height);
      drawVignette();
      drawWaves();

      for (const slip of slips) {
        slip.x += slip.vx + Math.sin(time + slip.y * 0.01) * 0.035;
        slip.y += slip.vy;
        slip.angle += slip.spin;

        if (slip.y < -80) {
          slip.y = height + 80;
          slip.x = Math.random() * width;
        }
        if (slip.x < -120) slip.x = width + 120;
        if (slip.x > width + 120) slip.x = -120;

        drawSlip(slip);
      }

      animationFrameId = requestAnimationFrame(draw);
    }

    resizeCanvas();
    draw();
    window.addEventListener("resize", resizeCanvas);

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return <canvas id="memory-field" ref={canvasRef} aria-hidden="true"></canvas>;
}
