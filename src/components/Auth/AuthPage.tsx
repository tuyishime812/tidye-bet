import React, { useState } from "react";
import axios from "axios";
import { config } from "../../config";
import "./authPage.scss";

interface AuthPageProps {
  onAuthSuccess: (token: string, user: any) => void;
}

export const AuthPage: React.FC<AuthPageProps> = ({ onAuthSuccess }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [userName, setUserName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");

    // Validate phone number (10-15 digits)
    if (!phoneNumber || !/^[0-9]{10,15}$/.test(phoneNumber)) {
      setError("Phone number must be 10-15 digits");
      setLoading(false);
      return;
    }

    // Validation - username only for registration
    if (!isLogin) {
      if (!userName || userName.length < 3) {
        setError("Username must be at least 3 characters");
        setLoading(false);
        return;
      }

      // Check username contains only letters and numbers
      if (!/^[a-zA-Z0-9]+$/.test(userName)) {
        setError("Username can only contain letters (a-z, A-Z) and numbers (0-9)");
        setLoading(false);
        return;
      }

      if (password !== confirmPassword) {
        setError("Passwords do not match");
        setLoading(false);
        return;
      }
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      setLoading(false);
      return;
    }

    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      setError("Password must include at least one letter and one number");
      setLoading(false);
      return;
    }

    try {
      const endpoint = isLogin ? "/auth/login" : "/auth/register";
      const response = await axios.post(
        `${config.development_api}${endpoint}`,
        {
          phoneNumber,
          userName: isLogin ? undefined : userName,
          password,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      console.log('Auth response:', response.data);

      if (response.data.status) {
        setSuccess(isLogin ? "Login successful!" : "Account created successfully!");
        setTimeout(() => {
          onAuthSuccess(response.data.token, response.data.user);
        }, 500);
      } else {
        setError(response.data.message || "Authentication failed");
      }
    } catch (err: any) {
      console.error('Auth error:', err);
      const errorMessage = err.response?.data?.message || err.message || "An error occurred. Please try again.";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      {/* Background decoration */}
      <div className="auth-bg">
        <div className="auth-bg-circle auth-bg-circle-1"></div>
        <div className="auth-bg-circle auth-bg-circle-2"></div>
        <div className="auth-bg-circle auth-bg-circle-3"></div>
      </div>

      <div className="auth-page-container">
        {/* Left side - Branding */}
        <div className="auth-brand">
          <div className="brand-content">
            <div className="brand-logo">
              <svg viewBox="0 0 100 100" className="logo-icon">
                <defs>
                  <linearGradient id="logoGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#00d4aa" />
                    <stop offset="100%" stopColor="#00a885" />
                  </linearGradient>
                </defs>
                <path
                  d="M50 15 L85 35 L85 75 L50 95 L15 75 L15 35 Z"
                  fill="url(#logoGradient)"
                  opacity="0.3"
                />
                <path
                  d="M50 25 L75 40 L75 70 L50 85 L25 70 L25 40 Z"
                  fill="url(#logoGradient)"
                />
                <circle cx="50" cy="55" r="12" fill="#fff" />
              </svg>
            </div>
            <h1 className="brand-title">AVIATOR</h1>
            <p className="brand-subtitle">Crash Game</p>
            
            <div className="brand-features">
              <div className="feature-item">
                <div className="feature-icon">⚡</div>
                <div className="feature-text">
                  <strong>Real-time Gaming</strong>
                  <span>Experience thrilling multiplayer action</span>
                </div>
              </div>
              <div className="feature-item">
                <div className="feature-icon">🔒</div>
                <div className="feature-text">
                  <strong>Provably Fair</strong>
                  <span>Transparent and verifiable results</span>
                </div>
              </div>
              <div className="feature-item">
                <div className="feature-icon">💰</div>
                <div className="feature-text">
                  <strong>Big Wins</strong>
                  <span>Win up to 1000x your bet</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right side - Auth Form */}
        <div className="auth-form-container">
          <div className="auth-form-wrapper">
            <div className="auth-header">
              <h2 className="auth-form-title">{isLogin ? "Welcome Back" : "Create Account"}</h2>
              <p className="auth-form-subtitle">
                {isLogin ? "Login to continue playing" : "Register to start winning"}
              </p>
            </div>

            <form onSubmit={handleSubmit} className="auth-form">
              {/* Phone Number - Always shown */}
              <div className="form-group">
                <label htmlFor="phoneNumber">
                  <span className="label-icon">📱</span>
                  Phone Number
                </label>
                <input
                  id="phoneNumber"
                  type="tel"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="Enter phone number (e.g., 991234567)"
                  pattern="[0-9]{10,15}"
                  required
                  autoComplete="tel"
                />
              </div>

              {/* Username - Only for registration */}
              {!isLogin && (
                <div className="form-group">
                  <label htmlFor="username">
                    <span className="label-icon">👤</span>
                    Username
                  </label>
                  <input
                    id="username"
                    type="text"
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                    placeholder="Choose a username"
                    required
                    minLength={3}
                    autoComplete="username"
                  />
                </div>
              )}

              <div className="form-group">
                <label htmlFor="password">
                  <span className="label-icon">🔐</span>
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  required
                  minLength={8}
                  autoComplete="current-password"
                />
              </div>

              {!isLogin && (
                <div className="form-group">
                  <label htmlFor="confirmPassword">
                    <span className="label-icon">🔒</span>
                    Confirm Password
                  </label>
                  <input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm your password"
                    required
                    minLength={8}
                  />
                </div>
              )}

              {error && (
                <div className="message error">
                  <span className="message-icon">⚠️</span>
                  {error}
                </div>
              )}

              {success && (
                <div className="message success">
                  <span className="message-icon">✅</span>
                  {success}
                </div>
              )}

              <button type="submit" className="auth-submit-btn" disabled={loading}>
                {loading ? (
                  <span className="loading-spinner">
                    <span className="spinner"></span>
                    Processing...
                  </span>
                ) : (
                  isLogin ? "Login to Game" : "Create Account"
                )}
              </button>
            </form>

            <div className="auth-switch">
              {isLogin ? (
                <p>
                  Don't have an account?{" "}
                  <button type="button" onClick={() => {
                    setIsLogin(false);
                    setError("");
                    setSuccess("");
                  }}>
                    Register Now
                  </button>
                </p>
              ) : (
                <p>
                  Already have an account?{" "}
                  <button type="button" onClick={() => {
                    setIsLogin(true);
                    setError("");
                    setSuccess("");
                  }}>
                    Login Here
                  </button>
                </p>
              )}
            </div>

            <p className="auth-terms">
              By continuing, you agree to our{" "}
              <a href="#terms" className="link">Terms of Service</a>
              {" "}and{" "}
              <a href="#privacy" className="link">Privacy Policy</a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
