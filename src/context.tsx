/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect } from "react";
import { UnityContext } from "react-unity-webgl";
import { io } from "socket.io-client";
import { toast } from "react-toastify";
import { config } from "./config";

export interface BettedUserType {
  name: string;
  betAmount: number;
  cashOut: number;
  cashouted: boolean;
  target: number;
  img: string;
}

export interface UserType {
  balance: number;
  userType: boolean;
  img: string;
  userName: string;
  avatar: string;
  userId: string;
  currency: string;
  ipAddress: string;
  platform: string;
  token: string;
  Session_Token: string;
  isSoundEnable: boolean;
  isMusicEnable: boolean;
  msgVisible: boolean;
  f: {
    auto: boolean;
    autocashout: boolean;
    betid: string;
    betted: boolean;
    cashouted: boolean;
    betAmount: number;
    cashAmount: number;
    target: number;
  };
  s: {
    auto: boolean;
    autocashout: boolean;
    betid: string;
    betted: boolean;
    cashouted: boolean;
    betAmount: number;
    cashAmount: number;
    target: number;
  };
  // Panels f/s/t/q are all materialised by createDefaultUserInfo() and
  // enrichUserShape(), so they are required here. Keeping t/q optional forced
  // every call site into `as any` casts and hid genuine undefined access.
  t: {
    auto: boolean;
    autocashout: boolean;
    betid: string;
    betted: boolean;
    cashouted: boolean;
    betAmount: number;
    cashAmount: number;
    target: number;
  };
  q: {
    auto: boolean;
    autocashout: boolean;
    betid: string;
    betted: boolean;
    cashouted: boolean;
    betAmount: number;
    cashAmount: number;
    target: number;
  };
}

export interface PlayerType {
  auto: boolean;
  betted: boolean;
  cashouted: boolean;
  betAmount: number;
  cashAmount: number;
  target: number;
}

interface GameStatusType {
  currentNum: number;
  currentSecondNum: number;
  GameState: string;
  time: number;
}

interface GameBetLimit {
  maxBet: number;
  minBet: number;
}

declare interface GameHistory {
  _id: number;
  name: string;
  betAmount: number;
  cashoutAt: number;
  cashouted: boolean;
  date: number;
  createdAt: number;
  flyAway: number;
  flyDetailID: string;
}

interface UserStatusType {
  fbetState: boolean;
  fbetted: boolean;
  sbetState: boolean;
  sbetted: boolean;
  tbetState: boolean;
  tbetted: boolean;
  qbetState: boolean;
  qbetted: boolean;
}

/**
 * Authentication surface.
 *
 * The platform no longer auto-creates a guest account on load. Players browse
 * the game lobby and the football fixture list anonymously and are prompted to
 * log in only at the moment they try to place a bet (CWE-306).
 */
interface AuthStateType {
  isAuthenticated: boolean;
  authReady: boolean;
  authModalOpen: boolean;
  authReason: string;
  authMode: "login" | "register";
  openAuthModal: (reason?: string, mode?: "login" | "register") => void;
  closeAuthModal: () => void;
  login: (token: string, user: any) => void;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

interface ContextDataType {
  myBets: GameHistory[];
  width: number;
  /** The player's chosen client seed (NOT the server seed hash). */
  seed: string;
  /** SHA256 hash of the server seed for the current round. */
  serverSeedHash: string;
  userInfo: UserType;
  fautoCashoutState: boolean;
  fautoCound: number;
  finState: boolean;
  fdeState: boolean;
  fsingle: boolean;
  fincrease: number;
  fdecrease: number;
  fsingleAmount: number;
  fdefaultBetAmount: number;
  sautoCashoutState: boolean;
  sautoCound: number;
  sincrease: number;
  sdecrease: number;
  ssingleAmount: number;
  sinState: boolean;
  sdeState: boolean;
  ssingle: boolean;
  sdefaultBetAmount: number;
  tautoCashoutState: boolean;
  tautoCound: number;
  tincrease: number;
  tdecrease: number;
  tsingleAmount: number;
  tinState: boolean;
  tdeState: boolean;
  tsingle: boolean;
  tdefaultBetAmount: number;
  qautoCashoutState: boolean;
  qautoCound: number;
  qincrease: number;
  qdecrease: number;
  qsingleAmount: number;
  qinState: boolean;
  qdeState: boolean;
  qsingle: boolean;
  qdefaultBetAmount: number;
  myUnityContext: UnityContext;
}

interface ContextType extends GameBetLimit, UserStatusType, GameStatusType, AuthStateType {
  state: ContextDataType;
  unityState: boolean;
  unityLoading: boolean;
  currentProgress: number;
  bettedUsers: BettedUserType[];
  previousHand: UserType[];
  history: number[];
  rechargeState: boolean;
  myUnityContext: UnityContext;
  currentTarget: number;
  userInfo: UserType;
  socket: any;
  msgTab: boolean;
  msgReceived: boolean;
  msgData: any;
  setMsgReceived: React.Dispatch<React.SetStateAction<boolean>>;
  setMsgData: React.Dispatch<React.SetStateAction<any>>;
  walletOpen: boolean;
  openWallet: () => void;
  closeWallet: () => void;
  profileOpen: boolean;
  openProfile: () => void;
  closeProfile: () => void;
  toggleMsgTab: () => void;
  handleChangeUserSeed: (seed: string) => void;
  handleGetSeed: (id?: string) => void;
  handleGetSeedOfRound: (id: string) => Promise<{
    createdAt: number;
    serverSeed: string;
    serverSeedHash: string;
    clientSeeds: string[];
    crashPoint: number;
  }>;
  updateUserInfo: (attrs: Partial<UserType>) => void;
  setCurrentTarget(attrs: Partial<number>);
  update(attrs: Partial<ContextDataType>);
  getMyBets();
  userBetState: UserStatusType;
  updateUserBetState(attrs: Partial<UserStatusType>);
}

/**
 * Build a pristine bet-panel state. Returned fresh each call so that resetting
 * the session can never mutate the shared module-level defaults.
 */
const createDefaultPanel = () => ({
  auto: false,
  autocashout: false,
  betid: "0",
  betted: false,
  cashouted: false,
  cashAmount: 0,
  betAmount: 20,
  target: 2,
});

/** A fresh, empty user record. */
const createDefaultUserInfo = () => ({
  balance: 0,
  userType: false,
  img: "",
  userName: "",
  avatar: "",
  userId: "",
  currency: "MWK",
  ipAddress: "",
  platform: "",
  token: "",
  Session_Token: "",
  isSoundEnable: false,
  isMusicEnable: false,
  msgVisible: false,
  f: createDefaultPanel(),
  s: createDefaultPanel(),
  t: createDefaultPanel(),
  q: createDefaultPanel(),
});

/**
 * Merge a server user record over the defaults, guaranteeing the nested bet
 * panels always exist. Guards against a malformed API response producing an
 * undefined access crash deeper in the bet panel.
 */
const enrichUserShape = (user: any) => ({
  ...createDefaultUserInfo(),
  ...user,
  f: { ...createDefaultPanel(), ...(user && user.f) },
  s: { ...createDefaultPanel(), ...(user && user.s) },
  t: { ...createDefaultPanel(), ...(user && user.t) },
  q: { ...createDefaultPanel(), ...(user && user.q) },
  balance: Number(user && user.balance) || 0,
});

const unityContext = new UnityContext({
  loaderUrl: "unity/AirCrash.loader.js",
  dataUrl: "unity/AirCrash.data.unityweb",
  frameworkUrl: "unity/AirCrash.framework.js.unityweb",
  codeUrl: "unity/AirCrash.wasm.unityweb",
});

const init_state = {
  myBets: [],
  width: 1500,
  seed: "",
  serverSeedHash: "",
  userInfo: createDefaultUserInfo(),
  fautoCashoutState: false,
  fautoCound: 0,
  finState: false,
  fdeState: false,
  fsingle: false,
  fincrease: 0,
  fdecrease: 0,
  fsingleAmount: 0,
  fdefaultBetAmount: 20,
  sautoCashoutState: false,
  sautoCound: 0,
  sincrease: 0,
  sdecrease: 0,
  ssingleAmount: 0,
  sinState: false,
  sdeState: false,
  ssingle: false,
  sdefaultBetAmount: 20,
  tautoCashoutState: false,
  tautoCound: 0,
  tincrease: 0,
  tdecrease: 0,
  tsingleAmount: 0,
  tinState: false,
  tdeState: false,
  tsingle: false,
  tdefaultBetAmount: 20,
  qautoCashoutState: false,
  qautoCound: 0,
  qincrease: 0,
  qdecrease: 0,
  qsingleAmount: 0,
  qinState: false,
  qdeState: false,
  qsingle: false,
  qdefaultBetAmount: 20,
  myUnityContext: unityContext,
} as ContextDataType;

const Context = React.createContext<ContextType>(null!);

let socket: any = null;

export const callCashOut = (at: number, index: "f" | "s" | "t" | "q") => {
  // INSTANT cashout - emit immediately. The token lets the server re-attach the
  // session if this socket lost its authenticate event (reconnect/remount).
  const authToken = localStorage.getItem("authToken");
  let data = { type: index, endTarget: at, ...(authToken ? { token: authToken } : {}) };
  socket.emit("cashOut", data);
  // Toast will show from backend response
};

let fIncreaseAmount = 0;
let fDecreaseAmount = 0;
let sIncreaseAmount = 0;
let sDecreaseAmount = 0;

let newState;
let newBetState;

export const Provider = ({ children }: any) => {
  const [state, setState] = React.useState<ContextDataType>(init_state);

  newState = state;
  const [unity, setUnity] = React.useState({
    unityState: false,
    unityLoading: false,
    currentProgress: 0,
  });
  const [gameState, setGameState] = React.useState({
    currentNum: 0,
    currentSecondNum: 0,
    GameState: "",
    time: 0,
  });

  const [bettedUsers, setBettedUsers] = React.useState<BettedUserType[]>([]);
  const update = (attrs: Partial<ContextDataType>) => {
    setState({ ...state, ...attrs });
  };
  const [previousHand, setPreviousHand] = React.useState<UserType[]>([]);
  const [history, setHistory] = React.useState<number[]>([]);
  const [userBetState, setUserBetState] = React.useState<UserStatusType>({
    fbetState: false,
    fbetted: false,
    sbetState: false,
    sbetted: false,
    tbetState: false,
    tbetted: false,
    qbetState: false,
    qbetted: false,
  });
  newBetState = userBetState;
  const [rechargeState, setRechargeState] = React.useState(false);
  const [currentTarget, setCurrentTarget] = React.useState(0);
  const updateUserBetState = (attrs: Partial<UserStatusType>) => {
    // Functional update: callers can set several panels in one tick (e.g.
    // "Bet All"). Spreading the captured `userBetState` let each call clobber
    // the previous one, so only the last panel was ever armed.
    setUserBetState((prev) => ({ ...prev, ...attrs }));
  };

  const [betLimit, setBetLimit] = React.useState<GameBetLimit>({
    maxBet: 1000,
    minBet: 1,
  });

  // Chat and messaging state
  const [msgTab, setMsgTab] = React.useState<boolean>(false);
  const [msgReceived, setMsgReceived] = React.useState<boolean>(false);
  const [msgData, setMsgData] = React.useState<any>(null);
  const toggleMsgTab = () => setMsgTab(!msgTab);

  // Wallet modal state. Owned here (not in the Header) so any surface - the
  // header button, the insufficient-balance prompt, the football page - can
  // open the same wallet.
  const [walletOpen, setWalletOpen] = React.useState(false);
  const openWallet = React.useCallback(() => setWalletOpen(true), []);
  const closeWallet = React.useCallback(() => setWalletOpen(false), []);

  // Account profile modal (opened from the header account menu).
  const [profileOpen, setProfileOpen] = React.useState(false);
  const openProfile = React.useCallback(() => setProfileOpen(true), []);
  const closeProfile = React.useCallback(() => setProfileOpen(false), []);

  // User info update function
  const updateUserInfo = (attrs: Partial<UserType>) => {
    setState({ ...state, userInfo: { ...state.userInfo, ...attrs } });
  };

  // ============================================
  // AUTHENTICATION
  // ============================================

  const [isAuthenticated, setIsAuthenticated] = React.useState(false);
  const [authReady, setAuthReady] = React.useState(false);
  const [authModalOpen, setAuthModalOpen] = React.useState(false);
  const [authReason, setAuthReason] = React.useState("");
  const [authMode, setAuthMode] = React.useState<"login" | "register">("login");

  /**
   * Open the login/signup modal, optionally explaining why and which tab to
   * show first. Calls without an explicit mode default to "login" so a
   * bet-triggered prompt always starts on the most common path.
   */
  const openAuthModal = React.useCallback((reason?: string, mode?: "login" | "register") => {
    setAuthReason(reason || "Log in or create an account to place bets.");
    setAuthMode(mode === "register" ? "register" : "login");
    setAuthModalOpen(true);
  }, []);

  const closeAuthModal = React.useCallback(() => {
    setAuthModalOpen(false);
    setAuthReason("");
  }, []);

  /** Persist a successful login and hydrate the shared user state. */
  const login = React.useCallback((token: string, user: any) => {
    const enriched = enrichUserShape(user);
    try {
      localStorage.setItem("authToken", token);
      localStorage.setItem("userInfo", JSON.stringify(enriched));
    } catch (error) {
      console.error("Failed to persist session", error);
    }
    setState((prev) => ({ ...prev, userInfo: { ...prev.userInfo, ...enriched } }));
    setIsAuthenticated(true);
    setAuthModalOpen(false);
    setAuthReason("");
    // Re-authenticate the live socket so bets are attributed to this account.
    if (socket && typeof socket.emit === "function") {
      socket.emit("authenticate", token);
      socket.emit("enterRoom", { token });
    }
  }, []);

  /** Clear the session and reset any per-round bet flags. */
  const logout = React.useCallback(() => {
    try {
      localStorage.removeItem("authToken");
      localStorage.removeItem("userInfo");
    } catch (error) {
      console.error("Failed to clear session", error);
    }
    setIsAuthenticated(false);
    setState((prev) => ({
      ...prev,
      userInfo: createDefaultUserInfo(),
    }));
    setUserBetState({ fbetState: false, fbetted: false, sbetState: false, sbetted: false, tbetState: false, tbetted: false, qbetState: false, qbetted: false });
    // Close any account surfaces so a logged-out visitor never lingers on an
    // authenticated-only pane.
    setProfileOpen(false);
    setWalletOpen(false);
    if (socket && typeof socket.emit === "function") {
      socket.emit("authenticate", null);
      socket.data = {};
    }
  }, []);

  /** Re-read the authoritative profile + balance from the server. */
  const refreshUser = React.useCallback(async () => {
    const token = localStorage.getItem("authToken");
    if (!token) return;
    try {
      const response = await fetch(`${config.development_api}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        // Expired or revoked session - drop it so the UI reflects reality.
        if (response.status === 401) logout();
        return;
      }
      const data = await response.json();
      if (data.status && data.data) {
        const enriched = enrichUserShape(data.data);
        localStorage.setItem("userInfo", JSON.stringify(enriched));
        setState((prev) => ({ ...prev, userInfo: { ...prev.userInfo, ...enriched } }));
        setIsAuthenticated(true);
      }
    } catch (error) {
      console.error("refreshUser failed", error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logout]);

  /**
   * Restore an existing session on boot. An invalid or expired token is
   * discarded rather than trusted, so the UI can never show a fabricated
   * "logged in" state from stale localStorage.
   */
  React.useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      const token = localStorage.getItem("authToken");
      if (!token) {
        if (!cancelled) setAuthReady(true);
        return;
      }

      // Optimistically hydrate the UI so the header does not flicker.
      try {
        const cached = localStorage.getItem("userInfo");
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && (parsed.userId || parsed.userName)) {
            setState((prev) => ({ ...prev, userInfo: enrichUserShape(parsed) }));
          }
        }
      } catch (error) {
        console.error("Failed to parse cached user", error);
      }

      await refreshUser();
      if (!cancelled) setAuthReady(true);
    };

    restore();
    return () => {
      cancelled = true;
    };
  }, [refreshUser]);

  // Seed handling functions
  const handleChangeUserSeed = (seed: string) => {
    // Functional update: merging into the previous state avoids clobbering
    // unrelated fields (e.g. the server seed hash) captured by a stale closure.
    setState(prev => ({ ...prev, seed }));
    if (socket) {
      socket.emit("changeClientSeed", seed);
    }
  };

  const handleGetSeed = () => {
    // The persistent `serverSeed` listener is registered once with the socket
    // in the effect below. Registering another one here leaked a listener on
    // every call (opening Settings repeatedly accumulated duplicates).
    if (socket) {
      socket.emit("getServerSeed");
    }
  };

  const handleGetSeedOfRound = async (id: string) => {
    try {
      const response = await fetch(`${config.development_api}/game/round-details`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ flyDetailID: id }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.status) {
          return data.data;
        }
      }
      return null;
    } catch (error) {
      console.log("handleGetSeedOfRound", error);
      return null;
    }
  };

  // Initialize socket connection
  React.useEffect(() => {
    if (!socket) {
      socket = io(config.development_wss, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 10
      });

      socket.on('connect', () => {
        console.log('Socket connected:', socket.id);
        // Authenticate and join the room using the persisted session.
        const storedToken = localStorage.getItem('authToken');
        if (storedToken) {
          socket.emit('authenticate', storedToken);
        }
        socket.emit('enterRoom', { token: storedToken });
      });

      socket.on('disconnect', () => {
        console.log('Socket disconnected');
      });

      socket.on('authenticated', (data) => {
        if (data.success && data.user) {
          console.log('Authenticated as:', data.user.userName);
          // Update balance from server
          setState(prev => ({
            ...prev,
            userInfo: {
              ...prev.userInfo,
              balance: data.user.balance || prev.userInfo.balance
            }
          }));
        }
      });
    }

    // The socket is a singleton for the app's lifetime. Its core listeners are
    // deliberately not removed: doing so left a re-mounted/reconnected socket
    // permanently unauthenticated while the UI still showed a logged-in user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-assert the socket session whenever the UI becomes authenticated and when
  // the tab regains focus (mobile browsers can suspend sockets in the
  // background without always reconnecting cleanly).
  React.useEffect(() => {
    if (!isAuthenticated) return;
    const reauth = () => {
      if (!socket || !socket.connected) return;
      const token = localStorage.getItem("authToken");
      if (token) socket.emit("authenticate", token);
    };
    reauth();
    window.addEventListener("focus", reauth);
    document.addEventListener("visibilitychange", reauth);
    return () => {
      window.removeEventListener("focus", reauth);
      document.removeEventListener("visibilitychange", reauth);
    };
  }, [isAuthenticated]);

  React.useEffect(function () {
    unityContext.on("GameController", function (message) {
      if (message === "Ready") {
        setUnity({
          currentProgress: 100,
          unityLoading: true,
          unityState: true,
        });
      }
    });
    unityContext.on("progress", (progression) => {
      const currentProgress = progression * 100;
      if (progression === 1) {
        setUnity({ currentProgress, unityLoading: true, unityState: true });
      } else {
        setUnity({ currentProgress, unityLoading: false, unityState: false });
      }
    });
    return () => unityContext.removeAllEventListeners();
  }, []);

  React.useEffect(() => {
    if (!socket) return;

    socket.on("bettedUserInfo", (bettedUsers: BettedUserType[]) => {
      // REAL-TIME: Show ALL players' bets (including yourself)
      console.log('👥 Live bets:', bettedUsers.length, 'players');
      setBettedUsers(bettedUsers);
    });

    socket.on("myBetState", (user: any) => {
      // INSTANT update - no waiting.
      //
      // Only the *betted* flags are authoritative here. Do NOT clear the
      // `*betState` flags for the other panels: with multi-panel play, one
      // panel being accepted must not silently disarm bets the player armed on
      // the other panels. A rejected bet is cleared by the `error` handler,
      // which carries the specific panel index.
      setUserBetState((prev) => ({
        ...prev,
        fbetted: !!user?.f?.betted,
        sbetted: !!user?.s?.betted,
        tbetted: !!user?.t?.betted,
        qbetted: !!user?.q?.betted,
      }));
      
      // Also update userInfo betted status immediately
      setState(prev => ({
        ...prev,
        userInfo: {
          ...prev.userInfo,
          f: { ...prev.userInfo.f, betted: user.f?.betted || false },
          s: { ...prev.userInfo.s, betted: user.s?.betted || false },
          t: { ...(prev.userInfo.t || createDefaultPanel()), betted: user.t?.betted || false },
          q: { ...(prev.userInfo.q || createDefaultPanel()), betted: user.q?.betted || false },
        }
      }));
    });

    socket.on("myInfo", (user: UserType) => {
      // REAL-TIME balance update
      setState(prev => ({
        ...prev,
        userInfo: {
          ...prev.userInfo,
          balance: user.balance !== undefined ? user.balance : prev.userInfo.balance,
          userType: user.userType !== undefined ? user.userType : prev.userInfo.userType,
          userName: user.userName || prev.userInfo.userName
        }
      }));
    });

    socket.on("history", (history: any) => {
      setHistory(history);
    });

    socket.on("gameState", (gameState: GameStatusType) => {
      // Map backend game states to frontend states
      const mappedGameState = {
        ...gameState,
        GameState: gameState.GameState === 'FLYING' ? 'PLAYING' : 
                   gameState.GameState === 'CRASHED' ? 'GAMEEND' : 
                   gameState.GameState
      };
      setGameState(mappedGameState);
    });

    socket.on("previousHand", (previousHand: UserType[]) => {
      setPreviousHand(previousHand);
    });

    socket.on("serverSeed", (data: any) => {
      // Keep the server seed hash separate from the player's client seed.
      // These were previously stored in the same `seed` field, so opening the
      // fairness dialog overwrote the client seed and subsequent bets sent the
      // hash as the seed, silently discarding the player's choice.
      if (data && data.serverSeedHash) {
        setState(prev => ({ ...prev, serverSeedHash: data.serverSeedHash }));
      }
    });

    socket.on("finishGame", (userData: any) => {
      let attrs = newState;
      let fauto = attrs.userInfo.f.auto;
      let sauto = attrs.userInfo.s.auto;
      let tauto = attrs.userInfo.t?.auto || false;
      let qauto = attrs.userInfo.q?.auto || false;
      let fbetAmount = attrs.userInfo.f.betAmount;
      let sbetAmount = attrs.userInfo.s.betAmount;
      let tbetAmount = attrs.userInfo.t?.betAmount || 0;
      let qbetAmount = attrs.userInfo.q?.betAmount || 0;
      let betStatus = newBetState;
      
      // Update user info from server
      if (userData) {
        attrs.userInfo.balance = userData.balance || attrs.userInfo.balance;
        attrs.userInfo.f.cashouted = userData.f?.cashouted || false;
        attrs.userInfo.s.cashouted = userData.s?.cashouted || false;
        if (attrs.userInfo.t) attrs.userInfo.t.cashouted = userData.t?.cashouted || false;
        if (attrs.userInfo.q) attrs.userInfo.q.cashouted = userData.q?.cashouted || false;
        attrs.userInfo.f.cashAmount = userData.f?.cashAmount || 0;
        attrs.userInfo.s.cashAmount = userData.s?.cashAmount || 0;
        if (attrs.userInfo.t) attrs.userInfo.t.cashAmount = userData.t?.cashAmount || 0;
        if (attrs.userInfo.q) attrs.userInfo.q.cashAmount = userData.q?.cashAmount || 0;
      }
      
      attrs.userInfo.f.betAmount = fbetAmount;
      attrs.userInfo.s.betAmount = sbetAmount;
      if (attrs.userInfo.t) attrs.userInfo.t.betAmount = tbetAmount;
      if (attrs.userInfo.q) attrs.userInfo.q.betAmount = qbetAmount;
      attrs.userInfo.f.auto = fauto;
      attrs.userInfo.s.auto = sauto;
      if (attrs.userInfo.t) attrs.userInfo.t.auto = tauto;
      if (attrs.userInfo.q) attrs.userInfo.q.auto = qauto;
      
      const processPanel = (panelKey: 'f' | 's' | 't' | 'q', increaseVar: any, decreaseVar: any, increaseSetter: (v: number) => void, decreaseSetter: (v: number) => void) => {
        const panel = (attrs.userInfo as any)[panelKey];
        const panelData = userData?.[panelKey];
        if (!panel) return;
        if (!panelData?.betted) {
          (betStatus as any)[`${panelKey}betted`] = false;
          if (panel.auto) {
            if (panelData?.cashouted) {
              increaseVar.value += panelData.cashAmount || 0;
              if ((attrs as any)[`${panelKey}inState`] && (attrs as any)[`${panelKey}increase`] - increaseVar.value <= 0) {
                panel.auto = false;
                (betStatus as any)[`${panelKey}betState`] = false;
                increaseVar.value = 0;
              } else if (
                (attrs as any)[`${panelKey}single`] &&
                (attrs as any)[`${panelKey}singleAmount`] <= (panelData.cashAmount || 0)
              ) {
                panel.auto = false;
                (betStatus as any)[`${panelKey}betState`] = false;
              } else {
                panel.auto = true;
                (betStatus as any)[`${panelKey}betState`] = true;
              }
            } else {
              decreaseVar.value += panel.betAmount || 0;
              if ((attrs as any)[`${panelKey}deState`] && (attrs as any)[`${panelKey}decrease`] - decreaseVar.value <= 0) {
                panel.auto = false;
                (betStatus as any)[`${panelKey}betState`] = false;
                decreaseVar.value = 0;
              } else {
                panel.auto = true;
                (betStatus as any)[`${panelKey}betState`] = true;
              }
            }
          }
        }
      };
      
      let fInc = { value: fIncreaseAmount }, fDec = { value: fDecreaseAmount };
      let sInc = { value: sIncreaseAmount }, sDec = { value: sDecreaseAmount };
      let tInc = { value: (window as any).tIncreaseAmount || 0 }, tDec = { value: (window as any).tDecreaseAmount || 0 };
      let qInc = { value: (window as any).qIncreaseAmount || 0 }, qDec = { value: (window as any).qDecreaseAmount || 0 };
      
      processPanel('f', fInc, fDec, v => fIncreaseAmount = v, v => fDecreaseAmount = v);
      processPanel('s', sInc, sDec, v => sIncreaseAmount = v, v => sDecreaseAmount = v);
      processPanel('t', tInc, tDec, v => (window as any).tIncreaseAmount = v, v => (window as any).tDecreaseAmount = v);
      processPanel('q', qInc, qDec, v => (window as any).qIncreaseAmount = v, v => (window as any).qDecreaseAmount = v);
      
      fIncreaseAmount = fInc.value; fDecreaseAmount = fDec.value;
      sIncreaseAmount = sInc.value; sDecreaseAmount = sDec.value;
      
      update(attrs);
      setUserBetState(betStatus);
    });

    socket.on("betLimits", (betAmounts: { max: number; min: number }) => {
      setBetLimit({ maxBet: betAmounts.max, minBet: betAmounts.min });
    });

    socket.on("recharge", () => {
      setRechargeState(true);
    });

    socket.on("error", (data) => {
      // Functional update: the old object spread used a stale `userBetState`
      // captured when the socket handler was registered, which could resurrect
      // an older bet panel state.
      const index = data && data.index;
      setUserBetState((prev) => ({
        ...prev,
        ...(index ? { [`${index}betted`]: false, [`${index}betState`]: false } : {}),
      }));
      if (/insufficient/i.test(String((data && data.message) || ""))) {
        // The server rejected an optimistic debit. Re-read the authoritative
        // balance instead of leaving the UI short by the stake.
        refreshUser();
      }
      toast.error(data.message);
    });

    socket.on("success", (data) => {
      toast.success(data);
    });

    socket.on("msgReceived", (data) => {
      setMsgReceived(!msgReceived);
    });

    return () => {
      socket.off("enterRoom");
      socket.off("bettedUserInfo");
      socket.off("myBetState");
      socket.off("myInfo");
      socket.off("history");
      socket.off("gameState");
      socket.off("previousHand");
      socket.off("serverSeed");
      socket.off("finishGame");
      socket.off("betLimits");
      socket.off("recharge");
      socket.off("error");
      socket.off("success");
      socket.off("msgReceived");
    };
  }, [socket, msgReceived]);

  React.useEffect(() => {
    let attrs = state;
    let betStatus = userBetState;

    // Guests may watch every round, but cannot bet. Prompt for login instead of
    // firing a bet the server will reject.
    if (!isAuthenticated) {
      if (betStatus.fbetState || betStatus.sbetState || (betStatus as any).tbetState || (betStatus as any).qbetState) {
        setUserBetState({ fbetState: false, fbetted: false, sbetState: false, sbetted: false, tbetState: false, tbetted: false, qbetState: false, qbetted: false });
        openAuthModal("Log in or create an account to place a bet.");
      }
      return;
    }

    if (gameState.GameState === "BET") {
      const placeBetForPanel = (panelKey: 'f' | 's' | 't' | 'q') => {
        const panel = (attrs.userInfo as any)[panelKey];
        const panelBetState = (betStatus as any)[`${panelKey}betState`];
        const panelBetted = (betStatus as any)[`${panelKey}betted`] || panel?.betted;
        if (panelBetState && !panelBetted) {
          if (panel?.auto) {
            const autoCountKey = `${panelKey}autoCound` as keyof ContextDataType;
            const count = (attrs as any)[autoCountKey] || 0;
            if (count > 0) {
              (attrs as any)[autoCountKey] = count - 1;
            } else {
              panel.auto = false;
              (betStatus as any)[`${panelKey}betState`] = false;
              return;
            }
          }
          const betAmount = panel?.betAmount || 0;
          if (attrs.userInfo.balance - betAmount < 0) {
            toast.error("Insufficient balance");
            if (panel) panel.auto = false;
            (betStatus as any)[`${panelKey}betState`] = false;
            (betStatus as any)[`${panelKey}betted`] = false;
            update(attrs);
            setUserBetState(betStatus);
            return;
          }
          const data = {
            betAmount: betAmount,
            target: panel?.target || 2,
            type: panelKey,
            // Fallback session proof for a socket whose authenticate event was
            // missed; the server ignores it once socket.userId is set.
            token: localStorage.getItem("authToken") || undefined,
            auto: panel?.auto || false,
            // Auto-cashout is settled by the authoritative game tick on the
            // server. A browser tab that is backgrounded or throttled can miss a
            // multiplier, and relying on the client meant the player lost a bet
            // they had asked to cash out.
            autoCashout: !!(attrs as any)[`${panelKey}autoCashoutState`],
            seed: state.seed,
          };
          attrs.userInfo.balance -= betAmount;
          update(attrs);
          socket.emit("playBet", data);
          (betStatus as any)[`${panelKey}betState`] = false;
          (betStatus as any)[`${panelKey}betted`] = true;
          setUserBetState(betStatus);
        }
      };
      placeBetForPanel('f');
      placeBetForPanel('s');
      placeBetForPanel('t');
      placeBetForPanel('q');
    }
  }, [
    gameState.GameState,
    userBetState.fbetState,
    userBetState.sbetState,
    userBetState.tbetState,
    userBetState.qbetState,
    isAuthenticated,
  ]);

  const getMyBets = async () => {
    // /game/my-info is authenticated: the owner is derived from the JWT, so a
    // guest simply has no history to fetch.
    const token = localStorage.getItem("authToken");
    if (!token) {
      update({ myBets: [] });
      return;
    }

    try {
      const response = await fetch(`${config.development_api}/game/my-info`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });

      if (response.status === 401) {
        logout();
        return;
      }

      if (response.ok) {
        const data = await response.json();
        if (data.status) {
          update({ myBets: data.data as GameHistory[] });
        }
      } else {
        console.error("getMyBets failed with status", response.status);
      }
    } catch (error) {
      console.log("getMyBets", error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  };

  useEffect(() => {
    if (gameState.GameState === "BET") getMyBets();
  }, [gameState.GameState]);

  return (
    <Context.Provider
      value={{
        state: state,
        userInfo: state.userInfo,
        ...betLimit,
        ...userBetState,
        userBetState,
        ...unity,
        ...gameState,
        currentTarget,
        rechargeState,
        // Auth surface
        isAuthenticated,
        authReady,
        authModalOpen,
        authReason,
        authMode,
        openAuthModal,
        closeAuthModal,
        login,
        logout,
        refreshUser,
        myUnityContext: unityContext,
        bettedUsers: [...bettedUsers],
        previousHand: [...previousHand],
        history: [...history],
        socket,
        msgTab,
        msgReceived,
        msgData,
        setMsgReceived,
        setMsgData,
        toggleMsgTab,
        walletOpen,
        openWallet,
        closeWallet,
        profileOpen,
        openProfile,
        closeProfile,
        handleChangeUserSeed,
        handleGetSeed,
        handleGetSeedOfRound,
        updateUserInfo,
        setCurrentTarget,
        update,
        getMyBets,
        updateUserBetState,
      }}
    >
      {children}
    </Context.Provider>
  );
};

export default Context;
