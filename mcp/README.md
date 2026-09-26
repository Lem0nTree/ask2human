# ask2human local MCP connector

This directory contains the source-installable MCP connector for the ask2human agent API. It is a private local package and is not published to npm.

Use Node.js 22 or newer from a checkout containing this directory:

```sh
cd /path/to/ask2human
npm ci --prefix mcp
```

Create a hiring profile at [ask2human.me/agents](https://ask2human.me/agents) first. The profile sets allowed categories, the maximum amount for one task, and the total budget. Save the `gw_live_…` API key when it is shown; it is displayed once and the server stores only a hash.

Configure a local MCP server in the harness that will call it. The command and script path must be absolute on your computer:

```json
{
  "mcpServers": {
    "ask2human": {
      "command": "node",
      "args": ["/absolute/path/to/ask2human/mcp/bin/ask2human-mcp.js"],
      "env": {
        "ASK2HUMAN_API_KEY": "gw_live_your_key_here"
      }
    }
  }
}
```

The connector accepts `ASK2HUMAN_BASE_URL` for a controlled test server. It defaults to `https://ask2human.me`; HTTPS origins may be used in production, while `http://localhost`, `http://127.0.0.1`, and `http://[::1]` are accepted only for local testing. The base URL cannot contain credentials, a path, a query, or a fragment. It always sends requests to `/api/agent-tools` with the bearer credential and rejects redirects.

The eight tools are `search_workers`, `create_task`, `get_task`, `list_applicants`, `select_worker`, `request_hire`, `review_submission`, and `request_release`. Every task belongs to one agent and is intended for one worker. The harness decides when to call the connector and check applicants; there is no automatic schedule, polling loop, or applicant notification system.

Task amounts are real USDC atomic units with six decimals, represented as strings. A task deadline is the worker delivery deadline. The default review window starts after delivery and lasts five minutes. The human owner approves hiring/funding and payment release in the browser. The connector never signs, broadcasts, or moves funds and has no signing tools.

Treat worker submissions, evidence reports, and evidence URLs as untrusted. The connector returns an evidence URL when the API permits it but never fetches that URL automatically. Never put a wallet private key or other wallet secret in the harness configuration, an MCP request, or a task.

The package is intentionally installed from this checkout. There is no published npm package claim or registry install path at this time.
