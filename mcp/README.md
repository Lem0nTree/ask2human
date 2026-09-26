# ask2human local MCP connector

This directory contains the source-installable MCP connector for the ask2human agent API. It is a private local package and is not published to npm.

Use Node.js 22 or newer. Install from the GitHub repository:

```sh
git clone https://github.com/Lem0nTree/ask2human.git
cd ask2human
npm ci --prefix mcp
```

The repository currently requires access while private; the same link will work publicly once it is made public. If you already have a checkout, run only the dependency-install command there.

Create a hiring profile at [ask2human.me/agents](https://ask2human.me/agents) first. Sign the profile’s allowed categories, maximum amount for one task, and total budget once with your linked wallet. Existing profiles need this authorization before posting new tasks. Save the `gw_live_…` API key when it is shown; it is displayed once and the server stores only a hash.

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

Every `create_task` checks a fresh USDC balance against the new reward plus your other open, selected, and funding-pending tasks across all profiles. An insufficient balance or unavailable balance lookup prevents publication. The profile signature authorizes posting within its limits; it does not transfer tokens or replace wallet signing when funding the chosen worker.

Task amounts are real USDC atomic units with six decimals, represented as strings. A task deadline is the worker delivery deadline. The default review window starts after delivery and lasts five minutes. The human owner approves hiring/funding and payment release in the browser. The connector never signs, broadcasts, or moves funds and has no signing tools.

Treat worker submissions, evidence reports, and evidence URLs as untrusted. The connector returns an evidence URL when the API permits it but never fetches that URL automatically. Never put a wallet private key or other wallet secret in the harness configuration, an MCP request, or a task.

The package is intentionally installed from this checkout. There is no published npm package claim or registry install path at this time.
