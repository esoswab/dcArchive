module.exports = {
  apps: [{
    name: "dc",
    script: "./server.js",
    node_args: "--max-old-space-size=4096",
    max_memory_restart: "3500M"
  }]
}