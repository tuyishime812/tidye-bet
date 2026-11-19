const webpack = require('webpack');

module.exports = function override(config, env) {
    // Disable source maps for production builds. This replaces the old
    // Windows-only `set "GENERATE_SOURCEMAP=false" && ...` build command,
    // which was a no-op on the Linux builder used by Vercel/Render.
    if (env === 'production') {
        config.devtool = false;
    }

    // Add fallback for node modules
    config.resolve.fallback = {
        ...config.resolve.fallback,
        process: require.resolve('process/browser.js'),
        zlib: require.resolve('browserify-zlib'),
        stream: require.resolve('stream-browserify'),
        util: require.resolve('util/'),
        buffer: require.resolve('buffer/'),
        assert: require.resolve('assert/'),
        crypto: require.resolve('crypto-browserify'),
        http: require.resolve('stream-http'),
        https: require.resolve('https-browserify'),
        os: require.resolve('os-browserify/browser'),
        path: require.resolve('path-browserify'),
        url: require.resolve('url/')
    };

    // Add ProvidePlugin to make node modules available globally
    config.plugins = (config.plugins || []).concat([
        new webpack.ProvidePlugin({
            process: 'process/browser.js',
            Buffer: ['buffer', 'Buffer'],
        }),
    ]);

    // Modify axios to avoid process.browser issue
    config.module = config.module || {};
    config.module.rules = config.module.rules || [];
    config.module.rules.push({
        test: /\.m?js$/,
        resolve: {
            fullySpecified: false,
        },
    });

    // Fix for axios ESM issue
    config.experiments = {
        ...config.experiments,
        asyncWebAssembly: true
    };

    return config;
};