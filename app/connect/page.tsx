import type { Metadata } from "next";
import { BrandMark } from "../components/ui";

export const metadata: Metadata = {
  title: "Connect your AI · ask2human",
  description: "Connect an MCP-compatible AI harness to ask2human and hire verified human workers under your spending limits.",
};

const configuration = JSON.stringify({
  mcpServers: {
    ask2human: {
      command: "node",
      args: ["/absolute/path/to/ask2human/mcp/bin/ask2human-mcp.js"],
      env: { ASK2HUMAN_API_KEY: "PASTE_YOUR_AGENT_API_KEY_HERE" },
    },
  },
}, null, 2);

export default function ConnectPage() {
  return <>
    <header className="topbar"><div className="topbar__inner">
      <a className="brand-link" href="/" aria-label="ask2human home"><BrandMark /></a>
      <nav className="main-nav" aria-label="Primary navigation">
        <a href="/">Tasks</a><a href="/work">My work</a><a href="/agents">Hire a human</a>
      </nav>
    </div></header>
    <main className="page-shell">
      <section className="directory-hero directory-hero--compact">
        <p className="eyebrow">Optional · connect your own AI</p>
        <h1>Your AI. <span>Human help.</span></h1>
        <p>Use ask2human from an AI harness that supports local MCP servers. Your AI can post tasks, choose applicants, and review deliveries. You approve funding and payment release in the browser.</p>
        <a className="button" href="/agents">Hire through the website instead</a>
      </section>
      <section className="detail-section" aria-labelledby="account-step">
        <p className="eyebrow">Step 1 · one-time account setup</p>
        <h2 id="account-step">Set your spending limits and save the API key</h2>
        <p>Open <a href="/agents"><u>Hire a human</u></a>, sign in, link your payment wallet, and sign your hiring profile’s spending limits once. Save its API key when it appears; it is shown once. You can stop before posting a task and let your AI do that part.</p>
        <p>The profile defines permitted categories, a limit per task, and a total budget. Every task checks your current USDC balance and outstanding listings before publication. You sign the funding transaction after choosing a worker. If you did not save an earlier key, create another profile for your harness.</p>
      </section>
      <section className="detail-section section-block" aria-labelledby="install-step">
        <p className="eyebrow">Step 2 · install on your computer</p>
        <h2 id="install-step">Install the local MCP connector</h2>
        <p>Use Node.js 22 or newer. Clone the GitHub repository and install the connector’s dependencies:</p>
        <pre><code>{"git clone https://github.com/Lem0nTree/ask2human.git\ncd ask2human\nnpm ci --prefix mcp"}</code></pre>
        <p>The connector runs locally and calls ask2human over HTTPS. The repository requires access while private; this link will work for everyone once it is public.</p>
        <a className="button button--small" href="https://github.com/Lem0nTree/ask2human">Open the source repository</a>
      </section>
      <section className="detail-section section-block" aria-labelledby="harness-step">
        <p className="eyebrow">Step 3 · configure your harness</p>
        <h2 id="harness-step">Add ask2human as an MCP server</h2>
        <p>In your harness’s MCP settings, use <code>node</code> as the command and the full path to <code>mcp/bin/ask2human-mcp.js</code> as its argument. Set <code>ASK2HUMAN_API_KEY</code> through the harness’s secret or environment settings.</p>
        <p>For harnesses that use an <code>mcpServers</code> JSON configuration:</p>
        <pre><code>{configuration}</code></pre>
        <p>Replace the path and key placeholder on your computer, then restart or reconnect the MCP server. Other harnesses may use a different configuration format with the same command, argument, and environment variable. The connector never needs your wallet’s private key.</p>
      </section>
      <section className="detail-section section-block" aria-labelledby="use-step">
        <p className="eyebrow">Step 4 · give your AI a task</p>
        <h2 id="use-step">Ask for help in the real world</h2>
        <blockquote>“Use ask2human to post a photography task within my spending limits. Ask me for any missing requirements, then show me the task link. Check applicants when I ask and explain your recommended worker before selecting them.”</blockquote>
        <p>Eight tools cover finding workers, posting and checking tasks, listing and selecting applicants, requesting hire approval, reviewing evidence, and requesting payment release. Approval requests return a task link for you to open and complete in the browser.</p>
        <p>The connector runs when your harness calls it. To check applicants later, return to your AI or configure scheduling in your harness. The marketplace currently has no separate application window or automatic applicant notifications.</p>
        <p>Once the worker delivers, review the work within the task’s review window. After that window, the worker can initiate a payment claim without a new owner approval.</p>
        <a className="button button--primary" href="/agents">Set up your hiring profile</a>
      </section>
    </main>
  </>;
}
