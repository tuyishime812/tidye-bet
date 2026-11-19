import React from "react";
import axios from "axios";
import { toast } from "react-toastify";
import Context from "../../context";
import { config } from "../../config";
import "./wallet.scss";

interface WalletAccount {
  userId?: string;
  balance: number;
  held: number;
  available: number;
  currency?: string;
  payoutPhone: string | null;
}

interface DepositRecord {
  id: string;
  amount: number;
  status: "PENDING" | "COMPLETED" | "FAILED" | "EXPIRED";
  method?: string;
  provider_ref?: string;
  created_at: string;
  gateway_ref?: string | null;
}

interface WithdrawalRecord {
  id: string;
  amount: number;
  fee: number;
  net_amount: number;
  method: string;
  status: "PENDING" | "PAID" | "REJECTED" | "CANCELLED";
  rejection_reason?: string | null;
  created_at: string;
}

interface StatementRow {
  amount: number;
  heldDelta: number;
  balanceAfter: number;
  reason: string;
  reference: string | null;
  at: string;
}

const REASON_LABEL: Record<string, string> = {
  DEPOSIT: "Deposit",
  WITHDRAWAL_HOLD: "Withdrawal requested",
  WITHDRAWAL_REFUND: "Withdrawal returned",
  WITHDRAWAL_PAID: "Withdrawal paid out",
  BET_ACCEPTED: "Stake placed",
  BET_REFUND: "Stake refunded",
  BET_PAYOUT: "Winnings paid",
  ADMIN_CREDIT: "Balance adjustment (credit)",
  ADMIN_DEBIT: "Balance adjustment (debit)",
};

const WITHDRAWAL_STATUS_LABEL: Record<string, string> = {
  PENDING: "Processing",
  PAID: "Paid",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

const fmt = (n: number) =>
  Number.isFinite(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "0.00";

const token = () =>
  localStorage.getItem("authToken") ||
  localStorage.getItem("token") ||
  "";

type DepositSession = {
  txRef: string;
  checkoutUrl: string | null;
  mode?: "checkout" | "mobile_money";
  message?: string | null;
  status: "PENDING" | "COMPLETED" | "FAILED" | "EXPIRED";
  amount: number;
};

export default function Wallet() {
  const { walletOpen, closeWallet, isAuthenticated, openAuthModal, refreshUser, logout } =
    React.useContext(Context) as any;

  const [tab, setTab] = React.useState<"DEPOSIT" | "WITHDRAW" | "HISTORY">("DEPOSIT");
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [acct, setAcct] = React.useState<WalletAccount | null>(null);
  const [deposits, setDeposits] = React.useState<DepositRecord[]>([]);
  const [withdrawals, setWithdrawals] = React.useState<WithdrawalRecord[]>([]);
  const [statement, setStatement] = React.useState<StatementRow[]>([]);

  const [depositAmount, setDepositAmount] = React.useState("5000");
  const [depositMethod, setDepositMethod] = React.useState<"mpamba" | "airtel_money">("mpamba");
  const [depositPhone, setDepositPhone] = React.useState("");
  const [creatingDeposit, setCreatingDeposit] = React.useState(false);
  const [depositSession, setDepositSession] = React.useState<DepositSession | null>(null);
  const [paymentModalOpen, setPaymentModalOpen] = React.useState(false);
  const [paymentStatus, setPaymentStatus] = React.useState<"loading" | "ready" | "success" | "failed">("loading");
  // After a few seconds of waiting the spinner stops; the modal then shows a
  // calmer "still confirming" state so it never looks stuck forever.
  const [confirmSlow, setConfirmSlow] = React.useState(false);
  const [depositCheckNonce, setDepositCheckNonce] = React.useState(0);
  const depositPresets = [1000, 5000, 10000, 50000];

  const [withdrawAmount, setWithdrawAmount] = React.useState("");
  const [withdrawMethod, setWithdrawMethod] = React.useState("mpamba");
  const [payoutPhone, setPayoutPhone] = React.useState("");
  const [savingPhone, setSavingPhone] = React.useState(false);
  const [creatingWithdrawal, setCreatingWithdrawal] = React.useState(false);

  const loadAll = React.useCallback(async () => {
    if (!token()) {
      setAcct(null);
      setDeposits([]);
      setWithdrawals([]);
      setStatement([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    try {
      const auth = { headers: { Authorization: `Bearer ${token()}` } };
      const [walletRes, depRes, wdRes, stRes] = await Promise.all([
        axios.get(`${config.development_api}/payments/wallet`, auth),
        axios.get(`${config.development_api}/payments/deposits`, auth),
        axios.get(`${config.development_api}/payments/withdrawals`, auth),
        axios.get(`${config.development_api}/payments/statement`, auth),
      ]);
      if (walletRes.data.status) {
        setAcct(walletRes.data.data);
        if (walletRes.data.data.payoutPhone) setPayoutPhone(walletRes.data.data.payoutPhone);
      }
      if (depRes.data.status) setDeposits(depRes.data.data || []);
      if (wdRes.data.status) setWithdrawals(wdRes.data.data || []);
      if (stRes.data.status) setStatement(stRes.data.data || []);
    } catch (error: any) {
      if (error?.response?.status === 401) {
        setAcct(null);
        toast.error("Please log in to view your wallet");
      } else {
        toast.error("Could not load wallet information");
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    if (walletOpen && isAuthenticated) {
      setLoading(true);
      loadAll();
    }
  }, [walletOpen, isAuthenticated, loadAll]);

  React.useEffect(() => {
    if (!walletOpen || !isAuthenticated) return;
    const params = new URLSearchParams(window.location.search);
    const txRef = params.get("tx_ref") || params.get("txRef");
    if (!txRef) return;
    setDepositSession({ txRef, checkoutUrl: null, status: "PENDING", amount: 0 });
    setPaymentModalOpen(true);
    setPaymentStatus("ready");
    params.delete("tx_ref");
    params.delete("txRef");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }, [walletOpen, isAuthenticated]);

  React.useEffect(() => {
    if (!paymentModalOpen || paymentStatus !== "ready") {
      setConfirmSlow(false);
      return;
    }
    setConfirmSlow(false);
    const timer = window.setTimeout(() => setConfirmSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [paymentModalOpen, paymentStatus, depositSession?.txRef]);

  React.useEffect(() => {
    if (!depositSession || !isAuthenticated) return;
    if (depositSession.status !== "PENDING") return;
    const txRef = depositSession.txRef;
    // Direct mobile-money charges only settle through the charge-verify
    // endpoint; telling the server which mode we created lets it ask the right
    // gateway endpoint first instead of always paying for a failed lookup.
    const modeParam = depositSession.mode
      ? `?mode=${encodeURIComponent(depositSession.mode)}`
      : "";
    let cancelled = false;
    let timer: number | null = null;
    let inFlight = false;

    const tick = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      let keepPolling = true;
      try {
        const res = await axios.get(
          `${config.development_api}/payments/deposits/${txRef}/status${modeParam}`,
          { headers: { Authorization: `Bearer ${token()}` }, timeout: 10000 }
        );
        const status: DepositSession["status"] = res.data?.data?.status || "PENDING";
        const credited = Boolean(res.data?.data?.credited);
        if (cancelled) return;

        setDepositSession((prev) => {
          if (!prev) return prev;
          const nextStatus = status === "COMPLETED" || credited ? "COMPLETED" : status;
          return prev.status === nextStatus ? prev : { ...prev, status: nextStatus };
        });

        if (status === "COMPLETED" || credited) {
          setPaymentStatus("success");
          toast.success("Deposit confirmed! Your wallet has been updated.");
          // Update wallet data and global betting balance immediately.
          void Promise.allSettled([loadAll(), refreshUser()]);
          window.setTimeout(() => {
            setPaymentModalOpen(false);
            setDepositSession(null);
            setPaymentStatus("loading");
          }, 1200);
          keepPolling = false;
          return;
        }
        if (status === "FAILED" || status === "EXPIRED") {
          setPaymentStatus("failed");
          toast.error("The payment failed or was cancelled");
          void Promise.allSettled([loadAll(), refreshUser()]);
          keepPolling = false;
          return;
        }
      } catch (error: any) {
        if (error?.response?.status === 401) {
          setDepositSession(null);
          setPaymentModalOpen(false);
          keepPolling = false;
          return;
        }
        // keep polling on transient/network/gateway-pending errors
      } finally {
        inFlight = false;
        if (!cancelled && keepPolling) timer = window.setTimeout(tick, 1000);
      }
    };

    // Poll immediately, then every second so the balance updates as soon as
    // the network confirms. Also re-check the instant the player returns to
    // the tab (e.g. after approving the prompt on their phone).
    const kick = () => {
      if (cancelled || inFlight) return;
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
      void tick();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") kick();
    };
    window.addEventListener("focus", kick);
    document.addEventListener("visibilitychange", onVisibility);

    timer = window.setTimeout(tick, depositCheckNonce ? 0 : 300);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", kick);
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) window.clearTimeout(timer);
    };
  }, [depositSession, isAuthenticated, loadAll, refreshUser, depositCheckNonce]);

  const startDeposit = async () => {
    const amount = Number(depositAmount.replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    const phone = depositPhone.trim().replace(/\s/g, "");
    if (!/^(265\d{9}|0\d{9}|\+265\d{9})$/.test(phone)) {
      toast.error("Enter a valid Malawian mobile number (e.g. 0991234567)");
      return;
    }
    setCreatingDeposit(true);
    setPaymentStatus("loading");
    try {
      const res = await axios.post(
        `${config.development_api}/payments/deposits`,
        { amount, provider: "paychangu", method: depositMethod, phoneNumber: phone },
        { headers: { Authorization: `Bearer ${token()}` } }
      );
      if (res.data.status) {
        const data = res.data.data as {
          token: string;
          checkoutUrl?: string | null;
          mode?: "checkout" | "mobile_money";
          message?: string | null;
        };
        const txRef = data.token;
        const checkoutUrl = data.checkoutUrl || null;
        const mode = data.mode || (checkoutUrl ? "checkout" : "mobile_money");
        setDepositSession({
          txRef,
          checkoutUrl,
          mode,
          message: data.message || null,
          status: "PENDING",
          amount,
        });
        setPaymentModalOpen(true);
        setPaymentStatus("ready");
        toast.info(
          mode === "mobile_money"
            ? "Payment prompt sent to your phone. Enter your PIN to confirm."
            : "Secure payment opened. Complete it to update your balance."
        );
      } else {
        toast.error(res.data.message || "Could not start the deposit");
        setPaymentStatus("loading");
      }
    } catch (error: any) {
      if (error?.response?.status === 401) {
        toast.error("Your session has expired. Please log in again.");
        closeWallet();
        if (typeof logout === "function") logout();
        else if (typeof openAuthModal === "function") openAuthModal("Log in to continue", "login");
      } else {
        toast.error(error?.response?.data?.message || "Could not start the deposit");
      }
      setPaymentStatus("loading");
    } finally {
      setCreatingDeposit(false);
    }
  };

  const savePayoutPhone = async () => {
    const trimmed = payoutPhone.trim();
    if (!/^(265\d{9}|0\d{9}|\+265\d{9})$/.test(trimmed.replace(/\s/g, ""))) {
      toast.error("Enter a valid Malawian mobile number (e.g. 991234567)");
      return;
    }
    setSavingPhone(true);
    try {
      const res = await axios.patch(
        `${config.development_api}/auth/me`,
        { payoutPhone: trimmed },
        { headers: { Authorization: `Bearer ${token()}` } }
      );
      if (res.data.status) {
        setAcct((prev) => (prev ? { ...prev, payoutPhone: res.data.data.payoutPhone } : prev));
        setPayoutPhone(res.data.data.payoutPhone);
        toast.success("Payout phone registered");
      } else {
        toast.error(res.data.message || "Could not register the phone");
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Could not register the phone");
    } finally {
      setSavingPhone(false);
    }
  };

  const requestWithdrawal = async () => {
    const amount = Number(withdrawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid withdrawal amount");
      return;
    }
    if (!acct?.payoutPhone) {
      toast.error("Register your payout phone first");
      return;
    }
    setCreatingWithdrawal(true);
    try {
      const res = await axios.post(
        `${config.development_api}/payments/withdrawals`,
        { amount, method: withdrawMethod, phoneNumber: acct.payoutPhone },
        { headers: { Authorization: `Bearer ${token()}` } }
      );
      if (res.data.status) {
        toast.success(res.data.data?.message || "Withdrawal requested");
        setWithdrawAmount("");
        await loadAll();
        refreshUser();
      } else {
        toast.error(res.data.message || "Could not request the withdrawal");
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Could not request the withdrawal");
    } finally {
      setCreatingWithdrawal(false);
    }
  };

  const cancelWithdrawal = async (id: string) => {
    try {
      const res = await axios.post(
        `${config.development_api}/payments/withdrawals/${id}/cancel`,
        {},
        { headers: { Authorization: `Bearer ${token()}` } }
      );
      if (res.data.status) {
        toast.success("Withdrawal cancelled");
        await loadAll();
        refreshUser();
      } else {
        toast.error(res.data.message || "Could not cancel the withdrawal");
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Could not cancel the withdrawal");
    }
  };

  if (!walletOpen) return null;

  const available = acct?.available ?? 0;
  const held = acct?.held ?? 0;
  const total = (acct?.balance ?? 0) + held;
  const amountNum = Number(depositAmount.replace(/,/g, "")) || 0;

  if (!isAuthenticated) {
    return (
      <div className="wallet-modal" role="dialog" aria-modal="true">
        <div className="wallet-backdrop" onClick={closeWallet} />
        <div className="wallet-dialog wallet-dialog--design" onClick={(e) => e.stopPropagation()}>
          <div className="wd-header">
            <h1 className="wd-title">Wallet</h1>
            <button className="wd-icon-btn" aria-label="Close" onClick={closeWallet}>×</button>
          </div>
          <div className="wd-body wd-body--center">
            <p className="wd-muted">Log in or create an account to deposit, withdraw and track your balance.</p>
            <div className="wd-row">
              <button className="wd-primary" onClick={() => { closeWallet(); openAuthModal("Access your wallet", "login"); }}>Log in</button>
              <button className="wd-secondary" onClick={() => { closeWallet(); openAuthModal("Create an account to get started", "register"); }}>Create account</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wallet-modal" role="dialog" aria-modal="true">
      <div className="wallet-backdrop" onClick={closeWallet} />
      <div className="wallet-dialog wallet-dialog--design" onClick={(e) => e.stopPropagation()}>
        <div className="wd-header">
          <h1 className="wd-title">Wallet</h1>
          <button className="wd-icon-btn" aria-label="Close" onClick={closeWallet}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>

        <div className="wd-balance">
          <div className="wd-balance-main">
            <span className="wd-label">Available balance</span>
            <div className="wd-balance-amount"><span>{fmt(available)}</span><span className="wd-currency">MWK</span></div>
          </div>
          <div className="wd-stats">
            <div className="wd-stat"><div className="wd-stat-label">Held for withdrawal</div><div className="wd-stat-value">{fmt(held)} <span>MWK</span></div></div>
            <div className="wd-stat"><div className="wd-stat-label">Total on account</div><div className="wd-stat-value">{fmt(total)} <span>MWK</span></div></div>
          </div>
        </div>

        <div className="wd-tabs">
          <div className="wd-tab-group">
            {(["DEPOSIT","WITHDRAW","HISTORY"] as const).map((t) => (
              <button key={t} className={`wd-tab ${tab===t?"active":""}`} onClick={() => setTab(t)}>
                {t === "DEPOSIT" ? "Deposit" : t === "WITHDRAW" ? "Withdraw" : "History"}
              </button>
            ))}
          </div>
          <button className="wd-icon-btn" aria-label="Refresh balance" onClick={loadAll} disabled={refreshing}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>
          </button>
        </div>

        <div className="wd-body">
          {loading ? (
            <div className="wd-loading" role="status" aria-live="polite">
              <div className="wd-loading-top">
                <div className="wd-skel wd-skel-amount" />
                <div className="wd-skel-row">
                  <div className="wd-skel wd-skel-stat" />
                  <div className="wd-skel wd-skel-stat" />
                </div>
              </div>
              <div className="wd-loading-mid">
                <span className="wd-spinner wd-spinner--lg" />
                <span>Loading your wallet</span>
              </div>
              <div className="wd-skel wd-skel-block" />
              <div className="wd-skel wd-skel-block short" />
            </div>
          ) : tab === "DEPOSIT" ? (
            <div className="wd-stack">
              <div className="wd-field">
                <label className="wd-label" htmlFor="wd-amt">Amount</label>
                <div className="wd-amount-input">
                  <span className="wd-currency-prefix">MWK</span>
                  <input id="wd-amt" inputMode="numeric" value={depositAmount ? Number(depositAmount).toLocaleString() : ""} onChange={(e) => setDepositAmount(e.target.value.replace(/[^0-9]/g, ""))} placeholder="0" />
                </div>
                <div className="wd-presets">
                  {depositPresets.map((p) => (
                    <button key={p} type="button" className={`wd-preset ${amountNum===p?"active":""}`} onClick={() => setDepositAmount(String(p))}>
                      {p.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>

              <div className="wd-field">
                <span className="wd-label">Payment method</span>
                <div className="wd-methods">
                  <button type="button" className={`wd-method ${depositMethod === "mpamba" ? "active" : ""}`} onClick={() => setDepositMethod("mpamba")}>MPamba</button>
                  <button type="button" className={`wd-method ${depositMethod === "airtel_money" ? "active" : ""}`} onClick={() => setDepositMethod("airtel_money")}>Airtel Money</button>
                </div>
                <div className="wd-field wd-field--compact">
                  <label className="wd-label" htmlFor="wd-pay-phone">{depositMethod === "mpamba" ? "MPamba number" : "Airtel Money number"}</label>
                  <input
                    id="wd-pay-phone"
                    className="wd-input"
                    inputMode="tel"
                    value={depositPhone}
                    onChange={(e) => setDepositPhone(e.target.value)}
                    placeholder={depositMethod === "mpamba" ? "e.g. 0881234567" : "e.g. 0991234567"}
                  />
                  <p className="wd-hint">Enter the number to pay with. You’ll receive a payment prompt on your phone to confirm with your PIN.</p>
                </div>
              </div>

              <div className="wd-total-row"><span>Total to pay</span><strong>{fmt(amountNum)} MWK</strong></div>

              <div className="wd-stack-sm">
                <button className="wd-primary wd-primary--cta" onClick={startDeposit} disabled={creatingDeposit || amountNum <= 0}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
                  {creatingDeposit ? "Sending payment prompt…" : "Send payment prompt"}
                </button>
                <p className="wd-hint wd-center">A payment prompt will be sent to your {depositMethod === "mpamba" ? "MPamba" : "Airtel Money"} number.<br/>Enter your PIN on your phone; your balance updates automatically once confirmed.</p>
              </div>

              {deposits.length > 0 && (
                <div className="wd-section">
                  <div className="wd-section-title">Recent deposits</div>
                  <div className="wd-list">
                    {deposits.slice(0,5).map((d) => (
                      <div className="wd-list-row" key={d.id}>
                        <div><div className="wd-list-amount">{fmt(d.amount)} MWK</div><div className="wd-list-meta">{new Date(d.created_at).toLocaleString()}</div></div>
                        <span className={`wd-badge wd-badge--${d.status.toLowerCase()}`}>{d.status}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : tab === "WITHDRAW" ? (
            <div className="wd-stack">
              <div className="wd-field">
                <span className="wd-label">Payout phone (registered)</span>
                <div className="wd-inline">
                  <input className="wd-input" value={payoutPhone} onChange={(e) => setPayoutPhone(e.target.value)} placeholder="e.g. 0991234567" />
                  <button className="wd-secondary" onClick={savePayoutPhone} disabled={savingPhone}>{savingPhone ? "Saving…" : "Save"}</button>
                </div>
                {acct?.payoutPhone && <p className="wd-hint">Withdrawals are sent only to your registered number: <strong>{acct.payoutPhone}</strong></p>}
              </div>
              <div className="wd-field">
                <label className="wd-label">Amount</label>
                <input className="wd-input" inputMode="decimal" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} placeholder="Amount in MWK" />
              </div>
              <div className="wd-field">
                <span className="wd-label">Method</span>
                <div className="wd-methods">
                  <button type="button" className={`wd-method ${withdrawMethod==="mpamba"?"active":""}`} onClick={()=>setWithdrawMethod("mpamba")}>MPamba</button>
                  <button type="button" className={`wd-method ${withdrawMethod==="airtel_money"?"active":""}`} onClick={()=>setWithdrawMethod("airtel_money")}>Airtel Money</button>
                </div>
              </div>
              <button className="wd-primary wd-primary--cta" onClick={requestWithdrawal} disabled={creatingWithdrawal}>{creatingWithdrawal ? "Requesting…" : "Request withdrawal"}</button>
              {withdrawals.length > 0 && (
                <div className="wd-section">
                  <div className="wd-section-title">Recent withdrawals</div>
                  <div className="wd-list">
                    {withdrawals.slice(0,6).map((w) => (
                      <div className="wd-list-row" key={w.id}>
                        <div><div className="wd-list-amount">{fmt(w.amount)} MWK</div><div className="wd-list-meta">{w.method} · {new Date(w.created_at).toLocaleString()}{w.rejection_reason ? ` · ${w.rejection_reason}` : ""}</div></div>
                        <div className="wd-list-actions">
                          <span className={`wd-badge wd-badge--${w.status.toLowerCase()}`}>{WITHDRAWAL_STATUS_LABEL[w.status] || w.status}</span>
                          {w.status === "PENDING" && <button className="wd-link" onClick={() => cancelWithdrawal(w.id)}>Cancel</button>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="wd-stack">
              <div className="wd-section-title">Statement</div>
              {statement.length === 0 ? <div className="wd-muted">No transactions yet.</div> : (
                <div className="wd-list">
                  {statement.slice(0,30).map((s, i) => (
                    <div className="wd-list-row" key={i}>
                      <div><div className="wd-list-amount">{REASON_LABEL[s.reason] || s.reason}</div><div className="wd-list-meta">{new Date(s.at).toLocaleString()}</div></div>
                      <div className={`wd-amt ${s.amount >= 0 ? "pos":"neg"}`}>{s.amount >= 0 ? "+" : ""}{fmt(s.amount)} MWK</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {paymentModalOpen && depositSession && (
          <div className="wd-pay-overlay" onClick={() => { if (paymentStatus === "ready" && !window.confirm("Close the payment window? If you already paid, we’ll still confirm it.")) return; setPaymentModalOpen(false); if (paymentStatus !== "ready") { setDepositSession(null); setPaymentStatus("loading"); } }}>
            <div className="wd-pay-modal" onClick={(e)=>e.stopPropagation()}>
              <div className="wd-pay-head">
                <div>
                  <div className="wd-pay-title">Secure payment</div>
                  <div className="wd-pay-sub">MPamba / Airtel Money · {fmt(depositSession.amount || amountNum)} MWK</div>
                </div>
                <button className="wd-icon-btn" onClick={() => setPaymentModalOpen(false)} aria-label="Close payment window"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
              </div>
              <div className="wd-pay-body">
                {paymentStatus === "success" ? (
                  <div className="wd-pay-state success"><div className="wd-pay-big">Payment confirmed</div><p>Your balance has been updated.</p></div>
                ) : paymentStatus === "failed" ? (
                  <div className="wd-pay-state failed"><div className="wd-pay-big">Payment not completed</div><p>The payment failed or was cancelled. You can try again.</p><button className="wd-primary" onClick={() => { setPaymentModalOpen(false); setDepositSession(null); setPaymentStatus("loading"); }}>Close</button></div>
                ) : depositSession.checkoutUrl ? (
                  <>
                    <div className="wd-pay-note">Complete your payment below. We'll confirm automatically once the gateway approves it.</div>
                    <iframe title="Secure payment" src={depositSession.checkoutUrl} className="wd-pay-frame" allow="payment *" />
                    <div className="wd-pay-foot">
                      {confirmSlow ? (
                        <>
                          <span>Still waiting for confirmation…</span>
                          <button type="button" className="wd-check-btn" onClick={() => setDepositCheckNonce((n) => n + 1)}>Check again</button>
                        </>
                      ) : (
                        <><span className="wd-spinner"/> Waiting for confirmation...</>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="wd-pay-state">
                    {confirmSlow ? (
                      <div className="wd-pay-wait" aria-hidden="true">
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                      </div>
                    ) : (
                      <div className="wd-spinner wd-spinner--lg"/>
                    )}
                    <div className="wd-pay-big">{confirmSlow ? "Still confirming" : "Check your phone"}</div>
                    <p>{confirmSlow
                      ? "If you have already paid, we are waiting for the mobile network to confirm it. This usually takes a moment."
                      : (depositSession.message || "A payment prompt has been sent to your mobile money number. Enter your PIN on your phone to confirm.")}</p>
                    <div className="wd-pay-foot">
                      {confirmSlow ? (
                        <>
                          <span>No need to pay again.</span>
                          <button type="button" className="wd-check-btn" onClick={() => setDepositCheckNonce((n) => n + 1)}>Check again</button>
                        </>
                      ) : (
                        <><span className="wd-spinner"/> Waiting for confirmation...</>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
