import React from "react";
import { Routes, Route, Navigate, Link, useLocation } from "react-router-dom";
import Header from "./components/header";
import BetsUsers from "./components/bet-users";
import Main from "./components/Main";
import GameSelection from "./components/GameSelection";
import PerfectLiveChat from "./components/Chat";
import AuthGate from "./components/Auth/AuthGate";
import Wallet from "./components/Wallet";
import Profile from "./components/Profile";
import Admin from "./components/Admin";
import propeller from "./assets/images/propeller.png";

import Context from "./context";

/**
 * Route guard for the Aviator game.
 *
 * The crash game must not be reachable by a guest - whether they arrive from
 * the lobby panel, the navbar link, or by typing the URL directly. While the
 * stored session is still being restored we render a neutral placeholder so a
 * logged-in player reloading the page is never briefly shown the login prompt
 * (which would otherwise flash and could be dismissed by accident).
 */
function RequireAviatorAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, authReady, openAuthModal } =
    React.useContext(Context) as any;

  React.useEffect(() => {
    if (authReady && !isAuthenticated) {
      openAuthModal("Log in or create an account to play Aviator.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, isAuthenticated]);

  if (!authReady) {
    return (
      <div className="aviator-gate">
        <div className="aviator-gate__card">
          <p className="aviator-gate__muted">Loading…</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="aviator-gate">
        <div className="aviator-gate__card">
          <h2>Login required</h2>
          <p>
            Log in or create an account with your phone number and password to
            play Aviator.
          </p>
          <button
            className="aviator-gate__btn"
            onClick={() =>
              openAuthModal("Log in or create an account to play Aviator.")
            }
          >
            Log in / Sign up
          </button>
          <Link className="aviator-gate__link" to="/">
            Back to games
          </Link>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * Landing page after a hosted checkout redirect. App opens the wallet and the
 * Wallet component verifies the tx_ref against the server (never trusting the
 * query string), then refreshes the balance.
 */
function PaymentReturn() {
  return (
    <div className="aviator-gate">
      <div className="aviator-gate__card">
        <h2>Confirming your payment…</h2>
        <p>
          Your balance updates automatically once the gateway confirms the
          transaction. If you closed the payment window, nothing was charged.
        </p>
        <Link className="aviator-gate__link" to="/">
          Back to games
        </Link>
      </div>
    </div>
  );
}

function App() {
  const {
    unityLoading,
    currentProgress,
    rechargeState,
    msgTab,
    openWallet,
    isAuthenticated,
    authReady,
  } = React.useContext(Context) as any;

  const location = useLocation();
  const isAviator = location.pathname === "/aviator";
  const isAdmin = location.pathname === "/admin";
  const showAviator = isAviator && isAuthenticated && authReady;

  // The Unity WebGL runtime must never be unmounted while its browser main loop
  // is still running. React deletes the canvas before the library's passive
  // effect cleanup calls Quit(), and Emscripten then dereferences the now-null
  // canvas ("Cannot read properties of null (reading 'onwheel')") from inside
  // requestAnimationFrame. Keep the game mounted for the lifetime of the app
  // once it has been opened for the first time, and hide it with CSS when the
  // player leaves /aviator. This also makes returning to the table instant.
  const [aviatorLoaded, setAviatorLoaded] = React.useState(false);
  React.useEffect(() => {
    if (showAviator) setAviatorLoaded(true);
  }, [showAviator]);

  // A gateway return redirect lands here with the transaction reference. Open
  // the wallet so the player immediately sees the verified status.
  React.useEffect(() => {
    if (location.pathname === "/payment/return") openWallet();
  }, [location.pathname, openWallet]);

  // The Unity WASM bundle is only needed for the crash game, so we only show
  // the loader on that route.
  //
  // NOTE: in context.tsx `unityLoading` means "the game has finished loading" —
  // it is false while the bundle downloads and flips to true on the final
  // progress tick / the "Ready" message. The overlay therefore shows while
  // `unityLoading` is still FALSE (the security refactor inverted this).
  //
  // It is also gated on auth: the Unity bundle is only mounted inside the
  // authenticated Aviator route, so a guest sitting on the login gate must not
  // see a loader that can never progress.
  const showUnityLoader = isAviator && isAuthenticated && authReady && !unityLoading;

  return (
    <div className={`main-container${isAdmin ? " main-container--admin" : ""}`}>
  `? wait need to keep exact indentation. Let us be careful.} Actually easier: replace block properly.
      {showUnityLoader && (
        <div className="myloading">
          <div className="loading-container">
            <div className="rotation">
              <img alt="propeller" src={propeller}></img>
            </div>
            <div className="waiting">
              <div style={{ width: `${Math.min(currentProgress * 1.111 + 0.01, 100)}%` }}></div>
            </div>
            <p>{Number(currentProgress * 1.111 + 0.01).toFixed(2)}%</p>
          </div>
        </div>
      )}

      {rechargeState && (
        <div className="recharge">
          <div className="recharge-body">
            <div className="recharge-body-font">Insufficient balance amount</div>
            <div className="recharge-hint">
              Top up your balance to keep playing. Funds land the moment your
              MPamba / Airtel payment is confirmed.
            </div>
            <button
              className="recharge-wallet-btn"
              onClick={() => {
                openWallet();
              }}
            >
              Open wallet
            </button>
          </div>
        </div>
      )}

      {!isAdmin && <Header />}

      <Routes>
        {/* Game lobby - Aviator entry. */}
        <Route path="/" element={<GameSelection />} />

        {/* Back-office: withdrawals queue, player management, manual credits. */}
        <Route path="/admin" element={<Admin />} />

        {/* Hosted-checkout return. The Wallet verifies the tx_ref server-side. */}
        <Route path="/payment/return" element={<PaymentReturn />} />

        {/* Aviator crash game - gated so guests must log in first. The real
            game tree is rendered once, below, and kept mounted; this route only
            renders the login gate when the player is not authenticated. */}
        <Route
          path="/aviator"
          element={
            showAviator ? null : (
              <RequireAviatorAuth>
                <></>
              </RequireAviatorAuth>
            )
          }
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* Persistent Aviator tree: mounted after the first authenticated visit
          and then only hidden, never unmounted (see aviatorLoaded above). */}
      {aviatorLoaded && (
        <div
          className={showAviator ? "game-container" : "game-container game-container--hidden"}
          aria-hidden={!showAviator}
        >
          <BetsUsers />
          <Main />
        </div>
      )}

      {msgTab && (
        <div className="chat-drawer">
          <PerfectLiveChat />
        </div>
      )}

      {/* Login / signup, opened when an unauthenticated user tries to bet. */}
      <AuthGate />

      {/* Wallet (deposits / withdrawals / ledger history). */}
      <Wallet />

      {/* Account profile (identity, balance, avatar, preferences). */}
      <Profile />
    </div>
  );
}

export default App;