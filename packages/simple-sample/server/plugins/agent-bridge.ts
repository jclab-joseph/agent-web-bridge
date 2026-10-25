export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('close', () => getAgentBridge().close())
})
