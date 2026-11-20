import React from "react";
import axios from "axios";
import { io, Socket } from "socket.io-client";
import { toast } from "react-toastify";
import { config } from "../../config";
import "./admin.scss";

// ============================================================================
// Types
// ============================================================================

type Section = "OVERVIEW" | "WITHDRAWALS" | "DEPOSITS" | "AVIATOR" | "PLAYERS";

interface Withdrawal {
  id: string;
  user_id: string;
  amount: number;
  fee: number;
  net_amount: number;
  method: string;
  phone_number: string;
  status: "PENDING" | "PAID" | "REJECTED" | "CANCELLED";
  rejection_reason?: string | null;
  gateway_ref?: string | null;
  created_at: string;
  processed_at?: string | null;
}

interface Deposit {
  id: string;
  user_id: string;
  amount: number;
  method: string;
  status: "PENDING" | "COMPLETED" | "FAILED" | "EXPIRED";
  failure_reason?: string | null;
  provider_ref?: string | null;
  created_at: string;
  completed_at?: string | null;
}

interface AviatorState {
  adminMode?: boolean;
  forcedCrashPoint?: number | null;
  waitingForAdmin?: boolean;
  fallbackMs?: number;
  fallbackAt?: number | null;
  gameState?: string;
  currentRound?: number;
  currentNum?: number;
  currentCrashPoint?: number;
  history?: number[];
  bettedUsersCount?: number;
}

interface AdminPlayer {
  id: string;
  userName: string;
  phoneNumber: string;
  email: string;
  balance: number;
  held: number;
  payoutPhone?: string | null;
  avatar: string;
  isBanned: boolean;
  banReason?: string | null;
  isGuest: boolean;
  createdAt?: string | null;
  lastLoginAt?: string | null;
}

interface PlayerDraft {
  userName: string;
  phoneNumber: string;
  email: string;
  isBanned: boolean;
  banReason: string;
  password: string;
}

// ============================================================================
// Helpers
// ============================================================================

const WITHDRAWAL_STATUS_LABEL: Record<string, string> = { PENDING: "Pending", PAID: "Paid", REJECTED: "Rejected", CANCELLED: "Cancelled" };
const DEPOSIT_STATUS_LABEL: Record<string, string> = { PENDING: "Pending", COMPLETED: "Completed", FAILED: "Failed", EXPIRED: "Expired" };
const AVIATOR_STATE_LABEL: Record<string, string> = { BET: "Betting open", FLYING: "In flight", CRASHED: "Crashed", WAITING: "Waiting" };

function money(value: number | null | undefined): string {
  return Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatAt(value: string | number | undefined | null): string {
  if (value === null || value === undefined || value === "") return "";
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ============================================================================
// Icons
// ============================================================================

function Icon({ name, className }: { name: string; className?: string }) {
  const common = { className: className || "i", viewBox: "0 0 24 24", "aria-hidden": true as const };
  switch (name) {
    case "overview": return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>;
    case "withdrawals": return <svg {...common}><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>;
    case "deposits": return <svg {...common}><path d="M12 20V9m0 0-4 4m4-4 4 4M5 4h14"/></svg>;
    case "aviator": return <svg {...common}><path d="M3 17 21 5l-5 15-4-6zM12 14l9-9"/></svg>;
    case "players": return <svg {...common}><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-3.5 3-5.5 6.5-5.5s6 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .6 3.2 2.3 3.5 5.2"/></svg>;
    case "search": return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>;
    case "bell": return <svg {...common}><path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21h4"/></svg>;
    case "refresh": return <svg {...common}><path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5"/></svg>;
    case "check": return <svg {...common} style={{ width: 28, height: 28, strokeWidth: 2.4 }}><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>;
    default: return null;
  }
}

function Spark({ color }: { color: string }) {
  const paths: Record<string, string> = {
    amber: "M0 30 L20 26 L40 32 L60 18 L80 22 L100 8",
    accent: "M0 34 L25 30 L45 24 L65 26 L85 14 L100 12",
    violet: "M0 28 L20 22 L40 26 L60 14 L80 18 L100 6",
    cyan: "M0 36 L30 34 L55 28 L75 18 L100 4",
  };
  return (
    <svg className="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <path d={paths[color] || paths.accent} fill="none" stroke={color === "amber" ? "var(--amber)" : color === "violet" ? "var(--violet)" : color === "cyan" ? "#6ef3ff" : "var(--accent)"} strokeWidth="2" opacity=".7" />
    </svg>
  );
}

export default function Admin() {
  const [adminToken, setAdminToken] = React.useState<string | null>(() => localStorage.getItem("adminToken"));

  // login
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loggingIn, setLoggingIn] = React.useState(false);
  const [loginError, setLoginError] = React.useState("");

  // nav
  const [section, setSection] = React.useState<Section>("OVERVIEW");
  const [menuOpen, setMenuOpen] = React.useState(false);

  // overview/shared
  const [ovLoading, setOvLoading] = React.useState(false);
  const [ovPending, setOvPending] = React.useState<Withdrawal[]>([]);
  const [ovAviator, setOvAviator] = React.useState<AviatorState>({});

  // withdrawals
  const [withdrawals, setWithdrawals] = React.useState<Withdrawal[]>([]);
  const [wStatusFilter, setWStatusFilter] = React.useState("PENDING");
  const [wLoading, setWLoading] = React.useState(false);
  const [rejectingId, setRejectingId] = React.useState<string | null>(null);
  const [rejectReason, setRejectReason] = React.useState("");
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // deposits
  const [deposits, setDeposits] = React.useState<Deposit[]>([]);
  const [dStatusFilter, setDStatusFilter] = React.useState("");
  const [dLoading, setDLoading] = React.useState(false);

  // aviator
  const [aviator, setAviator] = React.useState<AviatorState>({});
  const [aviatorBusy, setAviatorBusy] = React.useState(false);
  const [crashInput, setCrashInput] = React.useState("2.00");
  const [socketLive, setSocketLive] = React.useState(false);
  const socketRef = React.useRef<Socket | null>(null);

  // players
  const [players, setPlayers] = React.useState<AdminPlayer[]>([]);
  const [playerSearch, setPlayerSearch] = React.useState("");
  const [playersLoading, setPlayersLoading] = React.useState(false);
  const [playersTotal, setPlayersTotal] = React.useState(0);
  const [editingPlayerId, setEditingPlayerId] = React.useState<string | null>(null);
  const [playerDraft, setPlayerDraft] = React.useState<PlayerDraft | null>(null);
  const [playerBusyId, setPlayerBusyId] = React.useState<string | null>(null);
  const [savingPlayer, setSavingPlayer] = React.useState(false);
  const [creditUserId, setCreditUserId] = React.useState("");
  const [creditAmount, setCreditAmount] = React.useState("");
  const [creditReason, setCreditReason] = React.useState("");
  const [creditBusy, setCreditBusy] = React.useState(false);

  // Auth
  const handleLogout = React.useCallback(() => {
    localStorage.removeItem("adminToken");
    setAdminToken(null);
    setWithdrawals([]); setDeposits([]); setAviator({});
    setOvPending([]); setOvAviator({}); setPlayers([]);
  }, []);

  const request = React.useCallback(async (method: "get"|"post"|"put"|"patch"|"delete", url: string, body?: any) => {
    const client = axios as any;
    const full = `${config.development_api}${url}`;
    const opts = { headers: { Authorization: `Bearer ${adminToken}` } };
    try {
      const res = (method === "get" || method === "delete") ? await client[method](full, opts) : await client[method](full, body, opts);
      return res.data;
    } catch (error: any) {
      if (error?.response?.status === 401) {
        handleLogout();
        toast.error("Session expired - please sign in again");
      }
      throw error;
    }
  }, [adminToken, handleLogout]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoggingIn(true);
    setLoginError("");
    try {
      const res = await axios.post(`${config.development_api}/admin/login`, { username, password });
      if ((res.data.success || res.data.status) && res.data.token) {
        localStorage.setItem("adminToken", res.data.token);
        setAdminToken(res.data.token);
        setUsername(""); setPassword("");
        setSection("OVERVIEW");
        toast.success("Signed in as operator");
      } else {
        setLoginError(res.data.message || "Invalid credentials");
      }
    } catch (error: any) {
      setLoginError(error?.response?.data?.message || "Login failed");
    } finally {
      setLoggingIn(false);
    }
  };

  // Aviator socket (live)
  React.useEffect(() => {
    if (!adminToken || section !== "AVIATOR") return;
    const s = io(config.development_wss, { transports: ["websocket", "polling"], reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 10 });
    socketRef.current = s;
    s.on("connect", () => { setSocketLive(true); s.emit("adminAuthenticate", adminToken); s.emit("getAdminState"); });
    s.on("disconnect", () => setSocketLive(false));
    s.on("adminAuthenticated", (data: any) => { if (!data?.success) toast.error("Admin socket access denied"); });
    s.on("adminState", (state: AviatorState) => { if (state && typeof state === "object") setAviator(state); });
    return () => { s.close(); socketRef.current = null; setSocketLive(false); };
  }, [adminToken, section]);

  // Loaders
  const loadWithdrawals = React.useCallback(async (status: string) => {
    if (!adminToken) return; setWLoading(true);
    try { const q = status ? `?status=${encodeURIComponent(status)}` : ""; const data = await request("get", `/payments/admin/withdrawals${q}`); if (data.status) setWithdrawals(Array.isArray(data.data) ? data.data : []); }
    catch { toast.error("Could not load the withdrawal queue"); }
    finally { setWLoading(false); }
  }, [adminToken, request]);

  const loadDeposits = React.useCallback(async (status: string) => {
    if (!adminToken) return; setDLoading(true);
    try { const q = status ? `?status=${encodeURIComponent(status)}` : ""; const data = await request("get", `/payments/admin/deposits${q}`); if (data.status) setDeposits(Array.isArray(data.data) ? data.data : []); }
    catch { toast.error("Could not load deposits"); }
    finally { setDLoading(false); }
  }, [adminToken, request]);

  const loadPlayers = React.useCallback(async (search: string) => {
    if (!adminToken) return; setPlayersLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50", offset: "0" });
      if (search.trim()) params.set("search", search.trim());
      const data = await request("get", `/admin/users?${params.toString()}`);
      if (data.status && data.data) { setPlayers(Array.isArray(data.data.users) ? data.data.users : []); setPlayersTotal(Number(data.data.total) || 0); }
    } catch { toast.error("Could not load players"); }
    finally { setPlayersLoading(false); }
  }, [adminToken, request]);

  const loadAviator = React.useCallback(async () => {
    if (!adminToken) return;
    try { const data = await request("get", "/admin/state"); if (data && data.success !== false) setAviator(data as AviatorState); } catch { /* socket */ }
  }, [adminToken, request]);

  const loadOverview = React.useCallback(async () => {
    if (!adminToken) return; setOvLoading(true);
    try {
      const [w, a] = await Promise.all([
        request("get", "/payments/admin/withdrawals?status=PENDING"),
        request("get", "/admin/state"),
      ]);
      if (w.status) setOvPending(Array.isArray(w.data) ? w.data : []);
      if (a && a.success !== false) setOvAviator(a as AviatorState);
    } catch { toast.error("Could not load the overview"); }
    finally { setOvLoading(false); }
  }, [adminToken, request]);

  const refreshPendingBadge = React.useCallback(async () => {
    if (!adminToken) return;
    try { const data = await request("get", "/payments/admin/withdrawals?status=PENDING"); if (data.status) setOvPending(Array.isArray(data.data) ? data.data : []); } catch { /* badge */ }
  }, [adminToken, request]);

  React.useEffect(() => { refreshPendingBadge(); }, [refreshPendingBadge]);
  React.useEffect(() => {
    if (!adminToken) return;
    if (section === "OVERVIEW") loadOverview();
    else if (section === "WITHDRAWALS") loadWithdrawals(wStatusFilter);
    else if (section === "DEPOSITS") loadDeposits(dStatusFilter);
    else if (section === "AVIATOR") loadAviator();
    else if (section === "PLAYERS") loadPlayers(playerSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken, section, wStatusFilter, dStatusFilter]);

  const [refreshing, setRefreshing] = React.useState(false);
  const refreshCurrent = async () => {
    setRefreshing(true);
    try {
      if (section === "OVERVIEW") await loadOverview();
      else if (section === "WITHDRAWALS") await loadWithdrawals(wStatusFilter);
      else if (section === "DEPOSITS") await loadDeposits(dStatusFilter);
      else if (section === "AVIATOR") await loadAviator();
      else if (section === "PLAYERS") await loadPlayers(playerSearch);
      await refreshPendingBadge();
    } finally { setRefreshing(false); }
  };

  // Withdrawals actions
  const approveWithdrawal = async (w: Withdrawal) => {
    setBusyId(w.id);
    try {
      let data: any;
      try { data = await request("post", `/payments/admin/withdrawals/${w.id}/approve`); }
      catch (error: any) {
        const body = error?.response?.data;
        if (body?.code !== "PAYOUT_NOT_CONFIGURED") throw error;
        const reference = window.prompt(`Automatic payout is not configured.\n\nSend ${money(w.net_amount)} MWK to ${w.phone_number} from the PayChangu dashboard, then enter the payout reference:`);
        if (!reference || !reference.trim()) { toast.info("Nothing was paid out. The withdrawal stays pending and the funds stay held."); return; }
        data = await request("post", `/payments/admin/withdrawals/${w.id}/approve`, { manual: true, reference: reference.trim() });
      }
      if (data.status) toast.success(`Payout recorded for ${money(w.amount)} MWK (${data.gatewayRef || "no ref"})`);
      else toast.error(data.message || "Could not approve");
      await Promise.all([loadWithdrawals(wStatusFilter), refreshPendingBadge()]);
    } catch (error: any) {
      const body = error?.response?.data;
      if (body?.fundsStillHeld) toast.error(`${body.message} - funds are still held, nothing was paid out.`);
      else toast.error(body?.message || "Could not approve the withdrawal");
    } finally { setBusyId(null); }
  };

  const rejectWithdrawal = async (w: Withdrawal) => {
    if (rejectingId !== w.id) { setRejectingId(w.id); setRejectReason(""); return; }
    if (!rejectReason.trim()) { toast.error("A rejection reason is required"); return; }
    setBusyId(w.id);
    try {
      const data = await request("post", `/payments/admin/withdrawals/${w.id}/reject`, { reason: rejectReason.trim() });
      if (data.status) toast.success("Withdrawal rejected and the funds returned"); else toast.error(data.message || "Could not reject");
      setRejectingId(null);
      await Promise.all([loadWithdrawals(wStatusFilter), refreshPendingBadge()]);
    } catch (error: any) { toast.error(error?.response?.data?.message || "Could not reject the withdrawal"); }
    finally { setBusyId(null); }
  };

  // Aviator actions
  const setCrashPoint = async () => {
    const value = Number(crashInput);
    if (!Number.isFinite(value) || value < 1 || value > 6) { toast.error("Crash point must be between 1.00 and 6.00"); return; }
    setAviatorBusy(true);
    try {
      const data = await request("post", "/admin/crash-point", { value });
      if (data?.success === false) toast.error(data.error || "Could not set the crash point"); else toast.success(`Next round will fly away at ${value.toFixed(2)}x`);
      await loadAviator();
    } catch (error: any) { toast.error(error?.response?.data?.error || "Could not set the crash point"); }
    finally { setAviatorBusy(false); }
  };

  const setManualMode = async (enabled: boolean) => {
    setAviatorBusy(true);
    try {
      const data = await request("post", "/admin/mode", { enabled });
      if (data?.success === false) toast.error(data.error || "Could not change the mode"); else toast.success(enabled ? "Manual mode ON - every round waits for your crash point" : "Manual mode OFF - rounds run automatically");
      await loadAviator();
    } catch (error: any) { toast.error(error?.response?.data?.error || "Could not change the mode"); }
    finally { setAviatorBusy(false); }
  };

  const clearCrashPoint = async () => {
    setAviatorBusy(true);
    try { const data = await request("post", "/admin/clear", {}); if (data?.success === false) toast.error(data.error || "Could not clear"); else toast.success("Forced crash point cleared"); await loadAviator(); }
    catch (error: any) { toast.error(error?.response?.data?.error || "Could not clear the crash point"); }
    finally { setAviatorBusy(false); }
  };

  // Players actions
  const searchPlayers = (e: React.FormEvent) => { e.preventDefault(); loadPlayers(playerSearch); };
  const startPlayerEdit = (p: AdminPlayer) => { setEditingPlayerId(p.id); setPlayerDraft({ userName: p.userName || "", phoneNumber: p.phoneNumber || "", email: p.email || "", isBanned: p.isBanned, banReason: p.banReason || "", password: "" }); };
  const cancelPlayerEdit = () => { setEditingPlayerId(null); setPlayerDraft(null); };

  const savePlayer = async (p: AdminPlayer) => {
    if (!playerDraft) return;
    const patch: Record<string, any> = {};
    if (playerDraft.userName !== (p.userName || "")) { if (!playerDraft.userName.trim()) { toast.error("Username cannot be empty"); return; } patch.userName = playerDraft.userName.trim(); }
    if (playerDraft.phoneNumber !== (p.phoneNumber || "")) patch.phoneNumber = playerDraft.phoneNumber.trim();
    if (playerDraft.email !== (p.email || "")) patch.email = playerDraft.email.trim();
    if (playerDraft.isBanned !== p.isBanned) { patch.isBanned = playerDraft.isBanned; if (playerDraft.isBanned) patch.banReason = playerDraft.banReason.trim() || "Suspended by operator"; }
    else if (playerDraft.isBanned && playerDraft.banReason !== (p.banReason || "")) patch.banReason = playerDraft.banReason.trim();
    if (playerDraft.password.trim()) patch.password = playerDraft.password;
    if (!Object.keys(patch).length) { toast.info("Nothing changed"); return; }
    setSavingPlayer(true);
    try {
      const data = await request("patch", `/admin/users/${encodeURIComponent(p.id)}`, patch);
      if (data.status) { toast.success(`Player ${data.data?.userName || p.userName} updated`); cancelPlayerEdit(); await loadPlayers(playerSearch); }
      else toast.error(data.message || "Could not update the player");
    } catch (error: any) { toast.error(error?.response?.data?.message || "Could not update the player"); }
    finally { setSavingPlayer(false); }
  };

  const togglePlayerBan = async (p: AdminPlayer) => {
    const suspend = !p.isBanned;
    if (suspend && !window.confirm(`Suspend ${p.userName}? They will not be able to bet or withdraw.`)) return;
    setPlayerBusyId(p.id);
    try {
      const data = await request("patch", `/admin/users/${encodeURIComponent(p.id)}`, { isBanned: suspend, banReason: suspend ? "Suspended by operator" : undefined });
      if (data.status) { toast.success(suspend ? `${p.userName} suspended` : `${p.userName} reinstated`); await loadPlayers(playerSearch); }
      else toast.error(data.message || "Could not update the account");
    } catch (error: any) { toast.error(error?.response?.data?.message || "Could not update the account"); }
    finally { setPlayerBusyId(null); }
  };

  const deletePlayer = async (p: AdminPlayer) => {
    if (!window.confirm(`Delete ${p.userName} permanently?\n\nAccounts with a balance or wallet history cannot be deleted - suspend them instead.`)) return;
    setPlayerBusyId(p.id);
    try {
      const data = await request("delete", `/admin/users/${encodeURIComponent(p.id)}`);
      if (data.status) { toast.success(`${p.userName} deleted`); if (editingPlayerId === p.id) cancelPlayerEdit(); await loadPlayers(playerSearch); }
      else toast.error(data.message || "Could not delete the player");
    } catch (error: any) { toast.error(error?.response?.data?.message || "Could not delete the player"); }
    finally { setPlayerBusyId(null); }
  };

  const userIdInputValid = (v: string) => /^[A-Za-z0-9_-]+$/.test(v.trim());
  const applyCredit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(creditAmount);
    if (!userIdInputValid(creditUserId)) { toast.error("Enter the player's userId"); return; }
    if (!Number.isFinite(amount) || amount === 0) { toast.error("Enter a non-zero amount in MWK"); return; }
    if (!creditReason.trim()) { toast.error("A reason is required - every adjustment is audited"); return; }
    setCreditBusy(true);
    try {
      const data = await request("post", "/payments/admin/credits", { userId: creditUserId.trim(), amount, reason: creditReason.trim() });
      if (data.status) { toast.success(`Applied. New balance: ${money(data.data.balance)} MWK`); setCreditAmount(""); setCreditReason(""); await loadPlayers(playerSearch); }
      else toast.error(data.message || "Could not adjust the balance");
    } catch (error: any) { toast.error(error?.response?.data?.message || "Could not adjust the balance"); }
    finally { setCreditBusy(false); }
  };

  // Derived
  const pendingTotal = ovPending.reduce((sum, w) => sum + Number(w.amount || 0), 0);
  const SECTION_TITLES: Record<Section, string> = { OVERVIEW: "Overview", WITHDRAWALS: "Withdrawals", DEPOSITS: "Deposits", AVIATOR: "Aviator round control", PLAYERS: "Player balances" };
  const navItems: { key: Section; label: string; icon: string }[] = [
    { key: "OVERVIEW", label: "Overview", icon: "overview" },
    { key: "WITHDRAWALS", label: "Withdrawals", icon: "withdrawals" },
    { key: "DEPOSITS", label: "Deposits", icon: "deposits" },
    { key: "AVIATOR", label: "Aviator", icon: "aviator" },
    { key: "PLAYERS", label: "Players", icon: "players" },
  ];
  const go = (s: Section) => { setSection(s); setMenuOpen(false); };
  const pendingBadge = ovPending.length;
  const today = React.useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }), []);

  // Render login
  if (!adminToken) {
    return (
      <div className="admin-login-page">
        <div className="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
        <div className="admin-login-card glass">
          <div className="brand" style={{ paddingBottom: 10 }}>
            <div className="logo">TB</div>
            <div><b>Tidye Bet</b><span>Operator console</span></div>
          </div>
          <div className="admin-login-title">Sign in</div>
          <div className="admin-login-sub">Restricted back-office access</div>
          <form onSubmit={handleLogin} className="admin-form">
            <label className="field"><span>Email or username</span><input className="input" placeholder="admin or you@example.com" value={username} onChange={(e)=>setUsername(e.target.value)} autoComplete="username" /></label>
            <label className="field"><span>Password</span><input className="input" type="password" placeholder="Password" value={password} onChange={(e)=>setPassword(e.target.value)} autoComplete="current-password" /></label>
            {loginError && <div className="error-box">{loginError}</div>}
            <button className="wide btn-primary" disabled={loggingIn} type="submit">{loggingIn ? "Signing in..." : "Sign in"}</button>
          </form>
          <p className="note" style={{ marginTop: 14 }}>Withdrawal approvals · Aviator round control · Player management</p>
        </div>
      </div>
    );
  }

  // Main shell
  return (
    <div className="admin-shell">
      <div className="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" />
      <div className="app">
        <aside className={`side glass ${menuOpen ? "open" : ""}`}>
          <div className="brand"><div className="logo">TB</div><div><b>Tidye Bet</b><span>Operator console</span></div></div>
          <nav id="nav">
            {navItems.map((n) => (
              <button key={n.key} className={`nav-item ${section === n.key ? "on" : ""}`} onClick={() => go(n.key)} type="button">
                <Icon name={n.icon} /><span className="label-text">{n.label}</span>
                {n.key === "WITHDRAWALS" && pendingBadge > 0 && <b className="badge">{pendingBadge}</b>}
              </button>
            ))}
          </nav>
          <div className="who">
            <p><i className="dot"></i>Signed in as operator</p>
            <button className="wide" onClick={handleLogout} type="button">Sign out</button>
          </div>
        </aside>
        {menuOpen && <div className="admin-scrim" onClick={() => setMenuOpen(false)} />}

        <main>
          <header className="top glass">
            <button className="icon-btn menu-btn" onClick={() => setMenuOpen((v)=>!v)} aria-label="Toggle menu" type="button">☰</button>
            <div><h1>{SECTION_TITLES[section]}</h1><small>{today}</small></div>
            <label className="search">
              <Icon name="search" />
              <input
                placeholder={section === "PLAYERS" ? "Search players..." : "Search..."}
                aria-label="Search"
                value={section === "PLAYERS" ? playerSearch : ""}
                onChange={(e) => { if (section === "PLAYERS") setPlayerSearch(e.target.value); }}
                onKeyDown={(e) => { if (e.key === "Enter" && section === "PLAYERS") { e.preventDefault(); loadPlayers(playerSearch); } }}
              />
            </label>
            <button className={`icon-btn ${pendingBadge > 0 ? "has" : ""}`} aria-label="Notifications" type="button" onClick={() => go("WITHDRAWALS")}><Icon name="bell" /></button>
            <button className={`icon-btn ${refreshing ? "spin" : ""}`} onClick={refreshCurrent} type="button" style={{ display: "flex", gap: 8, alignItems: "center", width: "auto", padding: "10px 14px" }} aria-label="Refresh">
              <Icon name="refresh" /> Refresh
            </button>
          </header>

          {/* OVERVIEW */}
          {section === "OVERVIEW" && (
            <div className="section-stack">
              <section className="stats">
                <article className="stat glass"><div className="ic" style={{ background: "rgba(255,181,71,.16)", color: "var(--amber)" }}><Icon name="withdrawals" /></div><label>Pending withdrawals</label><strong>{pendingBadge}</strong><em>Worth {money(pendingTotal)} MWK</em><Spark color="amber" /></article>
                <article className="stat glass"><div className="ic" style={{ background: "rgba(110,243,255,.14)", color: "#6ef3ff" }}><Icon name="aviator" /></div><label>Aviator round</label><strong>#{ovAviator.currentRound ?? "—"}</strong><em>{AVIATOR_STATE_LABEL[ovAviator.gameState || ""] || ovAviator.gameState || "—"}{ovAviator.adminMode ? " · manual" : ""}</em><Spark color="cyan" /></article>
              </section>

              <section className="grid">
                <article className="card glass">
                  <div className="head"><h2>Live flight</h2><span className={`pill ${ovAviator.gameState === "CRASHED" ? "crash" : ""}`}><i className="dot"></i>{AVIATOR_STATE_LABEL[ovAviator.gameState || ""] || ovAviator.gameState || "Live"}</span></div>
                  <div className="flight" style={{ display: "grid", placeItems: "center" }}>
                    <div className={`mult ${ovAviator.gameState === "CRASHED" ? "crash" : ""}`}>{Number(ovAviator.currentNum || 0).toFixed(2)}x</div>
                    <div style={{ position: "absolute", bottom: 16, left: 16, right: 16, color: "var(--mute)", fontSize: 13, display: "flex", justifyContent: "space-between" }}>
                      <span>Round #{ovAviator.currentRound ?? "—"}</span>
                      <span>{ovAviator.bettedUsersCount ?? 0} players</span>
                      <span>{ovAviator.forcedCrashPoint ? `Forced ${ovAviator.forcedCrashPoint}x` : "Auto odds"}</span>
                    </div>
                  </div>
                  <div className="rounds"><span>Recent rounds</span><span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{(ovAviator.history || []).slice(0, 8).map((h, i) => <span key={`${h}-${i}`} className={`chip ${Number(h)>=5?"hi":Number(h)>=2?"mid":"lo"}`}>{Number(h).toFixed(2)}x</span>)}</span></div>
                </article>

                <article className="card glass">
                  <div className="head"><h2>Withdrawals awaiting approval</h2><button className="link-btn" type="button" onClick={() => go("WITHDRAWALS")}>Manage</button></div>
                  {ovPending.length === 0 ? (
                    <div className="empty"><div className="ok"><Icon name="check" /></div><div><b style={{ color: "var(--ink)", fontSize: 15 }}>All caught up</b><br />Nothing pending right now.</div></div>
                  ) : (
                    <div className="table-wrap">
                      <table className="adm-table"><thead><tr><th>Player</th><th>Amount</th><th>Destination</th><th>Requested</th></tr></thead>
                        <tbody>{ovPending.slice(0,5).map((w)=>(
                          <tr key={w.id}><td className="mono">{w.user_id}</td><td><strong>{money(w.amount)} MWK</strong></td><td>{w.phone_number} · {w.method}</td><td>{formatAt(w.created_at)}</td></tr>
                        ))}</tbody>
                      </table>
                    </div>
                  )}
                  <div className="quick">
                    <button type="button" onClick={() => go("AVIATOR")}><Icon name="aviator" /> Aviator controls</button>
                    <button type="button" onClick={() => go("PLAYERS")}><Icon name="players" /> View players</button>
                  </div>
                </article>
              </section>
              {ovLoading && <div className="muted">Refreshing overview...</div>}
            </div>
          )}

          {/* WITHDRAWALS */}
          {section === "WITHDRAWALS" && (
            <div className="section-stack">
              <article className="card glass">
                <div className="head"><h2>Withdrawal queue</h2></div>
                <div className="filters">
                  {["PENDING","PAID","REJECTED","CANCELLED"].map((s)=>(<button key={s} type="button" className={`filter-btn ${wStatusFilter===s?"active":""}`} onClick={()=>setWStatusFilter(s)}>{WITHDRAWAL_STATUS_LABEL[s]}</button>))}
                </div>
                {wLoading ? <div className="empty">Loading...</div> : withdrawals.length === 0 ? <div className="empty">No withdrawals in this state.</div> : (
                  <div className="list">
                    {withdrawals.map((w)=>(
                      <div className="row-card" key={w.id}>
                        <div className="row-main">
                          <div className="row-title">{money(w.amount)} MWK <span className={`status st-${w.status}`}>{WITHDRAWAL_STATUS_LABEL[w.status]||w.status}</span></div>
                          <div className="row-meta">To {w.phone_number} · {w.method} · net {money(w.net_amount)} MWK · fee {money(w.fee)} MWK</div>
                          <div className="row-meta mono">user: {w.user_id}</div>
                          <div className="row-meta">requested {formatAt(w.created_at)}</div>
                          {w.rejection_reason && <div className="row-meta" style={{color:"var(--amber)"}}>reason: {w.rejection_reason}</div>}
                          {w.gateway_ref && <div className="row-meta mono">ref: {w.gateway_ref}</div>}
                        </div>
                        {w.status === "PENDING" && (
                          <div className="row-actions">
                            <button type="button" className="btn-primary" disabled={busyId===w.id} onClick={()=>approveWithdrawal(w)}>{busyId===w.id?"Processing...":"Approve withdrawal"}</button>
                            {rejectingId === w.id ? (
                              <div className="inline-form">
                                <input className="input" placeholder="Reason for rejection" value={rejectReason} onChange={(e)=>setRejectReason(e.target.value)} />
                                <button type="button" className="btn-danger" disabled={busyId===w.id} onClick={()=>rejectWithdrawal(w)}>Confirm</button>
                                <button type="button" className="btn-ghost" disabled={busyId===w.id} onClick={()=>setRejectingId(null)}>Cancel</button>
                              </div>
                            ) : (
                              <button type="button" className="btn-danger" onClick={()=>rejectWithdrawal(w)}>Reject withdrawal</button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </article>
            </div>
          )}

          {/* DEPOSITS */}
          {section === "DEPOSITS" && (
            <div className="section-stack">
              <article className="card glass">
                <div className="head"><h2>Deposits</h2></div>
                <div className="filters">
                  {["","PENDING","COMPLETED","FAILED","EXPIRED"].map((s)=>(<button key={s||"ALL"} type="button" className={`filter-btn ${dStatusFilter===s?"active":""}`} onClick={()=>setDStatusFilter(s)}>{s ? DEPOSIT_STATUS_LABEL[s] : "All"}</button>))}
                </div>
                {dLoading ? <div className="empty">Loading...</div> : deposits.length === 0 ? <div className="empty">No deposits to show.</div> : (
                  <div className="table-wrap">
                    <table className="adm-table"><thead><tr><th>Player</th><th>Amount</th><th>Method</th><th>Status</th><th>Reference</th><th>Created</th></tr></thead>
                      <tbody>{deposits.map((d)=>(
                        <tr key={d.id}><td className="mono">{d.user_id}</td><td><strong>{money(d.amount)} MWK</strong></td><td>{d.method}</td><td><span className={`status st-${d.status}`}>{DEPOSIT_STATUS_LABEL[d.status]||d.status}</span></td><td className="mono">{d.provider_ref || "—"}</td><td>{formatAt(d.created_at)}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </article>
            </div>
          )}

          {/* AVIATOR */}
          {section === "AVIATOR" && (
            <div className="section-stack">
              <div className="pill" style={{ alignSelf: "flex-start" }}><i className="dot" style={{ background: socketLive ? "var(--accent)" : "var(--amber)" }}></i>{socketLive ? "Live feed connected" : "Connecting to live feed..."}</div>
              <section className="stats">
                <article className="stat glass"><label>Round</label><strong>#{aviator.currentRound ?? "—"}</strong><em>{AVIATOR_STATE_LABEL[aviator.gameState || ""] || aviator.gameState || "—"}</em></article>
                <article className="stat glass"><label>Multiplier</label><strong>{Number(aviator.currentNum || 0).toFixed(2)}x</strong><em>crash at {aviator.currentCrashPoint ? `${aviator.currentCrashPoint}x` : "—"}</em></article>
                <article className="stat glass"><label>Players in round</label><strong>{aviator.bettedUsersCount ?? 0}</strong><em>placed a bet</em></article>
                <article className="stat glass"><label>Forced point</label><strong>{aviator.forcedCrashPoint ? `${aviator.forcedCrashPoint}x` : "auto"}</strong><em>{aviator.adminMode ? "manual mode" : "single override"}</em></article>
              </section>

              <article className="card glass">
                <div className="head"><h2>Next round crash point</h2></div>
                <p className="note">Set where the next flight flies away. In manual mode every round pauses at the betting phase and waits for you; otherwise this applies to the next round only and then reverts to automatic odds.{aviator.adminMode && Number(aviator.fallbackMs)>0 ? ` If you are busy, the round auto-starts with a normal random result after ${Math.round(Number(aviator.fallbackMs)/1000)} seconds.` : ""}</p>
                <div className="inline-form" style={{ marginTop: 12 }}>
                  <label className="field"><span>Crash at (x)</span><input className="input" type="number" step="0.01" min="1" max="6" value={crashInput} onChange={(e)=>setCrashInput(e.target.value)} /></label>
                  <button type="button" className="btn-primary" disabled={aviatorBusy} onClick={setCrashPoint}>{aviatorBusy?"Working...":"Set crash point"}</button>
                  <button type="button" className="btn-warn" disabled={aviatorBusy || !aviator.forcedCrashPoint} onClick={clearCrashPoint}>Clear override</button>
                  <button type="button" className={aviator.adminMode ? "btn-primary" : "btn-ghost"} disabled={aviatorBusy} onClick={()=>setManualMode(!aviator.adminMode)}>{aviator.adminMode ? "Manual mode: ON" : "Manual mode: OFF"}</button>
                </div>
                {aviator.waitingForAdmin && <div className="callout">The round is paused waiting for your crash point.{Number(aviator.fallbackMs)>0 ? ` If you are busy it will auto-start with a normal random result in ${Math.round(Number(aviator.fallbackMs)/1000)}s.` : " It will wait until you set one."}</div>}
              </article>

              <article className="card glass">
                <div className="head"><h2>Recent crash history</h2></div>
                {!aviator.history || aviator.history.length === 0 ? <div className="empty">No rounds yet.</div> : (
                  <div className="rounds"><span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{aviator.history.map((h,i)=>(<span key={`${h}-${i}`} className={`chip ${Number(h)>=5?"hi":Number(h)>=2?"mid":"lo"}`}>{Number(h).toFixed(2)}x</span>))}</span></div>
                )}
              </article>
            </div>
          )}

          {/* PLAYERS */}
          {section === "PLAYERS" && (
            <div className="section-stack">
              <article className="card glass">
                <div className="head"><h2>Player accounts ({playersTotal})</h2><button className="link-btn" type="button" onClick={()=>loadPlayers(playerSearch)}>Reload</button></div>
                <form className="inline-form" onSubmit={searchPlayers} style={{ marginBottom: 14 }}>
                  <label className="field" style={{ flex: 1, minWidth: 220 }}><span>Search</span><input className="input" value={playerSearch} onChange={(e)=>setPlayerSearch(e.target.value)} placeholder="Search username, phone or email" /></label>
                  <button className="btn-primary" type="submit">Search</button>
                </form>
                {playersLoading ? <div className="empty">Loading...</div> : players.length === 0 ? <div className="empty">{playerSearch.trim() ? "No players match that search." : "No player accounts yet."}</div> : (
                  <div className="list">
                    {players.map((p)=>{
                      const isEditing = editingPlayerId === p.id && playerDraft;
                      return (
                        <div className="row-card" key={p.id}>
                          {isEditing ? (
                            <div className="form-grid" style={{ width: "100%" }}>
                              <input className="input" value={playerDraft!.userName} onChange={(e)=>setPlayerDraft({...playerDraft!,userName:e.target.value})} placeholder="Username" />
                              <input className="input" value={playerDraft!.phoneNumber} onChange={(e)=>setPlayerDraft({...playerDraft!,phoneNumber:e.target.value})} placeholder="Phone number" />
                              <input className="input" type="email" value={playerDraft!.email} onChange={(e)=>setPlayerDraft({...playerDraft!,email:e.target.value})} placeholder="Email" />
                              <input className="input" type="password" value={playerDraft!.password} onChange={(e)=>setPlayerDraft({...playerDraft!,password:e.target.value})} placeholder="New password (optional)" autoComplete="new-password" />
                              <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><input type="checkbox" checked={playerDraft!.isBanned} onChange={(e)=>setPlayerDraft({...playerDraft!,isBanned:e.target.checked})} /> Suspended</label>
                              {playerDraft!.isBanned && <input className="input" value={playerDraft!.banReason} onChange={(e)=>setPlayerDraft({...playerDraft!,banReason:e.target.value})} placeholder="Reason for suspension" />}
                              <div className="inline-form"><button type="button" className="btn-primary" disabled={savingPlayer} onClick={()=>savePlayer(p)}>{savingPlayer?"Saving...":"Save"}</button><button type="button" className="btn-ghost" disabled={savingPlayer} onClick={cancelPlayerEdit}>Cancel</button></div>
                            </div>
                          ) : (
                            <>
                              <div className="row-main">
                                <div className="row-title">{p.userName} {p.isBanned && <span className="status st-REJECTED">Suspended</span>} {p.isGuest && <span className="status st-SCHEDULED">Guest</span>}</div>
                                <div className="row-meta">{p.phoneNumber || "no phone"}{p.email ? ` · ${p.email}` : ""}</div>
                                <div className="row-meta">wallet {money(p.balance)} MWK{p.held > 0 ? ` · held ${money(p.held)} MWK` : ""}</div>
                                {p.banReason && <div className="row-meta" style={{color:"var(--amber)"}}>reason: {p.banReason}</div>}
                                <div className="row-meta mono">id: {p.id}</div>
                                {p.lastLoginAt && <div className="row-meta">last seen {formatAt(p.lastLoginAt)}</div>}
                              </div>
                              <div className="row-actions">
                                <button type="button" className="btn-warn" onClick={()=>{ setCreditUserId(p.id); window.scrollTo({top:document.body.scrollHeight, behavior:"smooth"}); }}>Credit</button>
                                <button type="button" className="btn-warn" onClick={()=>startPlayerEdit(p)}>Edit</button>
                                <button type="button" className={p.isBanned?"btn-primary":"btn-danger"} disabled={playerBusyId===p.id} onClick={()=>togglePlayerBan(p)}>{playerBusyId===p.id?"...":(p.isBanned?"Unban":"Suspend")}</button>
                                <button type="button" className="btn-danger" disabled={playerBusyId===p.id} onClick={()=>deletePlayer(p)}>Delete</button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </article>

              <article className="card glass">
                <div className="head"><h2>Adjust player balance</h2></div>
                <p className="note">Use a positive amount to credit, negative to debit. Every adjustment is audited.</p>
                <form onSubmit={applyCredit} className="form-grid" style={{ marginTop: 12 }}>
                  <label className="field"><span>Player userId</span><input className="input mono" value={creditUserId} onChange={(e)=>setCreditUserId(e.target.value)} placeholder="user id" /></label>
                  <label className="field"><span>Amount (MWK)</span><input className="input" type="number" step="0.01" value={creditAmount} onChange={(e)=>setCreditAmount(e.target.value)} placeholder="e.g. 500 or -200" /></label>
                  <label className="field" style={{ gridColumn: "1 / -1" }}><span>Reason (required)</span><input className="input" value={creditReason} onChange={(e)=>setCreditReason(e.target.value)} placeholder="Why this adjustment is being made" /></label>
                  <div className="field" style={{ justifyContent: "flex-end" }}><button className="btn-primary" disabled={creditBusy} type="submit">{creditBusy?"Applying...":"Apply adjustment"}</button></div>
                </form>
              </article>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
