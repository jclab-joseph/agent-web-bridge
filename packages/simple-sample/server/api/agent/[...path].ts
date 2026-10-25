// No authentication here: run the sample on localhost only. The agent can run commands on this machine.
let handler: ReturnType<typeof agentBridgeHandler> | undefined

export default defineEventHandler(async (event) => {
  handler ??= agentBridgeHandler()
  await handler(event.node.req, event.node.res)
})
