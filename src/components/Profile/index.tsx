import React from "react";
import axios from "axios";
import { toast } from "react-toastify";
import Context from "../../context";
import { config } from "../../config";
import "./profile.scss";

/**
 * Account / profile modal.
 *
 * Opened from the header account menu. Shows the player who they are (avatar,
 * display name, phone, member since), their balance at a glance, and the small
 * set of settings they actually control:
 *
 *   - avatar            -> PATCH /auth/me { avatar }
 *   - payout phone      -> PATCH /auth/me { payoutPhone }  (withdrawals only)
 *   - sound / music     -> PATCH /auth/me { isSoundEnable, isMusicEnable }
 *
 * Every write goes through the server's allow-listed PATCH /me, so nothing here
 * can ever mass-assign `balance`, `is_admin` or `password` (CWE-915). All server
 * strings are rendered as React text nodes, never as markup.
 */

const AVATAR_COUNT = 72;

interface ProfileData {
  userId: string;
  userName: string;
  phoneNumber: string;
  payoutPhone: string | null;
  balance: number;
  avatar: string;
  currency: string;
  userType: boolean;
  isSoundEnable: boolean;
  isMusicEnable: boolean;
  createdAt: string | null;
}

interface WalletSummary {
  balance: number;
  held: number;
  available: number;
  currency: string;
}

function money(value: number | null | undefined): string {
  return Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Never render a full phone number into a UI that can be shoulder-surfed. */
function maskPhone(phone?: string | null): string {
  if (!phone) return "Not set";
  const digits = String(phone);
  if (digits.length <= 4) return digits;
  return `${digits.slice(0, 3)}••••${digits.slice(-2)}`;
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

export default function Profile() {
  const {
    profileOpen,
    closeProfile,
    isAuthenticated,
    openAuthModal,
    openWallet,
    logout,
    updateUserInfo,
  } = React.useContext(Context) as any;

  const [profile, setProfile] = React.useState<ProfileData | null>(null);
  const [wallet, setWallet] = React.useState<WalletSummary | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [payoutPhone, setPayoutPhone] = React.useState("");
  const [savingPhone, setSavingPhone] = React.useState(false);
  const [savingAvatar, setSavingAvatar] = React.useState(false);
  const [savingPref, setSavingPref] = React.useState(false);
  const [showAvatars, setShowAvatars] = React.useState(false);

  const token = () => localStorage.getItem("authToken");

  const load = React.useCallback(async () => {
    const t = localStorage.getItem("authToken");
    if (!t) {
      setLoading(false);
      return;
    }
    try {
      const headers = { Authorization: `Bearer ${t}` };
      const [meRes, walletRes] = await Promise.all([
        axios.get(`${config.development_api}/auth/me`, { headers }),
        axios.get(`${config.development_api}/payments/wallet`, { headers }),
      ]);

      if (meRes.data.status) {
        const d = meRes.data.data;
        setProfile({
          userId: d.userId,
          userName: d.userName || "",
          phoneNumber: d.phoneNumber || "",
          payoutPhone: d.payoutPhone || null,
          balance: Number(d.balance) || 0,
          avatar: d.avatar || "",
          currency: d.currency || "MWK",
          userType: Boolean(d.userType),
          isSoundEnable: Boolean(d.isSoundEnable),
          isMusicEnable: Boolean(d.isMusicEnable),
          createdAt: d.createdAt || null,
        });
        setPayoutPhone(d.payoutPhone || "");
      }
      if (walletRes.data.status) {
        setWallet({
          balance: Number(walletRes.data.data.balance) || 0,
          held: Number(walletRes.data.data.held) || 0,
          available: Number(walletRes.data.data.available) || 0,
          currency: walletRes.data.data.currency || "MWK",
        });
      }
    } catch (error: any) {
      if (error?.response?.status !== 401) {
        toast.error("Could not load your profile");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (profileOpen) {
      setLoading(true);
      setShowAvatars(false);
      load();
    }
  }, [profileOpen, load]);

  // Close on Escape.
  React.useEffect(() => {
    if (!profileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeProfile();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [profileOpen, closeProfile]);

  const saveAvatar = async (avatar: string) => {
    if (savingAvatar || profile?.avatar === avatar) return;
    setSavingAvatar(true);
    try {
      const res = await axios.patch(
        `${config.development_api}/auth/me`,
        { avatar },
        { headers: { Authorization: `Bearer ${token()}` } }
      );
      if (res.data.status) {
        setProfile((prev) => (prev ? { ...prev, avatar } : prev));
        updateUserInfo({ avatar });
        toast.success("Avatar updated");
      } else {
        toast.error(res.data.message || "Could not update your avatar");
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Could not update your avatar");
    } finally {
      setSavingAvatar(false);
    }
  };

  const savePayoutPhone = async () => {
    const cleaned = payoutPhone.replace(/[\s-]/g, "");
    if (cleaned && !/^(\+?265|0)?(88|99)\d{7}$/.test(cleaned)) {
      toast.error("Enter a valid Malawian mobile number (e.g. 991234567)");
      return;
    }
    setSavingPhone(true);
    try {
      const res = await axios.patch(
        `${config.development_api}/auth/me`,
        { payoutPhone: cleaned },
        { headers: { Authorization: `Bearer ${token()}` } }
      );
      if (res.data.status) {
        const saved = res.data.data.payoutPhone || null;
        setProfile((prev) => (prev ? { ...prev, payoutPhone: saved } : prev));
        setPayoutPhone(saved || "");
        toast.success(saved ? "Payout phone saved" : "Payout phone removed");
      } else {
        toast.error(res.data.message || "Could not save the phone");
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Could not save the phone");
    } finally {
      setSavingPhone(false);
    }
  };

  const savePref = async (patch: { isSoundEnable?: boolean; isMusicEnable?: boolean }) => {
    if (savingPref) return;
    setSavingPref(true);
    // Optimistic update so the toggle feels instant.
    setProfile((prev) => (prev ? { ...prev, ...patch } : prev));
    updateUserInfo(patch);
    try {
      const res = await axios.patch(`${config.development_api}/auth/me`, patch, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      if (!res.data.status) {
        toast.error(res.data.message || "Could not save your settings");
        load();
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Could not save your settings");
      load();
    } finally {
      setSavingPref(false);
    }
  };

  if (!profileOpen) return null;

  const currentAvatar = profile?.avatar || "/avatars/av-5.png";
  const currency = wallet?.currency || profile?.currency || "MWK";

  return (
    <div className="profile-modal">
      <div className="profile-backdrop" onClick={closeProfile}></div>
      <div
        className="profile-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-title"
      >
        <div className="profile-header">
          <span className="profile-title" id="profile-title">
            My Account
          </span>
          <button className="profile-close" onClick={closeProfile} aria-label="Close">
            ×
          </button>
        </div>

        <div className="profile-body">
          {!isAuthenticated ? (
            <div className="profile-auth-required">
              <p>Log in or create an account to view your profile.</p>
              <button
                className="profile-primary-btn"
                onClick={() => {
                  closeProfile();
                  openAuthModal("Log in to view your profile.");
                }}
              >
                Log in / Sign up
              </button>
            </div>
          ) : loading ? (
            <div className="profile-loading">Loading your profile…</div>
          ) : (
            <>
              {/* ---- identity ------------------------------------------------ */}
              <div className="profile-hero">
                <div className="profile-avatar">
                  <img src={currentAvatar} alt="Your avatar" />
                </div>
                <div className="profile-identity">
                  <div className="profile-name-row">
                    <span className="profile-name">{profile?.userName || "Player"}</span>
                    <span
                      className={
                        profile?.userType
                          ? "profile-badge profile-badge-admin"
                          : "profile-badge"
                      }
                    >
                      {profile?.userType ? "Admin" : "Player"}
                    </span>
                  </div>
                  <div className="profile-meta">
                    <span>{maskPhone(profile?.phoneNumber)}</span>
                    <span className="profile-dot">•</span>
                    <span>Member since {formatDate(profile?.createdAt)}</span>
                  </div>
                  <button
                    className="profile-link-btn"
                    onClick={() => setShowAvatars((v) => !v)}
                  >
                    {showAvatars ? "Done choosing" : "Change avatar"}
                  </button>
                </div>
              </div>

              {showAvatars && (
                <div className="profile-avatar-picker">
                  <div className="profile-avatar-grid">
                    {Array.from({ length: AVATAR_COUNT }, (_, i) => i + 1).map((n) => {
                      const url = `/avatars/av-${n}.png`;
                      return (
                        <button
                          key={n}
                          type="button"
                          className={
                            profile?.avatar === url
                              ? "profile-avatar-option active"
                              : "profile-avatar-option"
                          }
                          onClick={() => saveAvatar(url)}
                          disabled={savingAvatar}
                          aria-label={`Choose avatar ${n}`}
                        >
                          <img src={url} alt={`Avatar ${n}`} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ---- balance --------------------------------------------------- */}
              <div className="profile-balances">
                <div className="profile-balance-card">
                  <div className="profile-card-label">Available</div>
                  <div className="profile-card-value">
                    {money(wallet?.available ?? profile?.balance)} <span>{currency}</span>
                  </div>
                </div>
                <div className="profile-balance-card profile-balance-card-dim">
                  <div className="profile-card-label">Held</div>
                  <div className="profile-card-value">
                    {money(wallet?.held)} <span>{currency}</span>
                  </div>
                </div>
                <div className="profile-balance-card profile-balance-card-dim">
                  <div className="profile-card-label">Total</div>
                  <div className="profile-card-value">
                    {money((wallet?.balance ?? profile?.balance ?? 0) + (wallet?.held || 0))}{" "}
                    <span>{currency}</span>
                  </div>
                </div>
              </div>

              {/* ---- payout phone ---------------------------------------------- */}
              <div className="profile-section">
                <div className="profile-section-title">Payout phone</div>
                <p className="profile-hint">
                  Withdrawals are only ever sent to this registered number.
                </p>
                <div className="profile-inline-form">
                  <input
                    className="profile-input"
                    inputMode="tel"
                    placeholder="e.g. 991234567"
                    value={payoutPhone}
                    onChange={(e) => setPayoutPhone(e.target.value)}
                  />
                  <button
                    className="profile-secondary-btn"
                    disabled={savingPhone}
                    onClick={savePayoutPhone}
                  >
                    {savingPhone ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>

              {/* ---- preferences ----------------------------------------------- */}
              <div className="profile-section">
                <div className="profile-section-title">Preferences</div>
                <label className="profile-toggle">
                  <span>Sound effects</span>
                  <input
                    type="checkbox"
                    checked={Boolean(profile?.isSoundEnable)}
                    onChange={(e) => savePref({ isSoundEnable: e.target.checked })}
                  />
                  <span className="profile-switch" aria-hidden="true"></span>
                </label>
                <label className="profile-toggle">
                  <span>Music</span>
                  <input
                    type="checkbox"
                    checked={Boolean(profile?.isMusicEnable)}
                    onChange={(e) => savePref({ isMusicEnable: e.target.checked })}
                  />
                  <span className="profile-switch" aria-hidden="true"></span>
                </label>
              </div>

              {/* ---- actions --------------------------------------------------- */}
              <div className="profile-actions">
                <button
                  className="profile-primary-btn"
                  onClick={() => {
                    closeProfile();
                    openWallet();
                  }}
                >
                  Open wallet
                </button>
                <button
                  className="profile-danger-btn"
                  onClick={() => {
                    closeProfile();
                    logout();
                  }}
                >
                  Log out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
