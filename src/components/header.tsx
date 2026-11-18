import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  Plane,
  Menu,
  X,
  MessageCircle,
  Wallet,
  User,
  LogOut,
  ChevronDown,
  CircleHelp,
  Gift,
  Headset,
  Languages,
} from "lucide-react";

import refound from "../assets/images/refund.png";
import "../index.scss";
import "./headerBar.scss";
import Context from "../context";

const ICON_PROPS = { size: 18, strokeWidth: 1.75, "aria-hidden": true, focusable: "false" as const };

export default function Header() {
  const {
    state,
    userInfo,
    msgTab,
    toggleMsgTab,
    isAuthenticated,
    openWallet,
    openProfile,
    openAuthModal,
    logout,
  } = React.useContext(Context) as any;

  const navigate = useNavigate();
  const [howto, setHowto] = React.useState<"howto" | "short" | "more" | "">("howto");
  const [, setFireSystem] = React.useState(false);

  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  React.useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  React.useEffect(() => {
    if (!isAuthenticated) setMenuOpen(false);
  }, [isAuthenticated]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    const onResize = () => {
      if (window.innerWidth >= 768) setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  React.useEffect(() => {
    document.body.style.overflow = drawerOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [drawerOpen]);

  const Refound = async () => {
    return;
  };

  const closeDrawer = () => setDrawerOpen(false);

  const handleLogout = () => {
    setMenuOpen(false);
    closeDrawer();
    logout();
    navigate("/");
  };

  const primaryLinks = (
    <>
      <NavLink to="/aviator" className="nav-link" onClick={closeDrawer}>
        <Plane className="nav-link__icon" {...ICON_PROPS} />
        <span className="nav-link__text">Aviator</span>
      </NavLink>
    </>
  );

  const guestButtons = (
    <div className="auth-buttons">
      <button
        type="button"
        className="btn-login"
        onClick={() => {
          closeDrawer();
          openAuthModal("Log in to your account.", "login");
        }}
      >
        Log in
      </button>
      <button
        type="button"
        className="btn-create"
        onClick={() => {
          closeDrawer();
          openAuthModal("Create an account to start playing.", "register");
        }}
      >
        <span className="label-full">Create account</span>
        <span className="label-short">Sign up</span>
      </button>
    </div>
  );

  const authedActions = (
    <div className="hdr-user-actions">
      {state.userInfo.userType && (
        <button className="hdr-icon-btn" onClick={Refound} title="Reback" type="button">
          <img width={18} src={refound} alt="refund" />
        </button>
      )}
      <button
        type="button"
        className={msgTab ? "hdr-pill hdr-pill--active" : "hdr-pill"}
        onClick={toggleMsgTab}
        title="Live chat"
      >
        <MessageCircle {...ICON_PROPS} />
        <span className="hdr-pill__label">Chat</span>
      </button>
      <button
        type="button"
        className="hdr-pill hdr-pill--wallet"
        onClick={openWallet}
        title="Deposits, withdrawals and your ledger"
      >
        <Wallet {...ICON_PROPS} />
        <span className="hdr-pill__label">Wallet</span>
      </button>
      <button type="button" className="hdr-balance" onClick={openWallet} title="Open your wallet">
        <span className="hdr-balance__amount">
          {Number(userInfo?.balance ?? state.userInfo.balance).toFixed(2)}
        </span>
        <span className="hdr-balance__currency">MWK</span>
      </button>
      <div className="hdr-account" ref={menuRef}>
        <button
          type="button"
          className="hdr-account__trigger"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <img
            className="hdr-account__avatar"
            src={userInfo?.avatar || "/avatars/av-5.png"}
            alt=""
          />
          <span className="hdr-account__name">
            {userInfo?.userName || state.userInfo.userName || "Player"}
          </span>
          <ChevronDown className={menuOpen ? "hdr-account__caret up" : "hdr-account__caret"} size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {menuOpen && (
          <div className="hdr-menu" role="menu">
            <div className="hdr-menu__head">
              <img className="hdr-menu__avatar" src={userInfo?.avatar || "/avatars/av-5.png"} alt="" />
              <div className="hdr-menu__who">
                <span className="hdr-menu__name">
                  {userInfo?.userName || state.userInfo.userName || "Player"}
                </span>
                <span className="hdr-menu__sub">
                  {state.userInfo.userType ? "Administrator" : "Player"}
                </span>
              </div>
            </div>
            <button role="menuitem" className="hdr-menu__item" onClick={() => { setMenuOpen(false); openProfile(); }}>
              <User {...ICON_PROPS} /> My profile
            </button>
            <button role="menuitem" className="hdr-menu__item" onClick={() => { setMenuOpen(false); openWallet(); }}>
              <Wallet {...ICON_PROPS} /> Wallet
            </button>
            <div className="hdr-menu__sep" />
            <button role="menuitem" className="hdr-menu__item hdr-menu__item--danger" onClick={handleLogout}>
              <LogOut {...ICON_PROPS} /> Log out
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <header className="site-nav">
        <div className="nav-inner">
          <div className="nav-topbar">
            <div className="nav-left">
              <NavLink to="/" className="brand" aria-label="Yanga Bet home" onClick={closeDrawer}>
                <span className="brand__text">Yanga Bet</span>
              </NavLink>

              <nav className="nav-links" aria-label="Primary">
                {primaryLinks}
              </nav>
            </div>

            <div className="nav-right">
              {isAuthenticated ? authedActions : guestButtons}
            </div>

            <div className="nav-mobile-right">
              {!isAuthenticated ? guestButtons : (
                <button type="button" className="hdr-balance hdr-balance--mobile" onClick={openWallet} title="Open your wallet">
                  <span className="hdr-balance__amount">
                    {Number(userInfo?.balance ?? state.userInfo.balance).toFixed(2)}
                  </span>
                  <span className="hdr-balance__currency">MWK</span>
                </button>
              )}
              <button
                type="button"
                className="hamburger"
                aria-label={drawerOpen ? "Close menu" : "Open menu"}
                aria-expanded={drawerOpen}
                aria-controls="nav-drawer"
                onClick={() => setDrawerOpen((v) => !v)}
              >
                {drawerOpen ? <X size={20} strokeWidth={1.75} aria-hidden="true" /> : <Menu size={20} strokeWidth={1.75} aria-hidden="true" />}
              </button>
            </div>
          </div>


        </div>
      </header>

      <div className={drawerOpen ? "nav-drawer-overlay open" : "nav-drawer-overlay"} onClick={closeDrawer} />
      <aside id="nav-drawer" className={drawerOpen ? "nav-drawer open" : "nav-drawer"} aria-hidden={!drawerOpen}>
        <div className="nav-drawer__head">
          <span>Menu</span>
          <button type="button" className="drawer-close" onClick={closeDrawer} aria-label="Close menu">
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <nav className="nav-drawer__links">
          <button type="button" className="drawer-link" onClick={() => { closeDrawer(); setHowto("short"); }}>
            <CircleHelp {...ICON_PROPS} /> Help &amp; Rules
          </button>
          <button type="button" className="drawer-link" onClick={closeDrawer}>
            <Gift {...ICON_PROPS} /> Promotions
          </button>
          <button type="button" className="drawer-link" onClick={closeDrawer}>
            <Headset {...ICON_PROPS} /> Support
          </button>
          <button type="button" className="drawer-link" onClick={closeDrawer}>
            <Languages {...ICON_PROPS} /> Language
          </button>
          {isAuthenticated && (
            <>
              <div className="drawer-sep" />
              <button type="button" className="drawer-link" onClick={() => { closeDrawer(); openProfile(); }}>
                <User {...ICON_PROPS} /> My profile
              </button>
              <button type="button" className="drawer-link" onClick={() => { closeDrawer(); openWallet(); }}>
                <Wallet {...ICON_PROPS} /> Wallet
              </button>
              <button type="button" className="drawer-link" onClick={() => { closeDrawer(); toggleMsgTab(); }}>
                <MessageCircle {...ICON_PROPS} /> Chat
              </button>
              <button type="button" className="drawer-link danger" onClick={handleLogout}>
                <LogOut {...ICON_PROPS} /> Log out
              </button>
            </>
          )}
        </nav>
      </aside>

      {howto === "short" && (
        <div className="modal">
          <div className="back" onClick={() => setHowto("howto")}></div>
          <div className="modal-dialog">
            <div className="modal-content">
              <div className="modal-header modal-bg text-uppercase">
                <span>How to Play?</span>
                <button onClick={() => setHowto("")} className="close modal-close"><span>×</span></button>
              </div>
              <div className="modal-body m-body-bg">
                <div className="youtube"><div className="embed-responsive"><iframe title="tutorial" className="embed-responsive-item" src="https://www.youtube.com/embed/PZejs3XDCSY?playsinline=1" /></div></div>
                <div className="step"><div className="bullet">01</div><p>Make a bet, or even two at same time and wait for the round to start.</p></div>
                <div className="step"><div className="bullet bullet-2">02</div><p>Watch the lucky plane. Your win is your bet multiplied by the coefficient. Cash out before the plane flies away!</p></div>
                <div className="step"><div className="bullet bullet-3">03</div><p>Cash out before the plane flies away and the money is yours!</p></div>
              </div>
              <div className="modal-footer m-f-bg"><button onClick={() => setHowto("more")}>detailed rules</button></div>
            </div>
          </div>
        </div>
      )}

      {howto === "more" && (
        <div className="modal">
          <div className="back" onClick={() => setHowto("howto")}></div>
          <div className="modal-dialog">
            <div className="modal-content">
              <div className="modal-header "><span className="text-uppercase">Game rules</span><button onClick={() => setHowto("howto")} className="close"><span>×</span></button></div>
              <div className="modal-body p-1r">
                <p className="text-gray">Aviator is built on a provably fair system.</p>
                <button className="under-a" onClick={() => setFireSystem(true)}> Read more about provably fair system </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
