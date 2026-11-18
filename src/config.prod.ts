export const config = {
  development: false,
  debug: false,
  appKey: "crash-0.1.0",
  
  // Production URLs - UPDATE THESE after deployment
  api: process.env.REACT_APP_API_URL 
    ? `${process.env.REACT_APP_API_URL}/api` 
    : 'https://YOUR-BACKEND-URL.onrender.com/api',
    
  wss: process.env.REACT_APP_API_URL 
    || 'wss://YOUR-BACKEND-URL.onrender.com',
  
  // Development URLs (local testing)
  development_api: 'http://localhost:5001/api',
  development_wss: 'http://localhost:5001',
  
  // Production URLs
  production_api: 'https://YOUR-BACKEND-URL.onrender.com/api',
  production_wss: 'wss://YOUR-BACKEND-URL.onrender.com',
};
