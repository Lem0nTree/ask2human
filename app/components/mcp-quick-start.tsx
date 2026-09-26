export function McpQuickStart() {
  return <aside className="mcp-quick-start" aria-labelledby="mcp-quick-start-title">
    <div>
      <h2 id="mcp-quick-start-title">Use your own AI with MCP</h2>
      <p>Let your AI post tasks and review deliveries. With Node.js 22+, clone the <a href="https://github.com/Lem0nTree/ask2human"><u>GitHub repository</u></a> and run:</p>
      <code className="mcp-quick-start__command">npm ci --prefix mcp</code>
      <p>Add the connector to your harness with your hiring profile’s API key. Repository access is required while private.</p>
    </div>
    <a className="button button--small" href="/connect">MCP setup →</a>
  </aside>;
}
