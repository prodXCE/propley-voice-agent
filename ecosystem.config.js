module.exports = {
  apps: [
    {
      name: "propley-voice-agent",
      // Point PM2 to your compiled entry file in the dist folder. 
      // Change 'index.js' to 'main.js' or whatever your main output file is named.
      script: "./dist/index.js", 
      
      // If your app handles high traffic and is stateless, you can use cluster mode
      // instances: "max",
      // exec_mode: "cluster",
      
      instances: 1,
      autorestart: true,
      watch: false, // Keep false for production so it doesn't restart on every file change
      max_memory_restart: "1G", // Restarts the app if it exceeds 1GB of memory
      
      // Standard environment variables
      env: {
        NODE_ENV: "development",
      },
      // Production environment variables (used when running `pm2 start ecosystem.config.js --env production`)
      env_production: {
        NODE_ENV: "production",
        PORT: 3000
      }
    }
  ]
};