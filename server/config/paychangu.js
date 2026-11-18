/**
 * PayChangu Payment Configuration
 *
 * PayChangu API Integration (Malawi mobile money)
 * Documentation: https://paychangu.com
 *
 * Integration Flow:
 * 1. Initialize payment with secret/public keys
 * 2. Redirect customer to PayChangu checkout
 * 3. Verify the transaction via the verify-payment API
 */

const dotenv = require('dotenv');
dotenv.config();

const paychanguConfig = {
  // API Keys
  secretKey: process.env.PAYCHANGU_SECRET_KEY, // e.g., sec-xxxxxxxx
  publicKey: process.env.PAYCHANGU_PUBLIC_KEY, // e.g., pub-xxxxxxxx

  // API Endpoints
  baseUrl: 'https://api.paychangu.com',
  checkoutUrl: 'https://checkout.paychangu.com',
  initializeEndpoint: '/api/payments/initialize',
  verifyEndpoint: '/api/payments/verify',

  // Environment (test or production)
  environment: process.env.PAYCHANGU_ENVIRONMENT || 'test',

  // Validate configuration
  validate() {
    const errors = [];

    if (!this.secretKey) {
      errors.push('PAYCHANGU_SECRET_KEY is not defined');
    }

    if (!this.publicKey) {
      errors.push('PAYCHANGU_PUBLIC_KEY is not defined');
    }

    if (errors.length > 0) {
      console.error('❌ PayChangu Configuration Errors:');
      errors.forEach(err => console.error(`   - ${err}`));
      console.error('\n📝 Please check your .env file and ensure all PayChangu credentials are set correctly.');
      return false;
    }

    console.log(`✅ PayChangu configured successfully (${this.environment} mode)`);
    return true;
  },

  // Check if running in production mode
  isProduction() {
    return this.environment === 'production';
  },

  // Check if running in test mode
  isTest() {
    return this.environment === 'test';
  }
};

// Validate on load (only in non-test environments)
if (process.env.NODE_ENV !== 'test') {
  paychanguConfig.validate();
}

module.exports = paychanguConfig;
