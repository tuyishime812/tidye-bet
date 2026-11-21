import React from "react";
import { useNavigate } from "react-router-dom";
import Context from "../../context";
import "./gameSelection.scss";

/**
 * Home / landing page.
 * Design provided by product: hero + Aviator preview + responsible play CTA.
 * Auth is enforced when entering Aviator (server-side).
 */
export default function GameSelection() {
  const navigate = useNavigate();
  const { isAuthenticated, authModalOpen, openAuthModal } =
    React.useContext(Context) as any;

  const [pendingRoute, setPendingRoute] = React.useState<string | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const mvRef = React.useRef<HTMLSpanElement | null>(null);
  const stRef = React.useRef<HTMLSpanElement | null>(null);
  const multRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (isAuthenticated && pendingRoute) {
      setPendingRoute(null);
      navigate(pendingRoute);
    }
  }, [isAuthenticated, pendingRoute, navigate]);

  React.useEffect(() => {
    if (!authModalOpen && !isAuthenticated) {
      setPendingRoute(null);
    }
  }, [authModalOpen, isAuthenticated]);

  const enterAviator = () => {
    if (isAuthenticated) {
      navigate("/aviator");
      return;
    }
    setPendingRoute("/aviator");
    openAuthModal("Log in or create an account to play Aviator.");
  };

  const openLogin = () => openAuthModal("Log in to your account.", "login");
  const openRegister = () =>
    openAuthModal("Create an account to start playing.", "register");

  React.useEffect(() => {
    const cv = canvasRef.current;
    const mv = mvRef.current;
    const st = stRef.current;
    const mb = multRef.current;
    if (!cv || !mv || !st || !mb) return;

    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const c = ctx;

    let W = 0;
    let H = 0;
    let dpr = 1;
    let raf = 0;
    let t = 0;
    let crash = 0;
    let wait = 0;
    let last = performance.now();
    let stopped = false;

    const size = () => {
      dpr = window.devicePixelRatio || 1;
      W = cv.clientWidth;
      H = cv.clientHeight;
      cv.width = Math.max(1, Math.floor(W * dpr));
      cv.height = Math.max(1, Math.floor(H * dpr));
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const V = (tt: number) => Math.exp(0.26 * tt);

    const newRound = () => {
      t = 0;
      crash = 1.4 + Math.random() * Math.random() * 14;
      mb.classList.remove("crash");
      st.textContent = "Round in progress";
    };

    const draw = (maxT: number, vmax: number, tt: number) => {
      c.clearRect(0, 0, W, H);
      const px = 40;
      const py = 34;
      const iw = W - px - 30;
      const ih = H - py - 40;
      c.strokeStyle = "rgba(255,255,255,.07)";
      c.lineWidth = 1;
      c.fillStyle = "rgba(157,176,218,.7)";
      c.font = "12px Barlow,sans-serif";
      for (let i = 0; i <= 4; i++) {
        const y = H - py - (ih * i) / 4;
        c.beginPath();
        c.moveTo(px, y);
        c.lineTo(W - 14, y);
        c.stroke();
        c.fillText((1 + ((vmax - 1) * i) / 4).toFixed(1) + "x", 6, y + 4);
      }
      const pts: Array<[number, number]> = [];
      const step = tt / 60 || 1;
      for (let s = 0; s <= tt; s += step) {
        const x = px + (s / maxT) * iw;
        const y2 = H - py - ((V(s) - 1) / (vmax - 1)) * ih;
        pts.push([x, y2]);
      }
      const e = pts[pts.length - 1] || [px, H - py];
      c.beginPath();
      c.moveTo(px, H - py);
      pts.forEach((p) => c.lineTo(p[0], p[1]));
      c.lineTo(e[0], H - py);
      c.closePath();
      c.fillStyle = "rgba(229,56,59,.22)";
      c.fill();
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
      c.strokeStyle = "#e5383b";
      c.lineWidth = 4;
      c.lineJoin = "round";
      c.stroke();
      return e;
    };

    const plane = (x: number, y: number, a: number) => {
      c.save();
      c.translate(x, y);
      c.rotate(a);
      c.fillStyle = "#e5383b";
      c.beginPath();
      c.moveTo(-26, -6);
      c.quadraticCurveTo(-4, -14, 24, -2);
      c.lineTo(26, 2);
      c.quadraticCurveTo(0, 10, -26, 6);
      c.closePath();
      c.fill();
      c.fillStyle = "#b82629";
      c.beginPath();
      c.moveTo(-6, 2);
      c.lineTo(-16, 16);
      c.lineTo(2, 12);
      c.closePath();
      c.fill();
      c.beginPath();
      c.moveTo(-24, -4);
      c.lineTo(-30, -16);
      c.lineTo(-18, -6);
      c.closePath();
      c.fill();
      c.fillStyle = "#fff";
      c.fillRect(6, -6, 10, 3);
      c.restore();
    };

    const frame = (now: number) => {
      if (stopped) return;
      const dt = (now - last) / 1000;
      last = now;
      if (wait > 0) {
        wait -= dt;
        if (wait <= 0) newRound();
        raf = requestAnimationFrame(frame);
        return;
      }
      t += dt;
      let v = V(t);
      if (v >= crash) {
        v = crash;
        mv.textContent = v.toFixed(2) + "x";
        mb.classList.add("crash");
        st.textContent = "Flew away";
        wait = 2.6;
        raf = requestAnimationFrame(frame);
        return;
      }
      const maxT = Math.max(t, 6);
      const vmax = Math.max(v, 3);
      const e = draw(maxT, vmax, t);
      plane(e[0], e[1], -0.35);
      mv.textContent = v.toFixed(2) + "x";
      raf = requestAnimationFrame(frame);
    };

    size();
    window.addEventListener("resize", size);
    newRound();

    const reduceMotion = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    if (reduceMotion) {
      draw(6, 3, 5);
      mv.textContent = "3.21x";
    } else {
      raf = requestAnimationFrame(frame);
    }

    return () => {
      stopped = true;
      window.removeEventListener("resize", size);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="tidye-home">
      <header className="th-header">
        <div className="th-wrap">
          <nav className="th-nav" aria-label="Main navigation">
            <a className="th-logo" href="/" aria-label="Tidye Bet home">
              <svg viewBox="0 0 24 24" fill="#ffc21a" aria-hidden="true">
                <path d="M2 14l20-9-7 16-3.5-6.5z" />
              </svg>
              Tidye<em>Bet</em>
            </a>
            <div className="th-links">
              <a href="#safe">Responsible play</a>
            </div>
            <button type="button" className="th-btn th-ghost" onClick={openLogin}>
              Log in
            </button>
            <button type="button" className="th-btn th-gold" onClick={openRegister}>
              Register
            </button>
          </nav>
        </div>
      </header>

      <main className="th-wrap">
        <div className="th-hero">
          <div>
            <h1 className="th-h1">
              Aviator.
              <br />
              Cash out in time.
            </h1>
            <p className="th-lead">
              Place your bet before take-off. The multiplier climbs until the
              plane flies away, so cash out first.
            </p>
            <div className="th-cta">
              <button type="button" className="th-btn th-gold th-lg" onClick={enterAviator}>
                Play now
              </button>
            </div>
          </div>

          <div className="th-stage" aria-label="Aviator game preview">
            <div className="th-sky">
              <div className="th-rays" />
              <canvas ref={canvasRef} className="th-canvas" />
              <div className="th-mult" ref={multRef}>
                <div>
                  <span ref={mvRef}>1.00x</span>
                  <small ref={stRef}>Round in progress</small>
                </div>
              </div>
            </div>
          </div>
        </div>

        <section id="safe" className="th-section">
          <div className="th-join">
            <div>
              <h2 className="th-h2">Ready for the next round?</h2>
              <p>Register in a minute and take a seat.</p>
            </div>
            <button type="button" className="th-btn th-gold th-lg" onClick={openRegister}>
              Register
            </button>
          </div>
        </section>
      </main>

      <footer className="th-footer">
        <div className="th-wrap th-footer-row">
          <div>
            <span className="th-age">18+</span>Gambling can be addictive. Only bet
            what you can afford to lose.
          </div>
          <div>© 2026 Tidye Bet</div>
        </div>
      </footer>
    </div>
  );
}
