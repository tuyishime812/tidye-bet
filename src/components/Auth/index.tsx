import React, { useState } from "react";
import axios from "axios";
import { config } from "../../config";

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthSuccess: (token: string, user: any) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose, onAuthSuccess }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [userName, setUserName] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const endpoint = isLogin ? "/auth/login" : "/auth/register";
      const response = await axios.post(`${config.development_api}${endpoint}`, isLogin ?
        { phoneNumber, password } :
        { phoneNumber, userName, password });

      if (response.data.status) {
        onAuthSuccess(response.data.token, response.data.user);
        onClose();
      } else {
        setError(response.data.message || "Authentication failed");
      }
    } catch (err: any) {
      setError(err.response?.data?.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleQuickPlay = async () => {
    setLoading(true);
    setError("");

    try {
      const response = await axios.post(`${config.development_api}/auth/quick-play`);
      if (response.data.status) {
        onAuthSuccess(response.data.token, response.data.user);
        onClose();
      } else {
        setError(response.data.message || "Quick play failed");
      }
    } catch (err: any) {
      setError(err.response?.data?.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="auth-modal-overlay">
      <div className="auth-modal">
        <button className="auth-modal-close" onClick={onClose}>×</button>
        
        <h2 className="auth-modal-title">{isLogin ? "Login" : "Register"}</h2>
        
        <form onSubmit={handleSubmit} className="auth-modal-form">
          <div className="form-group">
            <label>Phone Number</label>
            <input
              type="tel"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="10-15 digits, e.g. 265999123456"
              required
              pattern="[0-9]{10,15}"
            />
          </div>

          {!isLogin && (
            <div className="form-group">
              <label>Username</label>
              <input
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Enter username"
                required
                minLength={3}
              />
            </div>
          )}

          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              required
              minLength={6}
            />
          </div>

          {error && <div className="error-message">{error}</div>}

          <button type="submit" className="auth-btn primary" disabled={loading}>
            {loading ? "Please wait..." : (isLogin ? "Login" : "Register")}
          </button>
        </form>

        <button onClick={handleQuickPlay} className="auth-btn quick-play" disabled={loading}>
          🎮 Quick Play (Random User)
        </button>

        <div className="auth-modal-toggle">
          {isLogin ? (
            <p>
              Don't have an account?{" "}
              <span onClick={() => setIsLogin(false)}>Register</span>
            </p>
          ) : (
            <p>
              Already have an account?{" "}
              <span onClick={() => setIsLogin(true)}>Login</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
